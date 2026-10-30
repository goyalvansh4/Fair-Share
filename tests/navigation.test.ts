import { describe, expect, it } from 'vitest';
import { getSafeInternalPath } from '../src/lib/navigation';

describe('internal redirects', () => {
  it('preserves local paths, query strings, and fragments', () => {
    expect(getSafeInternalPath('/invite/abc?from=email#accept')).toBe('/invite/abc?from=email#accept');
  });

  it('rejects absolute, protocol-relative, and malformed destinations', () => {
    expect(getSafeInternalPath('https://attacker.example')).toBe('/');
    expect(getSafeInternalPath('//attacker.example')).toBe('/');
    expect(getSafeInternalPath('/\\\\attacker.example')).toBe('/');
    expect(getSafeInternalPath(null)).toBe('/');
  });
});
