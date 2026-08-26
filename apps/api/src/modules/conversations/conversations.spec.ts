import { describe, expect, it } from 'vitest';
import { ConversationsService } from './conversations.service';

const { canTransition } = ConversationsService;

describe('conversation lifecycle', () => {
  it('follows the documented happy path', () => {
    expect(canTransition('new', 'queued')).toBe(true);
    expect(canTransition('queued', 'assigned')).toBe(true);
    expect(canTransition('assigned', 'active')).toBe(true);
    expect(canTransition('active', 'waiting')).toBe(true);
    expect(canTransition('waiting', 'resolved')).toBe(true);
    expect(canTransition('resolved', 'closed')).toBe(true);
  });

  it('allows reopening a closed conversation', () => {
    expect(canTransition('closed', 'active')).toBe(true);
    expect(canTransition('resolved', 'active')).toBe(true);
  });

  it('refuses to resolve a conversation nobody has picked up', () => {
    expect(canTransition('new', 'resolved')).toBe(false);
  });

  it('refuses to skip straight from closed to resolved', () => {
    expect(canTransition('closed', 'resolved')).toBe(false);
    expect(canTransition('closed', 'queued')).toBe(false);
  });

  it('treats a no-op transition as allowed so retries are idempotent', () => {
    expect(canTransition('active', 'active')).toBe(true);
    expect(canTransition('closed', 'closed')).toBe(true);
  });

  it('lets work fall back to the queue from any working state', () => {
    for (const from of ['assigned', 'active', 'waiting'] as const) {
      expect(canTransition(from, 'queued')).toBe(true);
    }
  });

  it('permits closing from every state', () => {
    for (const from of ['new', 'queued', 'assigned', 'active', 'waiting', 'resolved'] as const) {
      expect(canTransition(from, 'closed')).toBe(true);
    }
  });

  it('exposes exactly the statuses that count as open', () => {
    expect(ConversationsService.openStatuses).toEqual(['new', 'queued', 'assigned', 'active', 'waiting']);
    expect(ConversationsService.openStatuses).not.toContain('resolved');
    expect(ConversationsService.openStatuses).not.toContain('closed');
  });
});
