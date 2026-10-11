/**
 * Where the helper scripts learn the deployed resource IDs.
 *
 * Two deploy paths produce the same stack: CDK (CloudFormation outputs) and
 * Terraform (`terraform output`). Rather than teach every script about both,
 * the scripts read environment variables first and fall back to the
 * CloudFormation stack. `scripts/deploy.sh` exports those variables from
 * `terraform output -json` when IAC=terraform, so the TypeScript never needs
 * to know which tool deployed the resources.
 *
 *   KNOWLEDGE_BASE_ID   DATA_SOURCE_ID   DATA_BUCKET_NAME
 *   MODEL_ID            AWS_REGION       CHAT_ENDPOINT   WEBSITE_URL
 */

import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';

export const STACK_NAME = process.env.STACK_NAME || 'S3VectorRAGStack';

/**
 * Named profiles often have no Region configured, and the SDK then fails with
 * the unhelpful "Region is missing" before it can even read the stack. Fall
 * back to the Region this tutorial targets. `scripts/deploy.sh` also exports
 * AWS_REGION for the same reason.
 */
export const REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1';

export interface DeploymentOutputs {
  knowledgeBaseId: string;
  dataSourceId: string;
  dataBucketName: string;
  modelId: string;
  region: string;
  account: string;
  chatEndpoint?: string;
  websiteUrl?: string;
}

const ENV_KEYS = ['KNOWLEDGE_BASE_ID', 'DATA_SOURCE_ID', 'DATA_BUCKET_NAME', 'MODEL_ID'] as const;

function fromEnvironment(): DeploymentOutputs | null {
  const present = ENV_KEYS.filter((k) => process.env[k]);
  if (present.length === 0) return null;
  if (present.length < ENV_KEYS.length) {
    const missing = ENV_KEYS.filter((k) => !process.env[k]).join(', ');
    throw new Error(
      `Some deployment variables are set but ${missing} are not. ` +
        'Set all of them (IAC=terraform ./scripts/deploy.sh does this) or none.'
    );
  }
  return {
    knowledgeBaseId: process.env.KNOWLEDGE_BASE_ID!,
    dataSourceId: process.env.DATA_SOURCE_ID!,
    dataBucketName: process.env.DATA_BUCKET_NAME!,
    modelId: process.env.MODEL_ID!,
    region: REGION,
    account: process.env.AWS_ACCOUNT_ID || '',
    chatEndpoint: process.env.CHAT_ENDPOINT,
    websiteUrl: process.env.WEBSITE_URL,
  };
}

async function fromCloudFormation(): Promise<DeploymentOutputs> {
  const cfn = new CloudFormationClient({ region: REGION });
  const response = await cfn.send(new DescribeStacksCommand({ StackName: STACK_NAME }));
  const stack = response.Stacks?.[0];
  if (!stack) throw new Error(`Stack ${STACK_NAME} not found`);

  const get = (key: string) => stack.Outputs?.find((o) => o.OutputKey === key)?.OutputValue;
  const knowledgeBaseId = get('KnowledgeBaseIdOutput');
  const dataSourceId = get('DataSourceIdOutput');
  const dataBucketName = get('DataBucketName');
  const modelId = get('ModelId');
  const region = get('Region');

  if (!knowledgeBaseId || !dataSourceId || !dataBucketName || !modelId || !region) {
    throw new Error('Required stack outputs not found. Make sure the stack has been deployed.');
  }

  // The stack ID is itself an ARN, so the account number is already in hand -
  // no extra STS call or credential permission needed.
  // arn:aws:cloudformation:<region>:<account>:stack/<name>/<id>
  const account = stack.StackId?.split(':')[4];
  if (!account) throw new Error(`Could not determine account ID from stack ID: ${stack.StackId}`);

  return {
    knowledgeBaseId,
    dataSourceId,
    dataBucketName,
    modelId,
    region,
    account,
    chatEndpoint: get('ChatEndpoint'),
    websiteUrl: get('WebsiteURL'),
  };
}

/** Environment first (Terraform path), CloudFormation second (CDK path). */
export async function resolveOutputs(): Promise<DeploymentOutputs> {
  return fromEnvironment() ?? fromCloudFormation();
}
