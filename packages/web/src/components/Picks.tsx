import { useEffect, useId, useState } from 'react';
import type { AppState, DataSource } from '../data/types';

// Sharing picks by hand: copy my signed block, paste a squad member's. Works when the squad
// server is unreachable, and it is the whole flow in the no-squad state.

export function ExportPicks({ source }: { source: DataSource }) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const id = useId();

  useEffect(() => {
    let live = true;
    source.exportPicks().then(
      (t) => live && setText(t),
      (e: unknown) =>
        live && setError(e instanceof Error ? e.message : 'Your picks could not be read.'),
    );
    return () => {
      live = false;
    };
  }, [source]);

  async function copy() {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      setError('The browser did not allow copying. Select the text and copy it by hand.');
    }
  }

  return (
    <div className="picks-block">
      <label htmlFor={id}>Your picks</label>
      <p className="cap">
        Send this block to your squad. It holds session codes and your signature, nothing else.
      </p>
      {error ? (
        <p className="err" role="alert">
          {error}
        </p>
      ) : (
        <>
          <textarea
            id={id}
            readOnly
            rows={4}
            value={text ?? ''}
            placeholder="Reading your picks"
            onFocus={(e) => e.currentTarget.select()}
          />
          <div className="actions">
            <button className="btn quiet" type="button" disabled={!text} onClick={copy}>
              Copy
            </button>
            <span role="status" className="cap">
              {copied ? 'Copied.' : ''}
            </span>
          </div>
        </>
      )}
    </div>
  );
}

export function ImportPicks({
  source,
  onState,
}: {
  source: DataSource;
  onState: (s: AppState) => void;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const id = useId();

  async function submit() {
    setBusy(true);
    setError(null);
    setDone(false);
    try {
      onState(await source.importPicks(text.trim()));
      setText('');
      setDone(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Those picks could not be added.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="picks-block"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <label htmlFor={id}>Picks from your squad</label>
      <p className="cap">Paste the block someone in your squad sent you.</p>
      <textarea
        id={id}
        rows={4}
        value={text}
        onChange={(e) => setText(e.target.value)}
        spellCheck={false}
      />
      <div className="actions">
        <button className="btn" type="submit" disabled={busy || text.trim() === ''}>
          {busy ? 'Adding' : 'Add picks'}
        </button>
        <span role="status" className="cap">
          {done ? 'Added.' : ''}
        </span>
      </div>
      {error && (
        <p className="err" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
