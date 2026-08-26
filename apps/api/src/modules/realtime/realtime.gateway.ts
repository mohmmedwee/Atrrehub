import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';
import type { AppConfig } from '../../config/configuration';
import { AppLogger } from '../../core/logger/logger.service';
import { PrismaService } from '../../core/prisma/prisma.service';
import { RedisService } from '../../core/redis/redis.service';
import type { AccessTokenClaims } from '../auth/guards/auth.guard';

interface SocketPrincipal {
  organizationId: string;
  type: 'user' | 'widget';
  id: string;
  permissions: string[];
  conversationId?: string;
}

/**
 * Realtime transport for the agent workspace and the customer chat widget.
 *
 * Rooms are always tenant-prefixed, so a subscription can never receive another
 * organization's traffic even if a client asks for a foreign room id.
 */
@WebSocketGateway({ namespace: '/realtime', cors: { origin: true, credentials: true } })
@Injectable()
export class RealtimeGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer() private server!: Server;

  private readonly principals = new WeakMap<Socket, SocketPrincipal>();

  constructor(
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly config: ConfigService<AppConfig>,
    private readonly logger: AppLogger,
  ) {}

  // ── Connection lifecycle ───────────────────────────────────────────────────

  async handleConnection(socket: Socket): Promise<void> {
    try {
      const token = (socket.handshake.auth?.token ?? socket.handshake.query?.token) as
        string | undefined;
      if (!token) throw new Error('missing token');

      // Either an agent access token or a widget token; both carry `org`.
      const claims = await this.jwt.verifyAsync<
        Omit<AccessTokenClaims, 'typ'> & {
          typ: 'access' | 'widget';
          cha?: string;
          cnv?: string;
          cus?: string;
        }
      >(token);

      const principal: SocketPrincipal =
        claims.typ === 'widget'
          ? {
              organizationId: claims.org,
              type: 'widget',
              id: claims.cus ?? claims.cha ?? 'visitor',
              permissions: [],
              conversationId: claims.cnv,
            }
          : {
              organizationId: claims.org,
              type: 'user',
              id: claims.sub,
              permissions: claims.perms ?? [],
            };

      this.principals.set(socket, principal);
      await socket.join(this.orgRoom(principal.organizationId));

      if (principal.type === 'user') {
        await socket.join(this.userRoom(principal.organizationId, principal.id));
        await this.trackPresence(principal.organizationId, principal.id, socket.id, true);
      } else if (principal.conversationId) {
        // A widget socket is pinned to exactly one conversation.
        await socket.join(
          this.conversationRoom(principal.organizationId, principal.conversationId),
        );
      }

      socket.emit('connected', { principal: { type: principal.type, id: principal.id } });
    } catch (error) {
      this.logger.debug('Rejected a realtime connection', { reason: (error as Error).message });
      socket.emit('error', { code: 'unauthenticated' });
      socket.disconnect(true);
    }
  }

  async handleDisconnect(socket: Socket): Promise<void> {
    const principal = this.principals.get(socket);
    if (principal?.type === 'user') {
      await this.trackPresence(principal.organizationId, principal.id, socket.id, false);
    }
    this.principals.delete(socket);
  }

  // ── Subscriptions ──────────────────────────────────────────────────────────

  @SubscribeMessage('subscribe:conversation')
  async subscribeConversation(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: { conversationId: string },
  ): Promise<{ ok: boolean; reason?: string }> {
    const principal = this.principals.get(socket);
    if (!principal) return { ok: false, reason: 'unauthenticated' };

    // Widgets may only ever watch the conversation their token names.
    if (principal.type === 'widget') {
      if (principal.conversationId !== body.conversationId)
        return { ok: false, reason: 'forbidden' };
      return { ok: true };
    }

    // Confirm the conversation belongs to this tenant before joining the room.
    const conversation = await this.prisma.raw.conversation.findFirst({
      where: { id: body.conversationId, organizationId: principal.organizationId },
      select: { id: true },
    });
    if (!conversation) return { ok: false, reason: 'not_found' };

    await socket.join(this.conversationRoom(principal.organizationId, body.conversationId));
    return { ok: true };
  }

  @SubscribeMessage('unsubscribe:conversation')
  async unsubscribeConversation(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: { conversationId: string },
  ): Promise<{ ok: boolean }> {
    const principal = this.principals.get(socket);
    if (principal)
      await socket.leave(this.conversationRoom(principal.organizationId, body.conversationId));
    return { ok: true };
  }

  @SubscribeMessage('subscribe:queue')
  async subscribeQueue(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: { queueId: string },
  ) {
    const principal = this.principals.get(socket);
    if (principal?.type !== 'user') return { ok: false };
    await socket.join(`${this.orgRoom(principal.organizationId)}:queue:${body.queueId}`);
    return { ok: true };
  }

  @SubscribeMessage('typing')
  async typing(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: { conversationId: string; isTyping: boolean },
  ) {
    const principal = this.principals.get(socket);
    if (!principal) return { ok: false };
    socket.to(this.conversationRoom(principal.organizationId, body.conversationId)).emit('typing', {
      conversationId: body.conversationId,
      actorType: principal.type === 'widget' ? 'customer' : 'user',
      actorId: principal.id,
      isTyping: body.isTyping,
    });
    return { ok: true };
  }

  // ── Server-side emission ───────────────────────────────────────────────────

  /** Returns true when at least one socket was listening. */
  emitToConversation(
    organizationId: string,
    conversationId: string,
    event: string,
    payload: unknown,
  ): boolean {
    const room = this.conversationRoom(organizationId, conversationId);
    const listeners = this.server?.sockets?.adapter?.rooms?.get(room)?.size ?? 0;
    this.server?.to(room).emit(event, { conversationId, ...(payload as object) });
    return listeners > 0;
  }

  emitToUser(organizationId: string, userId: string, event: string, payload: unknown): void {
    this.server?.to(this.userRoom(organizationId, userId)).emit(event, payload);
  }

  emitToOrganization(organizationId: string, event: string, payload: unknown): void {
    this.server?.to(this.orgRoom(organizationId)).emit(event, payload);
  }

  emitToQueue(organizationId: string, queueId: string, event: string, payload: unknown): void {
    this.server?.to(`${this.orgRoom(organizationId)}:queue:${queueId}`).emit(event, payload);
  }

  // ── Presence ───────────────────────────────────────────────────────────────

  /**
   * Presence is reference-counted per socket: an agent with the workspace open
   * in two tabs only goes offline when the last one closes.
   */
  private async trackPresence(
    organizationId: string,
    userId: string,
    socketId: string,
    online: boolean,
  ): Promise<void> {
    const key = this.redis.key(organizationId, 'presence', userId);
    if (online) {
      await this.redis.client.sadd(key, socketId);
      await this.redis.client.expire(key, 3600);
    } else {
      await this.redis.client.srem(key, socketId);
    }
    const remaining = await this.redis.client.scard(key);
    if ((online && remaining === 1) || (!online && remaining === 0)) {
      this.emitToOrganization(organizationId, 'presence', { userId, online: remaining > 0 });
    }
  }

  async onlineUserIds(organizationId: string): Promise<string[]> {
    const pattern = this.redis.key(organizationId, 'presence', '*');
    const online: string[] = [];
    let cursor = '0';
    do {
      const [next, keys] = await this.redis.client.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
      cursor = next;
      for (const key of keys) {
        if ((await this.redis.client.scard(key)) > 0) online.push(key.split(':').pop()!);
      }
    } while (cursor !== '0');
    return online;
  }

  private orgRoom(organizationId: string): string {
    return `org:${organizationId}`;
  }

  private userRoom(organizationId: string, userId: string): string {
    return `org:${organizationId}:user:${userId}`;
  }

  private conversationRoom(organizationId: string, conversationId: string): string {
    return `org:${organizationId}:conversation:${conversationId}`;
  }
}
