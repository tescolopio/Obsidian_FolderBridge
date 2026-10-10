import { describe, it, expect } from 'vitest';
import { RecentTexts, isMergeableText, mergeText } from '../src/textMerge';

describe('mergeText', () => {
    it('combines changes to different lines', () => {
        expect(mergeText('a\nb\nc', 'a\nb\nc (mine)', 'a (theirs)\nb\nc')).toEqual({ clean: true, merged: 'a (theirs)\nb\nc (mine)' });
    });

    it('refuses when both changed the same line differently', () => {
        expect(mergeText('a\nb\nc', 'a\nb (mine)\nc', 'a\nb (theirs)\nc').clean).toBe(false);
    });

    it('accepts the same change made on both sides', () => {
        expect(mergeText('a\nb', 'a\nb2', 'a\nb2')).toEqual({ clean: true, merged: 'a\nb2' });
    });
});

describe('isMergeableText', () => {
    it('merges plain-text note types only', () => {
        expect(isMergeableText('Notes/Plan.md')).toBe(true);
        expect(isMergeableText('Board.canvas')).toBe(true);
        expect(isMergeableText('chart.png')).toBe(false);
        expect(isMergeableText('Report.pdf')).toBe(false);
    });
});

describe('RecentTexts', () => {
    it('evicts the least recently used entry but keeps pinned ones', () => {
        const pinned = new Set(['open.md']);
        const recent = new RecentTexts(p => pinned.has(p), 2);
        recent.set('open.md', 'o', 1);
        recent.set('a.md', 'a', 2);
        recent.set('b.md', 'b', 3);
        expect(recent.get('open.md')).toEqual({ text: 'o', mtime: 1 });
        expect(recent.get('a.md')).toBeUndefined();
        expect(recent.get('b.md')).toEqual({ text: 'b', mtime: 3 });
    });

    it('does not keep very large texts', () => {
        const recent = new RecentTexts(() => false, 10, 40);
        recent.set('big.md', 'x'.repeat(11), 1);
        expect(recent.get('big.md')).toBeUndefined();
    });
});
