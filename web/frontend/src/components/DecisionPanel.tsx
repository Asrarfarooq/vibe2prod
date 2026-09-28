import { useId, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { ApiError, getApi } from "../api/client";
import type { Run, Stage } from "../api/types";
import { absolute, handle } from "../lib/format";
import { approverKey } from "../lib/approverKey";
import { ApproverKeyField } from "./ApproverKeyField";
import { CheckGlyph, CrossGlyph, LockGlyph } from "./Icons";
import s from "./DecisionPanel.module.css";

interface Props {
  runId: string;
  stage: Stage;
  index: number;
  onDecided: (r: Run) => void;
  onConflict: () => void;
}

const MAX_REASON = 2000;
const LONG_SUMMARY = 220;

type Action = "approve" | "deny" | "changes";

export function DecisionPanel({ runId, stage, index, onDecided, onConflict }: Props) {
  const [reason, setReason] = useState("");
  const [more, setMore] = useState(false);
  const [keyInput, setKeyInput] = useState("");
  const [busy, setBusy] = useState<Action | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<"key" | "deny" | "changes" | null>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const keyField = useRef<HTMLInputElement>(null);
  const hintId = useId();
  const errId = useId();
  const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

  const submit = async (action: Action) => {
    if (busy) return;
    const key = approverKey.get() ?? keyInput.trim();
    const trimmed = reason.trim();
    if (!key) {
      setFieldError("key");
      setError(null);
      keyField.current?.focus();
      return;
    }
    if (action !== "approve" && !trimmed) {
      setFieldError(action);
      setError(null);
      textarea.current?.focus();
      return;
    }
    setBusy(action);
    setError(null);
    setFieldError(null);
    try {
      const api = await getApi();
      const run =
        action === "changes" ? await api.rerun(runId, stage.key, trimmed, key) : await api.decide(runId, stage.key, action, trimmed || null, key);
      approverKey.remember(key);
      setKeyInput("");
      onDecided(run);
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) {
        approverKey.forget();
        setKeyInput("");
        setError("Approver key not recognized.");
      } else if (e instanceof ApiError) {
        setError(e.message);
        if (e.status === 409) onConflict();
      } else {
        setError(action === "changes" ? "The request was not sent. Check your connection and try again." : "The decision was not saved. Check your connection and try again.");
      }
    } finally {
      setBusy(null);
    }
  };

  const onKey = (e: KeyboardEvent<HTMLFormElement>) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void submit("approve");
    }
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void submit("approve");
  };

  const heading = (
    <h2 className={s.label} id="decision-heading">
      Decision <span className={`${s.stageRef} num`}>Stage {index + 1}</span>
    </h2>
  );

  if (stage.decision) {
    const d = stage.decision;
    const approved = d.decision === "approve";
    return (
      <section className={s.panel} aria-labelledby="decision-heading">
        {heading}
        <div className={s.record} data-decision={d.decision}>
          <span className={s.recordIcon} aria-hidden>
            {approved ? <CheckGlyph width={14} height={14} /> : <CrossGlyph width={13} height={13} />}
          </span>
          <div>
            <p className={s.recordLine}>
              {approved ? "Approved" : "Denied"} by <strong>{handle(d.by)}</strong>
            </p>
            <p className={`${s.recordTime} num`}>
              <time dateTime={d.at} title={absolute(d.at)}>
                {absolute(d.at)}
              </time>
            </p>
          </div>
        </div>
        {d.reason && (
          <blockquote className={s.reason}>
            <p>{d.reason}</p>
          </blockquote>
        )}
        {error && (
          <p className={s.error} role="alert">
            {error}
          </p>
        )}
      </section>
    );
  }

  if (stage.status !== "awaiting_approval") {
    const msg: Record<string, string> = {
      queued: `${stage.name} has not started. Its approval opens when the agent finishes.`,
      running: `${stage.name} is running. You can approve or deny its result when it finishes.`,
      failed: `${stage.name} failed, so there is nothing to approve. See the error in Activity.`,
      skipped: `${stage.name} was skipped because an earlier gate was denied.`,
      approved: `${stage.name} was approved.`,
      denied: `${stage.name} was denied.`,
    };
    return (
      <section className={s.panel} aria-labelledby="decision-heading">
        {heading}
        <p className={s.idle}>{msg[stage.status]}</p>
      </section>
    );
  }

  return (
    <section className={s.panel} aria-labelledby="decision-heading" data-actionable>
      {heading}
      <div className={s.waiting}>
        <LockGlyph width={14} height={14} className={s.lock} />
        <p>
          <strong>{stage.name}</strong> is waiting for approval.
        </p>
      </div>
      {stage.summary && (
        <div>
          <p className={`${s.summary} ${stage.summary.length > LONG_SUMMARY && !more ? s.clamp : ""}`}>{stage.summary}</p>
          {stage.summary.length > LONG_SUMMARY && (
            <button id="decision-summary-toggle" type="button" className={s.textBtn} aria-expanded={more} onClick={() => setMore((m) => !m)}>
              {more ? "Show less" : "Show all"}
            </button>
          )}
        </div>
      )}

      <form className={s.form} onSubmit={onSubmit} onKeyDown={onKey} noValidate>
        <ApproverKeyField
          id="approver-key"
          inputRef={keyField}
          value={keyInput}
          onChange={(v) => {
            setKeyInput(v);
            if (fieldError === "key" && v.trim()) setFieldError(null);
          }}
          invalid={fieldError === "key"}
          errorId={errId}
          disabled={busy !== null}
          hint="Only the Vibe2Prod team can act on stages."
        />
        <div className={s.field}>
          <label htmlFor="decision-reason" className={s.fieldLabel}>
            Note
            <span className={s.optional}>Required to deny or request changes</span>
          </label>
          <textarea
            ref={textarea}
            id="decision-reason"
            className={s.textarea}
            rows={3}
            maxLength={MAX_REASON}
            value={reason}
            onChange={(e) => {
              setReason(e.target.value);
              if ((fieldError === "deny" || fieldError === "changes") && e.target.value.trim()) setFieldError(null);
            }}
            placeholder="What should change?"
            aria-invalid={fieldError === "deny" || fieldError === "changes" || undefined}
            aria-describedby={`${hintId}${fieldError || error ? ` ${errId}` : ""}`}
            disabled={busy !== null}
          />
          <p id={hintId} className={s.hint}>
            Saved in the audit record. Request changes also sends it to the agent.
          </p>
        </div>
        {(fieldError || error) && (
          <p id={errId} className={s.error} role="alert">
            {fieldError === "key"
              ? "Enter your approver key."
              : fieldError === "deny"
                ? "Enter a note to deny this stage."
                : fieldError === "changes"
                  ? "Enter a note describing the changes."
                  : error}
          </p>
        )}
        <div className={s.actions}>
          <button id="decision-approve" type="submit" className={s.primary} disabled={busy !== null}>
            {busy === "approve" ? "Approving" : "Approve and continue"}
          </button>
          <button id="decision-changes" type="button" className={s.secondary} disabled={busy !== null} onClick={() => void submit("changes")}>
            {busy === "changes" ? "Sending" : "Request changes"}
          </button>
          <button id="decision-deny" type="button" className={s.danger} disabled={busy !== null} onClick={() => void submit("deny")}>
            {busy === "deny" ? "Denying" : "Deny"}
          </button>
        </div>
        <p className={s.kbd}>
          <kbd>{isMac ? "Cmd" : "Ctrl"}</kbd> <kbd>Enter</kbd> approves
        </p>
      </form>
    </section>
  );
}
