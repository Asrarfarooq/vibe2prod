import { useState } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Artifact, CostMeta, DocMeta, PrMeta, Stage, TerraformMeta } from "../api/types";
import { usd } from "../lib/format";
import { CheckGlyph, CrossGlyph, ExternalGlyph } from "./Icons";
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
  const kind = KIND_LABEL[a.kind];
  return (
    <article className={s.viewer} aria-labelledby={`${id}-title`}>
      <header className={s.viewerHead}>
        <div className={s.viewerTitleWrap}>
          {kind.toLowerCase() !== a.title.trim().toLowerCase() && <span className={s.viewerKind}>{kind}</span>}
          <h3 id={`${id}-title`} className={s.viewerTitle}>
            {a.kind === "pr" && <span className={`${s.prNum} num`}>#{num((a.meta as Partial<PrMeta>).number)}</span>}
            {a.title}
          </h3>
          {a.kind === "link" && isSafeUrl(a.url) && <span className={`${s.linkUrl} mono`}>{a.url}</span>}
        </div>
        {isSafeUrl(a.url) && (
          <a id={`${id}-open`} className={s.open} href={a.url} target="_blank" rel="noopener noreferrer">
            {a.kind === "pr" ? "Open on GitHub" : "Open"}
            <ExternalGlyph />
          </a>
        )}
      </header>
      {a.kind === "pr" && <PrBody meta={a.meta as Partial<PrMeta>} />}
      {(a.kind === "doc" || a.kind === "report") && <DocBody meta={a.meta as Partial<DocMeta>} />}
      {a.kind === "report" && <ChecksBody checks={(a.meta as { checks?: unknown }).checks} />}
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
  table: ({ children }) => (
    <div className={s.tableWrap}>
      <table>{children}</table>
    </div>
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

interface Check {
  category: string;
  name: string;
  passed: boolean;
  detail: string;
}

function ChecksBody({ checks }: { checks: unknown }) {
  const list = Array.isArray(checks) ? (checks as Partial<Check>[]).filter((c) => typeof c?.name === "string") : [];
  if (list.length === 0) return null;
  const passed = list.filter((c) => c.passed).length;
  return (
    <div className={s.checks}>
      <h4 className={s.h4}>
        Checks <span className="num">{passed} of {list.length} passed</span>
      </h4>
      <table className={s.checkTable}>
        <thead>
          <tr>
            <th scope="col">Check</th>
            <th scope="col">Category</th>
            <th scope="col">Detail</th>
          </tr>
        </thead>
        <tbody>
          {list.map((c, i) => (
            <tr key={i} data-passed={c.passed ? "true" : "false"}>
              <td>
                <span className={s.checkName}>
                  {c.passed ? <CheckGlyph className={s.pass} width={13} height={13} /> : <CrossGlyph className={s.fail} width={12} height={12} />}
                  {c.name}
                </span>
              </td>
              <td className={s.muted}>{c.category}</td>
              <td className={s.checkDetail}>{c.detail}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function commonDir(paths: string[]): string {
  const dirs = paths.map((p) => p.split("/").slice(0, -1));
  const first = dirs[0] ?? [];
  let n = 0;
  while (n < first.length && dirs.every((d) => d[n] === first[n])) n++;
  return n ? first.slice(0, n).join("/") + "/" : "";
}

function TerraformBody({ meta, id }: { meta: Partial<TerraformMeta>; id: string }) {
  const base = (p: string) => p.slice(p.lastIndexOf("/") + 1);
  const files = [...(Array.isArray(meta.files) ? meta.files : [])].sort((a, b) => Number(base(a.path).startsWith(".")) - Number(base(b.path).startsWith(".")));
  const [active, setActive] = useState(() => Math.max(0, files.findIndex((x) => base(x.path) === "main.tf")));
  if (files.length === 0) return <p className={s.none}>No Terraform files.</p>;
  const f = files[Math.min(active, files.length - 1)];
  const dir = commonDir(files.map((x) => String(x.path)));
  const lines = String(f.content ?? "").replace(/\n$/, "").split("\n");
  return (
    <div className={s.tf}>
      <div className={s.tfSide}>
        {dir && <p className={`${s.tfDir} mono`}>{dir}</p>}
        <ul className={s.tfFiles} aria-label="Terraform files">
          {files.map((file, i) => (
            <li key={file.path}>
              <button
                type="button"
                id={`${id}-file-${i}`}
                className={s.tfFile}
                aria-pressed={i === active}
                title={file.path}
                onClick={() => setActive(i)}
              >
                {file.path.slice(dir.length)}
              </button>
            </li>
          ))}
        </ul>
      </div>
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

const SKU_ID = /^([0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4})\s+(.*)$/;

function CostBody({ meta }: { meta: Partial<CostMeta> }) {
  const items = Array.isArray(meta.items) ? meta.items : [];
  const assumptions = Array.isArray(meta.assumptions) ? meta.assumptions : [];
  return (
    <div className={s.cost}>
      <div className={s.tableWrap}>
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
            {items.map((it, i) => {
              const m = SKU_ID.exec(String(it.sku ?? ""));
              return (
                <tr key={i}>
                  <td className={`${s.resource} mono`}>{it.resource}</td>
                  <td>
                    {m ? (
                      <>
                        {m[2]}
                        <span className={`${s.skuId} mono`}>{m[1]}</span>
                      </>
                    ) : (
                      it.sku
                    )}
                  </td>
                  <td className={`${s.r} num`}>{usd(num(it.monthly))}</td>
                </tr>
              );
            })}
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
      </div>
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
