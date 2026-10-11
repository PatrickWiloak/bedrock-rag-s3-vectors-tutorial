#!/bin/bash
#
# Deployment entry point for the Bedrock RAG + S3 Vectors tutorial.
#
# Works with either infrastructure tool. CDK is the default; set IAC=terraform
# to drive the configuration in terraform/ instead. Every subcommand below
# behaves the same way under both.
#
#   ./scripts/deploy.sh full        # everything: infra -> docs -> ingest -> health check
#   ./scripts/deploy.sh infra       # cdk deploy only (builds the web export first)
#   ./scripts/deploy.sh frontend    # rebuild the UI and redeploy it
#   ./scripts/deploy.sh backend     # redeploy the chat Lambda only
#   ./scripts/deploy.sh docs        # upload sample documents + start ingestion
#   ./scripts/deploy.sh ingest      # start ingestion (documents already in S3)
#   ./scripts/deploy.sh diff        # cdk diff
#   ./scripts/deploy.sh status      # resource IDs and URLs
#   ./scripts/deploy.sh destroy     # tear everything down (typed confirmation)
#
# Flags (after the subcommand):
#   --terraform         same as IAC=terraform
#   --profile <name>    same as AWS_PROFILE=<name>
#   --region <region>   same as AWS_REGION=<region>
#   --model <id>        same as MODEL_ID=<id>
#   --yes               destroy without the typed confirmation (for scripts and CI)
#
# Environment:
#   IAC             cdk (default) or terraform
#   AWS_PROFILE     named AWS CLI profile (default: the ambient credential chain)
#   AWS_REGION      target region (default us-east-1)
#   MODEL_ID        override the generation model for this deploy
#   SKIP_HEALTH=1   skip the post-deploy smoke test

set -euo pipefail

STACK_NAME="${STACK_NAME:-S3VectorRAGStack}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TF_DIR="$REPO_ROOT/terraform"
DEPLOY_START_TS=$(date +%s)
CMD_NAME="${1:-full}"
[ $# -gt 0 ] && shift

# Flags are the same knobs as the environment variables, for people who would
# rather not prefix every command. Flags win when both are given.
while [ $# -gt 0 ]; do
  case "$1" in
    --terraform) IAC=terraform ;;
    --cdk)       IAC=cdk ;;
    --profile)   [ $# -ge 2 ] || { echo "--profile needs a value" >&2; exit 1; }; export AWS_PROFILE="$2"; shift ;;
    --region)    [ $# -ge 2 ] || { echo "--region needs a value" >&2; exit 1; }; export AWS_REGION="$2"; shift ;;
    --model)     [ $# -ge 2 ] || { echo "--model needs a value" >&2; exit 1; }; MODEL_ID="$2"; shift ;;
    --yes|-y)    ASSUME_YES=1 ;;
    *) echo "Unknown flag: $1 (see ./scripts/deploy.sh help)" >&2; exit 1 ;;
  esac
  shift
done

REGION="${AWS_REGION:-us-east-1}"
IAC="${IAC:-cdk}"
# The SDK-based helper scripts need a Region too, and a named profile often
# has none configured ("Region is missing"). Hand them ours.
export AWS_REGION="$REGION"

cd "$REPO_ROOT"

# ─────────────────────────────────────────────────────────────────────────────
# Output helpers
# ─────────────────────────────────────────────────────────────────────────────
if [ -t 2 ]; then
  C_RESET=$'\033[0m'; C_BOLD=$'\033[1m'; C_DIM=$'\033[2m'
  C_RED=$'\033[0;31m'; C_GREEN=$'\033[0;32m'; C_YELLOW=$'\033[1;33m'; C_CYAN=$'\033[0;36m'
else
  C_RESET=''; C_BOLD=''; C_DIM=''; C_RED=''; C_GREEN=''; C_YELLOW=''; C_CYAN=''
fi

