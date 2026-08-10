// Monaco 封装的「代码编辑表面」（EditorSurface）。
// 取代原 CodePreview（CodeMirror 6）。
//
// 设计要点（对齐 ADR-0002 / issue 08）：
//   • 受控内容同步：外部 content 变更（如切回 tab、重新加载）时，仅当与编辑器当前值
//     不一致才 reconcile 覆盖，避免编辑中回写造成的光标跳动 / 内容丢失。
//   • onChange → 通知父组件计算 dirty / 缓存当前文本。
//   • onSave：Ctrl/Cmd+S 触发（仅在有未保存改动时拦截，由父组件决定是否落盘）。
//   • 主题跟随：监听根节点 data-theme，切换 vs-dark / vs（Monaco 内置主题，不自定义）。
//     编辑器背景色通过 CSS --editor-surface 变量覆盖，与面板色调一致。
//   • 字号跟随：监听 --font-scale（fontSize.ts 写入根节点），按比例设 editor fontSize。
//   • keep-alive：用 `keepCurrentModel` 让每个 path 的 model 跨 tab 切换保留（不 dispose），
//     自然支持 keep-alive、不丢滚动与光标。saveViewState 关掉，由本组件缓存/恢复视图状态。
//
// 注意：本组件不读盘、不写盘——加载与保存由父组件（PreviewTab）负责，保持单一职责。
import { useCallback, useEffect, useRef } from 'react';
import Editor, { OnMount } from '@monaco-editor/react';
import type { editor } from 'monaco-editor';
import { themeIsDark, getMonacoFontSize, useMonacoFontFollow } from '../../editorUtils';

interface Props {
  /** 仓库根目录，用于构造稳定的 model path（uri）。 */
  root: string;
  /** 相对 root 的文件路径，作为 model 唯一标识（keep-alive 的 key）。 */
  path: string;
  /** 语言 id（如 typescript / markdown / json…），用于着色。 */
  language: string;
  /** 当前应展示的内容。仅当与编辑器当前值不一致时回写（受控 reconcile）。 */
  content: string;
  /** 内容变更（用户输入）→ 父组件据此算 dirty / 缓存。 */
  onChange?: (content: string) => void;
  /** Ctrl/Cmd+S 保存请求。父组件据此落盘。不传则快捷键不拦截。 */
  onSave?: () => void;
}

// 把 root + path 合成一个稳定、合法的 monaco model uri。
// @monaco-editor/react 的 `path` prop 会经 `monaco.Uri.parse(path)` 传给 createModel，
// 故这里直接构造合法 uri 即可作为「每文件一个 model」的稳定 key（keep-alive 的锚点）。
//
// 用规范 file:// URI（正斜杠、分段规范、不做整段 encodeURIComponent）：
//   旧实现对整个 key 做 encodeURIComponent，产出形如
//   `file:///c%3A%5C...\pi-workbench//electron.vite.config.ts` 的畸形 URI，
//   Monaco 的 TS worker 无法把这样的 URI 解析回真实磁盘路径，导致
//   "Could not find source file"（worker 在算诊断/悬停/跳转定义时会去找源文件）。
//   这里把 Windows 反斜杠转成正斜杠、去掉 root 尾部多余的斜杠，再拼接普通相对路径。
function modelUri(root: string, path: string): string {
  const normRoot = root.replace(/\\/g, '/').replace(/\/+$/, '');
  const normPath = path.replace(/\\/g, '/').replace(/^\/+/, '');
  return `file:///${normRoot}/${normPath}`;
}

export function MonacoCodeEditor({ root, path, language, content, onChange, onSave }: Props) {
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  // 应用层视图状态缓存：key 为 model uri，value 为保存的 view state（cursor/scroll/selection）。
  const viewStateCache = useRef<Map<string, editor.ICodeEditorViewState | null>>(new Map());

  // 把最新回调挂到 ref，避免 onMount 闭包拿到过期值。
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;

  const uri = modelUri(root, path);

  // 字号跟随：监听 --font-scale（fontSize.ts 写到根节点）。
  useMonacoFontFollow(() => editorRef.current);

  const handleMount: OnMount = useCallback((ed, m) => {
    editorRef.current = ed;
    // 初始字号对齐当前 --font-scale。
    ed.updateOptions({ fontSize: getMonacoFontSize() });

    // 应用层视图状态缓存：切 model 前保存、切后恢复（saveViewState:false 由本逻辑接管）。
    ed.onDidChangeModel((e) => {
      // 保存旧 model 视图状态
      if (e.oldModelUrl) {
        const oldUri = e.oldModelUrl.toString();
        viewStateCache.current.set(oldUri, ed.saveViewState());
      }
      // 恢复新 model 视图状态
      const newUri = e.newModelUrl ? e.newModelUrl.toString() : '';
      const vs = viewStateCache.current.get(newUri);
      if (vs) ed.restoreViewState(vs);
    });

    // Ctrl/Cmd+S → 保存（仅在有未保存改动时父组件才落盘，这里只转发请求）。
    ed.addCommand(m.KeyMod.CtrlCmd | m.KeyCode.KeyS, () => {
      onSaveRef.current?.();
    });
  }, [root]);

  // 卸载时不销毁当前 model（keepCurrentModel 已保证），仅清缓存引用。
  useEffect(() => () => {
    viewStateCache.current.clear();
  }, []);

  return (
    <Editor
      // path 驱动 model 唯一性：每个文件一个 model，切回保留光标/滚动（keep-alive）。
      path={uri}
      language={language || 'plaintext'}
      value={content}
      // 使用 Monaco 内置 vs-dark/vs 主题，不自定义主题。
      // 编辑器背景色通过 CSS --editor-surface 变量在 app.css 中覆盖。
      theme={themeIsDark() ? 'vs-dark' : 'vs'}
      keepCurrentModel
      saveViewState={false}
      options={{
        readOnly: false,
        automaticLayout: true, // 容器尺寸变化（tab 切换/CSS 隐藏）自动重排
        fontSize: getMonacoFontSize(),
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        fontFamily: 'var(--font-mono)',
        wordWrap: 'on',
        tabSize: 2,
        renderWhitespace: 'none',
        // 以下选项参考 orca MonacoEditor，优化编辑体验
        lineNumbers: 'on',
        cursorStyle: 'block', // 默认使用块状光标
        renderLineHighlight: 'line', // 仅高亮当前行（而非全行+左边距），减少视觉噪声
        smoothScrolling: true, // 滚动平滑
        cursorSmoothCaretAnimation: 'on',
        padding: { top: 0 },
        find: {
          addExtraSpaceOnTop: false,
          autoFindInSelection: 'never',
          seedSearchStringFromSelection: 'never',
        },
      }}
      className="monaco-code-editor"
      onMount={handleMount}
      onChange={(value) => {
        // 受控 reconcile 已保证外部覆盖（content 与模型值不一致时 setValue）才回写，
        // 用户正常输入时 content 已与模型同步，不会触发额外 setValue，故此处直接上报。
        onChangeRef.current?.(value ?? '');
      }}
    />
  );
}