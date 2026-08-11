// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { parseResources, buildFileTree } from '../components/GitView';

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

  it('decodes C-quoted octal paths (Chinese filenames)', () => {
    // without -c core.quotepath=false, git octal-escapes non-ASCII paths
    const porcelain = '## main\n?? "\\346\\265\\213\\350\\257\\225\\346\\226\\207\\344\\273\\266.txt"\n';
    const r = parseResources(porcelain);
    expect(r).toHaveLength(1);
    expect(r[0].path).toBe('测试文件.txt');
    expect(r[0].group).toBe('untracked');
  });

  it('passes through raw UTF-8 paths when quotepath=false', () => {
    const porcelain = '## main\nM  测试文件.txt\n';
    const r = parseResources(porcelain);
    expect(r).toHaveLength(1);
    expect(r[0].path).toBe('测试文件.txt');
    expect(r[0].group).toBe('staged');
  });

  it('does not create empty filename nodes for untracked directory entries', () => {
    // 未跟踪目录在 porcelain 中带末尾斜杠：?? 目录/
    const porcelain = '## main\n?? 桌面运维工程师课程笔记/\n?? 桌面运维工程师课程笔记/第一章.md\n';
    const r = parseResources(porcelain);
    // 目录条目 + 文件条目
    expect(r).toHaveLength(2);
    // 目录条目应保留，且不以空文件名解析
    expect(r[0].path).toBe('桌面运维工程师课程笔记/');
    expect(r[1].path).toBe('桌面运维工程师课程笔记/第一章.md');
  });

  it('buildFileTree creates directory node for directory entries without empty child', () => {
    // 纯目录条目（无内部文件，git collapsed）：buildFileTree 应创建目录节点，不产生空文件子节点
    const resources = [
      { path: '桌面运维工程师课程笔记/', group: 'untracked' as const, badge: '?' },
    ];
    const tree = buildFileTree(resources as any);
    expect(tree).toHaveLength(1);
    expect(tree[0].name).toBe('桌面运维工程师课程笔记');
    expect(tree[0].isDir).toBe(true);
    expect(tree[0].children).toHaveLength(0);
  });

  it('buildFileTree merges directory entry with file entries correctly', () => {
    const resources = [
      { path: '桌面运维工程师课程笔记/', group: 'untracked' as const, badge: '?' },
      { path: '桌面运维工程师课程笔记/第一章.md', group: 'untracked' as const, badge: '?' },
      { path: '桌面运维工程师课程笔记/第二章.md', group: 'untracked' as const, badge: '?' },
    ];
    const tree = buildFileTree(resources as any);
    expect(tree).toHaveLength(1);
    expect(tree[0].name).toBe('桌面运维工程师课程笔记');
    expect(tree[0].isDir).toBe(true);
    expect(tree[0].children).toHaveLength(2);
    const names = tree[0].children!.map((c) => c.name).sort();
    expect(names).toEqual(['第一章.md', '第二章.md']);
  });
});