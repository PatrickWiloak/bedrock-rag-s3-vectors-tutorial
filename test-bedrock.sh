#!/bin/bash

# RAG diagnostic script.
#
# Walks the deployment from the bottom up and stops at the first thing that is
# actually broken, so you get a specific cause instead of a generic
# AccessDeniedException from the web UI.
#
#   ./test-bedrock.sh                 # CDK deployment
#   IAC=terraform ./test-bedrock.sh   # Terraform deployment

set -uo pipefail

STACK_NAME="${STACK_NAME:-S3VectorRAGStack}"
REGION="${AWS_REGION:-us-east-1}"

FAILED=0
pass() { echo "  ✓ $1"; }
fail() { echo "  ✗ $1"; FAILED=1; }
info() { echo "  · $1"; }

echo "╔════════════════════════════════════════════════════════════════╗"
echo "║              Bedrock RAG Diagnostic                            ║"
echo "╚════════════════════════════════════════════════════════════════╝"
echo ""

# ---------------------------------------------------------------------------
# 1. Credentials
# ---------------------------------------------------------------------------
echo "▶ AWS credentials"
if ! IDENTITY=$(aws sts get-caller-identity --output json 2>&1); then
  fail "No usable AWS credentials"
  echo "$IDENTITY" | sed 's/^/    /'
  exit 1
fi
ACCOUNT_ID=$(echo "$IDENTITY" | jq -r .Account)
pass "Account: $ACCOUNT_ID"
pass "Region:  $REGION"
echo ""

# ---------------------------------------------------------------------------
# 2. Deployment outputs
#
# Two deploy paths, one diagnostic. With IAC=terraform the IDs come from
# `terraform output`; otherwise from the CloudFormation stack the CDK deployed.
# Either way, every later check reads the same four variables.
# ---------------------------------------------------------------------------
IAC="${IAC:-cdk}"
if [ "$IAC" = "terraform" ]; then
  echo "▶ Terraform outputs"
  TF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/terraform"
  if ! TF_OUT=$(terraform -chdir="$TF_DIR" output -json 2>&1) || [ "$TF_OUT" = "{}" ]; then
    fail "No Terraform outputs in $TF_DIR"
    info "Deploy it first: IAC=terraform ./scripts/deploy.sh full"
    exit 1
  fi
  get_output() { echo "$TF_OUT" | jq -r --arg k "$1" '.[$k].value // empty'; }
  KB_ID=$(get_output knowledge_base_id)
  DS_ID=$(get_output data_source_id)
  MODEL_ID=$(get_output model_id)
  CHAT_ENDPOINT=$(get_output chat_endpoint)
else
  echo "▶ CloudFormation stack"
  if ! OUTPUTS=$(aws cloudformation describe-stacks \
    --stack-name "$STACK_NAME" --region "$REGION" \
    --query 'Stacks[0].Outputs' --output json 2>&1); then
    fail "Stack '$STACK_NAME' not found in $REGION"
    info "Deploy it first: ./scripts/deploy.sh full"
    exit 1
  fi
  get_output() { echo "$OUTPUTS" | jq -r --arg k "$1" '.[] | select(.OutputKey==$k) | .OutputValue'; }
  KB_ID=$(get_output KnowledgeBaseIdOutput)
  DS_ID=$(get_output DataSourceIdOutput)
  MODEL_ID=$(get_output ModelId)
  CHAT_ENDPOINT=$(get_output ChatEndpoint)
fi

if [ -z "$KB_ID" ]; then
  fail "Knowledge base ID missing from the deployment outputs"
  exit 1
fi
pass "Knowledge Base: $KB_ID"
pass "Data Source:    $DS_ID"
pass "Model:          $MODEL_ID"
echo ""

# ---------------------------------------------------------------------------
# 3. Model access
#
# The most common failure in this tutorial: the model exists, but the account
# has never enabled access to it in the Bedrock console.
# ---------------------------------------------------------------------------
echo "▶ Model access"
PROFILE_STATUS=$(aws bedrock list-inference-profiles --region "$REGION" \
  --query "inferenceProfileSummaries[?inferenceProfileId=='${MODEL_ID}'].status" \
  --output text 2>/dev/null)

