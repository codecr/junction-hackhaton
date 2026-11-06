import type { ReactNode } from 'react';

export function Brand() {
  return (
    <div className="brand">
      <svg width="26" height="26" viewBox="0 0 26 26" aria-hidden="true">
        <g
          fill="none"
          stroke="var(--ink)"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M2 5 L11 13" />
          <path d="M2 13 H11" />
          <path d="M2 21 L11 13" />
          <path d="M11 13 H24" />
        </g>
        <circle
          cx="12"
          cy="13"
          r="4.2"
          fill="var(--signal)"
          stroke="var(--ink)"
          strokeWidth="1.6"
        />
      </svg>
      <span>Junction</span>
    </div>
  );
}

export function TopBar({ children }: { children?: ReactNode }) {
  return (
    <header className="topbar">
      <div className="wrap">
        <Brand />
        <div className="status">{children}</div>
      </div>
    </header>
  );
}

export const DISCLAIMER =
  'Junction is an unofficial community project built for the re:Invent Event Catalog API Hackathon. It is not affiliated with or endorsed by Amazon Web Services.';

export function Footer({ children }: { children?: ReactNode }) {
  return (
    <footer className="foot">
      <div className="wrap">
        {children}
        <p className="disclaimer">{DISCLAIMER}</p>
      </div>
    </footer>
  );
}
