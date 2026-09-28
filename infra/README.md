# infra

Reserved for Terraform for the Vibe2Prod platform itself in `vibe2prod-509620`. Empty today: the platform resources (Firestore `(default)`, Artifact Registry repo `vibe2prod`, service accounts, secrets, Developer Connect connection, Cloud Build trigger) were created with gcloud, and the agent jobs are deployed by `../cloudbuild.yaml`.

Terraform for a fixed app is written by the IaC agent into that app's own folder (`<app>/infra/`) on the run branch, not here.
