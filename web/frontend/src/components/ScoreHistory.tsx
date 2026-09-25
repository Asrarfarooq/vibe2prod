import type { ScorePoint } from "../api/types";
import s from "./ScoreHistory.module.css";

const W = 140;
const H = 40;
const PAD_X = 6;
const PAD_Y = 5;
const LABEL_W = 16;

const y = (v: number) => PAD_Y + (1 - Math.max(0, Math.min(100, v)) / 100) * (H - 2 * PAD_Y);

export function ScoreHistory({ points }: { points: ScorePoint[] }) {
  if (points.length < 2) return null;
  const plotW = W - LABEL_W - 2 * PAD_X;
  const step = plotW / (points.length - 1);
  const xy = points.map((p, i) => [PAD_X + i * step, y(p.total)] as const);
  const label = `Readiness history: ${points.map((p) => `Run ${p.number} ${Math.round(p.total)}`).join(", ")}`;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} className={s.svg} role="img" aria-label={label}>
      {[60, 80].map((t) => (
        <g key={t}>
          <line x1={PAD_X} x2={W - LABEL_W} y1={y(t)} y2={y(t)} className={s.tick} />
          <text x={W - LABEL_W + 3} y={y(t)} dominantBaseline="middle" className={s.tickLabel}>
            {t}
          </text>
        </g>
      ))}
      <polyline points={xy.map(([a, b]) => `${a.toFixed(1)},${b.toFixed(1)}`).join(" ")} className={s.line} />
      {points.map((p, i) => (
        <g key={p.run_id}>
          <title>{`Run ${p.number} · ${Math.round(p.total)}`}</title>
          <circle cx={xy[i][0]} cy={xy[i][1]} r={7} className={s.hit} />
          <circle cx={xy[i][0]} cy={xy[i][1]} r={i === points.length - 1 ? 3 : 2.25} className={s.dot} data-low={p.total < 60 || undefined} />
        </g>
      ))}
    </svg>
  );
}
