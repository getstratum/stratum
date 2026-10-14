# Edge: global external Application Load Balancer (created by the GKE
# Gateway controller from deploy/gcp/k8s/edge.yaml), with the pieces it
# references created here: static anycast IP, Google-managed certificate,
# TLS policy and Cloud Armor policies.

resource "google_compute_global_address" "edge" {
  name = "${local.name}-edge"

  depends_on = [google_project_service.this]
}

# Load-balancer authorization: Google issues the certificate once the
# hostname resolves to the edge IP and the load balancer serves it. Takes
# 15-60 minutes after the Gateway exists; scripts/deploy.sh creates the
# Gateway first so this overlaps with the image builds.
resource "google_certificate_manager_certificate" "edge" {
  name  = "${local.name}-edge"
  scope = "DEFAULT"

  managed {
    domains = [local.host]
  }
}

resource "google_certificate_manager_certificate_map" "edge" {
  name = "${local.name}-edge"
}

resource "google_certificate_manager_certificate_map_entry" "edge" {
  name         = "${local.name}-edge"
  map          = google_certificate_manager_certificate_map.edge.name
  hostname     = local.host
  certificates = [google_certificate_manager_certificate.edge.id]
}

resource "google_compute_ssl_policy" "edge" {
  name            = "${local.name}-tls"
  profile         = "MODERN"
  min_tls_version = "TLS_1_2"
}

# ── Cloud Armor ───────────────────────────────────────────────────────────
#
# No preconfigured WAF (OWASP CRS) rules on the API: prompts routinely
# contain SQL, shell and HTML, which those signatures block. Content
# inspection is the gateway's job (PII/secrets policies). At the edge:
# per-IP rate limiting for the API, and allowlists for the console and the
# sync endpoint.

resource "google_compute_security_policy" "api" {
  name        = "${local.name}-api"
  description = "Gateway API: per-client-IP rate limit"
  type        = "CLOUD_ARMOR"

  rule {
    priority    = 900
    action      = "allow"
    description = "This environment's own egress (load tests) is not rate limited"
    match {
      versioned_expr = "SRC_IPS_V1"
      config {
        src_ip_ranges = ["${google_compute_address.nat.address}/32"]
      }
    }
  }

  rule {
    priority    = 1000
    action      = "throttle"
    description = "Per-IP rate limit"
    match {
      versioned_expr = "SRC_IPS_V1"
      config {
        src_ip_ranges = ["*"]
      }
    }
    rate_limit_options {
      conform_action = "allow"
      exceed_action  = "deny(429)"
      enforce_on_key = "IP"
      rate_limit_threshold {
        count        = var.api_rate_limit_per_minute
        interval_sec = 60
      }
    }
  }

  rule {
    priority    = 2147483647
    action      = "allow"
    description = "Default"
    match {
      versioned_expr = "SRC_IPS_V1"
      config {
        src_ip_ranges = ["*"]
      }
    }
  }
}

resource "google_compute_security_policy" "console" {
  name        = "${local.name}-console"
  description = "Console: operators only"
  type        = "CLOUD_ARMOR"

  rule {
    priority    = 1000
    action      = "allow"
    description = "Operators"
    match {
      versioned_expr = "SRC_IPS_V1"
      config {
        src_ip_ranges = var.console_allowed_cidrs
      }
    }
  }

  rule {
    priority    = 2147483647
    action      = "deny(403)"
    description = "Default deny"
    match {
      versioned_expr = "SRC_IPS_V1"
      config {
        src_ip_ranges = ["*"]
      }
    }
  }
}

# Gateways sync over the public HTTPS endpoint, exactly as a customer's
# gateway would against a managed control plane. Only known gateway egress
# addresses may call it: here, this environment's Cloud NAT IP.
resource "google_compute_security_policy" "sync" {
  name        = "${local.name}-sync"
  description = "Gateway sync endpoint: registered gateway egress IPs only"
  type        = "CLOUD_ARMOR"

  rule {
    priority    = 1000
    action      = "allow"
    description = "Gateway egress (Cloud NAT) and operators"
    match {
      versioned_expr = "SRC_IPS_V1"
      config {
        src_ip_ranges = concat(["${google_compute_address.nat.address}/32"], var.console_allowed_cidrs)
      }
    }
  }

  rule {
    priority    = 2147483647
    action      = "deny(403)"
    description = "Default deny"
    match {
      versioned_expr = "SRC_IPS_V1"
      config {
        src_ip_ranges = ["*"]
      }
    }
  }
}
