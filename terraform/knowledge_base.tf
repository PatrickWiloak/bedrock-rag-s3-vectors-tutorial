# S3 Vectors store + Bedrock Knowledge Base + S3 data source.
#
# Everything here is a first-party hashicorp/aws resource; there are no custom
# resources, so `terraform destroy` tears it all down cleanly.

# ---------------------------------------------------------------------------
# 1. S3 Vectors bucket and index
# ---------------------------------------------------------------------------

resource "aws_s3vectors_vector_bucket" "vectors" {
  vector_bucket_name = "${local.knowledge_base_name}-vectors"

  # Tutorial-only: delete the index and its vectors with the bucket.
  force_destroy = true
}

resource "aws_s3vectors_index" "index" {
  vector_bucket_name = aws_s3vectors_vector_bucket.vectors.vector_bucket_name
  index_name         = "${local.knowledge_base_name}-index"

  # Every argument on this resource is create-only. Changing one replaces the
  # index, discards every stored vector, and means re-running ingestion.
  data_type       = "float32"
  dimension       = var.embedding_dimension
  distance_metric = "cosine"

  # S3 Vectors caps *filterable* metadata at 2KB per vector but allows 40KB in
  # total. Bedrock stores the chunk text itself in AMAZON_BEDROCK_TEXT, which
  # blows past 2KB on all but the smallest chunks. Marking these two keys
  # non-filterable is what keeps ingestion from failing with
  # "metadata must have at most 2048 bytes".
  metadata_configuration {
    non_filterable_metadata_keys = [
      "AMAZON_BEDROCK_TEXT",
      "AMAZON_BEDROCK_METADATA",
    ]
  }
}

# ---------------------------------------------------------------------------
# 2. IAM role assumed by Bedrock
# ---------------------------------------------------------------------------

# Scoped to this account so the role cannot be used as a confused deputy by
# another customer's knowledge base. There is deliberately no aws:SourceArn
# condition on the knowledge base ARN: the knowledge base needs this role at
# create time, so referencing it back from the role would be a cycle.
data "aws_iam_policy_document" "kb_trust" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["bedrock.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account_id]
    }
  }
}

resource "aws_iam_role" "knowledge_base" {
  name_prefix        = "bedrock-kb-"
  description        = "Role assumed by Bedrock for knowledge base ${local.knowledge_base_name}"
  assume_role_policy = data.aws_iam_policy_document.kb_trust.json
}

data "aws_iam_policy_document" "kb_permissions" {
  # Generate embeddings for incoming documents and for queries.
  statement {
    sid       = "InvokeEmbeddingModel"
    actions   = ["bedrock:InvokeModel"]
    resources = [local.embedding_model_arn]
  }

  # Read the source documents. ListBucket is what the ingestion job uses to
  # enumerate objects.
  statement {
    sid       = "ReadDocuments"
    actions   = ["s3:GetObject", "s3:ListBucket"]
    resources = [aws_s3_bucket.docs.arn, "${aws_s3_bucket.docs.arn}/*"]
  }

  # Read and write the vector index. Ingestion needs Put/Delete, retrieval
  # needs Query/Get, and knowledge base validation calls GetIndex. Note the
  # plurals: the actions are GetVectors and DeleteVectors; singular forms
  # silently grant nothing.
  statement {
    sid = "UseVectorIndex"
    actions = [
      "s3vectors:GetIndex",
      "s3vectors:QueryVectors",
      "s3vectors:PutVectors",
      "s3vectors:GetVectors",
      "s3vectors:ListVectors",
      "s3vectors:DeleteVectors",
    ]
    resources = [aws_s3vectors_index.index.index_arn]
  }

  statement {
    sid       = "DescribeVectorBucket"
    actions   = ["s3vectors:GetVectorBucket"]
    resources = [aws_s3vectors_vector_bucket.vectors.vector_bucket_arn]
  }
}

resource "aws_iam_role_policy" "knowledge_base" {
  name   = "knowledge-base-access"
  role   = aws_iam_role.knowledge_base.id
  policy = data.aws_iam_policy_document.kb_permissions.json
}

# ---------------------------------------------------------------------------
# 3. Knowledge base
# ---------------------------------------------------------------------------

resource "aws_bedrockagent_knowledge_base" "kb" {
  name        = local.knowledge_base_name
  description = "Knowledge base for RAG tutorial - ${local.knowledge_base_name}"
  role_arn    = aws_iam_role.knowledge_base.arn

  knowledge_base_configuration {
    type = "VECTOR"

    vector_knowledge_base_configuration {
      embedding_model_arn = local.embedding_model_arn

      embedding_model_configuration {
        bedrock_embedding_model_configuration {
          dimensions          = var.embedding_dimension
          embedding_data_type = "FLOAT32"
        }
      }
    }
  }

  storage_configuration {
    type = "S3_VECTORS"

    s3_vectors_configuration {
      index_arn = aws_s3vectors_index.index.index_arn
    }
  }

  # Bedrock validates the role's permissions when the knowledge base is
  # created, so the inline policy has to land first. The role ARN reference
  # alone does not order the policy attachment.
  depends_on = [aws_iam_role_policy.knowledge_base]
}

# ---------------------------------------------------------------------------
# 4. S3 data source
# ---------------------------------------------------------------------------

resource "aws_bedrockagent_data_source" "docs" {
  knowledge_base_id = aws_bedrockagent_knowledge_base.kb.id
  name              = "${local.knowledge_base_name}-s3-datasource"

  # The vector index is deleted with the stack anyway; RETAIN keeps the
  # delete from blocking on a vector-store cleanup pass.
  data_deletion_policy = "RETAIN"

  data_source_configuration {
    type = "S3"

    s3_configuration {
      bucket_arn = aws_s3_bucket.docs.arn
      # No inclusion_prefixes: index every folder in the bucket.
    }
  }

  vector_ingestion_configuration {
    chunking_configuration {
      chunking_strategy = "FIXED_SIZE"

      fixed_size_chunking_configuration {
        max_tokens         = var.chunk_size
        overlap_percentage = var.chunk_overlap_percentage
      }
    }
  }
}
