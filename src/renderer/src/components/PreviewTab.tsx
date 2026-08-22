// 中间区 Tab 内容组件：单文件预览 / 编辑（keep-alive 友好）。
// 由右侧 FileDrawer 抽屉改造而来——去掉 overlay / 左侧拖拽 resizer / 关闭按钮，
// 改为占满 tab 内容的形态。关闭由统一 Tab 条的 × 负责；dirty 时由 tab 条/父组件
// 负责确认（本组件通过 onClose 语义外的 tab 条处理，这里保留 ConfirmDialog 兜底）。
// key 行为完全等价于原抽屉：
//   • 文本/代码 → MonacoCodeEditor，dirty 跟踪 + 显式保存（fsWriteFile）
//   • 图片 → ImagePreview
//   • 二进制/过大 → 系统默认程序打开（fsOpenWithSystem）
//   • 预览内相对链接点击 → onOpenFile（在应用内切到目标文件）
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { pi } from '../ipc';
import { MonacoCodeEditor, type LineDecoration } from './editor/MonacoCodeEditor';
import { ImagePreview } from './ImagePreview';
import { ConfirmDialog } from './ConfirmDialog';
import { DiffPopup } from './DiffPopup';
import { parseDiffLineChanges, extractHunkCompressed } from '../lib/diffLines';
import { MarkdownPreview } from './MarkdownPreview';
import { RichMarkdownEditor } from './RichMarkdownEditor';
import { basenameOf, toAbsolutePath } from '../lib/mdPath';
import { focusEditableIn } from '../lib/focusEditable';

interface Props {
  root: string;
  path: string;
  /** 是否当前可见 tab（keep-alive：非 active 时父容器用 CSS 隐藏，本组件仍挂载）。 */
  active: boolean;
  /** 预览内相对链接点击 → 在应用内切到目标文件（语义同文件树 onOpenFile）。 */
  onOpenFile?: (relPath: string, fileName: string, root: string) => void;
  /** 真正关闭本 tab（由父组件传入，通常即移除该 preview tab）。dirty 确认通过后调用。 */
  onClose: () => void;
  /** 向父组件（CenterPane）注册「关闭请求拦截器」：父组件 TabBar 的 × 会先调用它，
   *  以便 dirty 时弹出确认而不是直接丢弃改动。传 null 表示注销（unmount 时）。 */
  onRegisterCloseGuard?: (id: string, guard: (() => void) | null) => void;
  /** 向父组件上报「文件已被删除」状态（true=文件已不存在于磁盘）。父组件据此
   *  在 TabBar 标题上施加红字+删除线，文件恢复/保存后自动清除。 */
  onDeletedChange?: (deleted: boolean) => void;
  /** 本 tab 的唯一 id（与 CenterPane tabs 中的 id 对齐，用于注册 guard）。 */
  tabId: string;
}

function countLines(s: string): number {
  if (!s) return 0;
  return s.split(/\r\n|\r|\n/).length;
}

