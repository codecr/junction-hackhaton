import { fromBase64Url, sha256Hex, toBase64Url, utf8 } from './bytes';
import { sign, verify } from './keys';
import { err, ok, type Result } from './result';
import { MEMBER_ID_PATTERN } from './schemas';

// Signed requests to the squad server (docs/03, "Squad server API"). The clock and the nonce are
// inputs, so core stays pure. Nonce uniqueness is enforced by the server with a conditional put.

export const REQUEST_WINDOW_SEC = 120;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

export interface RequestToSign {
  method: string;
  /** Path without the query string, for example `/v1/squads/sq_x/charter`. */
  path: string;
  body: string;
}

export interface SignedAuth {
  kid: string;
  ts: number;
  nonce: string;
  sig: string;
}

export function stringToSign(req: RequestToSign, ts: number, nonce: string): string {
  return `${req.method.toUpperCase()}\n${req.path}\n${ts}\n${nonce}\n${sha256Hex(utf8(req.body))}`;
}

export function signRequest(
  req: RequestToSign,
  kid: string,
  secretKey: Uint8Array,
  nowSec: number,
  nonceBytes: Uint8Array,
): string {
  const nonce = toBase64Url(nonceBytes);
  const sig = toBase64Url(sign(utf8(stringToSign(req, nowSec, nonce)), secretKey));
  return `Junction kid=${kid}, ts=${nowSec}, nonce=${nonce}, sig=${sig}`;
}

export type RequestAuthError =
  'missing' | 'malformed' | 'stale' | 'unknown-member' | 'bad-signature';

export function parseAuthHeader(header: string | undefined): Result<SignedAuth, RequestAuthError> {
  if (!header) return err('missing');
  const m = /^Junction (.+)$/.exec(header.trim());
  if (!m) return err('malformed');
  const fields = new Map<string, string>();
  for (const part of m[1]!.split(',')) {
    const eq = part.indexOf('=');
    if (eq < 0) return err('malformed');
    fields.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
  }
  const kid = fields.get('kid');
  const tsRaw = fields.get('ts');
  const nonce = fields.get('nonce');
  const sig = fields.get('sig');
  if (!kid || !tsRaw || !nonce || !sig) return err('malformed');
  if (!MEMBER_ID_PATTERN.test(kid) || !/^\d{1,12}$/.test(tsRaw) || !NONCE_PATTERN.test(nonce)) {
    return err('malformed');
  }
  if (!/^[A-Za-z0-9_-]{80,100}$/.test(sig)) return err('malformed');
  return ok({ kid, ts: Number(tsRaw), nonce, sig });
}

/**
 * Checks the header against the request. `publicKeyOf` returns the raw Ed25519 key of a member, or
 * undefined when the member is unknown. The caller must still record the nonce.
 */
export function verifyRequest(
  req: RequestToSign,
  header: string | undefined,
  publicKeyOf: (memberId: string) => Uint8Array | undefined,
  nowSec: number,
): Result<SignedAuth, RequestAuthError> {
  const parsed = parseAuthHeader(header);
  if (!parsed.ok) return parsed;
  const auth = parsed.value;
  if (Math.abs(nowSec - auth.ts) > REQUEST_WINDOW_SEC) return err('stale');
  const key = publicKeyOf(auth.kid);
  if (!key) return err('unknown-member');
  let sigBytes: Uint8Array;
  try {
    sigBytes = fromBase64Url(auth.sig);
  } catch {
    return err('malformed');
  }
  if (!verify(sigBytes, utf8(stringToSign(req, auth.ts, auth.nonce)), key)) {
    return err('bad-signature');
  }
  return ok(auth);
}
