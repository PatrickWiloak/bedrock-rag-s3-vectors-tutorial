# TODO

Working task list for the Bedrock RAG + S3 Vectors tutorial - read this at the start of a work session and keep it current. v2.2 (2026-10-11) added the Terraform path, moved the default model to Claude Haiku 5.5, fixed the sample corpus, and - for the first time - deployed the stack to a real account from both paths and fixed what that found. What follows is what's left.

---

## Dated checks

- [ ] 2026-11-11 - re-check the default model. `us.anthropic.claude-haiku-5-5` was ACTIVE on 2026-10-11. Run `aws bedrock list-inference-profiles --region us-east-1`; if a newer Haiku exists, update `DEFAULT_MODEL_ID` in `lib/s3-rag-stack.ts`, `model_id` in `terraform/variables.tf` + `terraform.tfvars.example`, and the model tables in README / QUICKSTART / docs/04.
- [ ] 2026-12-01 - check whether `@aws-cdk/aws-bedrock-alpha` has shipped a knowledge base L2 (`npm view @aws-cdk/aws-bedrock-alpha` + its README). It had only Agents and Guardrails on 2026-10-11, which is why `lib/` stays on L1s. If it has, judge a port; `@cdklabs/generative-ai-cdk-constructs` is deprecated and is not the answer.
- [ ] 2026-12-01 - re-run `IAC=terraform ./scripts/deploy.sh full` and `./test-bedrock.sh` once (then destroy) to catch provider or service drift; last green 2026-10-11.

## Worth doing

- [ ] **Consider Server-Sent Events instead of raw NDJSON** if browser `EventSource` semantics (automatic reconnection) turn out to be worth the content-negotiation overhead.
- [ ] **Automate ingestion.** `npm run upload-docs` is a manual step. An S3 event notification triggering `StartIngestionJob` would make the tutorial more production-shaped - and is a good chapter-06 exercise. Same change in both `lib/` and `terraform/`.
- [ ] **Web UI unit test for the NDJSON parser and `sha256Hex`.** Both are small, pure, and were the two things that broke silently on first deploy.

## Nice to have

- [ ] **A chapter on migrating to AgentCore**, for readers who genuinely need tool-calling. The knowledge base built here plugs into AgentCore Gateway unchanged.
- [ ] **Evaluate reranking** on this corpus and document whether it measurably helps, rather than only describing the option in docs/06.
- [ ] **Screenshots of the web UI** in README and docs/07.

---

## Done - v2.2 (2026-10-11)

- [x] ~~Deploy end to end in a real account~~ ✅ 2026-10-11 - both paths deployed to the Nobler Works account, verified with `test-bedrock.sh` (16 docs indexed, grounded answer, streaming measured at ~4.7s spread), then destroyed. Found and fixed: `x-amz-content-sha256` required on POSTs through CloudFront OAC; `bedrock:GetInferenceProfile` missing from the Lambda role; Claude 5.5 models need both prompt templates with `$query$`; CDK outputs inside constructs get mangled keys; the synth-time timestamp in CDK resource names replaced the knowledge base on every redeploy; `Region is missing` with profile-only credentials; `numberOfNewDocumentsIndexed` vs `Modified` in the diagnostic; `test-bedrock.sh` reported success after a failed check.
- [x] ~~Add Terraform support~~ ✅ 2026-10-11 - `terraform/` with first-party `hashicorp/aws` resources only; `scripts/deploy.sh --terraform` / `IAC=terraform` drives it; shared `config/` for the prompt templates and the CloudFront function.
- [x] ~~Re-check the default model~~ ✅ 2026-10-11 - Haiku 5.5 default; Sonnet 5.5 / Opus 5.5 in the tables.
- [x] ~~Rename the repository~~ ✅ 2026-10-11 - `bedrock-rag-s3-vectors-tutorial`; GitHub redirects the old name.
- [x] ~~Confirm whether S3 Vectors supports HYBRID search~~ ✅ 2026-10-11 - it does not (AWS docs: semantic only); docs/04 and docs/06 now say so.
- [x] ~~Regenerate or drop the duplicated `.docx` samples~~ ✅ 2026-10-11 - all five `.docx` named a different fictional company and were rebranded; the duplicate `employee-handbook.docx` was removed (16 documents).
- [x] ~~Add a `.github/workflows` CI job~~ ✅ 2026-10-11 - tsc, next build, cdk synth, terraform fmt + validate.
- [x] ~~Add a v1 tag~~ ✅ 2026-10-11 - `v1` (agent-era) and `v2.1` tags pushed; `v2.2` on this release.
- [x] ~~Record the Agents Classic problem in `~/coding/strategic-bedrock-demo`~~ ✅ 2026-10-11 - in that repo's TODO.md.

## Done - v2.1 (streaming pass, 2026-08-31)

- [x] Lambda Function URL (`RESPONSE_STREAM`) behind CloudFront `/api/*`; real token streaming; same-origin API (no `config.json`, no CORS); handler is `lambda/chat.mjs`; viewer-request CloudFront Function for clean URLs; enriched citations; `scripts/deploy.sh` subcommands; `.nvmrc`, `MisconfiguredBanner`, `QuickStarters`.

## Done - v2 (architecture rewrite, 2026-08-31)

- [x] Native `aws-cdk-lib/aws-s3vectors` instead of `cdk-s3-vectors`; `RetrieveAndGenerate` instead of a Bedrock Agent (Agents Classic closed 2026-07-30); custom resources deleted; dead model IDs fixed; inference-profile IDs and the two-ARN IAM rule; `.gitignore` `*.js` fix; session handling fix; stale meta-documents removed; dependency bumps; OAC instead of OAI; docs rewritten.
