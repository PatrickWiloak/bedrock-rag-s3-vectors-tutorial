# One CloudFront distribution, two behaviours:
#
#   default  -> S3 website bucket (Next.js static export), private, via OAC
#   /api/*   -> Lambda Function URL (streaming), private, via OAC
#
# Serving the API from the same distribution as the site is the decision that
# most shapes this codebase: the browser POSTs to a relative /api/chat, so
# there is no API URL to discover at runtime, no CORS, and no URL-joining bug.

# ---------------------------------------------------------------------------
# 1. Website bucket
# ---------------------------------------------------------------------------

resource "aws_s3_bucket" "web" {
  bucket_prefix = "web-${local.deployment_id}-"
  force_destroy = true # tutorial-only
}

resource "aws_s3_bucket_public_access_block" "web" {
  bucket                  = aws_s3_bucket.web.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "web" {
  bucket = aws_s3_bucket.web.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# Only this distribution may read the website objects.
data "aws_iam_policy_document" "web_bucket" {
  statement {
    sid       = "AllowCloudFrontRead"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.web.arn}/*"]

    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.site.arn]
    }
  }

  statement {
    sid     = "DenyInsecureTransport"
    effect  = "Deny"
    actions = ["s3:*"]
    resources = [
      aws_s3_bucket.web.arn,
      "${aws_s3_bucket.web.arn}/*",
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

resource "aws_s3_bucket_policy" "web" {
  bucket     = aws_s3_bucket.web.id
  policy     = data.aws_iam_policy_document.web_bucket.json
  depends_on = [aws_s3_bucket_public_access_block.web]
}

# ---------------------------------------------------------------------------
# 2. Origin Access Controls - one per origin type
# ---------------------------------------------------------------------------

resource "aws_cloudfront_origin_access_control" "s3" {
  name                              = "rag-tutorial-s3-${local.deployment_id}"
  description                       = "CloudFront -> private S3 website bucket"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_origin_access_control" "lambda" {
  name                              = "rag-tutorial-lambda-${local.deployment_id}"
  description                       = "CloudFront -> IAM-authenticated Lambda Function URL"
  origin_access_control_origin_type = "lambda"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# ---------------------------------------------------------------------------
# 3. Viewer-request function for clean URLs
# ---------------------------------------------------------------------------

# Shared with the CDK stack. Rewrites "/foo" and "/foo/" to "/foo/index.html"
# and must leave /api/* alone, or the Lambda origin is never reached.
resource "aws_cloudfront_function" "url_rewrite" {
  name    = "rag-tutorial-url-rewrite-${local.deployment_id}"
  runtime = "cloudfront-js-2.0"
  comment = "Rewrites clean URLs to the Next.js static export object keys"
  publish = true
  code    = file("${path.module}/../config/cloudfront-url-rewrite.js")
}

# ---------------------------------------------------------------------------
# 4. Managed policies
# ---------------------------------------------------------------------------

data "aws_cloudfront_cache_policy" "caching_optimized" {
  name = "Managed-CachingOptimized"
}

data "aws_cloudfront_cache_policy" "caching_disabled" {
  name = "Managed-CachingDisabled"
}

# Forwards everything except Host, which must stay the Lambda's own hostname
# for the SigV4 signature to validate.
data "aws_cloudfront_origin_request_policy" "all_viewer_except_host" {
  name = "Managed-AllViewerExceptHostHeader"
}

# ---------------------------------------------------------------------------
# 5. The distribution
# ---------------------------------------------------------------------------

locals {
  # "https://abc123.lambda-url.us-east-1.on.aws/" -> "abc123.lambda-url.us-east-1.on.aws"
  chat_origin_domain = trimsuffix(trimprefix(aws_lambda_function_url.chat.function_url, "https://"), "/")
  web_build_dir      = abspath("${path.module}/${var.web_build_dir}")
}

resource "aws_cloudfront_distribution" "site" {
  enabled             = true
  comment             = "Bedrock RAG tutorial - ${local.deployment_id}"
  default_root_object = "index.html"
  price_class         = "PriceClass_100" # US, Europe, Canada
  http_version        = "http2and3"

  origin {
    origin_id                = "s3-web"
    domain_name              = aws_s3_bucket.web.bucket_regional_domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.s3.id
  }

  origin {
    origin_id                = "lambda-chat"
    domain_name              = local.chat_origin_domain
    origin_access_control_id = aws_cloudfront_origin_access_control.lambda.id

    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
      # Generation can take a while before the first byte on a cold start.
      origin_read_timeout = 60
    }
  }

  default_cache_behavior {
    target_origin_id       = "s3-web"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD", "OPTIONS"]
    cached_methods         = ["GET", "HEAD", "OPTIONS"]
    compress               = true
    cache_policy_id        = data.aws_cloudfront_cache_policy.caching_optimized.id

    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.url_rewrite.arn
    }
  }

  ordered_cache_behavior {
    path_pattern           = "/api/*"
    target_origin_id       = "lambda-chat"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods         = ["GET", "HEAD"]

    # Critical: compression buffers the response and silently stops streaming.
    # Leave it on and everything still "works" - the answer just arrives all at
    # once, with no error anywhere.
    compress = false

    cache_policy_id          = data.aws_cloudfront_cache_policy.caching_disabled.id
    origin_request_policy_id = data.aws_cloudfront_origin_request_policy.all_viewer_except_host.id
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = true
  }

  lifecycle {
    # fileset() over a missing directory is silently empty, which would deploy
    # a working API behind a blank site. Fail at plan time instead.
    precondition {
      condition     = fileexists("${local.web_build_dir}/index.html")
      error_message = "${local.web_build_dir}/index.html not found. Run: npm run build:web (from the repository root) before terraform apply."
    }
  }
}
