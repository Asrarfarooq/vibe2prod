import type { Scorecard as Card } from "../api/types";
import s from "./Scorecard.module.css";

export function Scorecard({ card, deployName }: { card: Card; deployName: string }) {
  return (
    <section className={s.panel} aria-labelledby="scorecard-heading">
      <div className={s.head}>
        <h2 id="scorecard-heading" className={s.title}>
          Before vs after
        </h2>
        <p className={s.sub}>
          Computed by {deployName} from this run's scanner results, Terraform plan and readiness audit.
          {card.agent_minutes !== null && ` Agent time across the four stages: ${card.agent_minutes} min.`}
        </p>
      </div>
      <div className={s.scroll} tabIndex={0} aria-label="Before and after comparison">
        <table className={s.table}>
          <thead>
            <tr>
              <th scope="col">Category</th>
              <th scope="col">Before (vibe-coded)</th>
              <th scope="col">After (Vibe2Prod)</th>
              <th scope="col">Change</th>
            </tr>
          </thead>
          <tbody>
            {card.rows.map((r) => (
              <tr key={r.category}>
                <th scope="row">{r.category}</th>
                <td className={s.before}>{r.before}</td>
                <td className={s.after}>{r.after}</td>
                <td>
                  <span className={`${s.delta} num`} data-improved={r.improved || undefined}>
                    {r.delta}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
