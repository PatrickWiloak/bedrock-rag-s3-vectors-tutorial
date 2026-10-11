variable "region" {
  description = "AWS Region to deploy into. S3 Vectors and the Claude inference profiles are not in every Region; us-east-1 has both."
  type        = string
  default     = "us-east-1"
}

variable "aws_profile" {
  description = "Named AWS CLI profile to use. Leave null to use the ambient credential chain (env vars, SSO, instance role)."
  type        = string
  default     = null
}

variable "model_id" {
  description = <<-EOT
    Inference profile that generates answers. Every current Claude model on
    Bedrock is served only through a cross-Region inference profile, so this
    carries a Region prefix (us., eu., apac. or global.). List what your account
    can reach with: aws bedrock list-inference-profiles --region us-east-1
  EOT
  type        = string
  default     = "us.anthropic.claude-haiku-5-5"

  validation {
    condition     = can(regex("^(us|eu|apac|global)\\.", var.model_id))
    error_message = "model_id must be an inference profile ID with a Region prefix, e.g. us.anthropic.claude-haiku-5-5."
  }
}

variable "embedding_model_id" {
  description = "Bedrock embedding model. Its output dimension must match embedding_dimension."
  type        = string
  default     = "amazon.titan-embed-text-v2:0"
}

variable "embedding_dimension" {
  description = "Vector dimension produced by the embedding model. Titan Text Embeddings V2 supports 256, 512 or 1024. Changing this replaces the index and discards every stored vector."
  type        = number
  default     = 1024
}

variable "chunk_size" {
  description = "Maximum tokens per chunk at ingestion."
  type        = number
  default     = 300
}

variable "chunk_overlap_percentage" {
  description = "Overlap between adjacent chunks, as a percentage."
  type        = number
  default     = 7
}

variable "number_of_results" {
  description = "How many chunks RetrieveAndGenerate pulls into the prompt per question."
  type        = number
  default     = 5
}

variable "web_build_dir" {
  description = "Path to the Next.js static export that gets uploaded to the website bucket. Build it first with: npm run build:web"
  type        = string
  default     = "../web/out"
}

variable "lambda_source_dir" {
  description = "Directory holding chat.mjs and its installed node_modules. Install them first with: npm --prefix lambda ci --omit=dev"
  type        = string
  default     = "../lambda"
}
