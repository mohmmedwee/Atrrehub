variable "name" {
  description = "Prefix for every resource. One deployment per name."
  type        = string
  default     = "atrrehub"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,20}$", var.name))
    error_message = "Lowercase letters, digits and hyphens, 2-21 characters — the limit RDS identifiers impose."
  }
}

variable "region" {
  description = "AWS region."
  type        = string
}

variable "vpc_cidr" {
  description = "CIDR for the VPC. Large enough for three availability zones."
  type        = string
  default     = "10.42.0.0/16"
}

variable "availability_zones" {
  description = "Three AZs. RDS Multi-AZ and ElastiCache both want at least two; three survives one being unavailable at create time."
  type        = list(string)

  validation {
    condition     = length(var.availability_zones) >= 2
    error_message = "At least two availability zones are required for a Multi-AZ database."
  }
}

# ── Database ─────────────────────────────────────────────────────────────────

variable "postgres_version" {
  description = "Major version. pgvector needs 15 or newer to be available as an extension."
  type        = string
  default     = "16"
}

variable "db_instance_class" {
  description = "Writer instance class."
  type        = string
  default     = "db.r6g.large"
}

variable "db_allocated_storage_gb" {
  type    = number
  default = 100
}

variable "db_max_allocated_storage_gb" {
  description = "Storage autoscaling ceiling. Set equal to allocated to disable it."
  type        = number
  default     = 1000
}

variable "db_replica_count" {
  description = <<-EOT
    Read replicas. The application routes analytics and report queries to one
    when DATABASE_REPLICA_URL is set; zero is a valid single-node deployment.
  EOT
  type        = number
  default     = 1

  validation {
    condition     = var.db_replica_count >= 0 && var.db_replica_count <= 5
    error_message = "Between 0 and 5 replicas."
  }
}

variable "db_backup_retention_days" {
  description = "Automated backup retention. The platform takes its own logical backups as well; this is the point-in-time restore window."
  type        = number
  default     = 14
}

variable "db_deletion_protection" {
  description = "Refuse to destroy the database. Turn it off deliberately, and only for a deployment you mean to discard."
  type        = bool
  default     = true
}

# ── Cache ────────────────────────────────────────────────────────────────────

variable "redis_node_type" {
  type    = string
  default = "cache.t4g.medium"
}

variable "redis_replica_count" {
  description = "Replicas per shard. One gives automatic failover; zero does not."
  type        = number
  default     = 1
}

# ── Storage ──────────────────────────────────────────────────────────────────

variable "storage_retention_days" {
  description = "Lifecycle expiry for uploaded objects. Zero keeps them indefinitely."
  type        = number
  default     = 0
}

variable "tags" {
  description = "Applied to everything."
  type        = map(string)
  default     = {}
}
