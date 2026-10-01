output "service_url" {
  description = "The Cloud Run service URI."
  value       = google_cloud_run_v2_service.app.uri
}
