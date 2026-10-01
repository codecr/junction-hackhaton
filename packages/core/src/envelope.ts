import { fromBase64Url, fromUtf8, toBase64Url } from './bytes';
import { canonicalBytes, canonicalJson } from './canonical';
import { memberIdFromPublicKey, sign, verify } from './keys';
import { err, ok, type Result } from './result';
import { parseInstant } from './time';
import {
  charterSchema,
  envelopeSchema,
  messageSchema,
  type Charter,
  type Envelope,
  type Message,
} from './schemas';

export type EnvelopeErrorCode =
  | 'malformed'
  | 'unknown-signer'
  | 'bad-signature'
  | 'non-canonical'
  | 'invalid-payload'
  | 'signer-mismatch'
  | 'wrong-squad'
  | 'wrong-event'
  | 'stale';

export interface EnvelopeError {
  code: EnvelopeErrorCode;
  message: string;
}

const fail = (code: EnvelopeErrorCode, message: string) => err<EnvelopeError>({ code, message });

/** Validates, canonicalises and signs a message. The signature covers the canonical payload bytes. */
export function signMessage(message: Message, kid: string, secretKey: Uint8Array): Envelope {
  const parsed = messageSchema.parse(message);
  const payloadBytes = canonicalBytes(parsed);
  return {
    kid,
    alg: 'Ed25519',
    payload: toBase64Url(payloadBytes),
    sig: toBase64Url(sign(payloadBytes, secretKey)),
  };
}

interface Decoded {
  envelope: Envelope;
  payloadBytes: Uint8Array;
  signature: Uint8Array;
  text: string;
  json: unknown;
}

function decode(raw: unknown): Result<Decoded, EnvelopeError> {
  const envelope = envelopeSchema.safeParse(raw);
  if (!envelope.success) {
    return fail('malformed', 'This is not a Junction envelope. Ask the sender to export it again.');
  }
  let payloadBytes: Uint8Array;
  let signature: Uint8Array;
  let text: string;
  let json: unknown;
  try {
    payloadBytes = fromBase64Url(envelope.data.payload);
    signature = fromBase64Url(envelope.data.sig);
    text = fromUtf8(payloadBytes);
    json = JSON.parse(text);
  } catch {
    return fail('malformed', 'The envelope payload or signature is not valid base64url JSON.');
  }
  return ok({ envelope: envelope.data, payloadBytes, signature, text, json });
}

function checkCanonical(d: Decoded): EnvelopeError | undefined {
  if (canonicalJson(d.json) === d.text) return undefined;
  return {
    code: 'non-canonical',
    message:
      'The payload is signed but is not canonical JSON (RFC 8785). Reject it and ask the sender to update.',
  };
}

function firstIssue(error: { issues: { path: PropertyKey[]; message: string }[] }): string {
  const issue = error.issues[0];
  if (!issue) return 'invalid payload';
  const path = issue.path.map(String).join('.');
  return path ? `${path}: ${issue.message}` : issue.message;
}

/** A charter must name one leader, unique members, and ids that match their public keys. */
export function charterProblem(charter: Charter): string | undefined {
  const issued = parseInstant(charter.issuedAt);
  const expires = parseInstant(charter.expiresAt);
  if (issued === undefined || expires === undefined || expires <= issued) {
    return 'expiresAt must be later than issuedAt';
  }
  const ids = new Set<string>();
  let leaders = 0;
  for (const member of charter.members) {
    if (ids.has(member.memberId)) return `member ${member.memberId} is listed twice`;
    ids.add(member.memberId);
    let key: Uint8Array;
    try {
      key = fromBase64Url(member.publicKey);
    } catch {
      return `member ${member.memberId} has an invalid public key`;
    }
    if (key.length !== 32) return `member ${member.memberId} has a public key of the wrong length`;
    if (memberIdFromPublicKey(key) !== member.memberId) {
      return `member ${member.memberId} does not match its public key`;
    }
    if (member.role === 'leader') {
      leaders += 1;
      if (member.memberId !== charter.leader)
        return 'the leader member does not match charter.leader';
    }
  }
  if (leaders !== 1) return 'a charter has exactly one leader';
  return undefined;
}

