# Step 1: Understanding the Basics

Before deploying anything, it's worth understanding what you're building and why each piece exists.

## What is RAG?

**Retrieval-Augmented Generation** gives a language model access to information it was never trained on, by looking that information up at query time and putting it in the prompt.

### The problem RAG solves

A foundation model knows what was in its training data. It does not know:

- Your company's Q4 revenue
- Your PTO policy
- What was decided in last week's leadership meeting
- Anything that happened after its training cutoff

Ask it anyway and you get one of two bad outcomes: a refusal, or a confident invention. RAG fixes this by retrieving the relevant passages from *your* documents first, then asking the model to answer using only those passages.

### How RAG works

```
                          INGESTION (once per document change)
┌──────────┐    ┌──────────┐    ┌────────────┐    ┌──────────────┐
│ Document │───►│  Chunk   │───►│   Embed    │───►│ Vector store │
└──────────┘    └──────────┘    └────────────┘    └──────────────┘

                          QUERY (every question)
┌──────────┐    ┌────────────┐    ┌──────────────┐    ┌───────────┐
│ Question │───►│   Embed    │───►│Similarity    │───►│  Top-k    │
└──────────┘    └────────────┘    │search        │    │  chunks   │
                                  └──────────────┘    └─────┬─────┘
                                                            │
                    ┌───────────────────────────────────────┘
                    ▼
          ┌──────────────────────┐    ┌──────────────────┐
          │ Prompt = template +  │───►│ Foundation model │──► Answer
          │ chunks + question    │    └──────────────────┘    + citations
          └──────────────────────┘
```

The key insight: **the model isn't trained on your data, and isn't fine-tuned. It's handed the relevant text at query time.** Update a document, re-run ingestion, and the answers change immediately.

### RAG components

| Component | Role | What this tutorial uses |
|---|---|---|
| Document store | Holds the source files | Amazon S3 |
| Chunker | Splits documents into retrievable pieces | Bedrock fixed-size chunking |
| Embedding model | Turns text into vectors | Titan Text Embeddings V2 |
| Vector store | Stores vectors, does similarity search | **Amazon S3 Vectors** |
| Retriever | Finds the top-k relevant chunks | Bedrock Knowledge Base |
| Generator | Writes the answer | Claude, via a Bedrock inference profile |
| Orchestrator | Wires the above together | `RetrieveAndGenerateStream` (one streaming API call) |

## What is Amazon Bedrock?

Bedrock is AWS's managed service for foundation models. You call an API; AWS runs the model. No GPUs to provision, no model weights to host.

### Key features used here

- **Foundation models** from Anthropic, Amazon, Meta, Cohere and others behind one API
- **Knowledge Bases** - managed RAG: ingestion, chunking, embedding, retrieval, and generation
- **Inference profiles** - cross-Region routing for capacity and throughput
- **Guardrails** - content filtering and topic restrictions (see [chapter 06](06-advanced.md))

### Foundation models and inference profiles

This is the single most common stumbling block, so it's worth being precise.

A **foundation model** has an ID like `anthropic.claude-haiku-5-5`. An **inference profile** has an ID like `us.anthropic.claude-haiku-5-5` and routes your request to that model in one of several Regions.

**Every current Claude model on Bedrock is inference-profile only.** None of them support direct `ON_DEMAND` invocation. Check for yourself:

```bash
aws bedrock list-foundation-models --region us-east-1 --by-provider anthropic \
  --query 'modelSummaries[?modelLifecycle.status==`ACTIVE`].[modelId,join(`,`,inferenceTypesSupported)]' \
  --output table
```

Everything returned says `INFERENCE_PROFILE`. This affects two things:

