import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as nodePath from 'node:path';
import { pi } from '../ipc';
import { clipboard, type ClipItem } from '../lib/clipboard';
import { ContextMenu, type ContextMenuItem } from './ContextMenu';
import { ConfirmDialog } from './ConfirmDialog';
import { FileTreeModel, fetchEntries } from './file-tree/file-tree-model';
import { FileTreeVirtualRows } from './file-tree/FileTreeVirtualRows';
import type { FileNode, VisibleRow, EditingState, MenuState, GitFileStatusEntry } from './file-tree/file-tree-types';

// 文件树 → 终端拖拽使用的自定义 MIME（区别于系统文件管理器的 'Files'）。
// XtermTerminal.bindDragAndDrop 同时识别该类型，实现「从内部文件树拖文件到终端即插入绝对路径」。
// 现承载 JSON 数组：被拖拽节点的相对路径列表（支持多选拖拽）。
// ⚠️ 集成契约：XtermTerminal 依赖此常量名 + 值不变，拖拽到终端才能解析绝对路径。禁止改名/改值。
export const PI_FILE_DRAG_MIME = 'application/x-pi-file';

/** 由 root + 相对路径算出绝对路径（跨平台分隔符 + . / .. 归一化）。 */
function toAbsolutePath(root: string, relPath: string): string {
  try {
    return nodePath.resolve(root, relPath);
  } catch {
    return relPath ? `${root}/${relPath}` : root;
  }
}

/** 父目录相对路径（'' 表示根）。 */
function parentOf(relPath: string): string {
  if (!relPath.includes('/')) return '';
  return relPath.slice(0, relPath.lastIndexOf('/'));
}

function basename(p: string): string {
  const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return idx >= 0 ? p.slice(idx + 1) : p;
}

interface Props {
  root: string;
  onOpenFile: (relPath: string, fileName: string, root: string) => void;
  /** Bump to force a refresh of the root layer. (可选；当前调用方未传，向后兼容保留。) */
  refreshKey?: number;
}

