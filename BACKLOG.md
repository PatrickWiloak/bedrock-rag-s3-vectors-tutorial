# Backlog

> Open items with no date and no owner action. **Still open, not archived.** Give an item a leading `YYYY-MM-DD`
> and the todo-budget hook moves it back to `TODO.md`. Fleet design: engineering-standards `todo-system.md`.

---

## Antigravity refactor audit (2026-11-23) - unverified

> Gemini fleet audit, not checked item by item: a 2026-11-24 spot check of 7 claims found 1 false. Read the code before acting; figures were not re-measured. Detail: engineering-standards `docs/REFACTOR-AUDIT-2026-11-23.md`, section "bedrock-rag-s3-vectors-tutorial".

- [ ] [P2, M] Dual CDK + Terraform stacks orchestrated by 484L scripts/deploy.sh risk security/config drift
- [ ] [P2, S] Untested 278L streaming Lambda handler (lambda/chat.mjs) and 1,529L drifted check-ci-local.mjs
