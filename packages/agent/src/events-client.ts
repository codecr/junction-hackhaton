import { z } from 'zod';
import { Pacer, systemClock, type Clock, type Operation } from './pacer';

// Typed client for the 12 operations of the AWS Events API, following the official OpenAPI at
// https://api.awsevents.com/v1/openapi.json. Every response is validated with zod and every session
// field is optional. Writes are never retried blindly (CLAUDE.md rules 4 and 5): a 5xx on a write is
// reported as an unknown outcome so the caller reconciles with GetSchedule.

export const EVENTS_API = 'https://api.awsevents.com/v1';
/** The API accepts at most 10 session ids per bulk request. */
export const BULK_MAX = 10;

const id = z.string().min(1).max(128);

export const eventSchema = z.looseObject({
  eventId: z.string(),
  name: z.string().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  timezone: z.string().optional(),
  timeFormat: z.string().optional(),
  authenticationRequired: z.boolean().optional(),
});
export type ApiEvent = z.infer<typeof eventSchema>;

const listEventsSchema = z.looseObject({ items: z.array(eventSchema) });
const getEventSchema = z.looseObject({ event: eventSchema });
const listSessionsSchema = z.looseObject({
  items: z.array(z.looseObject({ sessionId: id })),
  totalCount: z.number().optional(),
  nextToken: z.string().optional(),
});
const getSessionSchema = z.looseObject({ session: z.looseObject({ sessionId: id }) });

export const personalTimeSchema = z.looseObject({
  personalTimeId: id,
  startDateTime: z.string(),
  endDateTime: z.string(),
  title: z.string(),
  description: z.string(),
  location: z.string().optional(),
});
export type PersonalTime = z.infer<typeof personalTimeSchema>;

export const scheduleSchema = z.looseObject({
  reserved: z.array(id).default([]),
  favorites: z.array(id).default([]),
  personalTime: z.array(personalTimeSchema).default([]),
});
export type Schedule = z.infer<typeof scheduleSchema>;
const getScheduleSchema = z.looseObject({ schedule: scheduleSchema });

export const bulkFailureSchema = z.looseObject({
  sessionId: id,
  /** Unknown codes are kept as plain strings and treated as a generic refusal. */
  code: z.string(),
  conflictsWith: z.array(id).optional(),
});
export const bulkResultSchema = z.looseObject({
  successful: z.array(id).default([]),
  failed: z.array(bulkFailureSchema).default([]),
});
export type BulkResult = z.infer<typeof bulkResultSchema>;
const bulkResponseSchema = z.looseObject({ result: bulkResultSchema });

export interface PersonalTimeInput {
  /** `YYYY-MM-DDTHH:MM:00`, wall-clock time in the event's timezone (OpenAPI, 2026-11-06). */
  startDateTime: string;
  endDateTime: string;
  title: string;
  description: string;
  location?: string;
}

export type ApiErrorCode =
  | 'bad-request'
  | 'signed-out'
  | 'not-registered'
  | 'edge-refused'
  | 'not-found'
  | 'closed'
  | 'throttled'
  | 'unknown-outcome'
  | 'server'
  | 'network'
  | 'invalid-response';

export class ApiError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface EventsClientOptions {
  /** Returns a valid access token. `force` asks for a refresh after a 401. */
  getToken: (force?: boolean) => Promise<string>;
  fetch?: typeof fetch;
  pacer?: Pacer;
  clock?: Clock;
  baseUrl?: string;
}

const WRITE_METHODS = new Set(['POST', 'PUT', 'DELETE']);

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (text === '') return undefined;
  try {
    return JSON.parse(text);
  } catch {
    // The edge can answer with HTML. Never assume JSON.
    return undefined;
  }
}

function messageOf(body: unknown): string | undefined {
  if (body && typeof body === 'object' && 'message' in body) {
    const m = (body as { message: unknown }).message;
    if (typeof m === 'string') return m.slice(0, 300);
  }
  return undefined;
}

export class EventsClient {
  private readonly fetchFn: typeof fetch;
  private readonly pacer: Pacer;
  private readonly clock: Clock;
  private readonly baseUrl: string;

  constructor(private readonly opts: EventsClientOptions) {
    this.fetchFn = opts.fetch ?? fetch;
    this.clock = opts.clock ?? systemClock;
    this.pacer = opts.pacer ?? new Pacer(this.clock);
    this.baseUrl = opts.baseUrl ?? EVENTS_API;
  }

