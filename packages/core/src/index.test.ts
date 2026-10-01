import { describe, expect, it } from 'vitest';
import { packageName } from './index';

describe('core scaffold', () => {
  it('exports its package name', () => {
    expect(packageName).toBe('@junction/core');
  });
});
