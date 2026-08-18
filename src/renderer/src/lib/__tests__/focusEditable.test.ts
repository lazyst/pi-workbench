// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { focusEditableIn } from '../focusEditable';

describe('focusEditableIn（tab 内容区聚焦，SplitPane/PreviewTab 共用）', () => {
  it('聚焦 Monaco textarea，返回 true', () => {
    document.body.innerHTML = '<div class="tab-host"><div class="monaco-editor"><textarea></textarea></div></div>';
    const host = document.querySelector('.tab-host')!;
    expect(focusEditableIn(host)).toBe(true);
    expect(document.activeElement).toBe(document.querySelector('textarea'));
  });

  it('聚焦 TipTap 富文本 .ProseMirror（真实 DOM 带 contenteditable），返回 true', () => {
    document.body.innerHTML =
      '<div class="tab-host"><div class="ProseMirror" contenteditable="true"></div></div>';
    const host = document.querySelector('.tab-host')!;
    expect(focusEditableIn(host)).toBe(true);
    expect(document.activeElement).toBe(document.querySelector('.ProseMirror'));
  });

  it('无可编辑元素（纯阅读渲染预览）时返回 false 且不聚焦', () => {
    document.body.innerHTML = '<div class="tab-host"><p>纯正文</p></div>';
    const host = document.querySelector('.tab-host')!;
    expect(focusEditableIn(host)).toBe(false);
    expect(document.activeElement).toBe(document.body);
  });
});