output "project_id" {
  value = var.project_id
}

output "region" {
  value = var.region
}

output "namespace" {
  value = var.namespace
}

output "cluster_name" {
  value = google_container_cluster.this.name
}

output "host" {
  description = "Public hostname for the gateway API and the console."
  value       = local.host
}

output "edge_ip" {
  value = google_compute_global_address.edge.address
}

output "edge_ip_name" {
  value = google_compute_global_address.edge.name
}

output "egress_ip" {
  description = "Fixed outbound address of the environment (Cloud NAT). Give it to providers or customers that allowlist callers."
  value       = google_compute_address.nat.address
}

output "certificate_map" {
  value = google_certificate_manager_certificate_map.edge.name
}

output "certificate_name" {
  value = google_certificate_manager_certificate.edge.name
}

output "ssl_policy" {
  value = google_compute_ssl_policy.edge.name
}

output "armor_api_policy" {
  value = google_compute_security_policy.api.name
}

output "armor_console_policy" {
  value = google_compute_security_policy.console.name
}

output "armor_sync_policy" {
  value = google_compute_security_policy.sync.name
}

output "image_repo" {
  value = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.images.repository_id}"
}

output "build_service_account" {
  value = google_service_account.build.id
}

output "sql_instance" {
  value = google_sql_database_instance.cp.name
}

output "sql_connection_name" {
  value = google_sql_database_instance.cp.connection_name
}

output "sql_database" {
  value = google_sql_database.stratum.name
}

output "valkey_instance" {
  value = google_memorystore_instance.quota.instance_id
}

output "valkey_address" {
  value = "${local.valkey_primary.ip_address}:${local.valkey_primary.port}"
}

output "secret_prefix" {
  description = "Secret Manager names created by the scripts start with this."
  value       = local.name
}
