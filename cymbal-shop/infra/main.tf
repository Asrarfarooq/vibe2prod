resource "google_firestore_database" "database" {
  name                    = local.name
  location_id             = local.region
  type                    = "FIRESTORE_NATIVE"
  concurrency_mode        = "OPTIMISTIC"
  deletion_policy         = "DELETE"
  delete_protection_state = "DELETE_PROTECTION_DISABLED"
}

resource "google_storage_bucket" "uploads" {
  name                        = "${local.name}-${local.project}"
  location                    = upper(local.region)
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

resource "google_secret_manager_secret_iam_member" "admin_token_accessor" {
  secret_id = google_secret_manager_secret.admin_token.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${local.runtime_sa}"
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

resource "google_project_iam_member" "firestore_user" {
  project = local.project
  role    = "roles/datastore.user"
  member  = "serviceAccount:${local.runtime_sa}"

  condition {
    title       = "scoped_to_database"
    description = "Grants datastore.user only to the dedicated Firestore database"
    expression  = "resource.name == \"projects/${local.project}/databases/${google_firestore_database.database.name}\""
  }
}

resource "google_cloud_run_v2_service" "service" {
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
      max_instance_count = 3
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
        container_port = 8000
      }

      env {
        name  = "NODE_ENV"
        value = "production"
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
        name  = "VERTEX_AI_LOCATION"
        value = "global"
      }

      env {
        name  = "GEMINI_MODEL"
        value = "gemini-3.8-flash"
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

      startup_probe {
        initial_delay_seconds = 2
        period_seconds        = 5
        failure_threshold     = 6

        http_get {
          path = "/api/health"
          port = 8000
        }
      }

      liveness_probe {
        period_seconds    = 15
        failure_threshold = 3

        http_get {
          path = "/api/health"
          port = 8000
        }
      }
    }
  }

  depends_on = [
    google_secret_manager_secret_version.admin_token,
    google_secret_manager_secret_iam_member.admin_token_accessor,
    google_project_iam_member.firestore_user,
    google_storage_bucket_iam_member.bucket_viewer,
    google_storage_bucket_iam_member.bucket_creator,
  ]
}

resource "google_logging_metric" "errors" {
  name   = "${local.name}-errors"
  filter = "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"${google_cloud_run_v2_service.service.name}\" AND severity>=ERROR"

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
  }
}

resource "google_monitoring_alert_policy" "alert_5xx" {
  display_name = "${local.name} 5xx responses"
  combiner     = "OR"

  conditions {
    display_name = "Cloud Run 5xx Request Count"

    condition_threshold {
      filter          = "resource.type = \"cloud_run_revision\" AND resource.labels.service_name = \"${google_cloud_run_v2_service.service.name}\" AND metric.type = \"run.googleapis.com/request_count\" AND metric.labels.response_code_class = \"5xx\""
      comparison      = "COMPARISON_GT"
      threshold_value = 5
      duration        = "0s"

      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_SUM"
        cross_series_reducer = "REDUCE_SUM"
      }
    }
  }
}
