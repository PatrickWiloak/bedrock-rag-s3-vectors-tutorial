# Deploying with Terraform

The same stack as the CDK app in [`../lib`](../lib), written in plain Terraform against the `hashicorp/aws` provider. Pick whichever tool you already use; the two paths produce identical resources and the helper scripts work with either.

| | CDK (`../lib`) | Terraform (this directory) |
|---|---|---|
| Vector store | `AWS::S3Vectors::VectorBucket` + `::Index` | `aws_s3vectors_vector_bucket` + `aws_s3vectors_index` |
| Knowledge base | `AWS::Bedrock::KnowledgeBase` (`S3VectorsConfiguration`) | `aws_bedrockagent_knowledge_base` (`S3_VECTORS`) |
| Lambda packaging | Docker bundling at synth time | `archive_file` over `lambda/` (you run `npm ci` first) |
| Static site upload | `BucketDeployment` custom resource | one `aws_s3_object` per file |
| State | CloudFormation | local `terraform.tfstate` (S3 backend commented in `versions.tf`) |
| Prompt template, URL rewrite | [`../config/`](../config) | [`../config/`](../config) - the same files |

Everything is a first-party provider resource. There is no community module and no `awscc` provider: the S3 Vectors resources and the `S3_VECTORS` storage type landed in `hashicorp/aws` 6.x, which is why this directory exists at all.

## Prerequisites

Everything in the [root README](../README.md#prerequisites), minus Docker (Terraform does not bundle the Lambda in a container), plus:

- Terraform 1.10 or newer
- The [IAM permissions](../iam-policy.json) for Bedrock and S3 Vectors, plus whatever your account needs for S3, Lambda, CloudFront and IAM role creation

## Deploy

From the repository root, the deploy script does the whole thing:

```bash
npm install
IAC=terraform ./scripts/deploy.sh full
```

That builds the web UI, installs the Lambda's dependency, runs `terraform init` and `apply`, uploads the sample documents, waits for ingestion, and smoke-tests the CloudFront URL. Every subcommand of the script (`infra`, `frontend`, `docs`, `ingest`, `diff`, `status`, `destroy`) honours `IAC=terraform`.

By hand, if you would rather see each step:

```bash
# 1. Build what Terraform uploads
npm run build:web                        # -> web/out
npm --prefix lambda ci --omit=dev        # -> lambda/node_modules

# 2. Deploy
cd terraform
terraform init
terraform apply

# 3. Upload documents and start ingestion. The helper scripts read the IDs
#    from these environment variables when they are set, and from
#    CloudFormation otherwise.
eval "$(terraform output -json | jq -r '
  "export KNOWLEDGE_BASE_ID=\(.knowledge_base_id.value)",
  "export DATA_SOURCE_ID=\(.data_source_id.value)",
  "export DATA_BUCKET_NAME=\(.data_bucket_name.value)",
  "export MODEL_ID=\(.model_id.value)",
  "export CHAT_ENDPOINT=\(.chat_endpoint.value)",
  "export WEBSITE_URL=\(.website_url.value)"')"
cd ..
npm run upload-docs
npm run check-status
npm run test-rag

# 4. Verify the whole path, including that the answer actually streams
IAC=terraform ./test-bedrock.sh
```

Both preconditions that commonly bite are checked at plan time: a missing `web/out/index.html` and a missing `lambda/node_modules` each fail `terraform plan` with a message naming the command to run, instead of deploying a blank site or a Lambda that cannot find its module.

## Variables

All in [`variables.tf`](variables.tf), all with defaults. The ones you are likely to touch:

| Variable | Default | Notes |
|---|---|---|
| `model_id` | `us.anthropic.claude-haiku-5-5` | Must be an inference profile ID (Region prefix). `MODEL_ID=... IAC=terraform ./scripts/deploy.sh infra` passes it through. |
| `region` | `us-east-1` | S3 Vectors and the Claude profiles are not in every Region. |
| `aws_profile` | `null` | Named CLI profile; `null` uses the ambient credential chain. |
| `number_of_results` | `5` | Chunks per question. |
| `chunk_size` / `chunk_overlap_percentage` | `300` / `7` | Changing either replaces the data source and needs a re-ingest. |
| `embedding_dimension` | `1024` | Must match the embedding model. Changing it replaces the index and discards every vector. |

Copy [`terraform.tfvars.example`](terraform.tfvars.example) to `terraform.tfvars` to persist overrides.

## What is different from the CDK path, and why

**Lambda dependencies are installed on your machine, not in Docker.** `data "archive_file"` zips `lambda/` as-is, so `lambda/node_modules` has to exist. `scripts/deploy.sh` runs `npm --prefix lambda ci --omit=dev` before every apply; a `precondition` on the function turns a forgotten install into a plan error.

**The site upload is one object per file.** CDK's `BucketDeployment` is a custom-resource Lambda that syncs a directory and invalidates CloudFront. Terraform has no managed equivalent, so [`web.tf`](web.tf) iterates `fileset()` and sets `Content-Type` per extension (S3 does not infer it, and CloudFront serves whatever the object says). After a UI change the deploy script invalidates `/*`; by hand that is:

```bash
aws cloudfront create-invalidation --distribution-id "$(terraform output -raw distribution_id)" --paths '/*'
```

**Names use a random suffix kept in state.** Both paths need a short, stable, per-deployment suffix on bucket and knowledge base names. CDK derives it from the stack's own UUID; Terraform has no such thing, so `random_string.deployment_id` is generated on the first apply and kept in state. Either way the suffix never changes on an update - if it did, the buckets, index and knowledge base would be replaced and every vector lost.

**Two IAM facts carry over unchanged**, and they are the two that cost people an afternoon:

- `bedrock:InvokeModel` is granted on **both** the inference profile ARN and the foundation model ARN with a wildcard Region (`main.tf`, `local.base_model_arn`). The profile alone fails at runtime with an error naming a Region you never configured.
- The S3 Vectors index declares `AMAZON_BEDROCK_TEXT` and `AMAZON_BEDROCK_METADATA` as non-filterable (`knowledge_base.tf`). Without that, ingestion fails with `metadata must have at most 2048 bytes`, and the setting is create-only.
- The Lambda role also has `bedrock:GetInferenceProfile` on the profile ARN (`lambda.tf`), and the Lambda is handed **both** prompt templates from `config/`. The Claude 5.5 models refuse `RetrieveAndGenerate` without either.

## Destroy

```bash
IAC=terraform ./scripts/deploy.sh destroy     # or: cd terraform && terraform destroy
```

Both buckets have `force_destroy = true` and the vector bucket has `force_destroy = true`, so teardown is one command and leaves nothing behind. Confirm with:

```bash
aws s3vectors list-vector-buckets --region us-east-1
aws bedrock-agent list-knowledge-bases --region us-east-1
```

## Cost

Identical to the CDK path - see [Cost & Cleanup](../README.md#cost--cleanup) in the root README. The Terraform state file costs nothing; the resources it tracks cost roughly $1-5 for a full run of the tutorial.
