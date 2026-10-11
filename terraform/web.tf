# Upload the Next.js static export to the website bucket.
#
# This is the Terraform equivalent of CDK's BucketDeployment: one aws_s3_object
# per file, keyed by its path, re-uploaded when its content hash changes.
# CloudFront caches aggressively on the default behaviour, so after a UI change
# invalidate the distribution (scripts/deploy.sh frontend does this):
#
#   aws cloudfront create-invalidation --distribution-id <id> --paths '/*'

locals {
  web_files = fileset(local.web_build_dir, "**")

  # S3 does not infer Content-Type, and CloudFront serves whatever the object
  # says. Without this, every page downloads as application/octet-stream.
  mime_types = {
    html  = "text/html; charset=utf-8"
    css   = "text/css; charset=utf-8"
    js    = "application/javascript; charset=utf-8"
    mjs   = "application/javascript; charset=utf-8"
    json  = "application/json"
    map   = "application/json"
    txt   = "text/plain; charset=utf-8"
    xml   = "application/xml"
    svg   = "image/svg+xml"
    png   = "image/png"
    jpg   = "image/jpeg"
    jpeg  = "image/jpeg"
    gif   = "image/gif"
    webp  = "image/webp"
    avif  = "image/avif"
    ico   = "image/x-icon"
    woff  = "font/woff"
    woff2 = "font/woff2"
    ttf   = "font/ttf"
  }
}

resource "aws_s3_object" "web" {
  for_each = local.web_files

  bucket = aws_s3_bucket.web.id
  key    = each.value
  source = "${local.web_build_dir}/${each.value}"
  etag   = filemd5("${local.web_build_dir}/${each.value}")

  content_type = lookup(
    local.mime_types,
    lower(element(split(".", each.value), length(split(".", each.value)) - 1)),
    "application/octet-stream",
  )
}
