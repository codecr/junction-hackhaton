import { z } from 'zod';
import { instantSchema, memberIdSchema, sessionCodeSchema, sessionIdSchema, squadIdSchema } from './common';

export const SHARE_LEVELS = ['L0', 'L1', 'L2'] as const;
export const SESSION_STATUSES = ['reserved', 'favorite', 'maybe'] as const;

export const manifestSessionSchema = z.strictObject({
  sessionId: sessionIdSchema,
  code: sessionCodeSchema,
  status: z.enum(SESSION_STATUSES),
  priority: z.int().min(1).max(5).optional(),
  locked: z.boolean().optional(),
  role: z.enum(['attendee', 'speaker']).optional(),
});

export const holdSchema = z.strictObject({
  sessionId: sessionIdSchema,
  reason: z.enum(['declined', 'pinned']),
});

export const busyBlockSchema = z.strictObject({ start: instantSchema, end: instantSchema });

export const manifestSchema = z
  .strictObject({
    v: z.literal(1),
    type: z.literal('manifest'),
    squadId: squadIdSchema,
    memberId: memberIdSchema,
    seq: z.int().min(0),
    issuedAt: instantSchema,
    eventId: z.string().min(1).max(64),
    catalogHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    share: z.enum(SHARE_LEVELS),
    sessions: z.array(manifestSessionSchema).max(200),
    holds: z.array(holdSchema).max(200).optional(),
    busy: z.array(busyBlockSchema).max(100).optional(),
    at: z.strictObject({ venue: z.string().max(64), since: instantSchema }).optional(),
  })
  .superRefine((m, ctx) => {
    if (m.share === 'L0' && m.busy !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['busy'], message: 'busy blocks need sharing level L1 or L2' });
    }
    if (m.share !== 'L2' && m.at !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['at'], message: 'venue needs sharing level L2' });
    }
    const dupSession = firstDuplicate(m.sessions.map((s) => s.sessionId));
    if (dupSession !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['sessions'], message: `session ${dupSession} appears twice` });
    }
    const dupHold = firstDuplicate((m.holds ?? []).map((h) => h.sessionId));
    if (dupHold !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['holds'], message: `hold ${dupHold} appears twice` });
    }
  });

function firstDuplicate(values: string[]): string | undefined {
  const seen = new Set<string>();
  for (const v of values) {
    if (seen.has(v)) return v;
    seen.add(v);
  }
  return undefined;
}

export type Manifest = z.infer<typeof manifestSchema>;
export type ManifestSession = z.infer<typeof manifestSessionSchema>;
export type Hold = z.infer<typeof holdSchema>;
export type ShareLevel = (typeof SHARE_LEVELS)[number];
export type SessionStatus = (typeof SESSION_STATUSES)[number];

export const DEFAULT_PRIORITY = 3;
export const priorityOf = (s: ManifestSession): number => s.priority ?? DEFAULT_PRIORITY;
export const isLocked = (s: ManifestSession): boolean => s.locked === true || s.role === 'speaker';
