import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, getApi } from "../api/client";
import type { Project, RunSummary } from "../api/types";
import { TopBar, type Crumb } from "../components/TopBar";
import { ExternalGlyph } from "../components/Icons";
import { Link } from "../components/Link";
import { RunsTable } from "../components/RunsTable";
import { sortRuns } from "../lib/runs";
import { ScoreHistory } from "../components/ScoreHistory";
import { ApproverKeyField } from "../components/ApproverKeyField";
import { approverKey } from "../lib/approverKey";
import { navigate, projectPath, runPath } from "../lib/router";
import { useNow } from "../lib/useNow";
import { NotFound } from "./NotFound";
import s from "./ProjectPage.module.css";

const POLL_MS = 10000;

export function ProjectPage({ id }: { id: string }) {
  const [project, setProject] = useState<Project | null>(null);
  const [runs, setRuns] = useState<RunSummary[] | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "not_found" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const now = useNow(true, 30000);

  const load = useCallback(async () => {
    const api = await getApi();
    const [p, r] = await Promise.all([api.getProject(id), api.listProjectRuns(id)]);
    setProject(p);
    setRuns(sortRuns(r.runs));
    setState("ready");
  }, [id]);

  useEffect(() => {
    let cancelled = false;
    const tick = () =>
      load().catch((e: unknown) => {
        if (cancelled) return;
        if (e instanceof ApiError && e.status === 404) setState("not_found");
        else {
          setError(e instanceof Error ? e.message : "Could not load this project.");
          setState((prev) => (prev === "ready" ? prev : "error"));
        }
      });
    void tick();
    const t = window.setInterval(() => void tick(), POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(t);
    };
  }, [load]);

  const waiting = runs?.filter((r) => r.status === "awaiting_approval").length ?? 0;

  useEffect(() => {
    if (!project) return;
    document.title = `${waiting > 0 ? `(${waiting}) ` : ""}${project.name} · Vibe2Prod`;
  }, [project, waiting]);

  if (state === "not_found")
    return <NotFound title="No project with this id" body={`Project ${id} does not exist.`} />;

  if (state === "error" || !project || !runs) {
    if (state === "error")
      return (
        <>
          <TopBar crumbs={[{ label: id, to: projectPath(id) }]} />
          <main className={s.page}>
            <div className={s.message}>
              <h1 className={s.msgTitle}>This project could not be loaded</h1>
              <p className={s.msgBody}>{error}</p>
              <button id="project-retry" type="button" className={s.secondaryBtn} onClick={() => window.location.reload()}>
                Reload the page
              </button>
            </div>
          </main>
        </>
      );
    return <ProjectSkeleton crumbs={[{ label: id, to: projectPath(id) }]} />;
  }

  const active = runs.find((r) => r.status === "running" || r.status === "awaiting_approval");
  const history = project.score_history;
  const latest = history.at(-1) ?? null;
  const [owner, repoName] = project.repo.includes("/") ? project.repo.split("/", 2) : ["", project.repo];
  const repoUrl = /^https:\/\//.test(project.repo_url) ? project.repo_url : `https://github.com/${project.repo}`;
  const appUrl = project.app_url && /^https:\/\//.test(project.app_url) ? project.app_url : null;

  return (
    <>
      <TopBar crumbs={[{ label: project.name, to: projectPath(project.id) }]} />
      <main className={s.page}>
        <header className={s.header}>
          <div className={s.headMain}>
            <p className={s.context}>
              <a id="project-repo-link" className={s.repo} href={repoUrl} target="_blank" rel="noopener noreferrer">
                <span>
                  {owner && <span className={s.owner}>{owner}/</span>}
                  {repoName}
                </span>
                <ExternalGlyph />
              </a>
              <span className={`${s.chip} mono`} title="Branch">
                {project.branch}
              </span>
              <span className={s.target}>
                Deploys to <span className="mono">{project.target_project}</span>
              </span>
              {appUrl && (
                <a id="project-app-link" className={s.appLink} href={appUrl} target="_blank" rel="noopener noreferrer">
                  Open app
                  <ExternalGlyph />
                </a>
              )}
            </p>
            <h1 className={s.h1}>{project.name}</h1>
          </div>
          <div className={s.side}>
            <dl className={s.stats}>
              <div>
                <dt>Latest readiness</dt>
                <dd className={s.score}>
                  {latest ? (
                    <>
                      <span className={`${s.scoreNum} num`} data-low={latest.total < 60 || undefined}>
                        {Math.round(latest.total)}
                      </span>
                      <Link to={runPath(project.id, latest.run_id)} id="latest-score-run" className={s.scoreRun}>
                        Run <span className="num">{latest.number}</span>
                      </Link>
                    </>
                  ) : (
                    <span className={`${s.scoreNum} ${s.empty} num`}>--</span>
                  )}
                </dd>
              </div>
              {history.length >= 2 && (
                <div>
                  <dt>History</dt>
                  <dd className={s.history}>
                    <ScoreHistory points={history} />
                  </dd>
                </div>
              )}
            </dl>
            <button
              id="start-run"
              type="button"
              className={s.primary}
              disabled={!!active}
              title={active ? "A run is already in progress" : undefined}
              aria-expanded={confirming}
              aria-controls="start-run-confirm"
              onClick={() => setConfirming(true)}
            >
              Start run
            </button>
          </div>
        </header>

        {confirming && (
          <StartRunConfirm
            project={project}
            onCancel={() => setConfirming(false)}
            onConflict={() => {
              void load().catch(() => {});
            }}
          />
        )}

        <section className={s.runs} aria-labelledby="runs-heading">
          <div className={s.runsHead}>
            <h2 id="runs-heading" className={s.h2}>
              Runs
            </h2>
            {runs.length > 0 && (
              <p className={s.sub}>
                <span className="num">{runs.length}</span> {runs.length === 1 ? "run" : "runs"}
                {waiting > 0 && (
                  <>
                    <span className={s.dot} aria-hidden>
                      ·
                    </span>
                    <span className={s.waiting}>
                      <span className="num">{waiting}</span> awaiting approval
                    </span>
                  </>
                )}
              </p>
            )}
          </div>
          {runs.length === 0 ? (
            <p className={s.emptyRuns}>
              No runs yet. Start a run to send the latest commit on <span className="mono">{project.branch}</span> through the four agents.
            </p>
          ) : (
            <RunsTable runs={runs} now={now} />
          )}
        </section>
      </main>
    </>
  );
}