export function FileTree({ root, onOpenFile, refreshKey }: Props) {
  // 单一模型实例（借鉴 VS Code ExplorerModel 单例持有 roots）。
  const modelRef = useRef<FileTreeModel>(new FileTreeModel());
  const model = modelRef.current;

  const [roots, setRoots] = useState<FileNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const prevRootRef = useRef<string | null>(null);

  // 模型版本号：每次模型数据变化后自增，驱动行投影重算和虚拟列表重渲染。
  const [modelRefreshKey, setModelRefreshKey] = useState(0);
  // 正在加载子项的目录集合（用于显示加载中指示器）。
  const [dirLoading, setDirLoading] = useState<Set<string>>(new Set());

  // 文件管理交互状态
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<EditingState | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [cutRelPaths, setCutRelPaths] = useState<Set<string>>(new Set());
  const [confirmDelete, setConfirmDelete] = useState<ClipItem[] | null>(null);

  // ── Git 状态映射：文件树节点颜色联动 ──
  const [gitStatusMap, setGitStatusMap] = useState<Record<string, GitFileStatusEntry>>({});
  // 目录冒泡：子项有改动时，父目录路径 → 冒泡类别
  const [gitBubbleMap, setGitBubbleMap] = useState<Record<string, string>>({});
  // 被 .gitignore 忽略的顶层路径集合（仅在文件树变化时刷新）
  const [ignoredSet, setIgnoredSet] = useState<Set<string>>(new Set());

  // 检查路径是否被忽略（自身或父目录在 ignoredSet 中）
  const isIgnored = useCallback((fullPath: string): boolean => {
    if (ignoredSet.has(fullPath)) return true;
    // 沿路径向上检查父目录
    let slashIdx = fullPath.indexOf('/');
    while (slashIdx !== -1) {
      if (ignoredSet.has(fullPath.substring(0, slashIdx))) return true;
      slashIdx = fullPath.indexOf('/', slashIdx + 1);
    }
    return false;
  }, [ignoredSet]);

  // 刷新被忽略的路径集合（仅在文件树变化时调用，不绑定 git:change）
  const refreshIgnoredPaths = useCallback(async () => {
    if (!root) { setIgnoredSet(new Set()); return; }
    try {
      const paths = await pi.gitIgnoredPaths(root);
      setIgnoredSet(new Set(paths));
    } catch {
      setIgnoredSet(new Set());
    }
  }, [root]);

  // 从状态映射计算冒泡
  const computeBubble = useCallback((statusMap: Record<string, GitFileStatusEntry>): Record<string, string> => {
    const bubble: Record<string, string> = {};
    for (const relPath of Object.keys(statusMap)) {
      const entry = statusMap[relPath];
      if (!entry || entry.category === 'submodule') continue;
      let slashIdx = relPath.indexOf('/');
      while (slashIdx !== -1) {
        const parent = relPath.substring(0, slashIdx);
        if (!statusMap[parent] && !bubble[parent]) {
          bubble[parent] = entry.category;
        }
        slashIdx = relPath.indexOf('/', slashIdx + 1);
      }
    }
    return bubble;
  }, []);

  // 获取 git 状态映射并订阅实时变更
  const refreshGitStatus = useCallback(async () => {
    if (!root) { setGitStatusMap({}); setGitBubbleMap({}); return; }
    try {
      const map = await pi.gitFileStatusMap(root);
      setGitStatusMap(map);
      setGitBubbleMap(computeBubble(map));
    } catch {
      setGitStatusMap({});
      setGitBubbleMap({});
    }
  }, [root, computeBubble]);

  useEffect(() => {
    if (!root) return;
    void refreshGitStatus();
    void refreshIgnoredPaths();
  }, [root, refreshGitStatus, refreshIgnoredPaths]);

  // 订阅 git:change：git 操作（commit/stage/reset/checkout/stash 等）会改写 .git/
  // 内部文件，而根目录 fsWatch（recursive:false）只监听直接子项，探测不到 .git/
  // 内的变更，导致提交后文件树高亮不刷新。这里复用主进程 git:watch（recursive:true
  // 整仓监听）推送的 git:change 事件，git 元数据变化即刷新状态。250ms 防抖合并突发。
  useEffect(() => {
    if (!root) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const scheduleRefresh = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { timer = null; void refreshGitStatus(); }, 250);
    };
    const unsubscribe = pi.gitWatch(root, scheduleRefresh);
    return () => {
      unsubscribe();
      if (timer) clearTimeout(timer);
    };
  }, [root, refreshGitStatus]);

  const handleToggleExpanded = useCallback((fullPath: string, open: boolean) => {
    setExpandedPaths((prev) => {
      const next = new Set(prev);
      if (open) next.add(fullPath); else next.delete(fullPath);
      return next;
    });
  }, []);

  // ── 统一刷新 ──
  const gitRefreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshDir = useCallback((relPath: string) => {
    model.refresh(relPath);
    if (relPath === '') {
      // 根层：重新拉取 roots
      fetchEntries(root, '')
        .then((entries) => {
          setRoots(entries);
          setModelRefreshKey((k) => k + 1);
        })
        .catch((e) => setError(e instanceof Error ? e.message : String(e)));
      // 防抖 1s 执行 git 刷新，避免高频文件保存时反复调用 git status
      if (gitRefreshTimer.current) clearTimeout(gitRefreshTimer.current);
      gitRefreshTimer.current = setTimeout(() => {
        gitRefreshTimer.current = null;
        void refreshGitStatus();
        void refreshIgnoredPaths();
      }, 1000);
    } else {
      // 子目录：强制重载模型缓存，然后触发重渲染
      model.load(relPath, true).then(() => {
        setModelRefreshKey((k) => k + 1);
      });
    }
  }, [root, model, refreshGitStatus, refreshIgnoredPaths]);

  // 根目录（''）外部变更自动刷新
  useEffect(() => {
    if (!root) return;
    if (typeof pi.fsWatch !== 'function') return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = pi.fsWatch(root, '', () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => refreshDir(''), 150);
    });
    return () => {
      unsubscribe();
      if (timer) clearTimeout(timer);
    };
  }, [root, refreshDir]);

  // ── 已展开目录的外部变更监听 ──
  // 每个展开的目录订阅其直接子项变更，收到变更后刷新该目录。
  const dirWatchTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  useEffect(() => {
    if (!root) return;
    if (typeof pi.fsWatch !== 'function') return;

    const unsubs: (() => void)[] = [];
    const timers = dirWatchTimers.current;

    expandedPaths.forEach((path) => {
      if (path === '') return; // 根层已在外部独立监听
      const onChange = () => {
        if (timers.has(path)) clearTimeout(timers.get(path)!);
        const timer = setTimeout(() => refreshDir(path), 150);
        timers.set(path, timer);
      };
      const unsub = pi.fsWatch(root, path, onChange);
      unsubs.push(unsub);
    });

    return () => {
      unsubs.forEach((fn) => fn());
      timers.forEach((t) => clearTimeout(t));
      timers.clear();
    };
  }, [root, expandedPaths, refreshDir]);

  // ── 根目录加载 ──
  useEffect(() => {
    const rootChanged = prevRootRef.current !== root;
    prevRootRef.current = root;

    if (rootChanged) {
      model.setRoot(root);
      model.reset();
      setExpandedPaths(new Set());
      setError(null);
      setRoots([]);
      setSelection(new Set());
      setEditing(null);
      setCutRelPaths(new Set());
    }

    if (!root) {
      setLoading(false);
      return;
    }

    setLoading(rootChanged || roots.length === 0);
    setError(null);
    fetchEntries(root, '')
      .then((entries) => {
        setRoots(entries);
        setModelRefreshKey((k) => k + 1);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root, refreshKey]);

  // ── 展开目录的惰性加载 ──
  // 当 expandedPaths 变化时，对尚未加载的目录发起异步加载。
  const pendingLoads = useRef<Set<string>>(new Set());
  useEffect(() => {
    expandedPaths.forEach((path) => {
      if (model.isLoaded(path) || pendingLoads.current.has(path)) return;
      pendingLoads.current.add(path);
      setDirLoading((prev) => new Set(prev).add(path));
      model.load(path).then(() => {
        pendingLoads.current.delete(path);
        setDirLoading((prev) => {
          const next = new Set(prev);
          next.delete(path);
          return next;
        });
        setModelRefreshKey((k) => k + 1);
      });
    });
  }, [expandedPaths, model]);

  // ── 可见行投影（扁平化展开树）──
  const rows = useMemo<VisibleRow[]>(() => {
    const result: VisibleRow[] = [];

    // 根层新建伪节点（relPath===''）
    if (editing && editing.isNew && editing.relPath === '') {
      result.push({
        node: {
          name: editing.draftName,
          fullPath: `__draft__${editing.draftName}`,
          isDir: editing.isDir,
          size: 0,
        },
        depth: 0,
        isExpanded: false,
        isDraft: true,
      } as VisibleRow);
    }

    const walk = (nodes: FileNode[], depth: number) => {
      for (const node of nodes) {
        const open = expandedPaths.has(node.fullPath);
        result.push({ node, depth, isExpanded: open });

        if (node.isDir && open) {
          // 此目录下的新建伪节点
          if (editing && editing.isNew && editing.relPath === node.fullPath) {
            result.push({
              node: {
                name: editing.draftName,
                fullPath: `${node.fullPath}/__draft__${editing.draftName}`,
                isDir: editing.isDir,
                size: 0,
              },
              depth: depth + 1,
              isExpanded: false,
              isDraft: true,
            } as VisibleRow);
          }
          const children = model.getChildren(node.fullPath);
          if (children) walk(children, depth + 1);
        }
      }
    };

    walk(roots, 0);
    return result;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roots, expandedPaths, editing, modelRefreshKey, model.isLoaded, model.getChildren]);

  // ── 选择 ──
  const onToggleSelect = useCallback((fullPath: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setSelection((prev) => {
      const next = new Set(prev);
      if (next.has(fullPath)) next.delete(fullPath); else next.add(fullPath);
      return next;
    });
  }, []);

  // ── 右键菜单 ──
  const onOpenContextMenu = useCallback((e: React.MouseEvent, target: { relPath: string; isDir: boolean } | null) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, target });
  }, []);

  // ── 行点击 ──
  const handleRowClick = useCallback((node: FileNode, e: React.MouseEvent) => {
    if (e.ctrlKey || e.metaKey) {
      onToggleSelect(node.fullPath, e);
      return;
    }
    if (node.isDir) {
      const open = expandedPaths.has(node.fullPath);
      handleToggleExpanded(node.fullPath, !open);
    } else {
      onOpenFile(node.fullPath, node.name, root);
    }
  }, [expandedPaths, handleToggleExpanded, onOpenFile, root, onToggleSelect]);

  // ── 行右键菜单触发（从虚拟列表冒泡）──
  const handleRowContextMenu = useCallback((node: FileNode, e: React.MouseEvent) => {
    onOpenContextMenu(e, { relPath: node.fullPath, isDir: node.isDir });
  }, [onOpenContextMenu]);

  // ── 新建（inline 伪节点，输完名才落盘）──
  const startNew = useCallback((parentRel: string, isDir: boolean) => {
    setSelection(new Set());
    setEditing({ relPath: parentRel, isDir, isNew: true, draftName: isDir ? '新建文件夹' : '新建文件' });
    // 确保父目录展开可见（根 '' 无需展开）。
    if (parentRel && !expandedPaths.has(parentRel)) {
      setExpandedPaths((prev) => new Set(prev).add(parentRel));
    }
    setMenu(null);
  }, [expandedPaths]);

  const startRename = useCallback((relPath: string) => {
    setSelection(new Set([relPath]));
    setEditing({ relPath, isDir: false, isNew: false, draftName: basename(relPath) });
    setMenu(null);
  }, []);

  // 提交 inline 编辑
  const onCommitEdit = useCallback(async (value: string) => {
    if (!editing || !root) { setEditing(null); return; }
    const name = value.trim();
    setEditing(null);
    if (!name) return;

    try {
      if (editing.isNew) {
        const parent = editing.relPath;
        const siblings = await pi.fsListNames(root, parent);
        const finalName = await pi.fsUniqueName(name, siblings);
        const finalRel = parent ? `${parent}/${finalName}` : finalName;
        if (editing.isDir) await pi.fsMkdir(root, finalRel);
        else await pi.fsCreateFile(root, finalRel, '');
        refreshDir(parent);
      } else {
        const parent = parentOf(editing.relPath);
        const desired = parent ? `${parent}/${name}` : name;
        if (desired === editing.relPath) return;
        const siblings = await pi.fsListNames(root, parent);
        const others = siblings.filter((n) => n !== basename(editing.relPath));
        const finalName = await pi.fsUniqueName(name, others);
        const finalRel = parent ? `${parent}/${finalName}` : finalName;
        await pi.fsRename(root, editing.relPath, finalRel);
        refreshDir(parent);
        if (editing.relPath.includes('/')) {
          refreshDir(parentOf(editing.relPath));
        }
      }
    } catch (e) {
      refreshDir(parentOf(editing.relPath));
      console.error('[file-tree] edit failed', e);
    }
  }, [editing, root, refreshDir]);

  const onCancelEdit = useCallback(() => setEditing(null), []);

  // ── 复制 / 剪切 / 粘贴 ──
  const doCut = useCallback((targets: ClipItem[]) => {
    clipboard.set({ mode: 'cut', items: targets });
    setCutRelPaths(new Set(targets.map((t) => t.relPath)));
    setMenu(null);
  }, []);

  const doCopy = useCallback((targets: ClipItem[]) => {
    clipboard.set({ mode: 'copy', items: targets });
    setCutRelPaths(new Set());
    setMenu(null);
  }, []);

  const doPaste = useCallback(async (destDir: string) => {
    const clip = clipboard.get();
    setMenu(null);
    if (!clip || !root) return;
    try {
      for (const item of clip.items) {
        const base = basename(item.relPath);
        const siblings = await pi.fsListNames(root, destDir);
        const finalName = await pi.fsUniqueName(base, siblings);
        const destRel = destDir ? `${destDir}/${finalName}` : finalName;
        if (clip.mode === 'copy') {
          await pi.fsCopy(root, item.relPath, destRel);
        } else {
          await pi.fsRename(root, item.relPath, destRel);
        }
      }
      if (clip.mode === 'cut') {
        clipboard.clear();
        setCutRelPaths(new Set());
      }
      refreshDir(destDir);
    } catch (e) {
      console.error('[file-tree] paste failed', e);
    }
  }, [root, refreshDir]);

  // ── 删除 ──
  const requestDelete = useCallback((targets: ClipItem[]) => {
    setMenu(null);
    const hasDirOrMulti = targets.length > 1 || targets.some((t) => t.isDir);
    if (!hasDirOrMulti) {
      void (async () => {
        try {
          await pi.fsRemove(root, targets[0].relPath);
          refreshDir(parentOf(targets[0].relPath));
        } catch (e) { console.error('[file-tree] delete failed', e); }
      })();
      return;
    }
    setConfirmDelete(targets);
  }, [root, refreshDir]);

  const confirmDeleteNow = useCallback(async () => {
    if (!confirmDelete || !root) { setConfirmDelete(null); return; }
    try {
      for (const item of confirmDelete) {
        await pi.fsRemove(root, item.relPath);
        refreshDir(parentOf(item.relPath));
      }
    } catch (e) { console.error('[file-tree] delete failed', e); }
    finally {
      setConfirmDelete(null);
      setSelection(new Set());
    }
  }, [confirmDelete, root, refreshDir]);

  // ── 拖拽 ──
  // ⚠️ 集成契约：必须保持 PI_FILE_DRAG_MIME 常量 + toAbsolutePath 逻辑不变，
  // 否则拖拽到 XtermTerminal 无法解析成绝对路径。
  const handleRowDragStart = useCallback((node: FileNode, e: React.DragEvent) => {
    if (!e.dataTransfer) return;
    const payload = selection.has(node.fullPath) && selection.size > 0
      ? [...selection]
      : [node.fullPath];
    const absList = payload.map((p) => toAbsolutePath(root, p));
    e.dataTransfer.setData(PI_FILE_DRAG_MIME, JSON.stringify(absList));
    e.dataTransfer.setData('text/plain', absList.join(' '));
    e.dataTransfer.effectAllowed = 'copyMove';
  }, [root, selection]);

  const handleRowDragOverDir = useCallback((node: FileNode, _e: React.DragEvent) => {
    setDropTarget(node.fullPath);
  }, []);

  const handleRowDragLeaveDir = useCallback((node: FileNode) => {
    setDropTarget((prev) => prev === node.fullPath ? null : prev);
  }, []);

  const handleRowDropOnDir = useCallback(async (node: FileNode, e: React.DragEvent) => {
    setDropTarget(null);
    if (!root) return;
    const destDir = node.fullPath;
    const moving = selection.size > 0 ? [...selection] : [];
    if (!moving.length) return;
    try {
      for (const rel of moving) {
        const base = basename(rel);
        const siblings = await pi.fsListNames(root, destDir);
        const finalName = await pi.fsUniqueName(base, siblings);
        const destRel = destDir ? `${destDir}/${finalName}` : finalName;
        if (destRel === rel) continue;
        await pi.fsRename(root, rel, destRel);
        refreshDir(parentOf(rel));
      }
      refreshDir(destDir);
      const clip = clipboard.get();
      if (clip?.mode === 'cut') { clipboard.clear(); setCutRelPaths(new Set()); }
    } catch (e) { console.error('[file-tree] move failed', e); }
    setSelection(new Set());
  }, [root, selection, refreshDir]);

  // ── 菜单项构造 ──
  const menuItems: ContextMenuItem[] = useMemo(() => {
    if (!menu) return [];
    const clip = clipboard.get();
    const hasClip = !!clip && clip.items.length > 0;

    if (menu.target == null) {
      // 空白区域（目录内）
      const items: ContextMenuItem[] = [
        { label: '新建文件', onClick: () => startNew(currentDirForMenu, false) },
        { label: '新建文件夹', onClick: () => startNew(currentDirForMenu, true) },
      ];
      if (hasClip) {
        items.push({ label: '分隔线', kind: 'separator' });
        items.push({ label: '粘贴', onClick: () => void doPaste(currentDirForMenu) });
      }
      items.push(
        { label: '分隔线', kind: 'separator' },
        {
          label: '在文件管理器中显示',
          onClick: () => {
            const absPath = toAbsolutePath(root, currentDirForMenu);
            void pi.fsOpenWithSystem(absPath);
          },
        },
      );
      return items;
    }

    const { relPath, isDir } = menu.target;
    // 选集：若右键目标在选集中 → 操作整个选集；否则只操作目标
    const targets: ClipItem[] = selection.has(relPath)
      ? [...selection].map((p) => ({ root, relPath: p, isDir: false }))
      : [{ root, relPath, isDir }];

    const pasteDir = isDir ? relPath : parentOf(relPath);
    const items: ContextMenuItem[] = [];

    // ── 目录专属：新建 ──
    if (isDir) {
      items.push({ label: '新建文件', onClick: () => startNew(relPath, false) });
      items.push({ label: '新建文件夹', onClick: () => startNew(relPath, true) });
      items.push({ label: '分隔线', kind: 'separator' });
    }

    // ── 复制 / 剪切 / 粘贴 ──
    items.push({ label: '复制', onClick: () => doCopy(targets) });
    items.push({ label: '剪切', onClick: () => doCut(targets) });
    if (hasClip) items.push({ label: '粘贴', onClick: () => void doPaste(pasteDir) });
    items.push({ label: '分隔线', kind: 'separator' });

    // ── 路径 / 名称复制 ──
    items.push({
      label: '复制路径',
      onClick: () => {
        const paths = targets.map((t) => toAbsolutePath(root, t.relPath));
        void navigator.clipboard.writeText(paths.join('\n')).catch(() => {});
      },
    });
    items.push({
      label: '复制相对路径',
      onClick: () => {
        const names = targets.map((t) => t.relPath);
        void navigator.clipboard.writeText(names.join('\n')).catch(() => {});
      },
    });
    items.push({ label: '分隔线', kind: 'separator' });

    // ── 重命名 / 删除 ──
    items.push({ label: '重命名', onClick: () => startRename(relPath) });
    items.push({ label: '删除', danger: true, onClick: () => requestDelete(targets) });
    items.push({ label: '分隔线', kind: 'separator' });

    // ── 在文件管理器打开 ──
    items.push({
      label: '在文件管理器中显示',
      onClick: () => {
        const absPath = toAbsolutePath(root, relPath);
        if (isDir) {
          void pi.fsOpenWithSystem(absPath);
        } else {
          void pi.fsShowInFolder(absPath);
        }
      },
    });

    // ── 非目录：用系统默认程序打开（HTML→浏览器，PDF→阅读器，图片→看图软件等） ──
    if (!isDir) {
      items.push({
        label: '用系统默认程序打开',
        onClick: () => {
          const absPath = toAbsolutePath(root, relPath);
          void pi.fsOpenWithSystem(absPath);
        },
      });
    }

    return items;
  }, [menu, selection, root, startNew, startRename, doCut, doCopy, doPaste, requestDelete]);

  // 当前右键所在目录（用于空白区新建/粘贴）：若目标是目录则为其本身，否则取其父目录
  const currentDirForMenu = (() => {
    if (!menu) return '';
    if (menu.target == null) return '';
    const { relPath, isDir } = menu.target;
    return isDir ? relPath : parentOf(relPath);
  })();

  if (!root) {
    return <div className="file-empty">未选择工作目录</div>;
  }

  if (loading) {
    return <div className="file-empty">加载中…</div>;
  }
  if (error) {
    return <div className="file-error">{error}</div>;
  }
  if (roots.length === 0 && !editing) {
    // 纯空目录（无编辑态）：只显示"空目录"提示，不渲染 FileTreeVirtualRows
    return (
      <div
        className="file-tree file-tree-empty"
        style={{ minHeight: '100%' }}
        onContextMenu={(e) => onOpenContextMenu(e, null)}
      >
        <div className="file-empty" style={{ paddingLeft: 8 }}>空目录</div>
        {menu && (
          <ContextMenu
            x={menu.x}
            y={menu.y}
            items={menuItems}
            onClose={() => setMenu(null)}
          />
        )}
        {confirmDelete && (
          <ConfirmDialog
            title="删除确认"
            message={`将删除 ${confirmDelete.length} 个项目${confirmDelete.some((t) => t.isDir) ? '（含目录及其全部内容）' : ''}，此操作不可撤销。`}
            confirmLabel="删除"
            cancelLabel="取消"
            onConfirm={() => void confirmDeleteNow()}
            onCancel={() => setConfirmDelete(null)}
          />
        )}
      </div>
    );
  }

  return (
    <div
      className="file-tree"
      style={{ minHeight: '100%' }}
      onClick={() => { if (selection.size) setSelection(new Set()); }}
      onContextMenu={(e) => {
        // 点到文件行（或行内元素）视为节点右键；其余空白区域（含面板底部留白）视为空白右键。
        const onRow = (e.target as HTMLElement).closest('.file-row');
        if (!onRow) onOpenContextMenu(e, null);
      }}
    >
      <FileTreeVirtualRows
        rows={rows}
        expandedPaths={expandedPaths}
        selection={selection}
        cutRelPaths={cutRelPaths}
        dropTarget={dropTarget}
        editing={editing}
        draggable={!editing}
        gitStatusMap={gitStatusMap}
        gitBubbleMap={gitBubbleMap}
        isIgnored={isIgnored}
        dirLoading={dirLoading}
        onRowClick={handleRowClick}
        onRowContextMenu={handleRowContextMenu}
        onRowDragStart={handleRowDragStart}
        onRowDragOverDir={handleRowDragOverDir}
        onRowDragLeaveDir={handleRowDragLeaveDir}
        onRowDropOnDir={handleRowDropOnDir}
        onCommitEdit={onCommitEdit}
        onCancelEdit={onCancelEdit}
      />

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems}
          onClose={() => setMenu(null)}
        />
      )}

      {confirmDelete && (
        <ConfirmDialog
          title="删除确认"
          message={`将删除 ${confirmDelete.length} 个项目${confirmDelete.some((t) => t.isDir) ? '（含目录及其全部内容）' : ''}，此操作不可撤销。`}
          confirmLabel="删除"
          cancelLabel="取消"
          onConfirm={() => void confirmDeleteNow()}
          onCancel={() => setConfirmDelete(null)}
        />
      )}
    </div>
  );
}
