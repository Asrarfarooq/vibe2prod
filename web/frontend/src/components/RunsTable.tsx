import type { RunSummary, StageKey } from "../api/types";
import { StatusIcon } from "./Icons";
import { Link } from "./Link";
import { absolute, relative, runStatusLabel, shortSha } from "../lib/format";
import { navigate, runPath } from "../lib/router";
import s from "./RunsTable.module.css";

const STAGE_NAME: Record<StageKey, string> = {
  codeguard: "CodeGuard",
  architect: "Architect + Critic",
  iac: "IaC + Cost",
  deploy: "Deploy + Audit",
};
const STAGE_NUM: Record<StageKey, number> = { codeguard: 1, architect: 2, iac: 3, deploy: 4 };

export function RunsTable({ runs, now }: { runs: RunSummary[] | null; now: number }) {
  return (
    <div className={s.wrap}>
      <table className={s.table}>
        <thead>
          <tr>
            <th scope="col">Run</th>
            <th scope="col">Commit</th>
            <th scope="col">Status</th>
            <th scope="col">Stage</th>
            <th scope="col" className={s.right}>
              Score
            </th>
            <th scope="col" className={s.right}>
              Started
            </th>
          </tr>
        </thead>
        <tbody>
          {runs === null
            ? Array.from({ length: 3 }, (_, i) => (
                <tr key={i} aria-hidden>
                  {[48, 60, 120, 140, 32, 64].map((w, j) => (
                    <td key={j} className={j >= 4 ? s.right : undefined}>
                      <span className="skeleton" style={{ display: "inline-block", width: w, height: 12 }} />
                    </td>
                  ))}
                </tr>
              ))
            : runs.map((r) => {
                const to = runPath(r.project_id, r.id);
                return (
                  <tr key={r.id} className={s.row} onClick={() => navigate(to)}>
                    <td>
                      <Link to={to} id={`run-link-${r.id}`} className={s.runLink} onClick={(e) => e.stopPropagation()}>
                        Run <span className="num">{r.number}</span>
                      </Link>
                    </td>
                    <td className="mono">
                      {r.app.commit ? (
                        <span className={s.sha} title={r.app.commit}>
                          {shortSha(r.app.commit)}
                        </span>
                      ) : (
                        <span className={s.faint}>resolving</span>
                      )}
                    </td>
                    <td>
                      <span className={`${s.status} ${s[r.status]}`}>
                        <StatusIcon status={r.status} size={14} />
                        {runStatusLabel[r.status]}
                      </span>
                    </td>
                    <td className={s.muted}>
                      {r.current_stage ? (
                        <>
                          <span className={`${s.stageNum} num`}>{STAGE_NUM[r.current_stage]}</span>
                          {STAGE_NAME[r.current_stage]}
                        </>
                      ) : r.status === "succeeded" ? (
                        "Complete"
                      ) : (
                        "Stopped"
                      )}
                    </td>
                    <td className={`${s.right} num`}>
                      {r.score_total === null ? <span className={s.faint}>--</span> : <span className={s.score}>{Math.round(r.score_total)}</span>}
                    </td>
                    <td className={`${s.right} ${s.muted} num`}>
                      <time dateTime={r.created_at} title={absolute(r.created_at)}>
                        {relative(r.created_at, now)}
                      </time>
                    </td>
                  </tr>
                );
              })}
        </tbody>
      </table>
    </div>
  );
}
