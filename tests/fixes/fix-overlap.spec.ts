import { describe, it, expect } from 'vitest';
import { detectOverlap, buildCombinedPatch } from '../../src/modules/fix/lib/overlap';
import { generateDeterministicPatch } from '../../src/modules/fix/lib/diff';

describe('Stage 9: Conflict Detection and Combined Patch', () => {
    const baseContents = {
        'index.js': 'line 1\nline 2\nline 3\nline 4\nline 5\nline 6\nline 7\nline 8\n',
        'app.js': 'a\nb\nc\nd\n'
    };

    it('determines different files as NON_OVERLAPPING', () => {
        const fixA = { id: 'A', edits: [{ path: 'index.js', find: 'line 1\n', replace: 'L1\n' }] };
        const fixB = { id: 'B', edits: [{ path: 'app.js', find: 'a\n', replace: 'A\n' }] };
        
        expect(detectOverlap(fixA, fixB, baseContents).status).toBe('NON_OVERLAPPING');
    });

    it('determines separated ranges in same file as NON_OVERLAPPING', () => {
        const fixA = { id: 'A', edits: [{ path: 'index.js', find: 'line 1\n', replace: 'L1\n' }] };
        const fixB = { id: 'B', edits: [{ path: 'index.js', find: 'line 8\n', replace: 'L8\n' }] };
        
        expect(detectOverlap(fixA, fixB, baseContents).status).toBe('NON_OVERLAPPING');
    });

    it('determines overlapping ranges as CONFLICTING', () => {
        const fixA = { id: 'A', edits: [{ path: 'index.js', find: 'line 2\nline 3\n', replace: 'L2\nL3\n' }] };
        const fixB = { id: 'B', edits: [{ path: 'index.js', find: 'line 3\nline 4\n', replace: 'L3\nL4\n' }] };
        
        expect(detectOverlap(fixA, fixB, baseContents).status).toBe('CONFLICTING');
    });

    it('determines adjacent/ambiguous ranges as CONFLICTING (conservative)', () => {
        const fixA = { id: 'A', edits: [{ path: 'index.js', find: 'line 2\n', replace: 'L2\n' }] };
        const fixB = { id: 'B', edits: [{ path: 'index.js', find: 'line 3\n', replace: 'L3\n' }] };
        
        // adjacent ranges are conflicting in our logic
        expect(detectOverlap(fixA, fixB, baseContents).status).toBe('CONFLICTING');
    });

    it('determines multiple exact matches as CONFLICTING/AMBIGUOUS', () => {
        const dupBaseContents = { 'index.js': 'same\nsame\n' };
        const fixA = { id: 'A', edits: [{ path: 'index.js', find: 'same\n', replace: 'diff\n' }] };
        const fixB = { id: 'B', edits: [{ path: 'index.js', find: 'other\n', replace: 'diff\n' }] };
        
        expect(detectOverlap(fixA, fixB, dupBaseContents).status).toBe('UNKNOWN'); // missing other in base
        
        const fixC = { id: 'C', edits: [{ path: 'index.js', find: 'same\n', replace: 'changed\n' }] };
        expect(detectOverlap(fixA, fixC, dupBaseContents).status).toBe('CONFLICTING'); 
    });

    it('builds combined patch for non-conflicting fixes', () => {
        const fixA = { id: 'fixA', validatedHeadSha: 'sha123', edits: [{ path: 'index.js', find: 'line 1\n', replace: 'L1\n' }] };
        const fixB = { id: 'fixB', validatedHeadSha: 'sha123', edits: [{ path: 'index.js', find: 'line 7\nline 8\n', replace: 'L78\n' }] };
        
        const combined = buildCombinedPatch([fixA, fixB], baseContents);
        expect(combined.includedFixIds).toEqual(['fixA', 'fixB'].sort());
        expect(combined.edits).toHaveLength(2);

        const patchStats = generateDeterministicPatch(combined as any, baseContents);
        expect(patchStats.unifiedDiff).toContain('-line 1\n+L1\n');
        expect(patchStats.unifiedDiff).toContain('-line 7\n-line 8\n+L78\n');
    });
});
