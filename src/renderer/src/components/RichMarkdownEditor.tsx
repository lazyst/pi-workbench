// Markdown 富文本编辑器（orca 的 RichMarkdownEditor 风格的所见即所得模式）。
// 基于 TipTap 3 + tiptap-markdown：把 markdown 解析为可编辑文档，编辑后序列化回 markdown
// （通过 editor.storage.markdown.getMarkdown()），由 PreviewTab 统一写盘。
// 与 orca 的区别：不实现 orca 的 doc-link / 批注 / 斜杠菜单等内部特性，仅提供标准 GFM 编辑。
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useEditor, EditorContent, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import Placeholder from '@tiptap/extension-placeholder';
import Image from '@tiptap/extension-image';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import { Table, TableRow, TableHeader, TableCell } from '@tiptap/extension-table';
import { Markdown } from 'tiptap-markdown';
import { ContextMenu } from './ContextMenu';
import { useMarkdownContextMenu, buildRichEditorContextMenu } from './editor/useMarkdownContextMenu';
import { resolveImageSrc } from '../lib/mdPath';

interface Props {
  /** 初始 markdown 文本（文件内容）。 */
  content: string;
  /** 当前打开文件的相对路径；变化时重载编辑器内容。 */
  filePath?: string;
  /** 文件所在根目录（root），用于把相对路径图片解析为可加载的 pi-local URL。 */
  root: string;
  onChange?: (markdown: string) => void;
  /** Ctrl/Cmd+S 保存请求。父组件据此落盘。不传则快捷键不拦截。 */
  onSave?: () => void;
  /** 滚动比例变化上报（0~1），供 PreviewTab 跨视图复用滚动位置。 */
  onScrollFraction?: (fraction: number) => void;
  /** 进入本视图时应恢复的滚动比例；变化即恢复一次。 */
  restoreFraction?: number | null;
}

