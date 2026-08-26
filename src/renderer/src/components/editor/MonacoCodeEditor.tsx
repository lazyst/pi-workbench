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
//   • lineDecorations：行号旁 Git 变更标记（added/removed 竖条），点击触发 onDecorationClick。
//
// 注意：本组件不读盘、不写盘——加载与保存由父组件（PreviewTab）负责，保持单一职责。
import { useCallback, useEffect, useRef } from 'react';
import Editor, { OnMount } from '@monaco-editor/react';
import type { editor } from 'monaco-editor';
import { themeIsDark, getMonacoFontSize, useMonacoFontFollow } from '../../editorUtils';
import { monaco } from './monaco-setup';
import type { PreviewSelection } from '../../types';

export interface LineDecoration {
  /** 行号（1-based）。 */
  line: number;
  /** 变更类型。 */
  type: 'added' | 'removed' | 'modified';
}

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
  /** Git 变更行标记（行号左侧竖条）。 */
  lineDecorations?: LineDecoration[];
  /** 点击行号旁的变更标记 → 打开该行对应的 diff 弹窗。 */
  onDecorationClick?: (line: number, clientX: number, clientY: number) => void;
  /** 点击搜索结果跳转时定位的选区；变化即 reveal+高亮，null 清高亮。 */
  revealSelection?: PreviewSelection | null;
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

/**
 * 释放指定预览文件的 Monaco model（tab 真正关闭时由 PreviewTab 卸载时调用）。
 *
 * keepCurrentModel 使 model 跨 tab 切换保留（不随编辑器卸载 dispose），副作用是关闭
 * tab 后 model 仍永久驻留 monaco 全局 registry（monaco.editor.getModels()），导致每个
 * 打开过的文件（内容 + undo 栈 + 语法 token + TS worker mirror）永久占内存。
 */
export function disposePreviewModel(root: string, path: string): void {
  try {
    const model = monaco.editor.getModel(monaco.Uri.parse(modelUri(root, path)));
    if (model) model.dispose();
  } catch {
    /* 编辑器未初始化 / model 已释放，静默忽略 */
  }
}

// 装饰 ID 前缀（用于 deltaDecorations 分组标识）。
const DECO_ID = 'git-change-mark';

// 行号变更标记类型 → gutter CSS 类。
const GUTTER_CLASS: Record<LineDecoration['type'], string> = {
  added: 'git-gutter-added',
  removed: 'git-gutter-removed',
  modified: 'git-gutter',
};