function StartRunConfirm({ project, onCancel, onConflict }: { project: Project; onCancel: () => void; onConflict: () => void }) {
  const [keyInput, setKeyInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [keyMissing, setKeyMissing] = useState(false);
  const keyField = useRef<HTMLInputElement>(null);
  const confirmBtn = useRef<HTMLButtonElement>(null);
  const errId = "start-run-error";

  useEffect(() => {
    (keyField.current ?? confirmBtn.current)?.focus();
  }, []);

  const confirm = async () => {
    if (busy) return;
    const key = approverKey.get() ?? keyInput.trim();
    if (!key) {
      setKeyMissing(true);
      setError(null);
      keyField.current?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    setKeyMissing(false);
    try {
      const api = await getApi();
      const run = await api.startRun(project.id, key);
      approverKey.remember(key);
      navigate(runPath(project.id, run.id));
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) {
        approverKey.forget();
        setKeyInput("");
        setError("Approver key not recognized.");
      } else if (e instanceof ApiError) {
        setError(e.message);
        if (e.status === 409) onConflict();
      } else {
        setError("The run was not started. Check your connection and try again.");
      }
      setBusy(false);
    }
  };

  return (
    <section
      id="start-run-confirm"
      className={s.confirm}
      aria-labelledby="start-run-title"
      onKeyDown={(e) => {
        if (e.key === "Escape" && !busy) onCancel();
      }}
    >
      <p id="start-run-title" className={s.confirmText}>
        <strong>
          Start a run on <span className="mono">{project.branch}</span>?
        </strong>{" "}
        CodeGuard starts on the latest commit.
      </p>
      <form
        className={s.confirmForm}
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void confirm();
        }}
      >
        <div className={s.confirmKey}>
          <ApproverKeyField
            id="start-approver-key"
            inputRef={keyField}
            value={keyInput}
            onChange={(v) => {
              setKeyInput(v);
              if (keyMissing && v.trim()) setKeyMissing(false);
            }}
            invalid={keyMissing}
            errorId={errId}
            disabled={busy}
            hint="Only the Vibe2Prod team can start runs."
          />
        </div>
        <div className={s.confirmActions}>
          <button ref={confirmBtn} id="start-run-confirm-btn" type="submit" className={s.primary} disabled={busy}>
            {busy ? "Starting" : "Confirm"}
          </button>
          <button id="start-run-cancel" type="button" className={s.secondaryBtn} disabled={busy} onClick={onCancel}>
            Cancel
          </button>
        </div>
      </form>
      {(keyMissing || error) && (
        <p id={errId} className={s.error} role="alert">
          {keyMissing ? "Enter your approver key." : error}
        </p>
      )}
    </section>
  );
}

export function ProjectSkeleton({ crumbs }: { crumbs?: Crumb[] }) {
  return (
    <>
      <TopBar crumbs={crumbs} />
      <main className={s.page} aria-busy="true" aria-label="Loading project">
        <header className={s.header}>
          <div className={s.headMain}>
            <span className="skeleton" style={{ display: "block", width: 360, height: 14 }} />
            <span className="skeleton" style={{ display: "block", width: 240, height: 28, marginTop: 10 }} />
          </div>
          <span className="skeleton" style={{ display: "block", width: 200, height: 40 }} />
        </header>
        <section className={s.runs}>
          <span className="skeleton" style={{ display: "block", width: 80, height: 16 }} />
          <RunsTable runs={null} now={0} />
        </section>
      </main>
    </>
  );
}
