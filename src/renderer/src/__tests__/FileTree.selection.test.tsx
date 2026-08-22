// @vitest-environment jsdom
// 文件树选择行为测试：单击高亮保持、Ctrl 多选、Shift 范围选择（对齐 VS Code Explorer）。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { FileTree } from '../components/FileTree';

// 树结构（与 FileTree.management.test.tsx 一致）：
//   src (dir)
//     index.ts (file)
//     components (dir)
//       App.tsx (file)
//   README.md (file)
function makePi() {
  const api = {
    fsListDir: vi.fn(async (_root: string, dirPath: string) => {
      if (dirPath === '') return [
        { name: 'src', isDir: true, size: 0, mtime: 0 },
        { name: 'README.md', isDir: false, size: 10, mtime: 0 },
      ];
      if (dirPath === 'src') return [
        { name: 'index.ts', isDir: false, size: 5, mtime: 0 },
        { name: 'components', isDir: true, size: 0, mtime: 0 },
      ];
      if (dirPath === 'src/components') return [
        { name: 'App.tsx', isDir: false, size: 10, mtime: 0 },
      ];
      return [];
    }),
    fsListNames: vi.fn(async () => ['src', 'README.md']),
    fsUniqueName: vi.fn(async (base: string) => base),
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

describe('FileTree 单击高亮保持（VS Code 语义）', () => {
  let api: ReturnType<typeof makePi>;
  beforeEach(() => {
    api = makePi();
    (window as any).pi = api;
  });

  it('点击文件 → 该行 selected + onOpenFile 被调用', async () => {
    const onOpenFile = vi.fn();
    render(<FileTree root={'C:\\work'} onOpenFile={onOpenFile} />);
    await screen.findByText('README.md');

    const row = rowOf('README.md');
    fireEvent.click(row);

    expect(row).toHaveClass('selected');
    expect(onOpenFile).toHaveBeenCalledWith('README.md', 'README.md', 'C:\\work');
  });

  it('依次点击两个文件 → 高亮转移到最后点击的文件', async () => {
    render(<FileTree root={'C:\\work'} onOpenFile={vi.fn()} />);
    await screen.findByText('README.md');

    const readmeRow = rowOf('README.md');
    fireEvent.click(readmeRow);
    expect(readmeRow).toHaveClass('selected');

    // 点击另一个目录项：旧高亮清除，新高亮生效
    const srcRow = rowOf('src');
    fireEvent.click(srcRow);
    expect(srcRow).toHaveClass('selected');
    expect(readmeRow).not.toHaveClass('selected');
  });

  it('点击目录 → 该行 selected 且展开子项', async () => {
    render(<FileTree root={'C:\\work'} onOpenFile={vi.fn()} />);
    await screen.findByText('src');

    const srcRow = rowOf('src');
    fireEvent.click(srcRow);

    expect(srcRow).toHaveClass('selected');
    await waitFor(() => expect(screen.getByText('index.ts')).toBeInTheDocument());
  });

  it('点击文件树空白处 → 清空全部高亮', async () => {
    render(<FileTree root={'C:\\work'} onOpenFile={vi.fn()} />);
    await screen.findByText('README.md');

    const readmeRow = rowOf('README.md');
    fireEvent.click(readmeRow);
    expect(readmeRow).toHaveClass('selected');

    // 点击容器空白（file-tree 自身 onClick）
    const tree = readmeRow.closest('.file-tree') as HTMLElement;
    fireEvent.click(tree);
    expect(readmeRow).not.toHaveClass('selected');
  });
});

describe('FileTree Ctrl 多选', () => {
  let api: ReturnType<typeof makePi>;
  beforeEach(() => {
    api = makePi();
    (window as any).pi = api;
  });

  it('Ctrl+点击 → 切换选中且不打开文件', async () => {
    const onOpenFile = vi.fn();
    render(<FileTree root={'C:\\work'} onOpenFile={onOpenFile} />);
    await screen.findByText('README.md');

    const readmeRow = rowOf('README.md');
    const srcRow = rowOf('src');

    // 先普通选中 src，再 Ctrl+点击 README.md → 两者都选中
    fireEvent.click(srcRow);
    fireEvent.click(readmeRow, { ctrlKey: true });

    expect(srcRow).toHaveClass('selected');
    expect(readmeRow).toHaveClass('selected');
    expect(onOpenFile).not.toHaveBeenCalled();

    // 再 Ctrl+点击已选中的 README.md → 取消选中，src 保持
    fireEvent.click(readmeRow, { ctrlKey: true });
    expect(srcRow).toHaveClass('selected');
    expect(readmeRow).not.toHaveClass('selected');
  });
});

describe('FileTree Shift 范围选择', () => {
  let api: ReturnType<typeof makePi>;
  beforeEach(() => {
    api = makePi();
    (window as any).pi = api;
  });

  it('普通点击锚点后 Shift+点击另一项 → 区间内全部选中', async () => {
    const onOpenFile = vi.fn();
    render(<FileTree root={'C:\\work'} onOpenFile={onOpenFile} />);
    await screen.findByText('README.md');

    // 根层可见顺序：[src, README.md]
    const srcRow = rowOf('src');
    const readmeRow = rowOf('README.md');

    // 锚点：普通点击 src
    fireEvent.click(srcRow);
    expect(srcRow).toHaveClass('selected');

    // Shift+点击 README.md → 范围 [src, README.md] 全部选中
    fireEvent.click(readmeRow, { shiftKey: true });
    expect(srcRow).toHaveClass('selected');
    expect(readmeRow).toHaveClass('selected');
    // Shift 范围选择不打开文件
    expect(onOpenFile).not.toHaveBeenCalled();
  });

  it('展开目录后 Shift+点击跨层级范围选择', async () => {
    render(<FileTree root={'C:\\work'} onOpenFile={vi.fn()} />);
    await screen.findByText('README.md');

    // 展开 src → 可见顺序：[src, index.ts, components, README.md]
    // 第一次点击 src 时已将其设为锚点（selection={src}），无需重复点击
    const srcRow = rowOf('src');
    fireEvent.click(srcRow);
    await waitFor(() => expect(screen.getByText('index.ts')).toBeInTheDocument());

    // Shift+点击 README.md → 从锚点 src 到 README.md 的可见行全部选中
    const readmeRow = rowOf('README.md');
    fireEvent.click(readmeRow, { shiftKey: true });

    expect(srcRow).toHaveClass('selected');
    expect(rowOf('index.ts')).toHaveClass('selected');
    expect(rowOf('components')).toHaveClass('selected');
    expect(readmeRow).toHaveClass('selected');
  });

  it('反向 Shift 范围选择（先点下面的，再 Shift 点上面的）', async () => {
    render(<FileTree root={'C:\\work'} onOpenFile={vi.fn()} />);
    await screen.findByText('README.md');

    const srcRow = rowOf('src');
    const readmeRow = rowOf('README.md');

    // 锚点：普通点击 README.md（行序靠后）
    fireEvent.click(readmeRow);

    // Shift+点击 src（行序靠前）→ 反向区间仍全部选中
    fireEvent.click(srcRow, { shiftKey: true });
    expect(srcRow).toHaveClass('selected');
    expect(readmeRow).toHaveClass('selected');
  });
});
