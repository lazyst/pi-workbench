// 递归分屏渲染组件
//
// SplitPane 根据分屏树（SplitTree）的节点类型递归渲染：
// - SplitLeaf → TabBar + tab 内容区
// - SplitNode → 子 SplitPane + SplitDivider（递归）
//
// 所有 cwd 的分屏树同时存在于 DOM 中（keep-alive），
// 非活跃 cwd 用 opacity:0 + pointer-events:none + position:absolute 隐藏。
//
// 跨 leaf Tab 拖拽（ADR-0002）：
// - SplitPaneDragProvider 包装每个 cwd 的分屏树，持有 DndContext
// - 每个 leaf 的 TabBar 共享同一 DndContext，各自持有独立的 SortableContext
// - 通过 DragContext 将 leaf items 动态传递给 TabBar

import { useRef, useMemo, useEffect, useCallback, useState, createContext, useContext } from 'react';
import { useToast } from './Toast';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  closestCorners,
  type DragStartEvent,
  type DragEndEvent,
  type DragOverEvent,
  type DragMoveEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  horizontalListSortingStrategy,
} from '@dnd-kit/sortable';
import { TabBar } from './TabBar';
import { SplitDivider } from './SplitDivider';
import { ContextMenu } from './ContextMenu';
import type { ContextMenuItem } from './ContextMenu';
import { useSplitStore, findTabById, findLeaf, canMoveTabToLeaf } from '../store/splitStore';
import type { SplitTree, SplitLeaf, SplitNode, Tab, SessionContentTab } from '../store/splitStore';
import type { TabKind } from './TabBar';
import { SessionPane } from './SessionPane';
import { IntegratedPane } from './IntegratedPane';
import { PreviewTab } from './PreviewTab';
import { DiffTab } from './DiffTab';
import { SessionContentView } from './SessionContentView';
import { restorePaneScrollState, schedulePaneResize, setPaneActive } from './paneManager';

interface SplitTabContextMenuState {
  x: number;
  y: number;
  tabId: string;
}

interface Props {
  tree: SplitTree;
  cwd: string;
  isActive: boolean;
  onOpenFile?: (relPath: string, fileName: string, root: string) => void;
  onDestroyTerminal?: (id: string) => void;
  onDestroySession?: (id: string) => void;
  onOpen?: (req: { key?: string; cwd?: string; name?: string; leafId?: string }) => void;
  onNewTerminal?: () => void;
  onNewTerminalWithProfile?: (profileId: string) => void;
  terminalProfiles?: Array<{ id: string; label: string }>;
  closeGuards: React.MutableRefObject<Map<string, () => void>>;
  requestCloseTab: (id: string) => void;
  registerCloseGuard: (id: string, guard: (() => void) | null) => void;
  addedDirs?: string[];
  // 分屏回调
  onSplitPane?: (leafId: string, direction: 'horizontal' | 'vertical') => void;
  // 删除会话文件（直接删除，不弹确认框）
  onDeleteSession?: (key: string, name: string) => void;
  // 删除会话文件（带确认弹窗，确认后关闭对应 tab）
  onDeleteSessionRequest?: (key: string, name: string, tabId: string) => void;
}

// ── DragContext（跨 leaf 拖拽状态传递） ──

interface DragContextValue {
  /** 每个 leaf 的 SortableContext items（动态管理，含拖拽中的临时变更）。 */
  leafItems: Record<string, string[]>;
  /** 设置为 true 时表示某 leaf 正在被拖拽悬停。 */
  hoveredLeafId: string | null;
  canDrop: boolean;
  /** 注册 leaf 的 TabBar 滚动容器，供拖拽自动滚动使用。 */
  registerScrollContainer: (leafId: string, el: HTMLElement | null) => void;
}

const DragContext = createContext<DragContextValue>({
  leafItems: {},
  hoveredLeafId: null,
  canDrop: true,
  registerScrollContainer: () => {},
});

export function useDragContext() {
  return useContext(DragContext);
}

// ── SplitPaneDragProvider ──

/**
 * 跨 leaf Tab 拖拽的 DndContext 提供者。
 * 包装单个 cwd 的分屏树，所有 leaf 的 TabBar 共享此 DndContext。
 * 每个 cwd 使用独立的 SplitPaneDragProvider 实例。
 */
