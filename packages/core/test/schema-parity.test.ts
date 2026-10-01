import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  BASE64URL_PATTERN,
  charterSchema,
  claimSchema,
  envelopeSchema,
  manifestSchema,
  signalSchema,
} from '../src/schemas';

// The files in schemas/ are the published contract. The zod schemas are what runs. This test makes
// sure they describe the same documents. Rules zod cannot express in JSON Schema (the sharing-level
// allOf in manifest, duplicate session ids) are covered by schemas.test.ts instead.

type Json = Record<string, unknown>;
const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const BOUNDS = ['minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems'] as const;

function load(name: string): Json {
  const url = new URL(`../../../schemas/${name}.schema.json`, import.meta.url);
  return JSON.parse(readFileSync(fileURLToPath(url), 'utf8')) as Json;
}

function diff(published: Json, generated: Json, path: string): string[] {
  const out: string[] = [];
  const at = (what: string) => `${path || '(root)'}: ${what}`;

  if ('const' in published && published.const !== generated.const)
    out.push(at(`const ${String(published.const)} vs ${String(generated.const)}`));
  if (published.enum) {
    const a = JSON.stringify([...(published.enum as string[])].sort());
    const b = JSON.stringify([...((generated.enum as string[] | undefined) ?? [])].sort());
    if (a !== b) out.push(at(`enum ${a} vs ${b}`));
  }
  if (published.type && !('const' in published) && published.type !== generated.type) {
    out.push(at(`type ${String(published.type)} vs ${String(generated.type)}`));
  }
  if (published.pattern && published.pattern !== generated.pattern) out.push(at('pattern differs'));
  if (published.contentEncoding === 'base64url' && generated.pattern !== BASE64URL_PATTERN.source) {
    out.push(at('base64url field is not restricted to the base64url alphabet'));
  }
  if (published.format === 'date-time' && generated.format !== 'date-time')
    out.push(at('date-time format missing'));

  for (const key of BOUNDS) {
    const p = published[key];
    const g = generated[key];
    if (p !== undefined && p !== g) out.push(at(`${key} ${String(p)} vs ${String(g)}`));
    if (p === undefined && g !== undefined && !(key === 'maximum' && g === MAX_SAFE)) {
      out.push(at(`${key} is ${String(g)} in zod but unbounded in the published schema`));
    }
  }

  if (published.type === 'object') {
    if (published.additionalProperties === false && generated.additionalProperties !== false) {
      out.push(at('additionalProperties is not false'));
    }
    const pReq = JSON.stringify([...((published.required as string[] | undefined) ?? [])].sort());
    const gReq = JSON.stringify([...((generated.required as string[] | undefined) ?? [])].sort());
    if (pReq !== gReq) out.push(at(`required ${pReq} vs ${gReq}`));
    const pProps = (published.properties ?? {}) as Record<string, Json>;
    const gProps = (generated.properties ?? {}) as Record<string, Json>;
    const pKeys = Object.keys(pProps).sort();
    const gKeys = Object.keys(gProps).sort();
    if (JSON.stringify(pKeys) !== JSON.stringify(gKeys)) {
      out.push(at(`properties ${pKeys.join(',')} vs ${gKeys.join(',')}`));
    }
    for (const key of pKeys) {
      const g = gProps[key];
      if (g) out.push(...diff(pProps[key]!, g, `${path}.${key}`));
    }
  }
  if (published.type === 'array' && published.items) {
    out.push(...diff(published.items as Json, (generated.items ?? {}) as Json, `${path}[]`));
  }
  return out;
}

describe.each([
  ['charter', charterSchema],
  ['manifest', manifestSchema],
  ['signal', signalSchema],
  ['claim', claimSchema],
  ['envelope', envelopeSchema],
] as const)('%s', (name, schema) => {
  it('matches the published JSON Schema in schemas/', () => {
    const generated = z.toJSONSchema(schema, { target: 'draft-2020-12', io: 'input' }) as Json;
    expect(diff(load(name), generated, '')).toEqual([]);
  });
});

describe('the comparer itself', () => {
  it('notices a drift (a tighter bound in zod than in the published file)', () => {
    const published = load('claim');
    const generated = z.toJSONSchema(claimSchema, { target: 'draft-2020-12', io: 'input' }) as Json;
    const props = published.properties as Record<string, Json>;
    props.rank = { type: 'integer', minimum: 1 };
    expect(diff(published, generated, '').length).toBeGreaterThan(0);
  });
});