export function RichMarkdownEditor({ content, filePath, root, onChange, onSave, onScrollFraction, restoreFraction }: Props) {
  const lastPath = useRef<string | undefined>(undefined);
  const containerRef = useRef<HTMLDivElement>(null);
  const { menuState, setMenuState, closeMenu } = useMarkdownContextMenu();
  // onScrollFraction 走 ref：高频滚动上报不引发父级 re-render。
  const onScrollFractionRef = useRef(onScrollFraction);
  onScrollFractionRef.current = onScrollFraction;
  const scrollRafRef = useRef<number | null>(null);
  // 记录最近一次「写入编辑器」的内容（用户输入 或 外部重载的 setContent）。
  // 用于区分 content prop 变化的来源：若与编辑器当前内容一致 → 用户输入回流，跳过；
  // 若不一致 → 外部修改（如文件被外部编辑器变更后的自动重载），需 setContent 覆盖。
  const lastSyncedContent = useRef<string>(content);
  // onChange ref：避免 useEditor 的 onUpdate 闭包捕获过期 onChange（useEditor deps
  // 为 [root, filePath]，initialContent 变化时不会重建编辑器，导致 onUpdate 里的
  // onChange 仍是旧值）。用 ref 读取最新值。
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // 扩展 Image：渲染时把相对路径 src 解析为可加载的 pi-local URL（与 MarkdownPreview 的
  // img 组件一致），修复「富文本模式图片不显示」。仅影响 DOM 展示——节点 attrs.src 保持
  // 原相对路径不变，序列化回 markdown 时不会被改写成绝对路径。
  const extensions = useMemo(() => {
    const ResolvedImage = Image.extend({
      renderHTML({ node, HTMLAttributes }) {
        const src = node.attrs.src as string | undefined;
        const resolved = src ? resolveImageSrc(root, filePath ?? '', src) : src;
        return ['img', { ...HTMLAttributes, src: resolved }];
      },
    });
    return [
      // StarterKit 3 已含 Link/Underline，这里关掉其内置 Link 以便用自定义配置（不自动跳转）。
      StarterKit.configure({ link: false }),
      Link.configure({
        openOnClick: false,
        autolink: true,
        HTMLAttributes: { rel: 'noopener noreferrer nofollow' },
      }),
      Placeholder.configure({ placeholder: '在此撰写 Markdown…（支持 GFM 表格、任务列表、公式、代码块）' }),
      ResolvedImage,
      TaskList,
      TaskItem.configure({ nested: true }),
      Table.configure({ resizable: true }),
      TableRow,
      TableHeader,
      TableCell,
      Markdown.configure({
        html: true,
        tightLists: true,
        transformPastedText: true,
        transformCopiedText: true,
        linkify: false,
      }),
    ];
  }, [root, filePath]);

  const editor = useEditor({
    extensions,
    content,
    editorProps: { attributes: { class: 'md-rich-editor' } },
    onUpdate: ({ editor }) => {
      const md = (editor.storage as { markdown?: { getMarkdown: () => string } }).markdown?.getMarkdown();
      if (md != null) {
        // 记录用户输入后的内容，使后续 content prop 回流（与 md 一致）不被误判为外部变更。
        lastSyncedContent.current = md;
        onChangeRef.current?.(md);
      }
    },
    // root/filePath 变化时重建编辑器实例（TipTap 3 语义：deps 变化 → destroy + recreate），
    // 确保新建的 ResolvedImage 扩展使用最新的 root/filePath 解析相对路径图片。
  }, [root, filePath]);

  // 内容同步：文件切换（filePath 变化）或外部内容变更（文件被外部编辑器/命令修改，
  // PreviewTab 的 fsWatchFile 回调更新了 content prop）时，重载编辑器内容。
  // 用户输入回流时 content 与 lastSyncedContent 一致（onUpdate 中已同步），跳过，
  // 避免光标重置。注意不能用 content 作唯一依赖来重载——用户打字时 content 回流会
  // 重置光标。用 emitUpdate=false 避免误触发 onChange / dirty。
  // 编辑器重建（useEditor deps 变化 → destroy + recreate）时，旧实例可能已被销毁，
  // 此时跳过（isDestroyed 为 true），新实例在创建时已携带最新 content。
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    const isFileSwitch = filePath !== lastPath.current;
    if (isFileSwitch) lastPath.current = filePath;
    // 文件切换无条件重载；否则仅当 content 与编辑器当前内容不一致时（外部变更）重载
    if (isFileSwitch || content !== lastSyncedContent.current) {
      lastSyncedContent.current = content;
      editor.commands.setContent(content, { emitUpdate: false });
    }
  }, [editor, filePath, content]);

  // 滚动比例上报：.md-rich-body（overflow:auto）为滚动容器。
  useEffect(() => {
    const el = containerRef.current?.querySelector('.md-rich-body') as HTMLElement | null;
    if (!el) return;
    const onScroll = () => {
      if (scrollRafRef.current != null) return;
      scrollRafRef.current = requestAnimationFrame(() => {
        scrollRafRef.current = null;
        const max = el.scrollHeight - el.clientHeight;
        onScrollFractionRef.current?.(max > 0 ? el.scrollTop / max : 0);
      });
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      el.removeEventListener('scroll', onScroll);
      if (scrollRafRef.current != null) {
        cancelAnimationFrame(scrollRafRef.current);
        scrollRafRef.current = null;
      }
    };
  }, []);

  // 恢复滚动位置：editor 就绪 + restoreFraction 变化时按比例恢复。
  // TipTap 内容异步渲染，用一次性 ResizeObserver 在短窗口内重设几次兜底。
  useEffect(() => {
    if (restoreFraction == null || !editor || editor.isDestroyed) return;
    const el = containerRef.current?.querySelector('.md-rich-body') as HTMLElement | null;
    if (!el) return;
    const apply = () => {
      const max = el.scrollHeight - el.clientHeight;
      if (max > 0) el.scrollTop = Math.round(restoreFraction * max);
    };
    const raf = requestAnimationFrame(apply);
    let retries = 3;
    const ro = new ResizeObserver(() => {
      if (retries-- > 0) apply();
      else ro.disconnect();
    });
    ro.observe(el);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [editor, restoreFraction]);

  // Ctrl/Cmd+S 保存：在容器上监听 keydown，拦截保存快捷键
  useEffect(() => {
    const el = containerRef.current;
    if (!el || !onSave) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        onSave();
      }
    };
    el.addEventListener('keydown', onKeyDown);
    return () => el.removeEventListener('keydown', onKeyDown);
  }, [onSave]);

  // 右键菜单：在容器上阻止默认 contextmenu，改由本组件接管
  const onContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    if (!editor) return;
    const items = buildRichEditorContextMenu(editor, toggleLink, pickImage);
    setMenuState({ x: e.clientX, y: e.clientY, items });
  }, [editor, setMenuState]);

  // Toolbar 中的链接/图片操作（与右键菜单共享）
  const toggleLink = useCallback(() => {
    if (!editor) return;
    const prev = (editor.getAttributes('link').href as string | undefined) ?? 'https://';
    const url = window.prompt('链接地址（http(s):// 或相对路径）：', prev);
    if (url === null) return;
    if (url === '') {
      editor.chain().focus().extendMarkRange('link').unsetLink().run();
      return;
    }
    editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run();
  }, [editor]);

  const pickImage = useCallback(() => {
    if (!editor) return;
    const url = window.prompt('图片地址（URL 或相对路径）：', '');
    if (url) editor.chain().focus().setImage({ src: url }).run();
  }, [editor]);

  return (
    <div className="md-rich" ref={containerRef} onContextMenu={onContextMenu}>
      <div className="md-rich-toolbar">{editor && <RichToolbar editor={editor} />}</div>
      <div className="md-rich-body">
        <EditorContent editor={editor} />
      </div>
      {menuState && (
        <ContextMenu x={menuState.x} y={menuState.y} items={menuState.items} onClose={closeMenu} />
      )}
    </div>
  );
}

