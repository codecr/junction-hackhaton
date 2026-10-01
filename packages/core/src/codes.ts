// PROVISIONAL: the suffix meaning below comes from two observed shapes (`COM302-R`, `COM302-R1`).
// Spike 0 lists every suffix in the real catalog; do not trust this until docs/FINDINGS.md says so.

export interface ParsedCode {
  /** Track letters and number, e.g. `COM302`. */
  base: string;
  /** Suffix letters, e.g. `R`. Empty when the code has no suffix. */
  suffix: string;
  /** Suffix index, e.g. 1 for `R1`. Undefined when there is none. */
  index: number | undefined;
}

const CODE = /^([A-Z]{2,6}\d{2,4}[A-Z]?)(?:-([A-Z]+)(\d*))?$/;

export function parseCode(code: string): ParsedCode | undefined {
  const match = CODE.exec(code);
  if (!match) return undefined;
  const [, base, suffix, index] = match;
  return {
    base: base as string,
    suffix: suffix ?? '',
    index: index ? Number(index) : undefined,
  };
}

/** Shared base code: `COM302-R1` and `COM302` both give `COM302`. Undefined if unparseable. */
export function baseOf(code: string): string | undefined {
  return parseCode(code)?.base;
}