header()  { printf "\n%s%s══ %s ══%s\n" "$C_CYAN" "$C_BOLD" "$*" "$C_RESET" >&2; }
step()    { printf "\n%s▶%s %s\n" "$C_CYAN" "$C_RESET" "$*" >&2; }
info()    { printf "  %s→%s %s\n" "$C_DIM" "$C_RESET" "$*" >&2; }
success() { printf "  %s✓%s %s\n" "$C_GREEN" "$C_RESET" "$*" >&2; }
warn()    { printf "  %s!%s %s\n" "$C_YELLOW" "$C_RESET" "$*" >&2; }
err_msg() { printf "  %s✗%s %s\n" "$C_RED" "$C_RESET" "$*" >&2; }
die()     { err_msg "$*"; exit 1; }

format_duration() {
  local s=$1
  if [ "$s" -lt 60 ]; then printf "%ds" "$s"; else printf "%dm %ds" $((s / 60)) $((s % 60)); fi
}

on_error() {
  local code=$?
  err_msg "Failed at line $1 (exit $code) during '$CMD_NAME'."
  info "Nothing is rolled back automatically - run './scripts/deploy.sh status' to see current state."
  exit "$code"
}
trap 'on_error $LINENO' ERR

# ─────────────────────────────────────────────────────────────────────────────
# Preflight
# ─────────────────────────────────────────────────────────────────────────────
check_prereqs() {
  step "Checking prerequisites"

  command -v aws >/dev/null  || die "AWS CLI not found."
  command -v node >/dev/null || die "Node.js not found (need 20+)."
  command -v jq >/dev/null   || die "jq not found."

  case "$IAC" in
    cdk) ;;
    terraform) command -v terraform >/dev/null || die "IAC=terraform but terraform is not installed." ;;
    *) die "IAC must be 'cdk' or 'terraform' (got '$IAC')." ;;
  esac

  local major
  major="$(node --version | sed 's/^v//' | cut -d. -f1)"
  [ "$major" -ge 20 ] || die "Node $major found; this project needs Node 20 or newer."

  # CDK bundles the Lambda inside a container, so Docker has to be up. The
  # Terraform path zips lambda/ directly and needs no Docker.
  if [ "$IAC" = "cdk" ]; then
    docker info >/dev/null 2>&1 || die "Docker is not running - CDK needs it to bundle the Lambda."
  fi

  local identity
  identity="$(aws sts get-caller-identity --output json)" || die "AWS credentials are not usable."
  success "Account $(echo "$identity" | jq -r .Account) in $REGION"
  if [ "$IAC" = "cdk" ]; then
    success "Node $(node --version), Docker up, deploying with CDK"
  else
    success "Node $(node --version), $(terraform version | head -1), deploying with Terraform"
  fi
}

# ─────────────────────────────────────────────────────────────────────────────
# Stack helpers
# ─────────────────────────────────────────────────────────────────────────────
tf() { terraform -chdir="$TF_DIR" "$@"; }

stack_exists() {
  if [ "$IAC" = "terraform" ]; then
    # "Exists" means the state has outputs, i.e. an apply has completed.
    [ -f "$TF_DIR/terraform.tfstate" ] && [ "$(tf output -json 2>/dev/null || echo '{}')" != "{}" ]
  else
    aws cloudformation describe-stacks --stack-name "$STACK_NAME" --region "$REGION" >/dev/null 2>&1
  fi
}

# Terraform output names for each CloudFormation output key, so the rest of
# this script can ask for one name regardless of tool.
tf_output_name() {
  case "$1" in
    KnowledgeBaseIdOutput) echo knowledge_base_id ;;
    DataSourceIdOutput)    echo data_source_id ;;
    DataBucketName)        echo data_bucket_name ;;
    ModelId)               echo model_id ;;
    Region)                echo region ;;
    WebsiteURL)            echo website_url ;;
    ChatEndpoint)          echo chat_endpoint ;;
    ChatFunctionName)      echo chat_function_name ;;
    DistributionId)        echo distribution_id ;;
    WebsiteBucketName)     echo website_bucket_name ;;
    *) die "No Terraform output mapped for '$1'" ;;
  esac
}

stack_output() {
  if [ "$IAC" = "terraform" ]; then
    tf output -raw "$(tf_output_name "$1")" 2>/dev/null || true
  else
    aws cloudformation describe-stacks --stack-name "$STACK_NAME" --region "$REGION" \
      --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text 2>/dev/null | grep -v '^None$' || true
  fi
}

