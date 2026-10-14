# SLO alerting on Google Cloud Managed Service for Prometheus (enabled by
# default on Autopilot; deploy/gcp/k8s/monitoring.yaml scrapes the gateway).
#
# SLO: 99.99% of requests answered without an error attributable to Stratum
# (gateway 5xx other than provider errors passed through). Error budget
# 0.01%. Multi-window burn-rate alerts, as in the Google SRE workbook:
#   fast: 14.4x budget over 1h and 5m  -> 2% of the monthly budget in 1h
#   slow:  6x  budget over 6h and 30m  -> 5% of the monthly budget in 6h

resource "google_monitoring_notification_channel" "email" {
  count        = var.alert_email != "" ? 1 : 0
  display_name = "Stratum ${var.env} on-call"
  type         = "email"
  labels = {
    email_address = var.alert_email
  }

  depends_on = [google_project_service.this]
}

locals {
  channels = google_monitoring_notification_channel.email[*].id

  # Error ratio over a window, attributable to Stratum.
  err = "sum(rate(stratum_requests_total{namespace=\"${var.namespace}\",code=~\"5..\",reason!=\"upstream_status\"}[%s])) / sum(rate(stratum_requests_total{namespace=\"${var.namespace}\"}[%s]))"

  alerts = {
    slo-fast-burn = {
      display  = "Stratum ${var.env}: fast error-budget burn (14.4x)"
      query    = "(${format(local.err, "1h", "1h")}) > (14.4 * 0.0001) and (${format(local.err, "5m", "5m")}) > (14.4 * 0.0001)"
      duration = "120s"
      severity = "CRITICAL"
      doc      = "The gateway is failing requests fast enough to spend 2% of the monthly error budget in an hour. Check `kubectl -n ${var.namespace} get pods`, the gateway logs and `stratum_requests_total` by reason."
    }
    slo-slow-burn = {
      display  = "Stratum ${var.env}: slow error-budget burn (6x)"
      query    = "(${format(local.err, "6h", "6h")}) > (6 * 0.0001) and (${format(local.err, "30m", "30m")}) > (6 * 0.0001)"
      duration = "900s"
      severity = "WARNING"
      doc      = "Sustained errors at 6x the budget rate."
    }
    snapshot-stale = {
      display  = "Stratum ${var.env}: gateway configuration is stale"
      query    = "max(stratum_snapshot_age_seconds{namespace=\"${var.namespace}\"}) > 900"
      duration = "300s"
      severity = "WARNING"
      doc      = "Gateways have not synced with the control plane for 15 minutes. They keep serving the last good configuration; changes and revocations are not being applied."
    }
    quota-store-down = {
      display  = "Stratum ${var.env}: shared quota store unreachable"
      query    = "max(stratum_quota_store_age_seconds{namespace=\"${var.namespace}\"}) > 120"
      duration = "120s"
      severity = "WARNING"
      doc      = "Gateways cannot reach Valkey. Requests are unaffected; quotas are enforced per replica until it returns."
    }
    quota-store-reset = {
      display  = "Stratum ${var.env}: quota counters went backwards"
      query    = "sum(increase(stratum_quota_store_regressions_total{namespace=\"${var.namespace}\"}[10m])) > 0"
      duration = "0s"
      severity = "WARNING"
      doc      = "Valkey returned lower totals than before: it lost data (restart without persistence) or someone reset the counters."
    }
  }
}

resource "google_monitoring_alert_policy" "stratum" {
  for_each = local.alerts

  display_name          = each.value.display
  combiner              = "OR"
  severity              = each.value.severity
  notification_channels = local.channels

  conditions {
    display_name = each.value.display
    condition_prometheus_query_language {
      query               = each.value.query
      duration            = each.value.duration
      evaluation_interval = "60s"
    }
  }

  documentation {
    content   = each.value.doc
    mime_type = "text/markdown"
  }

  user_labels = local.labels

  depends_on = [google_project_service.this]
}

# Black-box check from Google's probes in several continents, through the
# whole edge (DNS, TLS, load balancer, gateway readiness).
resource "google_monitoring_uptime_check_config" "gateway" {
  display_name = "Stratum ${var.env} gateway /readyz"
  timeout      = "10s"
  period       = "60s"

  http_check {
    path         = "/readyz"
    port         = 443
    use_ssl      = true
    validate_ssl = true
  }

  monitored_resource {
    type = "uptime_url"
    labels = {
      project_id = var.project_id
      host       = local.host
    }
  }

  depends_on = [google_project_service.this]
}

resource "google_monitoring_alert_policy" "uptime" {
  display_name          = "Stratum ${var.env}: gateway unreachable from the internet"
  combiner              = "OR"
  severity              = "CRITICAL"
  notification_channels = local.channels

  conditions {
    display_name = "Uptime check failing from 2+ regions"
    condition_threshold {
      filter          = "metric.type=\"monitoring.googleapis.com/uptime_check/check_passed\" AND resource.type=\"uptime_url\" AND metric.label.check_id=\"${google_monitoring_uptime_check_config.gateway.uptime_check_id}\""
      comparison      = "COMPARISON_GT"
      threshold_value = 1
      duration        = "120s"
      aggregations {
        alignment_period     = "120s"
        per_series_aligner   = "ALIGN_NEXT_OLDER"
        cross_series_reducer = "REDUCE_COUNT_FALSE"
        group_by_fields      = ["resource.label.project_id"]
      }
    }
  }

  user_labels = local.labels
}

# ── Cost guardrail ────────────────────────────────────────────────────────

resource "google_billing_budget" "project" {
  count           = var.billing_account != "" ? 1 : 0
  billing_account = var.billing_account
  display_name    = "Stratum ${var.env} (${var.project_id})"

  budget_filter {
    projects = ["projects/${data.google_project.this.number}"]
  }

  amount {
    specified_amount {
      currency_code = "USD"
      units         = tostring(var.budget_amount_usd)
    }
  }

  dynamic "threshold_rules" {
    for_each = [0.5, 0.9, 1.0]
    content {
      threshold_percent = threshold_rules.value
    }
  }

  depends_on = [google_project_service.this]
}
