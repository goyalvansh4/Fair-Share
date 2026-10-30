import { describe, expect, it } from 'vitest';
import { createInvitationToken, hashInvitationToken } from '../src/lib/invitations/token';

describe('organization invitation tokens', () => {
  it('creates high-entropy URL-safe tokens without exposing their stored hashes', async () => {
    const first = createInvitationToken();
    const second = createInvitationToken();
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(second).toMatch(/^[0-9a-f]{64}$/);
    expect(first).not.toBe(second);
    expect(await hashInvitationToken(first)).toMatch(/^[0-9a-f]{64}$/);
    expect(await hashInvitationToken(first)).not.toBe(first);
  });

  it('hashes invitation tokens deterministically with SHA-256', async () => {
    await expect(hashInvitationToken('hello')).resolves.toBe(
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    );
  });
});