  private async call<T>(
    op: Operation,
    method: string,
    path: string,
    schema: z.ZodType<T> | undefined,
    options: { body?: unknown; auth?: boolean; cost?: number } = {},
  ): Promise<T> {
    const auth = options.auth ?? true;
    const cost = options.cost ?? 1;
    const isWrite = WRITE_METHODS.has(method);
    let refreshed = false;
    let throttles = 0;
    let serverRetries = 0;

    for (;;) {
      await this.pacer.acquire(op, cost);
      const headers: Record<string, string> = { accept: 'application/json' };
      if (auth) headers.authorization = `Bearer ${await this.opts.getToken(false)}`;
      if (options.body !== undefined) headers['content-type'] = 'application/json';

      let res: Response;
      try {
        res = await this.fetchFn(`${this.baseUrl}${path}`, {
          method,
          headers,
          ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
        });
      } catch {
        if (isWrite) {
          throw new ApiError(
            'unknown-outcome',
            `${op}: the connection dropped, so the outcome is unknown. Junction will read your schedule to check what was applied.`,
          );
        }
        throw new ApiError(
          'network',
          `${op}: could not reach api.awsevents.com. Check your connection and try again.`,
        );
      }

      const body = await readBody(res);
      const status = res.status;
      if (status >= 200 && status < 300) {
        if (!schema) return undefined as T;
        const parsed = schema.safeParse(body);
        if (!parsed.success) {
          throw new ApiError(
            'invalid-response',
            `${op}: the API answered in an unexpected shape. Update Junction or report it.`,
            status,
          );
        }
        return parsed.data;
      }

      const apiMessage = messageOf(body);
      switch (status) {
        case 401:
          if (auth && !refreshed) {
            refreshed = true;
            await this.opts.getToken(true);
            continue;
          }
          throw new ApiError(
            'signed-out',
            'Your sign-in expired. Run `junction login` again.',
            status,
          );
        case 429: {
          const retryAfter = Number(res.headers.get('retry-after') ?? '5');
          this.pacer.throttled(op, Number.isFinite(retryAfter) ? retryAfter : 5, cost);
          // A throttled request was refused and spent no quota, so trying again is safe.
          if (++throttles <= 3) continue;
          throw new ApiError(
            'throttled',
            `${op}: the API is throttling this account. Wait a minute and try again.`,
            status,
          );
        }
        case 400:
          throw new ApiError(
            'bad-request',
            `${op}: the API refused the request (${apiMessage ?? 'bad request'}).`,
            status,
          );
        case 403:
          if (body === undefined) {
            throw new ApiError(
              'edge-refused',
              `${op}: the API edge refused this network address. Try another network or turn off a VPN.`,
              status,
            );
          }
          throw new ApiError(
            'not-registered',
            'You are signed in, but this account is not registered for the event. Register for re:Invent, then sign in again.',
            status,
          );
        case 404:
          throw new ApiError('not-found', `${op}: ${apiMessage ?? 'not found'}.`, status);
        case 409:
          throw new ApiError(
            'closed',
            `${op} is closed right now (${apiMessage ?? 'operation unavailable'}). This is not a bug; it opens on the event's schedule.`,
            status,
          );
        default:
          if (status >= 500) {
            if (isWrite) {
              throw new ApiError(
                'unknown-outcome',
                `${op}: the API failed (${status}) after receiving the request. Junction will read your schedule to check what was applied.`,
                status,
              );
            }
            if (++serverRetries <= 1) {
              await this.clock.sleep(1000);
              continue;
            }
            throw new ApiError(
              'server',
              `${op}: the API is failing (${status}). Try again in a few minutes.`,
              status,
            );
          }
          throw new ApiError('server', `${op}: unexpected status ${status}.`, status);
      }
    }
  }

  listEvents(): Promise<ApiEvent[]> {
    return this.call('ListEvents', 'GET', '/events', listEventsSchema, { auth: false }).then(
      (r) => r.items,
    );
  }

  getEvent(eventId: string): Promise<ApiEvent> {
    return this.call('GetEvent', 'GET', `/events/${enc(eventId)}`, getEventSchema, {
      auth: false,
    }).then((r) => r.event);
  }

