import { useId, useRef, useState, type FormEvent } from "react";
import { ApiError, getApi } from "../api/client";
import type { Run, Stage, StageKey } from "../api/types";
import { approverKey } from "../lib/approverKey";
import { ApproverKeyField } from "./ApproverKeyField";
import s from "./DecisionPanel.module.css";

interface Props {
  runId: string;
  stages: Stage[];
  failedIndex: number;
  onSent: (r: Run) => void;
  onConflict: () => void;
}

const MAX_FEEDBACK = 4000;
const RAN = new Set<Stage["status"]>(["awaiting_approval", "approved", "denied", "failed"]);

export function RerunPanel({ runId, stages, failedIndex, onSent, onConflict }: Props) {
  const failed = stages[failedIndex];
  const targets = stages.slice(0, failedIndex + 1).filter((x) => RAN.has(x.status));
  const iac = targets.find((x) => x.key === "iac");
  // A failed deploy is usually a Terraform problem, so default to sending it back to IaC.
  const deployFailed = failed.key === "deploy" && !!iac;
  const [target, setTarget] = useState<StageKey>(deployFailed ? "iac" : failed.key);
  const [text, setText] = useState(deployFailed ? `Deploy failed: ${failed.summary ?? ""}`.trimEnd() : "");
  const [keyInput, setKeyInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<"key" | "text" | null>(null);
  const keyField = useRef<HTMLInputElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const hintId = useId();
  const errId = useId();
  const chosen = targets.find((x) => x.key === target) ?? failed;
  const label = chosen.key === failed.key ? `Rerun ${chosen.name}` : `Send back to ${chosen.name}`;

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const key = approverKey.get() ?? keyInput.trim();
    const feedback = text.trim();
    if (!key) {
      setFieldError("key");
      setError(null);
      keyField.current?.focus();
      return;
    }
    if (!feedback) {
      setFieldError("text");
      setError(null);
      textarea.current?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    setFieldError(null);
    try {
      const api = await getApi();
      const run = await api.rerun(runId, chosen.key, feedback, key);
      approverKey.remember(key);
      setKeyInput("");
      onSent(run);
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        approverKey.forget();
        setKeyInput("");
        setError("Approver key not recognized.");
      } else if (err instanceof ApiError) {
        setError(err.message);
        if (err.status === 409) onConflict();
      } else {
        setError("The request was not sent. Check your connection and try again.");
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={s.panel} aria-labelledby="rerun-heading">
      <h2 className={s.label} id="rerun-heading">
        Rerun with feedback
      </h2>
      <p className={s.summary}>
        {failed.name} failed. Send feedback to this stage or an earlier one; that agent reruns and the stages after it run again.
      </p>
      <form className={s.form} onSubmit={(e) => void onSubmit(e)} noValidate>
        <ApproverKeyField
          id="rerun-key"
          inputRef={keyField}
          value={keyInput}
          onChange={(v) => {
            setKeyInput(v);
            if (fieldError === "key" && v.trim()) setFieldError(null);
          }}
          invalid={fieldError === "key"}
          errorId={errId}
          disabled={busy}
          hint="Only the Vibe2Prod team can rerun stages."
        />
        <div className={s.field}>
          <label htmlFor="rerun-target" className={s.fieldLabel}>
            Send to
          </label>
          <select id="rerun-target" className={s.select} value={chosen.key} onChange={(e) => setTarget(e.target.value as StageKey)} disabled={busy}>
            {targets.map((x) => (
              <option key={x.key} value={x.key}>
                {stages.indexOf(x) + 1}. {x.name}
                {x.key === failed.key ? " (failed)" : ""}
              </option>
            ))}
          </select>
        </div>
        <div className={s.field}>
          <label htmlFor="rerun-feedback" className={s.fieldLabel}>
            Feedback
          </label>
          <textarea
            ref={textarea}
            id="rerun-feedback"
            className={s.textarea}
            rows={4}
            maxLength={MAX_FEEDBACK}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              if (fieldError === "text" && e.target.value.trim()) setFieldError(null);
            }}
            placeholder="What should the agent fix?"
            aria-invalid={fieldError === "text" || undefined}
            aria-describedby={`${hintId}${fieldError || error ? ` ${errId}` : ""}`}
            disabled={busy}
          />
          <p id={hintId} className={s.hint}>
            The agent reads this before it starts. Saved in the audit record.
          </p>
        </div>
        {(fieldError || error) && (
          <p id={errId} className={s.error} role="alert">
            {fieldError === "key" ? "Enter your approver key." : fieldError === "text" ? "Enter feedback for the agent." : error}
          </p>
        )}
        <div className={s.actions}>
          <button id="rerun-submit" type="submit" className={s.primary} disabled={busy}>
            {busy ? "Sending" : label}
          </button>
        </div>
      </form>
    </section>
  );
}
