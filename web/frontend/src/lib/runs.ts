import type { RunSummary } from "../api/types";

export function sortRuns(runs: RunSummary[]): RunSummary[] {
  return [...runs].sort((a, b) => {
    const wa = a.status === "awaiting_approval" ? 0 : 1;
    const wb = b.status === "awaiting_approval" ? 0 : 1;
    return wa - wb || b.created_at.localeCompare(a.created_at);
  });
}
