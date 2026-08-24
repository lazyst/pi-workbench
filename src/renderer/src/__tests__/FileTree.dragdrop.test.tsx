// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import * as nodePath from 'node:path';
import { FileTree, PI_FILE_DRAG_MIME } from '../components/FileTree';

// 复刻 FileTree.management 的最小 pi mock：根目录含目录 src 与文件 README.md。
function makePi() {
  const files = [
    { name: 'src', isDir: true, size: 0, mtime: 0 },
    { name: 'README.md', isDir: false, size: 10, mtime: 0 },
  ];
  const api = {
    fsListDir: vi.fn(async (_root: string, dirPath: string) => {
      if (dirPath === '') return files.map((f) => ({ ...f }));
      if (dirPath === 'src') return [{ name: 'index.ts', isDir: false, size: 5, mtime: 0 }];
      return [];
    }),
    fsListNames: vi.fn(async (_root: string, dirPath: string) => {
      if (dirPath === 'src') return ['index.ts'];
      return files.map((f) => f.name);
    }),
    fsUniqueName: vi.fn(async (base: string) => base),
    fsRename: vi.fn(async () => {}),
    fsCreateFile: vi.fn(async () => {}),
    fsMkdir: vi.fn(async () => {}),
    gitStatus: vi.fn(async () => ({
      isGit: true, branch: 'main', dirty: false, ahead: 0, behind: 0, porcelain: '## main',
    })),
    gitLog: vi.fn(async () => []),
    gitDiff: vi.fn(async () => ''),
    gitFileStatusMap: vi.fn(async () => ({})),
    gitIgnoredPaths: vi.fn(async () => []),
    gitWatch: vi.fn(() => vi.fn()),
    fsWatch: vi.fn(() => vi.fn()),
  } as any;
  return api;
}

describe('FileTree 拖拽移动（drop 读 dataTransfer 而非 selection）', () => {
  let api: ReturnType<typeof makePi>;
  beforeEach(() => {
    api = makePi();
    (window as any).pi = api;
  });

  it('选中目录 src 后拖 README.md 到 src 上 → 应移动 README.md 而非把 src 移到自身下', async () => {
    const root = 'C:\\work';
    render(<FileTree root={root} onOpenFile={vi.fn()} />);

    // 根层可见 src 目录与 README.md 文件
    await screen.findByText('src');
    await screen.findByText('README.md');

    // 1) 点击选中目录 src —— 此为 bug 触发条件：selection = { 'src' }
    fireEvent.click(screen.getByText('src').closest('.file-row') as HTMLElement);

    // 2) 模拟从 README.md 拖起后落到 src 上：
    //    dragstart 写入 dataTransfer 的 PI_FILE_DRAG_MIME 承载【绝对路径】JSON 数组。
    const absReadme = nodePath.resolve(root, 'README.md');
    const dt = {
      getData: (mime: string) =>
        mime === PI_FILE_DRAG_MIME ? JSON.stringify([absReadme]) : '',
    };
    fireEvent.drop(screen.getByText('src').closest('.file-row') as HTMLElement, {
      dataTransfer: dt,
    });

    // 3) 断言移动的是 README.md → src/README.md
    await waitFor(() => {
      expect(api.fsRename).toHaveBeenCalledWith(root, 'README.md', 'src/README.md');
    });
    // 不应出现把 src 自身当作移动目标的错误调用（旧 bug：moving 取自 selection={src}）
    expect(api.fsRename.mock.calls.filter((c: any[]) => c[1] === 'src')).toHaveLength(0);
  });

  it('未选中任何项时直接拖 README.md 到 src 上 → 同样应移动 README.md', async () => {
    const root = 'C:\\work';
    render(<FileTree root={root} onOpenFile={vi.fn()} />);

    await screen.findByText('src');

    // selection 为空（未点击任何项），直接 drop
    const absReadme = nodePath.resolve(root, 'README.md');
    const dt = {
      getData: (mime: string) =>
        mime === PI_FILE_DRAG_MIME ? JSON.stringify([absReadme]) : '',
    };
    fireEvent.drop(screen.getByText('src').closest('.file-row') as HTMLElement, {
      dataTransfer: dt,
    });

    await waitFor(() => {
      expect(api.fsRename).toHaveBeenCalledWith(root, 'README.md', 'src/README.md');
    });
  });
});
