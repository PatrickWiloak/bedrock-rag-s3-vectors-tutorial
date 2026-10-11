# Step 6: Advanced Topics

Patterns that go beyond a single knowledge base answering a single question.

> **A note on action groups.** Earlier versions of this chapter covered Bedrock Agent action groups - Lambda-backed tools the agent could call. That surface belongs to [Bedrock Agents Classic, which closed to new customers on July 30, 2026](https://docs.aws.amazon.com/bedrock/latest/userguide/agents-classic-maintenance-mode.html). If you need tool-calling agents, the section on [AgentCore](#when-you-actually-need-an-agent) at the end of this chapter is the current path.

## Guardrails

Bedrock Guardrails apply content filtering, denied topics, and PII handling to model interactions, independent of your prompt template. A prompt template is a request; a guardrail is enforcement.

### Creating one

```bash
aws bedrock create-guardrail \
  --name rag-tutorial-guardrail \
  --description "Content safety for the RAG assistant" \
  --blocked-input-messaging "I can't help with that request." \
  --blocked-outputs-messaging "I can't provide that information." \
  --content-policy-config '{
    "filtersConfig": [
      {"type":"HATE","inputStrength":"HIGH","outputStrength":"HIGH"},
      {"type":"INSULTS","inputStrength":"HIGH","outputStrength":"HIGH"},
      {"type":"SEXUAL","inputStrength":"HIGH","outputStrength":"HIGH"},
      {"type":"VIOLENCE","inputStrength":"HIGH","outputStrength":"HIGH"},
      {"type":"PROMPT_ATTACK","inputStrength":"HIGH","outputStrength":"NONE"}
    ]
  }' \
  --topic-policy-config '{
    "topicsConfig": [{
      "name": "LegalAdvice",
      "definition": "Requests for legal advice or interpretation of contracts",
      "examples": ["Can I sue over this policy?", "Is this contract enforceable?"],
      "type": "DENY"
    }]
  }' \
  --sensitive-information-policy-config '{
    "piiEntitiesConfig": [
      {"type":"EMAIL","action":"ANONYMIZE"},
      {"type":"PHONE","action":"ANONYMIZE"},
      {"type":"US_SOCIAL_SECURITY_NUMBER","action":"BLOCK"}
    ]
  }'
```

`PROMPT_ATTACK` is worth calling out: it targets prompt injection, which matters here because retrieved document text goes into the prompt. **A document in your corpus is untrusted input** if anyone but you can add documents to that bucket.

### Applying it

`RetrieveAndGenerate` accepts a guardrail on the generation configuration:

```typescript
generationConfiguration: {
  promptTemplate: { textPromptTemplate: PROMPT_TEMPLATE },
  guardrailConfiguration: {
    guardrailId: 'abc123',
    guardrailVersion: '1',
  },
}
```

Wire the IDs through as Lambda environment variables the same way `PROMPT_TEMPLATE` is, so changing them is a redeploy rather than a code edit.

### Managing guardrails in CDK

`AWS::Bedrock::Guardrail` and `AWS::Bedrock::GuardrailVersion` are native CloudFormation resources, so a guardrail can live in this stack alongside everything else:

```typescript
import * as bedrock from 'aws-cdk-lib/aws-bedrock';

const guardrail = new bedrock.CfnGuardrail(this, 'Guardrail', {
  name: `rag-guardrail-${deploymentId}`,
  blockedInputMessaging: "I can't help with that request.",
  blockedOutputsMessaging: "I can't provide that information.",
  contentPolicyConfig: { /* as above */ },
});
```

## Multiple knowledge bases

The `KnowledgeBaseConstruct` takes a `dataPrefix`, so partitioning the corpus is straightforward:

```typescript
const financeKb = new KnowledgeBaseConstruct(this, 'FinanceKb', {
  dataBucket,
  dataPrefix: 'Financial-Data/',
  knowledgeBaseName: `kb-fin-${this.account}-${deploymentId}`,
});

const hrKb = new KnowledgeBaseConstruct(this, 'HrKb', {
  dataBucket,
  dataPrefix: 'Human-Resources/',
  knowledgeBaseName: `kb-hr-${this.account}-${deploymentId}`,
});
```

Each gets its own vector bucket, index, role, and data source.

**When this is worth it:**

- **Access control** - finance documents shouldn't be retrievable by everyone. Separate knowledge bases mean separate IAM.
- **Independent ingestion** - re-indexing HR documents doesn't touch finance.
- **Different tuning** - legal text may want 1500-token chunks while an FAQ wants 200.

**When it isn't:** if you only want the model to *prefer* a category, metadata filtering on one knowledge base is simpler and cheaper. Each knowledge base carries its own storage and its own ingestion runs.

Routing across several knowledge bases means your Lambda decides which to query - by explicit user selection, by a cheap classification call, or by querying several and merging. That routing logic is yours to write; it is exactly the job an agent used to do.

## Metadata filtering at scale

[Chapter 04](04-customization.md#metadata-filtering) covers the mechanics. Two things matter once the corpus grows:

**Keep filterable attributes small.** S3 Vectors allows 40KB of metadata per vector but only **2KB filterable**. Use short scalar keys - `category`, `year`, `dept` - not prose.

**Filter for security, not just relevance.** If different users may see different documents, apply the filter server-side in the Lambda based on the authenticated identity. A filter set by the browser is a suggestion, not a control:

```typescript
// Derive from the verified token, never from the request body.
const allowedDepts = claimsFromVerifiedJwt(event).departments;

filter: { in: { key: 'dept', value: allowedDepts } }
```

## Reranking

Vector search optimises for embedding similarity, which is not identical to answer relevance. A reranking model re-scores the retrieved chunks against the original question before generation.

The pattern: retrieve a wider net (say 20 chunks), rerank, keep the best 5, generate. It costs an extra model call and buys noticeably better precision on corpora with many near-duplicate passages.

Bedrock supports reranking through `retrieveAndGenerateConfiguration`; availability varies by Region and model. See [Supported Regions and models for reranking](https://docs.aws.amazon.com/bedrock/latest/userguide/rerank-supported.html).

## Hybrid search

Pure semantic search can miss exact-token matches - error codes, SKUs, function names, proper nouns. Hybrid search combines vector similarity with keyword matching:

```typescript
vectorSearchConfiguration: {
  numberOfResults: 5,
  overrideSearchType: 'HYBRID',
}
```

**Not with S3 Vectors.** AWS lists this as the first limitation of the S3 Vectors integration: it supports semantic search only, no hybrid ([S3 Vectors with Amazon Bedrock Knowledge Bases - Limitations](https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-vectors-bedrock-kb.html#s3-vectors-bedrock-kb-limitations)). The snippet above works on an OpenSearch Serverless knowledge base, not on the one this tutorial builds.

So if exact-match retrieval matters to your corpus, that is a legitimate reason to choose OpenSearch Serverless despite the cost. The knowledge base abstracts the store: the change is `storageConfiguration` plus a re-ingest, and the query code stays the same. S3 Vectors also offers a one-click export of an index to OpenSearch for exactly this kind of upgrade.

## Streaming: how it actually works here

Answers stream token by token. That was not true of earlier versions of this tutorial, which faked it by animating an already-complete response, so it is worth stating what makes it real.

**The transport.** A Lambda Function URL with `invokeMode: RESPONSE_STREAM`, fronted by CloudFront at `/api/*`. API Gateway cannot do this - its Lambda proxy integration buffers the whole response before returning it.

**The handler.** `awslambda.streamifyResponse`, a global the Node runtime injects when the Function URL is configured for streaming:

```js
export const handler = awslambda.streamifyResponse(async (event, responseStream) => {
  const stream = awslambda.HttpResponseStream.from(responseStream, {
    statusCode: 200,
    headers: { 'Content-Type': 'application/x-ndjson' },
  });
  // write NDJSON lines, then stream.end()
});
```

**The protocol.** NDJSON - one JSON object per line: `session`, `text`, `citation`, `done`, `error`. Newline framing needs no library at either end and makes partial lines trivially detectable.

**The trap.** CloudFront `compress` must be `false` on the streaming behaviour. With compression on, everything still works - it just silently stops streaming.

Full detail in [chapter 07](07-web-interface.md) and [ARCHITECTURE.md](../ARCHITECTURE.md#the-wire-protocol).

### Where you would go further

- **Server-Sent Events** instead of raw NDJSON, if you want browser `EventSource` semantics and automatic reconnection. NDJSON over `fetch` was chosen here because it needs no special content negotiation and reads more plainly.
- **WebSockets**, if you need the client to interrupt or send mid-generation signals. That is a genuinely different architecture - API Gateway WebSocket API or AppSync - and overkill for question answering.
- **Backpressure**, if generation can outrun the client. For chat-sized responses it cannot.

## Multi-modal documents

Bedrock Knowledge Bases can parse images and complex layouts inside PDFs using a **foundation model as parser** rather than plain text extraction. Claude and Nova vision models can be used for this, which is what makes charts and scanned tables retrievable.

Configure it on the data source's `vectorIngestionConfiguration.parsingConfiguration`. This costs more at ingestion - every page goes through a vision model - so it earns its place on document sets where the information genuinely lives in the figures.

See [Parsing options for your data source](https://docs.aws.amazon.com/bedrock/latest/userguide/kb-advanced-parsing.html).

## A feedback loop

Answer quality is not observable without feedback. A minimal version:

1. Add thumbs up/down to the UI
2. Log the question, the retrieved chunk URIs, the answer, and the rating
3. Review the negatives weekly

Downvotes cluster into two causes, and they need different fixes:

- **The right chunks weren't retrieved** → chunking, embeddings, `numberOfResults`, filtering
- **The right chunks were retrieved but the answer was poor** → prompt template or model

Logging the retrieved URIs alongside the rating is what lets you tell those apart. Without it you're guessing.

## When you actually need an agent

Everything above is retrieval and generation. An **agent** is different: it decides which tools to call, in what order, and loops until it has an answer - querying an API, running code, writing to a system of record.

Bedrock Agents Classic did this, and is closed to new customers as of July 30, 2026. Its replacement is **[Amazon Bedrock AgentCore](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/what-is-bedrock-agentcore.html)**, which offers:

- A **managed harness** - declare model, tools, and instructions; AWS runs the loop, memory, identity, and observability
- **Code-defined agents** - deploy your own orchestration on AgentCore runtime using any framework
- **Gateway** - exposes REST APIs, Lambdas, and code-level tools as MCP tools
- **Gateway-fronted knowledge base integration** - the knowledge base you built in this tutorial plugs straight in

That last point is the useful part: **nothing in this tutorial is wasted if you later want an agent.** The knowledge base, the vector index, and the ingestion pipeline are the same resources; AgentCore consumes them through a retrieval tool.

The `AWS::BedrockAgentCore::*` CloudFormation resources are public, so an AgentCore deployment can be defined in CDK alongside this stack.

Before reaching for one, though: if your use case is "answer questions about my documents," you already have the right architecture. An agent adds latency, cost, and failure modes in exchange for tool use you may not need.

## Summary

- **Guardrails** enforce safety independently of the prompt - and matter more once documents are untrusted input
- **Multiple knowledge bases** buy access-control and ingestion isolation, at the cost of duplicated infrastructure
- **Metadata filtering** must be applied server-side when it's doing security work
- **Reranking and hybrid search** improve retrieval precision for specific corpus shapes
- **Streaming** is real here, and it is the Function URL plus `compress: false` that makes it so
- **AgentCore** is where to go if you need tools and orchestration - and it reuses this knowledge base

## Resources

- [Bedrock Guardrails](https://docs.aws.amazon.com/bedrock/latest/userguide/guardrails.html)
- [Knowledge base parsing options](https://docs.aws.amazon.com/bedrock/latest/userguide/kb-advanced-parsing.html)
- [Reranking support](https://docs.aws.amazon.com/bedrock/latest/userguide/rerank-supported.html)
- [Bedrock AgentCore developer guide](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/what-is-bedrock-agentcore.html)
- [Agents Classic maintenance mode](https://docs.aws.amazon.com/bedrock/latest/userguide/agents-classic-maintenance-mode.html)

## Next steps

→ **[Step 7: The Web Interface](07-web-interface.md)** - how the UI, CloudFront, and the streaming Lambda fit together.
