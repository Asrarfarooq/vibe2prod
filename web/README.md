# web

The Vibe2Prod dashboard: a React frontend and a FastAPI backend built into one container. The API serves `/api/*` and the built frontend from the same origin. Not deployed yet; the planned target is Cloud Run service `vibe2prod-dashboard` running as service account `vibe2prod-dashboard`.

## Layout

```
web/
├── Dockerfile            Stage 1: node:22-slim builds the frontend. Stage 2: python:3.12-slim runs uvicorn with the build in /app/static
├── api/
│   ├── main.py           FastAPI app
│   └── requirements.txt
└── frontend/             React 19, Vite, TypeScript, plain CSS modules and tokens, no UI framework
    └── src/
        ├── api/          HTTP + SSE client, types, useRun hook
        ├── dev/mockApi.ts  Fixture API for VITE_MOCK=1, excluded from production builds
        ├── components/   Pipeline stepper, stage detail, event log, artifacts, decision panel, readiness score, runs table
        ├── pages/        Projects list, project page, run page
        ├── lib/          Router, formatting, theme, approver key storage
        └── styles/       Global CSS and design tokens
```

## Pages

- `/`: opens the project directly if there is only one, otherwise lists projects.
- `/projects/{id}`: repo, deploy target, score history, Start run, runs table.
- `/projects/{id}/runs/{runId}`: pipeline view with live events, artifacts and the approve/deny panel.

## API

| Method and path | Purpose |
|---|---|
| `GET /api/projects` | All projects with latest run and score history |
| `GET /api/projects/{id}` | One project |
| `GET /api/projects/{id}/runs` | Runs for a project, newest first |
| `POST /api/projects/{id}/runs` | Start a run. One active run per project (409 otherwise). Starts `codeguard-agent`; returns 502 and marks the run failed if the job cannot start |
| `GET /api/runs/{id}` | Run with all four stages |
| `GET /api/runs/{id}/events?after=<seq>` | Events after a sequence number |
| `GET /api/runs/{id}/stream` | SSE: `event` messages for new events and `run` messages for run doc changes. Supports `Last-Event-ID` backfill; heartbeat every 15 s |
| `POST /api/runs/{id}/stages/{stage}/decision` | Body `{"decision": "approve" \| "deny", "reason": ...}`. Deny needs a reason. 409 if already decided or not awaiting approval. Approve starts `<next-stage>-agent` |
| `POST /api/runs/{id}/stages/{stage}/rerun` | Body `{"feedback": "..."}` (1-4000 chars). Allowed when the stage is `awaiting_approval`, `approved`, `denied` or `failed` and the run is not running (409 otherwise). Resets the stage to running with `attempt + 1` and the feedback recorded, deletes later stages, clears the score and starts `<stage>-agent`, which reads the feedback. 502 and marks the stage failed if the job cannot start |

All POST endpoints require headers `X-Requested-With: vibe2prod` and `X-Approver-Key: <key>`. Keys come from the `APPROVER_KEYS` env var, a JSON object mapping approver email to key, intended to be injected from Secret Manager secret `dashboard-approver-keys`. The matched email is recorded as `started_by`, as the decider, or as the feedback author. The browser keeps the key in `sessionStorage` (this tab only, cleared when the tab closes). Every response sets a strict Content Security Policy and related security headers; `/api/*` responses are `no-store`.

API env vars: `GOOGLE_CLOUD_PROJECT` (default `vibe2prod-509620`), `REGION` (default `us-central1`), `APPROVER_KEYS`, `STATIC_DIR`.

## Run locally

Mock mode, no GCP access needed. Node.js runs in Docker; `--network host` keeps Vite on `127.0.0.1:5173`:

```
docker run --rm -it --network host \
  -u "$(id -u):$(id -g)" -e HOME=/tmp \
  -v "$PWD/web/frontend:/app" -w /app \
  node:22-slim sh -c "npm ci && npm run dev:mock"
```

Open http://127.0.0.1:5173. On a remote host, forward the port first: `ssh -L 5173:127.0.0.1:5173 <host>`.

Against real Firestore: start the API on `127.0.0.1:8080` with Application Default Credentials, then run `npm run dev` instead of `npm run dev:mock`. Vite proxies `/api` to `http://127.0.0.1:8080`.

```
python3 -m venv .venv && . .venv/bin/activate
pip install -r web/api/requirements.txt
cd web/api
APPROVER_KEYS='{"<you>@gcp.altostrat.com": "<local-test-key>"}' \
  uvicorn main:app --host 127.0.0.1 --port 8080
```

Starting a run or approving a stage from a local API starts real Cloud Run Jobs.

## Checks

```
docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp \
  -v "$PWD/web/frontend:/app" -w /app node:22-slim \
  sh -c "npm ci && npm run typecheck && npm run lint && npm run build"

ruff check web/api
```

## Build the image

```
docker build -t vibe2prod-dashboard web
```

The container listens on `$PORT` (default 8080). No Cloud Build step builds or deploys it yet.
