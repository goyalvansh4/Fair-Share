import { describe, expect, it } from 'vitest';
import { formatInviteCode, formatSecretCode, isValidInviteCode, isValidSecretCode, normalizeInviteCode } from '../src/lib/invitations/code';

describe('invite codes', () => {
  it('cleans typed input', () => {
    expect(normalizeInviteCode(' a1b2-c3d4 e5f6 ')).toBe('A1B2C3D4E5F6');
  });
  it('accepts exactly 12 hex characters in any grouping', () => {
    expect(isValidInviteCode('A1B2-C3D4-E5F6')).toBe(true);
    expect(isValidInviteCode('a1b2c3d4e5f6')).toBe(true);
    expect(isValidInviteCode('A1B2-C3D4-E5F')).toBe(false);
    expect(isValidInviteCode('A1B2-C3D4-E5FG')).toBe(false);
    expect(isValidInviteCode('')).toBe(false);
  });
  it('groups the code as it is typed and caps the length', () => {
    expect(formatInviteCode('a1b2c')).toBe('A1B2-C');
    expect(formatInviteCode('a1b2c3d4e5f6ffff')).toBe('A1B2-C3D4-E5F6');
    expect(formatInviteCode('')).toBe('');
  });
});

describe('secret codes', () => {
  it('accepts 8 to 32 letters or digits in any grouping', () => {
    expect(isValidSecretCode('9F3A1-C07BD')).toBe(true);
    expect(isValidSecretCode('my-Secret-2026')).toBe(true);
    expect(isValidSecretCode('short7')).toBe(false);
    expect(isValidSecretCode('x'.repeat(33))).toBe(false);
    expect(isValidSecretCode('')).toBe(false);
  });
  it('groups generated secrets and keeps custom ones as typed', () => {
    expect(formatSecretCode('9f3a1c07bd')).toBe('9F3A1-C07BD');
    expect(formatSecretCode('my-secret-2026')).toBe('MYSECRET2026');
    expect(formatSecretCode('9f3a1c0')).toBe('9F3A1C0');
  });
});
