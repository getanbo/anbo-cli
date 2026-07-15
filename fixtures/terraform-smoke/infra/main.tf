terraform {
  required_version = ">= 1.6.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "= 6.54.0"
    }
  }
}

provider "aws" {
  region = "us-east-1"
}

resource "aws_s3_bucket" "smoke" {
  bucket = "anbo-terraform-smoke-bucket"
}

resource "aws_sqs_queue" "smoke" {
  name = "anbo-terraform-smoke-queue"
}

resource "aws_dynamodb_table" "smoke" {
  name         = "anbo-terraform-smoke-table"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "id"

  attribute {
    name = "id"
    type = "S"
  }
}

resource "aws_iam_role" "lambda" {
  name = "anbo-terraform-smoke-lambda"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_lambda_function" "smoke" {
  function_name    = "anbo-terraform-smoke"
  role             = aws_iam_role.lambda.arn
  runtime          = "python3.12"
  handler          = "handler.handler"
  filename         = "dist/smoke.zip"
  source_code_hash = filebase64sha256("dist/smoke.zip")
}

output "bucket" {
  value = aws_s3_bucket.smoke.bucket
}

output "queue_url" {
  value = aws_sqs_queue.smoke.url
}

output "table" {
  value = aws_dynamodb_table.smoke.name
}

output "function_name" {
  value = aws_lambda_function.smoke.function_name
}
