// Development-only fixture API, loaded when VITE_MOCK=1.
import type { Api, Artifact, Project, Run, RunEvent, RunSummary, Stage, StageAttempt, StageKey, StreamHandlers } from "../api/types";
import { ApiError } from "../api/client";

const ME = "asrarfarooq@gcp.altostrat.com";
const PROJECT_ID = "vibed-app";
const REPO = "Asrarfarooq/vibed-app";
const REPO_URL = `https://github.com/${REPO}`;
const T0 = Date.now() - (12 * 60 + 41) * 1000;
const at = (sec: number, base = T0) => new Date(base + sec * 1000).toISOString();

const STAGE_META: Record<StageKey, { name: string; agent_description: string }> = {
  codeguard: {
    name: "CodeGuard",
    agent_description: "Finds security and correctness defects, fixes them and opens a pull request.",
  },
  architect: {
    name: "Architect + Critic",
    agent_description: "Drafts the production design doc; a critic agent reviews it until open risks are resolved.",
  },
  iac: {
    name: "IaC + Cost",
    agent_description: "Writes Terraform for the design and estimates the monthly cost.",
  },
  deploy: {
    name: "Deploy + Audit",
    agent_description: "Applies the Terraform, smoke-tests the service and scores production readiness.",
  },
};

function stage(key: StageKey, patch: Partial<Stage>): Stage {
  return {
    key,
    ...STAGE_META[key],
    status: "queued",
    started_at: null,
    ended_at: null,
    summary: null,
    decision: null,
    artifacts: [],
    attempt: 1,
    feedback: null,
    ...patch,
  };
}

const DESIGN_DOC = `# Vibed app: production design

## Context
The vibed app is an Express API with a Vite React client. Users photograph a receipt, Gemini extracts merchant, date, line items and total, and the result is stored per user. The AI Studio build runs as a single process with the Gemini key in client code and receipts in an in-memory array.

## Goals
- Serve UI and API from one Cloud Run service with no public keys in the bundle.
- Persist receipts per user in Firestore with owner-scoped rules.
- Keep p95 extraction latency under 4 s at 5 requests per second.

## Architecture
| Component | Choice | Notes |
|---|---|---|
| Runtime | Cloud Run, 1 vCPU, 512 MiB, min 0, max 5 | Express serves \`/api/*\` and the built client |
| Model | Gemini 3.8 Flash via Vertex AI | Called server-side with the service identity |
| Data | Firestore (Native), \`receipts/{uid}/items/{id}\` | Composite index on \`createdAt desc\` |
| Images | Cloud Storage, 30-day lifecycle | Signed upload URLs, 10 MB limit |
| Secrets | Secret Manager | Session signing key only |

## Security
- The Gemini key is removed; Vertex AI is called with the runtime service account.
- Uploads are checked by magic bytes and size before extraction.
- Request bodies are validated with zod; unknown fields are rejected.

## Reliability
- Extraction calls use a 10 s timeout and two retries with jittered backoff.
- Firestore writes are idempotent on a client-generated receipt id.

## Open risks
1. Cold starts add about 1.8 s to the first extraction; min instances stay at 0 to hold cost down.
2. No rate limit per user yet; the critic recommends 30 extractions per hour.
`;

const TF_MAIN = `resource "google_cloud_run_v2_service" "app" {
  name     = "app-run-8f2c1a"
  location = "us-central1"
  ingress  = "INGRESS_TRAFFIC_ALL"

  template {
    service_account = google_service_account.runtime.email
    scaling {
      min_instance_count = 0
      max_instance_count = 5
    }
    containers {
      image = var.image
      resources {
        limits = { cpu = "1", memory = "512Mi" }
      }
    }
  }
}
`;

const TF_DATA = `resource "google_firestore_database" "receipts" {
  name        = "receipts-8f2c1a"
  location_id = "nam5"
  type        = "FIRESTORE_NATIVE"
}

resource "google_storage_bucket" "images" {
  name                        = "receipt-images-8f2c1a"
  location                    = "US"
  uniform_bucket_level_access = true

  lifecycle_rule {
    condition { age = 30 }
    action { type = "Delete" }
  }
}
`;

const PR_ARTIFACT: Artifact = {
  kind: "pr",
  title: "Remove hardcoded Gemini API key and add input validation",
  url: "https://github.com/Asrarfarooq/vibed-app/pull/3",
  meta: { number: 3, additions: 214, deletions: 61, changed_files: 9, state: "open" },
};

