# Architecture and Infrastructure Design: app-vibed-app-4

## Context
`app-vibed-app-4` is a full-stack note-taking web application built with Express 5, React 18, and Vite. The backend serves the built React SPA assets and exposes REST APIs for creating, reading, and deleting notes, uploading files, exporting uploaded files as a zip archive, and summarizing notes using Gemini. 

To run reliably in production on Google Cloud Run within project `vibe2prod-509620`, the application requires architectural modernization:
1. State currently kept in process memory (`notes = []`) must be persisted to a managed Firestore Native database.
2. Uploaded files stored on the local container filesystem (`uploads/`) must be persisted to a Google Cloud Storage bucket, and zip exports must be generated via a pure JavaScript streaming library (`archiver`) rather than a missing host CLI binary (`zip`).
3. Gemini AI summarization must transition from an external API key to Vertex AI (`gemini-3.8-flash` in `global` location) using IAM application default credentials.
4. Administrative note deletion must be authenticated using a secret token stored in Secret Manager and mounted as an environment variable.
5. Container probes require a dedicated, lightweight `/healthz` endpoint.

---

## Architecture

The application is packaged as a single Docker container deployed to Google Cloud Run (`app-vibed-app-4`) in `us-central1`. Cloud Run handles public ingress, terminates TLS, and routes traffic to the container on port 8080.

```mermaid
flowchart TD
    Client([Web Browser / Client]) -->|HTTPS| Run[Cloud Run: app-vibed-app-4\nRegion: us-central1]
    
    subgraph CloudRunContainer [Cloud Run Container]
        Express[Express 5 Server :8080]
        StaticUI[React Vite SPA UI]
        HealthRoute[/healthz Probe]
        NotesAPI[/api/notes API]
        UploadAPI[/api/upload & /api/files API]
        ExportAPI[/api/export API]
        SummaryAPI[/api/summarize API]
    end
    
    Run --> Express
    Express --> StaticUI
    Express --> HealthRoute
    Express --> NotesAPI
    Express --> UploadAPI
    Express --> ExportAPI
    Express --> SummaryAPI
    
    subgraph ManagedGCP [Google Cloud Managed Services]
        Firestore[(Firestore Native DB\napp-vibed-app-4)]
        GCS[(Cloud Storage Bucket\napp-vibed-app-4-uploads-509620)]
        SM[(Secret Manager\napp-vibed-app-4-admin-token)]
        VertexAI[Vertex AI Gemini 3.8 Flash\nLocation: global]
    end
    
    SM -.->|Injects ADMIN_TOKEN| Run
    NotesAPI <-->|Datastore User IAM| Firestore
    UploadAPI <-->|Storage Object User IAM| GCS
    ExportAPI <-->|Stream Objects| GCS
    SummaryAPI <-->|AI Platform User IAM| VertexAI
```

---

## Data Flow

1. **Frontend Delivery**: Clients request the root URL or static assets. Express serves pre-built static files from `/app/dist` directly from container disk.
2. **Health Probes**: Cloud Run startup and liveness probes query `GET /healthz`. Express immediately returns HTTP 200 `{ status: 'ok' }` without invoking database or cloud API calls.
3. **Notes Management**:
   - `GET /api/notes`: Express queries the `notes` collection in Firestore database `app-vibed-app-4` and returns notes sorted by creation time.
   - `POST /api/notes`: Express validates payload length and content, generates a unique timestamp ID, and writes `{ id, text, createdAt }` to Firestore.
   - `DELETE /api/notes/:id`: Express inspects header `x-admin-token`, verifies equality with `process.env.ADMIN_TOKEN` using `crypto.timingSafeEqual`, queries Firestore for the note, and deletes it.
4. **File Upload and Retrieval**:
   - `POST /api/upload`: Multer handles multipart file upload in memory. Express streams the buffer to the GCS bucket `app-vibed-app-4-uploads-509620` with a randomized filename and returns the filename.
   - `GET /api/files/:name`: Express validates the filename to prevent traversal, verifies the file exists in GCS, and streams the object from GCS to the HTTP client.
   - `GET /api/export`: Express lists objects in the GCS bucket, uses `archiver` to compress them into a zip stream, and pipes the output to `res.attachment()`.
5. **AI Summarization**:
   - `POST /api/summarize`: Express receives notes (or retrieves them from Firestore), formats them into a prompt, and calls Vertex AI model `gemini-3.8-flash` via `@google/genai` using application default credentials from the runtime service account in location `global`. The generated summary text is returned to the client.

