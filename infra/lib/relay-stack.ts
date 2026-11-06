import { fileURLToPath } from 'node:url';
import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import { AccessLogFormat } from 'aws-cdk-lib/aws-apigateway';
import {
  ApiMapping,
  DomainName,
  HttpApi,
  HttpMethod,
  HttpStage,
  LogGroupLogDestination,
} from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { CfnBudget } from 'aws-cdk-lib/aws-budgets';
import { Certificate, CertificateValidation } from 'aws-cdk-lib/aws-certificatemanager';
import {
  Alarm,
  ComparisonOperator,
  TreatMissingData,
  type IMetric,
} from 'aws-cdk-lib/aws-cloudwatch';
import { SnsAction } from 'aws-cdk-lib/aws-cloudwatch-actions';
import { AttributeType, BillingMode, Operation, Table } from 'aws-cdk-lib/aws-dynamodb';
import { Architecture, Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { ARecord, HostedZone, RecordTarget } from 'aws-cdk-lib/aws-route53';
import { ApiGatewayv2DomainProperties } from 'aws-cdk-lib/aws-route53-targets';
import { Topic } from 'aws-cdk-lib/aws-sns';
import { EmailSubscription } from 'aws-cdk-lib/aws-sns-subscriptions';
import type { Construct } from 'constructs';

// JunctionRelayStack (docs/02, "AWS infrastructure"): the squad server mailbox. DynamoDB single
// table, one Lambda behind an HTTP API, alarms to email, and a monthly budget.

export interface RelayDomainProps {
  /** For example `api.junction.gerardo.dev`. */
  domainName: string;
  hostedZoneId: string;
  hostedZoneName: string;
}

export interface JunctionRelayStackProps extends StackProps {
  alertEmail: string;
  /** Omit to serve only the execute-api URL. */
  domain?: RelayDomainProps;
  /** Reserved concurrency for the relay Lambda. 0 leaves it unreserved. */
  reservedConcurrency?: number;
  monthlyBudgetUsd?: number;
}

const repoFile = (rel: string) => fileURLToPath(new URL(`../../${rel}`, import.meta.url));

/** Every route in docs/03 "Squad server API". Anything else is a 404 at the gateway. */
export const RELAY_ROUTES: [HttpMethod, string][] = [
  [HttpMethod.GET, '/v1/health'],
  [HttpMethod.POST, '/v1/squads'],
  [HttpMethod.GET, '/v1/squads/{id}'],
  [HttpMethod.DELETE, '/v1/squads/{id}'],
  [HttpMethod.PUT, '/v1/squads/{id}/charter'],
  [HttpMethod.PUT, '/v1/squads/{id}/members/{mid}/manifest'],
  [HttpMethod.DELETE, '/v1/squads/{id}/members/{mid}'],
  [HttpMethod.POST, '/v1/squads/{id}/signals'],
  [HttpMethod.GET, '/v1/squads/{id}/signals'],
  [HttpMethod.POST, '/v1/squads/{id}/announcements'],
  [HttpMethod.POST, '/v1/squads/{id}/claims'],
  [HttpMethod.POST, '/v1/squads/{id}/join-requests'],
  [HttpMethod.GET, '/v1/squads/{id}/join-requests'],
];

export class JunctionRelayStack extends Stack {
  constructor(scope: Construct, id: string, props: JunctionRelayStackProps) {
    super(scope, id, props);

    const table = new Table(this, 'Table', {
      tableName: 'junction',
      partitionKey: { name: 'pk', type: AttributeType.STRING },
      sortKey: { name: 'sk', type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: false },
      deletionProtection: false,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const fnLogs = new LogGroup(this, 'RelayLogs', {
      retention: RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const reserved = props.reservedConcurrency ?? 20;
    const fn = new NodejsFunction(this, 'Relay', {
      functionName: 'junction-relay',
      entry: repoFile('packages/relay/src/handler.ts'),
      handler: 'handler',
      projectRoot: repoFile(''),
      depsLockFilePath: repoFile('package-lock.json'),
      runtime: Runtime.NODEJS_22_X,
      architecture: Architecture.ARM_64,
      memorySize: 256,
      timeout: Duration.seconds(10),
      ...(reserved > 0 ? { reservedConcurrentExecutions: reserved } : {}),
      logGroup: fnLogs,
      environment: {
        TABLE_NAME: table.tableName,
        NODE_OPTIONS: '--enable-source-maps',
      },
      bundling: {
        minify: true,
        sourceMap: true,
        target: 'node22',
        externalModules: ['@aws-sdk/*'],
      },
    });
    table.grantReadWriteData(fn);

    const api = new HttpApi(this, 'Api', {
      apiName: 'junction-relay',
      description: 'Junction squad server: signed envelopes only.',
      createDefaultStage: false,
      // No CORS: the local agent calls the relay server-side; browsers never do.
    });
    const integration = new HttpLambdaIntegration('RelayIntegration', fn);
    for (const [method, path] of RELAY_ROUTES) {
      api.addRoutes({ path, methods: [method], integration });
    }

    const accessLogs = new LogGroup(this, 'ApiAccessLogs', {
      retention: RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    // Request metadata only: no headers, no bodies, no query strings.
    const stage = new HttpStage(this, 'DefaultStage', {
      httpApi: api,
      stageName: '$default',
      autoDeploy: true,
      throttle: { rateLimit: 20, burstLimit: 40 },
      accessLogSettings: {
        destination: new LogGroupLogDestination(accessLogs),
        format: AccessLogFormat.custom(
          JSON.stringify({
            requestId: '$context.requestId',
            time: '$context.requestTime',
            ip: '$context.identity.sourceIp',
            method: '$context.httpMethod',
            route: '$context.routeKey',
            status: '$context.status',
            length: '$context.responseLength',
            latency: '$context.integrationLatency',
          }),
        ),
      },
    });

    // Alarms to the owner's email.
    const topic = new Topic(this, 'Alerts', { displayName: 'Junction relay alerts' });
    topic.addSubscription(new EmailSubscription(props.alertEmail));
    const action = new SnsAction(topic);
    const alarm = (id: string, metric: IMetric, threshold: number, description: string) => {
      const a = new Alarm(this, id, {
        metric,
        threshold,
        evaluationPeriods: 1,
        comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: TreatMissingData.NOT_BREACHING,
        alarmDescription: description,
      });
      a.addAlarmAction(action);
      return a;
    };
    const fiveMin = { period: Duration.minutes(5), statistic: 'Sum' };
    alarm('LambdaErrors', fn.metricErrors(fiveMin), 5, 'The relay Lambda is failing.');
    alarm(
      'LambdaThrottles',
      fn.metricThrottles(fiveMin),
      1,
      'The relay Lambda is being throttled.',
    );
    alarm('Api5xx', stage.metricServerError(fiveMin), 5, 'The relay API is returning 5xx.');
    alarm(
      'TableThrottles',
      table.metricThrottledRequestsForOperations({
        ...fiveMin,
        operations: [
          Operation.GET_ITEM,
          Operation.PUT_ITEM,
          Operation.QUERY,
          Operation.BATCH_WRITE_ITEM,
        ],
      }),
      1,
      'DynamoDB is throttling the relay table.',
    );

    // Monthly cost budget with 50, 80 and 100 percent email alerts.
    const budgetUsd = props.monthlyBudgetUsd ?? 25;
    new CfnBudget(this, 'Budget', {
      budget: {
        budgetName: 'junction-monthly',
        budgetType: 'COST',
        timeUnit: 'MONTHLY',
        budgetLimit: { amount: budgetUsd, unit: 'USD' },
      },
      notificationsWithSubscribers: [50, 80, 100].map((threshold) => ({
        notification: {
          notificationType: 'ACTUAL',
          comparisonOperator: 'GREATER_THAN',
          threshold,
          thresholdType: 'PERCENTAGE',
        },
        subscribers: [{ subscriptionType: 'EMAIL', address: props.alertEmail }],
      })),
    });

    new CfnOutput(this, 'ApiUrl', {
      value: api.apiEndpoint,
      description: 'execute-api URL of the squad server',
    });
    new CfnOutput(this, 'TableName', { value: table.tableName });

    if (props.domain) {
      const zone = HostedZone.fromHostedZoneAttributes(this, 'Zone', {
        hostedZoneId: props.domain.hostedZoneId,
        zoneName: props.domain.hostedZoneName,
      });
      const certificate = new Certificate(this, 'Certificate', {
        domainName: props.domain.domainName,
        validation: CertificateValidation.fromDns(zone),
      });
      const domainName = new DomainName(this, 'DomainName', {
        domainName: props.domain.domainName,
        certificate,
      });
      new ApiMapping(this, 'ApiMapping', { api, domainName, stage });
      new ARecord(this, 'AliasRecord', {
        zone,
        recordName: props.domain.domainName,
        target: RecordTarget.fromAlias(
          new ApiGatewayv2DomainProperties(
            domainName.regionalDomainName,
            domainName.regionalHostedZoneId,
          ),
        ),
      });
      new CfnOutput(this, 'CustomDomainUrl', { value: `https://${props.domain.domainName}` });
    }
  }
}
