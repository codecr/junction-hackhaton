import type { SquadView } from '@junction/core';
import { Marker } from '../chart/Marker';
import { nameList, plural, weekdayName, weekdayShort } from '../lib/format';

// Topic by day, for the week. Cells carry the marker shapes of who covers each topic.

export function Coverage({ view, selectedDay }: { view: SquadView; selectedDay: number }) {
  const cells = view.coverage.cells;
  const memberById = new Map(view.members.map((m) => [m.memberId, m]));
  let nNone = 0;
  let nUnder = 0;
  for (const c of cells) {
    if (c.state === 'none' && c.offered > 0) nNone += 1;
    else if (c.state === 'under') nUnder += 1;
  }

  return (
    <section aria-labelledby="h-cov">
      <h2 id="h-cov">Coverage this week</h2>
      <p className="cap">
        {nNone === 0 && nUnder === 0
          ? 'Every topic is covered on every day it is offered.'
          : `${plural(nNone, 'gap', 'gaps')} and ${plural(nUnder, 'topic day', 'topic days')} below target.`}
      </p>
      <div className="tablewrap">
        <table className="cov">
          <thead>
            <tr>
              <th scope="col" className="topic">
                Topic
              </th>
              {view.days.map((d) => (
                <th
                  key={d.day}
                  scope="col"
                  className={d.day === selectedDay ? 'today' : undefined}
                  abbr={weekdayName(d)}
                >
                  {weekdayShort(d)}
                </th>
              ))}
              <th scope="col" className="tgt">
                Target
              </th>
            </tr>
          </thead>
          <tbody>
            {view.topics.map((t) => (
              <tr key={t.id}>
                <th scope="row" className="topic">
                  {t.label}
                </th>
                {view.days.map((d) => {
                  const c = cells.find((x) => x.topicId === t.id && x.day === d.day);
                  const dayName = weekdayName(d);
                  let body;
                  let cls = 'cell';
                  let label: string;
                  if (!c || (c.count === 0 && c.offered === 0)) {
                    cls += ' off';
                    label = `${dayName}: no ${t.label} sessions offered`;
                    body = <span aria-hidden="true">&ndash;</span>;
                  } else if (c.state === 'none') {
                    cls += ' none';
                    label = `${dayName}: nobody covers ${t.label}`;
                    body = <span>none</span>;
                  } else {
                    const people = c.members
                      .map((id) => memberById.get(id))
                      .filter((m) => m !== undefined)
                      .sort((a, b) => view.members.indexOf(a) - view.members.indexOf(b));
                    label = `${dayName}: ${nameList(people.map((m) => m.name))}`;
                    if (c.state === 'under') {
                      cls += ' under';
                      label += `, ${c.count} of ${c.target}`;
                    }
                    body = (
                      <>
                        {people.map((m) => (
                          <Marker key={m.memberId} shape={m.shape} color={m.color} size={10} />
                        ))}
                        {c.state === 'under' && (
                          <span className="lab">
                            {c.count} of {c.target}
                          </span>
                        )}
                      </>
                    );
                  }
                  return (
                    <td key={d.day} className={d.day === selectedDay ? 'today' : undefined}>
                      <div className={cls} role="img" aria-label={label}>
                        {body}
                      </div>
                    </td>
                  );
                })}
                <td className="tgt">{t.target}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="covkey">
        Hatched cells have nobody. A red count means the topic is below the target your squad set.
      </p>
    </section>
  );
}
