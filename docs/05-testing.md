# Step 5: Testing & Production

How to tell whether the system actually works, and what to change before anyone depends on it.

## The diagnostic script

Start here whenever something is wrong:

```bash
./test-bedrock.sh
```

It walks the stack bottom-up and stops at the first genuinely broken layer:

1. **Credentials** - can we call STS at all?
2. **Stack outputs** - is the stack deployed, and does it expose what we expect?
3. **Model access** - is the configured inference profile reachable?
4. **Knowledge base** - is it `ACTIVE`, and is its storage type `S3_VECTORS`?
5. **Ingestion** - has a job run, and did it complete without failures?
6. **End-to-end query** - a real `RetrieveAndGenerate` call with citations

This ordering matters. A failure at the web UI could be caused by any layer beneath it, and guessing wastes time.

> Step 6 invokes the model, so it costs a few cents per run.

## Testing strategy

### 1. Ingestion testing

Before trusting answers, confirm the documents made it in.

```bash
KB_ID=$(aws cloudformation describe-stacks --stack-name S3VectorRAGStack \
  --query 'Stacks[0].Outputs[?OutputKey==`KnowledgeBaseIdOutput`].OutputValue' --output text)
DS_ID=$(aws cloudformation describe-stacks --stack-name S3VectorRAGStack \
  --query 'Stacks[0].Outputs[?OutputKey==`DataSourceIdOutput`].OutputValue' --output text)

aws bedrock-agent list-ingestion-jobs \
  --knowledge-base-id "$KB_ID" --data-source-id "$DS_ID" \
  --query 'ingestionJobSummaries[0].statistics'
```

`numberOfDocumentsFailed` must be `0`. If not:

```bash
aws bedrock-agent get-ingestion-job \
  --knowledge-base-id "$KB_ID" --data-source-id "$DS_ID" \
  --ingestion-job-id <JOB_ID> --query 'ingestionJob.failureReasons'
```

### 2. Retrieval testing (without generation)

Test retrieval in isolation. If the right chunks aren't coming back, no prompt template will save the answer.

```bash
aws bedrock-agent-runtime retrieve \
  --knowledge-base-id "$KB_ID" \
  --retrieval-query '{"text":"remote work policy"}' \
  --retrieval-configuration '{"vectorSearchConfiguration":{"numberOfResults":5}}' \
  --query 'retrievalResults[].[score,location.s3Location.uri]' --output table
```

This separates two very different failures:

- **Wrong documents returned** → a retrieval problem: chunking, embeddings, or `numberOfResults`
- **Right documents, bad answer** → a generation problem: prompt template or model

### 3. Query testing

```bash
npm run test-rag
```

The scripted questions cover all three document categories. Keep them fixed so runs stay comparable, and add your own with known-correct answers.

Score each answer on four axes:

| Axis | Question |
|---|---|
| **Grounded** | Is every claim actually in a cited document? |
| **Complete** | Did it miss something the documents do contain? |
| **Honest** | Does it admit gaps instead of inventing? |
| **Cited** | Are the sources the ones a human would have used? |

Deliberately include questions the corpus **cannot** answer. A system that confidently answers those is worse than one that returns nothing.

```
❓ What is our policy on submarine maintenance?
✅ Good: "That isn't covered in the documents I have access to."
❌ Bad:  A plausible, entirely invented policy.
```

### 4. Performance testing

```bash
time npm run test-rag
```

Latency is dominated by generation. Expect a few seconds per question with Haiku, longer with Opus. If it's much worse, check `numberOfResults` and chunk size - both drive prompt length.

### 5. Load testing

There is no API Gateway throttle here - the Function URL is reached through CloudFront, and Lambda's own concurrency limit is the first ceiling. Bedrock's account-level quotas are usually the real one. Raise them via Service Quotas before any load test that matters, and add WAF rate limiting on the distribution before exposing it.

## Validation checklist

Before calling a deployment good:

- [ ] `./test-bedrock.sh` passes end to end
- [ ] Ingestion shows 0 failed documents
- [ ] `Retrieve` returns sensible documents for 5+ representative queries
- [ ] Answers cite the correct sources
- [ ] Out-of-scope questions are refused, not invented
- [ ] Multi-turn follow-ups resolve correctly (session handling works)
- [ ] The CloudFront URL loads and can hold a conversation
- [ ] Answers stream token by token rather than arriving all at once
- [ ] `./scripts/deploy.sh destroy` on a scratch deployment leaves nothing behind

## Monitoring & observability

### CloudWatch metrics

Bedrock publishes under `AWS/Bedrock`:

| Metric | Watch for |
|---|---|
| `InvocationLatency` | Rising p99 - usually prompt growth |
| `InvocationClientErrors` | 4xx - throttling, validation, access denied |
| `InvocationServerErrors` | 5xx - retry with backoff |
| `InputTokenCount` | Drives cost; grows with `numberOfResults` |
| `OutputTokenCount` | Drives cost |

### Lambda logs

Every request logs with a `[RAG]` prefix - configuration, response length, citation count, and full error detail including `requestId`.