# The TypeScript helpers (upload-documents, check-status, test-rag) read
# CloudFormation by default. Under Terraform there is no stack to read, so hand
# them the IDs through the environment instead - see scripts/outputs.ts.
export_outputs_for_scripts() {
  [ "$IAC" = "terraform" ] || return 0
  export KNOWLEDGE_BASE_ID="$(stack_output KnowledgeBaseIdOutput)"
  export DATA_SOURCE_ID="$(stack_output DataSourceIdOutput)"
  export DATA_BUCKET_NAME="$(stack_output DataBucketName)"
  export MODEL_ID="${MODEL_ID:-$(stack_output ModelId)}"
  export CHAT_ENDPOINT="$(stack_output ChatEndpoint)"
  export WEBSITE_URL="$(stack_output WebsiteURL)"
  export AWS_REGION="$REGION"
  [ -n "$KNOWLEDGE_BASE_ID" ] || die "Terraform outputs are empty - has 'terraform apply' completed?"
}

tf_var_args() {
  printf -- '-var
region=%s
' "$REGION"
  [ -n "${MODEL_ID:-}" ]    && printf -- '-var
model_id=%s
' "$MODEL_ID"
  [ -n "${AWS_PROFILE:-}" ] && printf -- '-var
aws_profile=%s
' "$AWS_PROFILE"
  return 0
}

cdk_context_args() {
  # Model can be overridden per-deploy without editing any source.
  [ -n "${MODEL_ID:-}" ] && printf -- '--context\nmodelId=%s\n' "$MODEL_ID"
}

# ─────────────────────────────────────────────────────────────────────────────
# Steps
# ─────────────────────────────────────────────────────────────────────────────
step_build_web() {
  step "Building the web UI"
  info "Next.js static export -> web/out"
  npm run build:web >/dev/null
  [ -d web/out ] || die "web/out was not produced; run 'npm run build:web' directly to see why."
  success "Static export ready ($(find web/out -type f | wc -l | tr -d ' ') files)"
}

step_build_lambda() {
  # Terraform zips lambda/ as-is, so its one dependency has to be installed
  # here first. (CDK does this inside a Docker container at synth time.)
  [ "$IAC" = "terraform" ] || return 0
  step "Installing the Lambda's dependencies"
  npm --prefix "$REPO_ROOT/lambda" ci --omit=dev --no-audit --no-fund >/dev/null
  [ -d "$REPO_ROOT/lambda/node_modules/@aws-sdk/client-bedrock-agent-runtime" ] \
    || die "lambda/node_modules was not produced; run 'npm --prefix lambda ci --omit=dev' directly to see why."
  success "lambda/node_modules ready"
}

step_deploy() {
  if [ "$IAC" = "terraform" ]; then
    step "Applying the Terraform configuration"
    local args=()
    while IFS= read -r line; do [ -n "$line" ] && args+=("$line"); done < <(tf_var_args)

    [ -d "$TF_DIR/.terraform" ] || tf init -input=false
    if stack_exists; then
      info "Updating the existing deployment"
    else
      info "Creating everything (first apply takes 5-8 minutes, mostly CloudFront)"
    fi
    tf apply -input=false -auto-approve "${args[@]+"${args[@]}"}"
    success "Terraform apply complete"

    # Terraform uploads changed site files but does not invalidate CloudFront's
    # cache of the old ones. CDK's BucketDeployment does this for you.
    local dist
    dist="$(stack_output DistributionId)"
    if [ -n "$dist" ]; then
      aws cloudfront create-invalidation --distribution-id "$dist" --paths '/*' --region "$REGION" >/dev/null
      success "CloudFront cache invalidated"
    fi
    return 0
  fi

  step "Deploying the CDK stack"
  local args=()
  while IFS= read -r line; do [ -n "$line" ] && args+=("$line"); done < <(cdk_context_args)

  if stack_exists; then
    info "Updating existing stack '$STACK_NAME'"
  else
    info "Creating stack '$STACK_NAME' (first deploy takes 5-8 minutes)"
  fi

  npx cdk deploy --require-approval never "${args[@]+"${args[@]}"}"
  success "Stack deployed"
}

