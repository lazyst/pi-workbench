import { useEffect, useState, useRef, useCallback, type MouseEvent } from 'react';
import type { SessionStatus } from '../types';
import { IconNewSession, IconPin, IconTrash, IconRemoveDir, IconTerminal } from './icons';
import { ContextMenu } from './ContextMenu';
import { clampSidebarWidth } from './sidebarGeometry';
import { defaultConfig } from '../../../main/config';

interface Session { key: string; cwd: string; name: string; time?: string; unsaved?: boolean; }
interface Props {
  sessions: Session[];
  statusMap: Record<string, SessionStatus>;
  activeKey?: string | null;
  pinned: string[];
  onOpen: (req: { key?: string; cwd?: string; name?: string }) => void;
  onTerminate: (key: string) => void;
  onPickDirectory: () => void;
  onRemoveDir: (cwd: string) => void;
  onTogglePin: (cwd: string) => void;
  onDeleteSession: (key: string, name: string) => void;
  /** 直接删除（跳过确认弹窗），供 hover 内联确认使用 */
  onDeleteSessionDirect?: (key: string, name: string) => void;
  /** 右键「查看会话」：在中间区以 tab 形式展示会话内容。 */
  onViewContent?: (key: string, name: string) => void;
  // 多选模式：整条侧边栏进入选择态，每条会话显示 checkbox，点击切换勾选。
  selectionMode?: boolean;
  selectedKeys?: Set<string>;
  onToggleSelect?: (key: string) => void;
  onClearDirectory?: (cwd: string) => void;
  onEnterSelect?: () => void;
  onExitSelect?: (clear?: boolean) => void;
  onBatchDelete?: () => void;
  // live `live-<uuid>` key → on-disk `.jsonl` path, so a promoted session can be
  // highlighted as active using its on-disk key.
  relink?: Record<string, string>;
  // 侧边栏宽度（持久化于 config.sidebarWidth）与拖拽松手后的回写回调
  // （见 docs/adr/0001 决策④）。
  sidebarWidth?: number;
  onSidebarResize?: (w: number) => void;
  // 用户“添加目录”显式注册的目录列表：即使该目录下暂无会话，也需在侧边栏
  // 渲染出对应分组，保证“移除目录 / 新建会话 / 清空目录 / 置顶”等功能可用。
  addedDirs?: string[];
  // 「应用工作目录」分组的根目录（config.appWorkDir，默认 ~/piDesktop）。
  // 始终渲染为一个独立分组，收容与具体项目无关、与 pi-agent 闲聊/临时的集成终端。
  appWorkDir?: string;
  // 在「应用工作目录」分组下新建集成终端的入口。
  onNewTerminalInAppWorkDir?: () => void;
  // 在各项目分组（cwd）下新建集成终端的入口，传入具体目录。
  onNewTerminalInCwd?: (cwd: string) => void;
  /** 点击目录名称 → 切换到该目录的 tab 条。 */
  onSelectCwd?: (cwd: string) => void;
  // 已折叠的分组 cwd 列表（持久化），用于跨会话记住折叠状态。
  collapsedGroups?: string[];
  // 折叠状态变更回调：与 onSidebarResize 同模式，由 App 回写 config。
  onCollapseGroup?: (cwd: string, collapsed: boolean) => void;
  // 左侧栏整体折叠
  collapsed?: boolean;
}

