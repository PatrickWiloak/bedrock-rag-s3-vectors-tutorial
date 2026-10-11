import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import * as path from 'path';

export interface WebHostingConstructProps {
  /**
   * The Bedrock Knowledge Base to answer questions from
   */
  knowledgeBaseId: string;

  /**
   * ARN of the knowledge base, used to scope the Lambda's IAM policy
   */
  knowledgeBaseArn: string;

  /**
   * The model that generates answers from retrieved chunks.
   *
   * Every current Claude model on Bedrock is served through a cross-Region
   * inference profile, so this is a profile ID such as
   * `us.anthropic.claude-haiku-5-5` rather than a bare foundation model ID.
   */
  modelId: string;

  /**
   * Number of chunks to retrieve per question
   * @default 5
   */
  numberOfResults?: number;

  /**
   * Prompt template controlling how answers are written.
   *
   * Must contain the `$search_results$` placeholder. Omit to use Bedrock's
   * built-in template.
   */
  promptTemplate?: string;

  /**
   * Orchestration prompt template - how the conversation becomes a search
   * query. Must contain `$conversation_history$` and
   * `$output_format_instructions$`. Required (with `$query$` in both
   * templates) by the Claude 5.5 models; optional for older ones.
   */
  orchestrationPromptTemplate?: string;

  /**
   * Path to the built Next.js static export
   * @default '../web/out'
   */
  webBuildPath?: string;
}

/**
 * Strips the cross-Region routing prefix off an inference profile ID.
 *
 * `us.anthropic.claude-haiku-5-5` -> `anthropic.claude-haiku-5-5`
 *
 * An inference profile routes to the same foundation model in several Regions,
 * and `bedrock:InvokeModel` is authorized against the underlying foundation
 * model in whichever Region serves the request - so the policy needs the base
 * model ID as well as the profile.
 */
function baseModelIdOf(modelId: string): string {
  return modelId.replace(/^(us|eu|apac|global)\./, '');
}

/**
 * Viewer-request function that maps clean URLs onto the objects a Next.js
 * static export actually writes.
 *
 * `/study-guide` and `/study-guide/` both need to resolve to
 * `/study-guide/index.html`. Doing it here is precise; the alternative - a
 * CloudFront custom error response mapping 404 to /index.html - papers over
 * genuinely missing objects by returning the homepage with a 200, which hides
 * broken links and confuses crawlers.
 *
 * The code lives in config/cloudfront-url-rewrite.js, shared with the
 * Terraform configuration, so both deploy paths rewrite URLs identically.
 */
const URL_REWRITE_FUNCTION_PATH = path.join(__dirname, '../config/cloudfront-url-rewrite.js');

export class WebHostingConstruct extends Construct {
  public readonly distributionDomainName: string;
  public readonly distributionUrl: string;
  public readonly websiteBucket: s3.Bucket;
  public readonly distribution: cloudfront.Distribution;
  public readonly chatFunction: lambda.Function;

