// Per-operation token buckets with the published per-attendee quotas (CLAUDE.md rule 6). Bulk
// operations spend one token per session. The clock and sleep are injected so tests run instantly.

export type Operation =
  | 'ListEvents'
  | 'GetEvent'
  | 'ListSessions'
  | 'GetSession'
  | 'GetSchedule'
  | 'ReserveSessions'
  | 'CancelReservation'
  | 'AssociateFavorites'
  | 'DisassociateFavorite'
  | 'CreatePersonalTime'
  | 'UpdatePersonalTime'
  | 'DeletePersonalTime';

/** Per minute, per attendee. ListEvents and GetEvent have no published quota; 60 is our own cap. */
export const QUOTAS: Record<Operation, number> = {
  ListEvents: 60,
  GetEvent: 60,
  ListSessions: 60,
  GetSession: 120,
  GetSchedule: 60,
  ReserveSessions: 30,
  CancelReservation: 30,
  AssociateFavorites: 30,
  DisassociateFavorite: 30,
  CreatePersonalTime: 30,
  UpdatePersonalTime: 30,
  DeletePersonalTime: 30,
};

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

interface Bucket {
  tokens: number;
  updatedAt: number;
}

export class Pacer {
  private readonly buckets = new Map<Operation, Bucket>();
  /** Until when an operation is blocked after a 429. */
  private readonly blockedUntil = new Map<Operation, number>();

  constructor(private readonly clock: Clock = systemClock) {}

  private bucket(op: Operation): Bucket {
    const now = this.clock.now();
    const cap = QUOTAS[op];
    let b = this.buckets.get(op);
    if (!b) {
      b = { tokens: cap, updatedAt: now };
      this.buckets.set(op, b);
    }
    const refill = ((now - b.updatedAt) / 60_000) * cap;
    b.tokens = Math.min(cap, b.tokens + refill);
    b.updatedAt = now;
    return b;
  }

  /** Waits until `count` tokens are available for `op`, then spends them. */
  async acquire(op: Operation, count = 1): Promise<void> {
    if (count > QUOTAS[op])
      throw new Error(`${op}: a batch of ${count} exceeds the quota of ${QUOTAS[op]} per minute.`);
    for (;;) {
      const blocked = (this.blockedUntil.get(op) ?? 0) - this.clock.now();
      if (blocked > 0) {
        await this.clock.sleep(blocked);
        continue;
      }
      const b = this.bucket(op);
      if (b.tokens >= count) {
        b.tokens -= count;
        return;
      }
      const missing = count - b.tokens;
      await this.clock.sleep(Math.ceil((missing / QUOTAS[op]) * 60_000));
    }
  }

  /** A refused request spends no quota, so the tokens are given back, and the operation pauses. */
  throttled(op: Operation, retryAfterSec: number, count = 1): void {
    const b = this.bucket(op);
    b.tokens = Math.min(QUOTAS[op], b.tokens + count);
    this.blockedUntil.set(op, this.clock.now() + Math.max(1, retryAfterSec) * 1000);
  }
}
