output "service_url" {
  description = "The Cloud Run service URI."
  value       = google_cloud_run_v2_service.service.uri
}

output "firestore_database_id" {
  description = "The Firestore database ID."
  value       = google_firestore_database.database.name
}

output "storage_bucket_name" {
  description = "The Cloud Storage bucket name."
  value       = google_storage_bucket.uploads.name
}

output "secret_id" {
  description = "The Secret Manager secret ID for the admin token."
  value       = google_secret_manager_secret.admin_token.secret_id
}
