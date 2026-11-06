import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import {
  envelopeSchema,
  fromBase64Url,
  isNewer,
  keyPairFromSeed,
  memberIdFromPublicKey,
  openCharter,
  openMessage,
  sha256Bytes,
  signMessage,
  squadIdFrom,
  toBase64Url,
  utf8,
  type Charter,
  type CharterTopic,
  type Envelope,
  type KeyPair,
  type Manifest,
} from '@junction/core';
import { paths, readJson, removeFile, writeJson } from './paths';

// The member's identity (an Ed25519 key, ADR-002) and the squad state on this machine: the latest
// verified charter, the latest verified manifest per member, and local-only data (invite secret,
// holds, priorities, accepted proposals). Exchange is by file or pasted block (C5); the squad
// server carries the same envelopes.

export interface Identity extends KeyPair {
  memberId: string;
  name: string;
}

const keyFileSchema = z.strictObject({ seed: z.string(), name: z.string().min(1).max(40) });

export function loadIdentity(): Identity | undefined {
  const parsed = keyFileSchema.safeParse(readJson(paths.key()));
  if (!parsed.success) return undefined;
  const kp = keyPairFromSeed(fromBase64Url(parsed.data.seed));
  return { ...kp, memberId: memberIdFromPublicKey(kp.publicKey), name: parsed.data.name };
}

export function ensureIdentity(name?: string): Identity {
  const existing = loadIdentity();
  if (existing) {
    if (name && name !== existing.name) {
      const seed = toBase64Url(existing.secretKey);
      writeJson(paths.key(), { seed, name });
      return { ...existing, name };
    }
    return existing;
  }
  const displayName = (name ?? 'Member').slice(0, 40);
  writeJson(paths.key(), { seed: toBase64Url(randomBytes(32)), name: displayName });
  return loadIdentity()!;
}

export interface LocalSquad {
  /** Only the leader keeps it. Shared out of band as part of the invite. */
  inviteSecret?: string;
  share: 'L0' | 'L1' | 'L2';
  seq: number;
  holds: { sessionId: string; reason: 'declined' | 'pinned'; at: string }[];
  priorities: Record<string, number>;
  accepted: {
    proposalId: string;
    at: string;
    added: { sessionId: string; as: 'favorite' | 'reserved' }[];
    removed: { sessionId: string; was: 'favorite' | 'reserved' }[];
  }[];
  relayUrl?: string | undefined;
  /** Set after a join request through the squad server, until the leader approves. */
  pendingSquadId?: string | undefined;
}

export function loadLocal(): LocalSquad {
  return (
    readJson<LocalSquad>(paths.squadLocal()) ?? {
      share: 'L0',
      seq: 0,
      holds: [],
      priorities: {},
      accepted: [],
    }
  );
}

export function saveLocal(local: LocalSquad): void {
  writeJson(paths.squadLocal(), local);
}

export function loadCharterEnvelope(): Envelope | undefined {
  return readJson<Envelope>(paths.charter());
}

export function loadCharter(): Charter | undefined {
  const env = loadCharterEnvelope();
  if (!env) return undefined;
  const r = openCharter(env);
  return r.ok ? r.value : undefined;
}

export function loadManifestEnvelopes(): Record<string, Envelope> {
  return readJson<Record<string, Envelope>>(paths.manifests()) ?? {};
}

export function loadManifests(charter: Charter): Manifest[] {
  const out: Manifest[] = [];
  for (const env of Object.values(loadManifestEnvelopes())) {
    const r = openMessage(env, charter);
    if (r.ok && r.value.type === 'manifest') out.push(r.value);
  }
  return out;
}

export function storeManifestEnvelope(memberId: string, env: Envelope): void {
  const all = loadManifestEnvelopes();
  all[memberId] = env;
  writeJson(paths.manifests(), all);
}

export interface CreateSquadInput {
  name: string;
  eventId: string;
  topics?: CharterTopic[];
  mustCover?: string[];
  lunch?: { start: string; end: string; protected: boolean };
  maxPerDay?: number;
  /** ISO instant used as issuedAt. */
  now: string;
  /** Event end plus 14 days (docs/03). */
  expiresAt: string;
}

export function createSquad(
  me: Identity,
  input: CreateSquadInput,
): { charter: Charter; envelope: Envelope; invite: string } {
  const secret = toBase64Url(randomBytes(16));
  const charter: Charter = {
    v: 1,
    type: 'charter',
    squadId: squadIdFrom(me.publicKey, randomBytes(16)),
    name: input.name,
    eventId: input.eventId,
    leader: me.memberId,
    seq: 1,
    issuedAt: input.now,
    expiresAt: input.expiresAt,
    inviteVerifier: toBase64Url(sha256Bytes(utf8(secret))),
    members: [
      {
        memberId: me.memberId,
        name: me.name,
        publicKey: toBase64Url(me.publicKey),
        role: 'leader',
        joinedAt: input.now,
      },
    ],
    topics: input.topics ?? [],
    ...(input.mustCover?.length
      ? { mustCover: input.mustCover.map((sessionId) => ({ sessionId })) }
      : {}),
    ...(input.lunch ? { lunch: input.lunch } : {}),
    ...(input.maxPerDay ? { caps: { maxPerDay: input.maxPerDay } } : {}),
    travel: { bufferMin: 0 },
    tolerance: 0.2,
  };
  const envelope = signMessage(charter, me.memberId, me.secretKey);
  writeJson(paths.charter(), envelope);
  writeJson(paths.manifests(), {});
  const local = loadLocal();
  saveLocal({ ...local, inviteSecret: secret, seq: 0, holds: [], accepted: [] });
  return { charter, envelope, invite: secret };
}

