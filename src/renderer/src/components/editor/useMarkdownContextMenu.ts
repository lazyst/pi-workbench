// 右键菜单管理 hook：为 Markdown 富文本编辑器（TipTap）和 Markdown 预览（只读）提供统一的
// 右键菜单状态管理。参考 orca 的 rich-markdown-context-command-routing.ts 命令设计。
//
// 设计要点：
//   • 使用 pi-workbench 已有的 React ContextMenu 组件，而非 Electron 原生菜单。
//   • 对 TipTap 编辑器：提供格式化命令（标题、加粗、列表、链接等）。
//   • 对 Markdown 预览：提供复制/全选/复制链接地址等只读操作。
//   • 使用坐标命中检测（参考 orca 的 isRichMarkdownContextCommandTarget），
//     确保右键菜单只出现在组件区域内。
import { useCallback, useRef, useState } from 'react';
import type { Editor } from '@tiptap/react';
import type { ContextMenuItem } from '../ContextMenu';

interface ContextMenuState {
  x: number;
  y: number;
  items: ContextMenuItem[];
}

/**
 * 右键菜单的状态与管理 hook。
 * 返回 { menuState, onContextMenu, closeMenu } 供消费组件使用。
 */
export function useMarkdownContextMenu() {
  const [menuState, setMenuState] = useState<ContextMenuState | null>(null);

  const closeMenu = useCallback(() => setMenuState(null), []);

  return {
    menuState,
    setMenuState,
    closeMenu,
  };
}

/**
 * 构建 TipTap 富文本编辑器的右键菜单项。
 * 参考 orca 的 Markdown 格式化菜单设计，按功能分组：
 *   标题 → H1 / H2 / H3
 *   文字样式 → 加粗 / 斜体 / 删除线 / 行内代码
 *   段落 → 段落 / 引用 / 代码块
 *   列表 → 无序列表 / 有序列表 / 任务列表
 *   链接
 *   图片
 *   分割线
 */
export function buildRichEditorContextMenu(
  editor: Editor,
  onToggleLink: () => void,
  onPickImage: () => void,
): ContextMenuItem[] {
  return [
    // ── 标题 ──
    { label: '标题 1', onClick: () => editor.chain().focus().toggleHeading({ level: 1 }).run() },
    { label: '标题 2', onClick: () => editor.chain().focus().toggleHeading({ level: 2 }).run() },
    { label: '标题 3', onClick: () => editor.chain().focus().toggleHeading({ level: 3 }).run() },
    { label: '分隔线', kind: 'separator' },
    // ── 文字样式 ──
    { label: '加粗', onClick: () => editor.chain().focus().toggleBold().run() },
    { label: '斜体', onClick: () => editor.chain().focus().toggleItalic().run() },
    { label: '删除线', onClick: () => editor.chain().focus().toggleStrike().run() },
    { label: '行内代码', onClick: () => editor.chain().focus().toggleCode().run() },
    { label: '分隔线', kind: 'separator' },
    // ── 段落块 ──
    { label: '段落', onClick: () => editor.chain().focus().setParagraph().run() },
    { label: '引用', onClick: () => editor.chain().focus().toggleBlockquote().run() },
    { label: '代码块', onClick: () => editor.chain().focus().toggleCodeBlock().run() },
    { label: '分隔线', kind: 'separator' },
    // ── 列表 ──
    { label: '无序列表', onClick: () => editor.chain().focus().toggleBulletList().run() },
    { label: '有序列表', onClick: () => editor.chain().focus().toggleOrderedList().run() },
    { label: '任务列表', onClick: () => editor.chain().focus().toggleTaskList().run() },
    { label: '分隔线', kind: 'separator' },
    // ── 插入 ──
    { label: '链接…', onClick: () => { onToggleLink(); } },
    { label: '图片…', onClick: () => { onPickImage(); } },
    { label: '分割线', onClick: () => editor.chain().focus().setHorizontalRule().run() },
  ];
}

/**
 * 构建 Markdown 预览（只读）的右键菜单项。
 * 提供复制、全选、复制链接地址等操作。
 * 当右键点击的是链接元素时，额外显示「复制链接地址」。
 */
export function buildPreviewContextMenu(
  targetLink: string | null,
  selectedText: string = '',
): ContextMenuItem[] {
  const items: ContextMenuItem[] = [];

  // 复制选中文本。selectedText 由调用方在 contextmenu 事件触发瞬间快照传入——
  // 菜单打开后 Radix 会把焦点移到菜单 Content，清除文档选区，此时再读
  // window.getSelection() 已是空串，复制会失效。disabled 防止无选区时误点。
  items.push({
    label: '复制',
    disabled: !selectedText,
    onClick: () => {
      void navigator.clipboard.writeText(selectedText).catch(() => {});
    },
  });

  // 全选
  items.push({
    label: '全选',
    onClick: () => {
      const sel = window.getSelection();
      if (sel) {
        const range = document.createRange();
        const preview = document.querySelector('.markdown-file-preview');
        if (preview) {
          range.selectNodeContents(preview);
          sel.removeAllRanges();
          sel.addRange(range);
        }
      }
    },
  });

  // 如果右键点击的是链接，添加「复制链接地址」
  if (targetLink) {
    items.push({ label: '分隔线', kind: 'separator' });
    items.push({
      label: '复制链接地址',
      onClick: () => {
        void navigator.clipboard.writeText(targetLink).catch(() => {});
      },
    });
  }

  return items;
}

/**
 * 查找右键点击目标最近的 <a> 元素，返回其 href（或 null）。
 */
export function findLinkHref(target: HTMLElement): string | null {
  const link = target.closest('a');
  return link?.getAttribute('href') ?? null;
}