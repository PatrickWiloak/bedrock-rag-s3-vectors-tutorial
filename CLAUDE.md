# CLAUDE.md

Context for AI assistants working in this repository.

## What this is

A **public teaching repository**: a tutorial for building RAG on AWS with Amazon Bedrock Knowledge Bases and S3 Vectors. It is not a production service.

That framing drives most decisions here. The audience is people who have never used Bedrock, so **clarity beats cleverness**, comments explain *why* rather than *what*, and anything surprising gets called out explicitly rather than left for the reader to discover through a failed deploy.

## Architecture in one paragraph

Documents in S3 → Bedrock Knowledge Base ingests, chunks (300 tokens, 7% overlap), and embeds them with Titan Text Embeddings V2 → vectors land in an S3 Vectors index → questions go through `RetrieveAndGenerateStream` → answers stream back with citations. A streaming Lambda Function URL sits behind CloudFront at `/api/*`, on the same distribution that serves the static Next.js UI. Built twice, deliberately: three CDK constructs in `lib/` (~400 lines) and the same stack in plain Terraform in `terraform/`. Both read `config/` for the prompt template and the CloudFront URL-rewrite function. `scripts/deploy.sh` drives either (`IAC=cdk|terraform`). See [ARCHITECTURE.md](ARCHITECTURE.md).

## Facts that are easy to get wrong

These caused real bugs. Verify before changing anything nearby.

1. **Bedrock Agents Classic closed to new customers on 2026-07-30.** Do not reintroduce `AWS::Bedrock::Agent`, `CreateAgent`, or `InvokeAgent` - accounts without prior usage get a 403 and there is no exception process. This tutorial deliberately uses `RetrieveAndGenerate` instead. If agents are genuinely needed, the path is AgentCore (`AWS::BedrockAgentCore::*`).

2. **Every current Claude model on Bedrock is inference-profile only.** Model IDs need a Region prefix (`us.anthropic.claude-haiku-5-5`). There is no `ON_DEMAND` variant. Verify with `aws bedrock list-inference-profiles`.

3. **`bedrock:InvokeModel` needs two ARNs**, the inference profile *and* the underlying foundation model with a wildcard Region:
   ```
   arn:aws:bedrock:<region>:<account>:inference-profile/us.anthropic.claude-haiku-5-5
   arn:aws:bedrock:*::foundation-model/anthropic.claude-haiku-5-5
   ```
   Granting only the profile fails at runtime with an error naming an unrelated Region.

4. **`nonFilterableMetadataKeys` on the S3 Vectors index is load-bearing.** S3 Vectors allows 2KB of *filterable* metadata; Bedrock's `AMAZON_BEDROCK_TEXT` exceeds it. Without the declaration, ingestion fails with `metadata must have at most 2048 bytes`. The property is create-only.

5. **`RetrieveAndGenerate` issues session IDs.** The first request must omit `sessionId`; a client-generated one is rejected. The UI's `sessionId` state starts empty and is only ever set from a response.

6. **The root `.gitignore` must not contain a bare `*.js`.** It previously did, which silently excluded `web/next.config.js` and `web/postcss.config.js` and made the web UI unbuildable from a fresh clone. The rules are now scoped to `/bin`, `/lib`, `/lambda`, `/scripts`.

7. **`npm run build:web` must run before `cdk deploy`.** The stack uploads `web/out`; synthesis fails if it doesn't exist. `./scripts/deploy.sh` does it for you.

8. **CloudFront `compress` must stay `false` on the `/api/*` behaviour.** Compression buffers the response and silently stops streaming - no error, the answer just arrives all at once.

9. **The Lambda handler is `lambda/chat.mjs`, deliberately plain JavaScript.** It was previously `bedrock-api.ts` while `tsconfig.json` excluded `lambda/`, so nothing compiled it and the runtime could not load it. Do not reintroduce a TypeScript handler without also wiring up a build step.

10. **`RetrieveAndGenerateStream` reports failures as members of the stream union**, not as thrown exceptions. Check `chunk.validationException`, `chunk.accessDeniedException`, and friends explicitly, or errors become silent empty answers.

