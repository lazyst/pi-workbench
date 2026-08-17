import { useState, useEffect, useMemo, useCallback } from 'react';
import { pi } from '../ipc';
import { useTabStore } from '../store/tabStore';
import { getAllTabs } from '../store/splitStore';
import { defaultConfig } from '../../../main/config';
import type { AppConfig } from '../types';

interface DiskSession {
  key: string;
  cwd: string;
  name: string;
  time?: string;
  unsaved?: boolean;
}

function readPinned(cfg: AppConfig): string[] {
  const arr = cfg.pinnedDirs;
  return Array.isArray(arr) ? arr.filter((x) => typeof x === 'string') : [];
}

// Windows 路径规范化：把混合分隔符（\ 与 / 混用）统一为反斜杠、去尾部分隔符，
// 供 addedDirs 存储与比较使用。渲染进程沙箱无 node:path，此轻量实现覆盖常见绝对路径场景。
// 历史配置可能写入 "D:\\tmp/pi-test" 这类混合分隔符路径，而会话文件的 cwd 由 pi 写出为
// 标准反斜杠形式，直接做精确字符串比较会导致会话被过滤、侧边栏不显示。
function normalizeDir(p: string): string {
  return p.trim().replace(/[\\/]+/g, '\\').replace(/\\+$/, '');
}

function toDisk(
  groups: { cwd: string; sessions: Array<{ key: string; name: string; time: string }> }[],
): DiskSession[] {
  return groups.flatMap((g) => g.sessions.map((s) => ({ key: s.key, cwd: g.cwd, name: s.name, time: s.time })));
}

/**
 * 侧边栏数据状态 hook：管理 disk 会话列表、pinned 目录、addedDirs、appWorkDir、collapsedGroups。
 *
 * 依赖外部传入的 liveToDisk、virtualSessions 和 tabs 来派生 liveUnsaved 和合并后的 sessions 列表。
 */
