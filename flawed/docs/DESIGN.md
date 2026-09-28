# Production Architecture Design: app-vibed-app-3

## Context
The `vibed-app` is a lightweight full-stack application comprising an Express.js backend and a React single-page application (SPA) built with Vite. It features note-taking capabilities (`/api/notes`), AI-powered note summarization using the Gemini SDK (`/api/summarize`), file uploading and streaming (`/api/upload`, `/api/files/:name`), and a zip archive export endpoint (`/api/export`).

Prior to this design, the app stored notes in an in-memory JavaScript array, stored uploaded files on the local filesystem (`uploads/`), invoked an external system CLI (`zip`) via `child_process.execFile` (which does not exist in the slim base image), and required a `GEMINI_API_KEY` environment variable. In this cloud-native design, all state is migrated to managed services (Firestore Native and Cloud Storage), AI summarization runs on Vertex AI via Application Default Credentials (ADC), administrative credentials are held in Secret Manager, and the service is deployed to Cloud Run.

## Architecture

The service runs on Google Cloud Run in `us-central1`, fully stateless, scaling from 0 to 3 instances based on incoming request load. Ingress is open to the public (`INGRESS_TRAFFIC_ALL`) with `invoker_iam_disabled = true` to conform to the organization policy prohibiting `allUsers` IAM bindings.

```mermaid
flowchart TD
    Client([User Browser]) -->|HTTP / HTTPS| CR[Cloud Run: app-vibed-app-3]
    
    subgraph Google Cloud: vibe2prod-509620 (us-central1)
        CR -->|ADC IAM| VAI[Vertex AI Gemini API]
        CR -->|ADC IAM / Datastore User| FS[(Firestore Native: app-vibed-app-3)]
        CR -->|ADC IAM / Storage Object User| GCS[(Cloud Storage: app-vibed-app-3-uploads)]
        CR -->|Secret Accessor at Startup| SM[Secret Manager: app-vibed-app-3-admin-token]
    end
    
    subgraph Application Modules inside Container
        SPA[React SPA Static Assets /dist]
        Health[/healthz Health Probe]
        NotesAPI[/api/notes API]
        SummAPI[/api/summarize API]
        FilesAPI[/api/upload & /api/files & /api/export]
    end
    
    CR --- SPA
    CR --- Health
    CR --- NotesAPI
    CR --- SummAPI
    CR --- FilesAPI
```

## Data Flow

1. **Static UI Delivery**: The browser requests `/`, and the Express server serves compiled Vite React assets from `/dist`.
2. **Health Checking**: Cloud Run startup and liveness probes query `/healthz`, returning an immediate `200 OK` without touching external systems.
3. **Note CRUD**: 
   - `GET /api/notes`: Reads all note documents from the Firestore Native database `app-vibed-app-3` ordered by creation time.
   - `POST /api/notes`: Validates input and persists a new note document to Firestore.
   - `DELETE /api/notes/:id`: Validates the `x-admin-token` header against the secret `ADMIN_TOKEN` and deletes the document from Firestore.
4. **AI Summarization**: `POST /api/summarize` retrieves note texts from Firestore, creates a prompt, and executes `ai.models.generateContent` against Gemini 2.5 Flash via Vertex AI in `us-central1` using the runtime service account's ADC.
5. **File Management & Export**:
   - `POST /api/upload`: Multer processes file in memory and streams it directly to Cloud Storage bucket `app-vibed-app-3-uploads`.
   - `GET /api/files/:name`: Retrieves and streams the file object from the Cloud Storage bucket.
   - `GET /api/export`: Queries the bucket for objects and uses the `archiver` Node.js library to stream a dynamically generated zip archive to the client.

## Security

- **Service Identity**: The service executes under the identity of `vibe2prod-app-runtime@vibe2prod-509620.iam.gserviceaccount.com`. No personal credentials or API keys are embedded or configured.
- **Zero API Keys**: Gemini API keys are completely removed. The Vertex AI SDK interacts with Google Cloud's control plane using the ambient service account identity.
- **Database Isolation**: The runtime identity is granted `roles/datastore.user` with a CEL IAM condition restricting access exclusively to `projects/vibe2prod-509620/databases/app-vibed-app-3`, preventing access to the platform's default database.
- **Secret Management**: The admin token is generated using Terraform `random_password`, stored in Secret Manager, and injected as an environment variable into the container. Plaintext values are never checked into version control.
- **Public Access**: Public reachability is established using `invoker_iam_disabled = true`, preventing IAM violations against org policy.
- **Container Hardening**: The container runs as non-root user `1000:1000`, using a pinned Node.js 20 slim image with Helmet security headers and CORS origin restrictions.

## IAM

| Principal | Role | Resource | Condition | Purpose |
|---|---|---|---|---|
| `serviceAccount:vibe2prod-app-runtime@vibe2prod-509620.iam.gserviceaccount.com` | `roles/datastore.user` | `projects/vibe2prod-509620` | `resource.name == "projects/vibe2prod-509620/databases/app-vibed-app-3"` | Read/write permissions strictly scoped to the app's dedicated Firestore database. |
| `serviceAccount:vibe2prod-app-runtime@vibe2prod-509620.iam.gserviceaccount.com` | `roles/storage.objectUser` | `app-vibed-app-3-uploads` | None | Manage object lifecycle (create, read, delete) in the uploads bucket. |
| `serviceAccount:vibe2prod-app-runtime@vibe2prod-509620.iam.gserviceaccount.com` | `roles/secretmanager.secretAccessor` | `app-vibed-app-3-admin-token` | None | Read the administrative token secret version at instance initialization. |

