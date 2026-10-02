# Production Architecture Design: OWASP Juice Shop

## Context
OWASP Juice Shop is an intentionally vulnerable web application written in Node.js (Express) with an Angular frontend. It is packaged as a single container serving both static assets and REST API endpoints. The application is being deployed to Google Cloud project `vibe2prod-509620` in `us-central1` as Cloud Run service `app-juice-shop-1`.

In previous deployment attempts, container initialization and chatbot interactions encountered timeouts:
1. **Container Startup Probe Timeout**: The application performs extensive startup initialization before binding its HTTP listener: `sequelize.sync({ force: true })`, dependency verification, precondition validation, and `datacreator()` seeding over 200 catalog and challenge records. In constrained CPU environments or with strict startup probes, this bootstrap sequence took longer than probe thresholds, causing Cloud Run to terminate the container before becoming ready.
2. **Chatbot LLM Connection Timeout**: The default configuration pointed to `http://localhost:11434/v1` (local Ollama instance). In Cloud Run, no local Ollama service exists, leading to connection timeouts and hanging SSE streams during chat requests and startup precondition probes.

This architecture resolves both issues by optimizing startup probes with startup CPU boost, adding a dedicated lightweight `/healthz` health endpoint, bypassing local LLM probing in production, and migrating the chatbot to Vertex AI `gemini-3.8-flash` via the `@google/genai` SDK. Furthermore, single-instance execution (`max_instance_count = 1`) ensures consistency for in-memory RSA JWT signing and SQLite state, and CORS allows wildcard browser requests.

## Architecture

```mermaid
flowchart TD
    Client([Web Client / Browser]) -->|HTTPS :443| Ingress[Cloud Run Ingress: app-juice-shop-1]
    
    subgraph CloudRun[Google Cloud Run v2: app-juice-shop-1]
        Express[Express 4 Server :8080]
        Angular[Angular Static UI Bundle]
        SQLite[(SQLite In-Memory / Local Disk)]
        MarsDB[(MarsDB In-Memory NoSQL)]
        HealthRoute[/healthz Endpoint]
        ChatRoute[/rest/chat Endpoint]
        
        Express --> Angular
        Express --> SQLite
        Express --> MarsDB
        Express --> HealthRoute
        Express --> ChatRoute
    end
    
    subgraph GCPManaged[Google Cloud Platform Managed Services]
        SM[Secret Manager]
        VertexAI[Vertex AI Gemini 3.8 Flash global]
    end
    
    SM -->|COOKIE_SECRET, HMAC_SECRET| CloudRun
    ChatRoute -->|Vertex AI SDK vertexai=true| VertexAI
    
    CloudRunProbe[Cloud Run Startup/Liveness Probes] -->|GET /healthz| HealthRoute
```

## Data Flow
1. **HTTP Requests & Static Assets**: External web clients connect via HTTPS to Cloud Run `app-juice-shop-1`. Requests for frontend routes serve the compiled Angular application from `frontend/dist/frontend/`.
2. **API & Challenge Interactions**: API calls (`/api/*`, `/rest/*`) hit Express routes. SQL operations execute against the local SQLite database (`data/juiceshop.sqlite`), while product review NoSQL operations execute against the in-memory MarsDB collections.
3. **Chatbot Assistant**: When a user chats with "Juicy the Smart Assistant" at `/rest/chat`, the backend prepares the system prompt and conversation history, invokes Vertex AI `gemini-3.8-flash` using the container runtime identity (`vibe2prod-app-runtime@vibe2prod-509620.iam.gserviceaccount.com`), executes registered function tools (`searchProducts`, `getProductReviews`, `getOrderById`, `generateCoupon`), and streams SSE chunks back to the client.
4. **Health Probes**: Cloud Run orchestrator sends HTTP GET requests to `/healthz` on port 8080. The endpoint immediately responds with HTTP 200 without accessing SQLite or any external API.

