# Quick Start Guide

Get a working RAG system running in about 10 minutes of wall-clock time (plus ~5 minutes of waiting for ingestion).

For the full explanation of what you're building, start with [README.md](README.md).

## What Gets Deployed

- **S3 bucket** with 16 sample company documents in three folders
- **S3 Vectors** vector bucket and index (serverless vector database)
- **Bedrock Knowledge Base** wired to that index
- **Streaming Lambda** behind a Function URL, backed by `RetrieveAndGenerateStream`
- **CloudFront + S3** serving a Next.js chat UI, with `/api/*` routed to the Lambda on the same origin

No Bedrock Agent is involved - see [What changed in v2](README.md#-what-changed-in-v2-august-2026). Everything below deploys with CDK; prefix any `./scripts/deploy.sh` command with `IAC=terraform` to use the [Terraform configuration](terraform/README.md) instead (then Docker is not needed, Terraform 1.10+ is).

## Prerequisites

```bash
node --version     # need 20+
aws --version
cdk --version      # npm install -g aws-cdk
docker info        # must be running - CDK bundles the Lambda in a container
jq --version       # used by test-bedrock.sh
aws sts get-caller-identity   # credentials must work
```

You also need the IAM permissions in [iam-policy.json](iam-policy.json) - see [Required IAM Permissions](README.md#required-iam-permissions).

## About Bedrock Model Access

Bedrock grants access to most models automatically, but some need a one-time use-case submission (usually approved in 1-2 business days).

The default model is `us.anthropic.claude-haiku-5-5`. Check what your account can reach:

```bash
aws bedrock list-inference-profiles --region us-east-1 \
  --query "inferenceProfileSummaries[?contains(inferenceProfileId, 'claude')].[inferenceProfileId,status]" \
  --output table
```

Note the `us.` prefix: every current Claude model on Bedrock is served through a cross-Region **inference profile**, not as a plain on-demand foundation model.

To try a stronger (and pricier) model for the tutorial:

```bash
MODEL_ID=us.anthropic.claude-sonnet-5-5 ./scripts/deploy.sh infra
```

## Installation & Deployment

### The fast path

```bash
git clone https://github.com/PatrickWiloak/bedrock-rag-s3-vectors-tutorial.git
cd bedrock-rag-s3-vectors-tutorial
npm install
./scripts/deploy.sh full
```

That does everything below - prerequisites, build, deploy, upload, ingest, health check - and prints your CloudFront URL at the end.

### The manual path

```bash
# Install dependencies (root + web workspace)
npm install

# Build the static web export - the stack uploads web/out
npm run build:web

# First time in this account/Region only
npx cdk bootstrap

# Deploy (5-8 minutes)
npx cdk deploy
```

## Upload Documents

Uploading to S3 does **not** trigger indexing on its own. This script uploads and then starts the ingestion job:

```bash
npm run upload-docs
```

```
✓ Uploaded 16 documents to S3
✓ Knowledge Base ingestion started
```

Ingestion takes 2-5 minutes. Watch it:

```bash
npm run check-status
```

Wait for `Status: ✅ COMPLETE` before querying.

## Query Your Knowledge Base

```bash
# Scripted demo questions across all three categories
npm run test-rag

# Ask your own
npm run test-rag interactive
```

```
❓ You: What's our remote work policy?

🤖 According to the Remote Work Policy, Nobler Works operates a hybrid model...

📚 Sources:
  1. s3://docs-.../Human-Resources/remote-work-policy.md
```

Or open the CloudFront URL from the stack outputs:

```bash
aws cloudformation describe-stacks --stack-name S3VectorRAGStack \
  --query 'Stacks[0].Outputs[?OutputKey==`WebsiteURL`].OutputValue' --output text
```

## What You Just Built

A complete RAG pipeline:

1. Documents in S3, chunked at 300 tokens with 7% overlap
2. Chunks embedded by Titan Text Embeddings V2 into 1024-dimension vectors
3. Vectors stored in an S3 Vectors index with cosine distance
4. Questions embedded the same way, matched against the index
5. Top 5 chunks passed to Claude with a prompt template
6. A grounded answer **streamed back token by token**, with citations resolved to readable document titles

All of it defined in ~400 lines of CDK across three constructs, with no API Gateway and no CORS.

## Next Steps

- **Add your own documents**

  ```bash
  aws s3 cp my-doc.pdf "s3://$(aws cloudformation describe-stacks \
    --stack-name S3VectorRAGStack \
    --query 'Stacks[0].Outputs[?OutputKey==`DataBucketName`].OutputValue' \
    --output text)/Financial-Data/"
  ./scripts/deploy.sh docs    # re-uploads and re-ingests
  ```

- **Change how it answers** - edit `PROMPT_TEMPLATE` in [lib/s3-rag-stack.ts](lib/s3-rag-stack.ts), then `./scripts/deploy.sh infra`
- **Tune retrieval** - `numberOfResults`, chunk size, overlap; see [docs/04-customization.md](docs/04-customization.md)
- **Read the tutorial** - [docs/01-understanding.md](docs/01-understanding.md) onward

## Troubleshooting

Run the diagnostic first - it checks each layer in order and stops at the real failure:

```bash
./test-bedrock.sh
```

| Symptom | Cause and fix |
|---|---|
| `AccessDeniedException` mentioning a model | Model access not enabled. Bedrock console → **Model access**. Note the error may name a Region you didn't configure - that's the inference profile routing, not a mistake. |
| `ValidationException` about `sessionId` | A client-generated session ID was sent. Only ever send back one Bedrock issued. |
| "I don't have that information" | Ingestion hasn't finished, or finished with failures. Run `npm run check-status`. |
| Ingestion fails: `metadata must have at most 2048 bytes` | The index is missing its `nonFilterableMetadataKeys`. See [ARCHITECTURE.md](ARCHITECTURE.md#ingestion-flow). |
| `cdk deploy` fails bundling the Lambda | Docker isn't running. |
| Web UI shows "The chat API isn't reachable" | Expected under `next dev` (there is no CloudFront). On a real deployment, check the Lambda logs and CloudFront propagation. |
| Stack fails on bucket name already exists | S3 has not released a just-deleted name yet. Wait a minute, or deploy once with `--context deploymentId=<anything-short>` |
| Answer arrives all at once instead of streaming | CloudFront `compress` is on for `/api/*`. It must be `false`. |

## Clean Up

Everything is native CloudFormation, so one command removes all of it:

```bash
./scripts/deploy.sh destroy
```

It asks you to type the stack name to confirm.

### Cost estimate

Roughly **$1-5 total** for working through the tutorial, almost all of it model inference. The default `us.anthropic.claude-haiku-5-5` is already the cheapest option; switching up to Sonnet 5.5 or Opus 5.5 raises the generation cost several times over.

Idle cost after deployment is close to zero - S3 Vectors bills per request and per GB stored rather than for provisioned capacity - but **delete the stack when you're done anyway**.

Verify nothing is left:

```bash
aws cloudformation describe-stacks --stack-name S3VectorRAGStack   # should error
aws s3vectors list-vector-buckets --region us-east-1
aws bedrock-agent list-knowledge-bases --region us-east-1
```

## Support

- [README.md](README.md) - full documentation
- [ARCHITECTURE.md](ARCHITECTURE.md) - request flow and IAM detail
- [docs/](docs/) - the seven-chapter tutorial