if [ -z "$PROFILE_STATUS" ]; then
  fail "Inference profile '$MODEL_ID' is not available in $REGION"
  info "List what is: aws bedrock list-inference-profiles --region $REGION"
else
  pass "Inference profile status: $PROFILE_STATUS"
fi
echo ""

# ---------------------------------------------------------------------------
# 4. Knowledge base state
# ---------------------------------------------------------------------------
echo "▶ Knowledge base"
if ! KB_JSON=$(aws bedrock-agent get-knowledge-base \
  --knowledge-base-id "$KB_ID" --region "$REGION" --output json 2>&1); then
  fail "Cannot read the knowledge base"
  echo "$KB_JSON" | sed 's/^/    /'
  exit 1
fi
KB_STATUS=$(echo "$KB_JSON" | jq -r .knowledgeBase.status)
KB_STORE=$(echo "$KB_JSON" | jq -r .knowledgeBase.storageConfiguration.type)
if [ "$KB_STATUS" = "ACTIVE" ]; then
  pass "Status: $KB_STATUS (storage: $KB_STORE)"
else
  fail "Status: $KB_STATUS"
  echo "$KB_JSON" | jq -r '.knowledgeBase.failureReasons[]?' | sed 's/^/    /'
fi
echo ""

# ---------------------------------------------------------------------------
# 5. Ingestion
# ---------------------------------------------------------------------------
echo "▶ Ingestion"
JOB=$(aws bedrock-agent list-ingestion-jobs \
  --knowledge-base-id "$KB_ID" --data-source-id "$DS_ID" \
  --region "$REGION" --max-results 1 \
  --query 'ingestionJobSummaries[0]' --output json 2>/dev/null)

if [ -z "$JOB" ] || [ "$JOB" = "null" ]; then
  fail "No ingestion job has ever run"
  info "Upload and ingest documents: npm run upload-docs"
else
  JOB_STATUS=$(echo "$JOB" | jq -r .status)
  # New documents and modified documents are counted separately; a first run
  # is all "new", so reading only the "modified" figure shows a misleading 0.
  INDEXED=$(echo "$JOB" | jq -r '(.statistics.numberOfNewDocumentsIndexed // 0) + (.statistics.numberOfModifiedDocumentsIndexed // 0)')
  FAILED=$(echo "$JOB" | jq -r '.statistics.numberOfDocumentsFailed // 0')
  if [ "$JOB_STATUS" = "COMPLETE" ]; then
    pass "Latest job: $JOB_STATUS ($INDEXED indexed, $FAILED failed)"
  else
    fail "Latest job: $JOB_STATUS ($INDEXED indexed, $FAILED failed)"
    info "Details: npm run check-status"
  fi
fi
echo ""

# ---------------------------------------------------------------------------
# 6. End-to-end query
#
# This one costs a few cents - it actually runs retrieval and generation.
# ---------------------------------------------------------------------------
echo "▶ End-to-end query (this invokes the model)"
QUESTION="What is the remote work policy?"
info "Asking: $QUESTION"

# Both prompt templates, JSON-encoded. The Claude 5.5 models reject the call
# without them (older models would accept Bedrock's defaults).
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GEN_TEMPLATE=$(jq -Rs . < "$REPO_DIR/config/prompt-template.txt")
ORCH_TEMPLATE=$(jq -Rs . < "$REPO_DIR/config/orchestration-prompt-template.txt")

RESULT=$(aws bedrock-agent-runtime retrieve-and-generate \
  --region "$REGION" \
  --input "{\"text\":\"${QUESTION}\"}" \
  --retrieve-and-generate-configuration "{
    \"type\": \"KNOWLEDGE_BASE\",
    \"knowledgeBaseConfiguration\": {
      \"knowledgeBaseId\": \"${KB_ID}\",
      \"modelArn\": \"arn:aws:bedrock:${REGION}:${ACCOUNT_ID}:inference-profile/${MODEL_ID}\",
      \"generationConfiguration\": { \"promptTemplate\": { \"textPromptTemplate\": ${GEN_TEMPLATE} } },
      \"orchestrationConfiguration\": { \"promptTemplate\": { \"textPromptTemplate\": ${ORCH_TEMPLATE} } }
    }
  }" --output json 2>&1)

