import { z } from 'zod';
import { instantSchema, memberIdSchema, sessionCodeSchema, sessionIdSchema, squadIdSchema } from './common';

export const VERDICTS = ['worth-it', 'skip-repeat', 'crowded', 'wrong-level', 'moved'] as const;

export const signalSchema = z.strictObject({
  v: z.literal(1),
  type: z.literal('signal'),
  squadId: squadIdSchema,
  memberId: memberIdSchema,
  sessionId: sessionIdSchema,
  code: sessionCodeSchema,
  verdict: z.enum(VERDICTS),
  note: z.string().max(140).optional(),
  issuedAt: instantSchema,
});

export const claimSchema = z.strictObject({
  v: z.literal(1),
  type: z.literal('claim'),
  squadId: squadIdSchema,
  memberId: memberIdSchema,
  sessionId: sessionIdSchema,
  rank: z.int().min(0),
  issuedAt: instantSchema,
});

export type Signal = z.infer<typeof signalSchema>;
export type Claim = z.infer<typeof claimSchema>;
export type Verdict = (typeof VERDICTS)[number];
