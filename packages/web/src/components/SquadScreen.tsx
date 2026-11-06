import { useMemo, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { SquadView } from '@junction/core';
import { Chart } from '../chart/Chart';
import { Marker } from '../chart/Marker';
import { chartLayout, timeRange } from '../chart/layout';
import { dayModel, initialDay, type DayModel } from '../chart/model';
import { longDay, nameList, plural, tabDay } from '../lib/format';
import type { AppState, DataSource } from '../data/types';
import { Coverage } from './Coverage';
import { DayList } from './DayList';
import { Proposals } from './Proposals';

function Summary({ model }: { model: DayModel }) {
  const gaps = model.open.length;
  const parts: ReactNode[] = [];
  if (gaps > 0)
    parts.push(
      <>
        <strong>{plural(gaps, 'session', 'sessions')}</strong> no one covers
      </>,
    );
  if (model.unplanned > 0)
    parts.push(
      <strong>{plural(model.unplanned, 'unplanned duplicate', 'unplanned duplicates')}</strong>,
    );
  if (model.hops.length > 0)
    parts.push(
      <>
        <strong>{plural(model.hops.length, 'connection', 'connections')}</strong> that can&rsquo;t
        be made
      </>,
    );
  if (parts.length === 0) return <p className="summary">Nothing needs attention on this day.</p>;
  return (
    <p className="summary">
      {parts.map((p, i) => (
        <span key={i}>
          {i > 0 && (i === parts.length - 1 ? (parts.length > 2 ? ', and ' : ' and ') : ', ')}
          {p}
        </span>
      ))}
      .
    </p>
  );
}

function provisionalNotice(view: SquadView): string | undefined {
  if (!view.provisional) return undefined;
  const mine = view.members.find((m) => m.memberId === view.me)?.catalogHash;
  if (mine) {
    const behind = view.members.filter(
      (m) => m.hasPicks && m.catalogHash && m.catalogHash !== mine,
    );
    if (behind.length > 0) {
      const names = nameList(behind.map((m) => `${m.name}’s`));
      return `${names} catalog ${behind.length === 1 ? 'is' : 'are'} one update behind, so the proposals below are provisional until ${behind.length === 1 ? 'it matches' : 'they match'} yours.`;
    }
  }
  return 'Not every catalog in the squad matches yet, so the proposals below are provisional until they do.';
}

function todayLocal(view: SquadView): number {
  return Math.floor((Date.now() / 60000 + view.utcOffsetMin) / 1440);
}

export function SquadScreen({
  view,
  source,
  onState,
  demo,
}: {
  view: SquadView;
  source: DataSource;
  onState: (s: AppState) => void;
  demo: boolean;
}) {
  const [picked, setPicked] = useState<number | undefined>(undefined);
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const [focus, setFocus] = useState<string | null>(null);
  const [asList, setAsList] = useState(false);

  const day =
    picked !== undefined && view.days.some((d) => d.day === picked)
      ? picked
      : initialDay(view, todayLocal(view));
  const viewDay = view.days.find((d) => d.day === day);
  const model = useMemo(() => (day === undefined ? undefined : dayModel(view, day)), [view, day]);
  const layout = useMemo(() => {
    if (!model) return undefined;
    const spans = [...model.runs.flatMap((r) => r.sessions), ...model.open.map((o) => o.session)];
    return chartLayout(view.venues, timeRange(spans));
  }, [view, model]);

  const notice = provisionalNotice(view);

  if (!viewDay || !model || !layout) {
    return (
      <section className="head">
        <h1>{view.squadName}</h1>
        <p className="summary">
          Nobody in the squad has picks with dates yet. Once someone shares theirs, the week shows
          here.
        </p>
      </section>
    );
  }

  const onTabKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const n = view.days.length;
    let j: number;
    if (e.key === 'ArrowRight') j = (i + 1) % n;
    else if (e.key === 'ArrowLeft') j = (i - 1 + n) % n;
    else if (e.key === 'Home') j = 0;
    else if (e.key === 'End') j = n - 1;
    else return;
    e.preventDefault();
    const next = view.days[j];
    if (next) {
      setPicked(next.day);
      const tabs =
        e.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]');
      tabs?.[j]?.focus();
    }
  };

  const toggle = (id: string) =>
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <>
      <section className="head" aria-labelledby="h-day">
        <h1 id="h-day">{longDay(viewDay)}</h1>
        <Summary model={model} />
        {notice && <p className="notice">{notice}</p>}
        {demo && (
          <p className="notice">
            This demo uses a fictional squad and invented sessions. Nothing leaves your browser.
          </p>
        )}

        <div className="days" role="tablist" aria-label="Event days">
          {view.days.map((d, i) => (
            <button
              key={d.day}
              className="day"
              role="tab"
              type="button"
              aria-selected={d.day === day}
              tabIndex={d.day === day ? 0 : -1}
              onClick={() => setPicked(d.day)}
              onKeyDown={(e) => onTabKey(e, i)}
            >
              <span className="d">{tabDay(d)}</span>
              <span className="m">{d.issues > 0 ? plural(d.issues, 'issue', 'issues') : ' '}</span>
            </button>
          ))}
        </div>
      </section>

      <section aria-labelledby="h-where" className="where" role="tabpanel">
        <div className="where-head">
          <div>
            <h2 id="h-where">Where everyone is</h2>
            <p className="cap">
              Each line is one person. Thick runs are sessions, thin slopes are walks between
              venues.
              {view.venueApproximate ? ' Walking times are estimates.' : ''}
            </p>
          </div>
          <button
            className="linklike"
            type="button"
            aria-pressed={asList}
            onClick={() => setAsList((v) => !v)}
          >
            {asList ? 'Show as a chart' : 'Show as a list'}
          </button>
        </div>
        <div className="controls">
          <div className="legend" role="group" aria-label="Show or hide people">
            {model.runs.map((r) => {
              const m = r.member;
              const on = !hidden.has(m.memberId);
              return (
                <button
                  key={m.memberId}
                  className="chip"
                  type="button"
                  aria-pressed={on}
                  aria-label={`${m.name}, ${plural(r.sessions.length, 'session', 'sessions')}`}
                  onClick={() => toggle(m.memberId)}
                  onPointerEnter={() => setFocus(m.memberId)}
                  onPointerLeave={() => setFocus(null)}
                  onFocus={() => setFocus(m.memberId)}
                  onBlur={() => setFocus(null)}
                >
                  <Marker shape={m.shape} color={m.color} />
                  <span>{m.name}</span>
                  <span className="n">{r.sessions.length}</span>
                </button>
              );
            })}
          </div>
          {!asList && (
            <div className="key" aria-label="Chart key">
              <span>
                <i className="sw shared-planned" />
                Overlap your squad planned
              </span>
              <span>
                <i className="sw shared" />
                Duplicate nobody planned
              </span>
              <span>
                <i className="sw gap" />
                Nobody covers it
              </span>
              <span>
                <i className="sw cant" />
                Can&rsquo;t make the walk
              </span>
            </div>
          )}
        </div>
        {asList ? (
          <DayList view={view} model={model} hidden={hidden} />
        ) : (
          <Chart
            view={view}
            model={model}
            layout={layout}
            dayName={longDay(viewDay)}
            hidden={hidden}
            focus={focus}
            onFocus={setFocus}
          />
        )}
      </section>

      <div className="cols">
        <Coverage view={view} selectedDay={day ?? -1} />
        <Proposals view={view} source={source} onState={onState} />
      </div>
    </>
  );
}
