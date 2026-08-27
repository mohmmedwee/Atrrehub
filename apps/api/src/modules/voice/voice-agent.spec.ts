import { describe, expect, it } from 'vitest';
import { estimateSpeechMs } from './speech.gateway';
import { VoiceAgentService } from './voice-agent.service';

/**
 * The two pieces of the turn loop that are pure: preparing an answer written
 * for a screen to be *heard*, and recognizing a caller who wants a person.
 * Both decide what a caller actually experiences, and neither needs a call.
 */
const agent = new VoiceAgentService(
  null as never,
  null as never,
  null as never,
  null as never,
  null as never,
  null as never,
);

const asksForHuman = (text: string): boolean =>
  (agent as unknown as { asksForHuman(t: string): boolean }).asksForHuman(text);

describe('preparing an answer to be spoken', () => {
  it('strips citation markers a synthesizer would read aloud', () => {
    expect(agent.forSpeech('Refunds take five days [1] from approval [2].')).toBe(
      'Refunds take five days from approval .',
    );
  });

  it('strips markdown emphasis and headings', () => {
    expect(agent.forSpeech('## Refunds\n\nThey take **five** days.')).toBe(
      'Refunds They take five days.',
    );
  });

  it('replaces a URL with something sayable', () => {
    expect(agent.forSpeech('See https://example.com/refunds for details.')).toBe(
      'See a link I can send you for details.',
    );
  });

  it('keeps link text and drops the target', () => {
    expect(agent.forSpeech('Read the [refund policy](https://example.com/x).')).toBe(
      'Read the refund policy.',
    );
  });

  it('removes a code block rather than dictating it', () => {
    expect(agent.forSpeech('Run ```npm install``` first.')).toBe('Run first.');
  });

  it('collapses the whitespace left behind', () => {
    expect(agent.forSpeech('Refunds\n\n\ttake    five days.')).toBe('Refunds take five days.');
  });

  it('leaves a short plain answer untouched', () => {
    const answer = 'Refunds take five working days.';
    expect(agent.forSpeech(answer)).toBe(answer);
  });
});

describe('an answer too long to listen to', () => {
  const long = Array.from(
    { length: 40 },
    (_, index) => `This is sentence number ${index} about our refund policy.`,
  ).join(' ');

  it('cuts it down to something a caller will sit through', () => {
    const spoken = agent.forSpeech(long, 10_000);
    expect(estimateSpeechMs(spoken)).toBeLessThanOrEqual(12_000);
    expect(spoken.length).toBeLessThan(long.length);
  });

  it('cuts at a sentence boundary, never mid-word', () => {
    const spoken = agent.forSpeech(long, 10_000);
    const body = spoken.replace(' Would you like me to go on?', '');
    expect(body.trim().endsWith('.')).toBe(true);
  });

  it('offers to continue rather than just stopping', () => {
    expect(agent.forSpeech(long, 10_000)).toContain('Would you like me to go on?');
  });

  it('does not offer to continue when nothing was cut', () => {
    expect(agent.forSpeech('Refunds take five days.', 10_000)).not.toContain('go on?');
  });
});

describe('recognizing a caller who wants a person', () => {
  it.each([
    'I want to speak to a human please',
    'can I talk to a real person',
    'put me through to someone',
    'connect me to an agent',
    'transfer me to a representative',
    'operator',
  ])('treats "%s" as a request for a person', (text) => {
    expect(asksForHuman(text)).toBe(true);
  });

  it.each([
    'How long does a refund take?',
    'I spoke to someone last week about my bill',
    'Is there a person named Ada in your billing team?',
    'My agent number is 4417',
  ])('does not mistake "%s" for one', (text) => {
    expect(asksForHuman(text)).toBe(false);
  });
});

describe('estimateSpeechMs', () => {
  it('scales with the number of words', () => {
    expect(estimateSpeechMs('one two three four five six seven eight nine ten')).toBeGreaterThan(
      estimateSpeechMs('one two'),
    );
  });

  it('never reports zero, so a short prompt still occupies the line', () => {
    expect(estimateSpeechMs('Yes.')).toBeGreaterThan(0);
    expect(estimateSpeechMs('')).toBeGreaterThan(0);
  });

  it('puts a sentence of ordinary length in the right ballpark', () => {
    // 15 words at 150 wpm is about six seconds.
    const sentence =
      'Refunds are returned to the original payment method within five working days of approval today';
    expect(estimateSpeechMs(sentence)).toBeGreaterThan(4_000);
    expect(estimateSpeechMs(sentence)).toBeLessThan(9_000);
  });
});
