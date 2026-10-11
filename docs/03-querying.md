# Step 3: Querying Your Knowledge Base

The stack is deployed but the knowledge base is empty. This chapter fills it and queries it.

> **Where the agent went.** Earlier versions of this tutorial created a Bedrock Agent here. Bedrock Agents became [Agents Classic and closed to new customers on July 30, 2026](https://docs.aws.amazon.com/bedrock/latest/userguide/agents-classic-maintenance-mode.html), so this chapter uses `RetrieveAndGenerate` instead - one API call that does the whole RAG loop, available to every account. See [What changed in v2](../README.md#-what-changed-in-v2-august-2026).

## Overview

1. Upload documents to S3
2. Start an ingestion job (this is **not** automatic)
3. Wait for it to complete
4. Query with `RetrieveAndGenerate`

## Upload documents

### Using the upload script

```bash
npm run upload-docs          # or: ./scripts/deploy.sh docs
```

It uploads everything under `sample-data/knowledge-docs/`, preserving the folder structure, then calls `StartIngestionJob`:

```
✓ Uploaded 16 documents to S3
✓ Knowledge Base ingestion started
```

### Manual upload (alternative)

```bash
BUCKET=$(aws cloudformation describe-stacks --stack-name S3VectorRAGStack \
  --query 'Stacks[0].Outputs[?OutputKey==`DataBucketName`].OutputValue' --output text)

aws s3 sync sample-data/knowledge-docs/ "s3://$BUCKET/"
```

### Adding your own documents

Supported formats: `.md`, `.txt`, `.pdf`, `.docx`, `.html`, `.csv`.

```bash
aws s3 cp my-report.pdf "s3://$BUCKET/Financial-Data/"
npm run upload-docs     # re-runs ingestion over everything
```

The folder is not a hard partition - the knowledge base indexes the whole bucket, and folders exist so the prompt template can refer to categories and so you can add per-folder filtering later ([chapter 06](06-advanced.md)).

## Knowledge base ingestion

### What is ingestion?

Uploading to S3 does nothing on its own. Ingestion is the job that reads the bucket, chunks the documents, embeds each chunk, and writes the vectors into the S3 Vectors index.

**You must re-run it after any document change.** There is no automatic sync.

### Trigger ingestion manually

```bash
KB_ID=$(aws cloudformation describe-stacks --stack-name S3VectorRAGStack \
  --query 'Stacks[0].Outputs[?OutputKey==`KnowledgeBaseIdOutput`].OutputValue' --output text)
DS_ID=$(aws cloudformation describe-stacks --stack-name S3VectorRAGStack \
  --query 'Stacks[0].Outputs[?OutputKey==`DataSourceIdOutput`].OutputValue' --output text)

aws bedrock-agent start-ingestion-job \
  --knowledge-base-id "$KB_ID" --data-source-id "$DS_ID"
```

### Monitor status

```bash
npm run check-status
```

```
═══════════════════════════════════════════
Latest Ingestion Job
═══════════════════════════════════════════
Status: ✅ COMPLETE

Statistics:
  Documents Scanned: 16
  Documents Modified: 16
  Documents Failed: 0
═══════════════════════════════════════════
```

Or directly:

```bash
aws bedrock-agent list-ingestion-jobs \
  --knowledge-base-id "$KB_ID" --data-source-id "$DS_ID" \
  --query 'ingestionJobSummaries[0].[status,statistics]'
```

Typical duration for 16 documents: **2-5 minutes**.

### What ingestion actually does

1. **Scan** - enumerate objects under the data source prefix
2. **Parse** - extract text per format
3. **Chunk** - 300 tokens, 7% overlap
4. **Embed** - Titan Text Embeddings V2 → 1024-dim float32 vectors
5. **Store** - write to the S3 Vectors index with `AMAZON_BEDROCK_TEXT` and `AMAZON_BEDROCK_METADATA`

If `Documents Failed` is non-zero, check `failureReasons`:

```bash
aws bedrock-agent get-ingestion-job \
  --knowledge-base-id "$KB_ID" --data-source-id "$DS_ID" \
  --ingestion-job-id <JOB_ID> --query 'ingestionJob.failureReasons'
```

## Querying

### Using the test script

```bash
npm run test-rag                # scripted demo questions
npm run test-rag interactive    # ask your own
```

```
❓ You: What's our remote work policy?

🤖 According to the Remote Work Policy, Nobler Works operates a hybrid model
   requiring three days per week in office...

📚 Sources:
  1. s3://docs-.../Human-Resources/remote-work-policy.md
```

### The API call

The web UI uses the streaming variant, `RetrieveAndGenerateStream` (see [chapter 07](07-web-interface.md)). The non-streaming form below is what `scripts/test-rag.ts` uses, and it is the clearer one to read first - the configuration is identical.

```typescript
const response = await client.send(new RetrieveAndGenerateCommand({
  input: { text: question },
  retrieveAndGenerateConfiguration: {
    type: 'KNOWLEDGE_BASE',
    knowledgeBaseConfiguration: {
      knowledgeBaseId,
      modelArn,                              // the inference profile ARN
      retrievalConfiguration: {
        vectorSearchConfiguration: { numberOfResults: 5 },
      },
      generationConfiguration: {
        promptTemplate: { textPromptTemplate: PROMPT_TEMPLATE },
      },
    },
  },
}));
```

That single call embeds the question, searches the index, builds the prompt, generates the answer, and attaches citations.

> **`modelArn` must be the inference profile ARN**, e.g.
> `arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-haiku-5-5`

> **Two templates are required with this model.** `scripts/test-rag.ts` passes `generationConfiguration.promptTemplate` and `orchestrationConfiguration.promptTemplate`, read from [config/](../config/). The Claude 5.5 models reject a `RetrieveAndGenerate` call that lacks either, with a `ValidationException` that names the missing piece; see [chapter 04](04-customization.md#answer-style-the-prompt-template).

### Response structure

```jsonc
{
  "output": { "text": "According to the Remote Work Policy..." },
  "citations": [
    {
      "generatedResponsePart": {
        "textResponsePart": { "text": "...", "span": { "start": 0, "end": 87 } }
      },
      "retrievedReferences": [
        {
          "content": { "text": "Nobler Works operates a hybrid model..." },
          "location": { "s3Location": { "uri": "s3://.../remote-work-policy.md" } },
          "metadata": { }
        }
      ]
    }
  ],
  "sessionId": "b0c4...-issued-by-bedrock"
}
```

Citations are grouped **by span of generated text**, so one document commonly appears under several spans. Both the Lambda and `test-rag.ts` flatten and deduplicate them by S3 URI:

```typescript
const seen = new Set<string>();
for (const citation of response.citations ?? []) {
  for (const ref of citation.retrievedReferences ?? []) {
    const uri = ref.location?.s3Location?.uri;
    if (!uri || seen.has(uri)) continue;
    seen.add(uri);
    citations.push({ uri, text: ref.content?.text ?? '' });
  }
}
```

## Multi-turn conversations

`RetrieveAndGenerate` holds history server-side, keyed by a session ID.

**Bedrock issues the session ID. You never invent one.**

```typescript
// First question of a conversation - no sessionId
let result = await ask("What are our PTO benefits?");
let sessionId = result.sessionId;        // Bedrock gave us this

// Follow-up - send it back
result = await ask("How does that compare to sick leave?", sessionId);
```

Sending a client-generated ID returns a `ValidationException`. This is why `web/app/page.tsx` initialises `sessionId` to `''` and only ever sets it from a response, and why the Lambda spreads it conditionally:

```typescript
...(sessionId ? { sessionId } : {}),
```

Try it in interactive mode:

```
❓ You: What are our PTO benefits?
🤖 Employees receive 20 days of paid time off annually...

❓ You: Is that separate from sick leave?
🤖 Yes - the 20 PTO days are separate from the sick leave allowance...
```

The second question makes no sense without the first. The session is what makes it work.

## Testing different queries

### Queries that work well

Specific, answerable from the corpus:

- "What was our Q4 2024 revenue?"
- "How many PTO days do employees get?"
- "What's the home office stipend?"
- "What are the top 5 strategic priorities for 2025?"

### Out-of-scope queries

- "What's the weather today?"
- "Who won the World Cup?"

A well-templated model says it doesn't have that information rather than inventing an answer. If yours invents answers, tighten the prompt template - see [chapter 04](04-customization.md).

## Performance tips

### Faster responses

- Stay on the default `us.anthropic.claude-haiku-5-5` - markedly faster than Sonnet 5.5 or Opus 5.5
- Lower `numberOfResults` from 5 to 3 - fewer tokens in the prompt
- Keep chunks small

### Better answers

- Raise `numberOfResults` to 8-10 for questions spanning several documents
- Increase chunk size if answers feel like they're missing surrounding context
- Make the prompt template more explicit about citing and about admitting gaps
- Use a stronger model

These pull against each other. [Chapter 04](04-customization.md) works through the trade-offs.

## Common issues

### "I don't have that information"

Almost always ingestion, not the model.

```bash
npm run check-status                      # did ingestion complete?
aws s3 ls "s3://$BUCKET/" --recursive     # are the documents actually there?
```

If ingestion completed with `Documents Failed > 0`, read the failure reasons. If it completed cleanly, try a more specific query - vector search needs enough signal to match.

### `ValidationException` about `sessionId`

A client-generated session ID was sent. Only send back one Bedrock issued.

### `AccessDeniedException` on the model

Model access isn't enabled for the account, **or** the IAM policy grants the inference profile ARN but not the underlying foundation model ARN. `./test-bedrock.sh` distinguishes these.

### Slow responses

Opus 5.5 with `numberOfResults: 5` over long chunks is simply a lot of tokens. Stay on Haiku 5.5 unless the answers show you need more.

## Monitoring

Bedrock publishes to CloudWatch under `AWS/Bedrock`. Useful metrics: `InvocationLatency`, `InvocationClientErrors`, `InvocationServerErrors`, `InputTokenCount`, `OutputTokenCount`.

The Lambda logs every request with a `[RAG]` prefix, including configuration, response length, and citation count:

```bash
aws logs tail /aws/lambda/<function-name> --follow
```

## What you've learned

- Ingestion is explicit and must be re-run after document changes
- `RetrieveAndGenerate` collapses the whole RAG loop into one call
- Citations are grouped by generated span, not by document
- Sessions are server-side and server-issued

## Quick reference

```bash
npm run upload-docs             # upload + start ingestion
npm run check-status            # ingestion progress
npm run test-rag                # demo questions
npm run test-rag interactive    # ask your own
./test-bedrock.sh               # full bottom-up diagnostic

aws s3 ls "s3://$BUCKET/" --recursive
```

## Next steps

→ **[Step 4: Customization](04-customization.md)** - prompt templates, models, chunking, and retrieval tuning.
