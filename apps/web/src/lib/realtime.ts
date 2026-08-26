'use client';

import { io, type Socket } from 'socket.io-client';
import { tokens } from './api';

const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? 'http://localhost:4000';

let socket: Socket | null = null;

/**
 * One shared socket for the whole workspace. Opening a connection per screen
 * would multiply presence entries and fan-out cost for no benefit.
 */
export function realtime(): Socket {
  if (socket?.connected || socket?.active) return socket;

  socket = io(`${WS_URL}/realtime`, {
    auth: { token: tokens.access() },
    transports: ['websocket'],
    reconnection: true,
    reconnectionDelay: 500,
    reconnectionDelayMax: 5000,
  });

  // A refreshed access token must be presented on reconnect, or the socket is
  // rejected as soon as the old one expires.
  socket.io.on('reconnect_attempt', () => {
    if (socket) socket.auth = { token: tokens.access() };
  });

  return socket;
}

export function disconnectRealtime(): void {
  socket?.disconnect();
  socket = null;
}

/** Subscribe to an event for as long as the component is mounted. */
export function onRealtime(event: string, handler: (payload: never) => void): () => void {
  const connection = realtime();
  connection.on(event, handler as (payload: unknown) => void);
  return () => {
    connection.off(event, handler as (payload: unknown) => void);
  };
}

export function subscribeConversation(conversationId: string): () => void {
  const connection = realtime();
  connection.emit('subscribe:conversation', { conversationId });
  return () => connection.emit('unsubscribe:conversation', { conversationId });
}
