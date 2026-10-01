import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getApi } from "../api/client";
import type { Run, StageAttempt, StageKey } from "../api/types";
import { useRun } from "../api/useRun";
import { TopBar, type Crumb } from "../components/TopBar";
import { PipelineStepper } from "../components/PipelineStepper";
import { StageDetail, type Tab } from "../components/StageDetail";
import { DecisionPanel } from "../components/DecisionPanel";
import { RerunPanel } from "../components/RerunPanel";
import { ArtifactList } from "../components/Artifacts";
import { Readiness } from "../components/Readiness";
import { ExternalGlyph, StatusIcon } from "../components/Icons";
import { absolute, clock, elapsedClock, shortSha } from "../lib/format";
import { decisionTarget } from "../lib/stages";
import { projectPath, runPath } from "../lib/router";
import { useNow } from "../lib/useNow";
import { NotFound } from "./NotFound";
import s from "./RunPage.module.css";

function defaultStage(run: Run): StageKey {
  const waiting = run.stages.find((x) => x.status === "awaiting_approval");
  if (waiting) return waiting.key;
  if (run.current_stage) return run.current_stage;
  const failed = run.stages.find((x) => x.status === "failed" || x.status === "denied");
  if (failed) return failed.key;
  const started = [...run.stages].reverse().find((x) => x.status !== "queued" && x.status !== "skipped");
  return (started ?? run.stages[0]).key;
}

function headline(run: Run): string {
  const idx = run.stages.findIndex((x) => x.status === "awaiting_approval");
  switch (run.status) {
    case "awaiting_approval":
      return idx >= 0 ? `Waiting for approval at gate ${idx + 1}` : "Waiting for approval";
    case "running": {
      const cur = run.stages.find((x) => x.key === run.current_stage);
      return cur ? `Running ${cur.name}` : "Running";
    }
    case "succeeded":
      return run.score ? `Deployed with readiness ${Math.round(run.score.total)} of 100` : "Deployed";
    case "failed": {
      const f = run.stages.find((x) => x.status === "failed");
      return f ? `Failed in ${f.name}` : "Failed";
    }
    case "denied": {
      const d = run.stages.findIndex((x) => x.status === "denied");
      return d >= 0 ? `Stopped: gate ${d + 1} denied` : "Stopped: denied";
    }
  }
}