  constructor(scope: Construct, id: string, props: WebHostingConstructProps) {
    super(scope, id);

    const webBuildPath = props.webBuildPath || path.join(__dirname, '../web/out');
    const stack = cdk.Stack.of(this);

    const modelArn = `arn:aws:bedrock:${stack.region}:${stack.account}:inference-profile/${props.modelId}`;
    const baseModelArn = `arn:aws:bedrock:*::foundation-model/${baseModelIdOf(props.modelId)}`;

    // ========================================
    // 1. Streaming chat Lambda
    // ========================================

    this.chatFunction = new lambda.Function(this, 'ChatFunction', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'chat.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda'), {
        bundling: {
          image: lambda.Runtime.NODEJS_22_X.bundlingImage,
          command: [
            'bash',
            '-c',
            'npm install --omit=dev --cache /tmp/npm-cache && cp -r /asset-input/* /asset-output/',
          ],
        },
      }),
      // Generation can run for a while on a large model; the Function URL
      // streams the whole time, so nothing is waiting on a buffered response.
      timeout: cdk.Duration.minutes(5),
      memorySize: 512,
      environment: {
        KNOWLEDGE_BASE_ID: props.knowledgeBaseId,
        MODEL_ARN: modelArn,
        NUMBER_OF_RESULTS: String(props.numberOfResults ?? 5),
        ...(props.promptTemplate ? { PROMPT_TEMPLATE: props.promptTemplate } : {}),
        ...(props.orchestrationPromptTemplate
          ? { ORCHESTRATION_PROMPT_TEMPLATE: props.orchestrationPromptTemplate }
          : {}),
      },
    });

    // Retrieval is scoped to this one knowledge base.
    this.chatFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['bedrock:Retrieve', 'bedrock:RetrieveAndGenerate'],
        resources: [props.knowledgeBaseArn],
      })
    );

    // Generation runs through the inference profile, which in turn invokes the
    // foundation model in one of the Regions the profile spans.
    this.chatFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
        resources: [modelArn, baseModelArn],
      })
    );

    // RetrieveAndGenerate resolves the profile before invoking it. Without this
    // the call fails with "Not authorized to call GetInferenceProfile" - found
    // on the first real deploy, invisible to any synth-time check.
    this.chatFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['bedrock:GetInferenceProfile'],
        resources: [modelArn],
      })
    );

    /**
     * RESPONSE_STREAM is what makes token-by-token output possible. API Gateway
     * cannot do this: its Lambda proxy integration buffers the entire response
     * before returning it, so the client sees nothing until generation is done.
     *
     * AWS_IAM auth means the URL is not publicly callable on its own - only
     * CloudFront, through the Origin Access Control below, can sign requests to it.
     */
    const chatFunctionUrl = this.chatFunction.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.AWS_IAM,
      invokeMode: lambda.InvokeMode.RESPONSE_STREAM,
    });

    // ========================================
    // 2. S3 bucket for the static site
    // ========================================

    this.websiteBucket = new s3.Bucket(this, 'WebsiteBucket', {
      // No websiteIndexDocument here - that would create an S3 website endpoint,
      // which cannot be locked down to CloudFront.
      publicReadAccess: false,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // ========================================
    // 3. CloudFront: static site + /api/* on one origin
    // ========================================

    const urlRewrite = new cloudfront.Function(this, 'UrlRewriteFunction', {
      code: cloudfront.FunctionCode.fromFile({ filePath: URL_REWRITE_FUNCTION_PATH }),
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      comment: 'Rewrites clean URLs to the Next.js static export object keys',
    });

    this.distribution = new cloudfront.Distribution(this, 'WebsiteDistribution', {
      defaultRootObject: 'index.html',
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(this.websiteBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD_OPTIONS,
        compress: true,
        functionAssociations: [
          {
            function: urlRewrite,
            eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
          },
        ],
      },
      additionalBehaviors: {
        /**
         * Serving the API from the same distribution as the site is what makes
         * the front end simple: the browser POSTs to a relative `/api/chat`,
         * so there is no API URL to discover at runtime and no cross-origin
         * request to configure. It also removes the trailing-slash class of bug
         * that comes from string-joining a stage URL.
         */
        '/api/*': {
          origin: origins.FunctionUrlOrigin.withOriginAccessControl(chatFunctionUrl),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          // Critical: compression buffers the response and breaks streaming.
          compress: false,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          // Forwards everything except Host, which must stay the Lambda's own
          // hostname for the signature to validate.
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        },
      },
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100, // US, Europe, Canada
    });

    this.distributionDomainName = this.distribution.distributionDomainName;
    this.distributionUrl = `https://${this.distributionDomainName}`;

    // ========================================
    // 4. Deploy the static files
    // ========================================

    new s3deploy.BucketDeployment(this, 'DeployWebsite', {
      sources: [s3deploy.Source.asset(webBuildPath)],
      destinationBucket: this.websiteBucket,
      distribution: this.distribution,
      distributionPaths: ['/*'],
    });

  }
}
