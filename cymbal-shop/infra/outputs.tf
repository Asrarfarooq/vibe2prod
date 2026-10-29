output "service_url" {
  description = "The Cloud Run service URL."
  value       = google_cloud_run_v2_service.app_cymbal_shop_2.uri
}

output "firestore_database" {
  description = "The Firestore database name."
  value       = google_firestore_database.app_cymbal_shop_2.name
}

output "admin_token_secret_id" {
  description = "The Secret Manager secret ID for the admin token."
  value       = google_secret_manager_secret.admin_token.secret_id
}