export function MonacoCodeEditor({ root, path, language, content, onChange, onSave, lineDecorations, onDecorationClick, revealSelection }: Props) {
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  // 应用层视图状态缓存：key 为 model uri，value 为保存的 view state（cursor/scroll/selection）。
  const viewStateCache = useRef<Map<string, editor.ICodeEditorViewState | null>>(new Map());
  // 已应用的装饰 ID 集合，用于 deltaDecorations 增量更新。
  const decoIdsRef = useRef<string[]>([]);
  // 当前 decorations 的引用（用于 onMouseDown 判断）。
  const lineDecorationsRef = useRef<LineDecoration[]>(lineDecorations ?? []);
  lineDecorationsRef.current = lineDecorations ?? [];
  // 把最新 content 挂到 ref（onMount 只调用一次，直接闭包会拿到初始值）。
  const contentRef = useRef(content);
  contentRef.current = content;

  // 把最新回调挂到 ref，避免 onMount 闭包拿到过期值。
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;
  const onDecorationClickRef = useRef(onDecorationClick);
  onDecorationClickRef.current = onDecorationClick;
  // 搜索结果跳转：reveal + 选区 + 临时整行高亮（search-hit-line），变化即重应用。
  // 不依赖 content（避免用户输入时 re-reveal 打断编辑）；首次打开文件时由
  // [content] effect 先 setValue、本 effect 后 reveal 的顺序保证 model 已有内容。
  const searchHitDecoRef = useRef<string[]>([]);
  const revealSelectionRef = useRef<PreviewSelection | null | undefined>(revealSelection);
  revealSelectionRef.current = revealSelection;
  const applyReveal = useCallback((ed: editor.IStandaloneCodeEditor) => {
    const model = ed.getModel();
    if (!model) return;
    const sel = revealSelectionRef.current;
    const oldIds = searchHitDecoRef.current;
    if (!sel) {
      if (oldIds.length) searchHitDecoRef.current = model.deltaDecorations(oldIds, []);
      return;
    }
    const startLine = sel.startLine;
    const startColumn = sel.startColumn ?? 1;
    const endLine = sel.endLine ?? sel.startLine;
    const endColumn = sel.endColumn ?? startColumn;
    try {
      ed.revealLineInCenter(startLine);
      ed.setSelection({ startLineNumber: startLine, startColumn, endLineNumber: endLine, endColumn });
    } catch {
      /* 行号越界 Monaco 自动 clamp，忽略 */
    }
    searchHitDecoRef.current = model.deltaDecorations(oldIds, [{
      range: { startLineNumber: startLine, startColumn: 1, endLineNumber: endLine, endColumn: 1 },
      options: { isWholeLine: true, className: 'search-hit-line' },
    }]);
  }, []);

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

    // 点击行号区域 → 检测是否点击了变更标记行
    ed.onMouseDown((event) => {
      const target = event.target;
      // 只在 gutter 区域响应（含 glyph margin / 行号）
      const isGutter = target.type === m.editor.MouseTargetType.GUTTER_GLYPH_MARGIN ||
        target.type === m.editor.MouseTargetType.GUTTER_LINE_NUMBERS ||
        target.type === m.editor.MouseTargetType.GUTTER_VIEW_ZONE;
      if (!isGutter) return;

      const line = target.position?.lineNumber;
      if (line == null) return;

      // 检查该行是否有变更标记（有则触发弹窗）
      const cb = onDecorationClickRef.current;
      if (cb && lineDecorationsRef.current.some((d) => d.line === line)) {
        cb(line, event.event.browserEvent.clientX, event.event.browserEvent.clientY);
      }
    });

    // 外部内容同步（修复 keepCurrentModel 场景下显示旧内容）：
    // @monaco-editor/react 的 value 同步 effect 使用「跳过首次运行」的 hook（he/l），
    // 组件（重）挂载后若 value prop 不再变化，该 effect 永不执行，配合 keepCurrentModel
    // 会复用旧 model 导致显示过期内容。此处显式把 model 内容与 content prop 对齐，
    // 确保挂载即显示最新内容（用户输入时两者已一致，不会触发）。
    syncModelContent(ed, contentRef.current);

    // 首次挂载后应用初始 decorations
    applyDecorations(ed, lineDecorations ?? [], decoIdsRef);
    // 应用初始跳转选区（从搜索结果打开文件时）
    applyReveal(ed);
  }, [root, applyReveal]);

  // lineDecorations 变化时更新 decorations
  useEffect(() => {
    const ed = editorRef.current;
    if (!ed) return;
    applyDecorations(ed, lineDecorations ?? [], decoIdsRef);
  }, [lineDecorations]);

  // revealSelection 变化 → reveal + 高亮（不依赖 content，避免用户输入时打断）
  useEffect(() => {
    const ed = editorRef.current;
    if (ed) applyReveal(ed);
  }, [revealSelection, applyReveal]);

  // 外部内容变更同步：content prop 与 model 不一致时覆盖为最新内容（文件被外部
  // 修改后的自动重载）。@monaco-editor/react 的 value-sync 理论上会处理此情形，
  // 此处作为兜底显式同步（防止库内部行为变更或边界条件）；用户输入时 model 已与
  // content 一致，不会触发额外 setValue。
  useEffect(() => {
    const ed = editorRef.current;
    if (!ed) return;
    syncModelContent(ed, content);
  }, [content]);

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
        // 启用字形边距（用于显示 Git 变更标记竖条）
        glyphMargin: true,
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

// ── 内容同步 ──

/**
 * 把 editor 当前 model 的内容与 `content` 对齐：仅当二者不一致时才用 executeEdits
 * 覆盖（保留 undo 栈），避免用户输入时的无意义回写造成光标跳动。
 * 用于 onMount（keepCurrentModel 复用旧 model）和 content prop 变化（外部修改重载）。
 */
function syncModelContent(ed: editor.IStandaloneCodeEditor, content: string): void {
  const model = ed.getModel();
  if (!model) return;
  if (model.getValue() === content) return;
  // executeEdits + pushUndoStop：与 @monaco-editor/react 内部 value-sync 一致，
  // 保留 undo 历史（整体替换为一个可撤销的编辑操作）。
  ed.executeEdits('external-sync', [{
    range: model.getFullModelRange(),
    text: content,
    forceMoveMarkers: true,
  }]);
  ed.pushUndoStop();
}

// ── 装饰应用 ──

function applyDecorations(
  ed: editor.IStandaloneCodeEditor,
  decorations: LineDecoration[],
  decoIdsRef: React.MutableRefObject<string[]>,
) {
  const newDecorations: editor.IModelDeltaDecoration[] = decorations.map((d) => {
    const className = GUTTER_CLASS[d.type];
    return {
      range: {
        startLineNumber: d.line,
        startColumn: 1,
        endLineNumber: d.line,
        endColumn: 1,
      },
      options: {
        // 字形边距：在行号左侧显示一个小图标/标记
        glyphMarginClassName: className,
        // 行号左侧的竖线条（VS Code 的 gutter decoration）
        linesDecorationsClassName: className,
        isWholeLine: true,
      },
    };
  });

  const model = ed.getModel();
  if (model) {
    const oldIds = decoIdsRef.current.splice(0, decoIdsRef.current.length);
    const newIds = model.deltaDecorations(oldIds, newDecorations);
    decoIdsRef.current = newIds;
  }
}