/**
 * Opens the leader-signed charter. Order: decode, validate shape, check the leader's key, verify
 * the signature, check canonical form, then check it moves forward from `previous`.
 */
export function openCharter(raw: unknown, previous?: Charter): Result<Charter, EnvelopeError> {
  const decoded = decode(raw);
  if (!decoded.ok) return decoded;
  const d = decoded.value;

  const parsed = charterSchema.safeParse(d.json);
  if (!parsed.success)
    return fail('invalid-payload', `Charter rejected: ${firstIssue(parsed.error)}.`);
  const charter = parsed.data;

  const problem = charterProblem(charter);
  if (problem) return fail('invalid-payload', `Charter rejected: ${problem}.`);
  if (d.envelope.kid !== charter.leader) {
    return fail('signer-mismatch', 'Only the squad leader can sign the charter.');
  }
  const leader = charter.members.find((m) => m.memberId === charter.leader);
  if (!leader || !verify(d.signature, d.payloadBytes, fromBase64Url(leader.publicKey))) {
    return fail(
      'bad-signature',
      'The charter signature does not match the leader. Do not trust this file.',
    );
  }
  const nonCanonical = checkCanonical(d);
  if (nonCanonical) return err(nonCanonical);

  if (previous) {
    if (charter.squadId !== previous.squadId)
      return fail('wrong-squad', 'This charter belongs to another squad.');
    if (charter.leader !== previous.leader)
      return fail('signer-mismatch', 'The squad leader cannot change.');
    if (charter.seq <= previous.seq) {
      return fail(
        'stale',
        `Charter seq ${charter.seq} is not newer than the one you already have (${previous.seq}).`,
      );
    }
  }
  return ok(charter);
}

/**
 * Opens a manifest, signal or claim from a squad member. Order: decode, check the signer is in the
 * verified charter, verify the signature, check canonical form, validate with zod, check ownership.
 * Sequence numbers are checked separately with `isNewer`.
 */
export function openMessage(
  raw: unknown,
  charter: Charter,
): Result<Exclude<Message, { type: 'charter' }>, EnvelopeError> {
  const decoded = decode(raw);
  if (!decoded.ok) return decoded;
  const d = decoded.value;

  const member = charter.members.find((m) => m.memberId === d.envelope.kid);
  if (!member) {
    return fail(
      'unknown-signer',
      `${d.envelope.kid} is not a member of this squad. Ask the leader to approve the join request.`,
    );
  }
  if (!verify(d.signature, d.payloadBytes, fromBase64Url(member.publicKey))) {
    return fail(
      'bad-signature',
      'The signature does not match the sender. The message was altered or is not theirs.',
    );
  }
  const nonCanonical = checkCanonical(d);
  if (nonCanonical) return err(nonCanonical);

  const parsed = messageSchema.safeParse(d.json);
  if (!parsed.success)
    return fail('invalid-payload', `Message rejected: ${firstIssue(parsed.error)}.`);
  const message = parsed.data;
  if (message.type === 'charter') {
    return fail(
      'invalid-payload',
      'A charter must be opened with openCharter, not as a member message.',
    );
  }
  if (message.memberId !== d.envelope.kid) {
    return fail(
      'signer-mismatch',
      'The message names a different member than the one who signed it.',
    );
  }
  if (message.squadId !== charter.squadId)
    return fail('wrong-squad', 'This message belongs to another squad.');
  if (message.type === 'manifest' && message.eventId !== charter.eventId) {
    return fail('wrong-event', 'This manifest is for another event.');
  }
  return ok(message);
}

/** A manifest only replaces the stored one when its seq is strictly higher. */
export function isNewer(candidateSeq: number, storedSeq: number | undefined): boolean {
  return storedSeq === undefined || candidateSeq > storedSeq;
}
