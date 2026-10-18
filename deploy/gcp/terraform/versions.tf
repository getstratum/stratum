terraform {
  required_version = ">= 1.6"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 8.6"
    }
    # Only for Memorystore's token authentication (TOKEN_AUTH), which the
    # google provider does not accept yet.
    google-beta = {
      source  = "hashicorp/google-beta"
      version = "~> 8.6"
    }
  }

  # Local state is fine for a throwaway test environment run from Cloud Shell.
  # For anything that lives longer, copy backend.tf.example to backend.tf.
}

provider "google" {
  project = var.project_id
  region  = var.region

  # Bill API quota to this project. Needed for the budget API with user
  # credentials (Cloud Shell), harmless for everything else.
  user_project_override = true
  billing_project       = var.project_id

  default_labels = local.labels
}

provider "google-beta" {
  project               = var.project_id
  region                = var.region
  user_project_override = true
  billing_project       = var.project_id
  default_labels        = local.labels
}

data "google_project" "this" {
  project_id = var.project_id
}

locals {
  name = "stratum-${var.env}"

  labels = {
    app        = "stratum"
    env        = var.env
    managed-by = "terraform"
  }

  # Without a domain, use sslip.io: <a-b-c-d>.sslip.io resolves to a.b.c.d,
  # so a Google-managed certificate can be issued with no DNS setup.
  host = var.domain != "" ? var.domain : "${replace(google_compute_global_address.edge.address, ".", "-")}.sslip.io"

  # Kubernetes service accounts that act as Google identities through
  # Workload Identity Federation (no Google service account keys anywhere).
  wi_pool = "${var.project_id}.svc.id.goog"
  wi_principal = {
    control_plane = "principal://iam.googleapis.com/projects/${data.google_project.this.number}/locations/global/workloadIdentityPools/${local.wi_pool}/subject/ns/${var.namespace}/sa/stratum-control-plane"
  }
}
