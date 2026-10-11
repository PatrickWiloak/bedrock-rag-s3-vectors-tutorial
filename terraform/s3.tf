# The document bucket. Documents are organised into folders - Financial-Data/,
# Human-Resources/, Meeting-Notes/ - and the knowledge base indexes the whole
# bucket.

resource "aws_s3_bucket" "docs" {
  bucket = "docs-${local.account_id}-${var.region}-${local.deployment_id}"

  # Tutorial-only: lets `terraform destroy` empty and remove the bucket. Drop
  # this for anything whose documents you want to keep.
  force_destroy = true
}

resource "aws_s3_bucket_public_access_block" "docs" {
  bucket                  = aws_s3_bucket.docs.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "docs" {
  bucket = aws_s3_bucket.docs.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# Refuse plain-HTTP access, the equivalent of CDK's enforceSSL: true.
data "aws_iam_policy_document" "docs_ssl_only" {
  statement {
    sid     = "DenyInsecureTransport"
    effect  = "Deny"
    actions = ["s3:*"]
    resources = [
      aws_s3_bucket.docs.arn,
      "${aws_s3_bucket.docs.arn}/*",
    ]

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "docs" {
  bucket     = aws_s3_bucket.docs.id
  policy     = data.aws_iam_policy_document.docs_ssl_only.json
  depends_on = [aws_s3_bucket_public_access_block.docs]
}
