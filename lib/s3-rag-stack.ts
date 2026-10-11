import * as fs from 'fs';
import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { KnowledgeBaseConstruct } from './knowledge-base-construct';
import { WebHostingConstruct } from './web-hosting-construct';

/**
 * Default generation model.
 *
 * Every current Claude model on Bedrock is served exclusively through a
 * cross-Region inference profile - none of them support ON_DEMAND invocation -
 * so this is a profile ID, not a bare foundation model ID. Check what your
 * account and Region can reach with:
 *
 *   aws bedrock list-inference-profiles --region us-east-1
 *
 * Haiku 5.5 is the cheapest and fastest of the current Claude models, which is
 * the right default for a tutorial. Swap to `us.anthropic.claude-sonnet-5-5` or
 * `us.anthropic.claude-opus-5-5` to see what stronger synthesis buys you.
 */
const DEFAULT_MODEL_ID = 'us.anthropic.claude-haiku-5-5';

/**
 * How the answer should be written.
 *
 * With Bedrock Agents this lived in the agent's `instruction`. RetrieveAndGenerate
 * takes the equivalent as a prompt template, which must contain the
 * `$search_results$` placeholder for the retrieved chunks.
 *
 * The template lives in config/prompt-template.txt so that the CDK stack and
 * the Terraform configuration in terraform/ ship the exact same wording.
 */
const PROMPT_TEMPLATE = fs
  .readFileSync(path.join(__dirname, '../config/prompt-template.txt'), 'utf8')
  .trimEnd();

/**
 * How the model turns the conversation into a search query, before retrieval.
 *
 * Older models fall back to Bedrock's built-in orchestration prompt when this is
 * absent. The Claude 5.5 family does not: RetrieveAndGenerate rejects the call
 * unless BOTH an orchestration and a generation template are supplied, and each
 * contains `$query$`. Found on the first real deploy; no synth-time check sees it.
 */
const ORCHESTRATION_PROMPT_TEMPLATE = fs
  .readFileSync(path.join(__dirname, '../config/orchestration-prompt-template.txt'), 'utf8')
  .trimEnd();

