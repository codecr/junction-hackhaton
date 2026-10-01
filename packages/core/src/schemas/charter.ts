import { z } from 'zod';
import {
  base64UrlSchema,
  clockSchema,
  instantSchema,
  memberIdSchema,
  sessionIdSchema,
  squadIdSchema,
} from './common';

export const charterMemberSchema = z.strictObject({
  memberId: memberIdSchema,
  name: z.string().min(1).max(40),
  publicKey: base64UrlSchema,
  role: z.enum(['leader', 'member']),
  joinedAt: instantSchema,
});

export const topicMatchSchema = z.strictObject({
  topics: z.array(z.string()).optional(),
  services: z.array(z.string()).optional(),
  tracks: z.array(z.string()).optional(),
});

export const charterTopicSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9-]{1,32}$/),
  label: z.string().max(60),
  weight: z.int().min(1).max(5),
  target: z.int().min(1).max(5),
  match: topicMatchSchema.optional(),
});

export const charterSchema = z.strictObject({
  v: z.literal(1),
  type: z.literal('charter'),
  squadId: squadIdSchema,
  name: z.string().min(1).max(60),
  eventId: z.string().min(1).max(64),
  leader: memberIdSchema,
  seq: z.int().min(0),
  issuedAt: instantSchema,
  expiresAt: instantSchema,
  inviteVerifier: base64UrlSchema,
  members: z.array(charterMemberSchema).min(1).max(30),
  topics: z.array(charterTopicSchema).max(24),
  mustCover: z.array(z.strictObject({ sessionId: sessionIdSchema })).max(100).optional(),
  lunch: z
    .strictObject({ start: clockSchema, end: clockSchema, protected: z.boolean() })
    .optional(),
  caps: z.strictObject({ maxPerDay: z.int().min(1).max(12).optional() }).optional(),
  travel: z.strictObject({ bufferMin: z.int().min(0).max(30).optional() }).optional(),
  tolerance: z.number().min(0).max(1).optional(),
});

export type Charter = z.infer<typeof charterSchema>;
export type CharterMember = z.infer<typeof charterMemberSchema>;
export type CharterTopic = z.infer<typeof charterTopicSchema>;
