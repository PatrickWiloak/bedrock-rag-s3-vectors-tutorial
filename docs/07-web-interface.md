# Step 7: The Web Interface

A Next.js chat UI, exported as static files, served from S3 through CloudFront - with the streaming chat API on the *same* CloudFront distribution.

## What you'll build

- A chat interface where answers appear token by token as the model writes them
- Citations resolved to readable document titles with expandable excerpts
- Served globally over HTTPS, with both origins private behind Origin Access Control
- Deployed by the same `cdk deploy` as everything else

## The architecture decision that shapes everything

One CloudFront distribution, two behaviours:

```
  Browser
      │ GET /                ──► default behaviour ──► S3 (static export, OAC)
      │ POST /api/chat       ──► /api/* behaviour   ──► Lambda Function URL (OAC)
      └─◄ NDJSON stream                                     └──► Bedrock
```

Because the API is same-origin, three things that a CloudFront + API Gateway design needs simply do not exist here:

1. **No endpoint discovery.** The browser POSTs to a relative `/api/chat`. There is no API URL to inject at deploy time and no `config.json` to fetch on page load.
2. **No CORS.** No preflight, no `Access-Control-Allow-*` headers, and no risk of an error response being discarded by the browser for lacking them.
3. **No URL joining.** Concatenating a stage URL ending in `/` with `/chat` gives `//chat`, which fails looking like a permissions problem. That bug is structurally impossible now.

And the reason it had to change at all: **API Gateway cannot stream.** Its Lambda proxy integration buffers the entire response before returning it, so the client sees nothing until generation finishes. A Lambda Function URL with `invokeMode: RESPONSE_STREAM` does not buffer.

### The setting that silently breaks it

```ts
'/api/*': {
  origin: origins.FunctionUrlOrigin.withOriginAccessControl(chatFunctionUrl),
  compress: false,   // compression buffers the response and breaks streaming
  cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
  originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
}
```

Leave `compress` on and everything still *works* - it just stops streaming. No error, no warning; the whole answer simply arrives at once. It is the kind of failure you can stare at for an hour.

`ALL_VIEWER_EXCEPT_HOST_HEADER` matters too: the Host header must stay the Lambda's own hostname for the OAC signature to validate.

## Project structure

```
web/
├── next.config.ts        # output: 'export', images unoptimized
├── postcss.config.mjs    # Tailwind + autoprefixer
├── app/
│   ├── layout.tsx        # Root layout
│   ├── page.tsx          # Chat interface + stream parser
│   ├── globals.css
│   ├── lib/types.ts      # Citation, Message, StreamEvent
│   └── components/
│       ├── Citations.tsx
│       ├── QuickStarters.tsx
│       └── MisconfiguredBanner.tsx
└── out/                  # Build output - what CDK uploads (gitignored)
```

> **Why `next.config.ts` and not `next.config.js`:** the repository's root `.gitignore` once contained a bare `*.js`, which silently excluded `next.config.js` and `postcss.config.js` from the repo - so a fresh clone could not build the UI at all. The `.gitignore` is now scoped to the compiled CDK output directories, and these config files use extensions it doesn't sweep up.

## Clean URLs without the error-page hack

A Next.js static export writes `/study-guide/index.html`. A request for `/study-guide` has to be mapped onto it. The common shortcut is a CloudFront custom error response turning 404 into `/index.html` with a 200 - but that papers over genuinely missing objects by serving the homepage, which hides broken links and confuses crawlers.

A viewer-request CloudFront Function does it precisely instead:

```js
function handler(event) {
  var request = event.request;
  var uri = request.uri;

  if (uri.indexOf('/api/') === 0) return request;   // never rewrite the API path

  if (uri.endsWith('/')) {
    request.uri = uri + 'index.html';
    return request;
  }

  if (uri.lastIndexOf('.') < uri.lastIndexOf('/')) {  // no extension => HTML route
    request.uri = uri + '/index.html';
  }

  return request;
}
```

The `/api/` guard is essential - without it, `/api/chat` would be rewritten to `/api/chat/index.html` and never reach the Lambda.

