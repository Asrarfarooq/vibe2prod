import type { RunStatus, StageStatus } from "../api/types";

export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

export function handle(email: string): string {
  return email.split("@")[0] ?? email;
}

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
const absFmt = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

export function clock(iso: string): string {
  return timeFmt.format(new Date(iso));
}

export function absolute(iso: string): string {
  return absFmt.format(new Date(iso));
}

export function relative(iso: string, now = Date.now()): string {
  const s = Math.round((now - new Date(iso).getTime()) / 1000);
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Compact duration, e.g. "3m 12s", "1h 04m". */
export function duration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}

/** Clock-style elapsed, e.g. "00:12:41". */
export function elapsedClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return [h, m, s].map((n) => String(n).padStart(2, "0")).join(":");
}

/** Log offset, e.g. "+03:10.2", or "+4:40:27" past one hour. */
export function logOffset(ms: number): string {
  const safe = Math.max(0, ms);
  const h = Math.floor(safe / 3600000);
  const m = Math.floor((safe % 3600000) / 60000);
  const s = Math.floor((safe % 60000) / 1000);
  const t = Math.floor((safe % 1000) / 100);
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `+${h}:${mm}:${ss}` : `+${mm}:${ss}.${t}`;
}

export function usd(n: number, digits = 2): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(n);
}

export const stageStatusLabel: Record<StageStatus, string> = {
  queued: "Queued",
  running: "Running",
  awaiting_approval: "Awaiting approval",
  approved: "Approved",
  denied: "Denied",
  failed: "Failed",
  skipped: "Skipped",
};

export const runStatusLabel: Record<RunStatus, string> = {
  running: "Running",
  awaiting_approval: "Awaiting approval",
  succeeded: "Succeeded",
  failed: "Failed",
  denied: "Denied",
};