export function useSidebarState(
  liveToDisk: Record<string, string>,
  virtualSessions: DiskSession[],
  setStatusMap: React.Dispatch<React.SetStateAction<Record<string, import('../types').SessionStatus>>>,
) {
  const [disk, setDisk] = useState<DiskSession[]>([]);
  const [pinned, setPinned] = useState<string[]>([]);
  const [addedDirs, setAddedDirs] = useState<string[]>([]);
  const [appWorkDir, setAppWorkDir] = useState<string>('');
  const [collapsedGroups, setCollapsedGroups] = useState<string[]>(defaultConfig().collapsedGroups);
  const [initialized, setInitialized] = useState(false);

  // 侧边栏只渲染 disk 会话；live 会话默认只活在终端区，发消息写盘后才出现。
  // 但用户希望"未晋升"的 live 会话也立刻显示在左侧栏（按 cwd 混进对应分组，
  // 标 unsaved）。因此此处把尚未晋升的 live 会话也并入侧边栏数据源，
  // 并排除已晋升（已在 liveToDisk 映射中）的 live，避免重复出现两条。
  const tabs = useTabStore((s) => getAllTabs(s));
  const isLiveKey = (k: string) => k.startsWith('live-') || k.startsWith('pi-');

  const liveUnsaved = useMemo<DiskSession[]>(() => {
    return tabs
      .filter((t): t is import('../store/tabStore').SessionTab =>
        t.kind === 'session' && isLiveKey(t.key) && !liveToDisk[t.key])
      .map((t) => ({ key: t.key, cwd: t.cwd, name: t.name, unsaved: true }));
  }, [tabs, liveToDisk]);

  // 左侧栏只展示用户"添加目录"显式注册的目录下的会话（含未升级的 live 会话）。
  // 「应用工作目录」(appWorkDir) 也作为隐式允许的目录纳入。
  const visibleDirs = useMemo(() => {
    const set = new Set(addedDirs);
    if (appWorkDir) set.add(appWorkDir);
    return set;
  }, [addedDirs, appWorkDir]);

  const sessions = useMemo<DiskSession[]>(() => {
    const addedSet = visibleDirs;
    return [
      ...disk.filter((d) => addedSet.has(d.cwd)),
      ...liveUnsaved.filter((s) => addedSet.has(s.cwd)),
      ...virtualSessions.filter((s) => addedSet.has(s.cwd)),
    ];
  }, [disk, liveUnsaved, virtualSessions, visibleDirs]);

  useEffect(() => {
    if (initialized) return;
    setInitialized(true);

    pi.getConfig().then((cfg) => {
      setPinned(readPinned(cfg));
      const rawDirs = Array.isArray(cfg.addedDirs)
        ? cfg.addedDirs.filter((x) => typeof x === 'string')
        : [];
      // 规范化分隔符（历史配置可能混入 "/"，如 "D:\tmp/pi-test"），并去重/去空；
      // 若发生变化则写回自愈，保证与会话 cwd（反斜杠形式）精确匹配。
      const dirs = [...new Set(rawDirs.map(normalizeDir).filter(Boolean))];
      if (dirs.length !== rawDirs.length || dirs.some((d, i) => d !== rawDirs[i])) {
        pi.setConfig({ addedDirs: dirs }).catch(() => {});
      }
      const workDir = cfg.appWorkDir || '';
      if (cfg.appWorkDir) setAppWorkDir(cfg.appWorkDir);
      // 首次启动：addedDirs 为空时自动添加 appWorkDir
      if (dirs.length === 0 && workDir) {
        dirs.push(workDir);
        pi.setConfig({ addedDirs: dirs }).catch(() => {});
      }
      setAddedDirs(dirs);
      if (Array.isArray(cfg.collapsedGroups)) {
        setCollapsedGroups(cfg.collapsedGroups.filter((x) => typeof x === 'string'));
      }
    }).catch(() => setPinned([]));

    pi.listSessions().then(toDisk).then((diskList) => {
      setDisk(diskList);
      const init: Record<string, import('../types').SessionStatus> = {};
      for (const d of diskList) init[d.key] = 'dead';
      setStatusMap((m) => ({ ...init, ...m }));
    }).catch(() => setDisk([]));
  }, [initialized, setStatusMap]);

  // 独立 effect 订阅主进程事件（空 deps，只注册一次，避免 cleanup 误注销）
  useEffect(() => {
    // 订阅主进程索引推送：更新 disk 列表
    const offIndex = pi.onIndex((groups) => {
      const diskList = toDisk(groups);
      setDisk(diskList);
      const diskKeys = diskList.map((d) => d.key);
      setStatusMap((m) => {
        let changed = false;
        const next = { ...m };
        for (const k of diskKeys) {
          if (next[k] === undefined) { next[k] = 'dead'; changed = true; }
        }
        return changed ? next : m;
      });
    });

    // 订阅会话晋升：立即将磁盘会话加入 disk，避免 onRelink 更新 liveToDisk 后
    // liveUnsaved 移除会话但 disk 尚未更新（onIndex 未到）导致会话在侧边栏消失。
    const offRelink = pi.onRelink((from, to) => {
      setDisk((prev) => {
        if (prev.some((d) => d.key === to)) return prev; // 已存在，跳过
        // 从 store 中查找 live tab 的 cwd 和 name
        const state = useTabStore.getState();
        const allTabs = getAllTabs(state);
        const liveTab = allTabs.find(
          (t): t is import('../store/tabStore').SessionTab => t.kind === 'session' && t.key === from,
        );
        return [...prev, {
          key: to,
          cwd: liveTab?.cwd ?? '',
          name: liveTab?.name ?? '',
          time: new Date().toISOString().slice(0, 16).replace('T', ' '),
        }];
      });
    });

    return () => { offIndex?.(); offRelink?.(); };
  }, []);

  // ── Handlers ──

  /** 把指定路径添加为左侧工作目录（规范化分隔符 + 去重：已存在则静默忽略）。 */
  const handleAddDirectory = useCallback((dir: string) => {
    // null / 空串 / 纯空白都会在规范化后变为空串，单个守卫即可拦截。
    const norm = normalizeDir(dir || '');
    if (!norm) return;
    setAddedDirs((prev) => {
      if (prev.includes(norm)) return prev;
      const next = [...prev, norm];
      pi.setConfig({ addedDirs: next }).catch(() => {});
      return next;
    });
  }, []);

  const handlePickDirectory = useCallback(async () => {
    try {
      const dir = await pi.pickDirectory();
      if (!dir) return;
      handleAddDirectory(dir);
    } catch { /* 用户取消或出错 */ }
  }, [handleAddDirectory]);

  const handleRemoveDir = useCallback((cwd: string) => {
    setAddedDirs((prev) => {
      const next = prev.filter((c) => c !== cwd);
      pi.setConfig({ addedDirs: next }).catch(() => {});
      return next;
    });
  }, []);

  const handleTogglePin = useCallback((cwd: string) => {
    setPinned((prev) => {
      const next = prev.includes(cwd) ? prev.filter((c) => c !== cwd) : [...prev, cwd];
      pi.setConfig({ pinnedDirs: next }).catch(() => {});
      return next;
    });
  }, []);

  const handleCollapseGroup = useCallback((cwd: string, collapsed: boolean) => {
    setCollapsedGroups((prev) => {
      const next = collapsed
        ? [...prev, cwd]
        : prev.filter((d) => d !== cwd);
      pi.setConfig({ collapsedGroups: next }).catch(() => {});
      return next;
    });
  }, []);

  return {
    disk,
    pinned,
    addedDirs,
    appWorkDir,
    collapsedGroups,
    liveUnsaved,
    visibleDirs,
    sessions,
    handlePickDirectory,
    handleAddDirectory,
    handleRemoveDir,
    handleTogglePin,
    handleCollapseGroup,
  };
}