const DOC_ARTIFACT: Artifact = {
  kind: "doc",
  title: "design/production.md",
  url: "https://github.com/Asrarfarooq/vibed-app/blob/v2p/run-8f2c1a/design/production.md",
  meta: { markdown: DESIGN_DOC },
};

const TF_ARTIFACT: Artifact = {
  kind: "terraform",
  title: "infra/",
  url: null,
  meta: {
    files: [
      { path: "infra/main.tf", content: TF_MAIN },
      { path: "infra/data.tf", content: TF_DATA },
      { path: "infra/variables.tf", content: 'variable "image" {\n  type = string\n}\n' },
    ],
  },
};

const COST_ARTIFACT: Artifact = {
  kind: "cost",
  title: "Monthly cost estimate",
  url: null,
  meta: {
    currency: "USD",
    monthly_total: 23.84,
    items: [
      { resource: "Cloud Run app-run-8f2c1a", sku: "vCPU-seconds, Tier 1", monthly: 9.12 },
      { resource: "Cloud Run app-run-8f2c1a", sku: "Memory GiB-seconds", monthly: 1.01 },
      { resource: "Vertex AI Gemini 3.8 Flash", sku: "Input + output tokens", monthly: 11.4 },
      { resource: "Firestore receipts-8f2c1a", sku: "Reads, writes, storage", monthly: 1.73 },
      { resource: "Cloud Storage receipt-images", sku: "Standard storage, US", monthly: 0.58 },
    ],
    assumptions: [
      "5,000 extractions per month at 2,400 input and 600 output tokens each",
      "Average 1.2 s request time, min instances 0",
      "4 GB of images retained at any time",
    ],
  },
};

function mainRun(): Run {
  return {
    id: "run_8f2c1a",
    number: 4,
    project_id: PROJECT_ID,
    project: "vibe2prod-509620",
    app: {
      repo: "Asrarfarooq/vibed-app",
      branch: "main",
      commit: "3fa9c1e7b2d04a18c6e5f0b9d8a7c6e5f4a3b2c1",
      url: "https://github.com/Asrarfarooq/vibed-app",
    },
    status: "running",
    current_stage: "architect",
    created_at: at(0),
    updated_at: at(520),
    score: null,
    stages: [
      stage("codeguard", {
        status: "approved",
        started_at: at(2),
        ended_at: at(194),
        summary:
          "Found 7 issues (2 critical). Removed the client-side Gemini key, moved extraction behind /api/extract, added zod validation on 4 routes and a 10 MB upload limit.",
        decision: { decision: "approve", by: ME, at: at(236), reason: null },
        artifacts: [PR_ARTIFACT],
      }),
      stage("architect", {
        status: "running",
        started_at: at(248),
        artifacts: [],
      }),
      stage("iac", {}),
      stage("deploy", {}),
    ],
  };
}

type Ev = Omit<RunEvent, "seq" | "ts"> & { t: number };

const CG = (t: number, kind: RunEvent["kind"], text: string, data: RunEvent["data"] = null, author = "codeguard"): Ev => ({
  t,
  stage: "codeguard",
  kind,
  author,
  text,
  data,
});
const AR = (t: number, kind: RunEvent["kind"], text: string, data: RunEvent["data"] = null, author = "architect"): Ev => ({
  t,
  stage: "architect",
  kind,
  author,
  text,
  data,
});