## State Management & Instance Ephemerality
Cloud Run instances possess an in-memory, per-instance filesystem and no shared process memory. OWASP Juice Shop maintains state across several layers:
- **Single-Instance Enforcement**: Juice Shop generates dynamic RSA keypairs in memory at process startup for JWT token signing and verification, and manages state in local SQLite. Setting `max_instance_count = 1` prevents session split-brain, JWT verification mismatches (HTTP 401), and database inconsistency across multiple instances.
- **SQLite Database (`data/juiceshop.sqlite`)**: Holds user accounts, products, baskets, challenge statuses, and configuration. On every startup, `server.ts` executes `sequelize.sync({ force: true })` and `datacreator()`, purposefully wiping and recreating all tables from static seed data. Because fresh initialization on startup is the intended behavior of Juice Shop, keeping SQLite on the ephemeral container disk is standard and required. Moving to an external database would disrupt dozens of SQLite-specific injection challenges (such as SQLite dialect quirks and `sqlite_master` table disclosure).
- **MarsDB In-Memory Collections**: Stores reviews and orders in memory for NoSQL injection challenges. Preserved in memory per instance.
- **Challenge Progress**: Users can persist or restore their hacking progress across container recycles using the built-in continue code feature (`/rest/continue-code`), which encodes solved challenges into an encrypted token stored in client localStorage.
- **File Uploads**: Complaint uploads (`uploads/complaints/`) and profile images are saved locally to allow path-traversal challenges (`fileWriteChallenge` targeting `ftp/legal.md`). Keeping uploads on local ephemeral disk is critical to avoid breaking these challenges.

## Security
- **Service Identity**: The Cloud Run service runs as the platform shared service account `vibe2prod-app-runtime@vibe2prod-509620.iam.gserviceaccount.com`.
- **Ingress & Authentication**: Per organization policy, no IAM bindings to `allUsers` or `allAuthenticatedUsers` are used. Ingress is set to `INGRESS_TRAFFIC_ALL` with `invoker_iam_disabled = true` to allow public educational access.
- **Secret Protection**: Sensitive secrets (`COOKIE_SECRET` and `HMAC_SECRET`) are stored in Secret Manager and injected into container environment variables at runtime via Secret Manager secret references. The runtime service account is granted `roles/secretmanager.secretAccessor` strictly on the individual secret resources.
- **AI Authentication**: Vertex AI requests use Application Default Credentials (ADC) backed by `roles/aiplatform.user` already granted to the runtime service account, eliminating API keys.

## IAM

| Principal | Role | Resource | Condition | Reason |
|---|---|---|---|---|
| `serviceAccount:vibe2prod-app-runtime@vibe2prod-509620.iam.gserviceaccount.com` | `roles/secretmanager.secretAccessor` | `app-juice-shop-1-cookie-secret` | None | Read access for Express cookie-parser secret |
| `serviceAccount:vibe2prod-app-runtime@vibe2prod-509620.iam.gserviceaccount.com` | `roles/secretmanager.secretAccessor` | `app-juice-shop-1-hmac-secret` | None | Read access for HMAC cryptographic calculations |

*(Note: `roles/aiplatform.user` is already assigned to the shared platform runtime identity at the project level and does not need recreation.)*

## Configuration

### Environment Variables
- `NODE_ENV`: `production` (literal) — Enables Express production optimizations.
- `PORT`: `8080` (runtime) — Listening port specified by Cloud Run.
- `GOOGLE_CLOUD_PROJECT`: `vibe2prod-509620` (literal) — Project ID for Vertex AI initialization.
- `VERTEX_AI_LOCATION`: `global` (literal) — Region for Vertex AI Gemini 3.8 Flash model execution.
- `ALLOWED_ORIGINS`: `*` (literal) — Configures CORS middleware for public browser access.
- `COOKIE_SECRET`: Secret reference to `app-juice-shop-1-cookie-secret:latest`.
- `HMAC_SECRET`: Secret reference to `app-juice-shop-1-hmac-secret:latest`.

### Secret Manager Secrets
- `app-juice-shop-1-cookie-secret`: 32-character random string generated via Terraform resource `random_password.app-juice-shop-1-cookie-secret-pwd`.
- `app-juice-shop-1-hmac-secret`: 32-character random string generated via Terraform resource `random_password.app-juice-shop-1-hmac-secret-pwd`.

