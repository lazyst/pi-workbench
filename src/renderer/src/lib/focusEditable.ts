// 中间区 tab 内容一致的可编辑元素定位/聚焦工具（SplitPane 点击 tab 与 PreviewTab 激活共用）。
// Monaco 源码编辑器(textarea)、TipTap 富文本(ProseMirror) 与其他 contenteditable 容器。
export const EDITABLE_SELECTOR = '.monaco-editor textarea, .ProseMirror, [contenteditable="true"]';

/** 聚焦 host 内第一个可编辑元素；无可编辑元素（纯阅读预览等）返回 false。 */
export function focusEditableIn(host: ParentNode): boolean {
  const editable = host.querySelector<HTMLElement>(EDITABLE_SELECTOR);
  if (!editable) return false;
  editable.focus();
  return true;
}