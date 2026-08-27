# The identity the application assumes to reach object storage.
#
# A role rather than an access key: a key in a Kubernetes secret is a
# credential that outlives every rotation policy anyone writes down.

data "aws_iam_policy_document" "storage_access" {
  statement {
    sid    = "ObjectAccess"
    effect = "Allow"

    actions = [
      "s3:GetObject",
      "s3:PutObject",
      "s3:DeleteObject",
    ]

    # Scoped to the bucket's contents. Not to the bucket itself — that would
    # grant object-level actions on a resource they do not apply to, and hide
    # the fact that ListBucket below is a separate, deliberate grant.
    resources = ["${aws_s3_bucket.storage.arn}/*"]
  }

  statement {
    sid       = "ListForExistsChecks"
    effect    = "Allow"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.storage.arn]
  }
}

resource "aws_iam_policy" "storage_access" {
  name        = "${var.name}-storage"
  description = "Read and write ${aws_s3_bucket.storage.bucket}"
  policy      = data.aws_iam_policy_document.storage_access.json
  tags        = local.tags
}

variable "oidc_provider_arn" {
  description = <<-EOT
    The EKS cluster's OIDC provider ARN, for IRSA. Leave empty when the cluster
    is created elsewhere or the application runs outside Kubernetes — the policy
    is still created, and can be attached to whatever identity you use.
  EOT
  type        = string
  default     = ""
}

variable "service_account_namespace" {
  type    = string
  default = "atrrehub"
}

variable "service_account_name" {
  type    = string
  default = "atrrehub"
}

locals {
  irsa_enabled = var.oidc_provider_arn != ""
  # arn:aws:iam::123:oidc-provider/oidc.eks.eu-west-1.amazonaws.com/id/ABC
  oidc_issuer = local.irsa_enabled ? replace(var.oidc_provider_arn, "/^arn:aws:iam::\\d+:oidc-provider\\//", "") : ""
}

data "aws_iam_policy_document" "irsa_assume" {
  count = local.irsa_enabled ? 1 : 0

  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [var.oidc_provider_arn]
    }

    # Both conditions matter. Without the `sub` check any service account in
    # the cluster could assume this role; without `aud` the token need not have
    # been issued for STS at all.
    condition {
      test     = "StringEquals"
      variable = "${local.oidc_issuer}:sub"
      values   = ["system:serviceaccount:${var.service_account_namespace}:${var.service_account_name}"]
    }

    condition {
      test     = "StringEquals"
      variable = "${local.oidc_issuer}:aud"
      values   = ["sts.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "application" {
  count = local.irsa_enabled ? 1 : 0

  name               = "${var.name}-application"
  assume_role_policy = data.aws_iam_policy_document.irsa_assume[0].json
  tags               = local.tags
}

resource "aws_iam_role_policy_attachment" "storage" {
  count = local.irsa_enabled ? 1 : 0

  role       = aws_iam_role.application[0].name
  policy_arn = aws_iam_policy.storage_access.arn
}

output "storage_policy_arn" {
  description = "Attach to whatever identity the application runs as, when not using IRSA."
  value       = aws_iam_policy.storage_access.arn
}

output "service_account_annotation" {
  description = "Annotate the Kubernetes service account with this to use IRSA."
  value = local.irsa_enabled ? {
    "eks.amazonaws.com/role-arn" = aws_iam_role.application[0].arn
  } : null
}