function RichToolbar({ editor }: { editor: Editor }) {
  const cls = (active: boolean) => `md-tb-btn${active ? ' is-active' : ''}`;

  const setLink = () => {
    const prev = (editor.getAttributes('link').href as string | undefined) ?? 'https://';
    const url = window.prompt('链接地址（http(s):// 或相对路径）：', prev);
    if (url === null) return;
    if (url === '') {
      editor.chain().focus().extendMarkRange('link').unsetLink().run();
      return;
    }
    editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run();
  };

  const setImg = () => {
    const url = window.prompt('图片地址（URL 或相对路径）：', '');
    if (url) editor.chain().focus().setImage({ src: url }).run();
  };

  const addTable = () =>
    editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run();

  return (
    <>
      <button type="button" className={cls(editor.isActive('bold'))} title="加粗" onClick={() => editor.chain().focus().toggleBold().run()}><b>B</b></button>
      <button type="button" className={cls(editor.isActive('italic'))} title="斜体" onClick={() => editor.chain().focus().toggleItalic().run()}><i>I</i></button>
      <button type="button" className={cls(editor.isActive('underline'))} title="下划线" onClick={() => editor.chain().focus().toggleUnderline().run()}><u>U</u></button>
      <button type="button" className={cls(editor.isActive('strike'))} title="删除线" onClick={() => editor.chain().focus().toggleStrike().run()}><s>S</s></button>
      <button type="button" className={cls(editor.isActive('code'))} title="行内代码" onClick={() => editor.chain().focus().toggleCode().run()}>&lt;/&gt;</button>
      <span className="md-tb-sep" />
      <button type="button" className={cls(editor.isActive('heading', { level: 1 }))} title="标题 1" onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}>H1</button>
      <button type="button" className={cls(editor.isActive('heading', { level: 2 }))} title="标题 2" onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}>H2</button>
      <button type="button" className={cls(editor.isActive('heading', { level: 3 }))} title="标题 3" onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}>H3</button>
      <span className="md-tb-sep" />
      <button type="button" className={cls(editor.isActive('bulletList'))} title="无序列表" onClick={() => editor.chain().focus().toggleBulletList().run()}>•</button>
      <button type="button" className={cls(editor.isActive('orderedList'))} title="有序列表" onClick={() => editor.chain().focus().toggleOrderedList().run()}>1.</button>
      <button type="button" className={cls(editor.isActive('taskList'))} title="任务列表" onClick={() => editor.chain().focus().toggleTaskList().run()}>☑</button>
      <button type="button" className={cls(editor.isActive('blockquote'))} title="引用" onClick={() => editor.chain().focus().toggleBlockquote().run()}>❝</button>
      <button type="button" className={cls(editor.isActive('codeBlock'))} title="代码块" onClick={() => editor.chain().focus().toggleCodeBlock().run()}>{'{ }'}</button>
      <button type="button" title="分割线" onClick={() => editor.chain().focus().setHorizontalRule().run()}>―</button>
      <span className="md-tb-sep" />
      <button type="button" className={cls(editor.isActive('link'))} title="链接" onClick={setLink}>🔗</button>
      <button type="button" title="图片" onClick={setImg}>🖼</button>
      <button type="button" title="表格" onClick={addTable}>▦</button>
    </>
  );
}