11. **The URL-rewrite CloudFront Function must skip `/api/`.** Without the guard it rewrites `/api/chat` to `/api/chat/index.html` and the Lambda is never reached.

12. **Anything in `config/` is shared by both deploy paths.** `config/prompt-template.txt` and `config/cloudfront-url-rewrite.js` are read by `lib/` (CDK) and `terraform/`. A behaviour change goes there once; never re-inline either into one path.

13. **The Terraform path zips `lambda/` as-is, so `lambda/node_modules` must exist.** `scripts/deploy.sh` runs `npm --prefix lambda ci --omit=dev` first and `terraform/lambda.tf` has a plan-time `precondition` for it. The CDK path bundles in Docker and does not need it. Likewise `web/out` must exist before either tool runs (fact 7).

14. **S3 Vectors is semantic-only.** AWS lists "no hybrid search" as the first limitation of the Bedrock integration. Do not suggest `overrideSearchType: 'HYBRID'` for this stack; docs/04 and docs/06 say so explicitly.

15. **Every "sample" document is cited as fact.** The `.docx` samples once named a different fictional company and were cited as Nobler Works policy. Keep every sample on-brand and never duplicate a document across formats (one `employee-handbook.docx` was removed for being indexed twice).

16. **The Claude 5.5 models require BOTH prompt templates, each containing `$query$`.** `RetrieveAndGenerate` on Haiku/Sonnet/Opus 5.5 fails with `Custom prompt templates must be provided for both Orchestration and Generation` unless `generationConfiguration.promptTemplate` AND `orchestrationConfiguration.promptTemplate` are set; the orchestration one must also contain `$conversation_history$` and `$output_format_instructions$`. The generation template ends with `$output_format_instructions$` too: that placeholder is where Bedrock injects its citation instructions, and without it the model falls back to "Source 1"-style references and attributions thin out. Haiku 4.5 accepts Bedrock's defaults. Both templates live in `config/` and are sent by the Lambda, `scripts/test-rag.ts` and `test-bedrock.sh`.

17. **A POST through CloudFront OAC to a Lambda Function URL must carry `x-amz-content-sha256`.** CloudFront signs the origin request with SigV4 and Lambda rejects unsigned payloads, so the *browser* computes the SHA-256 of the JSON body and sends it as a header (`web/app/page.tsx`, `sha256Hex`). Without it the origin answers `The request signature we calculated does not match`. `test-bedrock.sh` sends it too.

18. **The Lambda role needs `bedrock:GetInferenceProfile` on the profile ARN** in addition to the two `InvokeModel*` grants - `RetrieveAndGenerate` resolves the profile first. Missing it fails with `Not authorized to call GetInferenceProfile`.

19. **Declare every `CfnOutput` at stack level** (`lib/s3-rag-stack.ts`), never inside a construct. A nested output gets a path-mangled key (`WebHostingWebsiteURL617FD337`) and every lookup of `WebsiteURL` silently returns nothing - the deploy summary printed blank URLs on the first real deploy.

20. **Set a Region for the helper scripts.** Named profiles often have none; the SDK then fails with `Region is missing`. `scripts/outputs.ts` falls back to `us-east-1` and `scripts/deploy.sh` exports `AWS_REGION`.

21. **Never edit `scripts/deploy.sh` while a deploy is running.** bash reads the script incrementally, so an edit mid-run makes the running instance execute garbage from the new file (`phrase: unbound variable` after an otherwise successful deploy, 2026-10-11).

22. **The name suffix must be stable across deploys.** CDK derives `deploymentId` from the stack UUID (`lib/s3-rag-stack.ts`); Terraform keeps `random_string.deployment_id` in state. v2 used a synth-time timestamp, so every `cdk deploy` renamed - and therefore replaced - the buckets, the index and the knowledge base, discarding all vectors. Never put `Date.now()`, `timestamp()` or similar in a resource name.

## Common commands

