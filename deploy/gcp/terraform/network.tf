# One VPC, private by default. Nodes have no public IPs; outbound traffic
# (LLM providers, Docker Hub) leaves through Cloud NAT with a fixed address
# that providers or customers can allowlist.

resource "google_compute_network" "vpc" {
  name                    = local.name
  auto_create_subnetworks = false
  routing_mode            = "REGIONAL"

  depends_on = [google_project_service.this]
}

resource "google_compute_subnetwork" "gke" {
  name                     = "${local.name}-gke"
  network                  = google_compute_network.vpc.id
  region                   = var.region
  ip_cidr_range            = "10.10.0.0/20"
  private_ip_google_access = true

  secondary_ip_range {
    range_name    = "pods"
    ip_cidr_range = "10.32.0.0/14"
  }
  secondary_ip_range {
    range_name    = "services"
    ip_cidr_range = "10.36.0.0/20"
  }
}

# Private Service Connect endpoints for Memorystore are allocated here.
resource "google_compute_subnetwork" "psc" {
  name                     = "${local.name}-psc"
  network                  = google_compute_network.vpc.id
  region                   = var.region
  ip_cidr_range            = "10.10.32.0/24"
  private_ip_google_access = true
}

# Private services access (VPC peering) for Cloud SQL private IP.
resource "google_compute_global_address" "psa" {
  name          = "${local.name}-psa"
  network       = google_compute_network.vpc.id
  purpose       = "VPC_PEERING"
  address_type  = "INTERNAL"
  address       = "10.40.0.0" # fixed, so it cannot land on the subnets above
  prefix_length = 20
}

resource "google_service_networking_connection" "psa" {
  network                 = google_compute_network.vpc.id
  service                 = "servicenetworking.googleapis.com"
  reserved_peering_ranges = [google_compute_global_address.psa.name]
  # Deleting the peering often fails while Cloud SQL is still releasing it;
  # abandoning it lets destroy finish, and it goes away with the network.
  deletion_policy = "ABANDON"
}

resource "google_compute_router" "nat" {
  name    = "${local.name}-nat"
  network = google_compute_network.vpc.id
  region  = var.region
}

resource "google_compute_address" "nat" {
  name   = "${local.name}-nat"
  region = var.region
}

resource "google_compute_router_nat" "nat" {
  name                               = "${local.name}-nat"
  router                             = google_compute_router.nat.name
  region                             = var.region
  nat_ip_allocate_option             = "MANUAL_ONLY"
  nat_ips                            = [google_compute_address.nat.self_link]
  source_subnetwork_ip_ranges_to_nat = "ALL_SUBNETWORKS_ALL_IP_RANGES"

  # Many concurrent long-lived connections to a few provider endpoints:
  # allocate ports dynamically instead of a small fixed slice per node.
  enable_dynamic_port_allocation      = true
  enable_endpoint_independent_mapping = false
  min_ports_per_vm                    = 1024
  max_ports_per_vm                    = 32768
  tcp_established_idle_timeout_sec    = 1200

  log_config {
    enable = true
    filter = "ERRORS_ONLY"
  }
}
