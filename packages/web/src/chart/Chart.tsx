import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { SquadView, ViewMember, ViewSession } from '@junction/core';
import { clockRange, hourLabel, nameList } from '../lib/format';
import { attendeesOf, type DayModel } from './model';
import { CHART, hopGeometry, laneOffset, pillWidth, type ChartLayout, type Pt } from './layout';
import { ChartMarker, cssVar } from './Marker';

// The Marey chart: the one memorable element. Time runs left to right, venues top to bottom,
// each person is a line. Ported from design/reference.html.

interface Tip {
  title: string;
  lines: string[];
  anchor: { x: number; y: number };
}

interface ChartProps {
  view: SquadView;
  model: DayModel;
  layout: ChartLayout;
  dayName: string;
  hidden: ReadonlySet<string>;
  focus: string | null;
  onFocus: (memberId: string | null) => void;
}

interface BarProps {
  label: string;
  title: string;
  lines: string[];
  show: (target: Element, title: string, lines: string[]) => void;
  hide: () => void;
  children: ReactNode;
}

/** A focusable session mark with a tooltip on hover and focus. */
function Bar({ label, title, lines, show, hide, children }: BarProps) {
  return (
    <g
      className="bar"
      tabIndex={0}
      role="img"
      aria-label={label}
      onPointerEnter={(e) => show(e.currentTarget, title, lines)}
      onPointerLeave={hide}
      onFocus={(e) => show(e.currentTarget, title, lines)}
      onBlur={hide}
      onKeyDown={(e) => {
        if (e.key === 'Escape') hide();
      }}
    >
      {children}
    </g>
  );
}

