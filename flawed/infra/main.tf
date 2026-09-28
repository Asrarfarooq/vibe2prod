resource "google_firestore_database" "database" {
  name                    = local.name
  location_id             = local.region
  type                    = "FIRESTORE_NATIVE"
  deletion_policy         = "DELETE"
  delete_protection_state = "DELETE_PROTECTION_DISABLED"
}

resource "google_storage_bucket" "uploads" {
  name                        = "${local.name}-${local.project}"
  location                    = upper(local.region)
  storage_class               = "STANDARD"
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = true
}

resource "random_password" "admin_token" {
  length  = 32
  special = false
}

resource "google_secret_manager_secret" "admin_token" {
  secret_id = "${local.name}-admin-token"

  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_version" "admin_token" {
  secret      = google_secret_manager_secret.admin_token.id
  secret_data = random_password.admin_token.result
}

resource "google_project_iam_member" "datastore_user" {
  project = local.project
  role    = "roles/datastore.user"
  member  = "serviceAccount:${local.runtime_sa}"

  condition {
    title       = "firestore_database_access"
    description = "Allow datastore user access only to dedicated app database"
    expression  = "resource.name == \"projects/${local.project}/databases/${google_firestore_database.database.name}\""
  }
}

resource "google_storage_bucket_iam_member" "storage_user" {
  bucket = google_storage_bucket.uploads.name
  role   = "roles/storage.objectUser"
  member = "serviceAccount:${local.runtime_sa}"
}

resource "google_secret_manager_secret_iam_member" "secret_accessor" {
  secret_id = google_secret_manager_secret.admin_token.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${local.runtime_sa}"
}

resource "google_cloud_run_v2_service" "service" {
  name                 = local.name
  location             = local.region
  deletion_protection  = false
  ingress              = "INGRESS_TRAFFIC_ALL"
  invoker_iam_disabled = true

  template {
    service_account                  = local.runtime_sa
    timeout                          = "60s"
    max_instance_request_concurrency = 80

    scaling {
      min_instance_count = 0
      max_instance_count = 3
    }

    containers {
      image = var.image

      ports {
        container_port = 8080
      }

      resources {
        limits = {
          cpu    = "1"
          memory = "512Mi"
        }
      }

      startup_probe {
        http_get {
          path = "/healthz"
          port = 8080
        }
        period_seconds    = 5
        timeout_seconds   = 2
        failure_threshold = 6
      }

      liveness_probe {
        http_get {
          path = "/healthz"
          port = 8080
        }
        period_seconds    = 15
        timeout_seconds   = 2
        failure_threshold = 3
      }

      env {
        name  = "PORT"
        value = "8080"
      }
      env {
        name  = "NODE_ENV"
        value = "production"
      }
      env {
        name  = "GCP_PROJECT"
        value = local.project
      }
      env {
        name  = "FIRESTORE_DATABASE_ID"
        value = google_firestore_database.database.name
      }
      env {
        name  = "GCS_BUCKET_NAME"
        value = google_storage_bucket.uploads.name
      }
      env {
        name  = "ALLOWED_ORIGINS"
        value = "*"
      }
      env {
        name = "ADMIN_TOKEN"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.admin_token.secret_id
            version = "latest"
          }
        }
      }
    }
  }

  depends_on = [
    google_secret_manager_secret_version.admin_token,
    google_secret_manager_secret_iam_member.secret_accessor
  ]
}