export function Sidebar({ sessions, statusMap, activeKey, pinned, onOpen, onTerminate, onPickDirectory, onRemoveDir, onTogglePin, onDeleteSession, onDeleteSessionDirect, onViewContent, relink,
  selectionMode, selectedKeys, onToggleSelect, onClearDirectory, onEnterSelect, onExitSelect, onBatchDelete,
  sidebarWidth, onSidebarResize, addedDirs, appWorkDir, onNewTerminalInAppWorkDir, onNewTerminalInCwd, onSelectCwd,
  collapsedGroups, onCollapseGroup, collapsed }: Props) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [menu, setMenu] = useState<{ key: string; name: string; x: number; y: number } | null>(null);
  const [confirmingKey, setConfirmingKey] = useState<string | null>(null);

  // 侧边栏宽度由 state 控制（初始取 config.sidebarWidth，默认 280）；拖拽实时改、松手经
  // onSidebarResize 回写 config（见 docs/adr/0001 决策④）。
  const sidebarRef = useRef<HTMLElement>(null);
  const [width, setWidth] = useState<number>(sidebarWidth ?? defaultConfig().sidebarWidth);
  const widthRef = useRef<number>(width);
  // 异步加载的 config.sidebarWidth 经 prop 流入时，同步到本地宽度 state；
  // 拖拽过程中只走本地 setWidth（prop 不变，故本 effect 不触发），因此不冲突。
  useEffect(() => {
    if (sidebarWidth != null) setWidth(sidebarWidth);
  }, [sidebarWidth]);
  const resizeStart = useRef<{ startX: number; startWidth: number } | null>(null);
  // 把最新的 onSidebarResize 存进 ref，使拖拽监听回调保持稳定、不依赖 prop 身份。
  const onResizeRef = useRef(onSidebarResize);
  onResizeRef.current = onSidebarResize;

  const onResizerMove = useCallback((e: globalThis.MouseEvent) => {
    const s = resizeStart.current;
    if (!s) return;
    const next = clampSidebarWidth(s.startWidth + (e.clientX - s.startX), window.innerWidth);
    widthRef.current = next;
    setWidth(next); // 实时跟手；终端区靠既有 ResizeObserver 自动重排
  }, []);

  const onResizerUp = useCallback(() => {
    resizeStart.current = null;
    document.removeEventListener('mousemove', onResizerMove);
    document.removeEventListener('mouseup', onResizerUp);
    if (onResizeRef.current) onResizeRef.current(widthRef.current);
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  }, [onResizerMove]);

  const onResizerDown = useCallback((e: MouseEvent) => {
    e.preventDefault();
    // jsdom / 隐藏态下 offsetWidth 为 0，退回当前跟踪宽度（真实浏览器走 offsetWidth）。
    const startWidth = sidebarRef.current?.offsetWidth || widthRef.current;
    resizeStart.current = { startX: e.clientX, startWidth };
    document.addEventListener('mousemove', onResizerMove);
    document.addEventListener('mouseup', onResizerUp);
    // 拖拽期间锁定光标与文本选择，避免侧边栏长文本被选中导致 mousemove 中断（不跟手）。
    document.body.style.cursor = 'ew-resize';
    document.body.style.userSelect = 'none';
  }, [onResizerMove, onResizerUp]);

  // A new session is keyed `live-<uuid>` in the terminal area but appears in the
  // sidebar under its on-disk `.jsonl` path once promoted. Map the active key to
  // its disk path so the promoted entry is highlighted as active.
  const effectiveActive = activeKey ? (relink?.[activeKey] ?? activeKey) : null;

  // 分组按 cwd；置顶分组排到最前（保持置顶先后顺序），其余维持原序。
  const pinnedSet = new Set(pinned);
  const rawGroups: Array<{ cwd: string; items: Session[]; isAppWorkDir?: boolean }> = [];
  const cwdIndex = new Map<string, number>();
  for (const s of sessions) {
    let i = cwdIndex.get(s.cwd);
    if (i === undefined) { i = rawGroups.length; cwdIndex.set(s.cwd, i); rawGroups.push({ cwd: s.cwd, items: [] }); }
    rawGroups[i].items.push(s);
  }
  const groups = [...rawGroups].sort((a, b) => {
    const pa = pinnedSet.has(a.cwd) ? pinned.indexOf(a.cwd) : Number.MAX_SAFE_INTEGER;
    const pb = pinnedSet.has(b.cwd) ? pinned.indexOf(b.cwd) : Number.MAX_SAFE_INTEGER;
    return pa - pb;
  });
  // 确保“添加目录”注册的每个目录都渲染出分组——即使该目录下暂无会话，
  // 也需显示分组以使用“移除目录 / 新建会话 / 清空目录 / 置顶”等功能。
  // 仅补充 sessions 中尚不存在的 cwd，避免重复分组。
  for (const cwd of addedDirs ?? []) {
    if (!cwdIndex.has(cwd)) groups.push({ cwd, items: [] });
  }
  // 始终渲染「应用工作目录」分组（收容与具体项目无关的闲聊/临时集成终端），
  // 即使其下暂无会话也显示，以提供独立的新建入口。
  // 避免重复：如果 appWorkDir 已在 addedDirs 中，不再重复添加
  if (appWorkDir && !cwdIndex.has(appWorkDir) && !addedDirs?.includes(appWorkDir)) {
    groups.push({ cwd: appWorkDir, items: [], isAppWorkDir: true });
  }

  // 组内会话排序：未晋升（unsaved）的排最前，其余按时间倒序（最新在前）。
  // time 形如 'YYYY-MM-DD HH:MM'，字典序即时间序。
  const sortedItems = (items: Session[]): Session[] =>
    [...items].sort((a, b) => {
      if (a.unsaved && !b.unsaved) return -1;
      if (!a.unsaved && b.unsaved) return 1;
      return (b.time ?? '').localeCompare(a.time ?? '');
    });

  return (
    <>
      <aside className={`sidebar${collapsed ? ' sidebar--collapsed' : ''}`} ref={sidebarRef} style={{ width: collapsed ? 0 : width }}>
      <div className="sidebar-header">
        <span className="sidebar-title">会话</span>
        <div className="sidebar-actions">
          {selectionMode ? (
            <>
              <span className="select-count">已选 {selectedKeys?.size ?? 0} 项</span>
              <button className="btn btn-danger" data-action="batch-delete" onClick={onBatchDelete}>删除</button>
              <button className="btn" data-action="exit-select" onClick={() => onExitSelect?.(true)}>取消</button>
            </>
          ) : (
            <>
              <button className="btn" onClick={onPickDirectory}>+ 目录</button>
              <button className="btn" data-action="enter-select" title="选择会话进行批量删除" onClick={onEnterSelect}>管理</button>
            </>
          )}
        </div>
      </div>
      <div className="session-list">
        {groups.map((g) => {
          const isPinned = pinnedSet.has(g.cwd);
          const isCollapsed = collapsedGroups?.includes(g.cwd) ?? false;
          const isOpen = !!expanded[g.cwd];
          const items = sortedItems(g.items);
          const visible = isOpen ? items : items.slice(0, 5);
          const hidden = items.length - visible.length;
          return (
            <div key={g.cwd} className={`group${isPinned ? ' pinned' : ''}${isCollapsed ? ' collapsed' : ''}`}>
              <div className="group-title" title={isCollapsed ? '展开分组' : '折叠分组'} onClick={() => onCollapseGroup?.(g.cwd, !isCollapsed)}>
                <span
                  className="group-collapse-icon"
                  title={isCollapsed ? '展开' : '折叠'}
                  aria-label={isCollapsed ? '展开分组' : '折叠分组'}
                >
                  {isCollapsed ? '▶' : '▼'}
                </span>
                <span className="group-name" title={g.cwd}>
                  {`📁 ${g.cwd.split(/[\\/]/).pop() || g.cwd}`}
                </span>
                <span className="group-actions">
                  <button
                    className="icon-btn"
                    title={`置顶 ${g.cwd}`}
                    aria-label={`置顶 ${g.cwd}`}
                    data-action="pin"
                    onClick={(e) => { e.stopPropagation(); onTogglePin(g.cwd); }}
                  >
                    <IconPin />
                  </button>
                  <button
                    className="icon-btn"
                    title={`在 ${g.cwd} 新建会话`}
                    aria-label={`在 ${g.cwd} 新建会话`}
                    data-action="new-session"
                    onClick={(e) => { e.stopPropagation(); onOpen({ cwd: g.cwd }); }}
                  >
                    <IconNewSession />
                  </button>
                  <button
                    className="icon-btn"
                    title={`在 ${g.cwd} 新建集成终端`}
                    aria-label={`在 ${g.cwd} 新建集成终端`}
                    data-action="new-terminal"
                    onClick={(e) => { e.stopPropagation(); g.isAppWorkDir ? onNewTerminalInAppWorkDir?.() : onNewTerminalInCwd?.(g.cwd); }}
                  >
                    <IconTerminal />
                  </button>
                  {g.isAppWorkDir ? null : (
                    <button
                      className="icon-btn"
                      title={`从侧边栏移除目录 ${g.cwd}（不会删除会话文件）`}
                      aria-label={`移除目录 ${g.cwd}`}
                      data-action="remove-directory"
                      onClick={(e) => { e.stopPropagation(); onRemoveDir(g.cwd); }}
                    >
                      <IconRemoveDir />
                    </button>
                  )}
                  <button
                    className="icon-btn"
                    title={`清空 ${g.cwd} 下的所有会话`}
                    aria-label={`清空 ${g.cwd}`}
                    data-action="clear-directory"
                    onClick={(e) => { e.stopPropagation(); onClearDirectory?.(g.cwd); }}
                  >
                    <IconTrash />
                  </button>
                </span>
              </div>
              {!isCollapsed && (<>
              {visible.map((s) => {
                const running = statusMap[s.key] === 'running';
                // 仅当会话明确处于 'running' 时才显示「终止进程」。磁盘历史/未启动会话
                // 在渲染层初始化（listSessions / onIndex）时已被补为 'dead'，故不会误显
                // 按钮；极早期首屏（statusMap 尚未就绪、该 key 为 undefined）也按不可终止
                // 处理，避免对“根本没有进程”的会话提供无意义的终止入口。
                const canTerminate = running;
                const isActive = s.key === effectiveActive;
                const selected = !!selectedKeys?.has(s.key);
                // 未晋升（live 未落盘）会话：无文件可删，仅允许终止；因此不显示右键删除菜单。
                const isUnsaved = !!s.unsaved;
                // 多选模式下：整条变为可勾选行，点击切换选中，不再打开终端面板。
                if (selectionMode) {
                  return (
                    <div
                      key={s.key}
                      data-key={s.key}
                      className={`session-item selectable${selected ? ' selected' : ''}${isUnsaved ? ' unsaved' : ''}`}
                      tabIndex={0}
                      aria-label={`选择会话 ${s.name}`}
                      aria-pressed={selected}
                      onClick={() => onToggleSelect?.(s.key)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          onToggleSelect?.(s.key);
                        }
                      }}
                    >
                      <input
                        type="checkbox"
                        className="select-box"
                        checked={selected}
                        tabIndex={-1}
                        onClick={(e) => e.stopPropagation()}
                        onChange={() => onToggleSelect?.(s.key)}
                      />
                      <span className="session-name">
                        <div className="name">{s.name}{isUnsaved && <span className="unsaved-badge">未保存</span>}</div>
                        {s.time && <div className="time">{s.time}</div>}
                      </span>
                    </div>
                  );
                }
                return (
                  <div
                    key={s.key}
                    data-key={s.key}
                    className={`session-item${isActive ? ' active' : ''}${isUnsaved ? ' unsaved' : ''}`}
                    tabIndex={0}
                    aria-label={`打开会话 ${s.name}`}
                    onClick={() => onOpen({ key: s.key })}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        onOpen({ key: s.key });
                      }
                    }}
                    onContextMenu={(e) => {
                      // 未晋升会话无磁盘文件，禁止“删除会话”（只有终止），故不弹右键菜单。
                      if (isUnsaved) return;
                      e.preventDefault();
                      setMenu({ key: s.key, name: s.name, x: e.clientX, y: e.clientY });
                    }}
                    onMouseLeave={() => {
                      if (confirmingKey === s.key) setConfirmingKey(null);
                    }}
                  >
                    <span className={`dot ${running ? 'running' : ''}`} />
                    <span className="session-name">
                      <div className="name">{s.name}{isUnsaved && <span className="unsaved-badge">未保存</span>}</div>
                      {s.time && <div className="time">{s.time}</div>}
                    </span>
                    {canTerminate && (
                      <button className="terminate" title="终止进程" onClick={(e) => { e.stopPropagation(); onTerminate(s.key); }}>终止进程</button>
                    )}
                    {!isUnsaved && !canTerminate && (
                      <>
                        <button
                          className="session-action-btn"
                          title="查看会话内容"
                          onClick={(e) => { e.stopPropagation(); onViewContent?.(s.key, s.name); }}
                        >
                          查看
                        </button>
                        <button
                          className={`session-action-btn${confirmingKey === s.key ? ' confirming' : ''}`}
                          title={confirmingKey === s.key ? '确认删除' : '删除会话'}
                          onClick={(e) => {
                            e.stopPropagation();
                            if (confirmingKey === s.key) {
                              (onDeleteSessionDirect ?? onDeleteSession)(s.key, s.name);
                              setConfirmingKey(null);
                            } else {
                              setConfirmingKey(s.key);
                            }
                          }}
                        >
                          {confirmingKey === s.key ? '确认删除' : '删除'}
                        </button>
                      </>
                    )}
                  </div>
                );
              })}
              {items.length > 5 && (
                <div
                  className="group-expand"
                  onClick={() => setExpanded((m) => ({ ...m, [g.cwd]: !isOpen }))}
                >
                  {isOpen ? '收起' : `展开 ${hidden} 个更多`}
                </div>
              )}
              </>)}
            </div>
          );
        })}
      </div>
      {/* 右侧 4px 拖拽条：整高、ew-resize、hover 淡高亮；与窗口右缘的 rz-right 缩放热区不冲突 */}
      {!collapsed && (
        <div
          className="sidebar-resizer"
          onMouseDown={onResizerDown}
          role="separator"
          aria-orientation="vertical"
          aria-label="拖拽调整侧边栏宽度"
        />
      )}
      </aside>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={[
            { label: '查看会话', onClick: () => onViewContent?.(menu.key, menu.name) },
            { label: '分隔线', kind: 'separator' },
            { label: '删除会话', danger: true, onClick: () => onDeleteSession(menu.key, menu.name) },
          ]}
          onClose={() => setMenu(null)}
        />
      )}
    </>
  );
}
