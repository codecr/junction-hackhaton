import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  BatchWriteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import type { Envelope } from '@junction/core';

// Single-table layout (docs/03, "Squad server API"): pk = SQUAD#<id>, sk = CHARTER, MANIFEST#<mid>,
// SIGNAL#<iso>#<mid>#<sessionId>, ANNOUNCE#<sessionId>, CLAIM#<sessionId>, JOIN#<mid>, NONCE#<nonce>.
//
// CLAUDE.md rule 2: an item holds the signed envelope as received (`env`) and nothing else from the
// request, plus bookkeeping the server needs to do its job: `mid` (who wrote it, for leave), `seq`
// (for the conditional seq-increasing put), `at` (server receive time), `ttl`. Join requests hold
// the requester's public key and display name, the two fields a leader needs to approve them.

export interface StoredItem {
  sk: string;
  ttl: number;
  env?: Envelope;
  mid?: string;
  seq?: number;
  at?: string;
  publicKey?: string;
  name?: string;
}

/** `absent`: only when no item has this key. `seqBelow`: only when absent or stored seq < n. */
export type PutCondition =
  { kind: 'none' } | { kind: 'absent' } | { kind: 'seq-below'; seq: number };

export interface QueryOptions {
  /** Return only items whose sk is strictly greater than this. */
  after?: string;
  limit?: number;
}

export interface QueryPage {
  items: StoredItem[];
  /** Present when more items may follow; pass it as `after`. */
  last?: string;
}

export interface SquadStore {
  get(squadId: string, sk: string): Promise<StoredItem | undefined>;
  /** Returns false when the condition failed. */
  put(squadId: string, item: StoredItem, condition: PutCondition): Promise<boolean>;
  query(squadId: string, prefix: string, options?: QueryOptions): Promise<QueryPage>;
  delete(squadId: string, sks: string[]): Promise<void>;
}

export const squadPk = (squadId: string) => `SQUAD#${squadId}`;

/** Reads every item under a prefix, following pages. */
export async function queryAll(
  store: SquadStore,
  squadId: string,
  prefix: string,
): Promise<StoredItem[]> {
  const all: StoredItem[] = [];
  let after: string | undefined;
  for (;;) {
    const page = await store.query(squadId, prefix, after === undefined ? {} : { after });
    all.push(...page.items);
    if (page.last === undefined) return all;
    after = page.last;
  }
}

/** In-memory store with the same semantics as DynamoStore. Used by tests and local runs. */
export class MemoryStore implements SquadStore {
  readonly squads = new Map<string, Map<string, StoredItem>>();

  private squad(squadId: string): Map<string, StoredItem> {
    let s = this.squads.get(squadId);
    if (!s) {
      s = new Map();
      this.squads.set(squadId, s);
    }
    return s;
  }

  async get(squadId: string, sk: string): Promise<StoredItem | undefined> {
    const item = this.squads.get(squadId)?.get(sk);
    return item === undefined ? undefined : structuredClone(item);
  }

  async put(squadId: string, item: StoredItem, condition: PutCondition): Promise<boolean> {
    const s = this.squad(squadId);
    const existing = s.get(item.sk);
    if (condition.kind === 'absent' && existing) return false;
    if (condition.kind === 'seq-below' && existing && !((existing.seq ?? -1) < condition.seq)) {
      return false;
    }
    s.set(item.sk, structuredClone(item));
    return true;
  }

  async query(squadId: string, prefix: string, options: QueryOptions = {}): Promise<QueryPage> {
    const s = this.squads.get(squadId);
    if (!s) return { items: [] };
    const keys = [...s.keys()]
      .filter((k) => k.startsWith(prefix) && (options.after === undefined || k > options.after))
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const limit = options.limit ?? 1000;
    const taken = keys.slice(0, limit);
    const items = taken.map((k) => structuredClone(s.get(k)!));
    return keys.length > limit ? { items, last: taken[taken.length - 1]! } : { items };
  }

