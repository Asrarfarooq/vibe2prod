# agents

All Vibe2Prod agents, built into one Docker image. Each agent runs as its own Cloud Run Job; the job's `AGENT` env var picks the folder. `main.py` imports `<AGENT>.agent` and runs its `main()` coroutine, whose return value is the exit code.

Every stage agent uses ADK 2.10 (`google-adk`) with a `Workflow` graph: plain Python function nodes for deterministic steps (checkout, scan, terraform, commit) and `Agent` nodes for model steps, with structured output via Pydantic `output_schema`. Each stage's `main()` loads the run, wraps the workflow in `guarded()`, and installs `GuardrailPlugin` and `FirestoreEventsPlugin`.

## Layout

```
agents/
├── Dockerfile        Python 3.12 slim; git, node/npm, pinned and checksum-verified gitleaks, osv-scanner, hadolint, terraform; semgrep in its own venv; google 8.4.0 and random 3.9.1 providers pre-fetched into /opt/tf-plugin-cache; runs as uid 10001
├── requirements.txt
├── main.py           Entrypoint
├── common/           Shared code for stage agents
├── hello/            Smoke test
├── codeguard/
│   ├── agent.py      Workflow, tools, PR body
│   └── scanners.py   gitleaks, semgrep, osv-scanner, hadolint wrappers with a common finding format
├── architect/
│   └── agent.py      Writer/critic workflow, DesignDoc schema, platform constraints
├── iac/
│   ├── agent.py      Workflow and tools
│   ├── terraform.py  versions.tf template, fmt/validate/plan in a scratch copy, policy checks
│   └── pricing.py    Cost estimate from the plan and Cloud Billing Catalog list prices
└── deploy/
    ├── agent.py      Workflow
    ├── gcp.py        Cloud Build, Cloud Run, Secret Manager, Storage and Logging REST calls over mTLS
    ├── terraform.py  init (gcs backend check), plan, apply, outputs
    ├── gate.py       Plan gate
    ├── probe.py      HTTP probe of the live app
    ├── audit.py      Deterministic readiness checks and scoring
    └── tests/        pytest tests for gate, audit and the workflow
```

## Shared code (`common/`)

| Module | Contents |
|---|---|
| `context.py` | `RunContext` (run id, stage, repo, base branch, commit, app subfolder, workdir). `load()` reads `runs/{RUN_ID}`. Run branch is `v2p/run-<run_id>`; working copy is `$WORKDIR/<run_id>` (default `/tmp/work`). `db()` returns the Firestore client; it switches to `firestore.mtls.googleapis.com` when a client certificate is available, which Agent Identity requires. Always use `db()` for Firestore in agent code |
| `events.py` | `Emitter` writes events to `runs/{id}/events/{seq:08d}` (kinds: `status`, `thought`, `tool_call`, `tool_result`, `output`, `error`; text clipped to 4000 chars, data to 8000). `FirestoreEventsPlugin` emits every non-partial model event |
| `guardrails.py` | `safe_path()` rejects paths outside the app folder or inside `.git`/`.github`. `GuardrailPlugin` blocks tools not in the stage allowlist and tool calls whose `path` argument fails `safe_path()`. When a tool raises, it returns the error to the model as a tool result and logs an `error` event instead of aborting the workflow |
| `model.py` | `gemini()`: model from `MODEL` (default `gemini-3.8-flash`) with HTTP retries (5 attempts). `thinking()`: planner with thoughts included, level HIGH |
| `repo.py` | `GitHubApp` reads the `vibe2prod-agent` GitHub App private key (secret `github-app-private-key`) as the job's own identity (mTLS on Cloud Run) and mints a one-hour installation token scoped to the run's repo, re-minted after 45 minutes. `Repo` clones, continues the run branch if an earlier stage pushed it, commits as `vibe2prod-agent[bot]`, pushes, and opens or finds the run PR. The token is passed per git command and never written to disk |
| `stage.py` | `run_workflow()` runs the workflow headless with an LLM call cap and a timeout. `set_stage()` writes status, summary, artifacts and `result` to `runs/{id}.stages.<stage>`. `guarded()` marks the stage `failed` on any exception |

## Agents

### hello

`LlmAgent` with one tool, `whoami`, that reads the service account email from the metadata server. Checks that a job can reach Gemini and call a tool. Does not use `common/` or Firestore. Job: `hello-agent`.

### codeguard (stage 1)

Job: `codeguard-agent`. Workflow: `checkout -> scan -> fixer -> verify -> open_pr -> finish`.

