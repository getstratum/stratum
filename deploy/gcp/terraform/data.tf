# State stores: PostgreSQL for the control plane, Valkey for shared quota
# counters. Both private, both replicated across zones with automatic
# failover. Neither is on the gateway's request path.

# ── Cloud SQL for PostgreSQL ──────────────────────────────────────────────

resource "google_sql_database_instance" "cp" {
  name                = "${local.name}-${var.suffix}"
  database_version    = "POSTGRES_16"
  region              = var.region
  deletion_protection = false

  settings {
    edition           = "ENTERPRISE"
    tier              = var.cloudsql_tier
    availability_type = var.cloudsql_ha ? "REGIONAL" : "ZONAL"
    disk_type         = "PD_SSD"
    disk_size         = 10
    disk_autoresize   = true

    deletion_protection_enabled = false
    user_labels                 = local.labels

    ip_configuration {
      ipv4_enabled    = false
      private_network = google_compute_network.vpc.id
      ssl_mode        = "ENCRYPTED_ONLY"
    }

    backup_configuration {
      enabled                        = true
      point_in_time_recovery_enabled = true
      start_time                     = "07:00"
      transaction_log_retention_days = 7

      backup_retention_settings {
        retained_backups = 7
      }
    }

    maintenance_window {
      day          = 7 # Sunday
      hour         = 8 # UTC
      update_track = "stable"
    }

    insights_config {
      query_insights_enabled = true
    }
  }

  depends_on = [google_service_networking_connection.psa]
}

resource "google_sql_database" "stratum" {
  name     = "stratum"
  instance = google_sql_database_instance.cp.name
}

# The database user is created by scripts/deploy.sh with a generated
# password kept in Secret Manager, so the password never lands in the
# Terraform state.

# ── Memorystore for Valkey ────────────────────────────────────────────────

resource "google_network_connectivity_service_connection_policy" "valkey" {
  name          = "${local.name}-memorystore"
  location      = var.region
  service_class = "gcp-memorystore"
  network       = google_compute_network.vpc.id

  psc_config {
    subnetworks = [google_compute_subnetwork.psc.id]
  }

  depends_on = [google_project_service.this]
}

resource "google_memorystore_instance" "quota" {
  provider      = google-beta
  instance_id   = "${local.name}-quota-${var.suffix}"
  location      = var.region
  mode          = "CLUSTER_DISABLED"
  shard_count   = 1
  replica_count = var.valkey_replicas
  node_type     = var.valkey_node_type

  desired_auto_created_endpoints {
    network    = google_compute_network.vpc.id
    project_id = var.project_id
  }

  zone_distribution_config {
    mode = "MULTI_ZONE"
  }

  # Quota counters must survive a restart: append-only file, fsync every second.
  persistence_config {
    mode = "AOF"
    aof_config {
      append_fsync = "EVERY_SEC"
    }
  }

  engine_configs = {
    # Never evict a counter to make room.
    "maxmemory-policy" = "noeviction"
  }

  # Reachable only from this VPC through Private Service Connect, and even
  # so encrypted and authenticated (docs/adr/0011): TLS with a CA of this
  # instance's own, and a token for the default user that gateways send with
  # AUTH. Not IAM authentication: that needs a fresh Google token for every
  # new connection, so a gateway starting during an IAM outage could not
  # reach Valkey, and the gateway would need Google permissions it has none
  # of today. Both settings are immutable: changing them recreates the
  # instance (and empties it).
  authorization_mode      = "TOKEN_AUTH"
  transit_encryption_mode = "SERVER_AUTHENTICATION"
  server_ca_mode          = "GOOGLE_MANAGED_PER_INSTANCE_CA"

  deletion_protection_enabled = false
  labels                      = local.labels

  depends_on = [google_network_connectivity_service_connection_policy.valkey]
}

locals {
  valkey_connections = flatten([
    for e in google_memorystore_instance.quota.endpoints : [
      for c in e.connections : c.psc_auto_connection
    ]
  ])
  valkey_primary = try(
    [for c in local.valkey_connections : c if c.connection_type == "CONNECTION_TYPE_PRIMARY"][0],
    local.valkey_connections[0],
  )
}
