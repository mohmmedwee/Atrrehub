import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import type { AgentPresence } from '@prisma/client';
import { DomainEvent, type DomainEventEnvelope } from '../../core/events/domain-events';
import { AppLogger } from '../../core/logger/logger.service';
import { WfmService } from './wfm.service';

/**
 * Presence history, captured as it happens.
 *
 * Adherence is measured against where an agent actually was, minute by minute,
 * and that can only be reconstructed if every transition was written down at
 * the time — there is no way to recover it afterwards.
 */
@Injectable()
export class WfmListener {
  constructor(
    private readonly wfm: WfmService,
    private readonly logger: AppLogger,
  ) {}

  @OnEvent(DomainEvent.AgentPresenceChanged)
  async onPresenceChanged(
    event: DomainEventEnvelope<{ userId: string; presence: string; note?: string }>,
  ) {
    try {
      await this.wfm.recordStateChange(
        event.data.userId,
        event.data.presence as AgentPresence,
        event.actor?.type === 'system' ? 'system' : 'user',
        event.data.note,
      );
    } catch (error) {
      // Losing one transition skews a day's adherence; failing the presence
      // change itself would stop an agent taking calls, which is worse.
      this.logger.error('Recording a presence change failed', error, {
        userId: event.data.userId,
      });
    }
  }
}
