output "service_url" {
  value       = google_cloud_run_v2_service.app.uri
  description = "The Cloud Run service URI"
}

output "firestore_database_name" {
  value       = google_firestore_database.database.name
  description = "The Firestore database name"
}

output "bucket_name" {
  value       = google_storage_bucket.uploads.name
  description = "The Cloud Storage bucket name"
}

output "secret_id" {
  value       = google_secret_manager_secret.admin_token.secret_id
  description = "The Secret Manager secret ID for the admin token"
}