function SplitPaneDragProvider({
  children,
  cwd,
  isActive,
}: {
  children: React.ReactNode;
  cwd: string;
  isActive: boolean;
}) {
  // 总是渲染 SplitPaneDragProviderInner（相同组件类型），
  // 避免 isActive 切换时 Fragment ↔ SplitPaneDragProviderInner 的组件类型变化
  // 导致 React 卸载全部子节点（含所有 SessionPane → XtermTerminal 终端实例）。
  // 非活跃时 DnD 逻辑在 SplitPaneDragProviderInner 内部跳过。
  return <SplitPaneDragProviderInner cwd={cwd} isActive={isActive}>{children}</SplitPaneDragProviderInner>;
}

function SplitPaneDragProviderInner({
  children,
  cwd,
  isActive,
}: {
  children: React.ReactNode;
  cwd: string;
  isActive: boolean;
}) {
  const moveTabAcrossLeafs = useSplitStore((s) => s.moveTabAcrossLeafs);
  const reorderTabsInLeaf = useSplitStore((s) => s.reorderTabsInLeaf);
  const cwdTrees = useSplitStore((s) => s.cwdTrees);

  // 拖拽状态
  const [leafItems, setLeafItems] = useState<Record<string, string[]>>({});
  const [hoveredLeafId, setHoveredLeafId] = useState<string | null>(null);
  const [canDrop, setCanDrop] = useState(true);
  /** ref 存储 drag item，回调总能读到最新值（避免 useCallback 闭包陈旧）。 */
  const activeDragItemRef = useRef<{ tabId: string; sourceLeafId: string } | null>(null);
  /** state 仅用于驱动 DragOverlay 渲染。 */
  const [activeDragTab, setActiveDragTab] = useState<Tab | null>(null);

  // TabBar 滚动容器注册表，用于拖拽自动滚动
  const scrollContainerRefs = useRef<Map<string, HTMLElement>>(new Map());
  const registerScrollContainer = useCallback((leafId: string, el: HTMLElement | null) => {
    if (el) {
      scrollContainerRefs.current.set(leafId, el);
    } else {
      scrollContainerRefs.current.delete(leafId);
    }
  }, []);
  // hoveredLeafId 的 ref 版本，避免 useCallback 闭包陈旧
  const hoveredLeafIdRef = useRef<string | null>(null);
  hoveredLeafIdRef.current = hoveredLeafId;

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  // 构建每个 leaf 的默认 items（按 visible tab 顺序）
  // 用于初始化 leafItems 和在 leafItems 为空时兜底
  const defaultLeafItems = useMemo(() => {
    const items: Record<string, string[]> = {};
    const tree = cwdTrees[cwd];
    if (!tree) return items;
    const traverse = (node: SplitTree) => {
      if (node.type === 'leaf') {
        items[node.id] = node.tabs
          .filter((t) => !t.hidden)
          .sort((a, b) => a.order - b.order)
          .map((t) => t.id);
      } else {
        for (const child of node.children) traverse(child);
      }
    };
    traverse(tree);
    return items;
  }, [cwdTrees, cwd]);

  const handleDragStart = useCallback((event: DragStartEvent) => {
    const { active } = event;
    const tabId = String(active.id);

    // 在所有 cwd 的 leaf 中查找 tab
    const found = findTabById(cwdTrees, tabId);
    if (!found) return;

    const sourceLeafId = found.leaf.id;
    activeDragItemRef.current = { tabId, sourceLeafId };
    setActiveDragTab(found.tab);

    // 初始化 leafItems：从 defaultLeafItems 出发，只移除被拖的 tab
    // 保留其他 tab，使 onDragOver 能正确计算插入位置
    setLeafItems((prev) => {
      // 如果 prev 已有内容，从 prev 出发；否则从 defaultLeafItems 出发
      const base = Object.keys(prev).length > 0 ? prev : defaultLeafItems;
      const sourceItems = base[sourceLeafId] ?? [];
      const filtered = sourceItems.filter((id) => id !== tabId);
      // 如果没变化，不触发更新
      if (filtered.length === sourceItems.length && prev[sourceLeafId] === filtered) return prev;
      return { ...base, [sourceLeafId]: filtered };
    });
  }, [cwdTrees, defaultLeafItems]);

  const handleDragOver = useCallback((event: DragOverEvent) => {
    const { active, over } = event;
    if (!over || !active) return;

    const activeId = String(active.id);
    const overId = String(over.id);

    // 忽略 SplitDivider 区域
    if (overId.startsWith('split-divider-')) return;

    // 确定目标 leafId
    // over.id 可能是 tab id 或 leaf 级 droppable id
    let targetLeafId: string | null = null;
    if (overId.startsWith('leaf-')) {
      targetLeafId = overId.slice(5); // 'leaf-{leafId}'
    } else {
      // 是 tab id → 查找所属 leaf
      const found = findTabById(cwdTrees, overId);
      if (found) targetLeafId = found.leaf.id;
    }

    if (!targetLeafId) return;

    // 更新 hovered leaf 高亮
    setHoveredLeafId(targetLeafId);

    // 查找 active tab 信息
    const activeFound = findTabById(cwdTrees, activeId);
    if (!activeFound) return;

    const targetFound = findLeaf(cwdTrees, targetLeafId);
    if (!targetFound) return;

    // 检查是否可以移动到目标 leaf
    // 同 leaf 拖拽（重排）始终允许，不加去重限制
    // 跨 leaf 时才检查去重冲突
    // 使用 ref 读取，避免 useCallback 闭包陈旧
    const isSameLeaf = activeDragItemRef.current?.sourceLeafId === targetLeafId;
    const canDropResult = isSameLeaf ? true : canMoveTabToLeaf(
      activeFound.tab,
      targetFound.leaf,
      targetFound.cwd,
      cwdTrees,
    );
    setCanDrop(canDropResult);

    // 动态更新 SortableContext items
    // 同 leaf 拖拽：管理 items 实现插入指示线（被拖 tab 在 items 中有对应 DOM 元素）
    // 跨 leaf 拖拽：不管理 items，被拖 tab 在目标 leaf 无 DOM 元素，
    // 强行加入 items 会导致 horizontalListSortingStrategy 计算出错 → 其他 tab 消失
    if (isSameLeaf) {
      setLeafItems((prev) => {
        const next = { ...prev };

        // 如果目标 leaf 不在 prev 中，从 defaultLeafItems 初始化
        if (!(targetLeafId in prev)) {
          next[targetLeafId] = [...(defaultLeafItems[targetLeafId] ?? [])];
        }

        // 如果目标 leaf 中已存在该 tab id，不再重复添加
        if (next[targetLeafId]?.includes(activeId)) return prev;

        // 从所有 leaf 的 items 中移除
        for (const key of Object.keys(next)) {
          next[key] = next[key].filter((id) => id !== activeId);
        }
        // 加入目标 leaf
        // 确定插入位置：如果 overId 是 tab id，放在该 tab 前面；否则追加到末尾
        if (overId.startsWith('leaf-')) {
          next[targetLeafId] = [...(next[targetLeafId] ?? []), activeId];
        } else {
          const items = next[targetLeafId] ?? [];
          const overIdx = items.indexOf(overId);
          if (overIdx >= 0) {
            const updated = [...items];
            updated.splice(overIdx, 0, activeId);
            next[targetLeafId] = updated;
          } else {
            next[targetLeafId] = [...items, activeId];
          }
        }

        return next;
      });
    }
  }, [cwdTrees, defaultLeafItems]);

  /** 拖拽移动时自动滚动 TabBar（拖到边缘时触发）。 */
  const handleDragMove = useCallback((event: DragMoveEvent) => {
    const pointerEvent = event.activatorEvent as PointerEvent;
    const x = pointerEvent.clientX;

    const targetId = hoveredLeafIdRef.current;
    if (!targetId) return;

    const container = scrollContainerRefs.current.get(targetId);
    if (!container) return;

    const rect = container.getBoundingClientRect();
    const threshold = 40; // 边缘触发距离（px）

    if (x < rect.left + threshold) {
      // 鼠标靠近左边缘 → 向左滚动
      const factor = 1 - (x - rect.left) / threshold;
      container.scrollLeft -= Math.max(1, factor * 12);
    } else if (x > rect.right - threshold) {
      // 鼠标靠近右边缘 → 向右滚动
      const factor = 1 - (rect.right - x) / threshold;
      container.scrollLeft += Math.max(1, factor * 12);
    }
  }, []);

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    const activeId = String(active.id);

    // 清理临时状态
    setHoveredLeafId(null);
    setCanDrop(true);
    const dragItem = activeDragItemRef.current;
    activeDragItemRef.current = null;
    setActiveDragTab(null);

    // 恢复所有 leaf items 为空（TabBar 将使用默认的 tabs 顺序）
    setLeafItems({});

    // 拖拽被取消
    if (!over) return;

    const overId = String(over.id);

    // 忽略 SplitDivider
    if (overId.startsWith('split-divider-')) return;

    if (!dragItem) return;
    const { sourceLeafId } = dragItem;

    // 确定目标 leafId
    let targetLeafId: string | null = null;
    if (overId.startsWith('leaf-')) {
      targetLeafId = overId.slice(5);
    } else {
      const found = findTabById(cwdTrees, overId);
      if (found) targetLeafId = found.leaf.id;
    }

    if (!targetLeafId) return;

    // 同 leaf → reorder
    if (sourceLeafId === targetLeafId) {
      // 获取当前 leaf 的可见 tab 顺序
      const foundLeaf = findLeaf(cwdTrees, sourceLeafId);
      if (!foundLeaf) return;
      const visibleTabs = foundLeaf.leaf.tabs
        .filter((t) => !t.hidden)
        .sort((a, b) => a.order - b.order);
      const visibleIds = visibleTabs.map((t) => t.id);

      // 如果 activeId 还在列表中（说明拖拽结束时被放回原 leaf）
      if (visibleIds.includes(activeId)) {
        // 计算新的顺序
        const oldIdx = visibleIds.indexOf(activeId);
        let newIdx: number;
        if (overId.startsWith('leaf-')) {
          newIdx = visibleIds.length - 1; // 追加到末尾
        } else {
          newIdx = visibleIds.indexOf(overId);
        }
        if (newIdx < 0) newIdx = visibleIds.length - 1;

        const reordered = [...visibleIds];
        reordered.splice(oldIdx, 1);
        reordered.splice(newIdx, 0, activeId);
        reorderTabsInLeaf(sourceLeafId, reordered);
      }
      return;
    }

    // 跨 leaf → 检查去重
    const activeFound = findTabById(cwdTrees, activeId);
    const targetFound = findLeaf(cwdTrees, targetLeafId);
    if (!activeFound || !targetFound) return;

    const canDropResult = canMoveTabToLeaf(
      activeFound.tab,
      targetFound.leaf,
      targetFound.cwd,
      cwdTrees,
    );
    if (!canDropResult) return; // 去重冲突，跳过

    // 计算 targetIndex
    let targetIndex: number;
    if (overId.startsWith('leaf-')) {
      targetIndex = targetFound.leaf.tabs.length; // 追加到末尾
    } else {
      // 找到 over tab 在完整 tabs[] 中的索引
      const overIdx = targetFound.leaf.tabs.findIndex((t) => t.id === overId);
      targetIndex = overIdx >= 0 ? overIdx : targetFound.leaf.tabs.length;
    }

    moveTabAcrossLeafs(activeId, sourceLeafId, targetLeafId, targetIndex);
  }, [cwdTrees, reorderTabsInLeaf, moveTabAcrossLeafs]);

  // 合并默认 items 和动态 items：动态 items 优先
  const mergedLeafItems = useMemo(() => {
    if (Object.keys(leafItems).length === 0) return defaultLeafItems;
    // 合并：用动态 items 覆盖默认 items
    const merged = { ...defaultLeafItems };
    for (const [leafId, items] of Object.entries(leafItems)) {
      merged[leafId] = items;
    }
    return merged;
  }, [defaultLeafItems, leafItems]);

  const contextValue = useMemo<DragContextValue>(() => ({
    leafItems: mergedLeafItems,
    hoveredLeafId,
    canDrop,
    registerScrollContainer,
  }), [mergedLeafItems, hoveredLeafId, canDrop, registerScrollContainer]);

  // 被拖拽的 tab 信息（用于 DragOverlay），直接使用 activeDragTab state
  const activeTab = activeDragTab;

  // 关键（修复「跨工作目录切换黑屏」）：无论 isActive 如何，都返回**相同结构**的
  // DragContext.Provider > DndContext > children 树。若在 isActive 切换时改变根节点类型
  // （Fragment ↔ DragContext.Provider），React 会对整个子树卸载/重挂，导致所有
  // SessionPane → XtermTerminal 终端实例被销毁（releasePane → unmount → WebGL 释放），
  // 重挂后的新终端为空 canvas，表现为黑屏直到手动拖拽分隔线触发 resize。
  // 与同目录内切换 tab 的「始终挂载、仅改可见性」策略对齐：这里 wrapper 结构恒定，
  // 仅凭外层 SplitPane 的 opacity 切换可见性，终端实例与 canvas 内容全程保留。
  // 非活跃时 DnD 无法被触发（TabBar 不可交互），DndContext 只是闲置，无副作用。
  return (
    <DragContext.Provider value={contextValue}>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCorners}
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragMove={handleDragMove}
        onDragEnd={handleDragEnd}
      >
        {children}
        {/* DragOverlay 仅 active 时渲染：非活跃时拖拽不存在，overlay 无意义。
            条件渲染 overlay 不影响 children 的挂载状态（它在 children 之后，独立子树）。 */}
        {isActive && (
          <DragOverlay dropAnimation={null}>
            {activeTab && (
              <div className={`drag-overlay${!canDrop ? ' drag-overlay--invalid' : ''}`}>
                <span className="drag-overlay-icon">
                  {activeTab.kind === 'session' && '💬'}
                  {activeTab.kind === 'integrated-terminal' && '⬛'}
                  {activeTab.kind === 'preview' && '📄'}
                  {activeTab.kind === 'diff' && '📝'}
                  {activeTab.kind === 'session-content' && '💬'}
                </span>
                <span className="drag-overlay-title">{activeTab.title}</span>
                {!canDrop && <span className="drag-overlay-invalid-icon">🚫</span>}
              </div>
            )}
          </DragOverlay>
        )}
      </DndContext>
    </DragContext.Provider>
  );
}

