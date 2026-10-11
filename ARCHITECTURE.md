# Architecture & Request Flow

This document traces what actually happens when a document is ingested and when a question is asked.

## System Architecture

```
                          ┌──────────────────┐
                          │  Users/Browsers  │
                          └────────┬─────────┘
                                   │ HTTPS
                                   ▼
        ┌──────────────────────────────────────────────────────┐
        │  CloudFront - ONE distribution, two behaviours        │
        │                                                      │
        │  viewer-request Function rewrites clean URLs         │
        │  ("/foo" -> "/foo/index.html"), skipping /api/*      │
        └───────┬──────────────────────────────┬───────────────┘
       default  │                              │  /api/*
                ▼                              ▼
   ┌────────────────────────┐   ┌──────────────────────────────┐
   │  S3 website bucket     │   │  Lambda Function URL         │
   │  Next.js static export │   │  AuthType: AWS_IAM           │
   │  private, S3 OAC       │   │  InvokeMode: RESPONSE_STREAM │
   └────────────────────────┘   │  private, Lambda OAC         │
                                │  compress=false, no caching  │
                                └──────────────┬───────────────┘
                                               ▼
   ┌───────────────────────────────────────────────────────────────────┐
   │                    Bedrock Knowledge Base                         │
   │                    (RetrieveAndGenerateStream)                    │
   │                                                                   │
   │   1. embed question    ──►  amazon.titan-embed-text-v2:0          │
   │   2. similarity search ──►  S3 Vectors index (cosine, 1024-dim)   │
   │   3. build prompt      ──►  top-k chunks + PROMPT_TEMPLATE        │
   │   4. generate          ──►  Claude via inference profile          │
   │                             → text deltas + citation events       │
   └───────────────────────────────────────────────────────────────────┘
                                               ▲
                                               │ ingestion
   ┌───────────────────────────────────────────┴───────────────────────┐
   │  S3 document bucket                                               │
   │  Financial-Data/ · Human-Resources/ · Meeting-Notes/              │
   └───────────────────────────────────────────────────────────────────┘
```

**Both origins are private.** The S3 bucket blocks all public access and is reachable only through an S3-type Origin Access Control; the Function URL is `AWS_IAM` and reachable only through a Lambda-type OAC, with CloudFront signing each request. Neither has a publicly callable URL of its own.

## Why one distribution instead of CloudFront + API Gateway

Serving the API from the same distribution as the site is the decision that most shapes this codebase:

- **Nothing to discover at runtime.** The browser POSTs to a relative `/api/chat`. There is no API URL to inject at deploy time, so no `config.json` fetch on page load.
- **No CORS.** Same origin means no preflight, no `Access-Control-Allow-*` headers, and no chance of a Lambda error response being discarded by the browser for lacking them.
- **No URL joining.** Concatenating a stage URL that ends in `/` with `/chat` yields `//chat`, which fails in a way that looks like a permissions problem. That bug cannot exist here.
- **Streaming is possible at all.** API Gateway's Lambda proxy integration buffers the entire response before returning it. A Function URL with `RESPONSE_STREAM` does not.

The cost is one non-obvious setting, called out in [lib/web-hosting-construct.ts](lib/web-hosting-construct.ts):

```ts
compress: false,  // compression buffers the response and breaks streaming
```

Leave compression on and everything still *works* - it just stops streaming, silently, and you get the whole answer at once with no error anywhere.

## Ingestion flow

Ingestion runs when you call `StartIngestionJob` (which `npm run upload-docs` and `./scripts/deploy.sh docs` do for you). It is **not** automatic on upload.

1. **Upload** - documents land in the S3 document bucket under a category folder.
2. **Scan** - the data source enumerates objects under its `inclusionPrefixes` (this stack indexes the whole bucket).
3. **Parse** - Bedrock extracts text. Markdown, PDF, DOCX, TXT, HTML, and CSV are supported.
4. **Chunk** - `FIXED_SIZE` chunking at 300 tokens with 7% overlap. Overlap keeps a sentence that straddles a boundary retrievable from either chunk.
5. **Embed** - each chunk goes through Titan Text Embeddings V2, producing a 1024-dimension float32 vector.
6. **Store** - vectors are written into the S3 Vectors index, alongside metadata: `AMAZON_BEDROCK_TEXT` (the chunk text) and `AMAZON_BEDROCK_METADATA` (source URI and friends).

