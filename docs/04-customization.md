# Step 4: Customization

Four levers control answer quality: the prompt template, the model, the chunking strategy, and retrieval depth. This chapter covers each, and which ones require re-ingestion.

## What requires re-ingestion

Get this straight before changing anything - it determines how expensive an experiment is.

| Change | Redeploy | Re-ingest | Index replaced |
|---|---|---|---|
| Prompt template | ✅ | – | – |
| Generation model | ✅ | – | – |
| `numberOfResults` | ✅ | – | – |
| Chunk size / overlap | ✅ | ✅ | – |
| Embedding model | ✅ | ✅ | ✅ |
| Embedding dimension | ✅ | ✅ | ✅ |

The first three are cheap to iterate on. The last three mean rebuilding the vector store.

## Answer style: the prompt template

This is the `RetrieveAndGenerate` equivalent of an agent's instructions, and the highest-leverage thing you can change. It lives in [config/prompt-template.txt](../config/prompt-template.txt), which [lib/s3-rag-stack.ts](../lib/s3-rag-stack.ts) and [terraform/lambda.tf](../terraform/lambda.tf) both read, so the two deploy paths cannot drift apart.

There is a second, smaller template next to it: [config/orchestration-prompt-template.txt](../config/orchestration-prompt-template.txt). Before retrieval, `RetrieveAndGenerate` asks the model to turn the conversation into a search query; that is the *orchestration* step, and this template drives it. It must contain `$conversation_history$` and `$output_format_instructions$`.

Both templates end with `$output_format_instructions$`. In the generation template that placeholder is where Bedrock injects its own citation instructions; drop it and the model starts writing "according to Source 3" and the `citations` array thins out, because nothing told it how to mark attributions.

> **Why there are two.** Older models fall back to Bedrock's built-in orchestration prompt if you only customise generation. The Claude 5.5 models (the default Haiku 5.5 included) refuse the call unless **both** templates are supplied and each contains `$query$`. The error names exactly what is missing - `Custom prompt templates must be provided for both Orchestration and Generation` - and it only appears at query time, never at deploy time.

### The one hard rule

**The template must contain `$search_results$`.** Bedrock replaces that placeholder with the retrieved chunks. Leave it out and the model receives no context and answers from training data alone - which is exactly the failure mode RAG exists to prevent.

### Basic shape

```
You are <role> for <organisation>. You answer questions using the documents below.

Here are the search results:
$search_results$

How to respond:
- Answer only from the search results above. If they do not contain the answer, say so plainly rather than guessing.
- Name the document an answer came from.
- Be specific: include dates, amounts, percentages, policy details.
```

### Example: customer support

```
You are a support assistant for Acme Software. Answer using only the
documentation below.

Here are the search results:
$search_results$

Guidelines:
- Give the shortest correct answer, then offer to go deeper.
- Always link the doc page you used.
- If the answer is not in the results, say "I don't have documentation on
  that - I'd suggest contacting support@acme.com" and stop.
- Never speculate about pricing, contractual terms, or security posture.
```

### Example: technical documentation

```
You are a documentation assistant for the Acme API.

Here are the search results:
$search_results$

Guidelines:
- Prefer code examples over prose. Use fenced blocks with the right language tag.
- State the API version an example applies to.
- Flag deprecated parameters explicitly.
- If the results conflict, say so and cite both.
```

### Making it stop inventing answers

If the model answers questions the documents don't cover, the template is too permissive. Effective additions:

- "Answer **only** from the search results above."
- "If the search results do not contain the answer, reply exactly: 'That isn't covered in the documents I have access to.'"
- "Do not use general knowledge. Do not speculate."

### Applying a change

```bash
cdk deploy      # prompt template lives in the Lambda's environment
npm run test-rag
```

No re-ingestion needed.

## Model selection

### Choosing at deploy time

```bash
cdk deploy --context modelId=us.anthropic.claude-sonnet-5-5
```

Or change `DEFAULT_MODEL_ID` in [lib/s3-rag-stack.ts](../lib/s3-rag-stack.ts).

### The options

| Model ID | Character |
|---|---|
| `us.anthropic.claude-haiku-5-5` | Default. Fastest and cheapest; more than enough for lookup questions over a small corpus. |
| `us.anthropic.claude-sonnet-5-5` | Stronger reasoning and synthesis across multiple documents, at a few times the cost. |
| `us.anthropic.claude-opus-5-5` | Best quality. Worth trying on the cross-document questions to see what the extra spend buys. |

