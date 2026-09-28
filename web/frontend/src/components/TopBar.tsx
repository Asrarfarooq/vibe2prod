import { Fragment } from "react";
import { Link } from "./Link";
import { useTheme } from "../lib/theme";
import { approverKey, useHasApproverKey } from "../lib/approverKey";
import { SunMoonGlyph } from "./Icons";
import s from "./TopBar.module.css";

export interface Crumb {
  label: string;
  to: string;
}

export function TopBar({ crumbs = [] }: { crumbs?: Crumb[] }) {
  const [theme, toggle] = useTheme();
  const hasKey = useHasApproverKey();
  const dark = theme === "dark";
  return (
    <header className={s.bar}>
      <nav className={s.left} aria-label="Breadcrumb">
        <Link to="/" id="nav-home" className={s.brand} aria-current={crumbs.length === 0 ? "page" : undefined}>
          <svg viewBox="0 0 64 64" width="20" height="20" aria-hidden focusable={false} className={s.mark}>
            <path d="M20 20A12 12 0 1 1 43.24 24.19" fill="none" stroke="currentColor" strokeWidth="8" />
            <path d="M37.41 25.44L16 48L27.03 48L44.54 29.55z" fill="currentColor" />
            <path d="M16 52h16v8h-16z" fill="currentColor" />
            <path d="M36 52h12v8h-12z" fill="var(--accent)" />
          </svg>
          Vibe2Prod
        </Link>
        {crumbs.map((c, i) => (
          <Fragment key={c.to}>
            <span className={s.sep} aria-hidden>
              /
            </span>
            {i === crumbs.length - 1 ? (
              <span className={`${s.crumb} ${s.current}`} aria-current="page">
                {c.label}
              </span>
            ) : (
              <Link to={c.to} id={`nav-crumb-${i}`} className={s.crumb}>
                {c.label}
              </Link>
            )}
          </Fragment>
        ))}
      </nav>
      <div className={s.right}>
        {hasKey && (
          <button id="forget-key" type="button" className={s.textBtn} onClick={approverKey.forget} title="Approver key is kept in this tab until it closes">
            Forget approver key
          </button>
        )}
        <button
          id="theme-toggle"
          type="button"
          className={s.iconBtn}
          onClick={toggle}
          aria-label={dark ? "Switch to light theme" : "Switch to dark theme"}
          title={dark ? "Light theme" : "Dark theme"}
        >
          <SunMoonGlyph dark={dark} />
        </button>
      </div>
    </header>
  );
}