export function RunPage({ projectId, id }: { projectId: string; id: string }) {
  const { state, run, events, connection, error, replaceRun } = useRun(id);
  const [projectName, setProjectName] = useState<string | null>(null);
  const [selected, setSelected] = useState<StageKey | null>(null);
  const [tab, setTab] = useState<Tab>("activity");
  const picked = useRef(false);
  const live = run?.status === "running" || run?.status === "awaiting_approval";
  const now = useNow(!!live || !!run?.stages.some((x) => x.status === "running"));

  useEffect(() => {
    let cancelled = false;
    getApi()
      .then((api) => api.getProject(projectId))
      .then((p) => !cancelled && setProjectName(p.name))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  useEffect(() => {
    if (!run) return;
    if (!picked.current || selected === null) setSelected(defaultStage(run));
  }, [run, selected]);

  const [attempts, setAttempts] = useState<StageAttempt[]>([]);
  const attemptSig = run ? run.stages.map((x) => `${x.key}:${x.attempt}:${x.started_at ?? ""}`).join("|") : "";
  useEffect(() => {
    if (!attemptSig) return;
    let cancelled = false;
    getApi()
      .then((api) => api.getAttempts(id))
      .then((b) => !cancelled && setAttempts(b.attempts))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [id, attemptSig]);

  const projectLabel = projectName ?? projectId;

  useEffect(() => {
    if (!run) {
      document.title = state === "not_found" ? "Not found · Vibe2Prod" : `${projectLabel} · Vibe2Prod`;
      return;
    }
    const prefix = run.status === "awaiting_approval" ? "(1) " : "";
    document.title = `${prefix}Run ${run.number} · ${projectLabel} · Vibe2Prod`;
  }, [run, state, projectLabel]);

  const select = useCallback((k: StageKey) => {
    picked.current = true;
    setSelected(k);
  }, []);

  const openArtifacts = useCallback(
    (k: StageKey) => {
      select(k);
      setTab("artifacts");
      document.getElementById("stage-title")?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    },
    [select],
  );

  const refetch = useCallback(() => {
    getApi()
      .then((api) => api.getRun(id))
      .then(replaceRun)
      .catch(() => {});
  }, [id, replaceRun]);

  const stageIdx = useMemo(() => (run && selected ? run.stages.findIndex((x) => x.key === selected) : -1), [run, selected]);

  const projectCrumb: Crumb = { label: projectLabel, to: projectPath(projectId) };
  const crumbs: Crumb[] = [projectCrumb, { label: run ? `Run ${run.number}` : "Run", to: runPath(projectId, id) }];

  if (state === "not_found" || (run && run.project_id !== projectId))
    return (
      <NotFound
        title="No run with this id"
        body={`Run ${id} does not exist in ${projectLabel}.`}
        crumbs={[projectCrumb]}
        back={{ label: `Go to ${projectLabel}`, to: projectPath(projectId) }}
      />
    );
  if (state === "error")
    return (
      <>
        <TopBar crumbs={crumbs} />
        <main className={s.page}>
          <div className={s.message}>
            <h1 className={s.msgTitle}>This run could not be loaded</h1>
            <p className={s.msgBody}>{error}</p>
            <button id="run-retry" type="button" className={s.secondaryBtn} onClick={() => window.location.reload()}>
              Reload the page
            </button>
          </div>
        </main>
      </>
    );
  if (!run || stageIdx < 0) return <RunSkeleton crumbs={crumbs} />;

  const stage = run.stages[stageIdx];
  const target = decisionTarget(run.stages, stage.key);
  const created = new Date(run.created_at).getTime();
  const end = live ? now : new Date(run.updated_at).getTime();
  const [owner, name] = run.app.repo.includes("/") ? run.app.repo.split("/", 2) : ["", run.app.repo];
  const repoUrl = run.app.url && /^https:\/\//.test(run.app.url) ? run.app.url : `https://github.com/${run.app.repo}`;
  const deploy = run.stages.find((x) => x.key === "deploy");
  const failedIdx = run.status === "failed" ? run.stages.findIndex((x) => x.status === "failed") : -1;

  return (
    <>
      <TopBar crumbs={crumbs} />
      <main className={s.page}>
        <header className={s.header}>
          <div className={s.headMain}>
            <p className={s.context}>
              <span className={s.project}>{run.project}</span>
              <span className={s.chev} aria-hidden>
                /
              </span>
              <a id="repo-link" className={s.repo} href={repoUrl} target="_blank" rel="noopener noreferrer">
                <span>
                  {owner && <span className={s.owner}>{owner}/</span>}
                  {name}
                </span>
                <ExternalGlyph />
              </a>
              <span className={`${s.ref} mono`}>
                {run.app.branch}
                <span className={s.at}>@</span>
                {run.app.commit ? <span title={run.app.commit}>{shortSha(run.app.commit)}</span> : <span className={s.resolving}>resolving</span>}
              </span>
            </p>
            <h1 className={s.h1} data-status={run.status}>
              <StatusIcon status={run.status} size={20} />
              {headline(run)}
            </h1>
          </div>
          <dl className={s.times}>
            <div>
              <dt>Started</dt>
              <dd className="num">
                <time dateTime={run.created_at} title={absolute(run.created_at)}>
                  {clock(run.created_at)}
                </time>
              </dd>
            </div>
            <div>
              <dt>{live ? "Elapsed" : "Duration"}</dt>
              <dd className={`num ${s.elapsed}`}>{elapsedClock(end - created)}</dd>
            </div>
          </dl>
        </header>

        {connection === "reconnecting" && (
          <div className={s.reconnect} role="status">
            <span className={s.reconnectDot} aria-hidden />
            Live updates paused. Reconnecting.
          </div>
        )}

        <PipelineStepper stages={run.stages} selected={stage.key} onSelect={select} now={now} />

        <div className={s.grid}>
          <StageDetail
            key={`${stage.key}-${stage.attempt}`}
            stage={stage}
            index={stageIdx}
            events={events}
            history={attempts.filter((a) => a.key === stage.key)}
            tab={tab}
            onTab={setTab}
          />
          <aside className={s.rail} aria-label="Decision, artifacts and readiness">
            {failedIdx >= 0 && (
              <RerunPanel
                key={`${run.stages[failedIdx].key}-${run.stages[failedIdx].attempt}`}
                runId={run.id}
                stages={run.stages}
                failedIndex={failedIdx}
                onSent={replaceRun}
                onConflict={refetch}
              />
            )}
            {(failedIdx < 0 || target.stage.decision) && (
              <DecisionPanel
                key={target.stage.key}
                runId={run.id}
                stage={target.stage}
                index={target.index}
                onDecided={replaceRun}
                onConflict={refetch}
              />
            )}
            <section className={s.railSection} aria-labelledby="artifacts-heading">
              <h2 id="artifacts-heading" className={s.railLabel}>
                Artifacts
              </h2>
              <ArtifactList stages={run.stages} onOpen={openArtifacts} />
            </section>
            <Readiness score={run.score} deployName={deploy?.name ?? "Deploy + Audit"} />
          </aside>
        </div>
      </main>
    </>
  );
}

function RunSkeleton({ crumbs }: { crumbs: Crumb[] }) {
  return (
    <>
      <TopBar crumbs={crumbs} />
      <main className={s.page} aria-busy="true" aria-label="Loading run">
        <header className={s.header}>
          <div className={s.headMain}>
            <span className="skeleton" style={{ display: "block", width: 320, height: 14 }} />
            <span className="skeleton" style={{ display: "block", width: 380, height: 28, marginTop: 10 }} />
          </div>
          <span className="skeleton" style={{ display: "block", width: 150, height: 40 }} />
        </header>
        <div className={s.skelStepper}>
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className={s.skelNode}>
              <span className="skeleton" style={{ display: "block", width: "60%", height: 14 }} />
              <span className="skeleton" style={{ display: "block", width: "40%", height: 10, marginTop: 10 }} />
            </div>
          ))}
        </div>
        <div className={s.grid}>
          <div className={s.skelPanel}>
            <span className="skeleton" style={{ display: "block", width: 220, height: 20 }} />
            <span className="skeleton" style={{ display: "block", width: "70%", height: 12, marginTop: 12 }} />
            {Array.from({ length: 9 }, (_, i) => (
              <span key={i} className="skeleton" style={{ display: "block", width: `${92 - ((i * 13) % 40)}%`, height: 12, marginTop: i === 0 ? 40 : 16 }} />
            ))}
          </div>
          <div className={s.skelPanel} style={{ minHeight: 420 }}>
            <span className="skeleton" style={{ display: "block", width: 80, height: 12 }} />
            <span className="skeleton" style={{ display: "block", width: "90%", height: 16, marginTop: 16 }} />
            <span className="skeleton" style={{ display: "block", width: "100%", height: 76, marginTop: 24 }} />
            <span className="skeleton" style={{ display: "block", width: "100%", height: 36, marginTop: 16 }} />
          </div>
        </div>
      </main>
    </>
  );
}