```bash
npm install                     # root + web workspace
./scripts/deploy.sh full        # everything: build, deploy, upload, ingest, health check
./scripts/deploy.sh infra       # cdk deploy only
./scripts/deploy.sh frontend    # rebuild + redeploy the UI
./scripts/deploy.sh docs        # re-upload documents and re-ingest
./scripts/deploy.sh diff        # cdk diff
./scripts/deploy.sh status      # resource IDs and URLs
./scripts/deploy.sh destroy     # tear down (typed confirmation)
IAC=terraform ./scripts/deploy.sh <any of the above>   # same, via terraform/

npm run build:web               # Next.js static export → web/out (before any cdk deploy)
npm run lint --workspace=web    # ESLint 10 flat config in web/eslint.config.mjs; CI runs it
npm run check-status            # ingestion job progress
npm run test-rag                # query from the CLI (add `interactive`)
./test-bedrock.sh               # bottom-up diagnostic incl. a streaming check - run this first when broken
                                # (IAC=terraform ./test-bedrock.sh for a Terraform deployment)
cd terraform && terraform fmt -check -recursive && terraform validate   # what CI runs for terraform/
```

Override the model without editing code:

```bash
MODEL_ID=us.anthropic.claude-sonnet-5-5 ./scripts/deploy.sh infra
```

## Safety guardrails

- **Never deploy or destroy without being asked.** Deploys cost money and `./scripts/deploy.sh destroy` deletes the document bucket (`autoDeleteObjects: true`).
- **`removalPolicy: DESTROY` and `autoDeleteObjects: true` are deliberate tutorial choices.** They make teardown clean. Do not copy them into production advice without flagging the consequence.
- **The chat API is unauthenticated by design.** The Function URL is locked to CloudFront by OAC, but the CloudFront URL is open. This is called out in the docs as a thing to fix before sharing a deployment - don't silently "fix" it in a way that breaks the tutorial's simplicity, and don't remove the warnings.
- **Verify AWS facts against the live API**, not from memory. Model IDs, lifecycle status, and CloudFormation resource schemas all move:
  ```bash
  aws bedrock list-foundation-models --by-provider anthropic --region us-east-1
  aws cloudformation describe-type --type RESOURCE --type-name AWS::Bedrock::KnowledgeBase --region us-east-1
  ```

## Documentation discipline

Documentation *is* the deliverable here - a wrong doc is a worse bug than a wrong line of code.

- The seven chapters in `docs/` are sequential and cross-linked. Changing behaviour means updating the chapter that teaches it.
- Numbers that appear in prose (document count, chunk size, dimensions, model IDs, timings) must match the code. They have drifted before.
- `README.md` and `QUICKSTART.md` overlap intentionally; keep them consistent.
- A change to a resource must land in **both** `lib/` and `terraform/`, and in `ARCHITECTURE.md`'s inventory table. `terraform/README.md` documents only where the tooling differs; it must not restate the chapters.
- Sample documents under `sample-data/knowledge-docs/` **get ingested and cited as authoritative answers**. Do not put tutorial instructions in there - three stale meta-documents were removed for exactly this reason.

## Conventions

- TypeScript throughout; CDK L1 constructs where no L2 exists (all of `aws-s3vectors`). The official Bedrock L2s are in flux (`@cdklabs/generative-ai-cdk-constructs` is deprecated in favour of `@aws-cdk/aws-bedrock-alpha`, which has no knowledge base yet) - stay on L1s until the alpha ships one.
- Web UI: Tailwind CSS 4 (theme and plugins in `web/app/globals.css`, no `tailwind.config.ts`); ESLint 10 flat config. TypeScript stays on 5.9 until typescript-eslint supports 7.x (TODO.md has the recipe).
- Terraform: first-party `hashicorp/aws` resources only, no registry modules (the `aws-ia/bedrock` module needs a pre-existing index and the `awscc` provider). `terraform fmt` clean, `validate` clean, no credentials needed for either.
- Comments explain *why*. Constraints that cost debugging time get a full explanation.
- No em dashes in prose - regular dashes.
- Tutorial-only shortcuts are labelled as such inline.

## Current state

See [TODO.md](TODO.md). v2.2 (2026-10-11) was deployed end to end from both paths and torn down again; the dated checks in TODO.md say when to re-verify.