- `checkout`: clones the base branch, creates `v2p/run-<id>`, records the commit on the run doc.
- `scan`: gitleaks (secrets), semgrep (`p/javascript`, `p/nodejsscan`, `p/react`, `p/dockerfile`), osv-scanner (dependency CVEs), hadolint (Dockerfiles). Findings sorted by severity; up to 80 go into the prompt. Secret values are redacted.
- `fixer`: Gemini agent with tools `list_files`, `read_file`, `write_file`, `delete_file`, `update_lockfile` (`npm install --package-lock-only --ignore-scripts`), `rescan`. Fixes secrets, injection, validation, CORS, error leaks, security headers, vulnerable dependencies and the Dockerfile, and reads all source files for problems the scanners missed. Infrastructure problems are listed as remaining. Returns a `FixReport`.
- `verify`: reruns all scanners.
- `open_pr`: if files changed, commits, pushes the run branch and opens the PR with fixed and remaining issues and a before/after scanner table.
- `finish`: `awaiting_approval`; artifact: PR. `result`: findings before/after, fixed, remaining, PR number.

Limits: `MAX_LLM_CALLS` 500, `STAGE_TIMEOUT_S` 7200.

### architect (stage 2)

Job: `architect-agent`. Workflow: `checkout -> gather -> writer -> critic -> gate`; `gate` routes back to `writer` or on to `write_doc -> finish`.

- `gather`: file tree, text files (size-capped) and the CodeGuard summary.
- `writer`: returns a `DesignDoc`: components, Terraform resources with settings, IAM bindings, secrets, env vars, required code changes, usage assumptions for costing, risks, full markdown. Fixed platform constraints: one Cloud Run service named `app-<run_id>`, every name prefixed and labeled `v2p-run=<run_id>`, no `allUsers` bindings, a dedicated Firestore database instead of `(default)`, the shared runtime service account `vibe2prod-app-runtime` (no per-app service accounts), Vertex AI instead of API keys, secrets in Secret Manager, no billing budget resource.
- `critic`: independent agent that checks the design against the code and constraints; returns blocking issues and suggestions.
- `gate`: sends blocking issues back to the writer, up to 3 rounds.
- `write_doc`: writes `<app>/docs/DESIGN.md` and pushes it.
- `finish`: `awaiting_approval`; artifacts: design doc, PR. `result`: the structured design (resource settings as typed values), critic verdict, rounds, doc path.

Tools: `list_files`, `read_file`. Limits: `MAX_LLM_CALLS` 500, `STAGE_TIMEOUT_S` 7200.

### iac (stage 3)

Job: `iac-agent`. Workflow: `checkout -> load_design -> writer -> validate`; `validate` routes back to `writer` (up to 3 rounds, then fails) or on to `price -> commit -> finish`.

- `load_design`: reads `stages.architect.result` (fails if empty) and `docs/DESIGN.md`, and writes the platform-owned `infra/versions.tf`: gcs backend `vibe2prod-509620-tfstate` with prefix `apps/<run_id>`, google 8.4.0 and random 3.9.1 providers, default label `v2p-run`, and locals for the `app-<run_id>` names.
- `writer`: Gemini agent that writes `infra/main.tf`, `variables.tf`, `outputs.tf` (required: variable `image`, output `service_url`). Tools: `list_files`, `read_file`, `write_file`, `delete_file`, `update_lockfile`, `run_validate`. `write_file` only accepts `infra/<name>.tf` (not `versions.tf` or overrides), plus app source files when the design lists `code_changes`. Support for those code changes is still being finished.
- `validate` / `run_validate`: `terraform fmt`, then `init`, `validate` and `plan` in a scratch copy with local state and a placeholder image, then policy checks the model cannot waive: only google and random providers, no modules, no data sources, no authoritative IAM, required names, prefixes and outputs. Changed JavaScript is syntax-checked with `node --check`.
- `price`: prices the planned creates with live list prices from the Cloud Billing Catalog API and the design's usage assumptions (Cloud Run, Firestore, Cloud Storage, Secret Manager, Vertex AI), including free tiers.
- `commit`: commits and pushes `infra/` (and any app code changes).
- `finish`: `awaiting_approval`; artifacts: Terraform files, cost estimate, PR. `result`: files, plan summary, cost, `image_var`, `infra_dir`, backend bucket and prefix, deviations from the design.

Limits: `MAX_LLM_CALLS` 500, `STAGE_TIMEOUT_S` 7200.

### deploy (stage 4)

Job: `deploy-agent`. Workflow: `checkout -> build_image -> plan -> gate_plan -> apply -> probe_app -> audit_checks -> auditor -> finish`. Only `auditor` is a model step; the plugin allowlist is empty, so the model has no tools.