## The streaming Lambda

`awslambda.streamifyResponse` is a global the Node runtime injects when the Function URL is configured for `RESPONSE_STREAM`. HTTP metadata must be attached before any body is written:

```js
export const handler = awslambda.streamifyResponse(async (event, responseStream) => {
  const stream = awslambda.HttpResponseStream.from(responseStream, {
    statusCode: 200,
    headers: { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store' },
  });

  const write = (obj) => stream.write(`${JSON.stringify(obj)}\n`);
  // ...
  stream.end();
});
```

### Why the handler is `.mjs` and not TypeScript

The handler is plain ESM on purpose. An earlier version of this tutorial shipped it as `lambda/bedrock-api.ts` while `tsconfig.json` **excluded** `lambda/` - so nothing ever compiled it, the bundler copied raw TypeScript into the deployment asset, and the Node runtime could not load the module. The Lambda could never have worked.

Keeping the handler as directly runnable JavaScript removes that entire class of problem: what you read is what executes.

### Modelled errors do not throw

`RetrieveAndGenerateStream` delivers failures as members of the stream union rather than as exceptions:

```js
const modelledError =
  chunk.internalServerException ?? chunk.validationException ??
  chunk.accessDeniedException   ?? chunk.throttlingException  ?? /* ... */;

if (modelledError) return fail(modelledError.message);
```

A handler that only wraps the loop in `try/catch` treats one of these as an ordinary iteration, emits no text, and ends with a cheerful `done`. The user sees an empty answer and nothing is logged.

## The wire protocol

NDJSON - one JSON object per line. No library needed on either end, and partial lines are trivially detectable.

| Event | Payload | When |
|---|---|---|
| `session` | `{sessionId}` | Once, before any text |
| `text` | `{delta}` | Repeatedly, as the model generates |
| `citation` | `{citation: {index, title, source, category, excerpt, uri}}` | As references resolve |
| `done` | – | Exactly once, on success |
| `error` | `{message}` | Instead of `done`, on failure |

## One header before the request leaves the browser

CloudFront reaches the Lambda Function URL through Origin Access Control, which means it signs the origin request with SigV4. Lambda refuses unsigned payloads, and CloudFront does not hash request bodies for you. So every POST carries the SHA-256 of its JSON body:

```ts
headers: {
  'Content-Type': 'application/json',
  'x-amz-content-sha256': await sha256Hex(body),   // Web Crypto, ~3 lines
},
```

Forget it and the origin answers `The request signature we calculated does not match the signature you provided`, which reads like an OAC misconfiguration and is not. GETs are unaffected, which is why the static site works without it.

## Parsing it in the browser

```ts
const reader = response.body.getReader();
const decoder = new TextDecoder();
let buffer = '';

for (;;) {
  const { done, value } = await reader.read();
  if (done) break;

  buffer += decoder.decode(value, { stream: true });
  const lines = buffer.split('\n');
  buffer = lines.pop() ?? '';        // hold the incomplete tail

  for (const line of lines) {
    if (!line.trim()) continue;
    const event = JSON.parse(line) as StreamEvent;
    // session | text | citation | done | error
  }
}
```

Two details worth internalising:

**`buffer = lines.pop()`** - network chunks split wherever TCP decides, not on newlines. Dropping this is the classic route to JSON parse errors that only appear under load.

**`{ stream: true }`** on `decode` - a multi-byte UTF-8 character can be split across chunks. Without this flag it decodes to a replacement character.

### Accumulate outside React state

```ts
let text = '';
const citations: Citation[] = [];
// ... in the loop:
text += event.delta;
setStreamingText(text);
```

React batches state updates, so `streamingText` cannot be read back synchronously when the stream ends. The final message is assembled from the local accumulators.

## Session handling

```ts
const [sessionId, setSessionId] = useState('');

body: JSON.stringify({
  message: question,
  ...(sessionId ? { sessionId } : {}),   // omitted on the first request
}),
```

`RetrieveAndGenerateStream` issues session IDs and keeps history server-side. A browser-invented ID is rejected with a validation error, so `sessionId` starts empty and is only ever set from a `session` event. An earlier version generated one on mount, which was simply wrong.

