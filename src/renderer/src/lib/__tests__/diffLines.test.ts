import { describe, it, expect } from 'vitest';
import { parseDiffLineChanges, extractHunkCompressed } from '../diffLines';

describe('parseDiffLineChanges', () => {
  it('returns empty array for empty diff', () => {
    expect(parseDiffLineChanges('')).toEqual([]);
  });

  it('parses a simple added line', () => {
    const diff = `--- a/test.ts
+++ b/test.ts
@@ -1,3 +1,4 @@
 line1
+new line
 line2
 line3
`;
    const hunks = parseDiffLineChanges(diff);
    expect(hunks).toHaveLength(1);
    expect(hunks[0].ranges).toEqual([{ startLine: 2, count: 1, type: 'added' }]);
  });

  it('parses a simple removed line', () => {
    const diff = `--- a/test.ts
+++ b/test.ts
@@ -1,3 +1,2 @@
 line1
-old line
 line3
`;
    const hunks = parseDiffLineChanges(diff);
    expect(hunks).toHaveLength(1);
    expect(hunks[0].ranges).toHaveLength(1);
    expect(hunks[0].ranges[0]).toMatchObject({ type: 'removed' });
  });

  it('parses replaced line (removed + added)', () => {
    const diff = `--- a/test.ts
+++ b/test.ts
@@ -1,3 +1,3 @@
 line1
-old
+new
 line3
`;
    const hunks = parseDiffLineChanges(diff);
    expect(hunks).toHaveLength(1);
    expect(hunks[0].ranges).toHaveLength(2); // removed + added
    expect(hunks[0].ranges[0]).toMatchObject({ type: 'removed' });
    expect(hunks[0].ranges[1]).toMatchObject({ startLine: 2, count: 1, type: 'added' });
  });

  it('parses multi-line addition', () => {
    const diff = `--- a/test.ts
+++ b/test.ts
@@ -1,1 +1,4 @@
 start
+one
+two
+three
`;
    const hunks = parseDiffLineChanges(diff);
    expect(hunks).toHaveLength(1);
    expect(hunks[0].ranges).toHaveLength(3);
    expect(hunks[0].ranges[0]).toMatchObject({ startLine: 2, count: 1, type: 'added' });
    expect(hunks[0].ranges[1]).toMatchObject({ startLine: 3, count: 1, type: 'added' });
    expect(hunks[0].ranges[2]).toMatchObject({ startLine: 4, count: 1, type: 'added' });
  });
});

describe('extractHunkCompressed', () => {
  it('extracts context + added + removed lines', () => {
    const diff = `--- a/test.ts
+++ b/test.ts
@@ -1,4 +1,5 @@
 line1
-old
+new
+extra
 line4
`;
    const hunks = extractHunkCompressed(diff);
    expect(hunks).toHaveLength(1);
    expect(hunks[0].lines).toHaveLength(5);
    expect(hunks[0].lines[0]).toMatchObject({ type: 'ctx', text: 'line1' });
    expect(hunks[0].lines[1]).toMatchObject({ type: 'del', text: 'old' });
    expect(hunks[0].lines[2]).toMatchObject({ type: 'add', text: 'new' });
    expect(hunks[0].lines[3]).toMatchObject({ type: 'add', text: 'extra' });
    expect(hunks[0].lines[4]).toMatchObject({ type: 'ctx', text: 'line4' });
  });
});