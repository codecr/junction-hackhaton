import { useCallback, useEffect, useRef, useState } from 'react';
import { ExportPicks, ImportPicks } from './components/Picks';
import { Footer, TopBar } from './components/Shell';
import { SquadScreen } from './components/SquadScreen';
import { ago } from './lib/format';
import type { AppState, DataSource } from './data/types';

type Phase =
  { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; state: AppState };

const message = (e: unknown) =>
  e instanceof Error
    ? e.message
    : 'Something went wrong talking to the local agent. Reload the page.';

function Skeleton() {
  return (
    <div className="skeleton" aria-busy="true" aria-label="Loading your squad">
      <div className="sk sk-title" />
      <div className="sk sk-line" />
      <div className="sk sk-line short" />
      <div className="sk sk-chart" />
    </div>
  );
}

function SignedOut({ source, onState }: { source: DataSource; onState: (s: AppState) => void }) {
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => {
      source.getState().then(
        (s) => {
          if (s.signedIn) {
            setWaiting(false);
            onState(s);
          }
        },
        (e: unknown) => {
          setWaiting(false);
          setError(message(e));
        },
      );
    }, 2000);
    return () => clearInterval(timer);
  }, [waiting, source, onState]);

  async function signIn() {
    setError(null);
    try {
      await source.login();
      setWaiting(true);
    } catch (e) {
      setError(message(e));
    }
  }

  return (
    <section className="head state" aria-labelledby="h-signin">
      <h1 id="h-signin">Sign in to see your squad</h1>
      <p className="summary">
        Junction reads your re:Invent schedule with your AWS Builder ID. The sign-in stays on this
        machine.
      </p>
      <div className="actions">
        <button className="btn" type="button" onClick={signIn} disabled={waiting}>
          Sign in with AWS Builder ID
        </button>
      </div>
      {waiting && (
        <p className="notice" role="status">
          Finish signing in in the browser tab that just opened. This page updates when you are
          done.
        </p>
      )}
      {error && (
        <p className="err" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

function NoSquad({
  source,
  onState,
  name,
}: {
  source: DataSource;
  onState: (s: AppState) => void;
  name: string;
}) {
  return (
    <section className="head state" aria-labelledby="h-nosquad">
      <h1 id="h-nosquad">Bring your squad in</h1>
      <p className="summary">
        Signed in as {name}. Share your picks with the people you are going with, and paste theirs
        here. Junction then shows where everyone is and what nobody covers.
      </p>
      <div className="picks-grid">
        <ExportPicks source={source} />
        <ImportPicks source={source} onState={onState} />
      </div>
    </section>
  );
}

export function App({ source }: { source: DataSource }) {
  const demo = source.mode === 'demo';
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const shareRef = useRef<HTMLDivElement>(null);

  const onState = useCallback((state: AppState) => setPhase({ kind: 'ready', state }), []);

  const load = useCallback(() => {
    setPhase({ kind: 'loading' });
    source
      .getState()
      .then(onState, (e: unknown) => setPhase({ kind: 'error', message: message(e) }));
  }, [source, onState]);

  useEffect(load, [load]);
  useEffect(() => {
    if (demo) return;
    const t = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(t);
  }, [demo]);
  useEffect(() => {
    if (sharing) shareRef.current?.focus();
  }, [sharing]);

  async function sync() {
    setSyncing(true);
    setSyncError(null);
    try {
      onState(await source.sync());
      setNow(Date.now());
    } catch (e) {
      setSyncError(message(e));
    } finally {
      setSyncing(false);
    }
  }

  async function signOut() {
    try {
      onState(await source.logout());
    } catch (e) {
      setSyncError(message(e));
    }
  }

  const state = phase.kind === 'ready' ? phase.state : null;
  const squad = state?.signedIn ? state.squad : null;
  const synced = state?.lastSync ? ago(state.lastSync, now) : undefined;

  return (
    <>
      <TopBar>
        {squad && (
          <>
            <span className="when">
              {demo
                ? 'Fictional demo squad'
                : syncing
                  ? 'Syncing'
                  : synced
                    ? `Synced ${synced}`
                    : 'Not synced yet'}
            </span>
            {!demo && (
              <button className="linklike sync" type="button" onClick={sync} disabled={syncing}>
                Sync now
              </button>
            )}
            <button
              className="btn quiet"
              type="button"
              aria-expanded={sharing}
              onClick={() => setSharing((v) => !v)}
            >
              Share my picks
            </button>
          </>
        )}
      </TopBar>

      <main className="wrap">
        {syncError && (
          <p className="err banner" role="alert">
            {syncError}
          </p>
        )}
        {sharing && squad && (
          <div className="share" ref={shareRef} tabIndex={-1} aria-label="Share my picks">
            {demo ? (
              <p className="summary">
                In the app on your own machine, this gives you a block of text with your picks to
                send to your squad, and a place to paste theirs. The demo squad is fictional, so
                there is nothing to share here.
              </p>
            ) : (
              <div className="picks-grid">
                <ExportPicks source={source} />
                <ImportPicks source={source} onState={onState} />
              </div>
            )}
            <button className="linklike" type="button" onClick={() => setSharing(false)}>
              Close
            </button>
          </div>
        )}

        {phase.kind === 'loading' && <Skeleton />}
        {phase.kind === 'error' && (
          <section className="head state" aria-labelledby="h-err">
            <h1 id="h-err">Junction can&rsquo;t reach its agent</h1>
            <p className="err" role="alert">
              {phase.message}
            </p>
            <p className="summary">
              Squad picks you exchanged as text still work once the agent is back.
            </p>
            <div className="actions">
              <button className="btn" type="button" onClick={load}>
                Try again
              </button>
            </div>
          </section>
        )}
        {state && !state.signedIn && <SignedOut source={source} onState={onState} />}
        {state && state.signedIn && !state.squad && (
          <NoSquad source={source} onState={onState} name={state.member?.name ?? 'you'} />
        )}
        {squad && <SquadScreen view={squad} source={source} onState={onState} demo={demo} />}
      </main>

      <Footer>
        {demo ? (
          <p>
            This demo runs entirely in your browser with fictional data. The real Junction runs on
            your machine: your AWS Events sign-in never leaves it, and the squad server only stores
            session codes.
          </p>
        ) : (
          <p>
            Junction runs on this machine. Your AWS Events sign-in never leaves it, and the squad
            server only stores session codes.
            {state?.signedIn && state.member && (
              <>
                {' '}
                Signed in as {state.member.name}.{' '}
                <button className="linklike" type="button" onClick={signOut}>
                  Sign out
                </button>
              </>
            )}
          </p>
        )}
      </Footer>
    </>
  );
}
