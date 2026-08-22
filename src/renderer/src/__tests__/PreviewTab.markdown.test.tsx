// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { PreviewTab } from '../components/PreviewTab';

// 用可控桩替换 Monaco / 富文本编辑器，聚焦「三模式切换」行为（不驱动真实编辑器）。
vi.mock('../components/editor/MonacoCodeEditor', () => ({
  MonacoCodeEditor: ({ content }: any) => <div data-testid="monaco-source">{content}</div>,
  disposePreviewModel: vi.fn(),
}));
vi.mock('../components/RichMarkdownEditor', () => ({
  RichMarkdownEditor: () => <div data-testid="rich-editor" />,
}));

const ROOT = 'C:/work';

function makePi(content = '# 标题\n正文段落 [内部](./x.md)。') {
  return {
    fsReadFile: vi.fn().mockResolvedValue({
      content,
      language: 'markdown', // 关键：触发 markdown 渲染分支
      isImage: false,
      isBinary: false,
    }),
    fsWriteFile: vi.fn().mockResolvedValue(undefined),
    fsOpenWithSystem: vi.fn().mockResolvedValue(true),
    fsWatchFile: vi.fn().mockReturnValue(() => {}),
  };
}

describe('PreviewTab markdown 三模式切换', () => {
  beforeEach(() => {
    (window as any).pi = makePi();
  });

  it('打开 .md 默认进入渲染预览（非原始源码），并提供 预览/源码/富文本 切换', async () => {
    render(
      <PreviewTab
        tabId="p1"
        root={ROOT}
        path="docs/readme.md"
        active
        onClose={vi.fn()}
        onRegisterCloseGuard={vi.fn()}
      />,
    );
    // 默认渲染为 H1（而非把 "# 标题" 当源码显示）
    await waitFor(() => expect(document.querySelector('h1')?.textContent).toBe('标题'));
    expect(screen.queryByTestId('monaco-source')).toBeNull();
    // 三模式切换按钮存在
    expect(screen.getByText('预览')).toBeInTheDocument();
    expect(screen.getByText('源码')).toBeInTheDocument();
    expect(screen.getByText('富文本')).toBeInTheDocument();
  });

  it('切到源码 → 显示原始 markdown 文本（Monaco）', async () => {
    render(
      <PreviewTab
        tabId="p1"
        root={ROOT}
        path="docs/readme.md"
        active
        onClose={vi.fn()}
        onRegisterCloseGuard={vi.fn()}
      />,
    );
    await waitFor(() => expect(document.querySelector('h1')).toBeInTheDocument());
    fireEvent.click(screen.getByText('源码'));
    const src = await screen.findByTestId('monaco-source');
    expect(src.textContent).toContain('# 标题');
  });

  it('切到富文本 → 挂载 RichMarkdownEditor', async () => {
    render(
      <PreviewTab
        tabId="p1"
        root={ROOT}
        path="docs/readme.md"
        active
        onClose={vi.fn()}
        onRegisterCloseGuard={vi.fn()}
      />,
    );
    await waitFor(() => expect(document.querySelector('h1')).toBeInTheDocument());
    fireEvent.click(screen.getByText('富文本'));
    expect(await screen.findByTestId('rich-editor')).toBeInTheDocument();
  });
});
