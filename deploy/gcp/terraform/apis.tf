locals {
  services = [
    "artifactregistry.googleapis.com",
    "certificatemanager.googleapis.com",
    "cloudbuild.googleapis.com",
    "cloudresourcemanager.googleapis.com",
    "compute.googleapis.com",
    "container.googleapis.com",
    "iam.googleapis.com",
    "logging.googleapis.com",
    "memorystore.googleapis.com",
    "monitoring.googleapis.com",
    "networkconnectivity.googleapis.com",
    "secretmanager.googleapis.com",
    "servicenetworking.googleapis.com",
    "sqladmin.googleapis.com",
  ]
}

resource "google_project_service" "this" {
  for_each = toset(concat(local.services, var.billing_account != "" ? ["billingbudgets.googleapis.com"] : []))

  service = each.value
  # Leave APIs enabled on destroy: disabling them can break other things in
  # the project and gains nothing.
  disable_on_destroy = false
}
