// Monaco 封装的「diff 编辑表面」（EditorSurface 的 diff 形态，同源 Monaco）。
// 取代自研 SplitDiffView（unified 单栏解析渲染）。
//
// 设计要点（对齐 MonacoCodeEditor / ADR-0002 / issue 09）：
//   • 用 @monaco-editor/react 的 <DiffEditor>：original（左/旧）与 modified（右/新）
//     双模型，由 monaco 内部计算行内差异（inline diff），无需自研分割算法。
//   • 主题跟随 / 字号跟随：复用 editorUtils 的 useMonacoThemeFollow / useMonacoFontFollow
//     （与代码编辑器同源一致）。
//   • keep-alive：DiffTab 始终挂载、非 active 由 CSS display:none（对齐代码编辑器），
//     故这里无需额外视图状态缓存；每次 diff 文本整体替换即重新渲染。
//   • 只读：diff 是纯浏览表面，readOnly + renderSideBySide 并排呈现。
//
// 注意：本组件只负责「把一个 unified patch 文本渲染成 diff」，不解析 patch 结构
// （Monaco 的 diff 输入是 original/modified 两份完整文本，而非 git 的 unified 格式）。
// 因此由父组件（DiffTab）把 git diff 还原成 original/modified 文本后传入。
import { useRef } from 'react';
import { DiffEditor, type DiffOnMount } from '@monaco-editor/react';
import type { editor } from 'monaco-editor';
import { themeIsDark, getMonacoFontSize, useMonacoThemeFollow, useMonacoFontFollow } from '../../editorUtils';

interface Props {
  /** 原始（左侧）文本，对应 git diff 的「旧版本」内容。 */
  original: string;
  /** 修改后（右侧）文本，对应 git diff 的「新版本」内容。 */
  modified: string;
  /** 语言 id（如 typescript / markdown / json…），用于两侧着色。 */
  language: string;
}

export function MonacoDiffEditor({ original, modified, language }: Props) {
  const editorRef = useRef<editor.IStandaloneDiffEditor | null>(null);

  // 主题跟随：监听根节点 data-theme（与代码编辑器同源）。
  useMonacoThemeFollow();
  // 字号跟随：监听 --font-scale，刷新整个 diff 编辑器（双模型共用同一字号）。
  useMonacoFontFollow(() => editorRef.current);

  const handleMount: DiffOnMount = (ed) => {
    editorRef.current = ed;
    // 初始字号对齐当前 --font-scale。DiffEditor.updateOptions 会自动传播到
    // original / modified 两侧子编辑器，故只需对整体设一次。
    ed.updateOptions({ fontSize: getMonacoFontSize() });
  };

  return (
    <DiffEditor
      original={original}
      modified={modified}
      language={language || 'plaintext'}
      // 使用 Monaco 内置 vs-dark/vs 主题，不自定义主题。
      theme={themeIsDark() ? 'vs-dark' : 'vs'}
      options={{
        readOnly: true,
        automaticLayout: true, // 容器尺寸变化（tab 切换/CSS 隐藏）自动重排
        fontSize: getMonacoFontSize(),
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        fontFamily: 'var(--font-mono)',
        wordWrap: 'on',
        renderSideBySide: true,
        renderOverviewRuler: false,
        ignoreTrimWhitespace: false,
        // 行内差异高亮（字符级），与代码编辑器视觉一致。
        diffWordWrap: 'on',
        originalAriaLabel: '原始内容',
        modifiedAriaLabel: '修改后内容',
        // 以下选项参考 orca，对齐代码编辑器的编辑体验
        cursorStyle: 'block', // 默认使用块状光标
        renderLineHighlight: 'line',
        smoothScrolling: true,
        padding: { top: 0 },
      }}
      className="monaco-diff-editor"
      onMount={handleMount}
    />
  );
}