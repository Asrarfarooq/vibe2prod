resource "random_password" "cookie_secret" {
  length  = 32
  special = false
}

resource "google_secret_manager_secret" "cookie_secret" {
  secret_id = "${local.name}-cookie-secret"

  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_version" "cookie_secret_version" {
  secret      = google_secret_manager_secret.cookie_secret.id
  secret_data = random_password.cookie_secret.result
}

resource "google_secret_manager_secret_iam_member" "cookie_secret_accessor" {
  secret_id = google_secret_manager_secret.cookie_secret.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${local.runtime_sa}"
}

resource "random_password" "hmac_secret" {
  length  = 32
  special = false
}

resource "google_secret_manager_secret" "hmac_secret" {
  secret_id = "${local.name}-hmac-secret"

  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_version" "hmac_secret_version" {
  secret      = google_secret_manager_secret.hmac_secret.id
  secret_data = random_password.hmac_secret.result
}

resource "google_secret_manager_secret_iam_member" "hmac_secret_accessor" {
  secret_id = google_secret_manager_secret.hmac_secret.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${local.runtime_sa}"
}

resource "google_cloud_run_v2_service" "main" {
  name                 = local.name
  location             = local.region
  deletion_protection  = false
  ingress              = "INGRESS_TRAFFIC_ALL"
  invoker_iam_disabled = true

  template {
    service_account                  = local.runtime_sa
    timeout                          = "300s"
    max_instance_request_concurrency = 80

    scaling {
      min_instance_count = 0
      max_instance_count = 1
    }

    containers {
      image = var.image

      resources {
        limits = {
          cpu    = "2"
          memory = "2Gi"
        }
        startup_cpu_boost = true
      }

      ports {
        container_port = 8080
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
        name  = "VERTEX_AI_LOCATION"
        value = "global"
      }

      env {
        name  = "ALLOWED_ORIGINS"
        value = "*"
      }

      env {
        name = "COOKIE_SECRET"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.cookie_secret.secret_id
            version = "latest"
          }
        }
      }

      env {
        name = "HMAC_SECRET"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.hmac_secret.secret_id
            version = "latest"
          }
        }
      }

      startup_probe {
        initial_delay_seconds = 10
        period_seconds        = 5
        timeout_seconds       = 5
        failure_threshold     = 30
        http_get {
          path = "/health"
          port = 8080
        }
      }

      liveness_probe {
        initial_delay_seconds = 30
        period_seconds        = 15
        timeout_seconds       = 5
        failure_threshold     = 3
        http_get {
          path = "/health"
          port = 8080
        }
      }
    }
  }

  depends_on = [
    google_secret_manager_secret_version.cookie_secret_version,
    google_secret_manager_secret_version.hmac_secret_version,
    google_secret_manager_secret_iam_member.cookie_secret_accessor,
    google_secret_manager_secret_iam_member.hmac_secret_accessor
  ]
}

resource "google_logging_metric" "errors" {
  name   = "${local.name}-errors"
  filter = "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"${google_cloud_run_v2_service.main.name}\" AND severity>=ERROR"

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
  }
}

resource "google_monitoring_alert_policy" "alert_policy" {
  display_name = "${local.name} 5xx responses"
  combiner     = "OR"

  conditions {
    display_name = "5xx responses threshold"
    condition_threshold {
      filter          = "resource.type = \"cloud_run_revision\" AND resource.labels.service_name = \"${google_cloud_run_v2_service.main.name}\" AND metric.type = \"run.googleapis.com/request_count\" AND metric.labels.response_code_class = \"5xx\""
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