## Citations

Resolution happens in the Lambda, not the browser - filename to friendly title, category folder, trimmed excerpt, deduplicated by URI:

```js
const TITLES = {
  'remote-work-policy.md': 'Remote Work Policy',
  'quarterly-report-q4-2024.md': 'Q4 2024 Quarterly Report',
  // ...
};
```

A raw `s3://docs-123456789012-us-east-1-260831/Human-Resources/remote-work-policy.md` tells a reader nothing about whether the answer came from the right place - which is the only reason to display a citation. Add entries to `TITLES` for documents whose filename doesn't derive a good title on its own.

## Local development

```bash
npm run dev --workspace=web     # http://localhost:3000
```

Layout, styling, and quick starters all work. **Sending a message will not** - `/api/chat` only exists on the CloudFront distribution. `MisconfiguredBanner` detects this and says so, rather than failing silently.

That's the trade same-origin makes: local development of the chat loop needs a deployed stack. The alternative - an injected absolute endpoint - buys easier local dev at the cost of a runtime config fetch, CORS, and a URL-joining bug.

## Customizing

| What | Where |
|---|---|
| Theme colours | `web/tailwind.config.ts`, `web/app/globals.css` |
| Quick-start questions | `web/app/components/QuickStarters.tsx` |
| Citation display | `web/app/components/Citations.tsx` |
| Document titles | `TITLES` in `lambda/chat.mjs` (server-side) |
| Page metadata | `web/app/layout.tsx` |

```bash
./scripts/deploy.sh frontend
```

CloudFront is invalidated on every deploy, so changes appear immediately.

## Debugging

| Symptom | Cause |
|---|---|
| "The chat API isn't reachable" | Expected under `next dev`. On a deployment, check Lambda logs and CloudFront propagation. |
| Answer arrives all at once | `compress` is on for `/api/*`. It must be `false`. |
| `403` from `/api/chat` | The OAC or the `lambda:InvokeFunctionUrl` permission isn't in place; `cdk deploy` again. |
| `/api/chat` returns HTML | The URL-rewrite function is missing its `/api/` guard. |
| Empty answer, no error | A modelled stream exception was ignored. |
| Malformed JSON in console | The NDJSON buffer isn't holding partial lines. |

```bash
FN=$(aws cloudformation describe-stacks --stack-name S3VectorRAGStack \
  --query 'Stacks[0].Outputs[?OutputKey==`ChatFunctionName`].OutputValue' --output text)
aws logs tail "/aws/lambda/$FN" --follow
```

## Before anyone else uses this

The Function URL is locked to CloudFront by OAC, but **the CloudFront URL itself is unauthenticated**. Anyone who has the link can spend your Bedrock budget.

Before sharing: add an authorizer, add WAF rate limiting, and set an AWS Budget alert. See [chapter 05](05-testing.md#taking-this-to-production).

## What you've learned

- Same-origin API routing removes runtime config, CORS, and a whole class of URL bugs
- Streaming requires a Function URL, not API Gateway - and CloudFront compression off
- `awslambda.streamifyResponse` and an NDJSON protocol are enough; no framework needed
- Partial-line buffering and `{ stream: true }` decoding are not optional
- Session IDs come from the server
- A handler you can run is better than one that needs a build step nobody wired up

## Resources

- [Lambda response streaming](https://docs.aws.amazon.com/lambda/latest/dg/configuration-response-streaming.html)
- [CloudFront Origin Access Control for Lambda Function URLs](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-restricting-access-to-lambda.html)
- [CloudFront Functions](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/cloudfront-functions.html)
- [Next.js static exports](https://nextjs.org/docs/app/guides/static-exports)

---

## You've finished the tutorial

You've built a complete RAG system: documents in S3, embeddings in S3 Vectors, retrieval and generation through a Bedrock Knowledge Base, a streaming Lambda, and a global web UI - all defined in CDK and torn down with one command.

**Don't forget:**

```bash
./scripts/deploy.sh destroy
```
