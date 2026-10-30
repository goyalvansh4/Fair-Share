import { describe, expect, it } from 'vitest';
import { parseSender } from '../src/lib/statements/mailer';

describe('parseSender', () => {
  it('splits a display name from the address', () => {
    expect(parseSender('FairShare <me@example.com>')).toEqual({ name: 'FairShare', email: 'me@example.com' });
    expect(parseSender('"Fair Share" <me@example.com>')).toEqual({ name: 'Fair Share', email: 'me@example.com' });
  });
  it('keeps a plain address as it is', () => {
    expect(parseSender('me@example.com')).toEqual({ email: 'me@example.com' });
    expect(parseSender('  me@example.com ')).toEqual({ email: 'me@example.com' });
  });
  it('handles an address in angle brackets without a name', () => {
    expect(parseSender('<me@example.com>')).toEqual({ email: 'me@example.com' });
  });
});
