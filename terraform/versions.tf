# Provider pins.
#
# S3 Vectors resources (aws_s3vectors_vector_bucket, aws_s3vectors_index) and
# the S3_VECTORS storage type on aws_bedrockagent_knowledge_base are all
# first-party resources in the hashicorp/aws provider - no awscc provider and no
# community module is needed any more. The floor below is the first release in
# which the whole set has been stable in our testing.

terraform {
  required_version = ">= 1.10"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 6.68"
    }
    archive = {
      source  = "hashicorp/archive"
      version = ">= 2.7"
    }
    random = {
      source  = "hashicorp/random"
      version = ">= 3.7"
    }
  }

  # State is local by default - fine for a tutorial you will tear down. For
  # anything shared, point this at an S3 bucket:
  #
  # backend "s3" {
  #   bucket       = "my-terraform-state"
  #   key          = "bedrock-rag-tutorial/terraform.tfstate"
  #   region       = "us-east-1"
  #   use_lockfile = true
  # }
}

provider "aws" {
  region  = var.region
  profile = var.aws_profile

  default_tags {
    tags = {
      Project = "bedrock-rag-s3-vectors-tutorial"
    }
  }
}
