# ── Images ────────────────────────────────────────────────────────────────

resource "google_artifact_registry_repository" "images" {
  repository_id = "stratum"
  location      = var.region
  format        = "DOCKER"
  description   = "Stratum images built from source for the ${var.env} environment"

  cleanup_policies {
    id     = "keep-recent"
    action = "KEEP"
    most_recent_versions {
      keep_count = 10
    }
  }

  depends_on = [google_project_service.this]
}

# Cloud Build runs as a dedicated service account with only what a build
# needs, instead of the project's default compute identity.
resource "google_service_account" "build" {
  account_id   = "${local.name}-build"
  display_name = "Stratum ${var.env} image builds"
}

resource "google_artifact_registry_repository_iam_member" "build" {
  repository = google_artifact_registry_repository.images.name
  location   = var.region
  role       = "roles/artifactregistry.writer"
  member     = "serviceAccount:${google_service_account.build.email}"
}

resource "google_project_iam_member" "build" {
  for_each = toset([
    "roles/logging.logWriter",
    "roles/storage.objectViewer", # read the uploaded source archive
  ])
  project = var.project_id
  role    = each.value
  member  = "serviceAccount:${google_service_account.build.email}"
}

# ── Workload identities ───────────────────────────────────────────────────
# The control plane (and its migration/bootstrap jobs) reaches Cloud SQL
# through the Cloud SQL Auth Proxy, authorised by IAM. The gateway needs no
# Google permissions at all.

resource "google_project_iam_member" "control_plane" {
  for_each = toset([
    "roles/cloudsql.client",
    "roles/cloudsql.instanceUser",
  ])
  project = var.project_id
  role    = each.value
  member  = local.wi_principal.control_plane

  depends_on = [google_container_cluster.this]
}