- `build_image`: tars the app folder to `gs://vibe2prod-509620_cloudbuild`, submits a Cloud Build job running as `vibe2prod-app-build@` that builds the app's own Dockerfile into `us-central1-docker.pkg.dev/<project>/vibe2prod/app-<run_id>:<commit>`, polls until done, and uses the pushed image digest.
- `plan`: `terraform init` with backend `vibe2prod-509620-tfstate` prefix `apps/<run_id>` (refuses to continue on any other backend), then `terraform plan -var image=<digest>`.
- `gate_plan`: rejects the plan on any delete or replace (only create, update, read, no-op allowed), providers other than google/google-beta/random, authoritative IAM, project/org/folder/billing resources, service accounts and their keys or IAM, names without the `app-<run_id>` prefix, grants to `allUsers`/`allAuthenticatedUsers` or to any member other than `vibe2prod-app-runtime`, and basic or admin project roles.
- `apply`: `terraform apply` of the saved plan; reads output `service_url`.
- `probe_app`: waits for `/` to return 200, records first-hit latency, a real `/api/...` GET route found in the server code, a missing route, the HTTP-to-HTTPS behavior and security headers.
- `audit_checks`: deterministic checks from the live Cloud Run service, its IAM, referenced secrets, recent logs, the plan, the CodeGuard result and the IaC cost estimate.
- `auditor`: adds at most 4 judged checks from the probe evidence and writes the readiness report.
- `finish`: score 0-100 as the mean of five categories (Security, Reliability, Cost, Observability, Deploy health), each a weighted pass rate. Writes `runs/{id}.score` and `app.url`, the project's `app_url`, and `awaiting_approval` with artifacts: live app link and readiness report. `result`: service URL, image, apply summary, score.

Limits: `MAX_LLM_CALLS` 500, `STAGE_TIMEOUT_S` 7200. Overrides: `TF_STATE_BUCKET`, `DEPLOY_REGION`, `BUILD_SOURCE_BUCKET`, `AR_REPO`, `BUILD_SA`.

## Environment variables

| Variable | Used by | Default |
|---|---|---|
| `AGENT` | `main.py` | required |
| `RUN_ID`, `STAGE` | stage agents | required; the dashboard sets both as job overrides |
| `GOOGLE_CLOUD_PROJECT` | all | `vibe2prod-509620` in `common/` |
| `GOOGLE_CLOUD_LOCATION` | google-genai | set to `global` |
| `GOOGLE_GENAI_USE_ENTERPRISE` | google-genai | set to `TRUE` (Vertex AI) |
| `MODEL` | `common/model.py` | `gemini-3.8-flash` |
| `WORKDIR` | `common/context.py` | `/tmp/work` |
| `GITHUB_APP_CLIENT_ID` | `common/repo.py` | `Iv23li6wJsHm9yHUg14w` (the `vibe2prod-agent` app) |
| `GITHUB_APP_KEY_SECRET` | `common/repo.py` | `github-app-private-key` |
| `MAX_LLM_CALLS`, `STAGE_TIMEOUT_S` | stage agents | per agent, see above |

## Run a stage locally

A local run uses real services: it reads and writes the run doc and events in Firestore, reads `github-app-private-key`, and pushes to the run branch on GitHub. IaC and Deploy also use the Terraform state bucket; Deploy runs Cloud Build and creates real resources. Your user account needs the matching permissions, and `runs/<run_id>` must exist with the earlier stages' `result` fields.

```
gcloud auth application-default login
docker build -t vibe2prod-agents agents

docker run --rm \
  -u "$(id -u):$(id -g)" \
  -e HOME=/tmp \
  -v "$HOME/.config/gcloud:/tmp/.config/gcloud:ro" \
  -e GOOGLE_CLOUD_PROJECT=vibe2prod-509620 \
  -e GOOGLE_CLOUD_QUOTA_PROJECT=vibe2prod-509620 \
  -e GOOGLE_CLOUD_LOCATION=global \
  -e GOOGLE_GENAI_USE_ENTERPRISE=TRUE \
  -e AGENT=codeguard \
  -e RUN_ID=<run_id> \
  -e STAGE=codeguard \
  vibe2prod-agents
```

`-u` and `HOME=/tmp` let the container user read the mounted Application Default Credentials. Set `AGENT` and `STAGE` to `architect`, `iac` or `deploy` for the other stages. For the smoke test, use `-e AGENT=hello` and drop `RUN_ID` and `STAGE`.

Deploy tests (need `requirements.txt` and `pytest` installed; run from `agents/`):

```
cd agents
python -m pytest deploy/tests
```

## Deploy

`../cloudbuild.yaml` builds this folder and deploys each agent job with:

```
gcloud beta run jobs deploy <stage>-agent \
  --image=us-central1-docker.pkg.dev/$PROJECT_ID/vibe2prod/agents:$COMMIT_SHA \
  --region=us-central1 \
  --functional-type=agent \
  --identity-type=agent-identity \
  --service-account=vibe2prod-agent-runtime@$PROJECT_ID.iam.gserviceaccount.com \
  --set-env-vars=AGENT=<folder>,STAGE=<stage>,GOOGLE_GENAI_USE_ENTERPRISE=TRUE,GOOGLE_CLOUD_PROJECT=$PROJECT_ID,GOOGLE_CLOUD_LOCATION=global \
  --cpu=2 --memory=4Gi --max-retries=0 --task-timeout=130m
```

Steps exist for `hello-agent`, `codeguard-agent`, `architect-agent`, `iac-agent` and `deploy-agent`. `--functional-type=agent --identity-type=agent-identity` gives the job its own Agent Identity and registers it in Agent Registry; these settings cannot be changed after the job is created. IAM is granted per job identity: each new job needs its own `secretAccessor` binding on `github-app-private-key`, plus whatever else its stage touches.
