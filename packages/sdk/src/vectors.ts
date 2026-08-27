/**
 * Published signing test vectors.
 *
 * The sender (the platform) and the receiver (this SDK) implement the signing
 * scheme independently — that independence is the whole point of a signature —
 * so something has to hold them to the same definition. These vectors are that
 * something: both sides assert against them, and a change to either that breaks
 * the other fails a test rather than a customer's integration.
 *
 * Anyone writing a receiver in another language should use them too.
 */
export const SIGNING_TEST_VECTORS = {
  secret: 'whsec_00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff',
  cases: [
    {
      description: 'an ordinary event payload',
      timestamp: 1_770_000_000,
      payload: '{"id":"evt_1","type":"conversation.created"}',
      v1: 'b81775b98f7efe067f58d30cfc0b72571ac9196713f85ccaaae14e85ecab237b',
    },
    {
      description: 'an empty body',
      timestamp: 1_700_000_000,
      payload: '',
      v1: '023c9219269c5f609ccd78b9ced439f568339d13a7d77b1f2538a6fc24454050',
    },
    {
      description: 'multi-byte characters, which must be hashed as UTF-8 bytes',
      timestamp: 1,
      payload: '{"unicode":"café ☕"}',
      v1: 'c54c0aa0c362841685026b7c50988b0d1ec2ee73bd282cc36c4f818345826092',
    },
  ],
} as const;
