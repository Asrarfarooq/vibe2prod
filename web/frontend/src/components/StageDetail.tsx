import { useMemo, useRef, type KeyboardEvent } from "react";
import type { RunEvent, Stage } from "../api/types";
import { EventLog } from "./EventLog";
import { ArtifactViewer } from "./Artifacts";
import { StatusIcon } from "./Icons";
import { absolute, clock, handle } from "../lib/format";
import { structured } from "../lib/structured";
import s from "./StageDetail.module.css";

export type Tab = "activity" | "artifacts" | "output";
const TABS: { key: Tab; label: string }[] = [
  { key: "activity", label: "Activity" },
  { key: "artifacts", label: "Artifacts" },
  { key: "output", label: "Output" },
];

interface Props {
  stage: Stage;
  index: number;
  events: RunEvent[];
  tab: Tab;
  onTab: (t: Tab) => void;
}

export function StageDetail({ stage, index, events, tab, onTab }: Props) {
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const stageEvents = useMemo(() => events.filter((e) => e.stage === stage.key), [events, stage.key]);
  const lastError = useMemo(() => {
    if (stage.status !== "failed") return null;
    for (let i = stageEvents.length - 1; i >= 0; i--) if (stageEvents[i].kind === "error") return stageEvents[i];
    return null;
  }, [stage.status, stageEvents]);
  const started = stage.started_at ? new Date(stage.started_at).getTime() : null;
  const first = stageEvents[0] ? new Date(stageEvents[0].ts).getTime() : null;
  // Reruns keep earlier attempts' events, which predate started_at.
  const origin = started !== null && first !== null ? Math.min(started, first) : (started ?? first);

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = TABS.findIndex((t) => t.key === tab);
    let n = -1;
    if (e.key === "ArrowRight") n = (i + 1) % TABS.length;
    else if (e.key === "ArrowLeft") n = (i - 1 + TABS.length) % TABS.length;
    else if (e.key === "Home") n = 0;
    else if (e.key === "End") n = TABS.length - 1;
    if (n < 0) return;
    e.preventDefault();
    onTab(TABS[n].key);
    tabRefs.current[n]?.focus();
  };

  const counts: Record<Tab, number | null> = {
    activity: null,
    artifacts: stage.artifacts.length,
    output: null,
  };

  return (
    <section className={s.panel} aria-labelledby="stage-title">
      <header className={s.head}>
        <div className={s.titleRow}>
          <h2 id="stage-title" className={s.title}>
            <span className={`${s.num} num`}>{index + 1}</span>
            {stage.name}
            {stage.attempt > 1 && <span className={`${s.attempt} num`}>Attempt {stage.attempt}</span>}
          </h2>
        </div>
        <p className={s.desc}>{stage.agent_description}</p>
      </header>

      {lastError && (
        <div className={s.error} role="alert">
          <div className={s.errorHead}>
            <StatusIcon status="failed" size={14} />
            <span>
              {stage.name} failed at <time dateTime={lastError.ts} title={absolute(lastError.ts)}>{clock(lastError.ts)}</time>
            </span>
          </div>
          <p className={s.errorText}>{lastError.text}</p>
        </div>
      )}

      <div className={s.tabs} role="tablist" aria-label={`${stage.name} views`} onKeyDown={onKey}>
        {TABS.map((t, i) => (
          <button
            key={t.key}
            ref={(el) => {
              tabRefs.current[i] = el;
            }}
            id={`tab-${t.key}`}
            type="button"
            role="tab"
            className={s.tab}
            aria-selected={tab === t.key}
            aria-controls={`tabpanel-${t.key}`}
            tabIndex={tab === t.key ? 0 : -1}
            onClick={() => onTab(t.key)}
          >
            {t.label}
            {counts[t.key] ? <span className={`${s.tabCount} num`}>{counts[t.key]}</span> : null}
          </button>
        ))}
      </div>

      <div id={`tabpanel-${tab}`} role="tabpanel" aria-labelledby={`tab-${tab}`} className={s.body}>
        {tab === "activity" && (
          <>
            {stage.feedback && (
              <div className={s.feedback}>
                <p className={s.feedbackHead}>
                  Feedback for attempt {stage.attempt} from {handle(stage.feedback.by)}
                  <time className="num" dateTime={stage.feedback.at} title={absolute(stage.feedback.at)}>
                    {clock(stage.feedback.at)}
                  </time>
                </p>
                <p className={s.feedbackText}>{stage.feedback.text}</p>
              </div>
            )}
            <EventLog key={stage.key} events={stageEvents} origin={origin} stageKey={stage.key} live={stage.status === "running"} />
          </>
        )}
        {tab === "artifacts" && (
          <div className={s.scroll} tabIndex={0} aria-label={`${stage.name} artifacts`}>
            <div className={s.pad}>
              {stage.artifacts.length === 0 ? (
                <p className={s.empty}>
                  {stage.status === "queued" || stage.status === "running"
                    ? `${stage.name} has not produced artifacts yet.`
                    : `${stage.name} produced no artifacts.`}
                </p>
              ) : (
                stage.artifacts.map((a, i) => <ArtifactViewer key={`${a.kind}-${i}`} artifact={a} id={`artifact-${stage.key}-${i}`} />)
              )}
            </div>
          </div>
        )}
        {tab === "output" && (
          <div className={s.scroll} tabIndex={0} aria-label={`${stage.name} output`}>
            <Output stage={stage} events={stageEvents} origin={origin} />
          </div>
        )}
      </div>
    </section>
  );
}

function Output({ stage, events }: { stage: Stage; events: RunEvent[]; origin: number | null }) {
  const outputs = events.filter((e) => e.kind === "output");
  if (!stage.summary && outputs.length === 0) {
    return (
      <div className={s.pad}>
        <p className={s.empty}>
          {stage.status === "queued" ? `${stage.name} has not started.` : stage.status === "skipped" ? `${stage.name} was skipped.` : "No output yet."}
        </p>
      </div>
    );
  }
  return (
    <div className={s.pad}>
      {stage.summary && (
        <div className={s.summary}>
          <h3 className={s.h3}>Summary</h3>
          <p>{stage.summary}</p>
        </div>
      )}
      {outputs.length > 0 && (
        <div>
          <h3 className={s.h3}>Findings and results</h3>
          <ol className={s.outputs}>
            {outputs.map((o) => {
              const r = structured(o.text);
              return (
                <li key={o.seq}>
                  <time className="num" dateTime={o.ts} title={absolute(o.ts)}>
                    {clock(o.ts)}
                  </time>
                  {r ? (
                    <div className={s.result}>
                      {r.summary && <p>{r.summary}</p>}
                      <details className={s.json}>
                        <summary>{r.parsed ? "Full result" : "Raw result"}</summary>
                        <pre>{r.body}</pre>
                      </details>
                    </div>
                  ) : (
                    <span>{o.text}</span>
                  )}
                </li>
              );
            })}
          </ol>
        </div>
      )}
    </div>
  );
}