const SCRIPT: Ev[] = [
  CG(2, "status", "Stage started"),
  CG(3.4, "tool_call", "clone_repo", { args: { repo: "Asrarfarooq/vibed-app", ref: "3fa9c1e" } }),
  CG(6.1, "tool_result", "clone_repo", { result: { files: 48, bytes: 184213 } }),
  CG(7.8, "thought", "Scanning for secrets first. AI Studio exports usually call Gemini from the browser bundle."),
  CG(9.2, "tool_call", "gitleaks", { args: { command: "gitleaks detect --no-git --source . --report-format json" } }),
  CG(11.9, "tool_result", "gitleaks", { result: { findings: [{ rule: "gcp-api-key", file: "src/lib/gemini.ts", line: 4, secret: "AIza...redacted" }] } }),
  CG(12.4, "output", "Critical: Gemini API key hardcoded at src/lib/gemini.ts:4 and shipped in the client bundle."),
  CG(14.1, "tool_call", "osv-scanner", { args: { command: "osv-scanner --lockfile package-lock.json --format json" } }),
  CG(19.6, "tool_result", "osv-scanner", {
    result: {
      vulnerabilities: [
        { id: "CVE-2024-43796", package: "express", installed: "4.19.2", fixed: "4.20.0" },
        { id: "CVE-2024-45296", package: "path-to-regexp", installed: "0.1.7", fixed: "0.1.10" },
      ],
    },
  }),
  CG(20.3, "output", "High: express 4.19.2 is affected by CVE-2024-43796 and CVE-2024-45296 (via path-to-regexp 0.1.7). Upgrading express to 4.21.0."),
  CG(22.0, "tool_call", "read_file", { args: { path: "server/routes/receipts.ts" } }),
  CG(22.3, "tool_result", "read_file", { result: { lines: 142 } }),
  CG(27.7, "thought", "POST /api/receipts at server/routes/receipts.ts:58 writes req.body.total and req.body.items without validation. A string total breaks the monthly summary query."),
  CG(34.2, "output", "Critical: 4 routes write request bodies to storage without validation (server/routes/receipts.ts:58, 91, 117, 133)."),
  CG(48.9, "tool_call", "write_file", { args: { path: "server/lib/validate.ts", bytes: 2210 } }),
  CG(49.1, "tool_result", "write_file", { result: { ok: true } }),
  CG(63.0, "tool_call", "write_file", { args: { path: "server/routes/extract.ts", bytes: 3184 } }),
  CG(63.2, "tool_result", "write_file", { result: { ok: true } }),
  CG(77.5, "tool_call", "run_tests", { args: { command: "npm test" } }),
  CG(104.0, "tool_result", "run_tests", { result: { passed: 31, failed: 0, duration_s: 26.4 } }),
  CG(151.2, "tool_call", "open_pull_request", { args: { branch: "v2p/run-8f2c1a/codeguard", title: PR_ARTIFACT.title } }),
  CG(153.8, "tool_result", "open_pull_request", { result: { number: 3, url: PR_ARTIFACT.url } }),
  CG(194, "status", "Awaiting approval"),
  CG(236, "status", "Approved by asrarfarooq", null, "dashboard"),
  AR(248, "status", "Stage started"),
  AR(250.6, "tool_call", "read_pull_request", { args: { number: 3 } }),
  AR(252.0, "tool_result", "read_pull_request", { result: { files: 9, additions: 214, deletions: 61 } }),
  AR(258.3, "thought", "Single Express process serving both client and API; Cloud Run with one container fits. Firestore is already the AI Studio default."),
  AR(266.9, "tool_call", "read_file", { args: { path: "server/index.ts" } }),
  AR(267.2, "tool_result", "read_file", { result: { lines: 88 } }),
  AR(281.4, "tool_call", "list_quotas", { args: { project: "vibe2prod-509620", region: "us-central1", service: "run.googleapis.com" } }),
  AR(282.8, "tool_result", "list_quotas", { result: { max_instances_per_service: 100, cpu_per_region: 1000 } }),
  AR(305.5, "output", "Draft 1 written: 5 sections, 4 open risks."),
  AR(309.0, "thought", "Critic: retry policy for extraction is missing; a Vertex AI 429 surfaces as a 500 to the user.", null, "critic"),
  AR(312.7, "thought", "Critic: images are kept forever; add a lifecycle rule or justify retention.", null, "critic"),
  AR(318.1, "tool_call", "write_doc", { args: { path: "design/production.md", revision: 2 } }),
  AR(319.4, "tool_result", "write_doc", { result: { sections: 6, words: 412 } }),
  AR(331.0, "thought", "Critic: per-user rate limit still absent; acceptable for a pilot if documented as an open risk.", null, "critic"),
  AR(344.2, "tool_call", "estimate_latency", { args: { model: "gemini-3.8-flash", input_tokens: 2400, output_tokens: 600 } }),
  AR(346.9, "tool_result", "estimate_latency", { result: { p50_ms: 1620, p95_ms: 3380 } }),
  AR(360.8, "output", "Revision 2 addresses 2 of 4 critic findings; 2 remain as documented open risks."),
  AR(392.4, "tool_call", "commit_file", { args: { branch: "v2p/run-8f2c1a/architect", path: "design/production.md" } }),
  AR(394.1, "tool_result", "commit_file", { result: { sha: "b41e09c" } }),
  AR(520.0, "output", "Design doc ready for review: 6 sections, 2 open risks."),
  AR(528.5, "status", "Awaiting approval"),
];

const LIVE_TAIL = 6;

function materialize(list: Ev[], base = T0, startSeq = 1): RunEvent[] {
  return list.map((e, i) => {
    const { t, ...rest } = e;
    return { ...rest, seq: startSeq + i, ts: at(t, base) };
  });
}

