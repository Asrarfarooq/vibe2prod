import { useId, type Ref } from "react";
import { approverKey, useHasApproverKey } from "../lib/approverKey";
import s from "./ApproverKeyField.module.css";

interface Props {
  id: string;
  value: string;
  onChange: (v: string) => void;
  invalid: boolean;
  errorId?: string;
  disabled: boolean;
  inputRef?: Ref<HTMLInputElement>;
  hint: string;
}

export function ApproverKeyField({ id, value, onChange, invalid, errorId, disabled, inputRef, hint }: Props) {
  const hasKey = useHasApproverKey();
  const hintId = useId();
  if (hasKey) {
    return (
      <p className={s.held}>
        Approver key entered for this tab.
        <button
          id={`${id}-forget`}
          type="button"
          className={s.textBtn}
          onClick={() => {
            approverKey.forget();
            onChange("");
          }}
        >
          Forget key
        </button>
      </p>
    );
  }
  return (
    <div className={s.field}>
      <label htmlFor={id} className={s.label}>
        Approver key
      </label>
      <input
        ref={inputRef}
        id={id}
        className={s.input}
        type="password"
        autoComplete="off"
        spellCheck={false}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={invalid || undefined}
        aria-describedby={`${hintId}${invalid && errorId ? ` ${errorId}` : ""}`}
        disabled={disabled}
      />
      <p id={hintId} className={s.hint}>
        {hint}
      </p>
    </div>
  );
}
