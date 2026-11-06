import { App } from 'aws-cdk-lib';
import { relayStackPropsFromContext } from '../lib/context';
import { JunctionRelayStack } from '../lib/relay-stack';

// Synth needs no AWS credentials: no lookups. The account comes from the CLI profile at deploy time.
const app = new App();
const props = relayStackPropsFromContext((key) => app.node.tryGetContext(key) as unknown);

new JunctionRelayStack(app, 'JunctionRelayStack', {
  ...props,
  env: {
    region: 'us-east-1',
    ...(process.env['CDK_DEFAULT_ACCOUNT'] ? { account: process.env['CDK_DEFAULT_ACCOUNT'] } : {}),
  },
  description: 'Junction squad server (relay): API Gateway HTTP API, Lambda, DynamoDB.',
  tags: { project: 'junction' },
});