1. **The model ID you configure** must carry the Region prefix.
2. **Your IAM policy** must allow `bedrock:InvokeModel` on both the profile ARN *and* the underlying foundation model ARN - see [ARCHITECTURE.md](../ARCHITECTURE.md#iam-and-why-inference-profiles-complicate-it).

## What is vector search?

### How it works

An embedding model maps text to a point in high-dimensional space - 1024 dimensions for Titan V2 - positioned so that **text with similar meaning lands close together**. Not similar *spelling*: similar *meaning*.

Similarity is measured with cosine distance, the angle between two vectors. Searching means embedding the question and finding the nearest stored chunks.

### Example

Three chunks, embedded:

```
"Employees receive 20 days of paid time off"      → [0.21, -0.44, 0.09, ...]
"Our PTO allowance is four weeks annually"        → [0.19, -0.41, 0.11, ...]   ← very close
"The Q4 gross margin improved to 71%"             → [-0.62, 0.30, -0.55, ...]  ← far away
```

Ask *"how much vacation do I get?"* and it embeds near the first two, even though it shares almost no words with either. That's why vector search beats keyword search for question answering.

## Why S3 Vectors

Bedrock Knowledge Bases support several vector stores: OpenSearch Serverless, OpenSearch Managed, Pinecone, Aurora RDS, Neptune Analytics, MongoDB Atlas, and **S3 Vectors**.

| | S3 Vectors | OpenSearch Serverless |
|---|---|---|
| Billing model | Per request + per GB stored | Provisioned capacity units, always on |
| Idle cost | Effectively zero | Meaningful - it never scales to zero |
| Creation time | Under a minute | 15-20 minutes |
| Latency | Higher | Lower |
| Best for | Document Q&A, cost-sensitive workloads | High-QPS, latency-sensitive search |

For a knowledge base of a few dozen documents queried occasionally, S3 Vectors is dramatically cheaper - AWS cites up to 90% savings - and that is exactly this tutorial's shape.

> **S3 Vectors is generally available** and has native CloudFormation support (`AWS::S3Vectors::VectorBucket`, `AWS::S3Vectors::Index`). Earlier versions of this tutorial predated that and used a community CDK library plus manual console steps; that is no longer necessary.

## Key concepts

### Document chunking

Documents are split before embedding, for two reasons: embedding models have input limits, and retrieving a whole 40-page handbook to answer one question wastes context and dilutes relevance.

This tutorial uses `FIXED_SIZE` chunking at **300 tokens** with **7% overlap**.

**Overlap matters.** Without it, a sentence spanning a chunk boundary is split across two chunks and may be retrievable from neither. Overlap duplicates a little text at each boundary so the sentence survives intact in at least one chunk.

Trade-offs:

| Chunk size | Effect |
|---|---|
| Small (100-300 tokens) | Precise retrieval, but may lack surrounding context |
| Medium (300-800) | Good default balance |
| Large (800-2000) | Rich context, but noisier retrieval and more tokens per query |

### Embeddings

Titan Text Embeddings V2 supports 256, 512, or 1024 dimensions. This tutorial uses 1024.

**The embedding dimension and the vector index dimension must match.** They are configured in two places in [lib/s3-rag-stack.ts](../lib/s3-rag-stack.ts) and [lib/knowledge-base-construct.ts](../lib/knowledge-base-construct.ts) - change them together, and re-create the index if you change it after deploying (dimension is a create-only property).

More dimensions means better semantic fidelity and more storage. 1024 is the sensible default.

### Prompt engineering

The retrieved chunks don't go to the model raw. They're inserted into a prompt template that tells the model how to behave. This tutorial's template lives in [config/prompt-template.txt](../config/prompt-template.txt); the CDK stack and the Terraform configuration both read that one file.

A template **must** contain the `$search_results$` placeholder, which Bedrock replaces with the retrieved chunks. Omit it and the model gets no context at all.

Good templates instruct the model to:
- Answer only from the supplied results
- Say so plainly when the results don't contain the answer
- Cite which document each claim came from

### Session management

`RetrieveAndGenerate` can hold conversation history server-side, so follow-up questions like *"and what about dental?"* resolve against the previous turn.

The mechanic that trips people up: **Bedrock issues the session ID, not you.** The first request in a conversation omits `sessionId`; the response contains one; subsequent requests send it back. A client-invented ID is rejected.

## Cost breakdown

Light usage (a few hundred queries while working through the tutorial):

| Item | Rough cost |
|---|---|
| S3 document storage | Pennies |
| S3 Vectors storage + requests | Pennies |
| Titan embeddings (ingestion) | Pennies - a one-off for 16 documents |
| Claude generation | The dominant cost; varies by model and query count |
| Lambda, CloudFront | Free tier |

**Total: roughly $1-5.** The default `us.anthropic.claude-haiku-5-5` keeps the dominant line item small; Sonnet 5.5 or Opus 5.5 multiply it several times.

## Use cases

The same architecture supports:

1. **Customer support** - answer from product docs and past tickets, with citations
2. **Internal knowledge base** - policies, handbooks, runbooks
3. **Research assistant** - query a corpus of papers or reports
4. **Product documentation** - conversational docs search

## Prerequisites check

### Enable Bedrock model access

Bedrock grants most models automatically, but some need a one-time use-case submission. In the Bedrock console, open **Model access** and confirm your chosen model is enabled.

Verify from the CLI:

```bash
aws bedrock list-inference-profiles --region us-east-1 \
  --query "inferenceProfileSummaries[?contains(inferenceProfileId, 'claude')].[inferenceProfileId,status]" \
  --output table
```

### Verify tooling

```bash
node --version      # 20+
aws --version
cdk --version       # npm install -g aws-cdk
docker info         # must be running - CDK bundles the Lambda in a container
jq --version
aws sts get-caller-identity
```

## Next steps

→ **[Step 2: Setting Up Infrastructure](02-infrastructure.md)** - walk through the CDK stack and deploy it.

## Additional resources

- [Amazon Bedrock Knowledge Bases](https://docs.aws.amazon.com/bedrock/latest/userguide/knowledge-base.html)
- [Amazon S3 Vectors](https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-vectors.html)
- [Supported Regions and models for inference profiles](https://docs.aws.amazon.com/bedrock/latest/userguide/inference-profiles-support.html)
- [RetrieveAndGenerate API reference](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_agent-runtime_RetrieveAndGenerate.html)