step_upload_docs() {
  step "Uploading sample documents"
  export_outputs_for_scripts
  npm run upload-docs
  success "Documents uploaded and ingestion started"
}

step_ingest() {
  step "Starting ingestion"
  local kb ds
  kb="$(stack_output KnowledgeBaseIdOutput)"
  ds="$(stack_output DataSourceIdOutput)"
  [ -n "$kb" ] && [ -n "$ds" ] || die "Knowledge base or data source not found in stack outputs."

  aws bedrock-agent start-ingestion-job \
    --knowledge-base-id "$kb" --data-source-id "$ds" --region "$REGION" >/dev/null
  success "Ingestion job started"
}

step_wait_ingestion() {
  step "Waiting for ingestion"
  local kb ds status
  kb="$(stack_output KnowledgeBaseIdOutput)"
  ds="$(stack_output DataSourceIdOutput)"
  [ -n "$kb" ] && [ -n "$ds" ] || { warn "No knowledge base yet; skipping."; return 0; }

  for attempt in $(seq 1 40); do
    status="$(aws bedrock-agent list-ingestion-jobs \
      --knowledge-base-id "$kb" --data-source-id "$ds" --region "$REGION" \
      --max-results 1 --query 'ingestionJobSummaries[0].status' --output text 2>/dev/null || echo UNKNOWN)"

    case "$status" in
      COMPLETE) success "Ingestion complete"; return 0 ;;
      FAILED)   err_msg "Ingestion failed - run 'npm run check-status' for the reasons"; return 1 ;;
      *)        info "Attempt $attempt/40: $status - checking again in 15s"; sleep 15 ;;
    esac
  done

  warn "Ingestion still running after 10 minutes. Check with 'npm run check-status'."
}

step_backend() {
  step "Redeploying the chat Lambda"
  # Both tools are incremental: only the changed Lambda asset is replaced.
  step_build_lambda
  step_deploy
}

step_health_check() {
  [ "${SKIP_HEALTH:-0}" = "1" ] && { warn "SKIP_HEALTH=1, skipping smoke test."; return 0; }
  step "Health check"

  local url code
  url="$(stack_output WebsiteURL)"
  [ -n "$url" ] || { warn "No WebsiteURL output; skipping."; return 0; }

  info "Polling $url ..."
  for attempt in 1 2 3 4 5; do
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$url/" || echo 000)"
    if [ "$code" = "200" ]; then
      success "Site returned 200 on attempt $attempt"
      return 0
    fi
    info "Attempt $attempt/5: HTTP $code - retrying in 5s"
    sleep 5
  done
  warn "Site not returning 200 yet (last: $code). CloudFront may still be propagating."
}

step_summary() {
  header "Summary"
  local duration
  duration="$(format_duration $(( $(date +%s) - DEPLOY_START_TS )))"

  printf "  %sCommand%s        %s\n"  "$C_BOLD" "$C_RESET" "$CMD_NAME" >&2
  printf "  %sDuration%s       %s\n"  "$C_BOLD" "$C_RESET" "$duration" >&2
  printf "\n" >&2
  printf "  %sSite%s           %s\n"  "$C_BOLD" "$C_RESET" "$(stack_output WebsiteURL || echo '-')" >&2
  printf "  %sChat endpoint%s  %s\n"  "$C_BOLD" "$C_RESET" "$(stack_output ChatEndpoint || echo '-')" >&2
  printf "\n" >&2
  printf "  %sKnowledge base%s %s\n"  "$C_BOLD" "$C_RESET" "$(stack_output KnowledgeBaseIdOutput || echo '-')" >&2
  printf "  %sData source%s    %s\n"  "$C_BOLD" "$C_RESET" "$(stack_output DataSourceIdOutput || echo '-')" >&2
  printf "  %sModel%s          %s\n"  "$C_BOLD" "$C_RESET" "$(stack_output ModelId || echo '-')" >&2
  printf "  %sDocuments%s      %s\n"  "$C_BOLD" "$C_RESET" "$(stack_output DataBucketName || echo '-')" >&2
  printf "\n" >&2
  if [ "$IAC" = "terraform" ]; then
    printf "  %sNext:%s IAC=terraform ./test-bedrock.sh   ·   IAC=terraform ./scripts/deploy.sh destroy\n" \
      "$C_DIM" "$C_RESET" >&2
    printf "  %s(npm run test-rag / check-status need the IDs above exported - see terraform/README.md)%s\n" \
      "$C_DIM" "$C_RESET" >&2
  else
    printf "  %sNext:%s npm run test-rag   ·   ./test-bedrock.sh   ·   ./scripts/deploy.sh destroy\n" \
      "$C_DIM" "$C_RESET" >&2
  fi
  printf "\n" >&2
  warn "This costs money while it exists. Destroy it when you are done."
}