Track it with `npm run check-status`.

> **Why those two metadata keys are marked non-filterable.** S3 Vectors allows 40KB of metadata per vector but only **2KB of *filterable* metadata**. The chunk text alone usually exceeds 2KB. Declaring `AMAZON_BEDROCK_TEXT` and `AMAZON_BEDROCK_METADATA` as `nonFilterableMetadataKeys` on the index is what prevents ingestion failing with `metadata must have at most 2048 bytes`. See [lib/knowledge-base-construct.ts](lib/knowledge-base-construct.ts).

## Query flow

```
browser              Lambda (streaming)          Bedrock KB
   │                        │                         │
   │ POST /api/chat         │                         │
   │ {message, sessionId?}  │                         │
   ├───────────────────────►│                         │
   │                        │ RetrieveAndGenerateStream
   │                        ├────────────────────────►│
   │ {"type":"session",...} │◄──── sessionId ─────────┤
   │◄───────────────────────┤                         │
   │                        │                         │ embed + search
   │ {"type":"text",...}    │◄──── output event ──────┤
   │◄───────────────────────┤                         │
   │ {"type":"citation",...}│◄──── citation event ────┤
   │◄───────────────────────┤                         │
   │ {"type":"text",...}    │◄──── output event ──────┤
   │◄───────────────────────┤          ...            │
   │ {"type":"done"}        │                         │
   │◄───────────────────────┤                         │
```

### One header the browser must send

CloudFront signs the origin request to the Function URL with SigV4, and Lambda does not accept unsigned payloads. So for any request **with a body** the client has to supply the SHA-256 of that body in an `x-amz-content-sha256` header - CloudFront cannot compute it on the client's behalf. [web/app/page.tsx](web/app/page.tsx) does this with the Web Crypto API before every POST; leave it out and the origin returns `The request signature we calculated does not match`, which looks like a misconfigured OAC and is not.

### Two prompt templates, not one

`RetrieveAndGenerate` runs two model calls: **orchestration** (turn the conversation into a search query) and **generation** (write the answer from the chunks). Each has a prompt template. Older models fall back to Bedrock's built-ins when you only set the generation template. The Claude 5.5 family does not: both templates are required, and each must contain `$query$` (the orchestration one also `$conversation_history$` and `$output_format_instructions$`), or the call is rejected with a `ValidationException`. Both templates live in [config/](config/) and are sent by the Lambda, the CLI query script and the diagnostic.

### The wire protocol

The Lambda emits **NDJSON** - one JSON object per line. Newline framing is the whole trick: it needs no library on either end, and a partially received line is trivially detectable.

| Event | Payload | When |
|---|---|---|
| `session` | `{sessionId}` | Once, before any text |
| `text` | `{delta}` | Repeatedly, as the model generates |
| `citation` | `{citation: {index, title, source, category, excerpt, uri}}` | As references are resolved |
| `done` | – | Exactly once, on success |
| `error` | `{message}` | Instead of `done`, on failure |

Because chunk boundaries fall wherever the network puts them rather than on newlines, the browser holds the trailing partial line in a buffer until the rest arrives:

```ts
buffer += decoder.decode(value, { stream: true });
const lines = buffer.split('\n');
buffer = lines.pop() ?? '';        // keep the incomplete tail
```

Dropping that one line is the classic way to end up with intermittently mangled JSON under load.

### Modelled errors do not throw

`RetrieveAndGenerateStream` delivers failures as *members of the stream union*, not as thrown exceptions:

```js
const modelledError =
  chunk.internalServerException ?? chunk.validationException ??
  chunk.accessDeniedException   ?? chunk.throttlingException  ?? ...;
```

A handler that only wraps the loop in `try/catch` will see one of these as an ordinary iteration, emit no text, and finish with a cheerful `done`. The user gets an empty answer and nothing is logged.

### Sessions

`RetrieveAndGenerate` keeps conversation history server-side and **issues its own session IDs**:

- The **first** request of a conversation must omit `sessionId` entirely.
- The `session` event carries the ID Bedrock assigned; send it back on later requests.
- A client-invented session ID is rejected with a validation error.

Both [lambda/chat.mjs](lambda/chat.mjs) and [web/app/page.tsx](web/app/page.tsx) implement this - the browser's `sessionId` state starts empty and is only ever populated from a `session` event.

