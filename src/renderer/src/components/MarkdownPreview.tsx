// Markdown 渲染预览（orca 风格）。
// 插件链与 orca 的 MarkdownPreview 对齐：remark(gfm/breaks/frontmatter/math)
// + rehype(raw → sanitize → slug → highlight → katex)。渲染产物套用 .markdown-file-preview 样式。
// 与 orca 的区别：去掉 orca 特有的 runtime/doc-link/批注模块，链接路由改用 pi-desktop 的
// linkUtils + openExternal，富文本编辑不在此组件（由 RichMarkdownEditor 负责）。
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import type { PluggableList } from 'unified';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import remarkFrontmatter from 'remark-frontmatter';
import remarkMath from 'remark-math';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import rehypeSlug from 'rehype-slug';
import rehypeHighlight from 'rehype-highlight';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import 'highlight.js/styles/github-dark.css';

import { MermaidBlock } from './MermaidBlock';
import { pi } from '../ipc';
import { isExternalHref } from '../linkUtils';
import { basenameOf, resolveImageSrc, resolveLinkTarget } from '../lib/mdPath';
import { ContextMenu } from './ContextMenu';
import { useMarkdownContextMenu, buildPreviewContextMenu, findLinkHref } from './editor/useMarkdownContextMenu';

// 与 orca 一致的 sanitize schema：放行 GFM 表格/任务列表用的 input、details/summary、
// 标题 id（slug）、代码块 language-/hljs 类、file:// 协议（留给点击处理器做安全决策）。
// 图片 src 额外放行 pi-local（自定义本地文件协议，见 mdPath.resolveImageSrc），
// 否则相对路径图片会被 rehype-sanitize 清空 src 导致不显示。
const sanitizeSchema = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames ?? []), 'details', 'summary', 'kbd', 'sub', 'sup', 'ins'],
  protocols: {
    ...defaultSchema.protocols,
    href: [...(defaultSchema.protocols?.href ?? []), 'file'],
    src: [...(defaultSchema.protocols?.src ?? []), 'file', 'pi-local'],
  },
  attributes: {
    ...defaultSchema.attributes,
    '*': [...(defaultSchema.attributes?.['*'] ?? []), 'id'],
    a: [...(defaultSchema.attributes?.a ?? []), 'href', 'title'],
    code: [
      ...(defaultSchema.attributes?.code ?? []),
      ['className', /^language-[\w-]+$/],
      ['className', 'hljs'],
    ],
    div: [...(defaultSchema.attributes?.div ?? []), ['className', /^language-[\w-]+$/], 'align'],
    h1: [...(defaultSchema.attributes?.h1 ?? []), 'id'],
    h2: [...(defaultSchema.attributes?.h2 ?? []), 'id'],
    h3: [...(defaultSchema.attributes?.h3 ?? []), 'id'],
    h4: [...(defaultSchema.attributes?.h4 ?? []), 'id'],
    h5: [...(defaultSchema.attributes?.h5 ?? []), 'id'],
    h6: [...(defaultSchema.attributes?.h6 ?? []), 'id'],
    img: [...(defaultSchema.attributes?.img ?? []), 'src', 'alt', 'title', 'width', 'height'],
    input: [...(defaultSchema.attributes?.input ?? []), 'type', 'checked', 'disabled'],
    pre: [...(defaultSchema.attributes?.pre ?? []), ['className', /^language-[\w-]+$/]],
    span: [...(defaultSchema.attributes?.span ?? []), ['className', /^hljs(?:-[\w-]+)?$/]],
    td: [...(defaultSchema.attributes?.td ?? []), 'align'],
    th: [...(defaultSchema.attributes?.th ?? []), 'align'],
  },
};

// 插件链固定为模块级常量：react-markdown@10 的 Markdown 组件每次 render 都同步全量
// 重跑 unified 管道（parse + remark/rehype 插件链），且没有内部缓存——只有保证传入
// 的插件/props 引用稳定，父组件 re-render 时才不会白白重跑一遍 KaTeX/highlight。
const remarkPlugins: PluggableList = [remarkGfm, remarkBreaks, remarkFrontmatter, remarkMath];
const rehypePlugins: PluggableList = [
  rehypeRaw,
  [rehypeSanitize, sanitizeSchema],
  rehypeSlug,
  rehypeHighlight,
  rehypeKatex,
];
const passthroughUrl = (url: string) => url;

interface TocItem {
  id: string;
  text: string;
  level: number;
}

function nodeText(node: ReactNode): string {
  if (node == null || node === false || node === true) return '';
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join('');
  if (typeof node === 'object' && 'props' in node) {
    return nodeText((node as { props?: { children?: ReactNode } }).props?.children);
  }
  return '';
}

interface Props {
  content: string;
  /** 文件相对 root 的路径（如 docs/readme.md），用于解析相对链接/图片。 */
  filePath: string;
  root: string;
  /** 预览内相对链接点击 → 在应用内切到目标文件。 */
  onOpenFile?: (relPath: string, fileName: string, root: string) => void;
}

// memo 比较：只关注影响渲染产物的 content/filePath/root。onOpenFile 等回调变化时
// 不重渲染（回调经 ref 调用，函数体总能拿到最新引用），从而把父级 store 刷新引发的
// re-render 完全挡在 ReactMarkdown 之外。
const markdownPreviewPropsEqual = (prev: Props, next: Props): boolean =>
  prev.content === next.content &&
  prev.filePath === next.filePath &&
  prev.root === next.root;