# ─────────────────────────────────────────────────────────────────────────────
# Subcommands
# ─────────────────────────────────────────────────────────────────────────────
cmd_full() {
  header "Full deployment"
  check_prereqs
  step_build_web
  step_build_lambda
  step_deploy
  step_upload_docs
  step_wait_ingestion
  step_health_check
  step_summary
}

cmd_infra() {
  header "Infrastructure"
  check_prereqs
  step_build_web
  step_build_lambda
  step_deploy
  step_summary
}

cmd_frontend() {
  header "Frontend"
  check_prereqs
  step_build_web
  step_build_lambda
  step_deploy
  step_health_check
  step_summary
}

cmd_backend() {
  header "Backend"
  check_prereqs
  step_backend
  step_summary
}

cmd_docs() {
  header "Documents"
  stack_exists || die "Nothing deployed yet - run './scripts/deploy.sh infra' first."
  step_upload_docs
  step_wait_ingestion
}

cmd_ingest() {
  header "Ingestion"
  stack_exists || die "Nothing deployed yet - run './scripts/deploy.sh infra' first."
  step_ingest
  step_wait_ingestion
}

cmd_diff() {
  header "Diff"
  local args=()
  if [ "$IAC" = "terraform" ]; then
    while IFS= read -r line; do [ -n "$line" ] && args+=("$line"); done < <(tf_var_args)
    [ -d "$TF_DIR/.terraform" ] || tf init -input=false
    tf plan -input=false "${args[@]+"${args[@]}"}"
  else
    while IFS= read -r line; do [ -n "$line" ] && args+=("$line"); done < <(cdk_context_args)
    npx cdk diff "${args[@]+"${args[@]}"}"
  fi
}

cmd_status() {
  header "Status"
  stack_exists || die "Nothing deployed in $REGION (IAC=$IAC)."
  DEPLOY_START_TS=$(date +%s)
  step_summary
}

cmd_destroy() {
  header "Destroy"
  stack_exists || die "Nothing deployed in $REGION (IAC=$IAC)."

  warn "This deletes the knowledge base, the vector index and every stored embedding,"
  warn "and the document bucket along with its contents."
  if [ "${ASSUME_YES:-0}" = "1" ]; then
    info "--yes given; skipping the typed confirmation"
  else
    local phrase="$STACK_NAME"
    [ "$IAC" = "terraform" ] && phrase="destroy"
    printf "\n  Type %s to confirm: " "$phrase" >&2
    read -r reply
    [ "$reply" = "$phrase" ] || die "Confirmation did not match - nothing was deleted."
  fi

  if [ "$IAC" = "terraform" ]; then
    local args=()
    while IFS= read -r line; do [ -n "$line" ] && args+=("$line"); done < <(tf_var_args)
    tf destroy -input=false -auto-approve "${args[@]+"${args[@]}"}"
  else
    npx cdk destroy --force
  fi
  success "Everything destroyed"
  info "Verify: aws s3vectors list-vector-buckets --region $REGION"
}

cmd_help() {
  sed -n '2,35p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2
}

case "$CMD_NAME" in
  full)      cmd_full ;;
  infra)     cmd_infra ;;
  frontend)  cmd_frontend ;;
  backend)   cmd_backend ;;
  docs)      cmd_docs ;;
  ingest)    cmd_ingest ;;
  diff)      cmd_diff ;;
  status)    cmd_status ;;
  destroy)   cmd_destroy ;;
  help|-h|--help) cmd_help ;;
  *) err_msg "Unknown command: $CMD_NAME"; cmd_help; exit 1 ;;
esac
