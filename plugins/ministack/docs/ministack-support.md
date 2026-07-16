# MiniStack Support

Anbo 0.1 certifies the full multi-platform image at
`ghcr.io/getanbo/anbo-ministack@sha256:cf29ce9cacd3982531b5f5bd48a7b46c10acaf4f44a10fb25831b3073c26b204`.
It was built by `getanbo/anbo-ministack` commit
`09aa7a0bc6869b5499e617d7c22ce728999c399d` from upstream MiniStack v1.4.2
commit `25c2cbad8ff77108823359d3d5c8e92a44726acd`, then qualified through the
installed canonical CLI acceptance suite. See `runtime-manifest.json` for the
machine-readable provenance.
The matrix contains 71 service surfaces. It describes expected fidelity and is
not a Terraform allowlist; use `anbo capabilities --json` for the exact current
entries, requirements, endpoint names, and per-service limitations.

## Fidelity Groups

| Fidelity | Services |
| --- | --- |
| Real data plane (19) | API Gateway v1, API Gateway v2, AppConfig, CloudWatch Logs, CloudWatch Metrics, DynamoDB, DynamoDB Streams, EventBridge, EventBridge Scheduler, Firehose, Kinesis, KMS, Lambda, S3, Secrets Manager, SNS, SQS, SSM Parameter Store, Step Functions |
| Emulated data plane (29) | Account, ACM, AppSync, Backup, Cloud Map, CloudFormation, CloudFront, CloudFront KeyValueStore, CloudTrail, Cognito, Cost & Usage Reports, ECS Container Credentials, ECS Task Metadata V4, ELBv2 / ALB, EventBridge Pipes, Glue, IAM, IMDS, Inspector2, Organizations, Resource Groups, Route53, S3 Files, S3 Tables, SES, SES v2, STS, WAF Classic, WAF v2 |
| Conditional data plane (9) | Athena, ECS, EKS, ElastiCache, IoT Core, OpenSearch Service, RDS, RDS Data API, Transfer Family |
| Control plane only (8) | Auto Scaling, Batch, CodeBuild, EBS, EC2, ECR, EFS, EMR |
| Bring your own data plane (6) | Amazon MQ, Bedrock, Bedrock Agent, Bedrock Agent Runtime, Bedrock Runtime, MSK |

"Real" means MiniStack supplies a working local implementation; it does not
promise byte-for-byte AWS behavior for every API. Emulated services intentionally
change semantics, such as capturing SES mail instead of delivering it and
storing IAM policy without reproducing all AWS authorization. Conditional
services require the Docker socket, a published port, a full-image component,
or an opt-in environment value. Bring-your-own services require an external
wire-protocol or model endpoint for non-mock behavior.

## Terraform Boundary

- Terraform support is for `hashicorp/aws`. Anbo generates MiniStack endpoint
  configuration for AWS provider v5/v6 and each literal provider alias.
- Terraform runs only in a digest-pinned Docker worker. Registry access is
  available during `init`; validate, plan, apply, and output use an internal
  control network that can reach MiniStack but not production AWS.
- The apply consumes the previously saved plan. Remote backend declarations are
  replaced in Anbo's private copy with local state; source Terraform is not
  edited.
- Ambient AWS credentials and profiles, clone credentials, CI secrets,
  `ANBO_*`, and `TF_VAR_*` do not enter the Terraform worker. AWS provider
  credential and endpoint fields are rejected so the generated override owns
  routing.
- Provisioners, `data.external`, `data.terraform_remote_state`, and absolute or
  parent-relative local module sources are rejected. Registry modules and local
  modules contained inside the configured root can initialize normally.
- The CLI does not have a production AWS mode or a host Terraform fallback.

An unsupported resource normally fails in Terraform with structured Anbo
process output and a final diagnostic. It is not silently redirected to AWS.

## Runtime Routing

Declared Docker services receive local credentials and a MiniStack
`AWS_ENDPOINT_URL`, plus the active CLI operation in `ANBO_RUN_ID`. Modern SDKs
that honor that setting route to MiniStack. SDK
discovery during `anbo configure` only reports Node.js, Python, Go, and Java
hints; it does not patch source or explicit client endpoints.

Application code that ignores `AWS_ENDPOINT_URL` must explicitly consume
`${ministack.endpoint}` from a manifest environment entry. A service with
`dynamodb_plane: "clone"` receives clone DynamoDB credentials and endpoint as
its default DynamoDB settings. A service that needs both local and cloned
DynamoDB must create two clients.

Configured test commands additionally receive `ANBO_TEST_ID` and a default
`ANBO_TEST_RUN_ID` correlation value. Declaring `ANBO_TEST_PROTOCOL=jsonl-v1`
promotes validated child test events into Anbo's ordered event stream while
retaining their original stdout as `process.output`.

Terraform network isolation is enforced, but application egress policy is not:
`network.allow_hosts` and `network.clone_egress` are currently descriptive. Do
not treat them as a security boundary.

## Platform Notes

Anbo reads the Docker server platform rather than inferring it from the Node
host process. The current runtime manifest certifies `linux/amd64`, so Anbo
selects that image platform deterministically on both amd64 and arm64 Docker
servers and uses Docker emulation where necessary. MiniStack features that start
containers, including Lambda, ECS, EKS, RDS, and ElastiCache, also require
access to the local Docker daemon and may carry their own architecture
constraints.

MiniStack fidelity is version-specific. Replacing the certified tag or digest
is an explicit compatibility change and should be validated through an installed
CLI deployment and smoke test.