```bash
FN=$(aws cloudformation describe-stack-resources --stack-name S3VectorRAGStack \
  --query "StackResources[?ResourceType=='AWS::Lambda::Function' && contains(LogicalResourceId,'BedrockApi')].PhysicalResourceId" \
  --output text)
aws logs tail "/aws/lambda/$FN" --follow
```

### An alarm worth having

```bash
aws cloudwatch put-metric-alarm \
  --alarm-name bedrock-rag-client-errors \
  --namespace AWS/Bedrock --metric-name InvocationClientErrors \
  --statistic Sum --period 300 --evaluation-periods 1 --threshold 10 \
  --comparison-operator GreaterThanThreshold \
  --alarm-actions <YOUR_SNS_TOPIC_ARN>
```

Point it at a topic a human actually reads. An alarm with no recipient is decoration.

## Taking this to production

This stack is a tutorial. Several deliberate choices are wrong for production.

### 1. Data would be deleted with the stack

```typescript
removalPolicy: cdk.RemovalPolicy.DESTROY,
autoDeleteObjects: true,
```

Both buckets use these so `cdk destroy` is clean. In production, use `RETAIN`, enable versioning, and turn on deletion protection. A `cdk destroy` against the wrong account should not be able to delete your corpus.

### 2. The API is unauthenticated

The Function URL is locked to CloudFront by Origin Access Control, but the CloudFront URL itself is open to the internet. Anyone who finds it can spend your Bedrock budget.

At minimum, add:

- An authorizer - a CloudFront Function checking a token, Cognito, or Lambda@Edge
- WAF rate limiting per IP on the distribution
- An AWS Budget alert

### 3. No budget guardrail

Generation cost scales with traffic and nothing here caps it. Add an AWS Budget with an alert, and consider a per-session query limit in the Lambda.

### 4. Environments aren't separated

One stack name, one account. For production, parameterise the stack name and deploy dev and prod to separate accounts:

```bash
cdk deploy --context stackName=RagStack-dev
cdk deploy --context stackName=RagStack-prod
```

### 5. Ingestion is manual

`npm run upload-docs` is a human action. In production, trigger `StartIngestionJob` from an S3 event notification or a schedule, and alarm on ingestion failure.

### 6. No guardrails

Bedrock Guardrails add content filtering, denied topics, and PII redaction. See [chapter 06](06-advanced.md).

## Security hardening

**IAM.** The knowledge base and Lambda roles are already scoped to specific resources and actions. [iam-policy.json](../iam-policy.json) is deliberately broad (`Resource: "*"`) because the resources don't exist until the stack creates them - scope it down for anything beyond a tutorial.

**Encryption.** Both S3 buckets use `S3_MANAGED` encryption and `enforceSSL`. For production, use a customer-managed KMS key; both `AWS::S3Vectors::VectorBucket` and `AWS::S3Vectors::Index` accept an `EncryptionConfiguration`.

**Network.** Everything here traverses public AWS endpoints. For a VPC-bound deployment, add interface endpoints for Bedrock and gateway endpoints for S3.

**Logging.** Enable CloudTrail data events for the document bucket if you need to know who read what.

## Cost management

```bash
aws ce get-cost-and-usage \
  --time-period Start=$(date -u -d '30 days ago' +%Y-%m-%d),End=$(date -u +%Y-%m-%d) \
  --granularity MONTHLY --metrics UnblendedCost \
  --filter '{"Dimensions":{"Key":"SERVICE","Values":["Amazon Bedrock"]}}'
```

Reduction levers, in order of impact:

1. **Cheaper model** - Haiku 5.5 (the default) instead of Sonnet 5.5 or Opus 5.5 is the single biggest lever
2. **Lower `numberOfResults`** - fewer chunks means fewer input tokens per query
3. **Smaller chunks** - same effect
4. **Cache repeated questions** - identical questions shouldn't hit Bedrock twice
5. **Delete idle stacks** - `./scripts/deploy.sh destroy`

S3 Vectors bills per request and per GB rather than for provisioned capacity, so an idle stack costs almost nothing. Generation is essentially the whole bill.

## Disaster recovery

The documents in S3 are the source of truth. Everything else - vectors, index, knowledge base - is derived and can be rebuilt.

```bash
# Back up what actually matters
aws s3 sync "s3://$BUCKET/" ./backup/

# Rebuild from scratch
cdk deploy
aws s3 sync ./backup/ "s3://$NEW_BUCKET/"
npm run upload-docs
```

That property is worth keeping: **never let the vector store become the only copy of anything.**

## Production checklist

- [ ] Removal policies set to `RETAIN` for anything holding data
- [ ] S3 versioning enabled on the document bucket
- [ ] API authentication in place
- [ ] CORS restricted to known origins
- [ ] Rate limiting or WAF configured
- [ ] AWS Budget with a real alert recipient
- [ ] CloudWatch alarms on client and server errors
- [ ] Ingestion automated and alarmed
- [ ] Guardrails configured
- [ ] Separate dev and prod accounts
- [ ] Document backups outside the stack
- [ ] IAM scoped to specific resource ARNs

## Next steps

→ **[Step 6: Advanced Topics](06-advanced.md)** - guardrails, multiple knowledge bases, reranking, and where agents fit now.
