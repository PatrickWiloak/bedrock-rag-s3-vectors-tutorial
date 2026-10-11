import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as bedrock from 'aws-cdk-lib/aws-bedrock';
import * as s3vectors from 'aws-cdk-lib/aws-s3vectors';
import { Construct } from 'constructs';

export interface KnowledgeBaseConstructProps {
  /**
   * S3 bucket containing the documents for the knowledge base
   */
  dataBucket: s3.IBucket;

  /**
   * S3 prefix (folder path) for this knowledge base's documents
   * @example 'Financial-Data/' or 'Human-Resources/'
   */
  dataPrefix?: string;

  /**
   * Name prefix for the knowledge base
   */
  knowledgeBaseName: string;

  /**
   * Bedrock embedding model ID
   * @default 'amazon.titan-embed-text-v2:0'
   */
  embeddingModelId?: string;

  /**
   * Vector dimension produced by the embedding model.
   *
   * Must match the model: Titan Text Embeddings V2 supports 256, 512 or 1024;
   * Cohere Embed models are fixed at 1024.
   *
   * @default 1024
   */
  embeddingDimension?: number;

  /**
   * Maximum tokens per chunk when splitting documents
   * @default 300
   */
  chunkSize?: number;

  /**
   * Percentage of overlap between adjacent chunks
   * @default 7
   */
  chunkOverlapPercentage?: number;
}

/**
 * A Bedrock Knowledge Base backed by Amazon S3 Vectors.
 *
 * Everything here is native CloudFormation - `AWS::S3Vectors::VectorBucket`,
 * `AWS::S3Vectors::Index` and `AWS::Bedrock::KnowledgeBase` with an
 * `S3VectorsConfiguration` storage type. There are no custom resources, so
 * `cdk destroy` tears the stack down cleanly.
 */
export class KnowledgeBaseConstruct extends Construct {
  public readonly knowledgeBase: bedrock.CfnKnowledgeBase;
  public readonly knowledgeBaseId: string;
  public readonly knowledgeBaseArn: string;
  public readonly dataSource: bedrock.CfnDataSource;
  public readonly dataSourceId: string;
  public readonly vectorBucket: s3vectors.CfnVectorBucket;
  public readonly vectorIndex: s3vectors.CfnIndex;
  public readonly role: iam.Role;

