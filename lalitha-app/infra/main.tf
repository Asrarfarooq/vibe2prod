resource "google_cloud_run_v2_service" "app" {
  name                 = local.name
  location             = local.region
  deletion_protection  = false
  ingress              = "INGRESS_TRAFFIC_ALL"
  invoker_iam_disabled = true

  template {
    service_account                  = local.runtime_sa
    timeout                          = "30s"
    max_instance_request_concurrency = 80

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
        cpu_idle = true
      }

      ports {
        container_port = 8080
      }

      env {
        name  = "NODE_ENV"
        value = "production"
      }

      startup_probe {
        initial_delay_seconds = 2
        period_seconds        = 5
        failure_threshold     = 3
        http_get {
          path = "/health"
          port = 8080
        }
      }

      liveness_probe {
        period_seconds    = 15
        timeout_seconds   = 2
        failure_threshold = 3
        http_get {
          path = "/health"
          port = 8080
        }
      }
    }
  }
}
