// Markdown 预览/富文本编辑器共用的路径与链接解析工具（渲染进程内，无 Node 集成）。
// 复用 linkUtils 的 isExternalHref / resolveRelativeLink 做安全判定与相对链接解析。
import { isExternalHref, resolveRelativeLink } from '../linkUtils';

// 取路径中最后一个路径分隔符（/ 或 \\）的位置，无则返回 -1。
function lastSepIndex(p: string): number {
  return Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
}

export function basenameOf(p: string): string {
  const idx = lastSepIndex(p);
  return idx >= 0 ? p.slice(idx + 1) : p;
}

/** 取文件相对 root 的目录段（如 'docs/api'）。根层文件返回 ''。 */
export function dirOf(p: string): string {
  const idx = lastSepIndex(p);
  return idx >= 0 ? p.slice(0, idx) : '';
}

/** root + 相对路径 → 绝对路径（file:// 对 / 与 \\ 均接受）。 */
export function toAbsolutePath(root: string, rel: string): string {
  if (!root) return rel;
  return `${root.replace(/[\\/]+$/, '')}/${rel.replace(/^[\\/]+/, '')}`;
}

/**
 * 把 markdown 链接 href 解析为「相对 root 的目标路径」，供应用内切文件（onOpenFile）。
 * - 外部协议（http/https/mailto/…）→ 返回 null（交给 openExternal）。
 * - file:// 绝对路径 → 转成相对 root 的 relPath（跨 root 则原样返回，由 onOpenFile 做越界校验）。
 * - 相对链接（./a.md、../b.md、a.md、#anchor）→ resolveRelativeLink。
 * - #anchor 等纯片段 → 返回 null（由浏览器/容器自行滚动）。
 */
export function resolveLinkTarget(root: string, filePath: string, href: string): string | null {
  if (!href) return null;
  if (isExternalHref(href)) return null;
  if (href.startsWith('#')) return null;
  if (href.startsWith('file://')) {
    const abs = decodeURIComponent(href.slice('file://'.length).replace(/^\/+/, ''));
    const norm = abs.replace(/\\/g, '/');
    const normRoot = root.replace(/\\/g, '/').replace(/\/+$/, '');
    if (normRoot && norm.startsWith(normRoot + '/')) return norm.slice(normRoot.length + 1);
    return abs;
  }
  const baseDir = dirOf(filePath);
  return resolveRelativeLink(baseDir, href);
}

/** 把 markdown 图片相对 src 解析为可加载的 file:// URL；绝对/网络/data URL 原样返回。 */
export function resolveImageSrc(root: string, filePath: string, src: string): string {
  if (!src) return src;
  if (/^(https?:|data:|file:)/i.test(src)) return src;
  const baseDir = dirOf(filePath);
  const rel = baseDir ? `${baseDir}/${src}` : src;
  const abs = toAbsolutePath(root, rel).replace(/\\/g, '/').replace(/^\/+/, '');
  return `file:///${abs}`;
}
