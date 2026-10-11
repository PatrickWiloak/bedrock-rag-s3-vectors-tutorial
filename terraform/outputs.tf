# Output names match what scripts/deploy.sh and the TypeScript helpers read
# when IAC=terraform (see scripts/outputs.ts).

output "data_bucket_name" {
  description = "S3 bucket for storing documents"
  value       = aws_s3_bucket.docs.bucket
}

output "knowledge_base_id" {
  description = "Knowledge Base ID"
  value       = aws_bedrockagent_knowledge_base.kb.id
}

output "data_source_id" {
  description = "Data Source ID"
  value       = aws_bedrockagent_data_source.docs.data_source_id
}

output "model_id" {
  description = "Inference profile used to generate answers"
  value       = var.model_id
}

output "region" {
  description = "AWS Region"
  value       = var.region
}

output "vector_bucket_name" {
  description = "S3 Vectors bucket name"
  value       = aws_s3vectors_vector_bucket.vectors.vector_bucket_name
}

output "vector_index_arn" {
  description = "S3 Vectors index ARN"
  value       = aws_s3vectors_index.index.index_arn
}

output "website_url" {
  description = "CloudFront URL for the web UI"
  value       = "https://${aws_cloudfront_distribution.site.domain_name}"
}

output "chat_endpoint" {
  description = "Streaming chat endpoint (same origin as the site)"
  value       = "https://${aws_cloudfront_distribution.site.domain_name}/api/chat"
}

output "chat_function_name" {
  description = "Name of the streaming chat Lambda (for log tailing)"
  value       = aws_lambda_function.chat.function_name
}

output "website_bucket_name" {
  description = "S3 bucket holding the static site"
  value       = aws_s3_bucket.web.bucket
}

output "distribution_id" {
  description = "CloudFront distribution ID (for invalidations)"
  value       = aws_cloudfront_distribution.site.id
}