/** Leader only: re-signs the charter with a change and a higher seq. */
export function updateCharter(
  me: Identity,
  change: (c: Charter) => Charter,
  now: string,
): Envelope {
  const current = loadCharter();
  if (!current) throw new Error('No squad yet. Run `junction squad create` or import an invite.');
  if (current.leader !== me.memberId)
    throw new Error('Only the squad leader can change the squad rules.');
  const next = { ...change(current), seq: current.seq + 1, issuedAt: now };
  const env = signMessage(next, me.memberId, me.secretKey);
  const check = openCharter(env, current);
  if (!check.ok) throw new Error(check.error.message);
  writeJson(paths.charter(), env);
  return env;
}

// ---------------------------------------------------------------------------------------------
// Blocks: what members paste to each other. A block is base64url(JSON) so it survives chat apps.

const blockSchema = z.strictObject({
  v: z.literal(1),
  kind: z.enum(['picks', 'join']),
  envelopes: z.array(envelopeSchema).max(40).optional(),
  join: z
    .strictObject({
      name: z.string().min(1).max(40),
      publicKey: z.string(),
      secret: z.string().optional(),
    })
    .optional(),
});
type Block = z.infer<typeof blockSchema>;

export const BLOCK_PREFIX = 'junction1:';

export function encodeBlock(block: Block): string {
  return BLOCK_PREFIX + toBase64Url(utf8(JSON.stringify(block)));
}

export function decodeBlock(text: string): Block {
  const trimmed = text.trim().replace(/\s+/g, '');
  if (!trimmed.startsWith(BLOCK_PREFIX))
    throw new Error('This is not a Junction block. It should start with "junction1:".');
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(fromBase64Url(trimmed.slice(BLOCK_PREFIX.length))));
  } catch {
    throw new Error('The block is damaged. Copy it again, all of it.');
  }
  const parsed = blockSchema.safeParse(json);
  if (!parsed.success)
    throw new Error('The block is not in a format this version understands. Update Junction.');
  return parsed.data;
}

/** The charter plus every manifest this machine holds, so a block can catch up a whole squad. */
export function exportPicksBlock(): string {
  const charter = loadCharterEnvelope();
  if (!charter)
    throw new Error('No squad yet. Run `junction squad create` or import an invite first.');
  return encodeBlock({
    v: 1,
    kind: 'picks',
    envelopes: [charter, ...Object.values(loadManifestEnvelopes())],
  });
}

export function exportJoinBlock(me: Identity, secret?: string): string {
  return encodeBlock({
    v: 1,
    kind: 'join',
    join: { name: me.name, publicKey: toBase64Url(me.publicKey), ...(secret ? { secret } : {}) },
  });
}

export interface ImportResult {
  charterUpdated: boolean;
  manifestsAccepted: number;
  rejected: string[];
  joinRequest?: {
    name: string;
    memberId: string;
    publicKey: string;
    secretOk: boolean | undefined;
  };
}

export function importBlock(text: string): ImportResult {
  const block = decodeBlock(text);
  const result: ImportResult = { charterUpdated: false, manifestsAccepted: 0, rejected: [] };
  if (block.kind === 'join' && block.join) {
    const pk = fromBase64Url(block.join.publicKey);
    const charter = loadCharter();
    const secretOk =
      block.join.secret !== undefined && charter
        ? toBase64Url(sha256Bytes(utf8(block.join.secret))) === charter.inviteVerifier
        : undefined;
    result.joinRequest = {
      name: block.join.name,
      memberId: memberIdFromPublicKey(pk),
      publicKey: block.join.publicKey,
      secretOk,
    };
    return result;
  }
  return { ...result, ...importEnvelopes(block.envelopes ?? []) };
}

/** Verifies and stores a charter and member picks, from a pasted block or the squad server. */
export function importEnvelopes(envelopes: readonly Envelope[]): ImportResult {
  const result: ImportResult = { charterUpdated: false, manifestsAccepted: 0, rejected: [] };
  let charter = loadCharter();
  // Charters first: a newer charter may add the members whose manifests follow.
  for (const env of envelopes) {
    const r = openCharter(env, charter);
    if (r.ok) {
      if (!charter || r.value.squadId !== charter.squadId || r.value.seq > charter.seq) {
        if (charter && r.value.squadId !== charter.squadId) {
          // Joining another squad replaces local squad state.
          writeJson(paths.manifests(), {});
          removeFile(paths.squadLocal());
        }
        writeJson(paths.charter(), env);
        charter = r.value;
        result.charterUpdated = true;
      }
    }
  }
  if (!charter)
    throw new Error(
      'The block has no squad rules from a leader. Ask the leader for an invite block.',
    );
  const stored = loadManifests(charter);
  for (const env of envelopes) {
    if (openCharter(env).ok) continue;
    const r = openMessage(env, charter);
    if (!r.ok) {
      result.rejected.push(r.error.message);
      continue;
    }
    if (r.value.type !== 'manifest') continue;
    const prev = stored.find((m) => m.memberId === r.value.memberId);
    if (isNewer(r.value.seq, prev?.seq)) {
      storeManifestEnvelope(r.value.memberId, env);
      result.manifestsAccepted++;
    }
  }
  return result;
}
