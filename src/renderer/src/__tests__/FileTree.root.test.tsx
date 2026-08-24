// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { FileTree } from '../components/FileTree';

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
    fsListNames: vi.fn(async () => files.map((f) => f.name)),
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

describe('FileTree 根目录标题行（VS Code 风格）', () => {
  let api: ReturnType<typeof makePi>;
  beforeEach(() => {
    api = makePi();
    (window as any).pi = api;
  });

  it('显示根目录名标题行（加粗 is-root），默认展开显示子项', async () => {
    // root='C:\work' → basename='work'
    render(<FileTree root={'C:\\work'} onOpenFile={vi.fn()} />);

    const rootRow = (await screen.findByText('work')).closest('.file-row') as HTMLElement;
    expect(rootRow).toHaveClass('is-root');
    // 默认展开：子项可见
    expect(await screen.findByText('src')).toBeInTheDocument();
    expect(screen.getByText('README.md')).toBeInTheDocument();
  });

  it('点击根目录行 → 折叠整个树，只剩根标题行', async () => {
    render(<FileTree root={'C:\\work'} onOpenFile={vi.fn()} />);
    await screen.findByText('src'); // 等待默认展开

    fireEvent.click(screen.getByText('work').closest('.file-row') as HTMLElement);

    await waitFor(() => {
      expect(screen.queryByText('src')).not.toBeInTheDocument();
      expect(screen.queryByText('README.md')).not.toBeInTheDocument();
    });
    // 根标题行始终可见
    expect(screen.getByText('work')).toBeInTheDocument();
  });

  it('折叠后再点击根目录行 → 子项恢复显示', async () => {
    render(<FileTree root={'C:\\work'} onOpenFile={vi.fn()} />);
    await screen.findByText('src');

    const rootRow = () => screen.getByText('work').closest('.file-row') as HTMLElement;
    fireEvent.click(rootRow()); // 折叠
    await waitFor(() => expect(screen.queryByText('src')).not.toBeInTheDocument());

    fireEvent.click(rootRow()); // 展开
    await waitFor(() => expect(screen.getByText('src')).toBeInTheDocument());
    expect(screen.getByText('README.md')).toBeInTheDocument();
  });

  it('点击根目录行不进入选中态（根行不携带 selected 类）', async () => {
    render(<FileTree root={'C:\\work'} onOpenFile={vi.fn()} />);
    await screen.findByText('src');

    const rootRow = screen.getByText('work').closest('.file-row') as HTMLElement;
    fireEvent.click(rootRow);
    // 根目录行即使被点击，也不应进入 selected 高亮
    expect(rootRow).not.toHaveClass('selected');
  });
});
