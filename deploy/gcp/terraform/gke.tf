# GKE Autopilot, regional: the control plane is replicated across zones and
# pods spread across zones are covered by the GKE SLA. Google operates the
# nodes (upgrades, hardening); we pay for pod requests only.

resource "google_service_account" "nodes" {
  account_id   = "${local.name}-nodes"
  display_name = "Stratum ${var.env} GKE nodes (least privilege)"
}

resource "google_project_iam_member" "nodes" {
  for_each = toset([
    "roles/container.defaultNodeServiceAccount",
    "roles/artifactregistry.reader",
  ])
  project = var.project_id
  role    = each.value
  member  = "serviceAccount:${google_service_account.nodes.email}"
}

resource "google_container_cluster" "this" {
  name     = local.name
  location = var.region

  enable_autopilot    = true
  deletion_protection = false

  network    = google_compute_network.vpc.id
  subnetwork = google_compute_subnetwork.gke.id

  ip_allocation_policy {
    cluster_secondary_range_name  = "pods"
    services_secondary_range_name = "services"
  }

  # Private nodes. The Kubernetes API is reached through its DNS endpoint,
  # authorised by IAM; there is no public IP endpoint to allowlist.
  private_cluster_config {
    enable_private_nodes = true
  }
  control_plane_endpoints_config {
    dns_endpoint_config {
      allow_external_traffic = true
    }
    ip_endpoints_config {
      enabled = false
    }
  }

  release_channel {
    channel = "REGULAR"
  }

  gateway_api_config {
    channel = "CHANNEL_STANDARD"
  }

  cluster_autoscaling {
    auto_provisioning_defaults {
      service_account = google_service_account.nodes.email
      oauth_scopes    = ["https://www.googleapis.com/auth/cloud-platform"]
    }
  }

  # Upgrades and maintenance outside business hours in the Americas
  # (UTC times). Weekends only.
  maintenance_policy {
    recurring_window {
      start_time = "2026-01-03T06:00:00Z"
      end_time   = "2026-01-03T12:00:00Z"
      recurrence = "FREQ=WEEKLY;BYDAY=SA,SU"
    }
  }

  resource_labels = local.labels

  depends_on = [google_project_iam_member.nodes]
}
