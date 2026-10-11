# The streaming chat Lambda, behind a Function URL in RESPONSE_STREAM mode.
#
# RESPONSE_STREAM is what makes token-by-token output possible. API Gateway
# cannot do this: its Lambda proxy integration buffers the entire response
# before returning it, so the client sees nothing until generation is done.

locals {
  lambda_source_dir  = abspath("${path.module}/${var.lambda_source_dir}")
  chat_function_name = "rag-chat-${local.deployment_id}"
}

# The handler is plain ESM (lambda/chat.mjs) with one dependency. Unlike the
# CDK path, which installs that dependency inside a Docker container at synth
# time, this path expects you to have run `npm --prefix lambda ci --omit=dev`
# first (scripts/deploy.sh does it). The precondition below turns a forgotten
# install into a plan-time error instead of a runtime "Cannot find module".
data "archive_file" "chat" {
  type        = "zip"
  source_dir  = local.lambda_source_dir
  output_path = "${path.module}/.build/chat.zip"
  excludes    = ["package-lock.json", ".gitignore"]
}

resource "aws_cloudwatch_log_group" "chat" {
  name              = "/aws/lambda/${local.chat_function_name}"
  retention_in_days = 14
}

data "aws_iam_policy_document" "lambda_trust" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "chat" {
  name_prefix        = "rag-chat-"
  assume_role_policy = data.aws_iam_policy_document.lambda_trust.json
}

resource "aws_iam_role_policy_attachment" "chat_logs" {
  role       = aws_iam_role.chat.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

data "aws_iam_policy_document" "chat_permissions" {
  # Retrieval is scoped to this one knowledge base.
  statement {
    sid       = "QueryKnowledgeBase"
    actions   = ["bedrock:Retrieve", "bedrock:RetrieveAndGenerate"]
    resources = [aws_bedrockagent_knowledge_base.kb.arn]
  }

  # Both ARNs - see the note on model_arn / base_model_arn in main.tf.
  statement {
    sid       = "InvokeGenerationModel"
    actions   = ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"]
    resources = [local.model_arn, local.base_model_arn]
  }

  # RetrieveAndGenerate resolves the profile before invoking it. Without this
  # the call fails with "Not authorized to call GetInferenceProfile".
  statement {
    sid       = "DescribeInferenceProfile"
    actions   = ["bedrock:GetInferenceProfile"]
    resources = [local.model_arn]
  }
}

resource "aws_iam_role_policy" "chat" {
  name   = "bedrock-access"
  role   = aws_iam_role.chat.id
  policy = data.aws_iam_policy_document.chat_permissions.json
}

resource "aws_lambda_function" "chat" {
  function_name = local.chat_function_name
  description   = "Streaming RetrieveAndGenerate handler for the RAG tutorial"
  role          = aws_iam_role.chat.arn

  filename         = data.archive_file.chat.output_path
  source_code_hash = data.archive_file.chat.output_base64sha256

  runtime = "nodejs22.x"
  handler = "chat.handler"

  # Generation can run for a while on a large model; the Function URL streams
  # the whole time, so nothing is waiting on a buffered response.
  timeout     = 300
  memory_size = 512

  environment {
    variables = {
      KNOWLEDGE_BASE_ID = aws_bedrockagent_knowledge_base.kb.id
      MODEL_ARN         = local.model_arn
      NUMBER_OF_RESULTS = tostring(var.number_of_results)
      PROMPT_TEMPLATE   = local.prompt_template

      ORCHESTRATION_PROMPT_TEMPLATE = local.orchestration_prompt_template
    }
  }

  lifecycle {
    precondition {
      condition     = fileexists("${local.lambda_source_dir}/node_modules/@aws-sdk/client-bedrock-agent-runtime/package.json")
      error_message = "lambda/node_modules is missing. Run: npm --prefix lambda ci --omit=dev (from the repository root) before terraform apply."
    }
  }

  depends_on = [
    aws_cloudwatch_log_group.chat,
    aws_iam_role_policy_attachment.chat_logs,
    aws_iam_role_policy.chat,
  ]
}

# AWS_IAM auth means the URL is not publicly callable on its own. Only
# CloudFront, through the Origin Access Control in cloudfront.tf, can sign
# requests to it.
resource "aws_lambda_function_url" "chat" {
  function_name      = aws_lambda_function.chat.function_name
  authorization_type = "AWS_IAM"
  invoke_mode        = "RESPONSE_STREAM"
}

# Lets this one CloudFront distribution invoke the Function URL. This is the
# resource-policy half of OAC; the distribution's origin_access_control_id in
# cloudfront.tf is the signing half.
resource "aws_lambda_permission" "cloudfront_url" {
  statement_id           = "AllowCloudFrontInvokeFunctionUrl"
  action                 = "lambda:InvokeFunctionUrl"
  function_name          = aws_lambda_function.chat.function_name
  principal              = "cloudfront.amazonaws.com"
  source_arn             = aws_cloudfront_distribution.site.arn
  function_url_auth_type = "AWS_IAM"
}

# The CloudFront OAC guide grants both actions; InvokeFunctionUrl alone was
# enough in testing, but the second statement costs nothing and matches the
# documented setup.
resource "aws_lambda_permission" "cloudfront_invoke" {
  statement_id  = "AllowCloudFrontInvokeFunction"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.chat.function_name
  principal     = "cloudfront.amazonaws.com"
  source_arn    = aws_cloudfront_distribution.site.arn
}
