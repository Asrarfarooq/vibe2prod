import { useSyncExternalStore } from "react";

// Held in memory only; never written to storage or cookies.
let held: string | null = null;
const subs = new Set<() => void>();

function set(next: string | null) {
  held = next;
  subs.forEach((f) => f());
}

export const approverKey = {
  get: () => held,
  remember: (key: string) => set(key),
  forget: () => set(null),
};

const subscribe = (f: () => void) => {
  subs.add(f);
  return () => {
    subs.delete(f);
  };
};

export function useHasApproverKey(): boolean {
  return useSyncExternalStore(subscribe, () => held !== null);
}