## Cost Drivers
- **Cloud Run Compute**: Billed per vCPU-second and GiB-second while processing requests and during startup boost. Sized to 2 vCPUs and 2 GiB memory, with `min_instance_count = 0` and `max_instance_count = 1` to scale to zero when idle and ensure single-instance consistency.
- **Cloud Run Request Processing**: Billed per million incoming requests (~25,000 monthly demo requests).
- **Vertex AI Gemini**: Billed per 1,000 input and output characters/tokens for `gemini-3.8-flash` (~250 monthly chatbot conversations).
- **Secret Manager**: Billed for 2 active secret versions and secret access operations upon container instance cold starts (~20 operations per month).
- **Network Egress**: Standard Cloud Run network data egress for web responses.

## Operations and Observability
- **Probes**:
  - **Startup Probe**: HTTP GET on `/healthz` port 8080. `initial_delay_seconds = 10`, `period_seconds = 5`, `timeout_seconds = 5`, `failure_threshold = 30`. Allows up to 160 seconds for SQLite migration and data generation to complete.
  - **Liveness Probe**: HTTP GET on `/healthz` port 8080. `initial_delay_seconds = 30`, `period_seconds = 15`, `timeout_seconds = 5`, `failure_threshold = 3`.
- **Logging**: Express access logs stream via Morgan to container stdout and Cloud Logging. Internal Winston log events write to stdout in JSON/structured format.
- **Metrics**: Application exposes Prometheus metrics at `/metrics` (monitored by Prometheus/Cloud Monitoring). Cloud Run native metrics (request count, latency, CPU/memory utilization, instance count) are collected automatically in Google Cloud Monitoring.

## Rollout
1. Provision random passwords `app-juice-shop-1-cookie-secret-pwd` and `app-juice-shop-1-hmac-secret-pwd`, followed by Secret Manager secrets and secret versions.
2. Apply IAM bindings for `roles/secretmanager.secretAccessor` to the runtime service account.
3. Deploy Cloud Run service `app-juice-shop-1` referencing the pre-built container image variable `var.image` with `max_instance_count = 1`.
4. Validate that startup probe succeeds on `/healthz` and verify `/rest/chat` communicates with Vertex AI.

## Risks
1. **Cold Start Latency**: Without startup CPU boost, SQLite table creation and bulk seeding can take over 30 seconds. Enabled `startup_cpu_boost = true` and 2 vCPUs to accelerate startup.
2. **Ephemeral Instance Restarts**: User session state and challenge scores reset if an instance scales to zero and terminates. Users should export/import their continue codes (`/#/score-board`) to preserve progress.
3. **Vertex AI Quota Limits**: Heavy chatbot utilization could hit Vertex AI API quotas; mitigated by setting Cloud Run concurrency to 80 and maximum instances to 1.

## Required Code Changes
1. **`server.ts`**: Add `app.get('/healthz', (req: Request, res: Response) => { res.status(200).json({ status: 'ok' }) })` early in `configureApp()`. Bypasses DB and provides an immediate 200 response for startup/liveness probes.
2. **`server.ts`**: Update the CORS origin callback in `configureApp()` to check `allowedOrigins.includes('*') || allowedOrigins.includes(origin)` so wildcard origins properly match incoming requests.
3. **`package.json`**: Add `@google/genai: ^0.1.2` dependency for Vertex AI Gemini communication.
4. **`routes/chat.ts`**: Initialize `GoogleGenAI` with `{ vertexai: true, project: process.env.GOOGLE_CLOUD_PROJECT || 'vibe2prod-509620', location: process.env.VERTEX_AI_LOCATION || 'global' }`. Call model `gemini-3.8-flash` and stream SSE events to client, replacing local Ollama `http://localhost:11434/v1` calls.
5. **`lib/startup/validatePreconditions.ts`**: Skip probing `localhost:11434` when `NODE_ENV === 'production'` to eliminate the 5-second fetch timeout that blocked `preconditionsReady`.

---
Written by the Vibe2Prod Architect agent; independent critic approved after 2 round(s). A human approves before Terraform is written.