  /** Walks every page until `nextToken` is absent. A short page is not the last page. */
  async listAllSessions(
    eventId: string,
    onPage?: (fetched: number, total: number | undefined) => void,
  ): Promise<{ items: Record<string, unknown>[]; totalCount: number | undefined; pages: number }> {
    const items: Record<string, unknown>[] = [];
    let nextToken: string | undefined;
    let totalCount: number | undefined;
    let pages = 0;
    do {
      const qs = new URLSearchParams({ includeAbstracts: 'false' });
      if (nextToken) qs.set('nextToken', nextToken);
      const page = await this.call(
        'ListSessions',
        'GET',
        `/events/${enc(eventId)}/sessions?${qs}`,
        listSessionsSchema,
      );
      pages++;
      items.push(...(page.items as Record<string, unknown>[]));
      totalCount = page.totalCount ?? totalCount;
      nextToken = page.nextToken;
      onPage?.(items.length, totalCount);
    } while (nextToken);
    return { items, totalCount, pages };
  }

  getSession(eventId: string, sessionId: string): Promise<Record<string, unknown>> {
    return this.call(
      'GetSession',
      'GET',
      `/events/${enc(eventId)}/sessions/${enc(sessionId)}`,
      getSessionSchema,
    ).then((r) => r.session as Record<string, unknown>);
  }

  getSchedule(eventId: string): Promise<Schedule> {
    return this.call(
      'GetSchedule',
      'GET',
      `/events/${enc(eventId)}/schedule`,
      getScheduleSchema,
    ).then((r) => r.schedule);
  }

  /** Splits into requests of at most 10 sessions. Each request is reported per session. */
  async associateFavorites(eventId: string, sessionIds: readonly string[]): Promise<BulkResult> {
    return this.bulk('AssociateFavorites', `/events/${enc(eventId)}/favorites`, sessionIds);
  }

  async reserveSessions(eventId: string, sessionIds: readonly string[]): Promise<BulkResult> {
    return this.bulk('ReserveSessions', `/events/${enc(eventId)}/reservations`, sessionIds);
  }

  private async bulk(
    op: Operation,
    path: string,
    sessionIds: readonly string[],
  ): Promise<BulkResult> {
    const out: BulkResult = { successful: [], failed: [] };
    const unique = [...new Set(sessionIds)];
    for (let i = 0; i < unique.length; i += BULK_MAX) {
      const chunk = unique.slice(i, i + BULK_MAX);
      const r = await this.call(op, 'POST', path, bulkResponseSchema, {
        body: { sessionIds: chunk },
        cost: chunk.length,
      });
      out.successful.push(...r.result.successful);
      out.failed.push(...r.result.failed);
    }
    return out;
  }

  disassociateFavorite(eventId: string, sessionId: string): Promise<void> {
    return this.call(
      'DisassociateFavorite',
      'DELETE',
      `/events/${enc(eventId)}/favorites/${enc(sessionId)}`,
      undefined,
    );
  }

  cancelReservation(eventId: string, sessionId: string): Promise<void> {
    return this.call(
      'CancelReservation',
      'DELETE',
      `/events/${enc(eventId)}/reservations/${enc(sessionId)}`,
      undefined,
    );
  }

  /** Returns no body and has no idempotency key. Reconcile with GetSchedule; never re-send blindly. */
  createPersonalTime(eventId: string, input: PersonalTimeInput): Promise<void> {
    return this.call(
      'CreatePersonalTime',
      'POST',
      `/events/${enc(eventId)}/personal-time`,
      undefined,
      { body: input },
    );
  }

  updatePersonalTime(
    eventId: string,
    personalTimeId: string,
    input: PersonalTimeInput,
  ): Promise<void> {
    return this.call(
      'UpdatePersonalTime',
      'PUT',
      `/events/${enc(eventId)}/personal-time/${enc(personalTimeId)}`,
      undefined,
      {
        body: input,
      },
    );
  }

  deletePersonalTime(eventId: string, personalTimeId: string): Promise<void> {
    return this.call(
      'DeletePersonalTime',
      'DELETE',
      `/events/${enc(eventId)}/personal-time/${enc(personalTimeId)}`,
      undefined,
    );
  }
}

function enc(s: string): string {
  return encodeURIComponent(s);
}