### Citations

The Lambda resolves each S3 key into something readable before sending it - a friendly title, the category folder, and a trimmed excerpt - and deduplicates by URI. A raw `s3://docs-123456789012-us-east-1-260831/Human-Resources/remote-work-policy.md` tells the reader nothing about whether the answer came from the right place, which is the entire point of showing a citation.

## IAM, and why inference profiles complicate it

Two roles matter:

**The knowledge base role** (`KnowledgeBaseRole`) is assumed by `bedrock.amazonaws.com` and needs:
- `bedrock:InvokeModel` on the embedding model
- `s3:GetObject` / `s3:ListBucket` on the document bucket
- `s3vectors:PutVectors` / `QueryVectors` / `GetVectors` / `ListVectors` / `DeleteVectors` / `GetIndex` on the index

Its trust policy is scoped with `aws:SourceAccount`. It deliberately does **not** use `aws:SourceArn` against the knowledge base ARN, because the knowledge base needs the role ARN at creation time - referencing the knowledge base from the role would be a circular dependency.

**The Lambda role** needs:
- `bedrock:Retrieve` and `bedrock:RetrieveAndGenerate` on the knowledge base ARN
- `bedrock:GetInferenceProfile` on the inference profile ARN - `RetrieveAndGenerate` resolves the profile before invoking it, and without this the call fails with `Not authorized to call GetInferenceProfile`
- `bedrock:InvokeModel` and `bedrock:InvokeModelWithResponseStream` on **both** the inference profile ARN **and** the underlying foundation model ARN

That last point catches people out. An inference profile like `us.anthropic.claude-haiku-5-5` routes requests to the same model in one of several Regions, and authorization is evaluated against the foundation model in whichever Region serves the request. So the policy needs both:

```
arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-haiku-5-5
arn:aws:bedrock:*::foundation-model/anthropic.claude-haiku-5-5
```

Granting only the profile ARN produces an `AccessDeniedException` that names a Region you never configured. [lib/web-hosting-construct.ts](lib/web-hosting-construct.ts) derives the base model ARN by stripping the Region prefix.

## Resource inventory

Two deploy paths, one set of resources. The CDK column is native CloudFormation with no custom resources except CDK's own `S3AutoDeleteObjects` and `CDKBucketDeployment` (from `autoDeleteObjects: true` and the static site upload). The Terraform column is first-party `hashicorp/aws` resources throughout.

| Resource | CDK / CloudFormation | Terraform |
|---|---|---|
| Document bucket | `AWS::S3::Bucket` | `aws_s3_bucket` + policy/encryption/public-access-block |
| Vector bucket | `AWS::S3Vectors::VectorBucket` | `aws_s3vectors_vector_bucket` |
| Vector index | `AWS::S3Vectors::Index` | `aws_s3vectors_index` |
| Knowledge base | `AWS::Bedrock::KnowledgeBase` (`S3VectorsConfiguration`) | `aws_bedrockagent_knowledge_base` (`S3_VECTORS`) |
| Data source | `AWS::Bedrock::DataSource` | `aws_bedrockagent_data_source` |
| Chat handler | `AWS::Lambda::Function` (Docker-bundled) | `aws_lambda_function` + `archive_file` |
| Streaming endpoint | `AWS::Lambda::Url` (`InvokeMode: RESPONSE_STREAM`) | `aws_lambda_function_url` (`RESPONSE_STREAM`) + `aws_lambda_permission` |
| Website bucket | `AWS::S3::Bucket` + `CDKBucketDeployment` | `aws_s3_bucket` + one `aws_s3_object` per file |
| URL rewriter | `AWS::CloudFront::Function` | `aws_cloudfront_function` |
| CDN | `AWS::CloudFront::Distribution` + two `OriginAccessControl`s | `aws_cloudfront_distribution` + two `aws_cloudfront_origin_access_control`s |

The prompt template and the URL-rewrite function are read from [config/](config/) by both, so the two deployments answer and route identically.

## Learn More

- [docs/01-understanding.md](docs/01-understanding.md) - RAG concepts from scratch
- [docs/02-infrastructure.md](docs/02-infrastructure.md) - the CDK stack line by line
- [docs/03-querying.md](docs/03-querying.md) - the query API in depth
- [docs/07-web-interface.md](docs/07-web-interface.md) - the UI and the streaming path
