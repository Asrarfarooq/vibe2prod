output "service_url" {
  description = "The Cloud Run service URI"
  value       = google_cloud_run_v2_service.main.uri
}

output "service_name" {
  description = "The Cloud Run service name"
  value       = google_cloud_run_v2_service.main.name
}

output "cookie_secret_id" {
  description = "The Secret Manager cookie secret ID"
  value       = google_secret_manager_secret.cookie_secret.secret_id
}

output "hmac_secret_id" {
  description = "The Secret Manager HMAC secret ID"
  value       = google_secret_manager_secret.hmac_secret.secret_id
}
