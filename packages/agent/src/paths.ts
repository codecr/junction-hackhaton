import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

// Everything the agent keeps lives under ~/.junction (or JUNCTION_HOME, used by tests). Files that
// hold secrets are written with mode 0600 and replaced atomically. On Windows the mode is advisory;
// the directory sits inside the user profile, which only that user can read by default.

export function junctionHome(): string {
  return process.env.JUNCTION_HOME ?? join(homedir(), '.junction');
}

export const paths = {
  credentials: () => join(junctionHome(), 'credentials.json'),
  key: () => join(junctionHome(), 'member-key.json'),
  profile: () => join(junctionHome(), 'profile.json'),
  catalogDb: () => join(junctionHome(), 'catalog.db'),
  squadDir: () => join(junctionHome(), 'squad'),
  charter: () => join(junctionHome(), 'squad', 'charter.json'),
  manifests: () => join(junctionHome(), 'squad', 'manifests.json'),
  squadLocal: () => join(junctionHome(), 'squad', 'local.json'),
};

export function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
}

export function writePrivate(file: string, data: string): void {
  ensureDir(dirname(file));
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, data, { mode: 0o600 });
  try {
    chmodSync(tmp, 0o600);
  } catch {
    // Not supported on every file system. The directory is still private.
  }
  renameSync(tmp, file);
}

export function writeJson(file: string, value: unknown): void {
  writePrivate(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function readJson<T>(file: string): T | undefined {
  if (!existsSync(file)) return undefined;
  return JSON.parse(readFileSync(file, 'utf8')) as T;
}

export function removeFile(file: string): void {
  rmSync(file, { force: true });
}
