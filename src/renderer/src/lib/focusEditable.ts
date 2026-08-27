// 中间区 tab 内容一致的可编辑元素定位/聚焦工具（SplitPane 点击 tab 与 PreviewTab 激活共用）。
// Monaco 源码编辑器(textarea)、TipTap 富文本(ProseMirror) 与其他 contenteditable 容器。
import type { Editor } from '@tiptap/react';

export const EDITABLE_SELECTOR = '.monaco-editor textarea, .ProseMirror, [contenteditable="true"]';

/** 聚焦 host 内第一个可编辑元素；无可编辑元素（纯阅读预览等）返回 false。 */
export function focusEditableIn(host: ParentNode): boolean {
  const editable = host.querySelector<HTMLElement>(EDITABLE_SELECTOR);
  if (!editable) return false;

  // TipTap 富文本（.ProseMirror）：TipTap 把 editor 实例挂在 DOM 节点 .editor 上。
  // 必须走受控 focus——先 dispatch selection 到文档开头并同步到 DOM，再聚焦且不滚动
  // （scrollIntoView:false）。原生 dom.focus() 会让 Chromium 把 caret 隐式放到文档
  // 末尾，ProseMirror DOMObserver 跟随该 selection 并 scrollToSelection，把滚动容器
  // 拉到最底部，覆盖跨视图滚动位置复用（preventScroll 只拦浏览器隐式滚动，拦不住
  // ProseMirror 自身的 scrollToSelection）。
  const tipTapEditor = (editable as HTMLElement & { editor?: Editor | null }).editor;
  if (tipTapEditor && !tipTapEditor.isDestroyed) {
    tipTapEditor.commands.focus('start', { scrollIntoView: false });
  } else {
    // 其他可编辑元素（Monaco textarea 等）：原生聚焦；preventScroll 避免浏览器把
    // 目标元素滚入视野（滚动定位统一由各视图自身的逻辑管理）。
    editable.focus({ preventScroll: true });
  }
  return true;
}
