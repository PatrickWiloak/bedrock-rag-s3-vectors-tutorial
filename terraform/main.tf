# Shared values.

data "aws_caller_identity" "current" {}

# Vector bucket and knowledge base names must be unique per account, and S3
# bucket names are capped at 63 characters. A short random suffix (kept in
# state, so it is stable across applies) lets you tear down and redeploy
# without name collisions.
resource "random_string" "deployment_id" {
  length  = 6
  upper   = false
  special = false
}

locals {
  account_id    = data.aws_caller_identity.current.account_id
  deployment_id = random_string.deployment_id.result

  knowledge_base_name = "kb-${local.account_id}-${local.deployment_id}"

  embedding_model_arn = "arn:aws:bedrock:${var.region}::foundation-model/${var.embedding_model_id}"

  # Generation runs through the inference profile, which routes to the same
  # foundation model in one of several Regions. IAM authorizes the call against
  # the foundation model in whichever Region serves it, so the Lambda policy
  # needs BOTH the profile ARN and the base model ARN with a wildcard Region.
  # Granting only the profile fails at runtime with an error naming a Region you
  # never configured.
  model_arn      = "arn:aws:bedrock:${var.region}:${local.account_id}:inference-profile/${var.model_id}"
  base_model_id  = replace(var.model_id, "/^(us|eu|apac|global)\\./", "")
  base_model_arn = "arn:aws:bedrock:*::foundation-model/${local.base_model_id}"

  # Shared with the CDK stack so both deploy paths answer identically. The
  # Claude 5.5 models require BOTH templates (each containing $query$); older
  # models accept either or neither.
  prompt_template               = trimspace(file("${path.module}/../config/prompt-template.txt"))
  orchestration_prompt_template = trimspace(file("${path.module}/../config/orchestration-prompt-template.txt"))
}