if echo "$RESULT" | jq -e .output.text >/dev/null 2>&1; then
  pass "Got an answer:"
  echo "$RESULT" | jq -r .output.text | head -5 | sed 's/^/    /'
  CITES=$(echo "$RESULT" | jq '[.citations[].retrievedReferences[]?] | length')
  pass "Citations: $CITES"
else
  fail "Query failed"
  echo "$RESULT" | sed 's/^/    /'
  echo ""
  info "AccessDeniedException on the model usually means model access is not"
  info "enabled for this account. Enable it in the Bedrock console under"
  info "'Model access', then retry."
  exit 1
fi
echo ""

# ---------------------------------------------------------------------------
# 7. Streaming endpoint
#
# Verifies the whole browser-facing path: CloudFront -> Lambda Function URL ->
# Bedrock, and that the response actually streams as NDJSON rather than arriving
# as one buffered blob.
# ---------------------------------------------------------------------------
if [ -n "$CHAT_ENDPOINT" ]; then
  echo "▶ Streaming endpoint"
  info "POST $CHAT_ENDPOINT"

  # Time-stamp every line as it arrives. If the response really streams, the
  # first "text" event lands well before the "done" event; if something in the
  # path buffers (CloudFront compression, a proxy), every line arrives in the
  # same instant and the spread below is ~0.
  # CloudFront's OAC signs the request to the Lambda Function URL with SigV4,
  # and Lambda rejects unsigned payloads, so a POST must carry the SHA-256 of
  # its body in x-amz-content-sha256 (the web UI does the same thing).
  BODY='{"message":"What is the remote work policy?"}'
  BODY_SHA=$(printf '%s' "$BODY" | sha256sum | cut -d' ' -f1)
  TIMED=$(curl -sN --max-time 120 -X POST "$CHAT_ENDPOINT" \
    -H 'Content-Type: application/json' \
    -H "x-amz-content-sha256: $BODY_SHA" \
    -d "$BODY" \
    | while IFS= read -r line; do printf '%s\t%s\n' "$(date +%s.%N)" "$line"; done)

  FIRST_LINES=$(echo "$TIMED" | cut -f2- | head -5)
  if echo "$FIRST_LINES" | jq -e 'select(.type)' >/dev/null 2>&1; then
    pass "Endpoint returned NDJSON events:"
    echo "$TIMED" | cut -f2- | jq -rc 'select(.type) | .type' 2>/dev/null | sort | uniq -c | sed 's/^/    /'

    T_FIRST=$(echo "$TIMED" | awk -F'\t' '$2 ~ /"type":"text"/ {print $1; exit}')
    T_LAST=$(echo "$TIMED" | awk -F'\t' '$2 ~ /"type":"done"/ {print $1}' | tail -1)
    if [ -n "$T_FIRST" ] && [ -n "$T_LAST" ]; then
      SPREAD=$(awk -v a="$T_FIRST" -v b="$T_LAST" 'BEGIN { printf "%.2f", b - a }')
      if awk -v s="$SPREAD" 'BEGIN { exit !(s > 0.3) }'; then
        pass "Streaming confirmed: ${SPREAD}s between the first text event and done"
      else
        fail "Response arrived all at once (${SPREAD}s between first text and done) - something is buffering"
        info "Check that the /api/* behaviour has compress=false and CachingDisabled."
      fi
    fi
  else
    fail "Endpoint did not return NDJSON"
    echo "$FIRST_LINES" | head -3 | sed 's/^/    /'
    info "CloudFront can take a few minutes to propagate after a first deploy."
  fi
  echo ""
fi
if [ "$FAILED" = "1" ]; then
  echo "❌ Some checks failed - see the ✗ lines above."
  exit 1
fi
echo "✅ All checks passed."
