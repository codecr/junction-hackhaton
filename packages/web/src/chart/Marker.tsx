import type { MemberShape } from '@junction/core';

// Every member is a colour, a shape and a name. These are the five shapes, drawn by hand.

export const cssVar = (token: string): string => `var(${token})`;

function Shape({
  shape,
  size: s,
  color,
  halo,
}: {
  shape: MemberShape;
  size: number;
  color: string;
  halo?: boolean;
}) {
  const h = s / 2;
  // In the chart a thin paper outline keeps filled markers legible where lines cross.
  const stroke = halo ? 'var(--ground)' : color;
  const sw = halo ? 1 : 0;
  switch (shape) {
    case 'circle':
      return <circle cx={h} cy={h} r={h - 0.8} fill={color} stroke={stroke} strokeWidth={sw} />;
    case 'square':
      return (
        <rect x={1} y={1} width={s - 2} height={s - 2} rx={1.5} fill={color} stroke={stroke} strokeWidth={sw} />
      );
    case 'diamond':
      return (
        <path
          d={`M${h} 0.8 L${s - 0.8} ${h} L${h} ${s - 0.8} L0.8 ${h} Z`}
          fill={color}
          stroke={stroke}
          strokeWidth={sw}
          strokeLinejoin="round"
        />
      );
    case 'triangle':
      return (
        <path
          d={`M${h} 1 L${s - 0.8} ${s - 1.2} L0.8 ${s - 1.2} Z`}
          fill={color}
          stroke={stroke}
          strokeWidth={sw}
          strokeLinejoin="round"
        />
      );
    case 'cross':
      return (
        <>
          {halo && (
            <path
              d={`M${h} 1 V${s - 1} M1 ${h} H${s - 1}`}
              stroke="var(--ground)"
              strokeWidth={5}
              strokeLinecap="round"
              fill="none"
            />
          )}
          <path d={`M${h} 1 V${s - 1} M1 ${h} H${s - 1}`} stroke={color} strokeWidth={3} strokeLinecap="round" fill="none" />
        </>
      );
  }
}

/** A standalone marker for chips, tables and lists. */
export function Marker({ shape, color, size = 11 }: { shape: MemberShape; color: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true" className="marker">
      <Shape shape={shape} size={size} color={cssVar(color)} />
    </svg>
  );
}

/** A marker centred on (cx, cy) inside the chart. */
export function ChartMarker({
  shape,
  color,
  cx,
  cy,
  size = 12,
}: {
  shape: MemberShape;
  color: string;
  cx: number;
  cy: number;
  size?: number;
}) {
  return (
    <g transform={`translate(${cx - size / 2} ${cy - size / 2})`}>
      <Shape shape={shape} size={size} color={cssVar(color)} halo />
    </g>
  );
}