const ev =
  (stage: StageKey, author: string) =>
  (t: number, kind: RunEvent["kind"], text: string, data: RunEvent["data"] = null, by = author): Ev => ({ t, stage, kind, author: by, text, data });

const AR1 = ev("architect", "architect");
const DP = ev("deploy", "deploy");

function run1(): Run {
  const b = Date.now() - 3 * 24 * 3600 * 1000;
  const a = (s: number) => new Date(b + s * 1000).toISOString();
  return {
    id: "run_5b3a90",
    number: 1,
    project_id: PROJECT_ID,
    project: "vibe2prod-509620",
    app: { repo: REPO, branch: "main", commit: "5e21b0c4a9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4", url: REPO_URL },
    status: "denied",
    current_stage: null,
    created_at: a(0),
    updated_at: a(760),
    score: null,
    stages: [
      stage("codeguard", {
        status: "approved",
        started_at: a(2),
        ended_at: a(210),
        summary: "Fixed 4 issues, 2 critical.",
        decision: { decision: "approve", by: "prati@gcp.altostrat.com", at: a(260), reason: null },
        artifacts: [{ ...PR_ARTIFACT, title: "Remove client-side Gemini key", url: `${REPO_URL}/pull/1`, meta: { number: 1, additions: 162, deletions: 48, changed_files: 7, state: "closed" } }],
      }),
      stage("architect", {
        status: "denied",
        started_at: a(270),
        ended_at: a(610),
        summary: "Design doc: 5 sections, 4 open risks.",
        decision: {
          decision: "deny",
          by: ME,
          at: a(760),
          reason: "Images are kept forever and a Vertex AI 429 still surfaces as a 500. Add a lifecycle rule and a retry policy, then run again.",
        },
      }),
      stage("iac", { status: "skipped" }),
      stage("deploy", { status: "skipped" }),
    ],
  };
}

const run1Events: Ev[] = [
  AR1(270, "status", "Stage started"),
  AR1(272.5, "tool_call", "read_pull_request", { args: { number: 1 } }),
  AR1(273.9, "tool_result", "read_pull_request", { result: { files: 7, additions: 162, deletions: 48 } }),
  AR1(281.0, "thought", "Express API and Vite client in one process; Cloud Run fits. Receipts live in memory today; Firestore for persistence."),
  AR1(330.2, "output", "Draft 1 written: 5 sections, 4 open risks."),
  AR1(334.0, "thought", "Critic: no retry policy for extraction; a Vertex AI 429 surfaces as a 500 to the user.", null, "critic"),
  AR1(338.4, "thought", "Critic: receipt images are kept forever; add a lifecycle rule or justify retention.", null, "critic"),
  AR1(402.7, "output", "Critic round limit reached; 4 open risks remain."),
  AR1(610, "status", "Awaiting approval"),
  AR1(760, "status", "Denied by asrarfarooq", null, "dashboard"),
];

