import type { SquadView } from '@junction/core';
import { Marker } from '../chart/Marker';
import { attendeesOf, type DayModel } from '../chart/model';
import { clockRange, nameList } from '../lib/format';

// The chart as a per-person list: same facts, readable by screen readers and keyboard.

export function DayList({
  view,
  model,
  hidden,
}: {
  view: SquadView;
  model: DayModel;
  hidden: ReadonlySet<string>;
}) {
  const venue = (id: string) => view.venues.find((v) => v.id === id)?.name ?? id;
  const dup = new Map(view.coverage.duplicates.map((d) => [d.sessionId, d]));
  return (
    <div className="daylist">
      {model.runs
        .filter((r) => !hidden.has(r.member.memberId))
        .map((run) => {
          const m = run.member;
          return (
            <section key={m.memberId} aria-label={m.name}>
              <h3>
                <Marker shape={m.shape} color={m.color} />
                <span>{m.name}</span>
              </h3>
              {run.sessions.length === 0 ? (
                <p className="cap">No sessions on this day.</p>
              ) : (
                <ol>
                  {run.sessions.map((s, i) => {
                    const hop = i > 0 ? run.hops[i - 1] : undefined;
                    const d = dup.get(s.sessionId);
                    const others = attendeesOf(model, s.sessionId)
                      .filter((o) => o.memberId !== m.memberId)
                      .map((o) => o.name);
                    return (
                      <li key={s.sessionId}>
                        {hop?.impossible && (
                          <p className="flag cant">
                            Can&rsquo;t make the walk: needs {hop.impossible.needMin} min, has{' '}
                            {hop.impossible.haveMin}.
                          </p>
                        )}
                        <span className="when">{clockRange(s.startLocal, s.endLocal)}</span>{' '}
                        <strong>{s.code}</strong> {s.title}, {venue(s.venue)}.
                        {d && others.length > 0 && (
                          <span className="flag">
                            {' '}
                            {d.planned ? 'Planned overlap' : 'Duplicate'} with {nameList(others)}.
                          </span>
                        )}
                      </li>
                    );
                  })}
                </ol>
              )}
            </section>
          );
        })}
      {model.open.length > 0 && (
        <section aria-label="Nobody covers it">
          <h3>Nobody covers it</h3>
          <ol>
            {model.open.map((o) => (
              <li key={o.session.sessionId}>
                <span className="when">{clockRange(o.session.startLocal, o.session.endLocal)}</span>{' '}
                <strong>{o.session.code}</strong> {o.session.title}, {venue(o.session.venue)}.
                {o.owner
                  ? ` Suggested for ${o.owner.name}.`
                  : o.collidesWithLunch
                    ? ' Falls in the squad lunch window.'
                    : ''}
              </li>
            ))}
          </ol>
        </section>
      )}
    </div>
  );
}
