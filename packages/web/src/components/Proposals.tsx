import { useState } from 'react';
import type { Proposal, SquadView } from '@junction/core';
import { describeProposal, type ProposalText } from '../lib/proposals';
import type { AppState, DataSource, SessionResult } from '../data/types';
import { plural } from '../lib/format';

// Proposals as a plain list. Accepting writes to the attendee's own schedule through the local
// agent; the outcome is shown per session, as the schedule confirms it, never as a bare "done".

interface Settled {
  proposal: Proposal;
  text: ProposalText;
  results: SessionResult[];
}

function ResultList({ results }: { results: SessionResult[] }) {
  if (results.length === 0) return null;
  return (
    <ul className="results">
      {results.map((r) => (
        <li key={`${r.action}-${r.sessionId}`} className={r.ok ? 'ok' : 'failed'}>
          <strong>{r.code}</strong>{' '}
          {r.ok
            ? r.action === 'add'
              ? 'added.'
              : 'released.'
            : r.action === 'add'
              ? 'not added.'
              : 'not released.'}{' '}
          <span>{r.detail}</span>
        </li>
      ))}
    </ul>
  );
}

function acceptedLine(results: SessionResult[]): string {
  const failed = results.filter((r) => !r.ok).length;
  if (results.length === 0) return 'Accepted.';
  if (failed === 0) return 'Accepted. Your schedule confirms every change.';
  return `Accepted, but ${plural(failed, 'change', 'changes')} did not go through. Check the list, then try again or undo.`;
}

export function Proposals({
  view,
  source,
  onState,
}: {
  view: SquadView;
  source: DataSource;
  onState: (s: AppState) => void;
}) {
  const [settled, setSettled] = useState<Settled[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<{ text: string; results: SessionResult[] } | null>(null);

  const settledIds = new Set(settled.map((s) => s.proposal.id));
  const open = view.proposals.filter((p) => !settledIds.has(p.id));
  const mine = open.filter((p) => p.memberId === view.me);
  const others = open.filter((p) => p.memberId !== view.me);

  const fail = (id: string, e: unknown) =>
    setErrors((prev) => ({
      ...prev,
      [id]: e instanceof Error ? e.message : 'That did not work. Reload the page and try again.',
    }));
  const clearError = (id: string) =>
    setErrors((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });

  async function run(id: string, action: () => Promise<void>) {
    setBusy(id);
    clearError(id);
    setNotice(null);
    try {
      await action();
    } catch (e) {
      fail(id, e);
    } finally {
      setBusy(null);
    }
  }

  const accept = (p: Proposal, text: ProposalText) =>
    run(p.id, async () => {
      const out = await source.accept(p.id);
      setSettled((prev) => [...prev, { proposal: p, text, results: out.results }]);
      onState(out.state);
    });
  const decline = (p: Proposal) =>
    run(p.id, async () => {
      onState(await source.decline(p.id));
    });
  const undo = (s: Settled) =>
    run(s.proposal.id, async () => {
      const out = await source.undo(s.proposal.id);
      setSettled((prev) => prev.filter((x) => x.proposal.id !== s.proposal.id));
      const failed = out.results.filter((r) => !r.ok).length;
      setNotice({
        text:
          failed === 0
            ? `Undone. ${s.text.title} is back to how it was.`
            : `Undo finished, but ${plural(failed, 'change', 'changes')} did not go through. Check the list.`,
        results: out.results,
      });
      onState(out.state);
    });

  const empty = mine.length === 0 && others.length === 0 && settled.length === 0;

  return (
    <section aria-labelledby="h-props">
      <h2 id="h-props">Proposals for you</h2>
      <p className="cap">Nothing changes on your schedule until you accept.</p>
      {notice && (
        <div className="notice-block" role="status">
          <p>{notice.text}</p>
          <ResultList results={notice.results} />
        </div>
      )}
      <ul className="props">
        {settled.map((s) => (
          <li key={s.proposal.id} className="is-done">
            <h3>{s.text.title}</h3>
            <p>{s.text.sentence}</p>
            <div className="done" role="status">
              <p>{acceptedLine(s.results)}</p>
              <ResultList results={s.results} />
              <button
                className="linklike"
                type="button"
                disabled={busy === s.proposal.id}
                onClick={() => undo(s)}
              >
                {busy === s.proposal.id ? 'Undoing' : 'Undo'}
              </button>
            </div>
            {errors[s.proposal.id] && (
              <p className="err" role="alert">
                {errors[s.proposal.id]}
              </p>
            )}
          </li>
        ))}
        {[...mine, ...others].map((p) => {
          const text = describeProposal(p, view);
          return (
            <li key={p.id}>
              <h3>{text.title}</h3>
              <p>{text.sentence}</p>
              <details>
                <summary>Why this</summary>
                {text.why.map((w) => (
                  <p key={w}>{w}</p>
                ))}
              </details>
              {text.forMe ? (
                <div className="actions">
                  <button className="btn" type="button" disabled={busy !== null} onClick={() => accept(p, text)}>
                    {busy === p.id ? 'Working' : text.accept}
                  </button>
                  <button className="linklike" type="button" disabled={busy !== null} onClick={() => decline(p)}>
                    {text.decline}
                  </button>
                </div>
              ) : (
                <p className="waiting">Waiting for {text.ownerName}. Only they can accept it.</p>
              )}
              {errors[p.id] && (
                <p className="err" role="alert">
                  {errors[p.id]}
                </p>
              )}
            </li>
          );
        })}
        {empty && (
          <li className="empty">
            <p>No proposals right now. Your picks and the squad rules agree.</p>
          </li>
        )}
      </ul>
    </section>
  );
}