function run2(): Run {
  const b = Date.now() - 26 * 3600 * 1000;
  const a = (s: number) => new Date(b + s * 1000).toISOString();
  const dec = (s: number) => ({ decision: "approve" as const, by: "lkolluru@gcp.altostrat.com", at: a(s), reason: null });
  return {
    id: "run_71d0e4",
    number: 2,
    project_id: PROJECT_ID,
    project: "vibe2prod-509620",
    app: { repo: REPO, branch: "main", commit: "a07c3d91e2f84b56a1c0d9e8f7b6a5c4d3e2f1a0", url: REPO_URL },
    status: "succeeded",
    current_stage: null,
    created_at: a(0),
    updated_at: a(1830),
    stages: [
      stage("codeguard", {
        status: "approved",
        started_at: a(2),
        ended_at: a(170),
        summary: "Fixed 5 issues, 2 critical.",
        decision: dec(240),
        artifacts: [{ ...PR_ARTIFACT, title: "Move Gemini calls server-side and validate receipt payloads", url: `${REPO_URL}/pull/2`, meta: { number: 2, additions: 188, deletions: 52, changed_files: 8, state: "open" } }],
      }),
      stage("architect", { status: "approved", started_at: a(250), ended_at: a(560), summary: "Design doc: 6 sections, 3 open risks.", decision: dec(700), artifacts: [DOC_ARTIFACT] }),
      stage("iac", { status: "approved", started_at: a(710), ended_at: a(1010), summary: "11 resources, estimated $23.84 per month.", decision: dec(1120), artifacts: [TF_ARTIFACT, COST_ARTIFACT] }),
      stage("deploy", {
        status: "approved",
        started_at: a(1130),
        ended_at: a(1830),
        summary: "Deployed app-run-71d0e4; 10 of 12 smoke checks passed.",
        artifacts: [
          { kind: "link", title: "app-run-71d0e4 service URL", url: "https://app-run-71d0e4-956008489215.us-central1.run.app", meta: {} },
          { kind: "report", title: "Readiness audit", url: null, meta: {} },
        ],
      }),
    ],
    score: {
      total: 71,
      categories: [
        { name: "Security", value: 84, note: "Key moved server-side; runtime service account still has roles/datastore.owner." },
        { name: "Reliability", value: 58, note: "No retry on Vertex AI 429s; no per-user rate limit." },
        { name: "Cost", value: 82, note: "Scales to zero; no budget alert." },
        { name: "Observability", value: 55, note: "Default request logs only; no uptime check or alerting." },
        { name: "Deploy health", value: 76, note: "10 of 12 smoke checks passed; uploads over 5 MB return 413." },
      ],
    },
    scorecard: {
      rows: [
        { category: "Security findings", before: "14", after: "2", delta: "-12 (-86%)", improved: true },
        { category: "Hardcoded secret findings", before: "3", after: "0; 2 in Secret Manager", delta: "-3 (-100%)", improved: true },
        { category: "Dependency vulnerabilities", before: "2", after: "0", delta: "-2 (-100%)", improved: true },
        { category: "Container", before: "node:20, runs as root", after: "node:24-slim, runs as non-root user node", delta: "Non-root", improved: true },
        { category: "Cloud architecture", before: "No cloud resources defined", after: "Cloud Run, Firestore, Secret Manager, Cloud Storage", delta: "+4 services", improved: true },
        { category: "Infrastructure as code", before: "None", after: "11 Terraform resources, remote state in GCS", delta: "+11 resources", improved: true },
        { category: "Monthly cost", before: "Not estimated", after: "$23.84/month estimated", delta: "Estimated", improved: true },
        { category: "Readiness score", before: "Not scored", after: "71/100 (10/12 checks passed)", delta: "First audit", improved: true },
      ],
      agent_minutes: 23,
      generated_at: a(1830),
    },
  };
}

const run2DeployEvents: Ev[] = [
  DP(1130, "status", "Stage started"),
  DP(1133.2, "tool_call", "terraform", { args: { command: "terraform apply plan.out" } }),
  DP(1291.8, "tool_result", "terraform", { result: { added: 11, changed: 0, destroyed: 0 } }),
  DP(1296.0, "tool_call", "cloud_build", { args: { image: "us-central1-docker.pkg.dev/vibe2prod-509620/apps/vibed-app:a07c3d9" } }),
  DP(1508.4, "tool_result", "cloud_build", { result: { status: "SUCCESS", duration_s: 212 } }),
  DP(1512.1, "tool_call", "deploy_cloud_run", { args: { service: "app-run-71d0e4", region: "us-central1" } }),
  DP(1561.7, "tool_result", "deploy_cloud_run", { result: { revision: "app-run-71d0e4-00001-kqz", ready: true } }),
  DP(1570.3, "tool_call", "smoke_test", { args: { checks: 12 } }),
  DP(1644.9, "tool_result", "smoke_test", { result: { passed: 10, failed: 2 } }),
  DP(1702.5, "thought", "No uptime check or alerting policy on the service; observability capped at 55."),
  DP(1826.0, "output", "Readiness 71 of 100. Security 84, reliability 58, cost 82, observability 55, deploy health 76."),
  DP(1830, "status", "Stage finished"),
];

const IC = ev("iac", "iac");