  constructor(scope: Construct, id: string, props: KnowledgeBaseConstructProps) {
    super(scope, id);

    const embeddingModelId = props.embeddingModelId ?? 'amazon.titan-embed-text-v2:0';
    const embeddingDimension = props.embeddingDimension ?? 1024;
    const chunkSize = props.chunkSize ?? 300;
    const chunkOverlapPercentage = props.chunkOverlapPercentage ?? 7;

    const stack = cdk.Stack.of(this);
    const region = stack.region;
    const account = stack.account;

    const embeddingModelArn = `arn:aws:bedrock:${region}::foundation-model/${embeddingModelId}`;

    // ========================================
    // 1. S3 Vectors bucket and index
    // ========================================

    this.vectorBucket = new s3vectors.CfnVectorBucket(this, 'VectorBucket', {
      vectorBucketName: `${props.knowledgeBaseName}-vectors`,
    });

    // Deleting the stack should delete the vectors along with it - this is a
    // tutorial, not a production store. Drop these two lines (or switch to
    // RETAIN) if you want the embeddings to survive `cdk destroy`.
    this.vectorBucket.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    this.vectorIndex = new s3vectors.CfnIndex(this, 'VectorIndex', {
      vectorBucketName: this.vectorBucket.vectorBucketName,
      indexName: `${props.knowledgeBaseName}-index`,
      dataType: 'float32',
      dimension: embeddingDimension,
      distanceMetric: 'cosine',
      // S3 Vectors caps *filterable* metadata at 2KB per vector, but allows 40KB
      // total. Bedrock stores the chunk text itself in AMAZON_BEDROCK_TEXT, which
      // blows past 2KB on all but the smallest chunks. Marking these two keys
      // non-filterable is what keeps ingestion from failing with
      // "metadata must have at most 2048 bytes".
      metadataConfiguration: {
        nonFilterableMetadataKeys: [
          'AMAZON_BEDROCK_TEXT',
          'AMAZON_BEDROCK_METADATA',
        ],
      },
    });
    this.vectorIndex.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    // The index names its parent bucket by name rather than by ARN, so
    // CloudFormation cannot infer the ordering on its own.
    this.vectorIndex.addResourceDependency(this.vectorBucket);

    // ========================================
    // 2. IAM role assumed by Bedrock
    // ========================================

    // Scoped to this account so the role cannot be used as a confused deputy by
    // another customer's knowledge base. We deliberately do not add an
    // aws:SourceArn condition on the knowledge base ARN: the knowledge base
    // needs this role's ARN at create time, so referencing the knowledge base
    // back from the role would be a circular dependency.
    this.role = new iam.Role(this, 'KnowledgeBaseRole', {
      assumedBy: new iam.ServicePrincipal('bedrock.amazonaws.com', {
        conditions: {
          StringEquals: { 'aws:SourceAccount': account },
        },
      }),
      description: `Role assumed by Bedrock for knowledge base ${props.knowledgeBaseName}`,
    });

    // Generate embeddings for incoming documents and for queries.
    this.role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['bedrock:InvokeModel'],
        resources: [embeddingModelArn],
      })
    );

    // Read the source documents. grantRead also adds s3:ListBucket on the
    // bucket itself, which the ingestion job needs to enumerate objects.
    props.dataBucket.grantRead(this.role, props.dataPrefix ? `${props.dataPrefix}*` : undefined);

    // Read and write the vector index. Ingestion needs Put/Delete, retrieval
    // needs Query/Get, and knowledge base validation calls GetIndex.
    this.role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          's3vectors:GetIndex',
          's3vectors:QueryVectors',
          's3vectors:PutVectors',
          's3vectors:GetVectors',
          's3vectors:ListVectors',
          's3vectors:DeleteVectors',
        ],
        resources: [this.vectorIndex.attrIndexArn],
      })
    );

    this.role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['s3vectors:GetVectorBucket'],
        resources: [this.vectorBucket.attrVectorBucketArn],
      })
    );

    // ========================================
    // 3. Knowledge base
    // ========================================

    this.knowledgeBase = new bedrock.CfnKnowledgeBase(this, 'KnowledgeBase', {
      name: props.knowledgeBaseName,
      description: `Knowledge base for RAG tutorial - ${props.knowledgeBaseName}`,
      roleArn: this.role.roleArn,
      knowledgeBaseConfiguration: {
        type: 'VECTOR',
        vectorKnowledgeBaseConfiguration: {
          embeddingModelArn,
          embeddingModelConfiguration: {
            bedrockEmbeddingModelConfiguration: {
              dimensions: embeddingDimension,
              embeddingDataType: 'FLOAT32',
            },
          },
        },
      },
      storageConfiguration: {
        type: 'S3_VECTORS',
        s3VectorsConfiguration: {
          indexArn: this.vectorIndex.attrIndexArn,
        },
      },
    });

    // Bedrock validates the role's permissions when the knowledge base is
    // created, so the inline policies have to land first.
    this.knowledgeBase.node.addDependency(this.role);

    this.knowledgeBaseId = this.knowledgeBase.attrKnowledgeBaseId;
    this.knowledgeBaseArn = this.knowledgeBase.attrKnowledgeBaseArn;

    // ========================================
    // 4. S3 data source
    // ========================================

    this.dataSource = new bedrock.CfnDataSource(this, 'DataSource', {
      name: `${props.knowledgeBaseName}-s3-datasource`,
      knowledgeBaseId: this.knowledgeBaseId,
      dataSourceConfiguration: {
        type: 'S3',
        s3Configuration: {
          bucketArn: props.dataBucket.bucketArn,
          inclusionPrefixes: props.dataPrefix ? [props.dataPrefix] : undefined,
        },
      },
      vectorIngestionConfiguration: {
        chunkingConfiguration: {
          chunkingStrategy: 'FIXED_SIZE',
          fixedSizeChunkingConfiguration: {
            maxTokens: chunkSize,
            overlapPercentage: chunkOverlapPercentage,
          },
        },
      },
      // The vector index is deleted with the stack anyway, and RETAIN keeps
      // CloudFormation from blocking the delete on a vector-store cleanup pass.
      dataDeletionPolicy: 'RETAIN',
    });

    this.dataSourceId = this.dataSource.attrDataSourceId;

  }
}