export function PreviewTab({ root, path, active, onOpenFile, onClose, onRegisterCloseGuard, onDeletedChange, tabId }: Props) {
  const [dirty, setDirty] = useState(false);
  // 文件是否已从磁盘删除：TabBar 标题红字+删除线；内容区保留已读内容仍可编辑，保存时重建。
  const [deleted, setDeleted] = useState(false);
  const dirtyRef = useRef(false);
  // 同步 dirty state 到 ref，供外界 fsWatchFile 回调读取最新值（避免闭包过期）。
  useEffect(() => { dirtyRef.current = dirty; }, [dirty]);
  const hostRef = useRef<HTMLDivElement>(null);
  const [initialContent, setInitialContent] = useState('');
  const [currentContent, setCurrentContent] = useState('');
  const [kind, setKind] = useState<'code' | 'image' | 'binary' | 'loading'>('loading');
  const [language, setLanguage] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  // markdown 文件的三模式视图：预览(渲染) / 源码(Monaco) / 富文本(TipTap)。
  const [isMarkdown, setIsMarkdown] = useState(false);
  const [viewMode, setViewMode] = useState<'rendered' | 'source' | 'rich'>('source');

  // Git 行号变更标记
  const [lineDecorations, setLineDecorations] = useState<LineDecoration[]>([]);
  const [diffPopup, setDiffPopup] = useState<{ x: number; y: number; lines: Array<{ type: 'add' | 'del' | 'ctx'; text: string; newLine: number | null }> } | null>(null);

  // 读取文件时一并获取 Git 变更行标记
  const fetchLineDecorations = useCallback(async (root: string, path: string) => {
    try {
      const diff = await pi.gitFileDiff(root, path);
      if (!diff) { setLineDecorations([]); return; }
      const hunks = parseDiffLineChanges(diff);
      const decos: LineDecoration[] = [];
      for (const hunk of hunks) {
        for (const r of hunk.ranges) {
          if (r.type === 'added') {
            for (let i = 0; i < r.count; i++) {
              decos.push({ line: r.startLine + i, type: 'added' });
            }
          } else if (r.type === 'removed') {
            // 删除行在原位置标记为 removed（新版本中该行已被删，但仍在有内容的一行旁）
            decos.push({ line: Math.max(r.startLine, 1), type: 'removed' });
          }
        }
      }
      setLineDecorations(decos);
    } catch {
      setLineDecorations([]);
    }
  }, []);

  // Load metadata (kind + initial content) when the file changes.
  useEffect(() => {
    let cancelled = false;
    setDirty(false);
    setError(null);
    setKind('loading');
    setInitialContent('');
    setCurrentContent('');
    setLineDecorations([]);
    (async () => {
      try {
        const res = await pi.fsReadFile(root, path);
        if (cancelled) return;
        // 文件已不存在（打开时即被删除/移动）：标记 tab 删除态，内容区显示提示。
        if (res.notFound) {
          setDeleted(true);
          setKind('binary');
          setError('文件已被删除');
          setIsMarkdown(false);
          return;
        }
        setDeleted(false);
        // 二进制 / 过大文件：无内置预览器，交系统默认程序打开（等同双击文件）。
        // 异步获取 git 行号标记（不阻塞文件加载）
        if (!res.isBinary && !res.isImage) {
          fetchLineDecorations(root, path).catch(() => {});
        }
        if (res.isBinary) {
          const abs = toAbsolutePath(root, path);
          const ok = await pi.fsOpenWithSystem(abs);
          if (!cancelled) setKind('binary');
          if (!ok && !cancelled) setError('无法用系统程序打开该文件');
          return;
        }
        if (res.isImage) { setKind('image'); setIsMarkdown(false); }
        else {
          setKind('code');
          setLanguage(res.language);
          const md = res.language === 'markdown';
          setIsMarkdown(md);
          // markdown 默认进入渲染预览（orca 风格）；其余代码默认源码编辑。
          setViewMode(md ? 'rendered' : 'source');
          setInitialContent(res.content);
          setCurrentContent(res.content);
        }
      } catch (e) {
        if (cancelled) return;
        // 目录错误（EISDIR）：降级到系统文件管理器打开，而非显示错误。
        const errMsg = e instanceof Error ? e.message : String(e);
        if (errMsg.includes('EISDIR')) {
          const abs = toAbsolutePath(root, path);
          await pi.fsOpenWithSystem(abs).catch(() => {});
          if (!cancelled) {
            setKind('binary');
            setError(null);
          }
          return;
        }
        // 文件不存在（ENOENT）：显示友好提示。
        if (errMsg.includes('ENOENT')) {
          setError('文件不存在或已被删除');
          setKind('binary');
          setIsMarkdown(false);
          return;
        }
        // 其他错误：显示友好提示（隐藏原始 IPC 错误详情）。
        setError('无法打开文件');
        setKind('binary');
        setIsMarkdown(false);
      }
    })();
    return () => { cancelled = true; };
  }, [root, path]);

  // 外部修改监听：当文件被其他编辑器或命令修改时，自动重载内容（仅非 dirty 时）。
  useEffect(() => {
    const unwatch = pi.fsWatchFile(root, path, () => {
      // 如有未保存改动，不覆盖用户编辑，待下次打开文件时自然读到新内容。
      // 通过 ref 而不是闭包捕获 latest dirty 值以避免 stale closure。
      if (dirtyRef.current) return;
      // 重新读取文件内容：文件删除/恢复均在此捕获（watch 监听父目录 rename 事件）。
      pi.fsReadFile(root, path).then((res) => {
        setDeleted(!!res.notFound); // 文件删除→保留旧内容仅标记；恢复/正常变更→清除标记
        if (res.notFound || res.isBinary || res.isImage) return;
        setCurrentContent(res.content);
        setInitialContent(res.content);
      }).catch(() => {});
    });
    return () => { unwatch(); };
  }, [root, path]);

  const doSave = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      await pi.fsWriteFile(root, path, currentContent);
      setInitialContent(currentContent);
      setDirty(false);
      setDeleted(false); // 保存会重建文件，清除「已删除」标记（对齐 VS Code 保存后标记消失）
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [root, path, currentContent]);

  // 内容变更统一入口：Monaco(源码) 与 RichMarkdownEditor(富文本) 共用，
  // 更新 currentContent 并据此计算 dirty（与磁盘 initialContent 比较）。
  const handleChange = useCallback((c: string) => {
    setCurrentContent(c);
    setDirty(c !== initialContent);
  }, [initialContent]);

  // 关闭请求：dirty 时先弹确认（防止静默丢弃未保存改动，对齐原 FileDrawer 抽屉语义）；
  // 非 dirty 或确认通过后，才真正关闭 tab（调父组件传入的 onClose）。
  // 该回调经 onRegisterCloseGuard 注册到 CenterPane，使 TabBar 的 × 走此拦截而非直关。
  const requestClose = useCallback(() => {
    if (dirty) setConfirmClose(true);
    else onClose();
  }, [dirty, onClose]);

  // 挂载时向 CenterPane 注册关闭拦截器；卸载时注销（传 null）。
  useEffect(() => {
    onRegisterCloseGuard?.(tabId, requestClose);
    return () => { onRegisterCloseGuard?.(tabId, null); };
  }, [tabId, requestClose, onRegisterCloseGuard]);

  // 上报「文件已删除」状态到父组件（TabBar 标题红字+删除线）。
  useEffect(() => {
    onDeletedChange?.(deleted);
  }, [deleted, onDeletedChange]);

  // 激活（点击 tab / 从文件树打开文件）时把焦点交给内容区（对齐 VS Code：打开即可输入）。
  // Monaco/TipTap 的 DOM 异步生成且内容异步读盘，就绪时机不定：先试一次，
  // 未就绪则短轮询（≤1s）等待可编辑元素出现后聚焦（幂等，重复聚焦无害）。
  useEffect(() => {
    if (!active || kind !== 'code') return;
    // 渲染预览（MarkdownPreview）无可编辑元素，纯阅读无需聚焦。
    if (isMarkdown && viewMode === 'rendered') return;
    let cancelled = false;
    let attempts = 0;
    const tryFocus = () => {
      if (cancelled) return;
      if (hostRef.current && focusEditableIn(hostRef.current)) return;
      // 编辑器 DOM 尚未生成（Monaco 异步加载 / 内容刚读完），短轮询重试后放弃。
      if (attempts++ < 20) setTimeout(tryFocus, 50);
    };
    tryFocus();
    return () => { cancelled = true; };
  }, [active, kind, isMarkdown, viewMode]);

  // 点击行号变更标记 → 打开 diff 弹窗：重新拉取行标记与该文件 diff，
  // 找到包含该行号的 hunk 后展示。
  const openDiffPopup = useCallback(async (line: number, x: number, y: number) => {
    try {
      await fetchLineDecorations(root, path);
      const diff = await pi.gitFileDiff(root, path);
      if (!diff) return;
      const hunks = extractHunkCompressed(diff);
      // 找到包含该行号的 hunk
      const hunk = hunks.find((h) => {
        const last = h.lines.filter((l) => l.newLine != null).pop();
        return h.newStart <= line && (last ? last.newLine! >= line : true);
      });
      if (hunk) setDiffPopup({ x, y, lines: hunk.lines });
    } catch { /* 弹窗打开失败静默忽略 */ }
  }, [fetchLineDecorations, root, path]);

  const fileName = basenameOf(path) || path || '未命名文件';

  // 选择 markdown 三模式视图 / 源码编辑器。
  const renderCodeView = () => {
    if (isMarkdown && viewMode === 'rendered') {
      return (
        <MarkdownPreview
          content={currentContent}
          filePath={path}
          root={root}
          onOpenFile={onOpenFile}
        />
      );
    }
    if (isMarkdown && viewMode === 'rich') {
      return <RichMarkdownEditor content={currentContent} filePath={path} root={root} onChange={handleChange} onSave={dirty ? doSave : undefined} />;
    }
    return (
      <MonacoCodeEditor
        root={root}
        path={path}
        language={language}
        content={currentContent}
        onChange={handleChange}
        onSave={dirty ? doSave : undefined}
        lineDecorations={lineDecorations}
        onDecorationClick={(line, x, y) => { void openDiffPopup(line, x, y); }}
      />
    );
  };

  return (
    <div className="preview-tab" ref={hostRef}>
      <div className="preview-tab-header">
        <span className="preview-tab-title" title={path}>{fileName}</span>
        {isMarkdown && (
          <span className="code-preview-toggle">
            <button
              type="button"
              className={viewMode === 'rendered' ? 'is-active' : ''}
              onClick={() => setViewMode('rendered')}
            >
              预览
            </button>
            <button
              type="button"
              className={viewMode === 'source' ? 'is-active' : ''}
              onClick={() => setViewMode('source')}
            >
              源码
            </button>
            <button
              type="button"
              className={viewMode === 'rich' ? 'is-active' : ''}
              onClick={() => setViewMode('rich')}
            >
              富文本
            </button>
          </span>
        )}
        {kind === 'code' && !isMarkdown && (
          <span className="drawer-meta">
            {currentContent ? `${countLines(currentContent)} 行` : ''}
          </span>
        )}
        {dirty && <span className="drawer-dirty" title="未保存">●</span>}
        {error && <span className="drawer-error">{error}</span>}
        <span className="drawer-spacer" />
        {kind !== 'binary' && kind !== 'loading' && (
          <button
            type="button"
            className="btn drawer-save"
            disabled={!dirty || saving}
            onClick={() => void doSave()}
          >
            {saving ? '保存中…' : '保存'}
          </button>
        )}
      </div>

      <div className="preview-tab-body">
        {kind === 'code' && renderCodeView()}
        {kind === 'image' && <ImagePreview root={root} path={path} />}
        {kind === 'binary' && !error && <div className="preview-empty">二进制文件，已用系统程序打开。</div>}
        {kind === 'loading' && <div className="preview-empty">加载中…</div>}
        {error && <div className="preview-error">{error}</div>}
      </div>

      {confirmClose && (
        <ConfirmDialog
          title="关闭文件"
          message="文件有未保存的改动，确定关闭？改动将不会写入磁盘。"
          confirmLabel="关闭并丢弃"
          cancelLabel="继续编辑"
          onConfirm={() => { setConfirmClose(false); onClose(); }}
          onCancel={() => setConfirmClose(false)}
        />
      )}

      {diffPopup && (
        <DiffPopup
          x={diffPopup.x}
          y={diffPopup.y}
          lines={diffPopup.lines}
          onClose={() => setDiffPopup(null)}
        />
      )}
    </div>
  );
}
