import type { Stage } from "../api/types";
import { clock, duration, handle, stageStatusLabel } from "../lib/format";
import { CheckGlyph, CrossGlyph, LockGlyph, StatusIcon } from "./Icons";
import s from "./PipelineStepper.module.css";

interface Props {
  stages: Stage[];
  selected: string;
  onSelect: (key: Stage["key"]) => void;
  now: number;
}

export function PipelineStepper({ stages, selected, onSelect, now }: Props) {
  return (
    <nav className={s.stepper} aria-label="Pipeline stages">
      <ol className={s.list}>
        {stages.map((st, i) => (
          <li key={st.key} className={s.item} data-last={i === stages.length - 1 || undefined}>
            <StageNode stage={st} index={i} selected={selected === st.key} onSelect={onSelect} now={now} />
            {i < stages.length - 1 && <GateConnector stage={st} next={stages[i + 1]} index={i} />}
          </li>
        ))}
      </ol>
    </nav>
  );
}

function StageNode({ stage, index, selected, onSelect, now }: { stage: Stage; index: number; selected: boolean; onSelect: Props["onSelect"]; now: number }) {
  const started = stage.started_at ? new Date(stage.started_at).getTime() : null;
  const ended = stage.ended_at ? new Date(stage.ended_at).getTime() : null;
  const dur = started ? duration((ended ?? now) - started) : null;
  return (
    <button
      type="button"
      id={`stage-node-${stage.key}`}
      className={s.node}
      data-status={stage.status}
      aria-current={selected ? "step" : undefined}
      aria-pressed={selected}
      onClick={() => onSelect(stage.key)}
    >
      <span className={s.nodeTop}>
        <span className={`${s.index} num`}>{index + 1}</span>
        <span className={s.name}>{stage.name}</span>
      </span>
      <span className={s.meta}>
        <StatusIcon status={stage.status} size={14} />
        <span className={s.statusText}>{stageStatusLabel[stage.status]}</span>
        {dur && (stage.status !== "queued" && stage.status !== "skipped") && <span className={`${s.dur} num`}>{dur}</span>}
      </span>
    </button>
  );
}

type GateState = "pending" | "waiting" | "approved" | "denied";

function gateState(stage: Stage): GateState {
  if (stage.status === "awaiting_approval") return "waiting";
  if (stage.decision?.decision === "approve" || stage.status === "approved") return "approved";
  if (stage.decision?.decision === "deny" || stage.status === "denied") return "denied";
  return "pending";
}

function GateConnector({ stage, next, index }: { stage: Stage; next: Stage; index: number }) {
  const state = gateState(stage);
  const d = stage.decision;
  let label: string;
  let sub: string | null = null;
  let title: string;
  switch (state) {
    case "waiting":
      label = "Awaiting approval";
      title = `Gate ${index + 1}: ${next.name} starts after you approve ${stage.name}`;
      break;
    case "approved":
      label = d ? handle(d.by) : "Approved";
      sub = d ? clock(d.at) : null;
      title = d ? `Approved by ${handle(d.by)} at ${clock(d.at)}` : "Approved";
      break;
    case "denied":
      label = d ? `Denied by ${handle(d.by)}` : "Denied";
      title = d ? `Denied by ${handle(d.by)} at ${clock(d.at)}` : "Denied";
      break;
    default:
      label = "Approval gate";
      title = `Gate ${index + 1}: opens when ${stage.name} is approved`;
  }
  return (
    <div className={s.gate} data-state={state} title={title} role="img" aria-label={title}>
      <span className={s.line} aria-hidden />
      <span className={s.badge} aria-hidden>
        <LockGlyph className={`${s.glyph} ${s.lock}`} width={12} height={12} />
        <CheckGlyph className={`${s.glyph} ${s.check}`} width={13} height={13} />
        <CrossGlyph className={`${s.glyph} ${s.cross}`} width={12} height={12} />
      </span>
      <span className={`${s.gateLabel} num`} aria-hidden>
        <span className={s.labelPart}>{label}</span>
        {sub && <span className={s.labelPart}>{sub}</span>}
      </span>
    </div>
  );
}
