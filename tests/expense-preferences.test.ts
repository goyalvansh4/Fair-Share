import { describe, expect, it } from 'vitest';
import { parsePreferences, preferencesKey, resolvePreferences } from '../src/lib/expenses/preferences';

const categories = ['food', 'rent', 'travel'];

describe('parsePreferences', () => {
  it('returns null for missing, corrupt or non-object data', () => {
    expect(parsePreferences(null)).toBeNull();
    expect(parsePreferences('')).toBeNull();
    expect(parsePreferences('{not json')).toBeNull();
    expect(parsePreferences('42')).toBeNull();
    expect(parsePreferences('null')).toBeNull();
  });
  it('ignores wrongly typed fields instead of trusting them', () => {
    const result = parsePreferences(JSON.stringify({ payerId: 5, participantIds: ['a', 7, null], category: {}, splitMode: 'weird' }));
    expect(result).toEqual({ payerId: '', participantIds: ['a'], category: 'food', splitMode: 'equal' });
  });
  it('keys preferences per space', () => {
    expect(preferencesKey('goa')).not.toBe(preferencesKey('flat'));
  });
});

describe('resolvePreferences', () => {
  it('defaults to everyone, the current user as payer and food', () => {
    expect(resolvePreferences(null, ['a', 'b', 'c'], 'b', categories)).toEqual({ payerId: 'b', participantIds: ['a', 'b', 'c'], category: 'food', splitMode: 'equal' });
  });
  it('restores remembered choices for members who are still active', () => {
    const stored = { payerId: 'c', participantIds: ['a', 'c'], category: 'travel', splitMode: 'shares' as const };
    expect(resolvePreferences(stored, ['a', 'b', 'c'], 'a', categories)).toEqual(stored);
  });
  it('drops people who left and falls back to everyone when nobody remains', () => {
    const stored = { payerId: 'gone', participantIds: ['gone', 'a'], category: 'rent', splitMode: 'exact' as const };
    expect(resolvePreferences(stored, ['a', 'b'], 'b', categories).participantIds).toEqual(['a']);
    expect(resolvePreferences(stored, ['a', 'b'], 'b', categories).payerId).toBe('b');
    expect(resolvePreferences({ ...stored, participantIds: ['gone'] }, ['a', 'b'], 'b', categories).participantIds).toEqual(['a', 'b']);
  });
  it('rejects unknown categories and handles a user who is not active', () => {
    const stored = { payerId: '', participantIds: [], category: 'deleted-category', splitMode: 'equal' as const };
    const result = resolvePreferences(stored, ['a', 'b'], 'zzz', categories);
    expect(result.category).toBe('food');
    expect(result.payerId).toBe('a');
  });
  it('copes with an empty member list', () => {
    expect(resolvePreferences(null, [], 'me', categories)).toEqual({ payerId: '', participantIds: [], category: 'food', splitMode: 'equal' });
  });
});
