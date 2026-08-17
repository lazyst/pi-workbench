// Git panel — IDEA Commit Dialog 风格。
// 三区：Changes to be committed / Unversioned Files / Modified (not staged)
// 每个区内的文件按目录组织为可展开的树，每个文件带 checkbox 和 IDEA 彩色圆点图标。
// 底部：提交信息 + 提交按钮。
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { pi } from '../ipc';
import { ContextMenu, type ContextMenuItem } from './ContextMenu';
import { useSplitStore } from '../store/splitStore';
import { toAbsolutePath } from '../lib/mdPath';

// ── Types ──

interface LogEntry {
  hash: string;
  author: string;
  date: string;
  message: string;
}

interface GitResource {
  path: string;
  /** 'staged' (index only), 'unstaged' (working tree only), 'both' (both have changes), 'untracked' */
  group: 'staged' | 'unstaged' | 'untracked';
  /** Badge letter: M / A / D / R / C / U / T / ? */
  badge: string;
  /** Rename target path (only for R status) */
  renameTarget?: string;
}

interface FileTreeNode {
  name: string;               // 文件名或目录名
  path: string;               // 完整相对路径
  isDir: boolean;
  status: 'modified' | 'new' | 'deleted' | 'untracked' | 'conflict';
  children?: FileTreeNode[];  // 目录子节点
}

interface Props {
  cwd: string;
  onOpenWorkDiff: (cwd: string) => void;
  onOpenCommit: (cwd: string, hash: string) => void;
  /** 点击 Git 文件列表中的文件 → 打开编辑器 */
  onOpenFile?: (relPath: string, fileName: string, root: string) => void;
  /** 打开提交中某文件的 diff tab */
  onOpenCommitFile?: (cwd: string, hash: string, filePath: string) => void;
}

// ── Porcelain parser ──

