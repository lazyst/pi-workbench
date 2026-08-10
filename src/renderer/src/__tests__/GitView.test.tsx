// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { parseResources } from '../components/GitView';

describe('parseResources', () => {
  it('skips the ## branch header line', () => {
    const porcelain = '## main...origin/main [ahead 3]\n';
    expect(parseResources(porcelain)).toEqual([]);
  });

  it('parses an untracked file as untracked group', () => {
    const porcelain = '## main\n?? newfile.txt\n';
    const r = parseResources(porcelain);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ path: 'newfile.txt', group: 'untracked', badge: '?' });
  });

  it('parses a staged modification into staged group', () => {
    const porcelain = '## main\nM  staged.txt\n';
    const r = parseResources(porcelain);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ path: 'staged.txt', group: 'staged', badge: 'M' });
  });

  it('parses a working-tree modification into unstaged group', () => {
    const porcelain = '## main\n M modified.txt\n';
    const r = parseResources(porcelain);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ path: 'modified.txt', group: 'unstaged', badge: 'M' });
  });

  it('parses a staged-then-modified file into both groups (MM)', () => {
    const porcelain = '## main\nMM both.txt\n';
    const r = parseResources(porcelain);
    expect(r).toHaveLength(2);
    expect(r[0]).toMatchObject({ path: 'both.txt', group: 'staged', badge: 'M' });
    expect(r[1]).toMatchObject({ path: 'both.txt', group: 'unstaged', badge: 'M' });
  });

  it('parses a rename with arrow target', () => {
    const porcelain = '## main\nR  old.txt -> new.txt\n';
    const r = parseResources(porcelain);
    expect(r).toHaveLength(1);
    expect(r[0].path).toBe('new.txt');
    expect(r[0].renameTarget).toBe('new.txt');
  });

  it('parses a conflict (UU) into unstaged group', () => {
    const porcelain = '## main\nUU conflict.txt\n';
    const r = parseResources(porcelain);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ path: 'conflict.txt', group: 'unstaged', badge: '!' });
  });

  it('returns empty for clean repo (header only)', () => {
    const porcelain = '## main...origin/main\n';
    expect(parseResources(porcelain)).toEqual([]);
  });
});