export function Chart({ view, model, layout, dayName, hidden, focus, onFocus }: ChartProps) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const hatchId = `hatch-${uid}`;
  const clipId = `reveal-${uid}`;
  const wrapRef = useRef<HTMLDivElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const clipRef = useRef<SVGRectElement>(null);
  const [tip, setTip] = useState<Tip | null>(null);
  const { x, width: W, bottom } = layout;
  const venueName = (id: string) => view.venues.find((v) => v.id === id)?.name ?? id;
  const count = view.members.length;
  const laneOf = (index: number) => laneOffset(index, count);
  const yOf = (s: ViewSession, index: number) =>
    (layout.yVenue(s.venue) ?? CHART.top) + laneOf(index);
  const P = (p: Pt) => ({ x: x(p.t), y: p.y });

  // The one orchestrated moment: the day unfolds left to right, once, unless motion is reduced.
  useEffect(() => {
    const rect = clipRef.current;
    if (!rect) return;
    const full = String(W + 40);
    if (
      typeof matchMedia === 'function' &&
      matchMedia('(prefers-reduced-motion: reduce)').matches
    ) {
      rect.setAttribute('width', full);
      return;
    }
    let raf = 0;
    const t0 = performance.now();
    const step = (now: number) => {
      const p = Math.max(0, Math.min(1, (now - t0) / 1100));
      const e = 1 - Math.pow(1 - p, 3);
      rect.setAttribute('width', String((W + 40) * e));
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(raf);
      rect.setAttribute('width', full);
    };
    // Once per mount: switching days does not replay it.
  }, [W]);

  // Keep the tooltip inside the scroll area once its size is known.
  useLayoutEffect(() => {
    const el = tipRef.current;
    const wrap = wrapRef.current;
    if (!el || !wrap || !tip) return;
    const tw = el.offsetWidth;
    const left = Math.max(4, Math.min(tip.anchor.x - tw / 2, wrap.scrollWidth - tw - 4));
    el.style.left = `${left}px`;
    el.style.top = `${tip.anchor.y - el.offsetHeight - 8}px`;
  }, [tip]);

  function show(target: Element, title: string, lines: string[]) {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const r = target.getBoundingClientRect();
    const w = wrap.getBoundingClientRect();
    setTip({
      title,
      lines,
      anchor: { x: r.left - w.left + wrap.scrollLeft + r.width / 2, y: r.top - w.top },
    });
  }
  const hide = () => setTip(null);

  const visibleRuns = model.runs.filter((r) => !hidden.has(r.member.memberId));
  const indexOf = new Map(model.runs.map((r) => [r.member.memberId, r.index]));
  const anyHidden = (ms: readonly ViewMember[]) => ms.some((m) => hidden.has(m.memberId));
  const dim = (memberId: string) => (focus !== null && focus !== memberId ? ' dim' : '');

  const under: ReactNode[] = [];
  const labels: ReactNode[] = [];

  // Shared sessions: a signal underlay behind the bars, with a pill below.
  for (const sh of model.shared) {
    if (anyHidden(sh.members)) continue;
    const s = sh.session;
    const ys = sh.members.map((m) => yOf(s, indexOf.get(m.memberId) ?? 0));
    const top = Math.min(...ys) - 9;
    const bot = Math.max(...ys) + 9;
    const key = `sh-${s.sessionId}`;
    const fade = focus !== null && !sh.members.some((m) => m.memberId === focus) ? ' dim' : '';
    under.push(
      <rect
        key={key}
        className={`shared${sh.planned ? ' planned' : ''}${fade}`}
        x={x(s.startLocal) - 6}
        y={top}
        width={x(s.endLocal) - x(s.startLocal) + 12}
        height={bot - top}
        rx={9}
      />,
    );
    const label = sh.planned ? 'Planned overlap' : 'Duplicate';
    const tx = x(s.startLocal) - 6;
    const ty = bot + 17;
    labels.push(
      <g key={key} className={`pill${fade}`}>
        <rect x={tx} y={ty - 13} width={pillWidth(label)} height={18} rx={4} />
        <text x={tx + 7} y={ty} className="t-pill">
          {label}
        </text>
      </g>,
    );
  }

  // Sessions nobody covers, and new ones suggested for someone.
  const open = model.open.map((o) => {
    const s = o.session;
    const y = layout.yVenue(s.venue) ?? CHART.top;
    const owner = o.owner;
    const stroke = owner ? cssVar(owner.color) : 'var(--ink-2)';
    const why = owner
      ? `Nobody covers it yet. Suggested for ${owner.name}.`
      : o.collidesWithLunch
        ? 'Falls in the squad lunch window. Nobody covers it.'
        : 'Nobody covers it.';
    labels.push(
      <text
        key={`open-${s.sessionId}`}
        x={owner ? x(s.startLocal) : x(s.endLocal) - 4}
        y={y - 21}
        textAnchor={owner ? 'start' : 'end'}
        className="t-code strong"
        style={{ fill: owner ? cssVar(owner.color) : 'var(--ink)' }}
      >
        {owner ? `${s.code}, suggested for ${owner.name}` : `${s.code}, not covered`}
      </text>,
    );
    return (
      <Bar
        key={s.sessionId}
        show={show}
        hide={hide}
        label={`${s.code}, ${s.title}, ${clockRange(s.startLocal, s.endLocal)}, ${venueName(s.venue)}. ${why}`}
        title={s.title}
        lines={[`${s.code}, ${clockRange(s.startLocal, s.endLocal)}, ${venueName(s.venue)}`, why]}
      >
        <rect
          x={x(s.startLocal)}
          y={y - 14}
          width={x(s.endLocal) - x(s.startLocal)}
          height={28}
          rx={8}
          fill={`url(#${hatchId})`}
          stroke={stroke}
          strokeWidth={1.6}
          strokeDasharray="5 4"
        />
        <rect
          x={x(s.startLocal) - 4}
          y={y - 17}
          width={x(s.endLocal) - x(s.startLocal) + 8}
          height={34}
          rx={10}
          className="focusring"
        />
      </Bar>
    );
  });

  const members = visibleRuns.map((run) => {
    const m = run.member;
    const color = cssVar(m.color);
    const lines: ReactNode[] = [];
    run.hops.forEach((hop, i) => {
      const fromY = yOf(hop.from, run.index);
      const toY = yOf(hop.to, run.index);
      const g = hopGeometry({
        fromEnd: hop.from.endLocal,
        fromY,
        toStart: hop.to.startLocal,
        toY,
        walkMin: hop.walkMin,
        ...(hop.impossible
          ? { impossible: { needMin: hop.impossible.needMin, haveMin: hop.impossible.haveMin } }
          : {}),
      });
      if (g.kind === 'walk') {
        g.segments.forEach(([a, b], j) => {
          const pa = P(a);
          const pb = P(b);
          lines.push(
            <line
              key={`w${i}-${j}`}
              x1={pa.x}
              y1={pa.y}
              x2={pb.x}
              y2={pb.y}
              stroke={color}
              strokeWidth={1.6}
            />,
          );
        });
      } else {
        const a = P(g.line[0]);
        const e = P(g.end);
        const sz = 5;
        lines.push(
          <line key={`c${i}`} x1={a.x} y1={a.y} x2={e.x} y2={e.y} className="cant-line" />,
          <path
            key={`x${i}`}
            d={`M${e.x - sz} ${e.y - sz} L${e.x + sz} ${e.y + sz} M${e.x - sz} ${e.y + sz} L${e.x + sz} ${e.y - sz}`}
            className="cant-cross"
          />,
        );
        labels.push(
          <text
            key={`cant-${m.memberId}-${i}`}
            x={e.x + 10}
            y={e.y + 4}
            className={`t-cant${dim(m.memberId)}`}
          >
            {g.haveMin < 0
              ? `${m.name} has two sessions at once`
              : `${m.name} needs ${g.needMin} min, has ${g.haveMin}`}
          </text>,
        );
      }
    });

    const bars = run.sessions.map((s) => {
      const y = yOf(s, run.index);
      const with_ = attendeesOf(model, s.sessionId).filter((o) => o.memberId !== m.memberId);
      if (with_.length === 0)
        labels.push(
          <text
            key={`code-${m.memberId}-${s.sessionId}`}
            x={x(s.startLocal)}
            y={y - 13}
            className={`t-code${dim(m.memberId)}`}
          >
            {s.code}
          </text>,
        );
      const who = with_.length ? `${m.name} with ${nameList(with_.map((o) => o.name))}` : m.name;
      return (
        <Bar
          key={s.sessionId}
          show={show}
          hide={hide}
          label={`${m.name}: ${s.code}, ${s.title}, ${clockRange(s.startLocal, s.endLocal)}, ${venueName(s.venue)}.`}
          title={s.title}
          lines={[`${s.code}, ${clockRange(s.startLocal, s.endLocal)}, ${venueName(s.venue)}`, who]}
        >
          <line
            x1={x(s.startLocal) + 4}
            y1={y}
            x2={Math.max(x(s.startLocal) + 4, x(s.endLocal) - 4)}
            y2={y}
            stroke={color}
            strokeWidth={7}
            strokeLinecap="round"
          />
          <rect
            x={x(s.startLocal) - 5}
            y={y - 8.5}
            width={x(s.endLocal) - x(s.startLocal) + 10}
            height={17}
            rx={8.5}
            className="focusring"
          />
          <ChartMarker shape={m.shape} color={m.color} cx={x(s.startLocal) + 4} cy={y} />
        </Bar>
      );
    });

    const last = run.sessions[run.sessions.length - 1];
    if (last)
      labels.push(
        <text
          key={`name-${m.memberId}`}
          x={x(last.endLocal) + 14}
          y={yOf(last, run.index) + 4.5}
          className={`t-name${dim(m.memberId)}`}
          style={{ fill: color }}
        >
          {m.name}
        </text>,
      );

    return (
      <g
        key={m.memberId}
        className={`member${dim(m.memberId)}`}
        onPointerEnter={() => onFocus(m.memberId)}
        onPointerLeave={() => onFocus(null)}
      >
        {lines}
        {bars}
      </g>
    );
  });

  const lunch = view.lunch;
  return (
    <div className="chartwrap" ref={wrapRef}>
      <svg
        className="chart"
        viewBox={`0 0 ${W} ${layout.height}`}
        role="group"
        aria-label={`Timeline of where each person is on ${dayName}, by venue`}
      >
        <defs>
          <pattern
            id={hatchId}
            width={6}
            height={6}
            patternUnits="userSpaceOnUse"
            patternTransform="rotate(45)"
          >
            <rect width={6} height={6} fill="transparent" />
            <line x1={0} y1={0} x2={0} y2={6} className="hatch-line" />
          </pattern>
          <clipPath id={clipId}>
            <rect ref={clipRef} x={0} y={0} width={0} height={layout.height} />
          </clipPath>
        </defs>

        <g aria-hidden="true">
          {lunch && lunch.endLocal > layout.range.start && lunch.startLocal < layout.range.end && (
            <>
              <rect
                className="lunch"
                x={x(lunch.startLocal)}
                y={CHART.gridTop}
                width={x(lunch.endLocal) - x(lunch.startLocal)}
                height={bottom - CHART.gridTop}
              />
              <text x={x(lunch.startLocal) + 6} y={60} className="t-lunch">
                {lunch.protected ? 'Squad lunch' : 'Lunch'}
              </text>
            </>
          )}
          {layout.hours.map((h) => (
            <g key={h}>
              <line className="grid" x1={x(h)} x2={x(h)} y1={CHART.gridTop} y2={bottom} />
              <text x={x(h)} y={30} textAnchor="middle" className="t-hour">
                {hourLabel(h)}
              </text>
            </g>
          ))}
          {layout.venues.map((v) => (
            <g key={v.id}>
              <line
                className="venue-line"
                x1={CHART.marginLeft}
                x2={W - CHART.marginRight}
                y1={v.y}
                y2={v.y}
              />
              <text x={0} y={v.y + 4.5} className="t-venue">
                {v.name}
              </text>
              {v.next && (
                <text x={0} y={v.next.y + 4} className="t-walk">
                  {`${v.next.minutes} min walk`}
                </text>
              )}
            </g>
          ))}
        </g>

        <g clipPath={`url(#${clipId})`}>
          <g>{under}</g>
          <g>{open}</g>
          <g>{members}</g>
          <g aria-hidden="true">{labels}</g>
        </g>
      </svg>
      <div className={`tip${tip ? ' on' : ''}`} ref={tipRef} role="status" aria-live="polite">
        {tip && (
          <>
            <b>{tip.title}</b>
            {tip.lines.map((l) => (
              <span key={l}>{l}</span>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