  async delete(squadId: string, sks: string[]): Promise<void> {
    const s = this.squads.get(squadId);
    if (!s) return;
    for (const sk of sks) s.delete(sk);
    if (s.size === 0) this.squads.delete(squadId);
  }
}

function isConditionFailure(e: unknown): boolean {
  return (
    typeof e === 'object' &&
    e !== null &&
    (e as { name?: string }).name === 'ConditionalCheckFailedException'
  );
}

export class DynamoStore implements SquadStore {
  private readonly doc: DynamoDBDocumentClient;

  constructor(
    private readonly tableName: string,
    client: DynamoDBClient = new DynamoDBClient({}),
  ) {
    this.doc = DynamoDBDocumentClient.from(client, {
      marshallOptions: { removeUndefinedValues: true },
    });
  }

  async get(squadId: string, sk: string): Promise<StoredItem | undefined> {
    const out = await this.doc.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { pk: squadPk(squadId), sk },
        ConsistentRead: true,
      }),
    );
    return out.Item ? toStored(out.Item) : undefined;
  }

  async put(squadId: string, item: StoredItem, condition: PutCondition): Promise<boolean> {
    const base = { TableName: this.tableName, Item: { pk: squadPk(squadId), ...item } };
    const conditional =
      condition.kind === 'absent'
        ? { ConditionExpression: 'attribute_not_exists(pk)' }
        : condition.kind === 'seq-below'
          ? {
              ConditionExpression: 'attribute_not_exists(pk) OR #seq < :seq',
              ExpressionAttributeNames: { '#seq': 'seq' },
              ExpressionAttributeValues: { ':seq': condition.seq },
            }
          : {};
    try {
      await this.doc.send(new PutCommand({ ...base, ...conditional }));
      return true;
    } catch (e) {
      if (isConditionFailure(e)) return false;
      throw e;
    }
  }

  async query(squadId: string, prefix: string, options: QueryOptions = {}): Promise<QueryPage> {
    const limit = options.limit ?? 1000;
    // BETWEEN is inclusive, so ask for one more and drop an exact match on `after`.
    const out = await this.doc.send(
      new QueryCommand({
        TableName: this.tableName,
        ConsistentRead: true,
        KeyConditionExpression:
          options.after === undefined
            ? 'pk = :pk AND begins_with(sk, :prefix)'
            : 'pk = :pk AND sk BETWEEN :lo AND :hi',
        ExpressionAttributeValues:
          options.after === undefined
            ? { ':pk': squadPk(squadId), ':prefix': prefix }
            : { ':pk': squadPk(squadId), ':lo': options.after, ':hi': `${prefix}￿` },
        Limit: limit + 1,
      }),
    );
    const items = (out.Items ?? [])
      .map(toStored)
      .filter(
        (i) => i.sk.startsWith(prefix) && (options.after === undefined || i.sk > options.after),
      );
    const more = items.length > limit || out.LastEvaluatedKey !== undefined;
    const page = items.slice(0, limit);
    const last = page[page.length - 1];
    return more && last ? { items: page, last: last.sk } : { items: page };
  }

  async delete(squadId: string, sks: string[]): Promise<void> {
    for (let i = 0; i < sks.length; i += 25) {
      let requests: Record<string, unknown>[] = sks.slice(i, i + 25).map((sk) => ({
        DeleteRequest: { Key: { pk: squadPk(squadId), sk } },
      }));
      for (let attempt = 0; requests.length > 0 && attempt < 5; attempt += 1) {
        const out = await this.doc.send(
          new BatchWriteCommand({ RequestItems: { [this.tableName]: requests } }),
        );
        requests = (out.UnprocessedItems?.[this.tableName] ?? []) as Record<string, unknown>[];
      }
      if (requests.length > 0)
        throw new Error('DynamoDB left deletes unprocessed after 5 attempts.');
    }
  }
}

function toStored(raw: Record<string, unknown>): StoredItem {
  const { pk: _pk, ...rest } = raw;
  return rest as unknown as StoredItem;
}
