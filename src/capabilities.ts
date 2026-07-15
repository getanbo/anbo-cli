export {
  CERTIFIED_MINISTACK_DIGEST,
  CERTIFIED_MINISTACK_IMAGE,
  CERTIFIED_MINISTACK_SOURCE,
  CERTIFIED_MINISTACK_VERSION,
} from "./distribution.js";
import {
  CERTIFIED_MINISTACK_DIGEST,
  CERTIFIED_MINISTACK_IMAGE,
  CERTIFIED_MINISTACK_SOURCE,
  CERTIFIED_MINISTACK_VERSION,
} from "./distribution.js";

export type CapabilityFidelity =
  | "real-data-plane"
  | "emulated-data-plane"
  | "control-plane-only"
  | "bring-your-own-data-plane"
  | "conditional-data-plane";

export interface ServiceCapability {
  service: string;
  fidelity: CapabilityFidelity;
  terraformEndpoint?: string;
  requirement?: string;
  limitation?: string;
}

const real = [
  ["S3", "s3"],
  ["SQS", "sqs"],
  ["SNS", "sns"],
  ["DynamoDB", "dynamodb"],
  ["DynamoDB Streams", "dynamodb"],
  ["Lambda", "lambda", "Docker socket for image and provided runtimes"],
  ["Secrets Manager", "secretsmanager"],
  ["CloudWatch Logs", "logs"],
  ["SSM Parameter Store", "ssm"],
  ["EventBridge", "events"],
  ["Kinesis", "kinesis"],
  ["CloudWatch Metrics", "cloudwatch"],
  ["Step Functions", "stepfunctions"],
  ["API Gateway v1", "apigateway"],
  ["API Gateway v2", "apigateway"],
  ["KMS", "kms"],
  ["Firehose", "firehose"],
  ["AppConfig", "appconfig"],
  ["EventBridge Scheduler", "scheduler"],
] as const;

const emulated = [
  ["IAM", "iam", "Policies are stored but do not reproduce complete AWS authorization semantics"],
  ["STS", "sts", "Credentials and identities are local emulations"],
  ["IMDS", "ec2", "Local metadata endpoint only"],
  ["ECS Task Metadata V4", "ecs", "Available to MiniStack-created ECS containers"],
  ["ECS Container Credentials", "ecs", "Available to MiniStack-created ECS containers"],
  ["SES", "ses", "Messages are captured and not delivered"],
  ["SES v2", "sesv2", "Messages are captured and not delivered"],
  ["ACM", "acm", "Certificates are locally issued"],
  ["Backup", "backup", "Jobs complete against emulated resource metadata"],
  ["WAF v2", "wafv2", "Control and association behavior without AWS edge enforcement"],
  ["ELBv2 / ALB", "elbv2", "Local routing fidelity is limited to MiniStack behavior"],
  ["CloudFront", "cloudfront", "Distribution behavior is emulated"],
  ["CloudFront KeyValueStore", "cloudfront", "Local data plane"],
  ["CloudTrail", "cloudtrail", "Local event records"],
  ["Resource Groups", "resourcegroups", "Local tag inventory"],
  ["Cost & Usage Reports", "cur", "Configuration plane and local reports"],
  ["Inspector2", "inspector2", "Findings are emulated"],
  ["CloudFormation", "cloudformation", "MiniStack implements a partial local stack engine rather than the complete CloudFormation service"],
  ["EventBridge Pipes", "pipes", "Supported operation and target coverage is limited to MiniStack's implementation"],
  ["Glue", "glue", "Catalog is local; jobs depend on Docker images"],
  ["S3 Tables", "s3control", "Local table metadata and data"],
  ["Route53", "route53", "Records are stored locally, not published to public DNS"],
  ["Cognito", "cognitoidp", "Tokens are structurally valid local tokens"],
  ["AppSync", "appsync", "Supported GraphQL and event operations only"],
  ["Cloud Map", "servicediscovery", "Local discovery registry"],
  ["S3 Files", "s3control", "Local control plane and supported file operations"],
  ["Organizations", "organizations", "Single local organization model"],
  ["Account", "account", "Local account and region metadata"],
  ["WAF Classic", "waf", "Minimal compatibility stub"],
] as const;

const controlPlane = [
  ["EC2", "ec2", "No virtual machines are started"],
  ["EBS", "ec2", "No block devices are attached to a VM"],
  ["EFS", "efs", "No general-purpose NFS data plane"],
  ["EMR", "emr", "No Spark or Hadoop cluster is executed"],
  ["ECR", "ecr", "In-memory registry metadata and manifest operations"],
  ["Auto Scaling", "autoscaling", "No EC2 instances are created"],
  ["CodeBuild", "codebuild", "Builds complete without executing a build container"],
  ["Batch", "batch", "Jobs complete without executing workload compute"],
] as const;