export class S3VectorRAGStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    /**
     * Deployment ID
     *
     * Vector bucket and knowledge base names must be unique per account, and S3
     * caps bucket names at 63 characters, so every name below carries a short
     * suffix. The suffix has to be STABLE across deploys: a value that changes
     * on each `cdk deploy` renames the buckets, the index and the knowledge
     * base, and CloudFormation implements a rename as delete-and-recreate.
     * v2 used a synth-time timestamp here, and the first real redeploy silently
     * threw away every document and every vector.
     *
     * The last segment of the stack's own UUID is unique per stack instance,
     * identical on every update, and new when the stack is destroyed and
     * recreated - exactly the behaviour a name suffix needs.
     *
     * Override it if you must: cdk deploy --context deploymentId=mytest1
     */
    const deploymentId: string =
      this.node.tryGetContext('deploymentId') ||
      cdk.Fn.select(4, cdk.Fn.split('-', cdk.Fn.select(2, cdk.Fn.split('/', this.stackId))));

    // Model is overridable from the CLI:
    //   cdk deploy --context modelId=us.anthropic.claude-sonnet-5-5
    const modelId = this.node.tryGetContext('modelId') || DEFAULT_MODEL_ID;

    // ========================================
    // 1. Document bucket
    // ========================================

    // Documents are organised into folders: Financial-Data/, Human-Resources/,
    // Meeting-Notes/. The short "docs" prefix leaves room under the 63-char limit.
    const dataBucket = new s3.Bucket(this, 'DataBucket', {
      bucketName: `docs-${this.account}-${this.region}-${deploymentId}`,
      removalPolicy: cdk.RemovalPolicy.DESTROY, // For tutorial purposes only
      autoDeleteObjects: true, // For tutorial purposes only
      versioned: false,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
    });

    // ========================================
    // 2. Knowledge base over the whole bucket
    // ========================================

    const knowledgeBase = new KnowledgeBaseConstruct(this, 'KnowledgeBase', {
      dataBucket,
      // No dataPrefix - index every folder in the bucket.
      knowledgeBaseName: `kb-${this.account}-${deploymentId}`,
      embeddingModelId: 'amazon.titan-embed-text-v2:0',
      embeddingDimension: 1024,
      chunkSize: 300,
      chunkOverlapPercentage: 7,
    });

    // ========================================
    // 3. Web UI + chat API
    // ========================================

    // Requires the Next.js static export to exist first (npm run build:web).
    const webHosting = new WebHostingConstruct(this, 'WebHosting', {
      knowledgeBaseId: knowledgeBase.knowledgeBaseId,
      knowledgeBaseArn: knowledgeBase.knowledgeBaseArn,
      modelId,
      numberOfResults: 5,
      promptTemplate: PROMPT_TEMPLATE,
      orchestrationPromptTemplate: ORCHESTRATION_PROMPT_TEMPLATE,
    });

    // ========================================
    // 4. Outputs
    // ========================================

    // Every output is declared HERE, at stack level, on purpose. A CfnOutput
    // created inside a child construct gets a path-mangled key such as
    // `WebHostingWebsiteURL3F2A9C1B`, so `scripts/deploy.sh status` and
    // `test-bedrock.sh`, which look up `WebsiteURL`, would silently find
    // nothing. That is exactly what happened on the first real deploy.

    new cdk.CfnOutput(this, 'WebsiteURL', {
      value: webHosting.distributionUrl,
      description: 'CloudFront URL for the web UI',
      exportName: `${this.stackName}-WebsiteURL`,
    });

    new cdk.CfnOutput(this, 'ChatEndpoint', {
      value: `${webHosting.distributionUrl}/api/chat`,
      description: 'Streaming chat endpoint (same origin as the site)',
      exportName: `${this.stackName}-ChatEndpoint`,
    });

    new cdk.CfnOutput(this, 'ChatFunctionName', {
      value: webHosting.chatFunction.functionName,
      description: 'Name of the streaming chat Lambda (for log tailing)',
    });

    new cdk.CfnOutput(this, 'WebsiteBucketName', {
      value: webHosting.websiteBucket.bucketName,
      description: 'S3 bucket name for static website',
    });

    new cdk.CfnOutput(this, 'DistributionId', {
      value: webHosting.distribution.distributionId,
      description: 'CloudFront distribution ID',
    });

    new cdk.CfnOutput(this, 'VectorBucketName', {
      value: knowledgeBase.vectorBucket.vectorBucketName!,
      description: 'S3 Vector Bucket Name',
    });

    new cdk.CfnOutput(this, 'VectorIndexArn', {
      value: knowledgeBase.vectorIndex.attrIndexArn,
      description: 'Vector Index ARN',
    });

    new cdk.CfnOutput(this, 'DataBucketName', {
      value: dataBucket.bucketName,
      description: 'S3 bucket for storing documents',
      exportName: `${this.stackName}-DataBucketName`,
    });

    new cdk.CfnOutput(this, 'KnowledgeBaseIdOutput', {
      value: knowledgeBase.knowledgeBaseId,
      description: 'Knowledge Base ID',
      exportName: `${this.stackName}-KbId`,
    });

    new cdk.CfnOutput(this, 'DataSourceIdOutput', {
      value: knowledgeBase.dataSourceId,
      description: 'Data Source ID',
      exportName: `${this.stackName}-DsId`,
    });

    new cdk.CfnOutput(this, 'ModelId', {
      value: modelId,
      description: 'Inference profile used to generate answers',
    });

    new cdk.CfnOutput(this, 'Region', {
      value: this.region,
      description: 'AWS Region',
    });

    new cdk.CfnOutput(this, 'DocumentFolders', {
      value: 'Financial-Data/, Human-Resources/, Meeting-Notes/',
      description: 'S3 folders for organizing documents',
    });

    new cdk.CfnOutput(this, 'DeploymentInstructions', {
      value:
        'Run "npm run upload-docs" to upload sample documents, then "npm run test-rag" to query them',
      description: 'Next Steps',
    });
  }
}
