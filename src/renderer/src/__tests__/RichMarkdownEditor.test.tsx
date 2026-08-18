// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { RichMarkdownEditor } from '../components/RichMarkdownEditor';

function queryImg(): HTMLImageElement | null {
  return document.querySelector('.md-rich-editor img');
}

async function waitForImg(): Promise<HTMLImageElement> {
  await waitFor(() => {
    const el = queryImg();
    if (!el) throw new Error('img not rendered yet');
  });
  return queryImg()!;
}

describe('RichMarkdownEditor 图片解析（富文本模式显示本地图片）', () => {
  it('相对路径图片的 <img> src 被解析为可加载的 pi-local URL', async () => {
    render(
      <RichMarkdownEditor
        root={'C:\\work'}
        filePath="docs/readme.md"
        content={'![示例](./images/logo.png)\n\n正文段落'}
        onChange={vi.fn()}
      />,
    );
    const img = await waitForImg();
    // 相对路径被 resolveImageSrc 解析为 pi-local://file/?path=<绝对路径>（与 MarkdownPreview 一致）
    expect(img.getAttribute('src')).toBe('pi-local://file/?path=C%3A%2Fwork%2Fdocs%2F.%2Fimages%2Flogo.png');
  });

  it('保持 https 绝对图片 src 原样', async () => {
    render(
      <RichMarkdownEditor
        root={'C:\\work'}
        filePath="readme.md"
        content={'![图一](https://example.com/a.png)\n\n![图二](https://example.com/b.png)'}
        onChange={vi.fn()}
      />,
    );
    await waitFor(() => {
      const imgs = document.querySelectorAll('.md-rich-editor img');
      if (imgs.length < 2) throw new Error('imgs not rendered yet');
    });
    const srcs = Array.from(document.querySelectorAll('.md-rich-editor img')).map((i) => i.getAttribute('src'));
    expect(srcs).toContain('https://example.com/a.png');
    expect(srcs).toContain('https://example.com/b.png');
  });

  it('filePath 变化（编辑器重建）后用新的基准目录解析图片', async () => {
    const { rerender } = render(
      <RichMarkdownEditor root={'C:\\work'} filePath="docs/a.md" content={'![x](./img.png)'} onChange={vi.fn()} />,
    );
    expect((await waitForImg()).getAttribute('src')).toBe('pi-local://file/?path=C%3A%2Fwork%2Fdocs%2F.%2Fimg.png');

    rerender(<RichMarkdownEditor root={'C:\\work'} filePath="sub/b.md" content={'![x](./img.png)'} onChange={vi.fn()} />);
    // useEditor deps=[root, filePath] → 编辑器重建，新扩展用 sub/ 基准解析
    expect((await waitForImg()).getAttribute('src')).toBe('pi-local://file/?path=C%3A%2Fwork%2Fsub%2F.%2Fimg.png');
  });
});