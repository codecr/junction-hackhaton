import type { SquadView } from '@junction/core';

// The contract between the UI and whatever feeds it: the local agent at the same origin, or the
// in-browser demo. Both return the same shapes, so every screen is written once.

export interface StateMember {
  memberId: string;
  name: string;
}

export interface AppState {
  signedIn: boolean;
  member: StateMember | null;
  squad: SquadView | null;
  lastSync: string | null;
  catalog: { count: number; fetchedAt: string } | null;
}

/** Per-session outcome of a write, confirmed from the schedule (never inferred from an HTTP 200). */
export interface SessionResult {
  sessionId: string;
  code: string;
  action: 'add' | 'remove';
  ok: boolean;
  detail: string;
}

export interface ActionResult {
  results: SessionResult[];
  state: AppState;
}

export interface DataSource {
  readonly mode: 'demo' | 'agent';
  getState(): Promise<AppState>;
  sync(): Promise<AppState>;
  accept(proposalId: string): Promise<ActionResult>;
  decline(proposalId: string): Promise<AppState>;
  undo(proposalId: string): Promise<ActionResult>;
  login(): Promise<void>;
  logout(): Promise<AppState>;
  exportPicks(): Promise<string>;
  importPicks(text: string): Promise<AppState>;
}

/** An error the user can act on. `message` already says what happened and what to do. */
export class SourceError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'SourceError';
    this.code = code;
  }
}
