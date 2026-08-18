// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { PreviewTab } from '../components/PreviewTab';

// MonacoCodeEditor 桩：渲染 contenteditable 元素，验证「激活后焦点落到内容区、可直接输入」。
vi.mock('../components/editor/MonacoCodeEditor', () => ({
  MonacoCodeEditor: ({ content }: any) => (
    <div data-testid="monaco-editor" contentEditable suppressContentEditableWarning>
      {content}
    </div>
  ),
}));

function makePi(content = 'hello world', language?: string) {
  return {
    fsReadFile: vi.fn().mockResolvedValue({ content, language, isImage: false, isBinary: false }),
    fsWriteFile: vi.fn().mockResolvedValue(undefined),
    fsOpenWithSystem: vi.fn().mockResolvedValue(true),
    fsWatchFile: vi.fn().mockReturnValue(() => {}),
    openExternal: vi.fn().mockResolvedValue(true),
  };
}

describe('PreviewTab 激活聚焦（点击 tab / 从文件树打开）', () => {
  beforeEach(() => {
    (window as any).pi = makePi();
  });

  it('从文件树打开（激活已有 tab）→ 内容区获得焦点', async () => {
    const { rerender } = render(
      <PreviewTab tabId="p1" root="C:\\work" path="a.ts" active={false} onClose={vi.fn()} />,
    );
    await waitFor(() => expect(screen.getByTestId('monaco-editor')).toBeInTheDocument());
    expect(document.activeElement).not.toBe(screen.getByTestId('monaco-editor'));

    // 模拟文件树点击 → store 激活 tab（active false → true）
    rerender(<PreviewTab tabId="p1" root="C:\\work" path="a.ts" active onClose={vi.fn()} />);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('monaco-editor')));
  });

  it('文件树打开新文件：内容异步加载完成后自动聚焦', async () => {
    render(<PreviewTab tabId="p1" root="C:\\work" path="a.ts" active onClose={vi.fn()} />);
    // kind 从 loading → code（fsReadFile 完成后 Monaco 挂载）→ 聚焦
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('monaco-editor')));
  });

  it('markdown 渲染预览（纯阅读）不聚焦，保持无副作用', async () => {
    (window as any).pi = makePi('# 标题\n正文', 'markdown');
    render(<PreviewTab tabId="p1" root="C:\\work" path="doc.md" active onClose={vi.fn()} />);
    // markdown 默认进入渲染预览：无可编辑元素
    await waitFor(() => expect(document.querySelector('.markdown-file-preview')).toBeInTheDocument());
    await new Promise((r) => setTimeout(r, 300)); // 等激活聚焦 effect 的轮询窗口过去
    expect(document.activeElement).toBe(document.body);
  });
});
