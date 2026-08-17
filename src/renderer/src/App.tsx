import { useEffect, useRef, useState, useCallback } from 'react';
import { Sidebar } from './components/Sidebar';
import { ConfirmDialog } from './components/ConfirmDialog';
import { TitleBar } from './components/TitleBar';
import { SettingsPanel } from './components/SettingsPanel';
import { WindowResizeZones } from './components/WindowResizeZones';
import { ToastProvider, useToast } from './components/Toast';
import { CenterPane } from './components/CenterPane';
import { RightPanel } from './components/RightPanel';
import { pi } from './ipc';
import { useTabStore } from './store/tabStore';
import { getAllTabs, findLeaf, getTabCwd } from './store/splitStore';
import { initTheme } from './theme';
import { initFontSize, bumpFontSize, getFontSize, FONT_SIZE_MIN, FONT_SIZE_MAX } from './fontSize';
import { usePanelLayout } from './hooks/usePanelLayout';
import { useSessionStatus } from './hooks/useSessionStatus';
import { useSidebarState } from './hooks/useSidebarState';
import { defaultConfig } from '../../main/config';
import type { TerminalProfile } from './types';
import type { SessionTab } from './store/tabStore';

export default function App() {
  // 中间区通用 Tab 模型（重构阶段 3E）：单一状态源已收编进 useTabStore（见 issue 03）。
  // App 不再持有 tabs / activeTabId / closedTabIds，仅把主进程 IPC 事件写回 store，
  // 并派生侧边栏 / 集成终端 cwd 所需的本地视图状态（statusMap / disk / liveToDisk 等）。
  const {
    statusMap, setStatusMap,
    liveToDisk, setLiveToDisk,
    liveToDiskRef, ptyOwnersRef,
    virtualSessions, setVirtualSessions,
  } = useSessionStatus();
  const [error, setError] = useState<string | null>(null);
  const {
    disk, pinned, addedDirs, appWorkDir, collapsedGroups,
    liveUnsaved, visibleDirs, sessions,
    handlePickDirectory, handleAddDirectory, handleRemoveDir, handleTogglePin, handleCollapseGroup,
  } = useSidebarState(liveToDisk, virtualSessions, setStatusMap);
  const {
    sidebarWidth, rightPanelWidth, sidebarCollapsed, rightPanelCollapsed,
    initFromConfig,
    handleSidebarResize, handleRightPanelResize,
    handleToggleSidebar, handleToggleRightPanel,
  } = usePanelLayout();
  const { toast } = useToast();
  const [settingsOpen, setSettingsOpen] = useState(false);
  // 集成终端实例列表 / 激活状态已收编进 useTabStore（see issue 03）。
  // App 仅保留「终端新建 / 销毁」所需的主进程 IPC 协调逻辑（见下方 handler）。
  // 缓存探测到的 profile 列表，避免每次新建都探测。
  const profilesRef = useRef<TerminalProfile[] | null>(null);
  // profile 列表状态（供 TabBar 下拉菜单展示）
  const [terminalProfiles, setTerminalProfiles] = useState<TerminalProfile[]>([]);
  // 当前激活会话（从 store tabs 派生）：供集成终端 cwd 默认取值、Sidebar 高亮、绿点状态。
  // 中间区 tab / 激活指针直接订阅 store。
  const tabs = useTabStore((s) => getAllTabs(s));
  const activeCwd = useTabStore((s) => s.activeCwd);
  const activeLeafId = useTabStore((s) => s.activeLeafId);
  const cwdTrees = useTabStore((s) => s.cwdTrees);
  // 从 active leaf 派生 activeTabId（store 的顶层 activeTabId 仅在部分 action 中维护，
  // 故此处以 active leaf 为准）。
  const activeTabId = activeLeafId ? findLeaf(cwdTrees, activeLeafId)?.leaf.activeTabId ?? null : null;
  const activeSession = tabs.find((t) => t.id === activeTabId && t.kind === 'session') as SessionTab | undefined;
  // 最后活跃会话目录：即使当前激活 tab 是预览/diff，也保留上一次的 cwd，
  // 供右栏文件树/Git 自动模式稳定跟随。
  // 同时持久化到 config.lastActiveDir，跨会话记住用户上一次选择的目录。
  const [lastSessionCwd, setLastSessionCwd] = useState<string | null>(null);
  useEffect(() => { if (activeCwd) { setLastSessionCwd(activeCwd); pi.setConfig({ lastActiveDir: activeCwd }).catch(() => {}); } }, [activeCwd]);
  const activeStatus = activeSession ? statusMap[activeSession.key] : undefined;
  // 文件预览：打开的文件（root + 相对路径 + 可选本地绝对路径用于 webview）。
  // liveToDisk, liveToDiskRef, ptyOwnersRef, virtualSessions
  // 已提取到 useSessionStatus hook
  // 如果当前 PTY owner 是虚拟 session（/new 创建），侧边栏高亮应指向虚拟条目而非原始 PTY tab
  const activeSessionKey = activeSession?.key ?? null;
  const activeOwner = activeSessionKey ? ptyOwnersRef.current.get(activeSessionKey) : undefined;
  const sidebarActiveKey = activeOwner !== undefined && activeOwner !== activeSessionKey
    ? activeOwner
    : activeSessionKey;

  useEffect(() => {
    initTheme().catch(() => {});
    initFontSize().catch(() => {});
    // 初始化面板布局配置 + 恢复上次打开的工作目录
    pi.getConfig().then((cfg) => {
      initFromConfig(cfg);
      if (cfg.lastActiveDir) {
        useTabStore.getState().setActiveCwd(cfg.lastActiveDir);
      }
    }).catch(() => {});
    // 启动动画：首屏（App 挂载）即视为就绪（见 docs/adr/0003 决策⑤a）。
    // 下一帧给 #splash 加 .splash--hidden 触发 CSS 淡出，并通知主进程 show() 窗口。
    // 用 rAF 确保过渡生效（避免同帧加 class 被合并为无过渡）；reduced-motion 下 CSS
    // 已禁用过渡，故等同于直接隐藏。window.pi 缺失（测试）时安全跳过。
    requestAnimationFrame(() => {
      const splash = document.getElementById('splash');
      if (splash) splash.classList.add('splash--hidden');
      pi.splashDone?.();
      // 淡出结束后从 DOM 移除，避免遮挡后续交互（pointer-events 已在 CSS 置 none）。
      setTimeout(() => splash?.remove(), 400);
    });
    // 订阅集成终端进程退出：移除对应 tab，若其为激活态则切到下一个可见 tab。
    const offTermExit = pi.onTerminalExit?.((id) => {
      useTabStore.getState().removeTerminalTab(id);
    });
    // 订阅主进程主动推送的集成终端实例列表（create/destroy/exit 时），
    // 保证左侧分组计数实时（对齐 ADR §6「主动推送，避免轮询」）。
    const offTermList = pi.onTerminalList?.((list) => useTabStore.getState().setTerminals(list));
    // 预加载终端 profile 列表（供 TabBar 下拉菜单展示）
    pi.listTerminalProfiles()
      .then((profiles) => {
        profilesRef.current = profiles;
        setTerminalProfiles(profiles);
      })
      .catch(() => {});
    // 订阅 pi 进程内部执行 /new 时主进程的推送已在 useSessionStatus 中处理
    return () => { offTermExit?.(); offTermList?.(); };
  }, []);
  // passive wheel 监听器执行，调用 preventDefault 阻止浏览器原生页面缩放。
  // 滚轮向上（deltaY<0）放大、向下缩小，步长 ±1px，夹在 [FONT_SIZE_MIN, FONT_SIZE_MAX]。
  useEffect(() => {
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return; // 仅 Ctrl/Cmd+滚轮触发；普通滚动留给终端/页面。
      e.preventDefault();
      const dir = e.deltaY < 0 ? 1 : -1;
      // 高通：忽略极小的物理刻度抖动，避免误触微调（触控板小步幅仍生效）。
      if (Math.abs(e.deltaY) < 1) return;
      bumpFontSize(dir);
    };
    window.addEventListener('wheel', onWheel, { passive: false, capture: true });
    return () => { window.removeEventListener('wheel', onWheel, { capture: true } as EventListenerOptions); };
  }, []);

  // 侧边栏只渲染 disk 会话；live 会话默认只活在终端区，发消息写盘后才出现。
  // 但用户希望“未晋升”的 live 会话也立刻显示在左侧栏（按 cwd 混进对应分组，
  // 标 unsaved）。该合并逻辑已收进 useSidebarState（见其 liveUnsaved 派生），
  // App 仅把 liveToDisk 传过去以排除已晋升的 live，避免重复出现两条。

  const handleOpen = async (req: { key?: string; cwd?: string; name?: string; leafId?: string }) => {
    setError(null);
    try {
      // 虚拟 session（pi-<uuid>）：通过 IPC 查询 PtyOwnershipRegistry
      if (req.key?.startsWith('pi-')) {
        const result = await pi.queryPtyOwner?.(req.key);
        const ptyId = result?.virtual ?? result?.ptyId;
        if (ptyId) {
          const storeState = useTabStore.getState();
          const allTabs = getAllTabs(storeState);
          const existing = allTabs.find(
            (t): t is SessionTab => t.kind === 'session' && t.key === ptyId,
          );
          useTabStore.getState().openSession({
            key: ptyId,
            cwd: existing?.cwd ?? req.cwd,
            name: existing?.name ?? req.name,
          }, req.leafId);
        }
        return;
      }
      // 旧条目（live key，PTY 已被 /new 重新分配）：spawn 新进程
      // 注意：disk key（.jsonl）不走此路径，由正常流程打开已保存的会话文件
      if (req.key?.startsWith('live-')) {
        const result = await pi.queryPtyOwner?.(req.key);
        const reassignedPtyIds = result?.virtual ? new Set([result.virtual]) : new Set();
        if (reassignedPtyIds.has(req.key)) {
          const info = await pi.openSession({ cwd: req.cwd, name: req.name });
          useTabStore.getState().openSession({ key: info.key, cwd: info.cwd, name: info.name }, req.leafId);
          ptyOwnersRef.current = new Map(ptyOwnersRef.current).set(info.key, info.key);
          pi.registerPtyOwner?.(info.key, info.key);
          return;
        }
      }
      const info = await pi.openSession(req.key ? { key: req.key } : { cwd: req.cwd, name: req.name });
      // 新增或激活 session tab 统一收编进 store（openSession action 已封装「已存在则
      // 取消隐藏并激活、不存在则新增并激活」逻辑，与「关闭=隐藏、重开=恢复」语义一致）。
      useTabStore.getState().openSession({ key: info.key, cwd: info.cwd, name: info.name }, req.leafId);
      // 注册 PTY 初始 owner（自身 key 为初始 owner，/new 时转移给新 session）
      ptyOwnersRef.current = new Map(ptyOwnersRef.current).set(info.key, info.key);
      pi.registerPtyOwner?.(info.key, info.key);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  // 点击文件树/Git 面板中的文件 → 中间区新增/激活预览 tab（单文件）。
  // 非文本文件（二进制/不可预览）→ 直接用系统默认程序打开，不创建空 tab。
  const handleOpenFile = async (relPath: string, fileName: string, root: string) => {
    try {
      const res = await pi.fsReadFile(root, relPath);
      if (res?.isDirectory) {
        // 目录：用系统默认程序打开（文件管理器），不创建 tab
        const abs = `${root.replace(/[\\/]+$/, '')}/${relPath.replace(/^[\\/]+/, '')}`;
        await pi.fsOpenWithSystem(abs).catch(() => {});
        return;
      }
      if (res?.isBinary) {
        // 二进制文件（如 exe/pdf/zip 等）无内置预览器，交系统默认程序打开
        const abs = `${root.replace(/[\\/]+$/, '')}/${relPath.replace(/^[\\/]+/, '')}`;
        await pi.fsOpenWithSystem(abs);
        return;
      }
    } catch {
      // 读取失败（如 ENOENT）降级创建 tab，由 PreviewTab 显示错误提示
    }
    // 统一收编进 store（openPreview action 封装「已存在则激活、不存在则新增」）。
    // title 由 store 按 fileName 或 path 末段计算，对应用户可见的文件名。
    useTabStore.getState().openPreview(root, relPath, fileName);
  };

  // 点击 Git 面板的「工作区改动」或某次提交 → 中间区新增/激活 diff tab（替代旧式 GitDiffDrawer）。
  // commitHash 为 null 时显示工作区 diff；为某 hash 时显示该提交 diff。
  const openWorkDiff = useCallback((cwd: string) => {
    useTabStore.getState().openDiff(cwd, null);
  }, []);
  const openCommitDiff = useCallback((cwd: string, hash: string) => {
    useTabStore.getState().openDiff(cwd, hash);
  }, []);

  // 待确认的危险操作：单条删除 / 清空目录 / 批量删除，统一用一份确认弹窗。
  type PendingDelete =
    | { kind: 'session'; key: string; name: string }
    | { kind: 'directory'; cwd: string; count: number }
    | { kind: 'batch'; keys: string[]; count: number };
  const [confirm, setConfirm] = useState<PendingDelete | null>(null);

  // 多选模式：进入后侧边栏每条会话出现 checkbox，点击切换勾选；用于批量删除。
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const handleEnterSelect = () => setSelectionMode(true);
  const handleExitSelect = (clear = true) => {
    setSelectionMode(false);
    if (clear) setSelectedKeys(new Set());
  };
  const handleToggleSelect = (key: string) => {
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  const handleDeleteRequest = (key: string, name: string) => setConfirm({ kind: 'session', key, name });
  const handleDeleteDirect = async (key: string, _name: string) => {
    try {
      await pi.deleteSession(key);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };
  // 用于 session-content 页面的删除：带确认弹窗，确认后关闭对应 tab
  const pendingCloseTabIdRef = useRef<string | null>(null);
  const handleDeleteSessionRequest = useCallback((key: string, name: string, tabId: string) => {
    pendingCloseTabIdRef.current = tabId;
    setConfirm({ kind: 'session', key, name });
  }, []);

  const handleClearDirectory = (cwd: string) => {
    const count = disk.filter((d) => d.cwd === cwd).length;
    setConfirm({ kind: 'directory', cwd, count });
  };

  const handleBatchDelete = () => {
    if (selectedKeys.size === 0) return;
    setConfirm({ kind: 'batch', keys: [...selectedKeys], count: selectedKeys.size });
  };

  const handleDeleteConfirm = async () => {
    if (!confirm) return;
    const pending = confirm;
    setConfirm(null);
    setError(null);
    try {
      if (pending.kind === 'session') {
        await pi.deleteSession(pending.key);
        // 关闭对应的 session-content tab（如果有）
        const tabId = pendingCloseTabIdRef.current;
        pendingCloseTabIdRef.current = null;
        if (tabId) {
          useTabStore.getState().closeCenterTab(tabId);
        }
      } else if (pending.kind === 'directory') {
        await pi.clearDirectory(pending.cwd);
        handleExitSelect(true); // 清空后退出多选态并清空选择
      } else {
        await pi.deleteMany(pending.keys);
        handleExitSelect(true); // 批量删除后退出多选态并清空选择
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleTerminate = async (key: string) => {
    // 虚拟 session 的 key 是 pi-<uuid>，需要翻译成 PTY 的 live key
    if (key.startsWith('pi-')) {
      const result = await pi.queryPtyOwner?.(key);
      const ptyId = result?.virtual;
      if (ptyId) { pi.terminate(ptyId); return; }
    }
    pi.terminate(key);
  };

  // —— 集成终端创建 ——
  // 在指定目录创建集成终端。若未指定 cwd，使用当前活跃目录。
  const appWorkDirRef = useRef(appWorkDir);
  appWorkDirRef.current = appWorkDir;

  const doCreateTerminal = useCallback(async (cwd?: string) => {
    try {
      if (!profilesRef.current) profilesRef.current = await pi.listTerminalProfiles();
      const profiles = profilesRef.current;
      const cfg = await pi.getConfig();
      const defaultId = cfg.defaultTerminalProfile;
      const profile = (defaultId && profiles.find((p) => p.id === defaultId)) || profiles[0];
      if (!profile) return;
      const targetCwd = cwd || useTabStore.getState().activeCwd || appWorkDirRef.current || defaultConfig().appWorkDir || '';
      const info = await pi.spawnTerminal({ command: undefined, cwd: targetCwd, profile });
      useTabStore.getState().openTerminal(info.id, info.cwd, info.title);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const handleNewTerminalInCwd = useCallback((cwd: string) => doCreateTerminal(cwd), [doCreateTerminal]);
  const handleNewTerminalInAppWorkDir = useCallback(() => doCreateTerminal(appWorkDirRef.current || ''), [doCreateTerminal]);

  // 在中间区 TabBar 新建终端（默认 profile）
  const handleNewTerminal = useCallback(() => {
    doCreateTerminal();
  }, [doCreateTerminal]);

  // 在中间区 TabBar 新建终端（指定 profile）
  const handleNewTerminalWithProfile = useCallback(async (profileId: string) => {
    try {
      const profiles = profilesRef.current;
      if (!profiles) return;
      const profile = profiles.find((p) => p.id === profileId);
      if (!profile) return;
      const targetCwd = useTabStore.getState().activeCwd || appWorkDirRef.current || defaultConfig().appWorkDir || '';
      const info = await pi.spawnTerminal({ command: undefined, cwd: targetCwd, profile });
      useTabStore.getState().openTerminal(info.id, info.cwd, info.title);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  // 点击侧边栏目录名称 → 切换到该目录的 tab 条，不打开新会话。
  const handleSelectCwd = useCallback((cwd: string) => {
    useTabStore.getState().setActiveCwd(cwd);
  }, []);

  // 集成终端 × 关闭：杀 PTY 再移除 tab（区别于 session 的 keep-alive 隐藏）。
  // 对齐用户预期：关闭终端 tab ≡ 终止终端进程，侧边栏计数相应减一。
  // 必须异步：pi.destroyTerminal 返回 Promise，主进程处理完后 push terminal:list。
  const handleDestroyTerminal = useCallback(async (id: string) => {
    try {
      await pi.destroyTerminal(id);
      // destroyTerminal 触发主进程 terminal:destroy → pushTerminalList →
      // terminal:list IPC → onTerminalList → setTerminals → 侧边栏计数自动更新。
      useTabStore.getState().closeTab(id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  // 关闭 session tab → 终止进程 + 真移除 tab（区别于 keep-alive 隐藏）。
  // 对齐用户预期：关闭终端 tab ≡ 终止终端进程。
  const handleDestroySession = useCallback(async (id: string) => {
    try {
      const storeState = useTabStore.getState();
      const allTabs = getAllTabs(storeState);
      const tab = allTabs.find((t) => t.id === id) as SessionTab | undefined;
      if (tab) {
        await pi.terminate(tab.key);
      }
      useTabStore.getState().closeTab(id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  // 侧边栏右键「查看会话」：在中间区以 tab 形式展示会话内容。
  const handleViewContent = useCallback((sessionKey: string, sessionName: string) => {
    // 从 disk 中查找该会话的 cwd
    const session = disk.find((d) => d.key === sessionKey);
    const cwd = session?.cwd ?? appWorkDir;
    useTabStore.getState().openSessionContent(sessionKey, sessionName, cwd);
  }, [disk, appWorkDir]);

  // 分屏：创建新 leaf + 自动创建终端
  const handleSplitPane = useCallback(async (leafId: string, direction: 'horizontal' | 'vertical') => {
    try {
      // 在 split 前获取 parent leaf 的 active tab 的 cwd
      const storeState = useTabStore.getState();
      const found = findLeaf(storeState.cwdTrees, leafId);
      if (!found) return;
      const { leaf } = found;
      const activeTab = leaf.tabs.find((t) => t.id === leaf.activeTabId);
      const parentCwd = activeTab ? getTabCwd(activeTab) : storeState.activeCwd || appWorkDirRef.current || '';

      // 创建分屏结构
      useTabStore.getState().splitPane(leafId, direction);
      // 立即捕获新 leaf 的 id（双重保险：即使事件冒泡改变了 activeLeafId，
      // 这里也有正确的引用）
      const newLeafId = useTabStore.getState().activeLeafId;

      // 在新 leaf 中创建终端
      if (parentCwd) {
        const profiles = profilesRef.current;
        if (!profiles) return;
        const cfg = await pi.getConfig();
        const defaultId = cfg.defaultTerminalProfile;
        const profile = (defaultId && profiles.find((p) => p.id === defaultId)) || profiles[0];
        if (!profile) return;
        const info = await pi.spawnTerminal({ command: undefined, cwd: parentCwd, profile });
        // 显式指定 newLeafId，确保终端加到新 leaf（而非依赖 activeLeafId）
        useTabStore.getState().openTerminal(info.id, info.cwd, info.title, newLeafId ?? undefined);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  return (
    <ToastProvider>
    <div className="app">
      <TitleBar
        onOpenSettings={() => setSettingsOpen(true)}
        sidebarCollapsed={sidebarCollapsed}
        onToggleSidebar={handleToggleSidebar}
        rightPanelCollapsed={rightPanelCollapsed}
        onToggleRightPanel={handleToggleRightPanel}
      />
      <div className="app-shell">
      <Sidebar
        sessions={sessions}
        statusMap={statusMap}
        activeKey={sidebarActiveKey}
        pinned={pinned}
        onOpen={handleOpen}
        onTerminate={handleTerminate}
        onPickDirectory={handlePickDirectory}
        onRemoveDir={handleRemoveDir}
        addedDirs={addedDirs}
        onTogglePin={handleTogglePin}
        onDeleteSession={handleDeleteRequest}
        onDeleteSessionDirect={handleDeleteDirect}
        relink={liveToDisk}
        selectionMode={selectionMode}
        selectedKeys={selectedKeys}
        onToggleSelect={handleToggleSelect}
        onClearDirectory={handleClearDirectory}
        onEnterSelect={handleEnterSelect}
        onExitSelect={handleExitSelect}
        onBatchDelete={handleBatchDelete}
        sidebarWidth={sidebarWidth}
        onSidebarResize={handleSidebarResize}
        appWorkDir={appWorkDir}
        onNewTerminalInAppWorkDir={handleNewTerminalInAppWorkDir}
        onNewTerminalInCwd={handleNewTerminalInCwd}
        onSelectCwd={handleSelectCwd}
        collapsedGroups={collapsedGroups}
        onCollapseGroup={handleCollapseGroup}
        onViewContent={handleViewContent}
        collapsed={sidebarCollapsed}
      />
      <CenterPane
        onOpenFile={handleOpenFile}
        onDestroyTerminal={handleDestroyTerminal}
        onDestroySession={handleDestroySession}
        addedDirs={Array.from(visibleDirs)}
        onOpen={handleOpen}
        onNewTerminal={handleNewTerminal}
        onNewTerminalWithProfile={handleNewTerminalWithProfile}
        terminalProfiles={terminalProfiles}
        onSplitPane={handleSplitPane}
        onDeleteSession={handleDeleteDirect}
        onDeleteSessionRequest={handleDeleteSessionRequest}
      />
      <RightPanel
        addedDirs={Array.from(visibleDirs)}
        activeCwd={lastSessionCwd}
        onPickDirectory={(cwd) => { pi.setConfig({ lastActiveDir: cwd }).catch(() => {}); }}
        onOpenFile={handleOpenFile}
        onAddWorkDir={(absDir: string) => {
          // 已在左侧工作目录中（含应用工作目录）→ 静默忽略
          if (visibleDirs.has(absDir)) return;
          handleAddDirectory(absDir);
          const dirName = absDir.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || absDir;
          toast('已添加工作目录：' + dirName);
        }}
        onOpenWorkDiff={openWorkDiff}
        onOpenCommit={openCommitDiff}
        onOpenCommitFile={(cwd, hash, filePath) => {
          useTabStore.getState().openDiff(cwd, hash, undefined, filePath);
        }}
        width={rightPanelWidth}
        onResize={handleRightPanelResize}
        collapsed={rightPanelCollapsed}
      />
      </div>
      {confirm && (
        <ConfirmDialog
          title={confirm.kind === 'directory' ? '清空目录' : '删除会话'}
          message={
            confirm.kind === 'session'
              ? `确定删除会话「${confirm.name}」？该会话文件将被删除且不可恢复，若进程正在运行也会被终止。`
              : confirm.kind === 'directory'
                ? `确定清空目录「${confirm.cwd}」下的 ${confirm.count} 个会话？运行中的进程将被终止，文件不可恢复。`
                : `确定删除选中的 ${confirm.count} 个会话？运行中的进程将被终止，文件不可恢复。`
          }
          onConfirm={handleDeleteConfirm}
          onCancel={() => setConfirm(null)}
        />
      )}
      <WindowResizeZones />
      {settingsOpen && <SettingsPanel onClose={() => setSettingsOpen(false)} />}
    </div>
    </ToastProvider>
  );
}
