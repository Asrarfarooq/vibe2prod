import type { Score } from "../api/types";
import s from "./Readiness.module.css";

const CX = 110;
const CY = 104;
const R = 86;
const START = 150;
const SWEEP = 240;

function pt(deg: number, r = R): [number, number] {
  const a = (deg * Math.PI) / 180;
  return [CX + r * Math.cos(a), CY + r * Math.sin(a)];
}

function arc(from: number, to: number): string {
  const [x1, y1] = pt(from);
  const [x2, y2] = pt(to);
  const large = to - from > 180 ? 1 : 0;
  return `M ${x1.toFixed(2)} ${y1.toFixed(2)} A ${R} ${R} 0 ${large} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`;
}

const angle = (v: number) => START + (SWEEP * Math.max(0, Math.min(100, v))) / 100;

function band(v: number): "low" | "mid" | "high" {
  return v >= 80 ? "high" : v >= 60 ? "mid" : "low";
}

const VERDICT = { high: "Ready for production", mid: "Ready after fixes", low: "Not ready for production" };

export function Readiness({ score, deployName }: { score: Score | null; deployName: string }) {
  const total = score ? Math.round(score.total) : null;
  const b = total === null ? null : band(total);
  return (
    <section className={s.panel} aria-labelledby="readiness-heading">
      <h2 id="readiness-heading" className={s.label}>
        Readiness
      </h2>
      <div className={s.gauge}>
        <svg viewBox="0 0 220 160" className={s.svg} aria-hidden focusable={false}>
          <path d={arc(START, START + SWEEP)} className={s.track} />
          {total !== null && total > 0 && <path d={arc(START, angle(total))} className={s.value} data-band={b} />}
          {[60, 80].map((t) => {
            const [x1, y1] = pt(angle(t), R - 7);
            const [x2, y2] = pt(angle(t), R + 7);
            const [lx, ly] = pt(angle(t), R + 16);
            return (
              <g key={t}>
                <line x1={x1} y1={y1} x2={x2} y2={y2} className={s.tick} />
                <text x={lx} y={ly} className={s.tickLabel} textAnchor="middle" dominantBaseline="middle">
                  {t}
                </text>
              </g>
            );
          })}
        </svg>
        <div className={s.readout}>
          <span className={`${s.big} num`} data-empty={total === null || undefined} data-band={b ?? undefined}>
            {total === null ? "--" : total}
          </span>
          {total !== null && <span className={`${s.of} num`}>/ 100</span>}
        </div>
      </div>
      <p className={s.verdict} data-band={b ?? undefined}>
        {b ? VERDICT[b] : "Not scored yet"}
      </p>
      {!score && <p className={s.pending}>{deployName} scores the app after it is deployed and smoke-tested.</p>}

      {score && score.categories.length > 0 && (
        <ul className={s.cats}>
          {score.categories.map((c) => {
            const v = Math.max(0, Math.min(100, Math.round(c.value)));
            return (
              <li key={c.name} className={s.cat}>
                <div className={s.catHead}>
                  <span>{c.name}</span>
                  <span className={`${s.catVal} num`} data-band={band(v)}>
                    {v}
                  </span>
                </div>
                <div className={s.bar} role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={v} aria-label={`${c.name} score`}>
                  <span className={s.fill} data-band={band(v)} style={{ transform: `scaleX(${v / 100})` }} />
                  <span className={s.mark} style={{ left: "60%" }} aria-hidden />
                  <span className={s.mark} style={{ left: "80%" }} aria-hidden />
                </div>
                {c.note && <p className={s.note}>{c.note}</p>}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
