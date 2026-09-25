import { useState } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Artifact, CostMeta, DocMeta, PrMeta, Stage, TerraformMeta } from "../api/types";
import { usd } from "../lib/format";
import { ExternalGlyph } from "./Icons";
import s from "./Artifacts.module.css";

function isSafeUrl(url: string | null): url is string {
  if (!url) return false;
  try {
    const u = new URL(url, window.location.origin);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

const KIND_LABEL: Record<Artifact["kind"], string> = {
  pr: "Pull request",
  doc: "Design doc",
  terraform: "Terraform",
  cost: "Cost estimate",
  report: "Report",
  link: "Link",
};

/** Compact list for the right rail; each row opens the full artifact in the stage view. */
export function ArtifactList({ stages, onOpen }: { stages: Stage[]; onOpen: (stage: Stage["key"]) => void }) {
  const rows = stages.flatMap((st, si) => st.artifacts.map((a, ai) => ({ a, st, si, ai })));
  if (rows.length === 0) return <p className={s.none}>Pull requests, design docs, Terraform and cost estimates appear here as stages finish.</p>;
  return (
    <ul className={s.list}>
      {rows.map(({ a, st, si, ai }) => (
        <li key={`${st.key}-${ai}`}>
          <button type="button" id={`rail-artifact-${st.key}-${ai}`} className={s.item} onClick={() => onOpen(st.key)}>
            <span className={s.itemKind}>
              {KIND_LABEL[a.kind]}
              <span className={`${s.itemStage} num`}>Stage {si + 1}</span>
            </span>
            <span className={s.itemTitle}>
              {a.kind === "pr" && <span className={`${s.prNum} num`}>#{num((a.meta as Partial<PrMeta>).number)}</span>}
              {a.title}
            </span>
            {a.kind === "pr" && <PrStats meta={a.meta as Partial<PrMeta>} />}
            {a.kind === "cost" && (
              <span className={`${s.itemMeta} num`}>{usd(num((a.meta as Partial<CostMeta>).monthly_total))} per month</span>
            )}
            {a.kind === "terraform" && (
              <span className={`${s.itemMeta} num`}>
                {((a.meta as Partial<TerraformMeta>).files ?? []).length} files
              </span>
            )}
          </button>
        </li>
      ))}
    </ul>
  );
}

function PrStats({ meta }: { meta: Partial<PrMeta> }) {
  const files = num(meta.changed_files);
  return (
    <span className={`${s.itemMeta} num`}>
      <span className={s.add}>+{num(meta.additions)}</span>
      <span className={s.del}>-{num(meta.deletions)}</span>
      <span>
        {files} {files === 1 ? "file" : "files"}
      </span>
    </span>
  );
}

export function ArtifactViewer({ artifact: a, id }: { artifact: Artifact; id: string }) {
  return (
    <article className={s.viewer} aria-labelledby={`${id}-title`}>
      <header className={s.viewerHead}>
        <div className={s.viewerTitleWrap}>
          <span className={s.viewerKind}>{KIND_LABEL[a.kind]}</span>
          <h3 id={`${id}-title`} className={s.viewerTitle}>
            {a.kind === "pr" && <span className={`${s.prNum} num`}>#{num((a.meta as Partial<PrMeta>).number)}</span>}
            {a.title}
          </h3>
        </div>
        {isSafeUrl(a.url) && (
          <a id={`${id}-open`} className={s.open} href={a.url} target="_blank" rel="noopener noreferrer">
            {a.kind === "pr" ? "Open on GitHub" : "Open"}
            <ExternalGlyph />
          </a>
        )}
      </header>
      {a.kind === "pr" && <PrBody meta={a.meta as Partial<PrMeta>} />}
      {a.kind === "doc" && <DocBody meta={a.meta as Partial<DocMeta>} />}
      {a.kind === "terraform" && <TerraformBody meta={a.meta as Partial<TerraformMeta>} id={id} />}
      {a.kind === "cost" && <CostBody meta={a.meta as Partial<CostMeta>} />}
    </article>
  );
}

function PrBody({ meta }: { meta: Partial<PrMeta> }) {
  return (
    <dl className={s.prFacts}>
      <div>
        <dt>Additions</dt>
        <dd className={`${s.add} num`}>+{num(meta.additions)}</dd>
      </div>
      <div>
        <dt>Deletions</dt>
        <dd className={`${s.del} num`}>-{num(meta.deletions)}</dd>
      </div>
      <div>
        <dt>Files changed</dt>
        <dd className="num">{num(meta.changed_files)}</dd>
      </div>
      <div>
        <dt>State</dt>
        <dd>{typeof meta.state === "string" ? meta.state.charAt(0).toUpperCase() + meta.state.slice(1) : "Unknown"}</dd>
      </div>
    </dl>
  );
}

const mdComponents: Components = {
  a: ({ href, children }) =>
    isSafeUrl(href ?? null) ? (
      <a href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    ) : (
      <span>{children}</span>
    ),
};

function DocBody({ meta }: { meta: Partial<DocMeta> }) {
  if (typeof meta.markdown !== "string" || !meta.markdown.trim()) return <p className={s.none}>The document is empty.</p>;
  return (
    <div className={s.doc}>
      <Markdown remarkPlugins={[remarkGfm]} components={mdComponents} disallowedElements={["img"]} unwrapDisallowed>
        {meta.markdown}
      </Markdown>
    </div>
  );
}

function TerraformBody({ meta, id }: { meta: Partial<TerraformMeta>; id: string }) {
  const files = Array.isArray(meta.files) ? meta.files : [];
  const [active, setActive] = useState(0);
  if (files.length === 0) return <p className={s.none}>No Terraform files.</p>;
  const f = files[Math.min(active, files.length - 1)];
  const lines = String(f.content ?? "").replace(/\n$/, "").split("\n");
  return (
    <div className={s.tf}>
      <ul className={s.tfFiles} aria-label="Terraform files">
        {files.map((file, i) => (
          <li key={file.path}>
            <button
              type="button"
              id={`${id}-file-${i}`}
              className={s.tfFile}
              aria-pressed={i === active}
              onClick={() => setActive(i)}
            >
              {file.path}
            </button>
          </li>
        ))}
      </ul>
      <pre className={s.code} aria-label={f.path}>
        <code>
          {lines.map((l, i) => (
            <span key={i} className={s.codeLine}>
              <span className={s.ln} aria-hidden>
                {i + 1}
              </span>
              {l || " "}
            </span>
          ))}
        </code>
      </pre>
    </div>
  );
}

function CostBody({ meta }: { meta: Partial<CostMeta> }) {
  const items = Array.isArray(meta.items) ? meta.items : [];
  const assumptions = Array.isArray(meta.assumptions) ? meta.assumptions : [];
  return (
    <div className={s.cost}>
      <table className={s.costTable}>
        <thead>
          <tr>
            <th scope="col">Resource</th>
            <th scope="col">SKU</th>
            <th scope="col" className={s.r}>
              Monthly
            </th>
          </tr>
        </thead>
        <tbody>
          {items.map((it, i) => (
            <tr key={i}>
              <td>{it.resource}</td>
              <td className={s.muted}>{it.sku}</td>
              <td className={`${s.r} num`}>{usd(num(it.monthly))}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row" colSpan={2}>
              Estimated total per month
            </th>
            <td className={`${s.r} ${s.total} num`}>{usd(num(meta.monthly_total))}</td>
          </tr>
        </tfoot>
      </table>
      {assumptions.length > 0 && (
        <div>
          <h4 className={s.h4}>Assumptions</h4>
          <ul className={s.assumptions}>
            {assumptions.map((a, i) => (
              <li key={i}>{a}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
