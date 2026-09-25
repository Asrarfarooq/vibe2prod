import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, getApi } from "./client";
import type { Run, RunEvent, StageKey } from "./types";

const MAX_EVENTS = 5000;

export type LoadState = "loading" | "ready" | "not_found" | "error";

export interface RunState {
  state: LoadState;
  run: Run | null;
  events: RunEvent[];
  connection: "connecting" | "open" | "reconnecting";
  error: string | null;
  replaceRun: (r: Run) => void;
}

function merge(prev: RunEvent[], incoming: RunEvent[]): RunEvent[] {
  if (!incoming.length) return prev;
  const last = prev.at(-1)?.seq ?? 0;
  const inOrder = incoming.every((e, i) => e.seq > last && (i === 0 || e.seq > incoming[i - 1].seq));
  let next: RunEvent[];
  if (inOrder) {
    next = prev.concat(incoming);
  } else {
    const bySeq = new Map<number, RunEvent>();
    for (const e of prev) bySeq.set(e.seq, e);
    for (const e of incoming) bySeq.set(e.seq, e);
    next = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
  }
  return next.length > MAX_EVENTS ? next.slice(next.length - MAX_EVENTS) : next;
}

export function useRun(id: string): RunState {
  const [state, setState] = useState<LoadState>("loading");
  const [run, setRun] = useState<Run | null>(null);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [connection, setConnection] = useState<RunState["connection"]>("connecting");
  const [error, setError] = useState<string | null>(null);
  const lastSeq = useRef(0);

  useEffect(() => {
    let cancelled = false;
    let unsubscribe: (() => void) | null = null;
    let wasDown = false;
    lastSeq.current = 0;

    const addEvents = (list: RunEvent[]) => {
      if (!list.length) return;
      lastSeq.current = Math.max(lastSeq.current, list.at(-1)!.seq);
      setEvents((p) => merge(p, list));
    };

    (async () => {
      const api = await getApi();
      try {
        const [r, ev] = await Promise.all([api.getRun(id), api.getEvents(id, 0)]);
        if (cancelled) return;
        setRun(r);
        addEvents(ev.events);
        setState("ready");
      } catch (e) {
        if (cancelled) return;
        if (e instanceof ApiError && e.status === 404) setState("not_found");
        else {
          setError(e instanceof Error ? e.message : "Could not load this run.");
          setState("error");
        }
        return;
      }
      unsubscribe = api.subscribe(id, {
        onEvent: (e) => !cancelled && addEvents([e]),
        onRun: (r) => !cancelled && setRun(r),
        onConnection: (c) => {
          if (cancelled) return;
          setConnection(c);
          if (c === "reconnecting") wasDown = true;
          if (c === "open" && wasDown) {
            wasDown = false;
            api.getEvents(id, lastSeq.current).then((b) => !cancelled && addEvents(b.events)).catch(() => {});
            api.getRun(id).then((r) => !cancelled && setRun(r)).catch(() => {});
          }
        },
      });
    })();

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [id]);

  const replaceRun = useCallback((r: Run) => setRun(r), []);
  return { state, run, events, connection, error, replaceRun };
}

export function stageIndex(key: StageKey | null | undefined): number {
  return ["codeguard", "architect", "iac", "deploy"].indexOf(key ?? "");
}