*(Note: `roles/aiplatform.user` is pre-granted to the runtime service account at the project level by the platform).* 

## Configuration

### Environment Variables and Secrets

| Variable Name | Source | Value / Reference | Purpose |
|---|---|---|---|
| `PORT` | literal | `3000` | Port for Express HTTP server. |
| `NODE_ENV` | literal | `production` | Optimizes Express and React for production runtime. |
| `GOOGLE_CLOUD_PROJECT` | literal | `vibe2prod-509620` | Project identifier for GCP client SDKs. |
| `FIRESTORE_DATABASE_ID` | literal | `app-vibed-app-3` | Specifies non-default Firestore database instance. |
| `GCS_BUCKET_NAME` | literal | `app-vibed-app-3-uploads` | Identifies the GCS bucket for uploads. |
| `VERTEX_AI_LOCATION` | literal | `us-central1` | Regional endpoint for Vertex AI Gemini model calls. |
| `ADMIN_TOKEN` | secret | `app-vibed-app-3-admin-token:latest` | Authorization secret for administrative note deletion. |

## Cost Drivers

- **Cloud Run Compute & Memory**: Sized at 1 vCPU and 512 MiB RAM. Scaled to 0 when idle to eliminate compute cost during inactivity. Active instances process concurrency up to 80 requests.
- **Firestore Operations**: 4,000 document reads and 600 document writes monthly, coupled with ~0.05 GB storage.
- **Cloud Storage**: 2.0 GB standard storage with ~200 Class A operations (uploads/lists) and ~600 Class B operations (reads).
- **Vertex AI Gemini**: ~200 summarization invocations monthly, averaging 1,200 input tokens and 250 output tokens per call using `gemini-2.5-flash`.
- **Secret Manager**: ~50 secret accesses per month corresponding to container cold starts.
- **Network Egress**: ~15 KB average payload over 20,000 total requests (including health checks and static UI delivery).

## Operations and Observability

- **Health Monitoring**: Startup and liveness probes monitor `/healthz` on port 3000. Probes execute every 15 seconds with a 3-strike failure threshold.
- **Logging**: Express request logging and structured uncaught error logging stream directly to Cloud Logging via stdout and stderr.
- **Metrics**: Cloud Monitoring automatically tracks Cloud Run request count, request latencies (p50, p95, p99), instance counts, CPU utilization, and container memory utilization.
- **Budget Recommendation**: It is recommended that a project billing administrator configure a Cloud Billing alert for `vibe2prod-509620` with alert thresholds set at 50%, 80%, and 100% of the allocated monthly demo budget.

## Rollout

1. Provision Firestore database `app-vibed-app-3` in `us-central1`.
2. Create Cloud Storage bucket `app-vibed-app-3-uploads` with uniform bucket-level access.
3. Generate administrative random password and create Secret Manager secret `app-vibed-app-3-admin-token`.
4. Apply IAM bindings for Datastore, Storage, and Secret Manager.
5. Deploy Cloud Run service `app-vibed-app-3` referencing the container image built with the required code changes.
6. Verify `/healthz` returns `200 OK` and run end-to-end checks on `/api/notes`, `/api/upload`, and `/api/summarize`.

## Risks

- **Cold Start Latency**: Scaling down to 0 instances saves costs but introduces 1 to 3 seconds of cold-start latency on the first request as Node.js initializes libraries.
- **Export Memory Spikes**: The `/api/export` endpoint uses in-memory streaming via `archiver`. If users request large zip archives concurrently, memory could approach the 512 MiB ceiling.
- **AI Regional Quotas**: Vertex AI `gemini-2.5-flash` calls in `us-central1` are subject to project quotas. If rate-limited, summary calls will return 500 errors.

## Required Code Changes

1. **`server.js`**:
   - Implement `GET /healthz` endpoint returning `{ status: "ok" }` to fulfill Cloud Run probe checks.
   - Initialize `@google/genai` with `{ vertexai: true, project: process.env.GOOGLE_CLOUD_PROJECT || 'vibe2prod-509620', location: process.env.VERTEX_AI_LOCATION || 'us-central1' }` and eliminate all references to `process.env.GEMINI_API_KEY`.
   - Replace in-memory array operations with `@google-cloud/firestore` calls targeting `databaseId: process.env.FIRESTORE_DATABASE_ID`.
   - Configure `multer` with `multer.memoryStorage()`, update `/api/upload` and `/api/files/:name` to stream to/from `@google-cloud/storage`, and update `/api/export` to generate zip streams using `archiver`.
2. **`package.json`**:
   - Add `@google-cloud/firestore` (`^7.11.0`), `@google-cloud/storage` (`^7.15.0`), and `archiver` (`^7.0.1`) to dependencies.

---
Written by the Vibe2Prod Architect agent; independent critic approved after 1 round(s). A human approves before Terraform is written.
