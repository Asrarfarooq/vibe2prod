output "service_url" {
  description = "The URL of the Cloud Run service"
  value       = google_cloud_run_v2_service.service.uri
}

output "firestore_database_name" {
  description = "The Firestore database name"
  value       = google_firestore_database.database.name
}

output "storage_bucket_name" {
  description = "The Cloud Storage bucket name"
  value       = google_storage_bucket.uploads.name
}

output "secret_id" {
  description = "The Secret Manager secret ID for admin token"
  value       = google_secret_manager_secret.admin_token.secret_id
}
