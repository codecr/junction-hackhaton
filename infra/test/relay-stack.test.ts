import { describe, expect, it } from 'vitest';
import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { relayStackPropsFromContext } from '../lib/context';
import { JunctionRelayStack, RELAY_ROUTES, type JunctionRelayStackProps } from '../lib/relay-stack';

function synth(props: Partial<JunctionRelayStackProps> = {}): Template {
  const app = new App();
  const stack = new JunctionRelayStack(app, 'Test', {
    alertEmail: 'alerts@example.com',
    env: { region: 'us-east-1' },
    ...props,
  });
  return Template.fromStack(stack);
}

describe('JunctionRelayStack', () => {
  // Bundling runs esbuild once per synth, so share the default template.
  const t = synth();

  it('creates the table with TTL, on demand, no PITR, destroy on delete', () => {
    t.hasResource('AWS::DynamoDB::Table', {
      Properties: {
        TableName: 'junction',
        BillingMode: 'PAY_PER_REQUEST',
        KeySchema: [
          { AttributeName: 'pk', KeyType: 'HASH' },
          { AttributeName: 'sk', KeyType: 'RANGE' },
        ],
        TimeToLiveSpecification: { AttributeName: 'ttl', Enabled: true },
        PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: false },
      },
      DeletionPolicy: 'Delete',
    });
  });

  it('runs the relay on Node 22 arm64 with reserved concurrency and source maps', () => {
    t.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs22.x',
      Architectures: ['arm64'],
      MemorySize: 256,
      Timeout: 10,
      ReservedConcurrentExecutions: 20,
      Environment: {
        Variables: { NODE_OPTIONS: '--enable-source-maps', TABLE_NAME: Match.anyValue() },
      },
    });
    t.hasResourceProperties('AWS::Logs::LogGroup', { RetentionInDays: 30 });
  });

  it('throttles the default stage and logs no bodies', () => {
    t.hasResourceProperties('AWS::ApiGatewayV2::Stage', {
      StageName: '$default',
      AutoDeploy: true,
      DefaultRouteSettings: { ThrottlingRateLimit: 20, ThrottlingBurstLimit: 40 },
      AccessLogSettings: { Format: Match.not(Match.stringLikeRegexp('body|header|authorization')) },
    });
  });

  it('exposes every docs/03 route and no CORS', () => {
    t.resourceCountIs('AWS::ApiGatewayV2::Route', RELAY_ROUTES.length);
    t.hasResourceProperties('AWS::ApiGatewayV2::Route', {
      RouteKey: 'PUT /v1/squads/{id}/charter',
    });
    const apis = t.findResources('AWS::ApiGatewayV2::Api');
    for (const api of Object.values(apis)) {
      expect(
        (api as { Properties: Record<string, unknown> }).Properties['CorsConfiguration'],
      ).toBeUndefined();
    }
  });

  it('alarms to an SNS email topic', () => {
    t.resourceCountIs('AWS::CloudWatch::Alarm', 4);
    t.hasResourceProperties('AWS::SNS::Subscription', {
      Protocol: 'email',
      Endpoint: 'alerts@example.com',
    });
  });

  it('has a 25 USD monthly budget with 50, 80 and 100 percent alerts', () => {
    t.hasResourceProperties('AWS::Budgets::Budget', {
      Budget: { BudgetLimit: { Amount: 25, Unit: 'USD' }, TimeUnit: 'MONTHLY', BudgetType: 'COST' },
      NotificationsWithSubscribers: [50, 80, 100].map((threshold) =>
        Match.objectLike({ Notification: Match.objectLike({ Threshold: threshold }) }),
      ),
    });
  });

  it('creates no domain resources without a hosted zone', () => {
    t.resourceCountIs('AWS::ApiGatewayV2::DomainName', 0);
    t.resourceCountIs('AWS::Route53::RecordSet', 0);
    t.resourceCountIs('AWS::CertificateManager::Certificate', 0);
    expect(Object.keys(t.findOutputs('*'))).toEqual(
      expect.arrayContaining(['ApiUrl', 'TableName']),
    );
  });

  it('creates certificate, domain, mapping and alias record with a hosted zone', () => {
    const d = synth({
      domain: {
        domainName: 'api.junction.example.dev',
        hostedZoneId: 'Z123EXAMPLE',
        hostedZoneName: 'example.dev',
      },
    });
    d.hasResourceProperties('AWS::CertificateManager::Certificate', {
      DomainName: 'api.junction.example.dev',
      ValidationMethod: 'DNS',
    });
    d.resourceCountIs('AWS::ApiGatewayV2::DomainName', 1);
    d.resourceCountIs('AWS::ApiGatewayV2::ApiMapping', 1);
    d.hasResourceProperties('AWS::Route53::RecordSet', { Type: 'A', HostedZoneId: 'Z123EXAMPLE' });
    expect(Object.keys(d.findOutputs('*'))).toContain('CustomDomainUrl');
  });
});

describe('context', () => {
  const ctx = (values: Record<string, unknown>) => (key: string) => values[key];

  it('skips the domain without a hosted zone id and name', () => {
    const props = relayStackPropsFromContext(
      ctx({ alertEmail: 'a@example.com', relayDomain: 'api.x.dev' }),
    );
    expect(props.domain).toBeUndefined();
    expect(props.reservedConcurrency).toBe(20);
  });

  it('builds the domain when all three values are set', () => {
    const props = relayStackPropsFromContext(
      ctx({
        alertEmail: 'a@example.com',
        relayDomain: 'api.x.dev',
        hostedZoneId: 'Z1',
        hostedZoneName: 'x.dev',
      }),
    );
    expect(props.domain).toEqual({
      domainName: 'api.x.dev',
      hostedZoneId: 'Z1',
      hostedZoneName: 'x.dev',
    });
  });

  it('requires an alert email', () => {
    expect(() => relayStackPropsFromContext(ctx({}))).toThrow(/alertEmail/);
  });
});
