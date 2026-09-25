import { useEffect, useState } from "react";
import { getApi } from "../api/client";
import type { Project } from "../api/types";
import { TopBar } from "../components/TopBar";
import { StatusIcon } from "../components/Icons";
import { Link } from "../components/Link";
import { absolute, relative, runStatusLabel } from "../lib/format";
import { navigate, projectPath } from "../lib/router";
import { useNow } from "../lib/useNow";
import { ProjectSkeleton } from "./ProjectPage";
import s from "./ProjectsPage.module.css";

export function ProjectsPage() {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const now = useNow(true, 30000);

  useEffect(() => {
    let cancelled = false;
    getApi()
      .then((api) => api.listProjects())
      .then((r) => {
        if (cancelled) return;
        if (r.projects.length === 1) navigate(projectPath(r.projects[0].id), { replace: true });
        else setProjects(r.projects);
      })
      .catch((e: unknown) => !cancelled && setError(e instanceof Error ? e.message : "Could not load projects."));
    return () => {
      cancelled = true;
    };
  }, []);

  const waiting = projects?.filter((p) => p.latest_run?.status === "awaiting_approval").length ?? 0;

  useEffect(() => {
    if (projects) document.title = `${waiting > 0 ? `(${waiting}) ` : ""}Projects · Vibe2Prod`;
  }, [projects, waiting]);

  if (error)
    return (
      <>
        <TopBar />
        <main className={s.page}>
          <h1 className={s.title}>Projects</h1>
          <p className={s.error} role="alert">
            Could not load projects: {error}
          </p>
        </main>
      </>
    );

  if (!projects) return <ProjectSkeleton />;

  return (
    <>
      <TopBar />
      <main className={s.page}>
        <h1 className={s.title}>Projects</h1>
        {projects.length === 0 ? (
          <section className={s.empty} aria-labelledby="no-projects">
            <h2 id="no-projects" className={s.emptyTitle}>
              No projects yet
            </h2>
            <p className={s.emptyBody}>A project is one app repository. Projects are added by the Vibe2Prod team.</p>
          </section>
        ) : (
          <div className={s.tableWrap}>
            <table className={s.table}>
              <thead>
                <tr>
                  <th scope="col">Project</th>
                  <th scope="col">Repository</th>
                  <th scope="col">Latest run</th>
                  <th scope="col" className={s.right}>
                    Score
                  </th>
                  <th scope="col" className={s.right}>
                    Last run
                  </th>
                </tr>
              </thead>
              <tbody>
                {projects.map((p) => {
                  const to = projectPath(p.id);
                  const r = p.latest_run;
                  const score = p.score_history.at(-1)?.total ?? null;
                  return (
                    <tr key={p.id} className={s.row} onClick={() => navigate(to)}>
                      <td>
                        <Link to={to} id={`project-link-${p.id}`} className={s.name} onClick={(e) => e.stopPropagation()}>
                          {p.name}
                        </Link>
                      </td>
                      <td className={s.muted}>
                        {p.repo}
                        <span className={`${s.chip} mono`}>{p.branch}</span>
                      </td>
                      <td>
                        {r ? (
                          <span className={`${s.status} ${s[r.status]}`}>
                            <StatusIcon status={r.status} size={14} />
                            {runStatusLabel[r.status]}
                            <span className={s.runNum}>
                              Run <span className="num">{r.number}</span>
                            </span>
                          </span>
                        ) : (
                          <span className={s.faint}>No runs</span>
                        )}
                      </td>
                      <td className={`${s.right} num`}>{score === null ? <span className={s.faint}>--</span> : <span className={s.score}>{Math.round(score)}</span>}</td>
                      <td className={`${s.right} ${s.muted} num`}>
                        {r ? (
                          <time dateTime={r.created_at} title={absolute(r.created_at)}>
                            {relative(r.created_at, now)}
                          </time>
                        ) : (
                          <span className={s.faint}>--</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </main>
    </>
  );
}