---

## Security

- **Public Access Model**: In accordance with the organization policy forbidding IAM bindings to `allUsers` or `allAuthenticatedUsers`, public access to the Cloud Run service is enabled by setting `invoker_iam_disabled = true` with ingress `INGRESS_TRAFFIC_ALL`. No `allUsers` IAM member is ever created.
- **Workload Identity**: The Cloud Run service executes under the dedicated runtime service account `vibe2prod-app-runtime@vibe2prod-509620.iam.gserviceaccount.com`. No service account keys are created or used.
- **Least-Privilege Database IAM**: The runtime identity receives `roles/datastore.user` bounded strictly by an IAM CEL condition: `resource.name == 'projects/vibe2prod-509620/databases/app-vibed-app-4'`. This ensures the application cannot interact with the platform's default database or other databases.
- **Bucket Security**: The Cloud Storage bucket enforces uniform bucket-level access and public access prevention (`enforced`). Only the runtime identity has `roles/storage.objectUser` on the bucket.
- **Secret Management**: The admin authorization token is generated using Terraform's `random_password`, stored in Secret Manager, and injected into the container via Cloud Run's native secret environment variable binding. The runtime service account receives `roles/secretmanager.secretAccessor` only on the specific secret.
- **Defense in Depth**: Express applies `helmet` HTTP security headers, CORS origin restrictions, body size limits (1MB), and multer upload limits (10MB, 1 file per request). Filenames are sanitized via regex to eliminate directory traversal risks.

---

## IAM

| Principal | Role | Resource | Condition | Purpose |
|---|---|---|---|---|
| `serviceAccount:vibe2prod-app-runtime@vibe2prod-509620.iam.gserviceaccount.com` | `roles/datastore.user` | `projects/vibe2prod-509620` | `resource.name == "projects/vibe2prod-509620/databases/app-vibed-app-4"` | Read and write access to the dedicated Firestore database |
| `serviceAccount:vibe2prod-app-runtime@vibe2prod-509620.iam.gserviceaccount.com` | `roles/storage.objectUser` | `app-vibed-app-4-uploads-509620` | None | Read, upload, and list objects in the uploads Cloud Storage bucket |
| `serviceAccount:vibe2prod-app-runtime@vibe2prod-509620.iam.gserviceaccount.com` | `roles/secretmanager.secretAccessor` | `app-vibed-app-4-admin-token` | None | Read access to the secret payload for ADMIN_TOKEN |

*Note: `roles/aiplatform.user` is already pre-assigned by the platform to `vibe2prod-app-runtime@vibe2prod-509620.iam.gserviceaccount.com`.*

---

## Configuration

### Environment Variables
| Name | Source | Value / Reference | Purpose |
|---|---|---|---|
| `PORT` | literal | `8080` | Express server listener port matching Cloud Run containerPort |
| `NODE_ENV` | literal | `production` | Optimizes Express and Node.js runtime performance |
| `GCP_PROJECT` | literal | `vibe2prod-509620` | Google Cloud project ID for Firestore and Vertex AI SDKs |
| `FIRESTORE_DATABASE_ID` | literal | `app-vibed-app-4` | Target database ID for Firestore Native client |
| `GCS_BUCKET_NAME` | literal | `app-vibed-app-4-uploads-509620` | Target bucket name for file uploads and downloads |
| `ALLOWED_ORIGINS` | literal | `*` | Express CORS configuration for web clients |
| `ADMIN_TOKEN` | secret | `app-vibed-app-4-admin-token:latest` | Bearer token for DELETE /api/notes/:id verification |

---

## Cost Drivers

Cost is governed strictly by consumption quantities:
- **Cloud Run Compute**: vCPU-seconds and Memory-seconds based on 1 vCPU and 512Mi RAM running between 0 and 3 instances. With `min_instance_count = 0`, instances scale to zero during idle periods.
- **Cloud Run Request Processing**: Total incoming HTTP requests including user traffic and container probe requests.
- **Firestore Storage & Operations**: Monthly document reads (~10,000) and writes (~1,000) plus 50 MB document storage in `us-central1`.
- **Cloud Storage**: Object storage (~2.0 GB Standard class in `us-central1`), Class A operations (object creation and bucket listings), and Class B operations (file downloads and reads).
- **Vertex AI Gemini**: Input and output token quantities for `gemini-3.8-flash` (~400 summarization requests per month at ~1,200 input tokens and ~250 output tokens per call).
- **Secret Manager**: 1 active secret with secret version access operations triggered on container cold starts.

