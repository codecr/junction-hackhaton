import type { JunctionRelayStackProps } from './relay-stack';

// Reads CDK context (cdk.json or `-c key=value`) into stack props.
// relayDomain + hostedZoneId + hostedZoneName -> custom domain with ACM cert and Route 53 alias.
// Without a hosted zone id and name, no domain resources are created.

export type ContextReader = (key: string) => unknown;

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

export function relayStackPropsFromContext(get: ContextReader): JunctionRelayStackProps {
  const alertEmail = str(get('alertEmail'));
  if (!alertEmail)
    throw new Error('Set the alertEmail context value (cdk.json or -c alertEmail=...).');

  const domainName = str(get('relayDomain'));
  const hostedZoneId = str(get('hostedZoneId'));
  const hostedZoneName = str(get('hostedZoneName'));

  const reservedRaw = get('reservedConcurrency');
  const reservedConcurrency = reservedRaw === undefined ? 20 : Number(reservedRaw);
  if (!Number.isInteger(reservedConcurrency) || reservedConcurrency < 0) {
    throw new Error('reservedConcurrency must be a whole number, 0 to leave it unreserved.');
  }

  return {
    alertEmail,
    reservedConcurrency,
    ...(domainName && hostedZoneId && hostedZoneName
      ? { domain: { domainName, hostedZoneId, hostedZoneName } }
      : {}),
  };
}
