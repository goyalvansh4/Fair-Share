import { describe, expect, it } from 'vitest';
import { MAX_RECIPIENTS, resolveRecipients } from '../src/lib/statements/recipients';

const members = [
  { role: 'admin', email: 'Owner@Example.com' },
  { role: 'member', email: 'asha@example.com' },
  { role: 'viewer', email: 'viewer@example.com' },
  { role: 'member', email: null },
];

describe('resolveRecipients', () => {
  it('sends to admins only', () => {
    expect(resolveRecipients('admins', members, [])).toEqual(['owner@example.com']);
  });
  it('sends to every member that has an email', () => {
    expect(resolveRecipients('all_members', members, [])).toEqual(['owner@example.com', 'asha@example.com', 'viewer@example.com']);
  });
  it('uses only the extra addresses in extra_only mode', () => {
    expect(resolveRecipients('extra_only', members, ['ca@firm.in'])).toEqual(['ca@firm.in']);
  });
  it('adds extras, lowercases and removes duplicates', () => {
    expect(resolveRecipients('admins', members, ['OWNER@example.com', ' friend@x.io '])).toEqual(['owner@example.com', 'friend@x.io']);
  });
  it('drops invalid addresses', () => {
    expect(resolveRecipients('extra_only', [], ['not-an-email', 'a@b', '@x.com', 'ok@x.com'])).toEqual(['ok@x.com']);
  });
  it('caps the number of recipients', () => {
    const many = Array.from({ length: MAX_RECIPIENTS + 20 }, (_, index) => `p${index}@x.com`);
    expect(resolveRecipients('extra_only', [], many)).toHaveLength(MAX_RECIPIENTS);
  });
});
