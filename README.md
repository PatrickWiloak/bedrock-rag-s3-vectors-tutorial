<div align="center">

<a href="https://noblerworks.com/"><img src="https://raw.githubusercontent.com/NoblerWorks-HQ/IRONSIGHT/main/nobler-works-banner.JPG" alt="Nobler Works" width="240"></a>

### Built by [Patrick Wiloak](https://patrickwiloak.com) at [Nobler Works](https://noblerworks.com/)

We build custom software and products at Nobler Works. Open source projects and tutorials like this one are our way of giving back - we're nothing without the community that supports us.<br>
If you need custom software built, [get in touch](https://noblerworks.com/).

[![Website](https://img.shields.io/badge/Website-000000?style=for-the-badge&logo=googlechrome&logoColor=white)](https://noblerworks.com/)
[![X](https://img.shields.io/badge/X-000000?style=for-the-badge&logo=x&logoColor=white)](https://x.com/Nobler_Works)
[![YouTube](https://img.shields.io/badge/YouTube-FF0000?style=for-the-badge&logo=youtube&logoColor=white)](https://www.youtube.com/@NoblerWorks)
[![TikTok](https://img.shields.io/badge/TikTok-000000?style=for-the-badge&logo=tiktok&logoColor=white)](https://www.tiktok.com/@noblerworks)
[![Threads](https://img.shields.io/badge/Threads-000000?style=for-the-badge&logo=threads&logoColor=white)](https://www.threads.com/@noblerworks)

</div>

---

<div align="center">

# AWS Bedrock RAG Tutorial with S3 Vectors

**Build a retrieval-augmented Q&A system on Amazon Bedrock Knowledge Bases and S3 Vectors -
one command (CDK or Terraform), a Next.js UI, and the debugging tools to see what the retriever actually returned.**

[![License: MIT](https://img.shields.io/badge/License-MIT-3d5a80?style=flat-square)](LICENSE)
[![AWS Bedrock](https://img.shields.io/badge/AWS-Bedrock-FF9900?style=flat-square&logo=amazonaws&logoColor=white)](https://aws.amazon.com/bedrock/)
[![AWS CDK](https://img.shields.io/badge/IaC-AWS%20CDK-FF9900?style=flat-square&logo=amazonaws&logoColor=white)](https://aws.amazon.com/cdk/)
[![Terraform](https://img.shields.io/badge/IaC-Terraform-7B42BC?style=flat-square&logo=terraform&logoColor=white)](terraform/README.md)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Deploy time](https://img.shields.io/badge/deploy-%3C10%20min-2f7757?style=flat-square)](#quick-start)
![Cost vs OpenSearch](https://img.shields.io/badge/vs%20OpenSearch-up%20to%2090%25%20cheaper-2f7757?style=flat-square)

</div>

> **Tutorial:** Build a document Q&A system on AWS using Amazon Bedrock Knowledge Bases and S3 Vectors. Deployed with CDK or Terraform (your choice, same stack), streamed token-by-token through `RetrieveAndGenerateStream`, with a Next.js web UI and citations.

Learn how to build and deploy a **Retrieval-Augmented Generation (RAG)** system using Amazon Bedrock Knowledge Bases, Amazon S3 Vectors, and either AWS CDK or Terraform.

---

## 📢 What changed in v2.2 (October 2026)

- **Terraform is a first-class deploy path.** [`terraform/`](terraform/) builds the identical stack from first-party `hashicorp/aws` resources - `aws_s3vectors_vector_bucket`, `aws_s3vectors_index`, and the `S3_VECTORS` storage type on `aws_bedrockagent_knowledge_base` all exist now, so no community module and no `awscc` provider. `IAC=terraform ./scripts/deploy.sh full` does everything the CDK path does. See [terraform/README.md](terraform/README.md) for the differences.
- **Deployed and verified for real.** v2 shipped verified only by `tsc`, `cdk synth` and `next build`. v2.2 was deployed end to end from both paths, and that found bugs no synth-time check could: the browser must send an `x-amz-content-sha256` header for POSTs through CloudFront OAC, the Lambda role needs `bedrock:GetInferenceProfile`, the Claude 5.5 models require **both** prompt templates (each with `$query$`), outputs declared inside a construct get path-mangled keys, and the timestamp in resource names made every redeploy replace the knowledge base and lose its vectors. All fixed; `./test-bedrock.sh` now also *measures* that the answer streams through CloudFront rather than arriving in one buffered blob.
- **Default model is Claude Haiku 5.5** (`us.anthropic.claude-haiku-5-5`), the cheapest and fastest current model - the right default for a tutorial. Sonnet 5.5 and Opus 5.5 are one flag away.
- **The sample corpus is consistent.** The five `.docx` samples described a different fictional company, so answers could cite another company's policies as Nobler Works'. They are rebranded, and a duplicated handbook was removed: 16 documents now.
- **Hybrid search is documented correctly.** AWS states S3 Vectors is semantic-only; two chapters used to hedge. They no longer do.
- **Repository renamed** to `bedrock-rag-s3-vectors-tutorial` - there has been no agent since v2. GitHub redirects the old URL. `v1` and `v2.1` tags mark the earlier architectures.
- Shared pieces moved to [`config/`](config/): the prompt template and the CloudFront URL-rewrite function are read by both deploy paths. CI runs `tsc`, `next build`, `cdk synth`, `terraform fmt` and `terraform validate` on every push.

## 📢 What changed in v2 (August 2026)

If you used the original version of this tutorial, four things are materially different.

**1. S3 Vectors is generally available, with native CloudFormation support.**
The original tutorial was written while S3 Vectors was in preview, and leaned on the community [cdk-s3-vectors](https://github.com/bimnett/cdk-s3-vectors) library plus a manual console-setup guide to work around the missing CloudFormation resources. Those resources now exist - `AWS::S3Vectors::VectorBucket`, `AWS::S3Vectors::Index`, and an `S3VectorsConfiguration` storage type on `AWS::Bedrock::KnowledgeBase`. The stack is now plain `aws-cdk-lib`, and the manual-setup guide is gone.

**`cdk destroy` now works.** The old README's long manual-teardown checklist existed because custom resources could not clean themselves up. That is no longer the case.

**2. The Bedrock Agent is gone, replaced by `RetrieveAndGenerate`.**
On **July 30, 2026** Amazon Bedrock Agents became [Bedrock Agents Classic and closed to new customers](https://docs.aws.amazon.com/bedrock/latest/userguide/agents-classic-maintenance-mode.html). Accounts without prior Bedrock Agents usage now get an `AccessDeniedException` on `CreateAgent`, with no exception process. Since a tutorial's readers are by definition new to the service, the agent layer would have failed for almost everyone who tried it.

Bedrock **Knowledge Bases are explicitly not affected**, so the retrieval half of this tutorial is untouched. The agent has been replaced by a direct [`RetrieveAndGenerate`](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_agent-runtime_RetrieveAndGenerate.html) call, which performs the whole RAG loop - embed, search, prompt, generate, cite - in a single API call. It is simpler, cheaper, and available to everyone.

If you specifically want an *agent* (tools, multi-step orchestration, action groups), AWS's recommended path is now [Bedrock AgentCore](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/what-is-bedrock-agentcore.html), which is outside this tutorial's scope.

**3. Answers stream, and the API moved onto CloudFront.**
The chat endpoint is now a Lambda Function URL with `invokeMode: RESPONSE_STREAM`, served at `/api/*` from the same CloudFront distribution as the site. API Gateway is gone: its Lambda proxy integration buffers the whole response, which makes streaming impossible. Because the API is now same-origin, the runtime `config.json` lookup, the CORS configuration, and a trailing-slash URL-joining bug all disappeared with it.

**4. Model IDs are inference profiles now.**
Every current Claude model on Bedrock is served **exclusively** through a cross-Region inference profile - none of them support `ON_DEMAND` invocation any more. So model IDs look like `us.anthropic.claude-haiku-5-5`, not `anthropic.claude-3-sonnet-20240229-v1:0`. The old default model no longer exists in the Bedrock catalog at all. See [Choosing a model](#choosing-a-model).

---

## What You'll Build

By the end of this tutorial, you'll have a working **RAG system** that:

- Stores documents in S3, organised by domain (Financial, HR, Meeting Notes)
- Creates a **Bedrock Knowledge Base** using **S3 Vectors** for vector storage
- Answers questions with **`RetrieveAndGenerate`**, grounded in your documents
- Returns **citations** pointing back at the source documents
- **Streams answers token by token** to a Next.js web UI served through CloudFront
- Deploys with a **single command** and tears down with one

## Why S3 Vectors

S3 Vectors is a serverless vector store built into S3, and it is the cheapest practical vector backend for a knowledge base of this size:

- **Up to 90% lower cost** than OpenSearch Serverless, which bills for always-on capacity units
- **Fully serverless** - no cluster, no capacity planning, no idle cost
- **Fast to create** - a vector bucket and index come up in under a minute

The tradeoff is that S3 Vectors is optimised for cost over latency. For a documentation Q&A workload this is the right trade; for high-QPS, low-latency search, OpenSearch Serverless still wins.

## Architecture

```
┌─────────────────┐
│  Users/Browsers │
└────────┬────────┘
         │ HTTPS
         ↓
┌─────────────────────────────────────────────────────────┐
│  CloudFront - one distribution, two behaviours          │
│                                                         │
│   default  ──► S3 static site (private, via OAC)        │
│   /api/*   ──► Lambda Function URL (private, via OAC)   │
│               compress=false, caching disabled          │
└────────┬────────────────────────────────────────────────┘
         │  the browser POSTs to a relative /api/chat -
         │  same origin, so no endpoint discovery, no CORS
         ↓
┌─────────────────────────────────────────────────────────┐
│  Streaming Lambda (RESPONSE_STREAM)                     │
│  • RetrieveAndGenerateStream                            │
│  • emits NDJSON: session · text · citation · done       │
└────────┬────────────────────────────────────────────────┘
         │
         ↓
┌─────────────────────────────────────────────────────────┐
│  Bedrock Knowledge Base                                 │
│                                                         │
│   question ──► Titan Embeddings v2 ──► query vector     │
│                                            │            │
│                                            ▼            │
│                              S3 Vectors index (cosine)  │
│                                            │            │
│                          top-k chunks ─────┘            │
│                                            │            │
│                                            ▼            │
│                        Claude (inference profile)       │
│                          → grounded answer + citations  │
└─────────────────────────────────────────────────────────┘
         ▲
         │ ingestion (StartIngestionJob)
         │
┌─────────────────────────────────────────────────────────┐
│  S3 document bucket                                     │
│  Financial-Data/  Human-Resources/  Meeting-Notes/      │
└─────────────────────────────────────────────────────────┘
```

See [ARCHITECTURE.md](ARCHITECTURE.md) for the request flow in detail.

## Prerequisites

> **🎓 New to AWS?**
>
> If you don't have an AWS account yet or need help setting up an IAM admin user, MFA, and billing alerts, watch this first:
>
> **[AWS Account Setup for Beginners](https://youtu.be/DuUmIMW0Xr0?si=teRTToyPucL9Zf3Y)** (15 minutes)
>
> Once you have an admin user set up, come back here.

You need:

- ✅ An AWS account with **Bedrock model access enabled** (see below)
- ✅ **Node.js 20+**
- ✅ AWS CLI configured with credentials
- ✅ **One of:** AWS CDK (`npm install -g aws-cdk`) **plus Docker running** (CDK bundles the Lambda in a container), **or** Terraform 1.10+ (no Docker needed) - see [Deploying with Terraform](#deploying-with-terraform)
- ✅ `jq` - used by `test-bedrock.sh` and `scripts/deploy.sh`
- ✅ The [required IAM permissions](#required-iam-permissions)

> **Note**: This project uses npm workspaces. `npm install` at the root installs both the CDK infrastructure and the Next.js web UI.

### Choosing a model

**The default is `us.anthropic.claude-haiku-5-5`.**

Every current Claude model on Bedrock is reachable only through a **cross-Region inference profile**, so model IDs carry a Region prefix (`us.`, `eu.`, `apac.`, or `global.`). Check what your account can actually reach:

```bash
# Inference profiles you can use (this is the list that matters)
aws bedrock list-inference-profiles --region us-east-1 \
  --query "inferenceProfileSummaries[?contains(inferenceProfileId, 'claude')].[inferenceProfileId,status]" \
  --output table

# Underlying foundation models and their lifecycle status
aws bedrock list-foundation-models --region us-east-1 --by-provider anthropic \
  --query 'modelSummaries[].[modelId,modelLifecycle.status]' --output table
```

Override the model at deploy time without editing any code:

```bash
cdk deploy --context modelId=us.anthropic.claude-sonnet-5-5
```

**Sensible choices:**

| Model | When to use it |
|---|---|
| `us.anthropic.claude-haiku-5-5` | **Default.** Cheapest and fastest; answers grounded in a small corpus do not need more. |
| `us.anthropic.claude-sonnet-5-5` | Stronger synthesis across several documents, at a few times the cost. |
| `us.anthropic.claude-opus-5-5` | Best answer quality. Use it when you want to compare, not to learn. |

**About model access:** Bedrock grants access to most models automatically, but some require you to submit use-case details first (usually approved within 1-2 business days). If a query fails with `AccessDeniedException` on the model, enable it under **Model access** in the Bedrock console. `./test-bedrock.sh` diagnoses this specifically.

The **embedding** model is separate and is `amazon.titan-embed-text-v2:0` (1024 dimensions). Its dimension must match the S3 Vectors index dimension - change both together in [lib/s3-rag-stack.ts](lib/s3-rag-stack.ts) if you swap it.

### Required IAM Permissions

> **⚠️ Do this BEFORE running the deploy script.** The deploy script cannot grant you permissions - you or your administrator must attach the policy first.

This repository ships a ready-to-use policy in [iam-policy.json](iam-policy.json). It covers the Bedrock and S3 Vectors permissions this tutorial needs, **on top of** the permissions CDK normally uses (CloudFormation, Lambda, CloudFront), which the CDK bootstrap roles usually provide.

```bash
# 1. Clone the repository
git clone https://github.com/PatrickWiloak/bedrock-rag-s3-vectors-tutorial.git
cd bedrock-rag-s3-vectors-tutorial

# 2. Get your AWS account ID and IAM username
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
IAM_USER=$(aws sts get-caller-identity --query Arn --output text | cut -d'/' -f2)

# 3. Create the policy
aws iam create-policy \
  --policy-name BedrockRagTutorialPolicy \
  --policy-document file://iam-policy.json

# 4. Attach it to your user
aws iam attach-user-policy \
  --user-name "$IAM_USER" \
  --policy-arn "arn:aws:iam::${ACCOUNT_ID}:policy/BedrockRagTutorialPolicy"
```

If you already have `AdministratorAccess`, you can skip this.

## Quick Start

### Option 1: Automated setup (fastest) 🚀

```bash
git clone https://github.com/PatrickWiloak/bedrock-rag-s3-vectors-tutorial.git
cd bedrock-rag-s3-vectors-tutorial
npm install
./scripts/deploy.sh full
```

`full` checks prerequisites, builds the web UI, deploys the stack, uploads the sample documents, waits for ingestion, runs a health check, and prints the CloudFront URL.

Prefer Terraform? Same script, same result:

```bash
IAC=terraform ./scripts/deploy.sh full
```

The script has subcommands for everything else:

```bash
./scripts/deploy.sh infra      # cdk deploy only
./scripts/deploy.sh frontend   # rebuild and redeploy the UI
./scripts/deploy.sh docs       # re-upload documents and re-ingest
./scripts/deploy.sh ingest     # re-ingest what is already in S3
./scripts/deploy.sh diff       # cdk diff
./scripts/deploy.sh status     # resource IDs and URLs
./scripts/deploy.sh destroy    # tear down (typed confirmation)
```

### Option 2: Step by step (recommended for learning) 🎓

```bash
# Install dependencies (root + web workspace)
npm install

# Build the Next.js static export - the stack uploads web/out
npm run build:web

# Bootstrap CDK (first time in this account/Region only)
cdk bootstrap

# Deploy
npx cdk deploy

# Upload the sample documents and start ingestion
npm run upload-docs

# Watch ingestion finish (2-5 minutes)
npm run check-status

# Ask it questions
npm run test-rag
npm run test-rag interactive
```

### Option 3: Local web UI development 💻

```bash
npm run build:web       # or: npm run dev --workspace=web
```

See [web/README.md](web/README.md) for the UI development workflow.

### Verifying a deployment

`./test-bedrock.sh` walks the whole stack bottom-up - credentials, stack outputs, model access, knowledge base state, ingestion status, a real end-to-end query, and the streaming endpoint - and stops at the first thing that is actually broken. The last check time-stamps each streamed line and fails if the whole answer arrived in one instant, which is what a buffering CloudFront behaviour looks like. Run it whenever something doesn't work (`IAC=terraform ./test-bedrock.sh` for a Terraform deployment).

## Deploying with Terraform

[`terraform/`](terraform/) is a complete second implementation of the stack - the same buckets, index, knowledge base, streaming Lambda and CloudFront distribution - in plain Terraform against the `hashicorp/aws` provider. Nothing in it is a community module; S3 Vectors and the `S3_VECTORS` knowledge base storage type are first-party resources now.

```bash
IAC=terraform ./scripts/deploy.sh full      # deploy everything
IAC=terraform ./test-bedrock.sh             # verify, including streaming
IAC=terraform ./scripts/deploy.sh destroy   # tear down
```

The two paths read the same [`config/prompt-template.txt`](config/prompt-template.txt) and [`config/cloudfront-url-rewrite.js`](config/cloudfront-url-rewrite.js), so they cannot drift apart on behaviour. What *is* different (Lambda packaging without Docker, per-file site upload, a random name suffix instead of a timestamp) is explained in [terraform/README.md](terraform/README.md). The chapters in `docs/` walk the CDK code; every resource they describe has a same-named counterpart in `terraform/`.

## Sample Data: Nobler Works

The tutorial includes **16 realistic sample documents** for a fictional SaaS company, organised into three folders. Alongside the Markdown files listed below, five are `.docx` - deliberately, so you can see Bedrock's parsing handle more than plain text:

### 📊 Financial-Data/
- **Q4 2024 Quarterly Report** - financial results ($12.4M revenue, profitability metrics)
- **2025 Annual Budget** - departmental budgets, headcount plan, $52.8M total
- **Corporate Expense Policy** - travel, meals, equipment reimbursement
- **Accounts Receivable Aging Report** - AR analysis, collections, DSO metrics

### 👥 Human-Resources/
- **Employee Handbook** - employment policies, compensation, benefits overview
- **Benefits Guide 2025** - medical, dental, vision, 401(k), PTO
- **Remote Work Policy** - hybrid/remote guidelines, home office stipends
- **Performance Review Guidelines** - rating scale, calibration, PIP procedures

### 📝 Meeting-Notes/
- **Executive Leadership Meeting (Jan 2025)** - Q4 results, 2025 strategy, org changes
- **Product Roadmap Planning (Q1 2025)** - AI features, mobile app, API marketplace
- **Engineering Sprint Retrospective** - Sprint 24 review, velocity, technical debt

Plus `.docx` files for the dress code policy, the vacation policy, and three further meeting notes (a CS team sync, marketing campaign planning, and general meeting notes).

**Try these questions:**
- "What was our Q4 2024 revenue?"
- "What are our PTO benefits?"
- "What are the company's top priorities for 2025?"
- "What's our remote work policy?"
- "How much is the home office stipend?"

## Tutorial Structure

| Chapter | What it covers |
|---|---|
| [01 - Understanding RAG](docs/01-understanding.md) | What RAG is, how embeddings and vector search work, why S3 Vectors |
| [02 - Infrastructure](docs/02-infrastructure.md) | The CDK stack, resource by resource |
| [03 - Querying](docs/03-querying.md) | `RetrieveAndGenerate`, sessions, citations |
| [04 - Customization](docs/04-customization.md) | Chunking, prompt templates, models, retrieval tuning |
| [05 - Testing](docs/05-testing.md) | Test scripts, evaluating answer quality, debugging |
| [06 - Advanced](docs/06-advanced.md) | Metadata filtering, multiple knowledge bases, guardrails, production concerns |
| [07 - Web Interface](docs/07-web-interface.md) | The Next.js UI, the streaming Lambda, CloudFront |
| [Terraform](terraform/README.md) | The same stack in Terraform, and how it differs from the CDK path |

Also see [docs/S3-VECTORS-SETUP.md](docs/S3-VECTORS-SETUP.md) for S3 Vectors specifics and limits.

## Project Structure

```
bedrock-rag-s3-vectors-tutorial/
├── README.md                       # This file
├── ARCHITECTURE.md                 # Request flow in detail
├── QUICKSTART.md                   # 10-minute quick start
├── CLAUDE.md                       # Context for AI assistants working here
├── TODO.md                         # Open work on this repo
├── test-bedrock.sh                 # Bottom-up deployment diagnostic (incl. a streaming check)
├── iam-policy.json                 # Permissions needed to deploy
├── .nvmrc                          # Node version (22)
├── .github/workflows/ci.yml        # tsc, next build, cdk synth, terraform fmt + validate
├── config/
│   ├── prompt-template.txt         # Answer style - read by BOTH deploy paths
│   └── cloudfront-url-rewrite.js   # Clean-URL viewer-request function - read by both
├── docs/                           # Tutorial chapters 01-07
├── terraform/                      # The same stack in Terraform (see its README)
│   ├── knowledge_base.tf           # S3 Vectors + Knowledge Base + data source
│   ├── lambda.tf                   # Streaming Lambda + Function URL
│   ├── cloudfront.tf               # CloudFront, OACs, website bucket
│   └── web.tf                      # Static export upload
├── bin/
│   └── s3-rag-app.ts               # CDK app entry point
├── lib/
│   ├── s3-rag-stack.ts             # The stack: bucket, KB, web hosting
│   ├── knowledge-base-construct.ts # S3 Vectors + Knowledge Base + data source
│   └── web-hosting-construct.ts    # Streaming Lambda + CloudFront + S3
├── lambda/
│   └── chat.mjs                    # Streaming RetrieveAndGenerateStream handler
├── scripts/
│   ├── deploy.sh                   # Deployment entry point (subcommands; IAC=cdk|terraform)
│   ├── outputs.ts                  # Resource IDs from env (Terraform) or CloudFormation (CDK)
│   ├── upload-documents.ts         # Upload sample docs, start ingestion
│   ├── test-rag.ts                 # Query from the terminal (demo/interactive)
│   └── check-status.ts             # Ingestion job status
├── sample-data/knowledge-docs/     # The Nobler Works documents
└── web/                            # Next.js static-export UI
    ├── next.config.ts              # output: 'export'
    └── app/
        ├── page.tsx                # Chat interface (NDJSON stream parser)
        ├── components/             # QuickStarters, Citations, MisconfiguredBanner
        └── lib/types.ts            # Shared Citation / StreamEvent types
```

## What You'll Learn

**AWS services** - S3, S3 Vectors, Bedrock Knowledge Bases, Bedrock runtime models, Lambda Function URLs, CloudFront (behaviours, Functions, Origin Access Control), IAM.

**CDK** - stacks and constructs, L1 vs L2, resource dependencies, IAM grants, asset bundling, static site deployment.

**Terraform** - the same resources as first-party provider resources, `archive_file` Lambda packaging, `fileset()` uploads with content types, plan-time `precondition`s, and how CloudFront OAC for a Lambda Function URL is wired without a construct doing it for you.

**RAG** - chunking and overlap, embeddings and dimensions, cosine similarity, top-k retrieval, grounding and citations, prompt templates.

**Bedrock APIs** - `RetrieveAndGenerateStream`, `RetrieveAndGenerate`, `Retrieve`, ingestion jobs, inference profiles, and why the distinction between a foundation model and an inference profile matters for IAM.

**Streaming** - Lambda `RESPONSE_STREAM` invoke mode, `awslambda.streamifyResponse`, an NDJSON wire protocol, incremental parsing in the browser, and why CloudFront compression must be off on a streaming behaviour.

## Customization Points

1. **Document processing** - chunk size and overlap ([lib/s3-rag-stack.ts](lib/s3-rag-stack.ts)), file formats, metadata
2. **Answer style** - [config/prompt-template.txt](config/prompt-template.txt), read by both deploy paths
3. **Retrieval** - `numberOfResults`, metadata filtering, search type
4. **Model** - `--context modelId=...` at deploy time, or the `DEFAULT_MODEL_ID` constant

See [docs/04-customization.md](docs/04-customization.md).

## Cost & Cleanup

Running this tutorial costs roughly **$1-5 total**, dominated by model inference:

| Service | Cost |
|---|---|
| S3 (documents) | ~$0.023/GB/month - negligible at this size |
| S3 Vectors | Pay per request and per GB stored - cents for this dataset |
| Bedrock embeddings | One-off at ingestion; Titan v2 is very cheap |
| Bedrock generation | The main cost. Per token, varies a lot by model - Haiku 5.5 (the default) is far cheaper than Opus 5.5 |
| Lambda | Free tier covers tutorial usage |
| CloudFront | Free tier covers tutorial usage |

### Cleanup

Everything in the stack is native CloudFormation (or first-party Terraform resources), so teardown is one command:

```bash
./scripts/deploy.sh destroy                 # CDK (or: npm run destroy)
IAC=terraform ./scripts/deploy.sh destroy   # Terraform
```

This removes the document bucket, the vector bucket and index, the knowledge base, the data source, the website bucket, CloudFront, and the Lambda.

> **The old manual-teardown checklist is no longer needed.** It existed because the preview-era custom resources could not reliably delete themselves. If you deployed the *original* version of this tutorial, that stack still needs the manual steps - see the [v1 README](https://github.com/PatrickWiloak/bedrock-rag-s3-vectors-tutorial/blob/e7b0810/README.md#detailed-cleanup-steps-option-a).

Confirm nothing is left behind:

```bash
aws cloudformation describe-stacks --stack-name S3VectorRAGStack   # should error: does not exist
aws s3vectors list-vector-buckets --region us-east-1
aws bedrock-agent list-knowledge-bases --region us-east-1
```

## Getting Help

- Run `./test-bedrock.sh` first - it names the specific failing layer
- Chapter [05 - Testing](docs/05-testing.md) has a troubleshooting table
- [QUICKSTART.md](QUICKSTART.md) for the condensed path

### Official AWS documentation

- **S3 Vectors**: [Overview](https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-vectors.html) | [Getting started](https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-vectors-getting-started.html)
- **Bedrock Knowledge Bases**: [User guide](https://docs.aws.amazon.com/bedrock/latest/userguide/knowledge-base.html) | [RetrieveAndGenerate API](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_agent-runtime_RetrieveAndGenerate.html)
- **Inference profiles**: [Supported Regions and models](https://docs.aws.amazon.com/bedrock/latest/userguide/inference-profiles-support.html)
- **Bedrock AgentCore**: [What is AgentCore](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/what-is-bedrock-agentcore.html) - if you need agents
- **AWS CDK**: [Developer guide](https://docs.aws.amazon.com/cdk/v2/guide/home.html)

---

## Credits & Acknowledgments

### Community libraries

Versions 1.x of this tutorial were built on **[cdk-s3-vectors](https://github.com/bimnett/cdk-s3-vectors)** by Bimnet Tesfamariam ([@bimnett](https://github.com/bimnett)), which provided CDK constructs for S3 Vectors during the preview, before AWS published CloudFormation support.

v2 uses the now-native `aws-cdk-lib/aws-s3vectors` constructs and no longer depends on it - but that library is the reason this tutorial existed at all during the preview period. 🙏 Thank you, Bimnet.

### Tutorial authors

- **Patrick Wiloak** - architecture, implementation, and documentation
- **Daniel Casale** - collaboration and testing

## License

MIT - see [LICENSE](LICENSE).
