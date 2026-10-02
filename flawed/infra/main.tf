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
  storage_class               = "STANDARD"
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = true

  lifecycle_rule {
    action {
      type = "Delete"
    }
    condition {
      age = 30
    }
  }
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
    title       = "Scoped to ${local.name} database"
    description = "Grants datastore.user only on the dedicated database"
    expression  = "resource.name == \"projects/${local.project}/databases/${google_firestore_database.database.name}\""
  }
}

resource "google_storage_bucket_iam_member" "storage_viewer" {
  bucket = google_storage_bucket.uploads.name
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:${local.runtime_sa}"
}

resource "google_storage_bucket_iam_member" "storage_creator" {
  bucket = google_storage_bucket.uploads.name
  role   = "roles/storage.objectCreator"
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
  invoker_iam_disabled = true
  ingress              = "INGRESS_TRAFFIC_ALL"

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

      resources {
        limits = {
          cpu    = "1"
          memory = "512Mi"
        }
        cpu_idle          = true
        startup_cpu_boost = true
      }

      ports {
        container_port = 3000
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
    }
  }

  depends_on = [
    google_secret_manager_secret_version.admin_token,
    google_secret_manager_secret_iam_member.secret_accessor,
    google_project_iam_member.datastore_user,
    google_storage_bucket_iam_member.storage_viewer,
    google_storage_bucket_iam_member.storage_creator,
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
    display_name = "Cloud Run 5xx error rate"
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