function run3(): Run {
  const b = Date.now() - 5 * 3600 * 1000;
  const a = (s: number) => new Date(b + s * 1000).toISOString();
  const dec = (s: number) => ({ decision: "approve" as const, by: ME, at: a(s), reason: null });
  return {
    id: "run_c4e7b2",
    number: 3,
    project_id: PROJECT_ID,
    project: "vibe2prod-509620",
    app: { repo: REPO, branch: "main", commit: "c4e7b21f0a9d8c7b6a5f4e3d2c1b0a9f8e7d6c5b", url: REPO_URL },
    status: "failed",
    current_stage: null,
    created_at: a(0),
    updated_at: a(2140),
    score: null,
    stages: [
      stage("codeguard", { status: "approved", started_at: a(2), ended_at: a(180), summary: "Fixed 6 issues, 2 critical.", decision: dec(230), artifacts: [PR_ARTIFACT] }),
      stage("architect", { status: "approved", started_at: a(240), ended_at: a(560), summary: "Design doc: 6 sections, 2 open risks.", decision: dec(640), artifacts: [DOC_ARTIFACT] }),
      stage("iac", {
        status: "approved",
        started_at: a(1180),
        ended_at: a(1420),
        summary: "12 resources, estimated $24.41 per month. Added the lifecycle rule and budget alert from feedback.",
        decision: dec(1500),
        artifacts: [TF_ARTIFACT, COST_ARTIFACT],
        attempt: 2,
        feedback: { text: "Add a 30-day lifecycle rule on the images bucket and a $50 budget alert before we deploy.", by: ME, at: a(1175) },
      }),
      stage("deploy", {
        status: "failed",
        started_at: a(1510),
        ended_at: a(2140),
        summary: "terraform apply failed: google_firestore_database.receipts already exists in project vibe2prod-509620 (409).",
      }),
    ],
  };
}

const run3Events: Ev[] = [
  IC(1175, "status", `Rerun requested by ${ME}: Add a 30-day lifecycle rule on the images bucket and a $50 budget alert before we deploy.`, null, "dashboard"),
  IC(1180, "status", "Stage started"),
  IC(1184.2, "thought", "Feedback asks for a bucket lifecycle rule and a budget alert. Adding google_billing_budget and a lifecycle_rule on the images bucket."),
  IC(1236.5, "tool_call", "write_file", { args: { path: "infra/data.tf", bytes: 1840 } }),
  IC(1236.8, "tool_result", "write_file", { result: { ok: true } }),
  IC(1310.1, "tool_call", "terraform", { args: { command: "terraform plan -out plan.out" } }),
  IC(1388.7, "tool_result", "terraform", { result: { add: 12, change: 0, destroy: 0 } }),
  IC(1420, "output", "12 resources, estimated $24.41 per month."),
  DP(1510, "status", "Stage started"),
  DP(1514.0, "tool_call", "terraform", { args: { command: "terraform apply plan.out" } }),
  DP(2131.6, "tool_result", "terraform", { result: { added: 7, failed: 1 } }),
  DP(2140, "error", "terraform apply failed: google_firestore_database.receipts already exists in project vibe2prod-509620 (409). Import it or rename the database."),
];

interface Store {
  run: Run;
  events: RunEvent[];
  pending: RunEvent[];
  listeners: Set<StreamHandlers>;
  attempts?: StageAttempt[];
}

const stores = new Map<string, Store>();

function init() {
  if (stores.size) return;
  const all = materialize(SCRIPT);
  stores.set("run_8f2c1a", {
    run: mainRun(),
    events: all.slice(0, all.length - LIVE_TAIL),
    pending: all.slice(all.length - LIVE_TAIL),
    listeners: new Set(),
  });
  const b2 = Date.now() - 26 * 3600 * 1000;
  const cg2 = materialize(SCRIPT.slice(0, 19), b2);
  stores.set("run_71d0e4", { run: run2(), events: [...cg2, ...materialize(run2DeployEvents, b2, cg2.length + 1)], pending: [], listeners: new Set() });
  stores.set("run_5b3a90", { run: run1(), events: materialize(run1Events, Date.now() - 3 * 24 * 3600 * 1000), pending: [], listeners: new Set() });
  stores.set("run_c4e7b2", { run: run3(), events: materialize(run3Events, Date.now() - 5 * 3600 * 1000), pending: [], listeners: new Set() });
  startTail();
}

type ProjectBase = Omit<Project, "latest_run" | "score_history">;

const PROJECTS: ProjectBase[] = [
  {
    id: PROJECT_ID,
    name: "vibed-app",
    repo: REPO,
    repo_url: REPO_URL,
    branch: "main",
    target_project: "vibe2prod-509620",
    app_url: null,
    created_at: new Date(Date.now() - 4 * 24 * 3600 * 1000).toISOString(),
  },
];

function projectRuns(pid: string): Run[] {
  return [...stores.values()].map((s) => s.run).filter((r) => r.project_id === pid);
}

function toProject(p: ProjectBase): Project {
  const runs = projectRuns(p.id).sort((a, b) => a.created_at.localeCompare(b.created_at));
  const latest = runs.at(-1);
  return {
    ...p,
    latest_run: latest ? summarize(latest) : null,
    score_history: runs.flatMap((r) => (r.score ? [{ run_id: r.id, number: r.number, total: r.score.total, at: r.updated_at }] : [])),
  };
}

