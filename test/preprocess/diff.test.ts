import { describe, expect, it } from 'vitest';
import { changedNewLines, countChanges, parsePatch, sideLines } from '../../src/preprocess/diff';

describe('PRE-04 unified diff parsing', () => {
  it('PRE-04 parses hunk ranges, defaulting omitted counts to 1', () => {
    const p = parsePatch('@@ -3 +3,2 @@ fn()\n-a\n+b\n+c');
    expect(p.hunks).toEqual([
      {
        header: '@@ -3 +3,2 @@ fn()',
        oldStart: 3,
        oldLines: 1,
        newStart: 3,
        newLines: 2,
        text: '-a\n+b\n+c',
      },
    ]);
  });

  it('PRE-04 parses added-only and deleted-only files', () => {
    expect(parsePatch('@@ -0,0 +1,2 @@\n+a\n+b').hunks[0]).toMatchObject({
      oldStart: 0,
      oldLines: 0,
      newLines: 2,
    });
    expect(parsePatch('@@ -1,2 +0,0 @@\n-a\n-b').hunks[0]).toMatchObject({
      newStart: 0,
      newLines: 0,
      oldLines: 2,
    });
  });

  it('PRE-04 keeps the no-newline marker in the text', () => {
    const p = parsePatch('@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+b\n\\ No newline at end of file\n');
    expect(p.hunks[0]?.text.split('\n')).toHaveLength(4);
    expect(countChanges(p.hunks[0] as never)).toEqual({ additions: 1, deletions: 1 });
  });

  it('PRE-04 normalizes CRLF and restores stripped context spaces', () => {
    const p = parsePatch('@@ -1,3 +1,3 @@\r\n a\r\n\r\n-b\r\n+c\r\n');
    expect(p.hunks[0]?.text).toBe(' a\n \n-b\n+c');
  });

  it('PRE-04 reads git headers: rename, new/deleted file, binary', () => {
    const p = parsePatch(
      [
        'diff --git a/x b/y',
        'similarity index 80%',
        'rename from x',
        'rename to y',
        '--- a/x',
        '+++ b/y',
        '@@ -1 +1 @@',
        '-a',
        '+b',
      ].join('\n'),
    );
    expect(p).toMatchObject({ renameFrom: 'x', renameTo: 'y', newFile: false, binary: false });
    expect(p.hunks).toHaveLength(1);
    expect(parsePatch('new file mode 100644').newFile).toBe(true);
    expect(parsePatch('deleted file mode 100644').deletedFile).toBe(true);
    expect(parsePatch('Binary files a/x.png and b/x.png differ').binary).toBe(true);
    expect(parsePatch('GIT binary patch').binary).toBe(true);
  });

  it('PRE-04 a second diff --git header ends the current hunk', () => {
    const p = parsePatch('@@ -1 +1 @@\n-a\n+b\ndiff --git a/z b/z\n--- a/z\n+++ b/z\n@@ -5 +5 @@\n-c\n+d');
    expect(p.hunks.map((h) => h.text)).toEqual(['-a\n+b', '-c\n+d']);
  });

  it('PRE-04 treats unprefixed lines inside a hunk as context', () => {
    expect(parsePatch('@@ -1,2 +1,2 @@\nplain\n-a\n+b').hunks[0]?.text).toBe(' plain\n-a\n+b');
  });

  it('PRE-04 maps changed lines to the new side, anchoring deletions', () => {
    const [h] = parsePatch('@@ -10,5 +10,4 @@\n a\n-b\n-c\n+B\n d\n-e\n f').hunks;
    expect(changedNewLines(h as never)).toEqual([11, 13]);
    const [del] = parsePatch('@@ -1,2 +0,0 @@\n-a\n-b').hunks;
    expect(changedNewLines(del as never)).toEqual([1]);
  });

  it('PRE-04 sideLines reconstructs either side without prefixes', () => {
    const [h] = parsePatch('@@ -1,2 +1,2 @@\n a\n-b\n+c\n\\ No newline at end of file').hunks;
    expect(sideLines(h as never, 'new')).toEqual(['a', 'c']);
    expect(sideLines(h as never, 'old')).toEqual(['a', 'b']);
  });
});