Check what your account can actually reach:

```bash
aws bedrock list-inference-profiles --region us-east-1 \
  --query "inferenceProfileSummaries[?contains(inferenceProfileId, 'claude')].[inferenceProfileId,status]" \
  --output table
```

### Which to pick

- **Lookup questions** ("what's the stipend?") - Haiku is fine and much cheaper
- **Synthesis across documents** ("how does our PTO compare to our stated values?") - Opus or Sonnet earns its cost
- **Working through the tutorial** - Haiku, then switch up if answers disappoint

> **Remember the ID prefix.** `us.anthropic.claude-haiku-5-5` is an inference profile; `anthropic.claude-haiku-5-5` is the underlying foundation model. Configure the profile. The IAM policy needs both - [lib/web-hosting-construct.ts](../lib/web-hosting-construct.ts) derives the second from the first.

## Chunking strategy

### Why it matters

Chunks are the unit of retrieval. A chunk that's too small lacks the context to be useful on its own; one that's too large drags irrelevant text into the prompt and dilutes the signal.

### Changing it

In [lib/s3-rag-stack.ts](../lib/s3-rag-stack.ts):

```typescript
const knowledgeBase = new KnowledgeBaseConstruct(this, 'KnowledgeBase', {
  chunkSize: 300,               // max tokens per chunk
  chunkOverlapPercentage: 7,    // percent of overlap between neighbours
});
```

Then:

```bash
cdk deploy
npm run upload-docs     # re-ingest - existing vectors are stale
```

### Guidelines

