// Monaco DiffEditor 封装：左右分栏对比视图，对齐 VS Code 的 diff 编辑器。
// 支持两种模式：
//   1. 工作区文件 diff（unstaged + staged 合并 → 对当前编辑器内容）
//   2. 提交中文件 diff（原始版本 vs 修改后版本）
//
// 使用 @monaco-editor/react 的 DiffEditor 组件，内置 side-by-side 模式。
import { useCallback, useEffect, useRef, useState } from 'react';
import { DiffEditor } from '@monaco-editor/react';
import { themeIsDark, getMonacoFontSize, useMonacoFontFollow } from '../editorUtils';
import type { editor } from 'monaco-editor';

interface Props {
  /** 原始内容（旧版本 / 左侧）。 */
  original: string;
  /** 修改后内容（新版本 / 右侧）。 */
  modified: string;
  /** 语言 id（如 typescript / markdown / json…）。 */
  language: string;
  /** 文件路径（用于显示文件名）。 */
  fileName?: string;
  /** 单栏 unified diff（Monaco inline），默认 false 为左右分栏。 */
  singleColumn?: boolean;
}

export function MonacoDiffView({ original, modified, language, fileName, singleColumn }: Props) {
  const editorRef = useRef<editor.IStandaloneDiffEditor | null>(null);
  const [isCollapsed, setIsCollapsed] = useState(false);

  const handleMount = useCallback((ed: editor.IStandaloneDiffEditor) => {
    editorRef.current = ed;
    ed.updateOptions({ fontSize: getMonacoFontSize() });
  }, []);

  useMonacoFontFollow(() => editorRef.current?.getModifiedEditor() ?? null);

  if (original === '' && modified === '') {
    return <div className="git-empty">无法加载文件内容</div>;
  }

  return (
    <div className="monaco-diff-view" style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      {fileName && (
        <div className="monaco-diff-header">
          <span className="monaco-diff-file">{fileName}</span>
          <button
            className="monaco-diff-toggle"
            onClick={() => setIsCollapsed((v) => !v)}
            title={isCollapsed ? '展开 diff' : '折叠 diff'}
          >
            {isCollapsed ? '▶' : '▼'}
          </button>
        </div>
      )}
      <div style={{ flex: 1, minHeight: 0, display: isCollapsed ? 'none' : 'flex' }}>
        <DiffEditor
          original={original}
          modified={modified}
          language={language || 'plaintext'}
          theme={themeIsDark() ? 'vs-dark' : 'vs'}
          originalModelPath={fileName ? `original-${fileName}` : undefined}
          modifiedModelPath={fileName ? `modified-${fileName}` : undefined}
          options={{
            automaticLayout: true,
            fontSize: getMonacoFontSize(),
            fontFamily: 'var(--font-mono)',
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            renderSideBySide: !singleColumn,
            readOnly: true,
            wordWrap: 'on',
            renderWhitespace: 'none',
            lineNumbers: 'on',
            // 对齐主编辑器（MonacoCodeEditor / MonacoDiffEditor）的编辑体验
            cursorStyle: 'block',
            renderLineHighlight: 'line',
            smoothScrolling: true,
            diffWordWrap: 'on',
            // VS Code 风格 diff 选项
            renderIndicators: true,
            ignoreTrimWhitespace: false,
            diffCodeLens: false,
            enableSplitViewResizing: !singleColumn,
          }}
          onMount={handleMount}
        />
      </div>
    </div>
  );
}