// ── Leaf 渲染 ──

function SplitPaneLeaf({
  leaf,
  cwd,
  isActive,
  onOpenFile,
  onDestroyTerminal,
  onDestroySession,
  onOpen,
  onNewTerminal,
  onNewTerminalWithProfile,
  terminalProfiles,
  closeGuards,
  requestCloseTab,
  registerCloseGuard,
  addedDirs,
  onSplitPane,
  onDeleteSession,
  onDeleteSessionRequest,
}: Props & { leaf: SplitLeaf }) {
  const selectTab = useSplitStore((s) => s.selectTab);
  const reorderTabsInLeaf = useSplitStore((s) => s.reorderTabsInLeaf);
  const setActiveLeaf = useSplitStore((s) => s.setActiveLeaf);
  const closeCenterTab = useSplitStore((s) => s.closeCenterTab);
  const splitPaneWithTab = useSplitStore((s) => s.splitPaneWithTab);
  const { toast } = useToast();

  // tab 右键菜单状态
  const [tabContextMenu, setTabContextMenu] = useState<SplitTabContextMenuState | null>(null);

  // 右键菜单项：分屏项在源 leaf 只剩一个可见 tab 时禁用（避免产生空窗格）
  const contextMenuItems = useMemo<ContextMenuItem[]>(() => {
    if (!tabContextMenu) return [];
    const visibleTabCount = leaf.tabs.filter((t) => !t.hidden).length;
    const canSplit = visibleTabCount > 1;
    const doSplit = (direction: 'horizontal' | 'vertical') => {
      splitPaneWithTab(leaf.id, tabContextMenu.tabId, direction);
    };
    return [
      {
        label: '向右分屏',
        disabled: !canSplit,
        onClick: () => doSplit('horizontal'),
      },
      {
        label: '向下分屏',
        disabled: !canSplit,
        onClick: () => doSplit('vertical'),
      },
    ];
  }, [tabContextMenu, leaf.id, leaf.tabs, splitPaneWithTab]);

  const handleTabContextMenu = useCallback((tabId: string, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    // 先关闭旧菜单，再下一帧打开新菜单，避免旧菜单 onClose 回调覆盖新状态
    setTabContextMenu(null);
    setTimeout(() => {
      setTabContextMenu({ x: e.clientX, y: e.clientY, tabId });
    }, 0);
  }, []);

  // 从 DragContext 获取 leaf 的动态 items
  const { leafItems, hoveredLeafId, canDrop } = useDragContext();
  const isDragOver = hoveredLeafId === leaf.id;

  // 该 leaf 的可见 tab（按 order 排序）
  const orderedVisibleTabs = useMemo(
    () => leaf.tabs.filter((t) => !t.hidden).sort((a, b) => a.order - b.order),
    [leaf.tabs],
  );

  // 恢复 pane 滚动位置（当 leaf 变为 active 时）
  useEffect(() => {
    if (!isActive) return;
    for (const t of leaf.tabs) {
      if (t.kind !== 'session' && t.kind !== 'integrated-terminal' && t.kind !== 'session-content') continue;
      restorePaneScrollState(t.id);
    }
    // 关键（修复「不同工作目录切换黑屏」）：切换 cwd 时，目标 leaf 的终端 tab 的
    // `active` prop 不变（tab 仍是该 leaf 的 activeTabId），SessionPane 的
    // useEffect([active]) 不会触发，setActive(true) 永远不会被调用 → 终端不 resize、
    // WebGL 上下文丢失后也不恢复，表现为黑屏直到手动拖分割线触发 resize。
    // 这里在 isActive 变为 true 时显式对当前 active 终端 tab 触发 resize 和 WebGL 恢复。
    // 注意：只处理 active 的 tab，不对隐藏 tab 调 setPaneActive（否则会提前设置
    // this.active=true，吞掉后续用户切到该 tab 时 setActive 的 resize 逻辑）。
    const activeTab = leaf.tabs.find(t => t.id === leaf.activeTabId);
    if (activeTab && (activeTab.kind === 'session' || activeTab.kind === 'integrated-terminal')) {
      setPaneActive(activeTab.id, true);
      schedulePaneResize(activeTab.id);
    }
  }, [isActive, leaf.tabs]);

  const handleSelectTab = useCallback((id: string) => {
    selectTab(id);
  }, [selectTab]);

  const handleReorder = useCallback((orderedIds: string[]) => {
    reorderTabsInLeaf(leaf.id, orderedIds);
  }, [reorderTabsInLeaf, leaf.id]);

  const handleLeafClick = useCallback(() => {
    setActiveLeaf(leaf.id);
  }, [setActiveLeaf, leaf.id]);

  const hasContent = orderedVisibleTabs.length > 0;

  const tabBarItems = orderedVisibleTabs.map((t) => ({
    id: t.id,
    title: t.title,
    kind: t.kind as TabKind,
  }));

  // 构建 leaf 的 SortableContext items
  const sortableItems = leafItems[leaf.id] ?? orderedVisibleTabs.map((t) => t.id);

  // 构建 leaf 高亮 class
  const leafClass = [
    'split-pane-leaf',
    isDragOver ? (canDrop ? 'split-pane-leaf--drag-over' : 'split-pane-leaf--drag-over--invalid') : '',
  ].filter(Boolean).join(' ');

  return (
    <div className={leafClass} onClick={handleLeafClick}>
      <TabBar
        leafId={leaf.id}
        tabs={tabBarItems}
        activeId={leaf.activeTabId}
        onSelect={handleSelectTab}
        onClose={requestCloseTab}
        onReorder={handleReorder}
        onNew={() => onOpen?.({ cwd, leafId: leaf.id })}
        onNewTerminal={onNewTerminal}
        onNewTerminalWithProfile={onNewTerminalWithProfile}
        terminalProfiles={terminalProfiles}
        onSplitPane={onSplitPane}
        sortableItems={sortableItems}
        onTabContextMenu={handleTabContextMenu}
      />
      <div className="center-pane-body">
        {/* keep-alive：所有 tab 内容永久挂载，非 active 用 opacity:0 隐藏 */}
        {leaf.tabs.map((t) => {
          const tabActive = t.id === leaf.activeTabId;
          const cls = tabActive ? 'tab-content active' : 'tab-content';
          if (t.kind === 'session') {
            return <div key={t.id} className={cls}><SessionPane sessionKey={t.key} active={tabActive} /></div>;
          }
          if (t.kind === 'integrated-terminal') {
            return <div key={t.id} className={cls}><IntegratedPane terminalId={t.id} active={tabActive} /></div>;
          }
          if (t.kind === 'preview') {
            return (
              <div key={t.id} className={cls}>
                <PreviewTab
                  tabId={t.id}
                  root={t.root}
                  path={t.path}
                  active={tabActive}
                  onOpenFile={onOpenFile}
                  onClose={() => closeCenterTab(t.id)}
                  onRegisterCloseGuard={registerCloseGuard}
                />
              </div>
            );
          }
          if (t.kind === 'session-content') {
            const sc = t as SessionContentTab;
            // 从会话文件路径中提取文件名（不含 .jsonl 后缀）作为会话 ID
            const sessionId = sc.sessionKey.split(/[\\/]/).filter(Boolean).pop()?.replace(/\.jsonl$/, '') ?? sc.sessionKey;
            const handleCopyPath = (e: React.MouseEvent) => {
              e.stopPropagation();
              navigator.clipboard.writeText(sc.sessionKey).then(() => toast('已复制文件路径')).catch(() => {});
            };
            const handleCopyId = (e: React.MouseEvent) => {
              e.stopPropagation();
              navigator.clipboard.writeText(sessionId).then(() => toast('已复制会话 ID')).catch(() => {});
            };
            return (
              <div key={t.id} className={cls}>
                <div className="session-content-tab-header">
                  <span className="session-content-tab-title">💬 {sc.sessionName}</span>
                  <div className="session-content-tab-actions">
                    <button
                      className="session-content-tab-btn"
                      title="复制会话文件路径到剪贴板"
                      onClick={handleCopyPath}
                    >
                      复制文件路径
                    </button>
                    <button
                      className="session-content-tab-btn"
                      title="复制会话 ID 到剪贴板"
                      onClick={handleCopyId}
                    >
                      复制会话id
                    </button>
                    <button
                      className="session-content-tab-btn"
                      title="启动会话"
                      onClick={(e) => {
                        e.stopPropagation();
                        onOpen?.({ key: sc.sessionKey, cwd, name: sc.sessionName });
                      }}
                    >
                      启动
                    </button>
                    <button
                      className="session-content-tab-btn session-content-tab-btn--danger"
                      title="删除会话文件"
                      onClick={(e) => {
                        e.stopPropagation();
                        onDeleteSessionRequest?.(sc.sessionKey, sc.sessionName, sc.id);
                      }}
                    >
                      删除
                    </button>
                  </div>
                </div>
                <SessionContentView sessionKey={sc.sessionKey} sessionName={sc.sessionName} />
              </div>
            );
          }
          return <div key={t.id} className={cls}><DiffTab cwd={t.cwd} commitHash={t.commitHash} active={tabActive} onBack={() => closeCenterTab(t.id)} /></div>;
        })}
        {/* 空状态 */}
        {leaf.tabs.length === 0 && (
          <div className="empty-state">
            {cwd ? (
              <div className="empty-state-buttons">
                <button
                  className="empty-state-new-session-btn"
                  onClick={() => onOpen?.({ cwd })}
                >
                  <span className="empty-state-plus">+</span>
                  <span>新建会话</span>
                </button>
                {onNewTerminal && (
                  <button
                    className="empty-state-new-session-btn"
                    onClick={onNewTerminal}
                  >
                    <span className="empty-state-plus">+</span>
                    <span>新建终端</span>
                  </button>
                )}
              </div>
            ) : (
              '请先在左侧添加工作目录，然后选择会话。'
            )}
          </div>
        )}
      </div>
      {tabContextMenu && (
        <ContextMenu
          x={tabContextMenu.x}
          y={tabContextMenu.y}
          items={contextMenuItems}
          onClose={() => setTabContextMenu(null)}
        />
      )}
    </div>
  );
}