function findProject(id: string): ProjectBase {
  init();
  const p = PROJECTS.find((x) => x.id === id);
  if (!p) throw new ApiError(404, "Project not found");
  return p;
}

function startCodeGuard(s: Store) {
  const now = () => new Date().toISOString();
  const r = s.run;
  push(s, { stage: "codeguard", kind: "status", author: "codeguard", text: "Stage started", data: null, ts: now() });
  setTimeout(() => {
    push(s, { stage: "codeguard", kind: "tool_call", author: "codeguard", text: "clone_repo", data: { args: { repo: r.app.repo, ref: r.app.branch } }, ts: now() });
  }, 1200);
  setTimeout(() => {
    r.app.commit = "9d41e0b7c2a85f36e1d0c9b8a7f6e5d4c3b2a190";
    push(s, { stage: "codeguard", kind: "tool_result", author: "codeguard", text: "clone_repo", data: { result: { files: 51, commit: "9d41e0b" } }, ts: now() });
    emitRun(s);
  }, 2600);
  setTimeout(() => {
    push(s, { stage: "codeguard", kind: "thought", author: "codeguard", text: "Scanning for secrets first, then dependencies.", data: null, ts: now() });
  }, 3800);
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const clone = <T,>(v: T): T => structuredClone(v);

function emitRun(s: Store) {
  s.run.updated_at = new Date().toISOString();
  s.listeners.forEach((l) => l.onRun(clone(s.run)));
}

function push(s: Store, e: Omit<RunEvent, "seq">) {
  const ev = { ...e, seq: (s.events.at(-1)?.seq ?? 0) + 1 };
  s.events.push(ev);
  s.listeners.forEach((l) => l.onEvent(ev));
}

let tailStarted = false;
function startTail() {
  if (tailStarted) return;
  tailStarted = true;
  const s = stores.get("run_8f2c1a")!;
  s.pending.forEach((e, i) => {
    setTimeout(() => {
      s.events.push(e);
      s.listeners.forEach((l) => l.onEvent(e));
      if (i === s.pending.length - 1) {
        const ar = s.run.stages[1];
        ar.status = "awaiting_approval";
        ar.ended_at = e.ts;
        ar.summary =
          "Design doc revision 2: Cloud Run + Firestore + Vertex AI, 6 sections. The critic raised 4 findings; 2 are resolved and 2 remain as open risks (cold starts, no per-user rate limit).";
        ar.artifacts = [DOC_ARTIFACT];
        s.run.status = "awaiting_approval";
        emitRun(s);
      }
    }, 900 + i * 700);
  });
}

function summarize(r: Run): RunSummary {
  return {
    id: r.id,
    number: r.number,
    project_id: r.project_id,
    app: { repo: r.app.repo, branch: r.app.branch, commit: r.app.commit },
    status: r.status,
    current_stage: r.current_stage,
    failed_stage: r.stages.find((st) => st.status === "failed")?.key ?? null,
    created_at: r.created_at,
    score_total: r.score?.total ?? null,
  };
}

function get(id: string): Store {
  init();
  const s = stores.get(id);
  if (!s) throw new ApiError(404, "Run not found");
  return s;
}

export const mockApi: Api = {
  async listProjects() {
    init();
    await delay(250);
    return { projects: clone(PROJECTS.map(toProject)) };
  },
  async getProject(id) {
    await delay(200);
    return clone(toProject(findProject(id)));
  },
  async listProjectRuns(id) {
    const p = findProject(id);
    await delay(250);
    return { runs: clone(projectRuns(p.id).map(summarize)) };
  },
  async startRun(projectId, approverKey) {
    await delay(500);
    if (!approverKey || approverKey === "invalid") throw new ApiError(403, "Unknown approver key");
    const p = findProject(projectId);
    const runs = projectRuns(p.id);
    if (runs.some((r) => r.status === "running" || r.status === "awaiting_approval")) throw new ApiError(409, "A run is already in progress");
    const now = new Date().toISOString();
    const run: Run = {
      id: `run_${Math.random().toString(16).slice(2, 8)}`,
      number: Math.max(0, ...runs.map((r) => r.number)) + 1,
      project_id: p.id,
      project: p.target_project,
      app: { repo: p.repo, branch: p.branch, commit: null, url: p.repo_url },
      status: "running",
      current_stage: "codeguard",
      created_at: now,
      updated_at: now,
      score: null,
      stages: [stage("codeguard", { status: "running", started_at: now }), stage("architect", {}), stage("iac", {}), stage("deploy", {})],
    };
    const s: Store = { run, events: [], pending: [], listeners: new Set() };
    stores.set(run.id, s);
    startCodeGuard(s);
    return clone(run);
  },
  async getRun(id) {
    await delay(300);
    return clone(get(id).run);
  },
  async getEvents(id, after) {
    await delay(200);
    return { events: get(id).events.filter((e) => e.seq > after).map(clone) };
  },
  async getAttempts(id) {
    await delay(150);
    return { attempts: (get(id).attempts ?? []).map(clone) };
  },
  subscribe(id, h) {
    const s = get(id);
    s.listeners.add(h);
    setTimeout(() => h.onConnection("open"), 50);
    return () => s.listeners.delete(h);
  },
  async decide(id, key, decision, reason, approverKey) {
    await delay(400);
    if (!approverKey || approverKey === "invalid") throw new ApiError(403, "Unknown approver key");
    const s = get(id);
    const idx = s.run.stages.findIndex((x) => x.key === key);
    const st = s.run.stages[idx];
    if (!st) throw new ApiError(400, "Unknown stage");
    if (st.decision) throw new ApiError(409, `Already decided by ${st.decision.by} at ${st.decision.at}`);
    if (st.status !== "awaiting_approval") throw new ApiError(400, "Stage is not awaiting approval");
    if (decision === "deny" && !reason?.trim()) throw new ApiError(400, "A reason is required to deny");
    const now = new Date().toISOString();
    st.decision = { decision, by: ME, at: now, reason: reason?.trim() || null };
    push(s, { stage: key, kind: "status", author: "dashboard", text: `${decision === "approve" ? "Approved" : "Denied"} by ${ME.split("@")[0]}`, data: null, ts: now });
    if (decision === "approve") {
      st.status = "approved";
      const next = s.run.stages[idx + 1];
      if (next) {
        next.status = "running";
        next.started_at = now;
        s.run.status = "running";
        s.run.current_stage = next.key;
        setTimeout(() => {
          push(s, { stage: next.key, kind: "status", author: next.key, text: "Stage started", data: null, ts: new Date().toISOString() });
          emitRun(s);
        }, 600);
        setTimeout(() => {
          push(s, { stage: next.key, kind: "thought", author: next.key, text: "Reading design/production.md to derive the resource list.", data: null, ts: new Date().toISOString() });
        }, 1600);
      } else {
        s.run.status = "succeeded";
        s.run.current_stage = null;
      }
    } else {
      st.status = "denied";
      s.run.stages.slice(idx + 1).forEach((x) => (x.status = "skipped"));
      s.run.status = "denied";
      s.run.current_stage = null;
    }
    emitRun(s);
    return clone(s.run);
  },
  async rerun(id, key, feedback, approverKey) {
    await delay(400);
    if (!approverKey || approverKey === "invalid") throw new ApiError(403, "Unknown approver key");
    const text = feedback.trim();
    if (!text) throw new ApiError(400, "Feedback is required");
    const s = get(id);
    const idx = s.run.stages.findIndex((x) => x.key === key);
    const st = s.run.stages[idx];
    if (!st) throw new ApiError(400, "Unknown stage");
    if (s.run.status === "running") throw new ApiError(409, "A stage is still running; wait for it to finish");
    if (!["awaiting_approval", "approved", "denied", "failed"].includes(st.status)) throw new ApiError(409, "This stage has not run yet");
    const now = new Date().toISOString();
    s.attempts = [
      ...(s.attempts ?? []),
      ...s.run.stages.slice(idx).filter((x) => x.status !== "queued").map((x) => ({ ...clone(x), archived_at: now })),
    ];
    s.run.stages[idx] = stage(key, { status: "running", started_at: now, attempt: st.attempt + 1, feedback: { text, by: ME, at: now } });
    for (let i = idx + 1; i < s.run.stages.length; i++) s.run.stages[i] = stage(s.run.stages[i].key, {});
    s.run.status = "running";
    s.run.current_stage = key;
    s.run.score = null;
    push(s, { stage: key, kind: "status", author: "dashboard", text: `Rerun requested by ${ME}: ${text}`, data: null, ts: now });
    setTimeout(() => {
      push(s, { stage: key, kind: "status", author: key, text: "Stage started", data: null, ts: new Date().toISOString() });
      emitRun(s);
    }, 600);
    setTimeout(() => {
      push(s, { stage: key, kind: "thought", author: key, text: `Reading the reviewer feedback first: ${text}`, data: null, ts: new Date().toISOString() });
    }, 1600);
    emitRun(s);
    return clone(s.run);
  },
};
