import { z } from 'zod';
import { base64UrlSchema, memberIdSchema } from './common';
import { charterSchema } from './charter';
import { manifestSchema } from './manifest';
import { claimSchema, signalSchema } from './signal-claim';

/** 64 KB of payload is at most 87,382 base64url characters. */
export const MAX_PAYLOAD_CHARS = 87_400;

export const envelopeSchema = z.strictObject({
  kid: memberIdSchema,
  alg: z.literal('Ed25519'),
  payload: base64UrlSchema.max(MAX_PAYLOAD_CHARS),
  sig: base64UrlSchema,
});

export const messageSchema = z.discriminatedUnion('type', [
  charterSchema,
  manifestSchema,
  signalSchema,
  claimSchema,
]);

export type Envelope = z.infer<typeof envelopeSchema>;
export type Message = z.infer<typeof messageSchema>;
