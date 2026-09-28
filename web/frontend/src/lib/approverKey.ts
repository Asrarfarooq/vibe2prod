import { useSyncExternalStore } from "react";

// sessionStorage only: scoped to this tab, survives reload, cleared when the tab closes. Never localStorage or cookies.
const STORAGE_KEY = "v2p-approver-key";
const subs = new Set<() => void>();

function read(): string | null {
  try {
    return sessionStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function set(next: string | null) {
  try {
    if (next === null) sessionStorage.removeItem(STORAGE_KEY);
    else sessionStorage.setItem(STORAGE_KEY, next);
  } catch {
    // Storage blocked: the key is simply not kept.
  }
  subs.forEach((f) => f());
}

export const approverKey = {
  get: read,
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
  return useSyncExternalStore(subscribe, () => read() !== null);
}