function decodeGitPath(p: string): string {
  if (!p.startsWith('"')) return p;
  const inner = p.slice(1, -1);
  const bytes: number[] = [];
  let i = 0;
  while (i < inner.length) {
    const c = inner[i];
    if (c === '\\' && /^[0-7]/.test(inner[i + 1] ?? '')) {
      let val = 0;
      let j = 0;
      while (j < 3 && /^[0-7]/.test(inner[i + 1 + j] ?? '')) {
        val = val * 8 + Number(inner[i + 1 + j]);
        j++;
      }
      bytes.push(val);
      i += 1 + j;
    } else if (c === '\\') {
      const map: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, "'": 39, '\\': 92 };
      bytes.push(map[inner[i + 1]] ?? c.charCodeAt(0));
      i += 2;
    } else {
      if (c.charCodeAt(0) < 0x80) {
        bytes.push(c.charCodeAt(0));
      } else {
        for (const b of new TextEncoder().encode(c)) {
          bytes.push(b);
        }
      }
      i++;
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

/** 把 ISO 日期格式化为相对时间（中文）。 */
function formatRelative(dateStr: string): string {
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return dateStr;
  const diff = Date.now() - d.getTime();
  if (diff < 0) return '刚刚';
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return '刚刚';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day} 天前`;
  return d.toLocaleDateString('zh-CN');
}

export function parseResources(porcelain: string): GitResource[] {
  const resources: GitResource[] = [];
  for (const line of porcelain.split('\n')) {
    if (!line.trim()) continue;
    if (line.startsWith('## ')) continue;
    const xy = line.substring(0, 2);
    const pathPart = line.substring(3).trim();
    const [fromPath, toPath] = pathPart.includes(' -> ') ? pathPart.split(' -> ') : [pathPart, undefined];
    const actualPath = decodeGitPath(toPath?.trim() ?? fromPath.trim());

    const x = xy[0];
    const y = xy[1];

    if (xy === '??') {
      resources.push({ path: actualPath, group: 'untracked', badge: '?' });
      continue;
    }

    const isConflict = x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D');
    if (isConflict) {
      resources.push({ path: actualPath, group: 'unstaged', badge: '!' });
      continue;
    }

    let stagedBadge = '';
    if (x !== ' ' && x !== '?') {
      stagedBadge = STAGED_BADGE[x] ?? 'M';
    }

    let unstagedBadge = '';
    if (y !== ' ' && y !== '?' && y !== '!') {
      unstagedBadge = UNSTAGED_BADGE[y] ?? 'M';
    }

    if (stagedBadge) {
      resources.push({
        path: actualPath,
        group: 'staged',
        badge: stagedBadge,
        renameTarget: toPath ? decodeGitPath(toPath.trim()) : undefined,
      });
    }
    if (unstagedBadge) {
      resources.push({
        path: actualPath,
        group: 'unstaged',
        badge: unstagedBadge,
      });
    }
  }
  return resources;
}

// ── 文件树构建 ──

/** 根据 badge 推导 IDEA 风格的状态分类 */
function deduceStatus(badge: string): FileTreeNode['status'] {
  switch (badge) {
    case 'M': return 'modified';
    case 'A': case '?': return 'new';
    case 'D': return 'deleted';
    case '!': case 'U': return 'conflict';
    default: return 'untracked';
  }
}

// git status --porcelain 的状态字母 → badge 映射表：第一列 → staged，第二列 → unstaged。
// 在 parseResources 的循环内重复创建浪费内存，提为模块级常量。
const STAGED_BADGE: Record<string, string> = { ' ': '', M: 'M', A: 'A', D: 'D', R: 'R', C: 'C', '?': '' };
const UNSTAGED_BADGE: Record<string, string> = { ' ': '', M: 'M', D: 'D', A: 'A', '?': '' };

/** 递归收集目录下所有文件路径。 */
function getDescendantFiles(node: FileTreeNode): string[] {
  const files: string[] = [];
  const walk = (n: FileTreeNode) => {
    if (!n.isDir) { files.push(n.path); return; }
    (n.children ?? []).forEach(walk);
  };
  walk(node);
  return files;
}

/** 把平铺的 GitResource[] 转为目录树，用于渲染。 */
export function buildFileTree(resources: GitResource[]): FileTreeNode[] {
  const root: FileTreeNode[] = [];
  const dirMap = new Map<string, FileTreeNode>();

  /** 确保目录节点及其所有祖先节点存在，返回该目录节点。 */
  const ensureDir = (dirPath: string): FileTreeNode | undefined => {
    if (!dirPath) return undefined;
    if (dirMap.has(dirPath)) return dirMap.get(dirPath);
    const dirs = dirPath.split('/');
    const node: FileTreeNode = {
      name: dirs[dirs.length - 1] ?? '',
      path: dirPath,
      isDir: true,
      status: 'modified',
      children: [],
    };
    dirMap.set(dirPath, node);
    const parent = ensureDir(dirs.slice(0, -1).join('/'));
    if (parent) parent.children?.push(node);
    else root.push(node);
    return node;
  };

  for (const r of resources) {
    // 路径末尾带 / 表示这是一个目录条目（如 `?? 桌面运维工程师课程笔记/`）。
    // git status --untracked-files=normal 会把整个未跟踪目录折叠成一个条目，
    // 不列出内部文件。因此这里创建目录节点（children 为空），但不创建空文件名字节点。
    if (r.path.endsWith('/')) {
      ensureDir(r.path.slice(0, -1));
      continue;
    }

    const parts = r.path.split('/');
    const name = parts[parts.length - 1] ?? '';
    const dirPath = parts.slice(0, -1).join('/');

    // 确保目录节点存在
    ensureDir(dirPath);

    const fileNode: FileTreeNode = {
      name,
      path: r.path,
      isDir: false,
      status: deduceStatus(r.badge),
    };

    if (dirPath) {
      dirMap.get(dirPath)?.children?.push(fileNode);
    } else {
      root.push(fileNode);
    }
  }

  // 排序：目录在前，文件在后；各自按名称排序
  const sortNodes = (nodes: FileTreeNode[]) => {
    nodes.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name, 'zh-CN');
    });
    for (const n of nodes) {
      if (n.children) sortNodes(n.children);
    }
  };
  sortNodes(root);

  return root;
}

// ── UI 组件 ──

function Spinner() {
  return <span className="git-spinner" title="Operation in progress">⟳</span>;
}

/** IDEA 状态圆点图标 */
function IdeaIcon({ status }: { status: FileTreeNode['status'] }) {
  return <span className={`git-idea-icon ${status}`} />;
}

/** 文件树节点：目录或文件 */
function FileTreeRow({
  node,
  checkedFiles,
  onToggleCheck,
  expandedDirs,
  onToggleDir,
  onOpenDiff,
  onContextMenu,
  depth = 0,
}: {
  node: FileTreeNode;
  checkedFiles: Set<string>;
  onToggleCheck: (node: FileTreeNode) => void;
  expandedDirs: Set<string>;
  onToggleDir: (path: string) => void;
  onOpenDiff: (path: string) => void;
  onContextMenu: (e: React.MouseEvent, node: FileTreeNode) => void;
  depth?: number;
}) {
  const indent = depth * 16;

  if (node.isDir) {
    const descendants = getDescendantFiles(node);
    const isEmpty = descendants.length === 0;
    const checkedCount = descendants.filter((f) => checkedFiles.has(f)).length;
    const allChecked = !isEmpty && checkedCount === descendants.length;
    const someChecked = checkedCount > 0 && !allChecked;
    const isExpanded = expandedDirs.has(node.path);

    // 空目录：渲染为文件级条目（无 subpath，checkbox 无级联效果）。
    if (isEmpty) {
      return (
        <div
          className="git-tree-file"
          style={{ paddingLeft: 12 + indent }}
          onContextMenu={(e) => onContextMenu(e, node)}
        >
          <input
            type="checkbox"
            className="git-file-checkbox"
            checked={false}
            onChange={() => onToggleCheck(node)}
            onClick={(e) => e.stopPropagation()}
          />
          <span className="git-tree-dir-icon">📁</span>
          <span className="git-tree-file-name" onClick={() => onOpenDiff(node.path)}>{node.name}</span>
          <span className="git-tree-file-dir">/</span>
        </div>
      );
    }

    return (
      <>
        <div
          className="git-tree-dir"
          style={{ paddingLeft: 12 + indent }}
          onClick={() => onToggleDir(node.path)}
          onContextMenu={(e) => onContextMenu(e, node)}
        >
          <input
            type="checkbox"
            className="git-file-checkbox git-dir-checkbox"
            checked={allChecked}
            ref={(el) => { if (el) el.indeterminate = someChecked; }}
            onChange={() => onToggleCheck(node)}
            onClick={(e) => e.stopPropagation()}
          />
          <span className={`git-chevron${isExpanded ? ' expanded' : ''}`} />
          <IdeaIcon status={node.status} />
          <span className="git-tree-dir-name">{node.name}</span>
          <span className="git-tree-dir-count">/</span>
        </div>
        {isExpanded && node.children?.map((child) => (
          <FileTreeRow
            key={child.path}
            node={child}
            checkedFiles={checkedFiles}
            onToggleCheck={onToggleCheck}
            expandedDirs={expandedDirs}
            onToggleDir={onToggleDir}
            onOpenDiff={onOpenDiff}
            onContextMenu={onContextMenu}
            depth={depth + 1}
          />
        ))}
      </>
    );
  }

  return (
    <div
      className="git-tree-file"
      style={{ paddingLeft: 12 + indent }}
      onContextMenu={(e) => onContextMenu(e, node)}
    >
      <input
        type="checkbox"
        className="git-file-checkbox"
        checked={checkedFiles.has(node.path)}
        onChange={() => onToggleCheck(node)}
        onClick={(e) => e.stopPropagation()}
      />
      <IdeaIcon status={node.status} />
      <span className="git-tree-file-name" onClick={() => onOpenDiff(node.path)}>{node.name}</span>
      {node.path.includes('/') && (
        <span className="git-tree-file-dir">{node.path.substring(0, node.path.lastIndexOf('/') + 1)}</span>
      )}
    </div>
  );
}

/** 可折叠的文件分区 */
function FileSection({
  title,
  count,
  children,
  defaultExpanded = true,
  sectionKey,
  expanded,
  onToggle,
}: {
  title: string;
  count: number;
  children: React.ReactNode;
  defaultExpanded?: boolean;
  sectionKey: string;
  expanded: Record<string, boolean>;
  onToggle: (key: string) => void;
}) {
  const isExpanded = expanded[sectionKey] ?? defaultExpanded;
  return (
    <div className="git-file-section">
      <div className="git-file-section-title" onClick={() => onToggle(sectionKey)}>
        <span className={`git-chevron${isExpanded ? ' expanded' : ''}`} />
        <span className="git-section-label">{title}</span>
        <span className="git-section-count">{count}</span>
      </div>
      <div className={`git-file-section-body${isExpanded ? ' expanded' : ''}`}>
          {count === 0 ? (
            <div className="git-section-empty">No {title.toLowerCase()}</div>
          ) : children}
        </div>
    </div>
  );
}

// ── Main component ──

export function GitView({ cwd, onOpenWorkDiff, onOpenCommit, onOpenFile, onOpenCommitFile }: Props) {
  // ── State ──
  const [branches, setBranches] = useState<Array<{ name: string; current: boolean; remote: boolean }>>([]);
  const [showBranchPicker, setShowBranchPicker] = useState(false);
  const [status, setStatus] = useState<{
    isGit: boolean; branch: string | null; additions: number; deletions: number;
    ahead: number; behind: number; porcelain: string;
  } | null>(null);
  const [resources, setResources] = useState<GitResource[]>([]);
  const [commitMsg, setCommitMsg] = useState('');
  const [commitError, setCommitError] = useState<string | null>(null);
  const [commitSuccess, setCommitSuccess] = useState(false);
  const [isCommitting, setIsCommitting] = useState(false);
  const [activeOps, setActiveOps] = useState<Set<string>>(new Set());

  // 展开/折叠的文件分区
  const [sectionExpanded, setSectionExpanded] = useState<Record<string, boolean>>({
    staged: true, untracked: true, unstaged: true,
  });

  // 展开/折叠的目录
  const [dirExpanded, setDirExpanded] = useState<Set<string>>(new Set());

  // 选中的文件路径 → checkbox 状态
  const [checkedFiles, setCheckedFiles] = useState<Set<string>>(new Set());

  // 作者
  const [author, setAuthor] = useState('');

  // ── 提交历史（右侧栏 section）──
  const [historyExpanded, setHistoryExpanded] = useState(false);
  const [historyAllBranches, setHistoryAllBranches] = useState(false);
  const [historyCommits, setHistoryCommits] = useState<LogEntry[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  /** 展开的提交 hash（点击提交行展开/收起其改动文件）。 */
  const [expandedCommit, setExpandedCommit] = useState<string | null>(null);
  /** 展开提交的改动文件列表。 */
  const [expandedCommitFiles, setExpandedCommitFiles] = useState<Array<{ status: string; path: string; oldPath?: string }>>([]);
  const [commitFilesLoading, setCommitFilesLoading] = useState(false);

  // ── 悬浮预览 ──
  const [hoverCommit, setHoverCommit] = useState<{ x: number; y: number; entry: LogEntry } | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── 衍生数据 ──

  const staged = resources.filter((r) => r.group === 'staged');
  const unstaged = resources.filter((r) => r.group === 'unstaged');
  const untracked = resources.filter((r) => r.group === 'untracked');

  // 仅未暂存的 modified 文件（排除已暂存的）
  const unstagedModified = unstaged.filter((r) => r.badge === 'M' || r.badge === 'D');

  const stagedTree = buildFileTree(staged);
  const untrackedTree = buildFileTree(untracked);
  const unstagedTree = buildFileTree(unstagedModified);

  const canCommit = commitMsg.trim().length > 0 && checkedFiles.size > 0 && !isCommitting;

  // ── Data fetching ──

  const refresh = useCallback(async () => {
    if (!cwd) { setStatus(null); setResources([]); return; }
    try {
      const s = await pi.gitStatus(cwd);
      setStatus(s);
      if (s.isGit) {
        const br = await pi.gitBranches(cwd).catch(() => []);
        setBranches(br);
        setResources(parseResources(s.porcelain ?? ''));
      } else {
        setResources([]);
      }
    } catch {
      setStatus(null); setResources([]);
    }
  }, [cwd]);

  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshQueued = useRef(false);
  const scheduleRefresh = useCallback(() => {
    if (refreshQueued.current) return;
    refreshQueued.current = true;
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(() => {
      refreshQueued.current = false;
      refreshTimer.current = null;
      void refresh();
    }, 800);
  }, [refresh]);

  useEffect(() => {
    if (!cwd) return;
    void refresh();
    const unsubscribe = pi.gitWatch(cwd, scheduleRefresh);
    return () => {
      unsubscribe();
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
    };
  }, [cwd, refresh, scheduleRefresh]);

  useEffect(() => {
    if (!cwd) return;
    const unsub = pi.onGitOperation?.((payload) => {
      if (payload.cwd !== cwd) return;
      setActiveOps((prev) => {
        const next = new Set(prev);
        if (payload.running) next.add(payload.kind);
        else next.delete(payload.kind);
        return next;
      });
      if (!payload.running) scheduleRefresh();
    });
    return () => unsub?.();
  }, [cwd, scheduleRefresh]);

  // 初始化 author
  useEffect(() => {
    if (!cwd) return;
    pi.gitConfigUser?.(cwd).then((name) => {
      if (name) setAuthor(name);
    }).catch(() => {});
  }, [cwd]);

  // ── 操作 ──

  const handleToggleSection = useCallback((key: string) => {
    setSectionExpanded((p) => ({ ...p, [key]: !p[key] }));
  }, []);

  const handleToggleDir = useCallback((path: string) => {
    setDirExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const handleToggleCheck = useCallback((node: FileTreeNode) => {
    setCheckedFiles((prev) => {
      const next = new Set(prev);
      if (node.isDir) {
        // 目录：全选/全不选其所有后代文件。若全部已选则取消，否则全选。
        const files = getDescendantFiles(node);
        const allChecked = files.length > 0 && files.every((f) => next.has(f));
        files.forEach((f) => {
          if (allChecked) next.delete(f);
          else next.add(f);
        });
        return next;
      }
      if (next.has(node.path)) next.delete(node.path);
      else next.add(node.path);
      return next;
    });
  }, []);

  const handleOpenDiff = useCallback((path: string) => {
    onOpenFile?.(path, path.split('/').pop() ?? path, cwd);
  }, [onOpenFile, cwd]);

  // ── 右键菜单 ──
  const [menu, setMenu] = useState<{ x: number; y: number; items: ContextMenuItem[] } | null>(null);

  const handleContextMenu = useCallback((e: React.MouseEvent, node: FileTreeNode) => {
    e.preventDefault();
    e.stopPropagation();
    const items: ContextMenuItem[] = [
      {
        label: '显示差异',
        onClick: () => handleOpenDiff(node.path),
      },
      {
        label: '撤销更改',
        danger: true,
        onClick: () => {
          void pi.gitRevert(cwd, [node.path]).then((r) => {
            if (!r.success) alert(`撤销失败: ${r.error ?? '未知错误'}`);
            scheduleRefresh();
          });
        },
      },
    ];
    // 非文件节点（文件或空目录）才可添加 .gitignore
    if (!node.isDir || !node.children || node.children.length === 0) {
      items.push({
        label: '添加到 .gitignore',
        onClick: () => {
          void pi.gitAddToGitignore(cwd, node.path, node.isDir).then((r) => {
            if (!r.success && r.error !== 'Already in .gitignore') alert(`添加到 .gitignore 失败: ${r.error}`);
            scheduleRefresh();
          });
        },
      });
    }
    items.push(
      { label: '', kind: 'separator' },
      {
        label: '复制路径',
        onClick: () => {
          const abs = toAbsolutePath(cwd, node.path);
          void navigator.clipboard.writeText(abs).catch(() => {});
        },
      },
      {
        label: '复制相对路径',
        onClick: () => void navigator.clipboard.writeText(node.path).catch(() => {}),
      },
      { label: '', kind: 'separator' },
      {
        label: '在文件管理器中显示',
        onClick: () => {
          const abs = toAbsolutePath(cwd, node.path);
          void pi.fsShowInFolder(abs).catch(() => {});
        },
      },
    );
    if (!node.isDir) {
      items.push({
        label: '用系统默认程序打开',
        onClick: () => {
          const abs = toAbsolutePath(cwd, node.path);
          void pi.fsOpenWithSystem(abs).catch(() => {});
        },
      });
    }
    setMenu({ x: e.clientX, y: e.clientY, items });
  }, [cwd, handleOpenDiff, scheduleRefresh]);

  // ── 提交历史 ──
  const loadHistory = useCallback((allBranches: boolean) => {
    setHistoryLoading(true);
    pi.gitLogAdvanced(cwd, { limit: 50, allBranches }).then((list) => {
      setHistoryCommits(list);
    }).finally(() => setHistoryLoading(false));
  }, [cwd]);

  const handleToggleHistory = useCallback(() => {
    setHistoryExpanded((v) => {
      const nv = !v;
      if (nv && historyCommits.length === 0) {
        loadHistory(historyAllBranches);
      }
      return nv;
    });
  }, [historyCommits.length, loadHistory, historyAllBranches]);

  // 切换分支 / 切换全部/当前后刷新提交历史（如果已展开）
  useEffect(() => {
    if (historyExpanded) {
      loadHistory(historyAllBranches);
    }
  }, [cwd, status?.branch, historyAllBranches, historyExpanded, loadHistory]);

  const handleToggleCommit = useCallback(async (hash: string) => {
    if (expandedCommit === hash) {
      setExpandedCommit(null);
      // 不立即清空文件列表，让 max-height 过渡平滑收起
      return;
    }
    setExpandedCommit(hash);
    setExpandedCommitFiles([]);
    setCommitFilesLoading(true);
    try {
      const files = await pi.gitCommitFiles(cwd, hash);
      setExpandedCommitFiles(files);
    } catch (e) {
      setExpandedCommitFiles([]);
    } finally {
      setCommitFilesLoading(false);
    }
  }, [cwd, expandedCommit]);

  const handleOpenCommitFile = useCallback((hash: string, filePath: string) => {
    // 从提交日志打开文件 diff → 单栏 unified
    useSplitStore.getState().openDiff(cwd, hash, undefined, filePath, true);
  }, [cwd]);

  // ── 悬浮预览 ──
  const handleHoverEnter = useCallback((e: React.MouseEvent, entry: LogEntry) => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    hoverTimer.current = setTimeout(() => {
      setHoverCommit({ x: e.clientX, y: e.clientY, entry });
    }, 300);
  }, []);
  const handleHoverMove = useCallback((e: React.MouseEvent) => {
    setHoverCommit((prev) => {
      if (!prev) return null;
      return { ...prev, x: e.clientX, y: e.clientY };
    });
  }, []);
  const handleHoverLeave = useCallback(() => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    setHoverCommit(null);
  }, []);

  const handleCommit = useCallback(async (push = false) => {
    const msg = commitMsg.trim();
    if (!msg) { setCommitError('Commit message is empty'); return; }
    if (checkedFiles.size === 0) { setCommitError('No files selected'); return; }
    setCommitError(null);
    setCommitSuccess(false);
    setIsCommitting(true);
    try {
      // 先取消暂存所有，再暂存选中的文件，然后提交
      await pi.gitUnstage(cwd);
      const r = await pi.gitStage(cwd, Array.from(checkedFiles));
      if (!r.success) { setCommitError(r.error ?? 'Stage failed'); setIsCommitting(false); return; }
      const cr = await pi.gitCommit(cwd, msg, { allowEmptyMessage: true, allowEmpty: true });
      if (cr.success) {
        setCommitMsg('');
        setCheckedFiles(new Set());
        setCommitSuccess(true);
        setTimeout(() => setCommitSuccess(false), 2000);
        if (push) {
          void pi.gitPush(cwd);
        }
      } else {
        setCommitError(cr.error ?? 'Commit failed');
      }
    } catch (e: any) {
      setCommitError(e.message ?? 'Commit failed');
    } finally {
      setIsCommitting(false);
    }
  }, [cwd, commitMsg, checkedFiles]);

  const handleCheckout = useCallback(async (ref: string) => {
    const r = await pi.gitCheckout(cwd, ref);
    if (!r.success) alert(r.error ?? 'Checkout failed');
    else scheduleRefresh();
  }, [cwd, scheduleRefresh]);

  const handleSelectAll = useCallback(() => {
    const allPaths = new Set<string>();
    const collect = (nodes: FileTreeNode[]) => {
      for (const n of nodes) {
        if (!n.isDir) allPaths.add(n.path);
        if (n.children) collect(n.children);
      }
    };
    collect(stagedTree);
    collect(untrackedTree);
    collect(unstagedTree);
    setCheckedFiles(allPaths);
  }, [stagedTree, untrackedTree, unstagedTree]);

  const handleDeselectAll = useCallback(() => {
    setCheckedFiles(new Set());
  }, []);

  // ── Branch picker ──
  const branchPickerRef = useRef<HTMLDivElement>(null);
  const branchToggleRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!showBranchPicker) return;
    const handler = (e: MouseEvent) => {
      if (branchToggleRef.current && branchToggleRef.current.contains(e.target as Node)) return;
      if (branchPickerRef.current && !branchPickerRef.current.contains(e.target as Node)) {
        setShowBranchPicker(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showBranchPicker]);

  const [newBranchName, setNewBranchName] = useState('');

  // ── Render ──

  if (!status) {
    return <div className="git-empty">Loading...</div>;
  }
  if (!status.isGit) {
    return <div className="git-empty">Not a git repository: {cwd}</div>;
  }

  const allCount = staged.length + untracked.length + unstagedModified.length;

  return (
    <div className="git-view git-view-idea">
      {/* 头部：仓库名 + 分支 + 同步 */}
      <div className="git-idea-header">
        <div className="git-idea-repo">
          <span className="git-idea-repo-icon">📦</span>
          <span className="git-idea-repo-name">{cwd.split(/[\\/]/).pop() ?? cwd}</span>
        </div>
        <div className="git-branch-row">
          <div className="git-branch-wrap">
          <span
            className="git-branch"
            ref={branchToggleRef}
            onClick={() => setShowBranchPicker((v) => !v)}
            data-testid="git-branch-switch"
          >
            {activeOps.has('checkout') ? <Spinner /> : '🌿'} {status.branch ?? '(detached)'}
          </span>
          {(status.ahead > 0 || status.behind > 0) && (
            <span className="git-ahead-behind">
              {status.ahead > 0 && <span className="git-ahead">↑{status.ahead}</span>}
              {status.behind > 0 && <span className="git-behind">↓{status.behind}</span>}
            </span>
          )}
          {/* Branch picker popup（绝对定位在分支名下方） */}
          {showBranchPicker && (
            <div className="git-branch-picker" ref={branchPickerRef}>
              <div className="git-branch-picker-create">
                <input
                  placeholder="New branch name"
                  value={newBranchName}
                  onChange={(e) => setNewBranchName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && newBranchName.trim()) {
                      void pi.gitCreateBranch(cwd, newBranchName.trim()).then((r) => {
                        if (r?.success) void handleCheckout(newBranchName.trim());
                        else alert(r?.error ?? 'Create branch failed');
                        setNewBranchName('');
                        setShowBranchPicker(false);
                      });
                    }
                  }}
                />
                <button onClick={() => { void pi.gitCreateBranch(cwd, newBranchName.trim()).then((r) => { if (r?.success) void handleCheckout(newBranchName.trim()); else alert(r?.error ?? 'Create branch failed'); setNewBranchName(''); setShowBranchPicker(false); }); }}>+</button>
              </div>
              <div className="git-branch-picker-list">
                {branches.map((b) => (
                  <div
                    key={b.name}
                    className={`git-branch-item${b.current ? ' git-branch-item-current' : ''}`}
                    onClick={() => { void handleCheckout(b.name); setShowBranchPicker(false); }}
                  >
                    <span className="git-branch-item-name">{b.remote ? '☁' : '⎇'} {b.name}</span>
                    {b.current && <span className="git-branch-item-current-mark">*</span>}
                  </div>
                ))}
              </div>
            </div>
          )}
          </div>
          <div className="git-sync-btns">
            <button className="git-sync-btn" onClick={() => { void pi.gitSync(cwd); scheduleRefresh(); }} title="Sync" disabled={activeOps.size > 0}>
              {activeOps.has('sync') ? <Spinner /> : '⟳'}
            </button>
            <button className="git-sync-btn" onClick={() => { void pi.gitPull(cwd); scheduleRefresh(); }} title="Pull" disabled={activeOps.size > 0}>
              {activeOps.has('pull') ? <Spinner /> : '↓'}
            </button>
            <button className="git-sync-btn" onClick={() => { void pi.gitPush(cwd); scheduleRefresh(); }} title="Push" disabled={activeOps.size > 0}>
              {activeOps.has('push') ? <Spinner /> : '↑'}
            </button>
            <button className="git-sync-btn" onClick={() => { void pi.gitFetch(cwd); scheduleRefresh(); }} title="Fetch" disabled={activeOps.size > 0}>
              {activeOps.has('fetch') ? <Spinner /> : '◎'}
            </button>
          </div>
        </div>
      </div>

      {/* 全选/取消栏 */}
      <div className="git-idea-select-bar">
        <span className="git-idea-change-count">{allCount} file{allCount !== 1 ? 's' : ''} changed</span>
        <span className="git-idea-spacer" />
        <button className="git-idea-link-btn" onClick={handleSelectAll}>Select All</button>
        <span className="git-idea-sep">|</span>
        <button className="git-idea-link-btn" onClick={handleDeselectAll}>Deselect All</button>
      </div>

      {/* 文件分区 */}
      <div className="git-idea-files">
        <FileSection title="Changes to be committed" count={staged.length} sectionKey="staged" expanded={sectionExpanded} onToggle={handleToggleSection}>
          <FileTreeSection nodes={stagedTree} checkedFiles={checkedFiles} onToggleCheck={handleToggleCheck} expandedDirs={dirExpanded} onToggleDir={handleToggleDir} onOpenDiff={handleOpenDiff} onContextMenu={handleContextMenu} />
        </FileSection>

        <FileSection title="Unversioned Files" count={untracked.length} sectionKey="untracked" expanded={sectionExpanded} onToggle={handleToggleSection}>
          <FileTreeSection nodes={untrackedTree} checkedFiles={checkedFiles} onToggleCheck={handleToggleCheck} expandedDirs={dirExpanded} onToggleDir={handleToggleDir} onOpenDiff={handleOpenDiff} onContextMenu={handleContextMenu} />
        </FileSection>

        <FileSection title="Modified (not staged)" count={unstagedModified.length} sectionKey="unstaged" expanded={sectionExpanded} onToggle={handleToggleSection}>
          <FileTreeSection nodes={unstagedTree} checkedFiles={checkedFiles} onToggleCheck={handleToggleCheck} expandedDirs={dirExpanded} onToggleDir={handleToggleDir} onOpenDiff={handleOpenDiff} onContextMenu={handleContextMenu} />
        </FileSection>
      </div>

      {/* 提交历史 */}
      <div className="git-file-section">
        <div className="git-file-section-title" onClick={handleToggleHistory}>
          <span className={`git-chevron${historyExpanded ? ' expanded' : ''}`} />
          <span className="git-section-label">提交历史</span>
          {historyLoading && <span className="git-spinner" style={{ fontSize: 10, marginLeft: 4 }} />}
          <span className="git-history-scope" onClick={(e) => { e.stopPropagation(); setHistoryAllBranches((v) => !v); }} title={historyAllBranches ? '当前为全部分支，点击切换为仅当前分支' : '当前为仅当前分支，点击切换为全部分支'}>
            {historyAllBranches ? '全部' : '当前'}
          </span>
        </div>
          <div className={`git-history-body${historyExpanded ? ' expanded' : ''}`}>
            {historyCommits.length === 0 && !historyLoading && (
              <div className="git-section-empty">暂无提交记录</div>
            )}
            {historyCommits.map((entry) => (
              <div
                key={entry.hash}
                className="git-history-row"
                onMouseEnter={(e) => handleHoverEnter(e, entry)}
                onMouseMove={handleHoverMove}
                onMouseLeave={handleHoverLeave}
              >
                <div
                  className="git-history-row-main"
                  onClick={() => handleToggleCommit(entry.hash)}
                >
                  <span className={`git-chevron${expandedCommit === entry.hash ? ' expanded' : ''}`} />
                  <span className="git-history-hash">{entry.hash.slice(0, 7)}</span>
                  <span className="git-history-msg">{entry.message}</span>
                  <span className="git-history-date">{formatRelative(entry.date)}</span>
                </div>
                <div className={`git-history-files${expandedCommit === entry.hash ? ' expanded' : ''}`}>
                  {expandedCommit === entry.hash && commitFilesLoading && <div className="git-section-empty" style={{ paddingLeft: 20 }}>加载改动文件…</div>}
                  {expandedCommit === entry.hash && !commitFilesLoading && expandedCommitFiles.length === 0 && (
                    <div className="git-section-empty" style={{ paddingLeft: 20 }}>无改动文件</div>
                  )}
                  {expandedCommit === entry.hash && !commitFilesLoading && expandedCommitFiles.map((f) => (
                    <div
                      key={f.path}
                      className="git-history-file"
                      onClick={(e) => { e.stopPropagation(); handleOpenCommitFile(entry.hash, f.path); }}
                      title="点击查看该文件 diff"
                    >
                      <span className={`git-history-file-status git-history-file-status--${f.status.toLowerCase()}`}>
                        {f.status}
                      </span>
                      <span className="git-history-file-path">{f.path}</span>
                      {f.oldPath && <span className="git-history-file-old">← {f.oldPath}</span>}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
      </div>

      {/* 提交信息区 */}
      <div className="git-idea-commit-area">
        <textarea
          className="git-commit-input"
          placeholder="Commit message (Ctrl+Enter to commit)"
          value={commitMsg}
          onChange={(e) => { setCommitMsg(e.target.value); setCommitError(null); }}
          onKeyDown={(e) => {
            if (e.ctrlKey && e.key === 'Enter') {
              e.preventDefault();
              if (canCommit) handleCommit(false);
            }
          }}
          rows={3}
        />
        {commitError && <div className="git-commit-error">{commitError}</div>}
        {commitSuccess && <div className="git-commit-success">✓ Committed</div>}
        <div className="git-idea-author">
          <span className="git-idea-author-label">Author:</span>
          <input
            className="git-idea-author-input"
            value={author}
            onChange={(e) => setAuthor(e.target.value)}
            placeholder="Author name"
          />
        </div>
        <div className="git-idea-commit-actions">
          <label className="git-idea-amend">
            <input type="checkbox" /> Amend
          </label>
          <span className="git-idea-spacer" />
          <button
            className="git-idea-btn git-idea-btn-commit"
            disabled={!canCommit || activeOps.size > 0}
            onClick={() => handleCommit(false)}
          >
            {isCommitting ? 'Committing...' : 'Commit'}
          </button>
          <button
            className="git-idea-btn git-idea-btn-push"
            disabled={!canCommit || activeOps.size > 0}
            onClick={() => handleCommit(true)}
          >
            {isCommitting ? 'Committing...' : 'Commit and Push…'}
          </button>
        </div>
      </div>

      {/* 右键菜单 */}
      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />
      )}

      {/* 悬浮预览卡片（Portal 到 body，避免右侧栏 transform 影响 fixed 定位） */}
      {hoverCommit && createPortal(
        <CommitHoverPanel entry={hoverCommit.entry} mouseX={hoverCommit.x} mouseY={hoverCommit.y} />,
        document.body
      )}
    </div>
  );
}

// ── 辅助子组件 ──

function FileTreeSection({
  nodes,
  checkedFiles,
  onToggleCheck,
  expandedDirs,
  onToggleDir,
  onOpenDiff,
  onContextMenu,
}: {
  nodes: FileTreeNode[];
  checkedFiles: Set<string>;
  onToggleCheck: (node: FileTreeNode) => void;
  expandedDirs: Set<string>;
  onToggleDir: (path: string) => void;
  onOpenDiff: (path: string) => void;
  onContextMenu: (e: React.MouseEvent, node: FileTreeNode) => void;
}) {
  return (
    <>
      {nodes.map((node) => (
        <FileTreeRow
          key={node.path}
          node={node}
          checkedFiles={checkedFiles}
          onToggleCheck={onToggleCheck}
          expandedDirs={expandedDirs}
          onToggleDir={onToggleDir}
          onOpenDiff={onOpenDiff}
          onContextMenu={onContextMenu}
        />
      ))}
    </>
  );
}

/** 悬浮在提交行上时弹出的紧凑预览卡片（类似右键菜单，跟随鼠标）。 */
function CommitHoverPanel({ entry, mouseX, mouseY }: { entry: LogEntry; mouseX: number; mouseY: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: 0, top: 0 });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const pw = el.offsetWidth;
    const ph = el.offsetHeight;
    // 尽在鼠标右侧，放不下则左侧（类似右键菜单）
    let left = mouseX + 12;
    if (left + pw > vw - 8) left = mouseX - pw - 12;
    left = Math.max(8, left);
    let top = mouseY + 12;
    if (top + ph > vh - 8) top = mouseY - ph - 12;
    top = Math.max(8, top);
    setPos({ left: Math.round(left), top: Math.round(top) });
  }, [mouseX, mouseY]);

  return (
    <div ref={ref} className="git-hover-panel" style={{ left: pos.left, top: pos.top }}>
      <div className="git-hover-panel-hash">{entry.hash.slice(0, 12)}</div>
      <div className="git-hover-panel-message">{entry.message}</div>
      <div className="git-hover-panel-meta">
        <span className="git-hover-panel-author">{entry.author}</span>
        <span className="git-hover-panel-sep">·</span>
        <span className="git-hover-panel-date">{entry.date?.replace('T', ' ').replace(/\..*/, '')}</span>
      </div>
    </div>
  );
}