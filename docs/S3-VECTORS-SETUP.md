# Amazon S3 Vectors Reference

Background on the vector store behind this tutorial's knowledge base.

> **This used to be a manual setup guide.** While S3 Vectors was in preview there were no CloudFormation resources for it, so the tutorial walked you through creating a vector bucket and index by hand in the console. That is no longer necessary - S3 Vectors is generally available with native CloudFormation support, and [lib/knowledge-base-construct.ts](../lib/knowledge-base-construct.ts) creates everything. This page is now reference material.

## What it is

S3 Vectors is a vector store built into S3. It holds embeddings and does similarity search, billed per request and per GB stored rather than by provisioned capacity.

Three resource types, all native CloudFormation:

| Resource | Purpose |
|---|---|
| `AWS::S3Vectors::VectorBucket` | Container for indexes |
| `AWS::S3Vectors::Index` | The searchable index - dimension, distance metric, metadata config |
| `AWS::S3Vectors::VectorBucketPolicy` | Resource policy on a vector bucket |

In CDK: `aws-cdk-lib/aws-s3vectors`, exposing `CfnVectorBucket`, `CfnIndex`, and `CfnVectorBucketPolicy`. These are L1 constructs - there are no hand-written L2s yet, so you configure them exactly as you would in CloudFormation.

## Index configuration

```typescript
new s3vectors.CfnIndex(this, 'VectorIndex', {
  vectorBucketName: bucket.vectorBucketName,
  indexName: 'my-index',
  dataType: 'float32',
  dimension: 1024,
  distanceMetric: 'cosine',
  metadataConfiguration: {
    nonFilterableMetadataKeys: ['AMAZON_BEDROCK_TEXT', 'AMAZON_BEDROCK_METADATA'],
  },
});
```

| Property | Accepted values | Notes |
|---|---|---|
| `dataType` | `float32` | Only value currently supported |
| `dimension` | 1-4096 | Must match the embedding model |
| `distanceMetric` | `cosine`, `euclidean` | `cosine` for text embeddings |
| `indexName` | 3-63 characters | |
| `metadataConfiguration` | up to 10 non-filterable keys | See below |

**`dataType`, `dimension`, `distanceMetric`, `indexName`, `metadataConfiguration`, and the bucket reference are all create-only.** Changing any of them replaces the index and discards every stored vector, so you must re-run ingestion afterwards.

## The metadata limit that breaks ingestion

This is the one S3 Vectors quirk that will cost you an afternoon if you hit it cold.

- **40KB** total metadata per vector
- **2KB** of *filterable* metadata per vector

Bedrock stores the chunk text itself in `AMAZON_BEDROCK_TEXT`, which for any reasonable chunk size exceeds 2KB. If that key is filterable, ingestion fails with:

```
metadata must have at most 2048 bytes
```

The fix is to declare it non-filterable at index creation:

```typescript
metadataConfiguration: {
  nonFilterableMetadataKeys: ['AMAZON_BEDROCK_TEXT', 'AMAZON_BEDROCK_METADATA'],
}
```

Non-filterable metadata is still returned with query results - it just can't be used in a filter expression. Since you never want to filter on the chunk body anyway, nothing is lost.

Because `metadataConfiguration` is create-only, getting this wrong means recreating the index.

## Using it with a Bedrock Knowledge Base

```typescript
storageConfiguration: {
  type: 'S3_VECTORS',
  s3VectorsConfiguration: {
    indexArn: vectorIndex.attrIndexArn,
  },
}
```

`S3VectorsConfiguration` accepts **either** `indexArn` alone, **or** `vectorBucketArn` plus `indexName`. This tutorial uses `indexArn` because it's a single unambiguous reference and CloudFormation resolves the dependency ordering from it.

`S3_VECTORS` is one of seven storage types `AWS::Bedrock::KnowledgeBase` accepts, alongside `OPENSEARCH_SERVERLESS`, `OPENSEARCH_MANAGED_CLUSTER`, `PINECONE`, `RDS`, `NEPTUNE_ANALYTICS`, and `MONGO_DB_ATLAS`.

## IAM

The role Bedrock assumes needs these on the index ARN:

```
s3vectors:GetIndex
s3vectors:QueryVectors
s3vectors:PutVectors
s3vectors:GetVectors
s3vectors:ListVectors
s3vectors:DeleteVectors
```

and `s3vectors:GetVectorBucket` on the bucket ARN.

Note the plurals - the actions are `GetVectors` and `DeleteVectors`, not `GetVector`. Singular forms silently grant nothing.

Deploying the stack additionally needs `CreateVectorBucket`, `CreateIndex`, `DeleteVectorBucket`, `DeleteIndex`, and `ListIndexes`; see [iam-policy.json](../iam-policy.json).

## CLI

```bash
# Buckets and indexes
aws s3vectors list-vector-buckets --region us-east-1
aws s3vectors list-indexes --vector-bucket-name <name> --region us-east-1
aws s3vectors get-index --vector-bucket-name <name> --index-name <index> --region us-east-1

# Data plane
aws s3vectors list-vectors --vector-bucket-name <name> --index-name <index> --region us-east-1
aws s3vectors query-vectors --help
```

Full operation list: `aws s3vectors help`.

## When to use something else

S3 Vectors trades latency for cost. It is the right choice for document Q&A over a corpus queried occasionally - which is this tutorial's shape and most internal knowledge bases.

Choose **OpenSearch Serverless** instead when you need:

- Consistently low query latency under sustained load
- Hybrid (vector + keyword) search you can rely on
- Rich filtering and aggregation over large metadata

Choose **Aurora / RDS with pgvector** when the vectors belong alongside relational data you're already querying transactionally.

The knowledge base abstracts this: switching stores means changing `storageConfiguration` and re-ingesting, not rewriting your query code.

## Cost

Billing is per GB stored, per PUT request, and per query request - there is **no provisioned capacity charge**, which is the substantive difference from OpenSearch Serverless and the reason an idle stack in this tutorial costs almost nothing.

For this tutorial's 16 documents the storage and request costs are cents. Model inference dominates the bill. Current pricing: [Amazon S3 pricing](https://aws.amazon.com/s3/pricing/).

## Cleanup

`cdk destroy` removes the vector bucket and index along with everything else - the construct sets `RemovalPolicy.DESTROY` on both. To keep the embeddings across stack deletions, change those to `RETAIN` in [lib/knowledge-base-construct.ts](../lib/knowledge-base-construct.ts).

Confirm nothing is left:

```bash
aws s3vectors list-vector-buckets --region us-east-1
```

## Troubleshooting

| Error | Cause |
|---|---|
| `metadata must have at most 2048 bytes` | Missing `nonFilterableMetadataKeys`. The index must be recreated. |
| Knowledge base creation fails with 403 | The KB role lacks `s3vectors:*` on the index, or lacks `GetIndex`. |
| Dimension mismatch at ingestion | Index `dimension` doesn't match the embedding model output. |
| `S3 Vectors not available in this Region` | Not every Region has it. Check the S3 Vectors documentation for current Region support. |
| An index change did nothing | Most index properties are create-only. Check whether CloudFormation replaced the resource, and re-ingest if it did. |

## Further reading

- [Amazon S3 Vectors user guide](https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-vectors.html)
- [AWS::S3Vectors::Index](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-s3vectors-index.html)
- [AWS::Bedrock::KnowledgeBase StorageConfiguration](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-properties-bedrock-knowledgebase-storageconfiguration.html)
