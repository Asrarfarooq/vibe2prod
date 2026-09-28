import type { Api, Run, RunEvent, StageKey, StreamHandlers } from "./types";

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: "same-origin",
    cache: "no-store",
    ...init,
    headers: { Accept: "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    let detail = `Request failed with status ${res.status}`;
    try {
      const body = (await res.json()) as { detail?: unknown };
      if (typeof body.detail === "string") detail = body.detail;
    } catch {
      // Non-JSON error body; keep the generic message.
    }
    throw new ApiError(res.status, detail);
  }
  return (await res.json()) as T;
}

const enc = encodeURIComponent;

const writeHeaders = (approverKey: string) => ({
  "Content-Type": "application/json",
  "X-Requested-With": "vibe2prod",
  "X-Approver-Key": approverKey,
});

const httpApi: Api = {
  listProjects: () => request("/api/projects"),
  getProject: (id) => request(`/api/projects/${enc(id)}`),
  listProjectRuns: (id) => request(`/api/projects/${enc(id)}/runs`),
  startRun: (projectId, approverKey) =>
    request<Run>(`/api/projects/${enc(projectId)}/runs`, {
      method: "POST",
      headers: writeHeaders(approverKey),
      body: "{}",
    }),
  getRun: (id) => request(`/api/runs/${enc(id)}`),
  getEvents: (id, after) => request(`/api/runs/${enc(id)}/events?after=${after}`),
  decide: (id: string, stage: StageKey, decision, reason, approverKey) =>
    request<Run>(`/api/runs/${enc(id)}/stages/${enc(stage)}/decision`, {
      method: "POST",
      headers: writeHeaders(approverKey),
      body: JSON.stringify({ decision, reason }),
    }),
  rerun: (id, stage, feedback, approverKey) =>
    request<Run>(`/api/runs/${enc(id)}/stages/${enc(stage)}/rerun`, {
      method: "POST",
      headers: writeHeaders(approverKey),
      body: JSON.stringify({ feedback }),
    }),
  subscribe(id: string, h: StreamHandlers) {
    const es = new EventSource(`/api/runs/${enc(id)}/stream`);
    es.onopen = () => h.onConnection("open");
    es.onerror = () => h.onConnection("reconnecting");
    es.addEventListener("event", (m) => {
      try {
        h.onEvent(JSON.parse((m as MessageEvent<string>).data) as RunEvent);
      } catch {
        // Malformed frame; the next backfill covers any gap.
      }
    });
    es.addEventListener("run", (m) => {
      try {
        h.onRun(JSON.parse((m as MessageEvent<string>).data) as Run);
      } catch {
        // Ignore malformed run snapshot.
      }
    });
    return () => es.close();
  },
};

let current: Promise<Api> | null = null;

export function getApi(): Promise<Api> {
  if (!current) {
    current =
      import.meta.env.DEV && import.meta.env.VITE_MOCK === "1"
        ? import("../dev/mockApi").then((m) => m.mockApi)
        : Promise.resolve(httpApi);
  }
  return current;
}
