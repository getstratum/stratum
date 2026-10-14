variable "project_id" {
  description = "GCP project. A dedicated project per test environment is recommended: deleting it guarantees nothing keeps billing."
  type        = string
}

variable "region" {
  description = "Region with at least three zones. us-central1 is among the cheapest; southamerica-east1 is closest to the Río de la Plata (about 50% more expensive)."
  type        = string
  default     = "us-central1"
}

variable "env" {
  description = "Short environment name used in resource names and labels."
  type        = string
  default     = "test"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,10}$", var.env))
    error_message = "env must be 2-11 lowercase letters, digits or dashes."
  }
}

variable "suffix" {
  description = "Random suffix for names that cannot be reused for days after deletion (Cloud SQL, Memorystore). scripts/up.sh generates it."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9]{4,8}$", var.suffix))
    error_message = "suffix must be 4-8 lowercase letters or digits."
  }
}

variable "namespace" {
  description = "Kubernetes namespace for Stratum."
  type        = string
  default     = "stratum"
}

variable "domain" {
  description = "Public hostname for the gateway and console. Empty = <ip>.sslip.io (no DNS needed). If you set one, create an A record to the edge IP output."
  type        = string
  default     = ""
}

variable "console_allowed_cidrs" {
  description = "Source ranges allowed to open the console (dashboard). Your workstation's public IP as a /32 (curl -s ifconfig.me)."
  type        = list(string)

  validation {
    condition     = length(var.console_allowed_cidrs) > 0 && length(var.console_allowed_cidrs) <= 10
    error_message = "Give between 1 and 10 CIDR ranges."
  }
}

variable "api_rate_limit_per_minute" {
  description = "Per-client-IP request limit on the gateway API at the edge (Cloud Armor). The environment's own egress IP (load tests) is exempt."
  type        = number
  default     = 1200
}

variable "cloudsql_tier" {
  description = "Cloud SQL machine. Dedicated-core tiers are covered by the SLA; shared-core (db-f1-micro, db-g1-small) are not."
  type        = string
  default     = "db-custom-1-3840"
}

variable "cloudsql_ha" {
  description = "Regional (synchronous standby in another zone). Needed to test database failover."
  type        = bool
  default     = true
}

variable "valkey_node_type" {
  description = "Memorystore for Valkey node type. SHARED_CORE_NANO is enough for a test; use STANDARD_SMALL or larger in production."
  type        = string
  default     = "SHARED_CORE_NANO"
}

variable "valkey_replicas" {
  description = "Replicas of the single Valkey shard, placed in other zones, with automatic failover."
  type        = number
  default     = 1
}

variable "alert_email" {
  description = "Email for alert notifications. Empty = alert policies are created without a notification channel."
  type        = string
  default     = ""
}

variable "metric_alerts" {
  description = "Create the PromQL SLO alerts. Leave false on the first 'make up': Cloud Monitoring rejects alerts on metrics that do not exist yet. Set true and apply again after 'make deploy'."
  type        = bool
  default     = false
}

variable "billing_account" {
  description = "Billing account ID (XXXXXX-XXXXXX-XXXXXX) for a budget alert on this project. Empty = no budget (needs billing.budgets.create on the account)."
  type        = string
  default     = ""
}

variable "budget_amount_usd" {
  description = "Monthly budget for the project; alerts at 50%, 90% and 100%."
  type        = number
  default     = 30
}
