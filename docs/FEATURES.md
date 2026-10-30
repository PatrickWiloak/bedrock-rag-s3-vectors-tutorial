# Feature Catalogue

The canonical list of what this tutorial builds and teaches. Update it in the
same commit as any user-visible change. The deployed stack is a teaching
deployment, not a production service: v2.2 was deployed end to end from both
paths and torn down again (see [TODO.md](../TODO.md)).

## What the deployed stack does

- **Document Q&A web UI** (`web/`) - a Next.js static-export chat page served from CloudFront: suggested opening questions across the three sample folders, streamed answers, a session indicator, and a banner explaining why `/api/chat` is unreachable under `next dev`. [web/app/page.tsx](../web/app/page.tsx), [web/app/components/QuickStarters.tsx](../web/app/components/QuickStarters.tsx), [web/app/components/MisconfiguredBanner.tsx](../web/app/components/MisconfiguredBanner.tsx).
- **Citations** - each answer lists its sources with a readable title and a short excerpt resolved from the S3 key. [web/app/components/Citations.tsx](../web/app/components/Citations.tsx).
- **Multi-turn sessions** - `RetrieveAndGenerate` issues the session id; the UI sends it back on later turns and never invents one. [web/app/page.tsx](../web/app/page.tsx).
- **Streaming chat API** (`/api/chat`) - a Lambda Function URL in `RESPONSE_STREAM` mode calls `RetrieveAndGenerateStream` and emits NDJSON (`session`, `text`, `citation`, `done`), with stream-union errors reported instead of silent empty answers. [lambda/chat.mjs](../lambda/chat.mjs); browser parser and `sha256Hex` in [web/app/lib/stream.ts](../web/app/lib/stream.ts).
- **Knowledge Base on S3 Vectors** - documents in S3 are chunked (300 tokens, 7% overlap), embedded with Titan Text Embeddings V2 and stored in an S3 Vectors index (cosine). Semantic search only. CDK: [lib/knowledge-base-construct.ts](../lib/knowledge-base-construct.ts); Terraform: [terraform/knowledge_base.tf](../terraform/knowledge_base.tf).
- **One CloudFront distribution** - the static site and `/api/*` on the same origin via OAC, compression off on the API behaviour, and a clean-URL rewrite function that skips `/api/`. [lib/web-hosting-construct.ts](../lib/web-hosting-construct.ts), [terraform/cloudfront.tf](../terraform/cloudfront.tf), [config/cloudfront-url-rewrite.js](../config/cloudfront-url-rewrite.js).
- **Shared prompt templates** - generation and orchestration templates read by both deploy paths. [config/prompt-template.txt](../config/prompt-template.txt), [config/orchestration-prompt-template.txt](../config/orchestration-prompt-template.txt).
- **Sample corpus** - 16 fictional Nobler Works documents in `Financial-Data/`, `Human-Resources/` and `Meeting-Notes/`. [sample-data/knowledge-docs/](../sample-data/knowledge-docs).
- **Model choice** - Claude Haiku 5.5 inference profile by default; `MODEL_ID` or `--model` switches to Sonnet or Opus 5.5 at deploy time.
- **Open by design** - the chat API has no authentication (the CloudFront URL is public); the docs flag this as a thing to fix before sharing a deployment.

## Two deploy paths, one stack

- **CDK path** (default, `IAC=cdk`) - three constructs under one stack. [bin/s3-rag-app.ts](../bin/s3-rag-app.ts), [lib/s3-rag-stack.ts](../lib/s3-rag-stack.ts).
- **Terraform path** (`IAC=terraform`) - the same resources from first-party `hashicorp/aws` resources, no registry modules. [terraform/](../terraform/README.md): [main.tf](../terraform/main.tf), [s3.tf](../terraform/s3.tf), [knowledge_base.tf](../terraform/knowledge_base.tf), [lambda.tf](../terraform/lambda.tf), [cloudfront.tf](../terraform/cloudfront.tf), [web.tf](../terraform/web.tf).

## Commands (`scripts/`)

- **Deploy script** (`scripts/deploy.sh full | infra | frontend | backend | docs | ingest | diff | status | destroy`) - drives either path; `full` runs infra, document upload, ingestion and a health check. `destroy` asks for typed confirmation. [scripts/deploy.sh](../scripts/deploy.sh).
- **Document upload and ingestion** (`scripts/upload-documents.ts`) - uploads the sample documents and starts an ingestion job. [scripts/upload-documents.ts](../scripts/upload-documents.ts).
- **Ingestion status** (`scripts/check-status.ts`, `npm run check-status`) - ingestion job progress. [scripts/check-status.ts](../scripts/check-status.ts).
- **CLI query** (`scripts/test-rag.ts`, `npm run test-rag [interactive]`) - scripted demo questions or an interactive prompt against the deployed knowledge base. [scripts/test-rag.ts](../scripts/test-rag.ts).
- **Resource lookup** (`scripts/outputs.ts`) - reads resource ids from environment (Terraform) or CloudFormation outputs (CDK) so the scripts work with either path. [scripts/outputs.ts](../scripts/outputs.ts).
- **Diagnostic** (`./test-bedrock.sh`) - walks the deployment bottom up, including a streaming check, and stops at the first broken layer. [test-bedrock.sh](../test-bedrock.sh).
- **Deploy permissions** - the IAM policy a reader needs to deploy. [iam-policy.json](../iam-policy.json).

## What the tutorial teaches (chapters)

- **01 Understanding RAG** - embeddings, vector search, why S3 Vectors. [01-understanding.md](01-understanding.md).
- **02 Infrastructure** - the stack resource by resource. [02-infrastructure.md](02-infrastructure.md).
- **03 Querying** - `RetrieveAndGenerate`, sessions, citations. [03-querying.md](03-querying.md).
- **04 Customization** - chunking, prompt templates, models, retrieval tuning. [04-customization.md](04-customization.md).
- **05 Testing** - test scripts, answer quality, debugging, troubleshooting table. [05-testing.md](05-testing.md).
- **06 Advanced** - metadata filtering, multiple knowledge bases, guardrails, production concerns. [06-advanced.md](06-advanced.md).
- **07 Web Interface** - the Next.js UI, the streaming Lambda, CloudFront. [07-web-interface.md](07-web-interface.md).
- **S3 Vectors specifics and limits** - [S3-VECTORS-SETUP.md](S3-VECTORS-SETUP.md).
- **Quick start and architecture** - [QUICKSTART.md](../QUICKSTART.md), [ARCHITECTURE.md](../ARCHITECTURE.md).

## CI

- **Push checks** - `tsc`, `next build`, `cdk synth`, `terraform fmt` and `terraform validate` on every push; web lint and `node --test` for the NDJSON parser. [.github/workflows/ci.yml](../.github/workflows/ci.yml), [web/test/stream.test.mjs](../web/test/stream.test.mjs).
