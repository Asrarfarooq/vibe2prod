import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { EventKind, RunEvent } from "../api/types";
import { logOffset } from "../lib/format";
import { ChevronGlyph } from "./Icons";
import s from "./EventLog.module.css";

type Filter = "all" | "tools" | "thoughts" | "errors";

const FILTERS: { key: Filter; label: string; kinds: EventKind[] | null }[] = [
  { key: "all", label: "All", kinds: null },
  { key: "tools", label: "Tools", kinds: ["tool_call", "tool_result"] },
  { key: "thoughts", label: "Thoughts", kinds: ["thought"] },
  { key: "errors", label: "Errors", kinds: ["error"] },
];

const KIND_TAG: Record<EventKind, string> = {
  status: "Status",
  thought: "Thought",
  tool_call: "Tool",
  tool_result: "Result",
  output: "Output",
  error: "Error",
};

const RENDER_CAP = 1500;

interface Props {
  events: RunEvent[];
  origin: number | null;
  stageKey: string;
  live: boolean;
}

export function EventLog({ events, origin, stageKey, live }: Props) {
  const [filter, setFilter] = useState<Filter>("all");
  const [open, setOpen] = useState<Set<number>>(() => new Set());
  const [unseen, setUnseen] = useState(0);
  const scroller = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const prevCount = useRef(0);

  const kinds = FILTERS.find((f) => f.key === filter)!.kinds;
  const visible = useMemo(() => {
    const list = kinds ? events.filter((e) => kinds.includes(e.kind)) : events;
    return list.length > RENDER_CAP ? list.slice(list.length - RENDER_CAP) : list;
  }, [events, kinds]);
  const hidden = (kinds ? events.filter((e) => kinds.includes(e.kind)).length : events.length) - visible.length;

  const t0 = origin ?? (events[0] ? new Date(events[0].ts).getTime() : 0);

  const pin = useCallback((smooth: boolean) => {
    const el = scroller.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
    atBottom.current = true;
  }, []);

  useLayoutEffect(() => {
    pin(false);
  }, [filter, pin]);

  useLayoutEffect(() => {
    const added = visible.length - prevCount.current;
    prevCount.current = visible.length;
    if (added <= 0) return;
    if (atBottom.current) pin(false);
    else setUnseen((n) => n + added);
  }, [visible.length, pin]);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const onScroll = () => {
      const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
      atBottom.current = bottom;
      if (bottom) setUnseen(0);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  const toggle = (seq: number) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(seq)) next.delete(seq);
      else next.add(seq);
      return next;
    });

  return (
    <div className={s.wrap}>
      <div className={s.toolbar}>
        <div className={s.filters} role="group" aria-label="Filter events">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              id={`log-filter-${f.key}`}
              type="button"
              className={s.filter}
              aria-pressed={filter === f.key}
              onClick={() => {
                setFilter(f.key);
                setUnseen(0);
              }}
            >
              {f.label}
            </button>
          ))}
        </div>
        <span className={`${s.count} num`} aria-live="polite">
          {events.length} {events.length === 1 ? "event" : "events"}
        </span>
      </div>

      <div className={s.scroller} ref={scroller} tabIndex={0} role="log" aria-label="Stage activity" id={`event-log-${stageKey}`}>
        {hidden > 0 && <p className={s.truncated}>{hidden} earlier events not shown</p>}
        {visible.length === 0 ? (
          <p className={s.empty}>
            {events.length === 0
              ? live
                ? "Waiting for the agent's first event."
                : "No activity recorded for this stage."
              : "No events match this filter."}
          </p>
        ) : (
          <ol className={s.list}>
            {visible.map((e) => (
              <EventRow key={e.seq} e={e} t0={t0} open={open.has(e.seq)} onToggle={toggle} />
            ))}
          </ol>
        )}
      </div>

      {unseen > 0 && (
        <button
          id="log-jump-latest"
          type="button"
          className={s.jump}
          onClick={() => {
            pin(true);
            setUnseen(0);
          }}
        >
          <span className="num">{unseen}</span> new {unseen === 1 ? "event" : "events"}
        </button>
      )}
    </div>
  );
}

function EventRow({ e, t0, open, onToggle }: { e: RunEvent; t0: number; open: boolean; onToggle: (seq: number) => void }) {
  const payload = e.data ? (e.kind === "tool_call" ? (e.data.args ?? e.data) : e.kind === "tool_result" ? (e.data.result ?? e.data) : e.data) : null;
  const inline = payload ? summarize(payload) : null;
  const expandable = payload !== null && payload !== undefined;
  const isTool = e.kind === "tool_call" || e.kind === "tool_result";
  const offset = logOffset(new Date(e.ts).getTime() - t0);
  const body = (
    <>
      <span className={`${s.ts} num`} title={new Date(e.ts).toISOString()}>
        {offset}
      </span>
      <span className={s.kind} data-kind={e.kind}>
        {KIND_TAG[e.kind]}
      </span>
      <span className={s.text}>
        {isTool ? <span className={s.toolName}>{e.text}</span> : <span>{e.text}</span>}
        {isTool && inline && <span className={s.inline}>{inline}</span>}
        {!isTool && e.author && !["codeguard", "architect", "iac", "deploy", "dashboard"].includes(e.author) && (
          <span className={s.author}>{e.author}</span>
        )}
      </span>
      {expandable && (
        <span className={s.chev} data-open={open || undefined} aria-hidden>
          <ChevronGlyph />
        </span>
      )}
    </>
  );
  return (
    <li className={s.row} data-kind={e.kind}>
      {expandable ? (
        <button
          type="button"
          id={`event-${e.seq}-toggle`}
          className={s.line}
          aria-expanded={open}
          aria-controls={`event-${e.seq}-payload`}
          onClick={() => onToggle(e.seq)}
        >
          {body}
        </button>
      ) : (
        <div className={s.line}>{body}</div>
      )}
      {expandable && open && (
        <pre id={`event-${e.seq}-payload`} className={s.payload}>
          {JSON.stringify(payload, null, 2)}
        </pre>
      )}
    </li>
  );
}

function summarize(v: unknown): string {
  if (v === null || typeof v !== "object") return String(v);
  const entries = Object.entries(v as Record<string, unknown>);
  const first = entries.find(([, val]) => typeof val === "string" || typeof val === "number" || typeof val === "boolean");
  if (!first) {
    const arr = entries.find(([, val]) => Array.isArray(val));
    if (arr) {
      const n = (arr[1] as unknown[]).length;
      return `${arr[0]}: ${n} ${n === 1 ? "item" : "items"}`;
    }
    return `${entries.length} ${entries.length === 1 ? "field" : "fields"}`;
  }
  const [k, val] = first;
  const str = String(val);
  return `${k}: ${str.length > 64 ? str.slice(0, 63) + "..." : str}`;
}
