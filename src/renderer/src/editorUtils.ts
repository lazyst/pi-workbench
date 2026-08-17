// 编辑器共用的小工具：主题判定与字号缩放读取。
// 从原 CodePreview 抽出 themeIsDark，并新增 getFontScale（读根节点 --font-scale）。
// Monaco 与 CodeMirror 共享，避免重复实现。

import { useEffect } from 'react';
import type { editor } from 'monaco-editor';
import * as monaco from 'monaco-editor';
import type { ThemeFamily } from './types';

/** 当前是否为暗色主题（读根节点 data-theme，缺省按暗色）。 */
export function themeIsDark(): boolean {
  return document.documentElement.getAttribute('data-theme') !== 'light';
}

/** 当前主题家族（读根节点 data-theme-family，缺省 'github'）。 */
export function getThemeFamily(): ThemeFamily {
  return (document.documentElement.getAttribute('data-theme-family') as ThemeFamily) ?? 'github';
}

/** 当前字号缩放比例（--font-scale：1 表示基准 13px）。缺省 1。 */
export function getFontScale(): number {
  const raw = document.documentElement.style.getPropertyValue('--font-scale');
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

/** 当前应设的 Monaco 字号（基准 13px × 缩放比例，取整，钳制在 8–32px 安全区间）。
 *  参考 orca `computeEditorFontSize` 的 min/max 防护，避免极端缩放值导致
 *  编辑器文字不可读或布局崩坏。 */
export function getMonacoFontSize(): number {
  return Math.max(8, Math.min(32, Math.round(13 * getFontScale())));
}

/**
 * 主题跟随：监听根节点 data-theme 与 data-theme-family，切换 vs-dark / vs（Monaco 内置主题）。
 * 编辑器背景色通过 CSS --editor-surface 变量在 app.css 中覆盖，避免自定义主题
 * 与 @monaco-editor/react 内部 theme 处理机制之间的冲突。
 * Monaco 的 setTheme 是全局单例，故任意编辑器组件调用都等价；在各自组件内调用
 * 即可保证挂载时立即对齐当前主题。
 * 被 MonacoCodeEditor / MonacoDiffEditor 共用，避免重复实现。
 */
export function useMonacoThemeFollow(): void {
  useEffect(() => {
    const apply = () => monaco.editor.setTheme(themeIsDark() ? 'vs-dark' : 'vs');
    apply();
    const observer = new MutationObserver(apply);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-theme-family'] });
    return () => observer.disconnect();
  }, []);
}

/**
 * 字号跟随：监听 --font-scale（fontSize.ts 写到根节点的 inline style），按比例刷新
 * 传入 editor 的字号。返回 apply 回调，挂载时由调用方对 original/modified 双模型分别调用。
 * 被 MonacoCodeEditor / MonacoDiffEditor 共用，避免重复实现。
 */
export function useMonacoFontFollow(
  getEditor: () => editor.IStandaloneCodeEditor | editor.IStandaloneDiffEditor | null,
): () => void {
  const apply = () => {
    const ed = getEditor();
    if (!ed) return;
    const fontSize = getMonacoFontSize();
    ed.updateOptions({ fontSize });
  };
  useEffect(() => {
    const observer = new MutationObserver(apply);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });
    return () => observer.disconnect();
  }, []);
  return apply;
}