// ── Split 节点渲染 ──

function SplitPaneNode({
  node,
  cwd,
  isActive,
  ...rest
}: Props & { node: SplitNode }) {
  const setRatios = useSplitStore((s) => s.setRatios);
  const splitRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState<{ index: number; startPos: number; startRatios: number[] } | null>(null);

  const handleMouseDown = useCallback((index: number, e: React.MouseEvent) => {
    e.preventDefault();
    const rect = splitRef.current?.getBoundingClientRect();
    if (!rect) return;
    const startPos = node.direction === 'horizontal' ? e.clientX : e.clientY;
    setDragging({ index, startPos, startRatios: [...node.ratios] });
  }, [node.direction, node.ratios]);

  // 拖拽逻辑
  useEffect(() => {
    if (!dragging) return;

    const handleMouseMove = (e: MouseEvent) => {
      const rect = splitRef.current?.getBoundingClientRect();
      if (!rect) return;
      const totalSize = node.direction === 'horizontal' ? rect.width : rect.height;
      const delta = (node.direction === 'horizontal' ? e.clientX : e.clientY) - dragging.startPos;
      const deltaRatio = delta / totalSize;

      const newRatios = [...dragging.startRatios];
      const leftIdx = dragging.index;
      const rightIdx = dragging.index + 1;

      let newLeft = newRatios[leftIdx] + deltaRatio;
      let newRight = newRatios[rightIdx] - deltaRatio;

      // 最小比例约束 6%
      const minRatio = 0.06;
      if (newLeft < minRatio) {
        newRight -= (minRatio - newLeft);
        newLeft = minRatio;
      }
      if (newRight < minRatio) {
        newLeft -= (minRatio - newRight);
        newRight = minRatio;
      }

      if (newLeft <= 0 || newRight <= 0) return;

      newRatios[leftIdx] = newLeft;
      newRatios[rightIdx] = newRight;

      // 归一化
      const total = newRatios.reduce((a, b) => a + b, 0);
      const normalized = newRatios.map((r) => r / total);

      setRatios(node.id, normalized);
    };

    const handleMouseUp = () => {
      setDragging(null);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    // 锁定 body cursor
    document.body.style.cursor = node.direction === 'horizontal' ? 'col-resize' : 'row-resize';
    document.body.style.userSelect = 'none';

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [dragging, node.direction, node.id, setRatios]);

  const fixedRatios = node.ratios;

  return (
    <div
      ref={splitRef}
      className={`split-pane-node split-pane-node--${node.direction}`}
    >
      {node.children.flatMap((child, idx) => {
        const elements: React.ReactNode[] = [
          <div
            key={child.id}
            className="split-pane-child"
            style={{ flex: `${fixedRatios[idx]}` }}
          >
            <SplitPaneChild
              child={child}
              cwd={cwd}
              isActive={isActive}
              {...rest}
            />
          </div>,
        ];
        // 在每对相邻子节点之间插入分割线
        if (idx < node.children.length - 1) {
          elements.push(
            <SplitDivider
              key={`divider-${idx}`}
              direction={node.direction}
              onMouseDown={(e) => handleMouseDown(idx, e)}
            />,
          );
        }
        return elements;
      })}
    </div>
  );
}

// ── 递归子节点渲染 ──

function SplitPaneChild({
  child,
  ...rest
}: Props & { child: SplitLeaf | SplitNode }) {
  if (child.type === 'leaf') {
    return <SplitPaneLeaf leaf={child} {...rest} />;
  }
  return <SplitPaneNode node={child} {...rest} />;
}

// ── 对外暴露的 SplitPane 组件 ──

export function SplitPane(props: Props) {
  const { tree, isActive, cwd, ...rest } = props;

  // 关键（修复「分屏时终端重载，滚动位置丢失」）：始终渲染 SplitPaneNode，
  // 使 React 树结构在分屏操作前后保持稳定。
  //
  // 分屏前（单 leaf）：SplitPaneNode > div > div[key=L1] > SplitPaneChild > SplitPaneLeaf(L1)
  // 分屏后（split node）：SplitPaneNode > div > div[key=L1] > SplitPaneChild > SplitPaneLeaf(L1)
  //                                        + div[key=L2] > SplitPaneChild > SplitPaneLeaf(L2)
  //
  // 原 leaf L1 始终以 key={L1} 挂载在相同位置，React 复用组件，不卸载/重挂终端。
  // 若分屏前直接渲染 SplitPaneLeaf、分屏后切换为 SplitPaneNode，React 树根节点类型变化
  // 导致原 leaf 全部子节点（SessionPane → XtermTerminal）被卸载，终端实例销毁后重建，
  // 新终端 scrollback 为空，滚动位置丢失。
  // 单 leaf 时包裹为 ratios=[1] 的单 child split node，布局等价于直接渲染 leaf。
  const node: SplitNode = tree.type === 'leaf'
    ? { type: 'split', id: 'root', direction: 'horizontal', ratios: [1], children: [tree] }
    : tree;

  return (
    <div
      className="split-pane"
      style={{
        opacity: isActive ? 1 : 0,
        pointerEvents: isActive ? 'auto' : 'none',
        position: 'absolute',
        inset: 0,
        zIndex: isActive ? 1 : 0,
      }}
    >
      <SplitPaneDragProvider cwd={cwd} isActive={isActive}>
        <SplitPaneNode node={node} tree={tree} cwd={cwd} isActive={isActive} {...rest} />
      </SplitPaneDragProvider>
    </div>
  );
}