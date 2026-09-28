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

resource "google_secret_manager_secret_iam_member" "admin_token_accessor" {
  secret_id = google_secret_manager_secret.admin_token.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${local.runtime_sa}"
}

resource "google_firestore_database" "database" {
  name                    = local.name
  location_id             = local.region
  type                    = "FIRESTORE_NATIVE"
  deletion_policy         = "DELETE"
  delete_protection_state = "DELETE_PROTECTION_DISABLED"
}

resource "google_project_iam_member" "datastore_user" {
  project = local.project
  role    = "roles/datastore.user"
  member  = "serviceAccount:${local.runtime_sa}"

  condition {
    title       = "app_vibed_app_3_firestore_access"
    description = "Scoped to database"
    expression  = "resource.name == \"projects/${local.project}/databases/${google_firestore_database.database.name}\""
  }
}

resource "google_storage_bucket" "uploads" {
  name                        = "${local.name}-${local.project}"
  location                    = upper(local.region)
  storage_class               = "STANDARD"
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = true
}

resource "google_storage_bucket_iam_member" "bucket_viewer" {
  bucket = google_storage_bucket.uploads.name
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:${local.runtime_sa}"
}

resource "google_storage_bucket_iam_member" "bucket_creator" {
  bucket = google_storage_bucket.uploads.name
  role   = "roles/storage.objectCreator"
  member = "serviceAccount:${local.runtime_sa}"
}

resource "google_cloud_run_v2_service" "app" {
  name                 = local.name
  location             = local.region
  deletion_protection  = false
  ingress              = "INGRESS_TRAFFIC_ALL"
  invoker_iam_disabled = true

  template {
    service_account                  = local.runtime_sa
    max_instance_request_concurrency = 80
    timeout                          = "60s"

    scaling {
      min_instance_count = 0
      max_instance_count = 5
    }

    containers {
      image = var.image

      resources {
        limits = {
          cpu    = "1"
          memory = "512Mi"
        }
      }

      ports {
        container_port = 3000
      }

      startup_probe {
        initial_delay_seconds = 2
        period_seconds        = 5
        failure_threshold     = 3
        http_get {
          path = "/health"
          port = 3000
        }
      }

      liveness_probe {
        period_seconds    = 15
        failure_threshold = 3
        http_get {
          path = "/health"
          port = 3000
        }
      }

      env {
        name  = "NODE_ENV"
        value = "production"
      }

      env {
        name  = "PORT"
        value = "3000"
      }

      env {
        name  = "ALLOWED_ORIGINS"
        value = "*"
      }

      env {
        name  = "GOOGLE_CLOUD_PROJECT"
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
    google_secret_manager_secret_iam_member.admin_token_accessor,
    google_project_iam_member.datastore_user,
    google_storage_bucket_iam_member.bucket_viewer,
    google_storage_bucket_iam_member.bucket_creator,
  ]
}
