# Postgres, Redis and object storage.

# ── Postgres ─────────────────────────────────────────────────────────────────

resource "random_password" "database" {
  length = 40
  # RDS rejects '/', '@', '"' and space in a master password, and a password
  # containing them would also have to be escaped in the connection URL the
  # application reads.
  override_special = "!#$%&*()-_=+[]{}<>:?"
}

resource "aws_db_subnet_group" "main" {
  name       = var.name
  subnet_ids = [for subnet in aws_subnet.private : subnet.id]
  tags       = local.tags
}

# pgvector ships with RDS but is not enabled by default. `shared_preload_libraries`
# is not required for it, but the extension must be creatable — the migration
# does `CREATE EXTENSION vector`, which needs rds_superuser, which the master
# user has.
resource "aws_db_parameter_group" "main" {
  name   = "${var.name}-pg${var.postgres_version}"
  family = "postgres${var.postgres_version}"

  parameter {
    name  = "log_min_duration_statement"
    value = "1000"
  }

  # The platform's own connection pooling assumes it is not fighting the
  # database for connection slots.
  parameter {
    name         = "max_connections"
    value        = "LEAST({DBInstanceClassMemory/9531392},5000)"
    apply_method = "pending-reboot"
  }

  lifecycle {
    create_before_destroy = true
  }

  tags = local.tags
}

resource "aws_db_instance" "primary" {
  identifier     = var.name
  engine         = "postgres"
  engine_version = var.postgres_version
  instance_class = var.db_instance_class

  allocated_storage     = var.db_allocated_storage_gb
  max_allocated_storage = var.db_max_allocated_storage_gb
  storage_type          = "gp3"
  storage_encrypted     = true

  db_name  = "atrrehub"
  username = "atrrehub"
  password = random_password.database.result
  port     = 5432

  db_subnet_group_name   = aws_db_subnet_group.main.name
  parameter_group_name   = aws_db_parameter_group.main.name
  vpc_security_group_ids = [aws_security_group.database.id]
  publicly_accessible    = false

  multi_az                = true
  backup_retention_period = var.db_backup_retention_days
  backup_window           = "03:00-04:00"
  maintenance_window      = "sun:04:30-sun:05:30"
  copy_tags_to_snapshot   = true

  # A destroy that silently discards the database is not a mistake anyone
  # should be able to make from a plan they skim.
  deletion_protection       = var.db_deletion_protection
  skip_final_snapshot       = false
  final_snapshot_identifier = "${var.name}-final-${formatdate("YYYYMMDDhhmmss", timestamp())}"

  performance_insights_enabled    = true
  enabled_cloudwatch_logs_exports = ["postgresql"]

  auto_minor_version_upgrade = true
  apply_immediately          = false

  lifecycle {
    # Regenerating this on every plan would show a diff forever.
    ignore_changes = [final_snapshot_identifier]
  }

  tags = local.tags
}

# Read replicas serve the application's analytics and reporting queries. The
# application decides what is safe to read from one; this only provides it.
resource "aws_db_instance" "replica" {
  count = var.db_replica_count

  identifier          = "${var.name}-replica-${count.index + 1}"
  replicate_source_db = aws_db_instance.primary.identifier
  instance_class      = var.db_instance_class

  vpc_security_group_ids = [aws_security_group.database.id]
  publicly_accessible    = false

  # A replica takes its backups from the primary; retaining its own would pay
  # twice for the same data.
  backup_retention_period = 0
  skip_final_snapshot     = true

  performance_insights_enabled = true
  auto_minor_version_upgrade   = true

  tags = merge(local.tags, { Role = "read-replica" })
}

# ── Redis ────────────────────────────────────────────────────────────────────

resource "random_password" "redis" {
  length  = 40
  special = false
}

resource "aws_elasticache_subnet_group" "main" {
  name       = var.name
  subnet_ids = [for subnet in aws_subnet.private : subnet.id]
  tags       = local.tags
}

resource "aws_elasticache_replication_group" "main" {
  replication_group_id = var.name
  description          = "${var.name} cache, queues and rate limiting"

  engine         = "redis"
  engine_version = "7.1"
  node_type      = var.redis_node_type
  port           = 6379

  num_cache_clusters         = var.redis_replica_count + 1
  automatic_failover_enabled = var.redis_replica_count > 0
  multi_az_enabled           = var.redis_replica_count > 0

  subnet_group_name  = aws_elasticache_subnet_group.main.name
  security_group_ids = [aws_security_group.cache.id]

  at_rest_encryption_enabled = true
  transit_encryption_enabled = true
  auth_token                 = random_password.redis.result

  # BullMQ stores job state in Redis. Evicting a key under memory pressure
  # would lose a queued job, so keys with no TTL must never be candidates.
  parameter_group_name = aws_elasticache_parameter_group.main.name

  snapshot_retention_limit = 7
  snapshot_window          = "02:00-03:00"
  maintenance_window       = "sun:05:00-sun:06:00"

  apply_immediately = false
  tags              = local.tags
}

resource "aws_elasticache_parameter_group" "main" {
  name   = "${var.name}-redis7"
  family = "redis7"

  parameter {
    name  = "maxmemory-policy"
    value = "volatile-lru"
  }

  lifecycle {
    create_before_destroy = true
  }

  tags = local.tags
}

# ── Object storage ───────────────────────────────────────────────────────────

resource "aws_s3_bucket" "storage" {
  bucket = "${var.name}-storage-${data.aws_caller_identity.current.account_id}"
  tags   = local.tags
}

data "aws_caller_identity" "current" {}

resource "aws_s3_bucket_public_access_block" "storage" {
  bucket = aws_s3_bucket.storage.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "storage" {
  bucket = aws_s3_bucket.storage.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_versioning" "storage" {
  bucket = aws_s3_bucket.storage.id

  versioning_configuration {
    # Attachments and recordings are referenced by a database row. A delete
    # that turns out to be wrong is recoverable while versioning is on, and
    # permanently wrong the moment it is not.
    status = "Enabled"
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "storage" {
  bucket = aws_s3_bucket.storage.id

  rule {
    id     = "abort-incomplete-uploads"
    status = "Enabled"

    filter {}

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }

  rule {
    id     = "expire-noncurrent-versions"
    status = "Enabled"

    filter {}

    noncurrent_version_expiration {
      noncurrent_days = 30
    }
  }

  dynamic "rule" {
    # Only when a retention window is actually wanted: a lifecycle rule that
    # expires objects is not something to configure by accident.
    for_each = var.storage_retention_days > 0 ? [var.storage_retention_days] : []

    content {
      id     = "retention"
      status = "Enabled"

      filter {}

      expiration {
        days = rule.value
      }
    }
  }

  depends_on = [aws_s3_bucket_versioning.storage]
}
