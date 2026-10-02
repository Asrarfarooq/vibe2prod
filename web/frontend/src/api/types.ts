export type StageKey = "codeguard" | "architect" | "iac" | "deploy";

export type RunStatus = "running" | "awaiting_approval" | "succeeded" | "failed" | "denied";

export type StageStatus =
  | "queued"
  | "running"
  | "awaiting_approval"
  | "approved"
  | "denied"
  | "failed"
  | "skipped";

export interface AppRef {
  repo: string;
  branch: string;
  commit: string | null;
  url?: string;
}

export interface Decision {
  decision: "approve" | "deny";
  by: string;
  at: string;
  reason: string | null;
}

export interface PrMeta {
  number: number;
  additions: number;
  deletions: number;
  changed_files: number;
  state: string;
}

export interface DocMeta {
  markdown: string;
}

export interface TerraformMeta {
  files: { path: string; content: string }[];
}

export interface CostMeta {
  currency: string;
  monthly_total: number;
  items: { resource: string; sku: string; monthly: number }[];
  assumptions: string[];
}

export type ArtifactKind = "pr" | "doc" | "terraform" | "cost" | "report" | "link";

export interface Artifact {
  kind: ArtifactKind;
  title: string;
  url: string | null;
  meta: Record<string, unknown>;
}

export interface Stage {
  key: StageKey;
  name: string;
  agent_description: string;
  status: StageStatus;
  started_at: string | null;
  ended_at: string | null;
  summary: string | null;
  decision: Decision | null;
  artifacts: Artifact[];
  attempt: number;
  feedback: Feedback | null;
}

export interface StageAttempt extends Stage {
  archived_at: string;
}

export interface Feedback {
  text: string;
  by: string;
  at: string;
}

export interface ScoreCategory {
  name: string;
  value: number;
  note: string | null;
}

export interface Score {
  total: number;
  categories: ScoreCategory[];
}

export interface ScorecardRow {
  category: string;
  before: string;
  after: string;
  delta: string;
  improved: boolean;
}

export interface Scorecard {
  rows: ScorecardRow[];
  agent_minutes: number | null;
  generated_at: string | null;
}

export interface Run {
  id: string;
  number: number;
  project_id: string;
  project: string;
  app: AppRef;
  status: RunStatus;
  current_stage: StageKey | null;
  created_at: string;
  updated_at: string;
  stages: Stage[];
  score: Score | null;
  scorecard?: Scorecard | null;
}

export interface RunSummary {
  id: string;
  number: number;
  project_id: string;
  app: Omit<AppRef, "url">;
  status: RunStatus;
  current_stage: StageKey | null;
  failed_stage: StageKey | null;
  created_at: string;
  score_total: number | null;
}

export interface ScorePoint {
  run_id: string;
  number: number;
  total: number;
  at: string;
}

export interface Project {
  id: string;
  name: string;
  repo: string;
  repo_url: string;
  branch: string;
  target_project: string;
  app_url: string | null;
  created_at: string;
  latest_run: RunSummary | null;
  score_history: ScorePoint[];
}

export type EventKind = "status" | "thought" | "tool_call" | "tool_result" | "output" | "error";

export interface RunEvent {
  seq: number;
  stage: StageKey;
  kind: EventKind;
  author: string;
  text: string;
  data: Record<string, unknown> | null;
  ts: string;
}

export interface StreamHandlers {
  onEvent: (e: RunEvent) => void;
  onRun: (r: Run) => void;
  onConnection: (state: "open" | "reconnecting") => void;
}

export interface Api {
  listProjects(): Promise<{ projects: Project[] }>;
  getProject(id: string): Promise<Project>;
  listProjectRuns(id: string): Promise<{ runs: RunSummary[] }>;
  startRun(projectId: string, approverKey: string): Promise<Run>;
  getRun(id: string): Promise<Run>;
  getEvents(id: string, after: number): Promise<{ events: RunEvent[] }>;
  getAttempts(id: string): Promise<{ attempts: StageAttempt[] }>;
  subscribe(id: string, handlers: StreamHandlers): () => void;
  decide(
    id: string,
    stage: StageKey,
    decision: "approve" | "deny",
    reason: string | null,
    approverKey: string,
  ): Promise<Run>;
  rerun(id: string, stage: StageKey, feedback: string, approverKey: string): Promise<Run>;
}