---

## Operations and Observability

- **Logging**: Express console outputs (`stdout`/`stderr`) are automatically collected by Cloud Logging with structured severity levels and request metadata.
- **Health Monitoring**: Cloud Run executes HTTP startup probes (initial delay 0s, period 5s, failure threshold 6) and liveness probes (period 15s, failure threshold 3) against `/healthz`.
- **Metrics**: Standard Cloud Run metrics in Cloud Monitoring track request count, request latency percentiles (p50, p95, p99), container CPU utilization, memory utilization, and active instance count.
- **Budget Recommendation**: Because budget creation requires billing account administrative permissions not granted to the deployment pipeline, a monthly Cloud Billing budget alert should be configured in the Google Cloud Console for project `vibe2prod-509620` with alert thresholds set at 50%, 80%, and 100% of the team's planned demo threshold.

---

## Rollout

1. **Database & Storage Provisioning**: Terraform provisions the Firestore Native database `app-vibed-app-4` in `us-central1` and the Cloud Storage bucket `app-vibed-app-4-uploads-509620`.
2. **Secret Provisioning**: Terraform generates a 32-character random string via `random_password`, creates the `app-vibed-app-4-admin-token` Secret Manager secret, and stores the version.
3. **IAM Assignments**: Terraform attaches resource-level IAM policies for Cloud Storage, Secret Manager, and the conditional Firestore datastore user role.
4. **Service Deployment**: Cloud Run service `app-vibed-app-4` is deployed with image `${var.image}`, configured environment variables, secret mounts, probe paths, and `invoker_iam_disabled = true`.
5. **Traffic Verification**: Synthetic requests verify `/healthz` returns 200, `/api/notes` reads from and writes to Firestore, `/api/upload` stores files in GCS, and `/api/summarize` invokes Vertex AI.

---

## Risks

1. **Unauthenticated Public Access**: Setting `invoker_iam_disabled = true` allows public internet traffic to access endpoints. While note deletion is protected by `ADMIN_TOKEN`, note creation and summarization could be abused if the URL is exposed publicly. Rate limiting or Cloud Armor should be considered if traffic escalates.
2. **Export Memory Limits**: Streaming zip exports for large files could consume container memory if multiple large archives are requested concurrently. Sizing container RAM to 512Mi mitigates standard usage, but very large archives should be handled via signed GCS URLs.
3. **Scale-From-Zero Latency**: With `min_instance_count = 0`, the first request after an idle period incurs a cold start of approximately 2-4 seconds while the container initializes Node.js and SDK clients.
4. **Vertex AI Global Availability**: Vertex AI Gemini 3.8 Flash uses location `global`. Any network interruption or quota contention in the global endpoint could cause `/api/summarize` requests to return HTTP 500.

---

## Required Code Changes

1. **`package.json`**:
   Add dependencies `@google-cloud/firestore`, `@google-cloud/storage`, and `archiver`.
2. **`server.js` - Health Route**:
   Register `app.get('/healthz', (req, res) => res.status(200).json({ status: 'ok' }))` before all other routes.
3. **`server.js` - Firestore Persistence**:
   Initialize `@google-cloud/firestore` with `projectId: process.env.GCP_PROJECT` and `databaseId: process.env.FIRESTORE_DATABASE_ID`. Replace in-memory `notes = []` with Firestore operations for `GET /api/notes`, `POST /api/notes`, and `DELETE /api/notes/:id`.
4. **`server.js` - Cloud Storage for Files & Pure JS Archiver**:
   Initialize `@google-cloud/storage` pointing to `process.env.GCS_BUCKET_NAME`. Replace multer disk storage with memory storage. Upload files directly to GCS in `POST /api/upload`, stream files from GCS in `GET /api/files/:name`, and stream zip archives using `archiver` in `GET /api/export` (removing reliance on `child_process.execFile('zip')`).
5. **`server.js` - Vertex AI Gemini Integration**:
   Remove `GEMINI_API_KEY` validation in `POST /api/summarize`. Instantiate `GoogleGenAI` with `{ vertexai: true, project: process.env.GCP_PROJECT || 'vibe2prod-509620', location: 'global' }`.

---
Written by the Vibe2Prod Architect agent; independent critic approved after 1 round(s). A human approves before Terraform is written.