| Content | Suggested chunk size |
|---|---|
| FAQs, short policies, structured records | 200-300 |
| General documents (this tutorial's default) | 300-500 |
| Narrative prose, meeting notes, long reports | 500-1000 |
| Legal or technical text where context is everything | 1000-2000 |

### Overlap

Overlap duplicates a little text at each boundary so a sentence spanning two chunks survives intact in at least one.

- **0%** - risks losing boundary-spanning facts
- **5-10%** - sensible default (this tutorial uses 7%)
- **20%+** - better recall, but more vectors, more storage, more cost

### Other chunking strategies

Bedrock also supports `NONE` (one chunk per document), `HIERARCHICAL` (parent/child chunks - retrieve the child, return the parent), and `SEMANTIC` (split at meaning boundaries). This tutorial uses `FIXED_SIZE` because it's predictable and easy to reason about. `HIERARCHICAL` is worth exploring for long structured documents.

## Embedding model

### Options

| Model | Dimensions | Notes |
|---|---|---|
| `amazon.titan-embed-text-v2:0` | 256 / 512 / **1024** | Default. Good quality, low cost. |
| `amazon.titan-embed-text-v1` | 1536 | Older generation. |
| `cohere.embed-english-v3` | 1024 | Strong English-only performance. |
| `cohere.embed-multilingual-v3` | 1024 | Use for non-English corpora. |

### Changing it

The embedding dimension is a **create-only** property of the S3 Vectors index, so changing it replaces the index and discards every stored vector.

```typescript
const knowledgeBase = new KnowledgeBaseConstruct(this, 'KnowledgeBase', {
  embeddingModelId: 'cohere.embed-multilingual-v3',
  embeddingDimension: 1024,     // must match the model
});
```

```bash
cdk deploy              # replaces the index
npm run upload-docs     # rebuild every vector
```

**The two values must agree.** A 1024-dim index fed 1536-dim vectors fails at ingestion.

## Retrieval configuration

### Number of results

How many chunks get pulled into the prompt. Set in [lib/s3-rag-stack.ts](../lib/s3-rag-stack.ts):

```typescript
new WebHostingConstruct(this, 'WebHosting', {
  numberOfResults: 5,
});
```

| Value | Effect |
|---|---|
| 3 | Fast and cheap. Good for narrow lookups. Risks missing context. |
| 5 | Default. Balanced. |
| 10 | Better for questions spanning documents. More tokens, higher cost, more noise. |

More is not automatically better - irrelevant chunks actively degrade answers by diluting the useful ones.

### Search type

`vectorSearchConfiguration` also accepts `overrideSearchType`:

- `SEMANTIC` - pure vector similarity
- `HYBRID` - vector plus keyword matching

**S3 Vectors does not support hybrid search.** The [S3 Vectors integration limitations](https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-vectors-bedrock-kb.html#s3-vectors-bedrock-kb-limitations) state it plainly: semantic search only. Setting `HYBRID` against this tutorial's knowledge base is rejected at query time. `HYBRID` is for knowledge bases on OpenSearch Serverless (and some other stores), where it helps when exact terms matter - product codes, error strings, proper nouns - because pure semantic search can miss a literal token match. If that is your corpus, see [Hybrid search](06-advanced.md#hybrid-search) for the trade-off.

## Metadata filtering

You can restrict retrieval to a subset of documents by attaching metadata at ingestion and filtering at query time.

### Attaching metadata

Place a `.metadata.json` file alongside each document:

```
Financial-Data/budget-2025.md
Financial-Data/budget-2025.md.metadata.json
```

```json
{
  "metadataAttributes": {
    "category": "financial",
    "year": 2025,
    "confidential": true
  }
}
```

Re-ingest after adding these.

### Filtering at query time

```typescript
retrievalConfiguration: {
  vectorSearchConfiguration: {
    numberOfResults: 5,
    filter: {
      andAll: [
        { equals: { key: 'category', value: 'financial' } },
        { greaterThanOrEquals: { key: 'year', value: 2025 } },
      ],
    },
  },
}
```

Operators include `equals`, `notEquals`, `greaterThan`, `greaterThanOrEquals`, `lessThan`, `lessThanOrEquals`, `in`, `notIn`, `startsWith`, `andAll`, `orAll`.

> **The 2KB filterable-metadata limit applies here.** S3 Vectors allows 40KB of metadata per vector but only 2KB of *filterable* metadata. That's why `AMAZON_BEDROCK_TEXT` and `AMAZON_BEDROCK_METADATA` are declared non-filterable in [lib/knowledge-base-construct.ts](../lib/knowledge-base-construct.ts). Keep your own filterable attributes small and scalar.

## Tuning for a goal

### For speed

```typescript
modelId: 'us.anthropic.claude-sonnet-5-5',
numberOfResults: 3,
chunkSize: 300,
```

### For quality

```typescript
modelId: 'us.anthropic.claude-haiku-5-5',
numberOfResults: 8,
chunkSize: 500,
chunkOverlapPercentage: 15,
```

Plus a prompt template that demands citations and forbids speculation.

### For cost

```typescript
modelId: 'us.anthropic.claude-sonnet-5-5',
numberOfResults: 3,
chunkSize: 300,
chunkOverlapPercentage: 5,
```

Generation dominates the bill, so the model choice and `numberOfResults` matter far more than storage settings.

## Testing customizations

Change one variable at a time and use a fixed question set, or you won't know what caused a difference.

```bash
# Baseline
cdk deploy --context modelId=us.anthropic.claude-sonnet-5-5
npm run test-rag > /tmp/haiku.txt

# Variant
cdk deploy --context modelId=us.anthropic.claude-haiku-5-5
npm run test-rag > /tmp/opus.txt

diff /tmp/haiku.txt /tmp/opus.txt
```

The demo questions in `scripts/test-rag.ts` are deliberately fixed so runs are comparable. Add your own to that array - questions whose correct answers you know.

What to judge:

- **Grounded** - is every claim actually in the cited document?
- **Complete** - did it miss something the documents contain?
- **Honest** - does it admit gaps rather than inventing?
- **Cited** - are the sources the ones a human would have used?

[Chapter 05](05-testing.md) goes further on evaluation.

## Deployment workflow

```bash
# 1. Make the change in lib/s3-rag-stack.ts
# 2. Preview it
npm run diff

# 3. Deploy
cdk deploy

# 4. Re-ingest ONLY if chunking or embeddings changed
npm run upload-docs
npm run check-status

# 5. Evaluate
npm run test-rag
```

## Summary checklist

- [ ] Prompt template contains `$search_results$`
- [ ] Prompt template tells the model to admit gaps
- [ ] Model ID carries an inference profile prefix (`us.`, `eu.`, `apac.`, `global.`)
- [ ] Embedding dimension matches the index dimension
- [ ] Re-ingested after any chunking or embedding change
- [ ] `numberOfResults` tuned against real questions, not guessed
- [ ] Tested with questions whose answers you know

## Next steps

→ **[Step 5: Testing & Production](05-testing.md)** - evaluating quality, monitoring, and hardening.
