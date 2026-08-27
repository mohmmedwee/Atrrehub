# Everything the Helm chart needs, in the shape it needs it.
#
# The connection strings are assembled here rather than left for an operator to
# concatenate, because getting a password with a special character into a URL
# correctly is exactly the kind of thing that fails at 3am.

output "vpc_id" {
  value = aws_vpc.main.id
}

output "private_subnet_ids" {
  value = [for subnet in aws_subnet.private : subnet.id]
}

output "public_subnet_ids" {
  value = [for subnet in aws_subnet.public : subnet.id]
}

output "application_security_group_id" {
  description = "Attach this to the API and worker pods; it is what the data stores accept."
  value       = aws_security_group.application.id
}

output "database_url" {
  description = "DATABASE_URL for the Helm chart."
  value       = "postgresql://${aws_db_instance.primary.username}:${urlencode(random_password.database.result)}@${aws_db_instance.primary.endpoint}/${aws_db_instance.primary.db_name}?schema=public&sslmode=require"
  sensitive   = true
}

output "database_replica_url" {
  description = <<-EOT
    DATABASE_REPLICA_URL for the Helm chart, or null when no replica was
    created. The application routes analytics and report queries here and
    keeps every write and read-after-write on the primary.
  EOT
  value       = var.db_replica_count > 0 ? "postgresql://${aws_db_instance.primary.username}:${urlencode(random_password.database.result)}@${aws_db_instance.replica[0].endpoint}/${aws_db_instance.primary.db_name}?schema=public&sslmode=require" : null
  sensitive   = true
}

output "redis_url" {
  description = "REDIS_URL for the Helm chart. rediss:// — transit encryption is on."
  value       = "rediss://:${urlencode(random_password.redis.result)}@${aws_elasticache_replication_group.main.primary_endpoint_address}:6379"
  sensitive   = true
}

output "storage_bucket" {
  value = aws_s3_bucket.storage.bucket
}

output "storage_region" {
  value = var.region
}

output "helm_values" {
  description = <<-EOT
    Paste into a values file, or:
      terraform output -json helm_values | jq -r 'to_entries|map("--set-string \(.key)=\(.value)")|join(" ")'

    Secrets are excluded on purpose. Read them from the sensitive outputs above
    and put them in a secret manager, not in a values file in a repository.
  EOT
  value = {
    "config.storageDriver" = "s3"
    "config.s3Bucket"      = aws_s3_bucket.storage.bucket
    "config.s3Region"      = var.region
    "postgresql.enabled"   = "false"
    "redis.enabled"        = "false"
  }
}
