// @vitest-environment jsdom
// 文件树删除撤销测试：删除后 Ctrl/Cmd+Z 恢复文件/目录（对齐 VS Code Explorer 撤销）。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { FileTree } from '../components/FileTree';

// 树结构（与 FileTree.selection.test.tsx 一致）：
//   src (dir)
//     index.ts (file)
//     components (dir)
//       App.tsx (file)
//   README.md (file)
// 删除/恢复通过动态过滤模拟磁盘状态：fsRemove 把路径加入 deleted，fsRestore 移除。
function makePi() {
  const deleted = new Set<string>();
  const SNAP = { dirs: [], files: [{ relPath: '', data: 'dGVzdA==' }] };
  const api = {
    fsListDir: vi.fn(async (_root: string, dirPath: string) => {
      let entries: Array<{ name: string; isDir: boolean; size: number; mtime: number }> = [];
      if (dirPath === '') entries = [
        { name: 'src', isDir: true, size: 0, mtime: 0 },
        { name: 'README.md', isDir: false, size: 10, mtime: 0 },
      ];
      else if (dirPath === 'src') entries = [
        { name: 'index.ts', isDir: false, size: 5, mtime: 0 },
        { name: 'components', isDir: true, size: 0, mtime: 0 },
      ];
      else if (dirPath === 'src/components') entries = [
        { name: 'App.tsx', isDir: false, size: 10, mtime: 0 },
      ];
      return entries.filter((e) => !deleted.has(dirPath ? `${dirPath}/${e.name}` : e.name));
    }),
    fsListNames: vi.fn(async () => ['src', 'README.md']),
    fsUniqueName: vi.fn(async (base: string) => base),
    fsCreateFile: vi.fn(async () => {}),
    fsMkdir: vi.fn(async () => {}),
    fsSnapshot: vi.fn(async () => SNAP),
    fsRemove: vi.fn(async (_root: string, rel: string) => { deleted.add(rel); }),
    fsRestore: vi.fn(async (_root: string, rel: string) => { deleted.delete(rel); }),
    gitStatus: vi.fn(async () => ({ isGit: true, branch: 'main', dirty: false, ahead: 0, behind: 0, porcelain: '## main' })),
    gitLog: vi.fn(async () => []),
    gitDiff: vi.fn(async () => ''),
    gitFileStatusMap: vi.fn(async () => ({})),
    gitIgnoredPaths: vi.fn(async () => []),
    gitWatch: vi.fn(() => vi.fn()),
    fsWatch: vi.fn(() => vi.fn()),
  } as any;
  return api;
}

/** 按文件名找到所在 .file-row 行元素。 */
function rowOf(name: string): HTMLElement {
  const el = screen.getByText(name);
  const row = el.closest('.file-row') as HTMLElement;
  if (!row) throw new Error(`未找到 ${name} 所在 .file-row`);
  return row;
}

/** 右键某行并点击菜单里的「删除」（单文件 → 直接删，不弹确认）。 */
async function deleteViaMenu(name: string) {
  fireEvent.contextMenu(rowOf(name));
  fireEvent.click(await screen.findByText('删除'));
}

/** 在文件树容器上触发 Ctrl/Cmd+Z。 */
function pressUndo(meta = false) {
  const tree = document.querySelector('.file-tree') as HTMLElement;
  fireEvent.keyDown(tree, { key: 'z', ctrlKey: !meta, metaKey: meta });
}

describe('FileTree 删除撤销（Ctrl+Z）', () => {
  let api: ReturnType<typeof makePi>;
  beforeEach(() => {
    api = makePi();
    (window as any).pi = api;
  });

  it('删除单文件后 Ctrl+Z → fsRestore 恢复 + 行重新出现并高亮', async () => {
    render(<FileTree root={'C:\\work'} onOpenFile={vi.fn()} />);
    await screen.findByText('README.md');

    await deleteViaMenu('README.md');
    // 删除前先快照，再删除；删除后行消失
    await waitFor(() => expect(api.fsSnapshot).toHaveBeenCalledWith('C:\\work', 'README.md'));
    await waitFor(() => expect(screen.queryByText('README.md')).toBeNull());

    pressUndo();
    await waitFor(() => expect(api.fsRestore).toHaveBeenCalledWith('C:\\work', 'README.md', expect.objectContaining({ files: expect.any(Array) })));
    // 撤销后行重新出现并高亮选中
    const row = await waitFor(() => rowOf('README.md'));
    expect(row).toHaveClass('selected');
  });

  it('连续删除两个文件 → 两次 Ctrl+Z 按栈序（后删先恢复）', async () => {
    render(<FileTree root={'C:\\work'} onOpenFile={vi.fn()} />);
    await screen.findByText('README.md');

    await deleteViaMenu('README.md');
    await waitFor(() => expect(api.fsRemove).toHaveBeenCalledWith('C:\\work', 'README.md'));
    // 展开 src 再删除 index.ts
    fireEvent.click(rowOf('src'));
    await screen.findByText('index.ts');
    await deleteViaMenu('index.ts');
    await waitFor(() => expect(api.fsRemove).toHaveBeenCalledTimes(2));

    api.fsRestore.mockClear();
    pressUndo();
    await waitFor(() => expect(api.fsRestore).toHaveBeenCalledTimes(1));
    expect(api.fsRestore).toHaveBeenLastCalledWith('C:\\work', 'src/index.ts', expect.anything());

    api.fsRestore.mockClear();
    pressUndo();
    await waitFor(() => expect(api.fsRestore).toHaveBeenCalledTimes(1));
    expect(api.fsRestore).toHaveBeenLastCalledWith('C:\\work', 'README.md', expect.anything());
  });

  it('无删除记录时 Ctrl+Z 不调用 fsRestore', async () => {
    render(<FileTree root={'C:\\work'} onOpenFile={vi.fn()} />);
    await screen.findByText('README.md');
    pressUndo();
    expect(api.fsRestore).not.toHaveBeenCalled();
  });

  it('Mac 上 Cmd+Z 同样触发撤销删除', async () => {
    render(<FileTree root={'C:\\work'} onOpenFile={vi.fn()} />);
    await screen.findByText('README.md');
    await deleteViaMenu('README.md');
    await waitFor(() => expect(screen.queryByText('README.md')).toBeNull());

    pressUndo(true); // metaKey
    await waitFor(() => expect(api.fsRestore).toHaveBeenCalledWith('C:\\work', 'README.md', expect.anything()));
  });
});
