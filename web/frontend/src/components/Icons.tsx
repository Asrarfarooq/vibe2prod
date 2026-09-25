import type { RunStatus, StageStatus } from "../api/types";
import s from "./Icons.module.css";

type Status = StageStatus | RunStatus;

const tone: Record<Status, string> = {
  queued: s.faint,
  running: s.accent,
  awaiting_approval: s.warning,
  approved: s.success,
  succeeded: s.success,
  denied: s.danger,
  failed: s.danger,
  skipped: s.faint,
};

export function StatusIcon({ status, size = 16 }: { status: Status; size?: number }) {
  const cls = `${s.icon} ${tone[status]} ${status === "running" ? s.pulse : ""}`;
  const common = { width: size, height: size, viewBox: "0 0 16 16", className: cls, "aria-hidden": true, focusable: false } as const;
  switch (status) {
    case "queued":
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray="2.2 2.1" />
        </svg>
      );
    case "running":
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <circle cx="8" cy="8" r="2.5" fill="currentColor" />
        </svg>
      );
    case "awaiting_approval":
      return <LockGlyph {...common} />;
    case "approved":
    case "succeeded":
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="6.25" fill="currentColor" />
          <path d="M5.2 8.2l1.9 1.9 3.8-4" fill="none" stroke="var(--surface-1)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case "denied":
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="6.25" fill="currentColor" />
          <path d="M5.8 5.8l4.4 4.4M10.2 5.8l-4.4 4.4" stroke="var(--surface-1)" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      );
    case "failed":
      return (
        <svg {...common}>
          <path d="M8 1.8l6.4 11.4H1.6z" fill="currentColor" strokeLinejoin="round" stroke="currentColor" strokeWidth="1" />
          <path d="M8 6v3.4" stroke="var(--surface-1)" strokeWidth="1.6" strokeLinecap="round" />
          <circle cx="8" cy="11.4" r="0.9" fill="var(--surface-1)" />
        </svg>
      );
    case "skipped":
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path d="M5.5 8h5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      );
  }
}

export function LockGlyph(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden focusable={false} {...props}>
      <rect x="3.5" y="7" width="9" height="6.5" rx="1.5" fill="currentColor" />
      <path d="M5.5 7V5.4a2.5 2.5 0 015 0V7" fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

export function CheckGlyph(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden focusable={false} {...props}>
      <path d="M3.8 8.4l2.7 2.7 5.7-6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function CrossGlyph(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden focusable={false} {...props}>
      <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

export function ExternalGlyph(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden focusable={false} {...props}>
      <path d="M6 3.5H3.5v9h9V10M9 3.5h3.5V7M12.5 3.5L7 9" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function ChevronGlyph(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden focusable={false} {...props}>
      <path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function SunMoonGlyph({ dark }: { dark: boolean }) {
  return dark ? (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden focusable={false}>
      <circle cx="8" cy="8" r="3" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M8 1.5v1.6M8 12.9v1.6M1.5 8h1.6M12.9 8h1.6M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M3.4 12.6l1.1-1.1M11.5 4.5l1.1-1.1" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  ) : (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden focusable={false}>
      <path d="M13.2 10.1A5.6 5.6 0 015.9 2.8a5.6 5.6 0 107.3 7.3z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
    </svg>
  );
}
