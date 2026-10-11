# RAG Chat Web UI

The Next.js front end for the [Bedrock RAG tutorial](../README.md). A streaming chat interface over a Bedrock Knowledge Base, with markdown rendering and citations.

For the full explanation of how it fits together, see [docs/07-web-interface.md](../docs/07-web-interface.md).

## Features

- **Token-by-token streaming** - answers appear as the model writes them
- Markdown rendering with syntax highlighting
- Citations resolved to readable document titles, with expandable excerpts
- Multi-turn conversations via Bedrock-issued session IDs
- Quick-start suggestions spanning all three document categories
- A clear banner when the API isn't reachable, instead of a silent failure
- **Fully static** - no server side, no secrets in the browser

## How it works

This is a **static export** (`output: 'export'` in [next.config.ts](next.config.ts)). There are no Next.js route handlers and no server runtime.

The chat API lives on the **same origin**: CloudFront serves the static site from S3 by default, and routes `/api/*` to a streaming Lambda Function URL.

```
Browser
  │ GET /                ──► CloudFront ──► S3 (Origin Access Control)
  │ POST /api/chat       ──► CloudFront ──► Lambda Function URL (OAC, RESPONSE_STREAM)
  │                                              └──► Bedrock RetrieveAndGenerateStream
  └─◄ NDJSON stream: session · text · text · citation · … · done
```

Because the API is same-origin there is **no endpoint to discover at runtime, no `config.json`, and no CORS**. The browser POSTs to a relative path.

All AWS credentials live in the Lambda's IAM role. Nothing sensitive reaches the browser, and neither origin is publicly callable - both sit behind Origin Access Control.

## Prerequisites

- Node.js 20+ (22 recommended; see [`.nvmrc`](../.nvmrc))
- The stack deployed with either CDK or Terraform (see the [root README](../README.md))

## Quick start

### Build and deploy

From the repository root:

```bash
npm install
./scripts/deploy.sh frontend     # builds web/out and redeploys it
```

Or manually:

```bash
npm run build:web
npx cdk deploy                         # or: terraform -chdir=terraform apply
```

**Build before deploying.** `cdk deploy` fails at synthesis if `web/out` doesn't exist, and the Terraform plan fails its precondition for the same reason.

Get your URL:

```bash
./scripts/deploy.sh status
```

### Local development

```bash
npm run dev --workspace=web     # http://localhost:3000
```

The layout, styling, and quick starters all work. **Sending a message will not**, because `/api/chat` only exists on the CloudFront distribution - the dev server has no such route. The UI detects this and shows a banner explaining it rather than failing silently.

This is a deliberate trade. The previous design injected an API URL at deploy time and fetched it from `config.json`, which made local development marginally easier at the cost of a runtime lookup, a CORS configuration, and a URL-joining bug. Same-origin is the better arrangement; developing the chat loop itself is best done against a deployed stack.

## Project structure

```
web/
├── next.config.ts          # output: 'export', images unoptimized
├── postcss.config.mjs      # Tailwind + autoprefixer
├── tailwind.config.ts      # Theme
├── app/
│   ├── layout.tsx          # Root layout, fonts, metadata
│   ├── page.tsx            # Chat interface + NDJSON stream parser
│   ├── globals.css         # Tailwind directives
│   ├── lib/
│   │   └── types.ts        # Citation, Message, StreamEvent
│   └── components/
│       ├── Citations.tsx           # Expandable sources with excerpts
│       ├── QuickStarters.tsx       # Suggested opening questions
│       └── MisconfiguredBanner.tsx # Shown when /api/chat is unreachable
└── out/                    # Build output (gitignored) - what CDK uploads
```

## Key implementation details

### Parsing the NDJSON stream

The Lambda emits one JSON object per line. Network chunks don't respect line boundaries, so the trailing partial line is buffered until the rest arrives:

```ts
buffer += decoder.decode(value, { stream: true });
const lines = buffer.split('\n');
buffer = lines.pop() ?? '';     // keep the incomplete tail

for (const line of lines) {
  if (!line.trim()) continue;
  const event = JSON.parse(line) as StreamEvent;
  // session | text | citation | done | error
}
```

Dropping that `buffer = lines.pop()` line is the classic way to get intermittently mangled JSON that only shows up under load.

### Accumulating outside React state

Text and citations are accumulated in local variables *as well as* state. React batches state updates, so `streamingText` cannot be read back synchronously when the stream ends - the final message is built from the local accumulators.

### Session IDs come from the server

`RetrieveAndGenerateStream` issues session IDs and keeps conversation history server-side. A client-invented ID is rejected, so `sessionId` starts empty and is only ever set from a `session` event:

```ts
const [sessionId, setSessionId] = useState('');

body: JSON.stringify({
  message: question,
  ...(sessionId ? { sessionId } : {}),   // omitted on the first request
}),
```

### Citations

The Lambda does the resolution - filename to friendly title, category folder, trimmed excerpt, deduplicated by URI - so the component just renders. A raw `s3://docs-…/remote-work-policy.md` doesn't tell a reader whether the answer came from the right place, which is the only reason to show a citation at all.

## Customization

| What | Where |
|---|---|
| Theme colours | `tailwind.config.ts`, `app/globals.css` |
| Quick-start questions | `app/components/QuickStarters.tsx` |
| Citation display | `app/components/Citations.tsx` |
| Document titles | `TITLES` in [`lambda/chat.mjs`](../lambda/chat.mjs) - it's server-side |
| Page title and metadata | `app/layout.tsx` |

After any change:

```bash
./scripts/deploy.sh frontend
```

CloudFront is invalidated on every deploy (`distributionPaths: ['/*']`), so changes appear immediately.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| "The chat API isn't reachable" | Expected under `next dev`. On a deployment, check the Lambda logs and give CloudFront a few minutes to propagate. |
| Answer arrives all at once, not streaming | CloudFront `compress` must be `false` on the `/api/*` behaviour - compression buffers the whole response. |
| `ValidationException` mentioning `sessionId` | A client-generated session ID was sent. Only send back one Bedrock issued. |
| Empty answer, no error | A modelled stream exception was ignored. `lambda/chat.mjs` checks each union member explicitly - see [ARCHITECTURE.md](../ARCHITECTURE.md#modelled-errors-do-not-throw). |
| Malformed JSON errors in the console | The NDJSON buffer isn't holding partial lines. |
| Unhelpful answers | Usually the knowledge base, not the UI. Run `npm run check-status` and `./test-bedrock.sh` from the root. |

Watch the backend:

```bash
FN=$(aws cloudformation describe-stacks --stack-name S3VectorRAGStack \
  --query 'Stacks[0].Outputs[?OutputKey==`ChatFunctionName`].OutputValue' --output text)
aws logs tail "/aws/lambda/$FN" --follow
```

## ⚠️ Before sharing a deployment

The chat endpoint is **unauthenticated**. The Function URL itself is locked to CloudFront, but anyone who has the CloudFront URL can spend your Bedrock budget.

Before giving anyone the link, add an authorizer (a CloudFront Function checking a token, Cognito, or Lambda@Edge), add WAF rate limiting, and set an AWS Budget alert. See [docs/05-testing.md](../docs/05-testing.md#taking-this-to-production).

## Deploying elsewhere

This UI is a plain static export, so the files will host anywhere. But the same-origin `/api/chat` assumption means the host must also route that path to the streaming Lambda. On a different CDN you'd need an equivalent behaviour, or you'd have to reintroduce an absolute endpoint and CORS.

The CDK stack already handles this end to end, so there's no reason to host it separately unless you want a custom domain.