function MarkdownPreviewImpl({ content, filePath, root, onOpenFile }: Props) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const [toc, setToc] = useState<TocItem[]>([]);
  const tocRef = useRef<TocItem[]>([]);
  const { menuState, setMenuState, closeMenu } = useMarkdownContextMenu();
  // 回调走 ref：components 的 useMemo 不依赖 onOpenFile，引用稳定，memo 比较也因此有效。
  const onOpenFileRef = useRef(onOpenFile);
  onOpenFileRef.current = onOpenFile;

  // 渲染后从 DOM 收集标题（id 由 rehype-slug 生成），保证 TOC 锚点与正文一致。
  // content 不变时（如父级 store 刷新触发的 re-render）不重新收集；仅在 TOC 真实变化
  // 时才 setState，避免无谓的额外一次状态更新。
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const heads = Array.from(el.querySelectorAll('h1,h2,h3,h4,h5,h6')) as HTMLElement[];
    const newToc = heads.map((h) => ({ id: h.id, text: h.textContent ?? '', level: Number(h.tagName[1]) }));
    const cur = tocRef.current;
    const changed =
      newToc.length !== cur.length ||
      newToc.some((t, i) => t.id !== cur[i].id || t.text !== cur[i].text || t.level !== cur[i].level);
    if (changed) {
      tocRef.current = newToc;
      setToc(newToc);
    }
  }, [content]);

  const onTocClick = (id: string) => {
    const el = bodyRef.current?.querySelector(`#${CSS.escape(id)}`);
    el?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
  };

  // components 引用稳定（仅 root/filePath 变化才重建）：ReactMarkdown 的子树因此可被
  // 复用，配合下面的 rendered useMemo，父级 re-render 时不会重建 ReactMarkdown 元素。
  const components = useMemo<Components>(
    () => ({
      // 代码块：mermaid 走专用渲染；其余加复制按钮。
      pre: ({ children }) => {
        // children 可能是单个元素或数组，统一收集后找 type === 'code' 的子元素（mermaid 判断用）。
        const codeEl = (Array.isArray(children) ? children : [children]).find(
          (c) => typeof c === 'object' && c !== null && (c as { type?: unknown }).type === 'code',
        ) ?? null;
        const codeProps = codeEl ? (codeEl as { props?: { className?: string; children?: ReactNode } }).props : null;
        const lang = codeProps?.className ? /language-(\w+)/.exec(codeProps.className)?.[1] : undefined;
        const text = codeProps ? nodeText(codeProps.children) : '';
        if (lang === 'mermaid') return <MermaidBlock code={text} />;
        return (
          <div className="md-codeblock">
            <button
              type="button"
              className="md-copy"
              onClick={() => {
                navigator.clipboard?.writeText(text).catch(() => {});
              }}
            >
              复制
            </button>
            <pre>{children}</pre>
          </div>
        );
      },
      // 链接：外部 → openExternal；相对/文件链接 → 应用内切文件；#anchor → 默认滚动。
      a: ({ href, children, node, ...rest }) => {
        const handle = (e: React.MouseEvent) => {
          if (!href) return;
          if (isExternalHref(href)) {
            e.preventDefault();
            void pi.openExternal(href).catch(() => {});
            return;
          }
          const rel = resolveLinkTarget(root, filePath, href);
          if (rel) {
            e.preventDefault();
            onOpenFileRef.current?.(rel, basenameOf(rel), root);
          }
        };
        return (
          <a href={href} onClick={handle} {...rest}>
            {children}
          </a>
        );
      },
      // 图片：相对路径解析为 file:// 以在渲染进程内加载。
      img: ({ src, alt, node, ...rest }) => {
        const finalSrc = resolveImageSrc(root, filePath, typeof src === 'string' ? src : '');
        return <img src={finalSrc} alt={alt} {...rest} />;
      },
    }),
    [root, filePath],
  );

  // 渲染结果缓存：content 或 components 引用变化时才重建 ReactMarkdown 元素。
  // 组件内部 setState（setToc / 右键菜单）触发的 re-render 不经过 memo，但此时
  // useMemo 命中 → 复用旧元素 → React 跳过 ReactMarkdown 整棵子树，绝不重跑管道。
  const rendered = useMemo(
    () => (
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        // raw HTML 先 sanitize 再交给受信任的渲染器；KaTeX 与语法高亮在 sanitize 之后运行，
        // 因此无需在 schema 里放行 KaTeX 生成的标签，公式/代码仍按 VS Code 风格正常渲染。
        rehypePlugins={rehypePlugins}
        components={components}
        urlTransform={passthroughUrl}
      >
        {content}
      </ReactMarkdown>
    ),
    [content, components],
  );

  // 右键菜单：接管 contextmenu，构建预览菜单项
  const onContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const target = e.target instanceof HTMLElement ? e.target : null;
    const linkHref = target ? findLinkHref(target) : null;
    const items = buildPreviewContextMenu(linkHref);
    setMenuState({ x: e.clientX, y: e.clientY, items });
  }, [setMenuState]);

  return (
    <div className="md-preview" onContextMenu={onContextMenu}>
      <div className="markdown-file-preview" ref={bodyRef}>
        {rendered}
      </div>
      {toc.length > 1 && (
        <aside className="md-toc">
          <div className="md-toc-title">目录</div>
          <div className="md-toc-list">
            {toc.map((t, i) => (
              <button
                key={t.id || i}
                type="button"
                className={`md-toc-item lvl-${t.level}`}
                title={t.text}
                onClick={() => onTocClick(t.id)}
              >
                {t.text}
              </button>
            ))}
          </div>
        </aside>
      )}
      {menuState && (
        <ContextMenu x={menuState.x} y={menuState.y} items={menuState.items} onClose={closeMenu} />
      )}
    </div>
  );
}

export const MarkdownPreview = memo<Props>(MarkdownPreviewImpl, markdownPreviewPropsEqual);