const conditional = [
  ["ECS", "ecs", "Docker socket", "RunTask starts real Docker containers"],
  ["RDS", "rds", "Docker socket and published RDS port range", "PostgreSQL, MySQL, MariaDB, and Aurora-compatible containers"],
  ["RDS Data API", "rds", "RDS real data plane", "Routes SQL to the local RDS containers"],
  ["ElastiCache", "elasticache", "Docker socket and published Redis port range", "Real Redis containers"],
  ["Athena", "athena", "MiniStack full image", "DuckDB executes SQL in the full image"],
  ["EKS", "eks", "Docker socket and project network", "Creates a real k3s API server"],
  ["OpenSearch Service", "opensearch", "OPENSEARCH_DATAPLANE=1 and Docker socket", "Real OpenSearch is opt-in"],
  ["Transfer Family", "transfer", "Published SFTP port", "Real SFTP listener backed by local S3"],
  ["IoT Core", "iot", "Gateway WebSocket access", "MQTT 3.1.1 over WebSocket"],
] as const;

const bringYourOwn = [
  ["Bedrock", "bedrock", "Deterministic mock unless an OpenAI-compatible model endpoint is configured"],
  ["Bedrock Runtime", "bedrock", "Deterministic mock unless an OpenAI-compatible model endpoint is configured"],
  ["Bedrock Agent", "bedrockagent", "Agent control plane with local runtime behavior"],
  ["Bedrock Agent Runtime", "bedrockagent", "Agent runtime operations use local or configured model behavior"],
  ["MSK", "kafka", "Kafka control plane; set MINISTACK_MSK_BOOTSTRAP for a real broker"],
  ["Amazon MQ", "mq", "Control plane; broker wire protocol is not supplied by MiniStack"],
] as const;

export const SERVICE_CAPABILITIES: readonly ServiceCapability[] = [
  ...real.map(([service, terraformEndpoint, requirement]) => ({
    service,
    fidelity: "real-data-plane" as const,
    terraformEndpoint,
    ...(requirement === undefined ? {} : { requirement }),
  })),
  ...emulated.map(([service, terraformEndpoint, limitation]) => ({
    service,
    fidelity: "emulated-data-plane" as const,
    terraformEndpoint,
    limitation,
  })),
  ...controlPlane.map(([service, terraformEndpoint, limitation]) => ({
    service,
    fidelity: "control-plane-only" as const,
    terraformEndpoint,
    limitation,
  })),
  ...conditional.map(([service, terraformEndpoint, requirement, limitation]) => ({
    service,
    fidelity: "conditional-data-plane" as const,
    terraformEndpoint,
    requirement,
    limitation,
  })),
  ...bringYourOwn.map(([service, terraformEndpoint, limitation]) => ({
    service,
    fidelity: "bring-your-own-data-plane" as const,
    terraformEndpoint,
    limitation,
  })),
].sort((left, right) => left.service.localeCompare(right.service));

export function getCapabilityReport(): Record<string, unknown> {
  const byFidelity = Object.fromEntries(
    [...new Set(SERVICE_CAPABILITIES.map((entry) => entry.fidelity))]
      .map((fidelity) => [fidelity, SERVICE_CAPABILITIES.filter((entry) => entry.fidelity === fidelity).length]),
  );
  return {
    schema_version: 1,
    ministack: {
      version: CERTIFIED_MINISTACK_VERSION,
      certified_image: CERTIFIED_MINISTACK_IMAGE,
      digest: CERTIFIED_MINISTACK_DIGEST,
      source: CERTIFIED_MINISTACK_SOURCE,
    },
    policy: "Terraform may attempt any hashicorp/aws resource inside the isolated worker; this matrix reports verified fidelity rather than acting as an allowlist.",
    terraform: {
      providers: ["hashicorp/aws"],
      aws_provider_versions: ["5", "6"],
      execution: "digest-pinned Docker worker on an internal network; saved-plan apply only",
      unsupported: [
        "production AWS apply",
        "non-AWS providers",
        "provisioners",
        "external data sources",
        "terraform_remote_state data sources",
        "local modules outside the configured Terraform root",
      ],
    },
    data_clones: {
      engines: ["postgres", "dynamodb"],
      providers: ["external", "anbo-cloud"],
      reference_schemes: ["env://", "exec://"],
      terraform_visibility: "clone endpoints and credentials are never passed into Terraform",
    },
    extensions: { adapter_protocol: 2 },
    runtime_limitations: [
      "AWS behavior is bounded by the pinned MiniStack implementation and is not full AWS parity",
      "network.allow_hosts is descriptive in this MVP; runtime container egress is not host-filtered",
      "SDK endpoint routing is injected into declared services, but application clients must honor AWS_ENDPOINT_URL or explicit endpoint settings",
    ],
    counts: { total: SERVICE_CAPABILITIES.length, by_fidelity: byFidelity },
    services: SERVICE_CAPABILITIES,
  };
}
