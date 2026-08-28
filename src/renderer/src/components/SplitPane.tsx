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

import { memo, useRef, useMemo, useEffect, useLayoutEffect, useCallback, useState, useReducer, createContext, useContext } from 'react';
import { createPortal } from 'react-dom';
import { SYNC_FIT_PANES_EVENT } from '../constants/terminal';
import { useToast } from './Toast';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  type CollisionDetection,
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
import { EdgeSplitZone, type EdgeSide } from './EdgeSplitZone';
import { ContextMenu } from './ContextMenu';
import type { ContextMenuItem } from './ContextMenu';
import { useSplitStore, findTabById, findLeaf, canMoveTabToLeaf } from '../store/splitStore';
import type { SplitTree, SplitLeaf, SplitNode, SplitDirection, Tab, SessionContentTab, SessionTab, PreviewTab as PreviewTabType, DiffTab as DiffTabType, IntegratedTerminalTab } from '../store/splitStore';
import type { TabKind } from './TabBar';
import { SessionPane } from './SessionPane';
import { IntegratedPane } from './IntegratedPane';
import { PreviewTab } from './PreviewTab';
import { DiffTab } from './DiffTab';
import { SessionContentView } from './SessionContentView';
import { restorePaneScrollState, schedulePaneResize, setPaneActive, focusPane } from './paneManager';
import { focusEditableIn } from '../lib/focusEditable';

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
  /** 是否有拖拽正在进行（ADR-0003：驱动内容区边缘条带/预览格渲染）。 */
  isDragging: boolean;
  /** 当前悬停的边缘落点（ADR-0003：用于分屏方向预览）。 */
  pendingSplitEdge: { leafId: string; side: EdgeSide } | null;
  /** 注册 leaf 的内容区容器，供全局 TabContentHost portal 投射 tab 内容（ADR-0003 keep-alive）。 */
  registerLeafBody: (leafId: string, el: HTMLElement | null) => void;
  /** 各 preview tab 的「文件已删除」标记（PreviewTab 上报，TabBar 红字+删除线）。 */
  tabDeleted: Record<string, boolean>;
  /** 接收 PreviewTab 的「文件已删除」上报。 */
  registerTabDeleted: (id: string, v: boolean) => void;
}

const DragContext = createContext<DragContextValue>({
  leafItems: {},
  hoveredLeafId: null,
  canDrop: true,
  registerScrollContainer: () => {},
  isDragging: false,
  pendingSplitEdge: null,
  registerLeafBody: () => {},
  tabDeleted: {},
  registerTabDeleted: () => {},
});

export function useDragContext() {
  return useContext(DragContext);
}

// ── 拖拽创建分屏（ADR-0003）：落点 id 前缀 + 边缘方向映射 ──

/** 边缘条带 droppable id 前缀：split-edge:{leafId}:{side}。 */
export const EDGE_SPLIT_PREFIX = 'split-edge:';

/** 边缘落点 → (分屏方向, 新 leaf 前置/后置)。拖到左/上边缘新窗格在前，右/下边缘在后。 */
function edgeToDirSide(side: EdgeSide): { direction: SplitDirection; side: 'before' | 'after' } {
  switch (side) {
    case 'left':
      return { direction: 'horizontal', side: 'before' };
    case 'right':
      return { direction: 'horizontal', side: 'after' };
    case 'top':
      return { direction: 'vertical', side: 'before' };
    case 'bottom':
      return { direction: 'vertical', side: 'after' };
  }
}

/** 解析 split-edge:{leafId}:{side} 落点 id → { leafId, side }；格式不符返回 null。 */
function parseEdgeId(id: string): { leafId: string; side: EdgeSide } | null {
  const parts = id.split(':');
  const leafId = parts[1];
  const side = parts[2] as EdgeSide;
  return leafId && side ? { leafId, side } : null;
}

/** DragOverlay 分屏方向提示：side → 箭头文案。 */
const EDGE_SPLIT_HINT: Record<EdgeSide, string> = {
  left: '⇤ 分屏',
  right: '分屏 ⇥',
  top: '⇧ 分屏',
  bottom: '分屏 ⇩',
};

/**
 * ADR-0003：边缘优先碰撞检测（纯包含性判定，无距离回退）。
 *
 * 优先级：边缘条带 > 排序 Tab > leaf Tab 条 > 无落点。
 * - 边缘条带：四向不重叠，指针恰中其一 → 分屏；
 * - 排序 Tab：指针落在某个 tab 上 → 以该 tab 为落点（支持插入位置）；
 * - leaf Tab 条：指针在 Tab 条空白处 → 追加到该窗格；
 * - 其余（内容区死区/中央、分隔线、右栏）→ 返回空，over=null → 无任何操作与反馈。
 *
 * 不用 closestCorners 兜底：它对「指针远在中央」也会返回最近的 droppable，
 * 会把内容区中央误判成最近的边缘条带（分屏）或残留高亮，违反「中央无落点」。
 */
const edgeAwareCollision: CollisionDetection = (args) => {
  const { droppableContainers, droppableRects, pointerCoordinates } = args;
  if (!pointerCoordinates) return [];
  const { x, y } = pointerCoordinates;

  // 指针是否落在 droppable 矩形内
  const inside = (id: string): boolean => {
    const rect = droppableRects.get(id);
    return !!rect && x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
  };

  // 1. 边缘条带（四向不重叠，恰中其一）
  for (const container of droppableContainers) {
    const id = String(container.id);
    if (id.startsWith(EDGE_SPLIT_PREFIX) && inside(id)) {
      return [{ id }];
    }
  }

  // 2. Tab（sortable 项，id 不以已知非 tab 前缀开头）
  for (const container of droppableContainers) {
    const id = String(container.id);
    if (id.startsWith(EDGE_SPLIT_PREFIX) || id.startsWith('leaf-') || id.startsWith('split-divider-')) continue;
    if (inside(id)) return [{ id }];
  }

  // 3. leaf Tab 条空白处 → 追加到该窗格
  for (const container of droppableContainers) {
    const id = String(container.id);
    if (id.startsWith('leaf-') && inside(id)) return [{ id }];
  }

  // 4. 无落点（内容区死区/中央、分隔线、右栏）
  return [];
};

// ── SplitPaneDragProvider ──

/**
 * 跨 leaf Tab 拖拽的 DndContext 提供者。
 * 包装单个 cwd 的分屏树，所有 leaf 的 TabBar 共享此 DndContext。
 * 每个 cwd 使用独立的 SplitPaneDragProvider 实例。
 */
function SplitPaneDragProvider({ children, ...rest }: Props & { children: React.ReactNode }) {
  // 总是渲染 SplitPaneDragProviderInner（相同组件类型），
  // 避免 isActive 切换时 Fragment ↔ SplitPaneDragProviderInner 的组件类型变化
  // 导致 React 卸载全部子节点（含所有 SessionPane → XtermTerminal 终端实例）。
  // 非活跃时 DnD 逻辑在 SplitPaneDragProviderInner 内部跳过。
  return <SplitPaneDragProviderInner {...rest}>{children}</SplitPaneDragProviderInner>;
}

function SplitPaneDragProviderInner({
  children,
  tree,
  cwd,
  isActive,
  ...rest
}: Props & { children: React.ReactNode }) {
  const moveTabAcrossLeafs = useSplitStore((s) => s.moveTabAcrossLeafs);
  const reorderTabsInLeaf = useSplitStore((s) => s.reorderTabsInLeaf);
  const splitPaneWithTab = useSplitStore((s) => s.splitPaneWithTab);
  const cwdTrees = useSplitStore((s) => s.cwdTrees);

  // 拖拽状态
  const [leafItems, setLeafItems] = useState<Record<string, string[]>>({});
  const [hoveredLeafId, setHoveredLeafId] = useState<string | null>(null);
  const [canDrop, setCanDrop] = useState(true);
  // 各 preview tab 的「文件已删除」标记（原在 SplitPaneLeaf，提升为全局：tab.id 全局唯一）。
  const [tabDeleted, setTabDeleted] = useState<Record<string, boolean>>({});
  const registerTabDeleted = useCallback((id: string, v: boolean) => {
    setTabDeleted((prev) => {
      const next = { ...prev };
      if (v) next[id] = true; else delete next[id];
      return next;
    });
  }, []);
  // 全局 keep-alive（修复终端跨 leaf 移动丢内容）：leaf 内容区容器注册表，
  // TabContentHost 用 createPortal 把每个 tab 内容投射到所属 leaf。ref 变化后
  // forceUpdate 触发 host 重渲染，使首帧未挂载的 leaf 在 ref 注册后补 slot 定位。
  const leafBodyRefs = useRef<Map<string, HTMLElement>>(new Map());
  const [, forceUpdate] = useReducer((x: number) => x + 1, 0);
  const registerLeafBody = useCallback((leafId: string, el: HTMLElement | null) => {
    if (el) leafBodyRefs.current.set(leafId, el);
    else leafBodyRefs.current.delete(leafId);
    forceUpdate();
  }, []);
  /** ref 存储 drag item，回调总能读到最新值（避免 useCallback 闭包陈旧）。 */
  const activeDragItemRef = useRef<{ tabId: string; sourceLeafId: string } | null>(null);
  /** state 仅用于驱动 DragOverlay 渲染。 */
  const [activeDragTab, setActiveDragTab] = useState<Tab | null>(null);
  /** 是否有拖拽进行中（ADR-0003：驱动边缘条带/预览格渲染）。 */
  const [isDragging, setIsDragging] = useState(false);
  /** 当前悬停的边缘落点（ADR-0003：分屏方向预览）。 */
  const [pendingSplitEdge, setPendingSplitEdge] = useState<{ leafId: string; side: EdgeSide } | null>(null);

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
    // ADR-0003：激活拖拽状态，SplitPaneLeaf 据此渲染边缘条带与分屏预览线框
    setIsDragging(true);

    // 初始化 leafItems：从 defaultLeafItems 出发，只移除被拖的 tab
    // 保留其他 tab，使 onDragOver 能正确计算插入位置
    setLeafItems((prev) => {
      // 如果 prev 已有内容，从 prev 出发；否则从 defaultLeafItems 出发
      const base = Object.keys(prev).length > 0 ? prev : defaultLeafItems;
      const sourceItems = base[sourceLeafId] ?? [];
      const filtered = sourceItems.filter((id) => id !== tabId);
      // 无变化（被拖 tab 不在此 leaf 的 items 中）→ 不触发重渲染
      if (filtered.length === sourceItems.length) return prev;
      return { ...base, [sourceLeafId]: filtered };
    });
  }, [cwdTrees, defaultLeafItems]);

  const handleDragOver = useCallback((event: DragOverEvent) => {
    const { active, over } = event;
    // 无落点（拖到内容区死区/中央）→ 清除所有悬停反馈，不残留任何线框
    if (!over) {
      setPendingSplitEdge(null);
      setHoveredLeafId(null);
      return;
    }
    if (!active) return;

    const activeId = String(active.id);
    const overId = String(over.id);

    // 忽略 SplitDivider 区域
    if (overId.startsWith('split-divider-')) return;

    // ADR-0003：边缘条带命中 → 记录分屏方向预览（新 leaf 恒空，去重永不冲突）
    if (overId.startsWith(EDGE_SPLIT_PREFIX)) {
      const edge = parseEdgeId(overId);
      if (edge) {
        setPendingSplitEdge(edge);
        setHoveredLeafId(null);
        setCanDrop(true);
      }
      return;
    }

    // 非边缘命中 → 清除分屏预览
    setPendingSplitEdge(null);

    // 确定目标 leafId：over.id 是 tab id 或 leaf Tab 条 droppable id（leaf-{leafId}）
    // 移入窗格只能拖到目标窗格的 Tab 条（ADR-0003 简化：内容区中央不再是落点）
    let targetLeafId: string | null = null;
    if (overId.startsWith('leaf-')) {
      targetLeafId = overId.slice(5); // 'leaf-{leafId}'
    } else {
      // 是 tab id → 查找所属 leaf
      const found = findTabById(cwdTrees, overId);
      if (found) targetLeafId = found.leaf.id;
    }

    if (!targetLeafId) {
      setHoveredLeafId(null);
      return;
    }

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
    setIsDragging(false);
    setPendingSplitEdge(null);
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

    // ADR-0003：边缘条带 → 创建分屏并移入被拖 Tab（源窗格可变空）
    if (overId.startsWith(EDGE_SPLIT_PREFIX)) {
      const edge = parseEdgeId(overId);
      if (edge) {
        const { direction, side: childSide } = edgeToDirSide(edge.side);
        splitPaneWithTab(edge.leafId, activeId, direction, { side: childSide, allowEmptySource: true });
      }
      return;
    }

    // 确定目标 leafId：tab id 或 leaf Tab 条 droppable（leaf-{leafId}）
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
  }, [cwdTrees, reorderTabsInLeaf, moveTabAcrossLeafs, splitPaneWithTab]);

  /** 拖拽被取消（Esc / 窗口失焦）时清理全部临时状态。 */
  const handleDragCancel = useCallback(() => {
    setIsDragging(false);
    setPendingSplitEdge(null);
    setHoveredLeafId(null);
    setCanDrop(true);
    activeDragItemRef.current = null;
    setActiveDragTab(null);
    setLeafItems({});
  }, []);

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
    isDragging,
    pendingSplitEdge,
    registerLeafBody,
    tabDeleted,
    registerTabDeleted,
  }), [mergedLeafItems, hoveredLeafId, canDrop, registerScrollContainer, isDragging, pendingSplitEdge, registerLeafBody, tabDeleted, registerTabDeleted]);

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
        collisionDetection={edgeAwareCollision}
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragMove={handleDragMove}
        onDragEnd={handleDragEnd}
        onDragCancel={handleDragCancel}
      >
        {children}
        {/* 全局 keep-alive（修复终端跨 leaf 移动丢内容）：所有 tab 内容挂在此 host 下
            （key=tab.id 稳定、portal 容器恒定，React 19 下不重挂载 → 终端实例保留），
            slot div 绝对定位覆盖到所属 leaf 的内容区。 */}
        <TabContentHost
          tree={tree}
          cwd={cwd}
          leafBodyRefs={leafBodyRefs}
          registerTabDeleted={registerTabDeleted}
          {...rest}
        />
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
                {/* ADR-0003：悬停边缘时提示分屏方向 */}
                {pendingSplitEdge && (
                  <span className="drag-overlay-split-hint">
                    {EDGE_SPLIT_HINT[pendingSplitEdge.side]}
                  </span>
                )}
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

// ── TabContent（keep-alive 下单个 tab 的内容渲染，memo 隔离） ──
//
// SplitPaneLeaf 在 store 更新（cwdTrees 引用变化）时会 re-render，进而把所有 tab 内容
// 一起 reconcile。用 memo 把每个 tab 的内容渲染独立出来：比较函数只看 tab 的「内容标识」
// （kind + 该 kind 决定渲染的稳定字段，如 preview 的 root/path、session 的 key）+ active。
// 标题、order、history 等元数据变化不影响内容渲染，直接跳过，避免波及 Monaco /
// MarkdownPreview 等重组件。回调（onOpenFile/closeCenterTab 等）行为一致、引用稳定，
// 不纳入比较——即便上层 re-render 传入新引用，也不会无谓重渲染内容区。

interface TabContentProps {
  tab: Tab;
  active: boolean;
  cwd: string;
  onOpenFile?: (relPath: string, fileName: string, root: string) => void;
  closeCenterTab: (id: string) => void;
  registerCloseGuard: (id: string, guard: (() => void) | null) => void;
  registerTabDeleted: (id: string, v: boolean) => void;
  onOpen?: (req: { key?: string; cwd?: string; name?: string; leafId?: string }) => void;
  onDeleteSessionRequest?: (key: string, name: string, tabId: string) => void;
  toast: (text: string) => void;
}

function tabContentPropsEqual(prev: TabContentProps, next: TabContentProps): boolean {
  if (prev.active !== next.active) return false;
  const a = prev.tab, b = next.tab;
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case 'session':
      return a.key === (b as SessionTab).key;
    case 'integrated-terminal':
      return a.id === (b as IntegratedTerminalTab).id;
    case 'preview':
      return a.root === (b as PreviewTabType).root && a.path === (b as PreviewTabType).path;
    case 'diff': {
      const bb = b as DiffTabType;
      return a.cwd === bb.cwd && a.commitHash === bb.commitHash && a.filePath === bb.filePath && a.singleColumn === bb.singleColumn;
    }
    case 'session-content': {
      const bb = b as SessionContentTab;
      return a.sessionKey === bb.sessionKey && a.sessionName === bb.sessionName;
    }
    default:
      return false;
  }
}

const TabContent = memo(function TabContent({
  tab,
  active,
  cwd,
  onOpenFile,
  closeCenterTab,
  registerCloseGuard,
  registerTabDeleted,
  onOpen,
  onDeleteSessionRequest,
  toast,
}: TabContentProps) {
  const cls = active ? 'tab-content active' : 'tab-content';
  // 回调按 tab.id 闭包化：useCallback 让引用稳定（PreviewTab/DiffTab 等子组件若 memo 可生效）。
  const handleClose = useCallback(() => closeCenterTab(tab.id), [closeCenterTab, tab.id]);
  const handleDeletedChange = useCallback((v: boolean) => registerTabDeleted(tab.id, v), [registerTabDeleted, tab.id]);

  if (tab.kind === 'session') {
    return (
      <div className={cls} data-tab-content-id={tab.id}>
        <SessionPane sessionKey={tab.key} active={active} />
      </div>
    );
  }
  if (tab.kind === 'integrated-terminal') {
    return (
      <div className={cls} data-tab-content-id={tab.id}>
        <IntegratedPane terminalId={tab.id} active={active} />
      </div>
    );
  }
  if (tab.kind === 'preview') {
    return (
      <div className={cls} data-tab-content-id={tab.id}>
        <PreviewTab
          tabId={tab.id}
          root={tab.root}
          path={tab.path}
          selection={tab.selection}
          active={active}
          onOpenFile={onOpenFile}
          onClose={handleClose}
          onRegisterCloseGuard={registerCloseGuard}
          onDeletedChange={handleDeletedChange}
        />
      </div>
    );
  }
  if (tab.kind === 'session-content') {
    const sc = tab as SessionContentTab;
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
    const handleLaunch = (e: React.MouseEvent) => {
      e.stopPropagation();
      onOpen?.({ key: sc.sessionKey, cwd, name: sc.sessionName });
    };
    const handleDelete = (e: React.MouseEvent) => {
      e.stopPropagation();
      onDeleteSessionRequest?.(sc.sessionKey, sc.sessionName, sc.id);
    };
    return (
      <div className={cls} data-tab-content-id={tab.id}>
        <div className="session-content-tab-header">
          <span className="session-content-tab-title">💬 {sc.sessionName}</span>
          <div className="session-content-tab-actions">
            <button className="session-content-tab-btn" title="复制会话文件路径到剪贴板" onClick={handleCopyPath}>
              复制文件路径
            </button>
            <button className="session-content-tab-btn" title="复制会话 ID 到剪贴板" onClick={handleCopyId}>
              复制会话id
            </button>
            <button className="session-content-tab-btn" title="启动会话" onClick={handleLaunch}>
              启动
            </button>
            <button className="session-content-tab-btn session-content-tab-btn--danger" title="删除会话文件" onClick={handleDelete}>
              删除
            </button>
          </div>
        </div>
        <SessionContentView sessionKey={sc.sessionKey} sessionName={sc.sessionName} />
      </div>
    );
  }
  // diff（union narrowing 后此处 tab 为 DiffTab）
  return (
    <div className={cls} data-tab-content-id={tab.id}>
      <DiffTab cwd={tab.cwd} commitHash={tab.commitHash} filePath={tab.filePath} singleColumn={tab.singleColumn} active={active} onBack={handleClose} />
    </div>
  );
}, tabContentPropsEqual);

/** 收集 cwd 树所有 leaf 的 (leafId, tab, activeTabId)，保持 leaf.tabs 顺序（供 TabContentHost portal 投射）。 */
function collectLeafTabs(tree: SplitTree): Array<{ leafId: string; tab: Tab; activeTabId: string | null }> {
  const out: Array<{ leafId: string; tab: Tab; activeTabId: string | null }> = [];
  const walk = (node: SplitTree): void => {
    if (node.type === 'leaf') {
      for (const tab of node.tabs) out.push({ leafId: node.id, tab, activeTabId: node.activeTabId });
      return;
    }
    for (const child of node.children) walk(child);
  };
  walk(tree);
  return out;
}

interface TabContentHostProps {
  tree: SplitTree;
  cwd: string;
  leafBodyRefs: React.RefObject<Map<string, HTMLElement>>;
  registerTabDeleted: (id: string, v: boolean) => void;
  onOpenFile?: (relPath: string, fileName: string, root: string) => void;
  registerCloseGuard: (id: string, guard: (() => void) | null) => void;
  onOpen?: (req: { key?: string; cwd?: string; name?: string; leafId?: string }) => void;
  onDeleteSessionRequest?: (key: string, name: string, tabId: string) => void;
}

/**
 * 全局 keep-alive 容器（修复终端 tab 跨 leaf 移动丢内容）。
 *
 * React 19 的 portal 在 container 变更时会重挂载内容（updatePortal 对 containerInfo 不
 * 相等即新建 fiber）→ 不能用「改投 leaf body」的方式跨 leaf 迁移，否则终端实例销毁。
 * 本实现把每个 tab 的 TabContent portal 到「自身 slot div」（容器恒定、永不改变），
 * slot div 用 CSS 绝对定位覆盖到所属 leaf 的内容区矩形（getBoundingClientRect 同步，
 * ResizeObserver 跟踪尺寸变化）——既不改 portal 容器、也不做 React 之外的 DOM 移动，
 * 从而保证 TabContent 永不移出 React 树 → IntegratedPane/SessionPane 不 cleanup →
 * XtermTerminal 实例与 scrollback 保留。
 *
 * closeTab 时 tab 从 store 移除 → collectLeafTabs 不再含该 tab → slot unmount →
 * releasePane 正常销毁。
 */
function TabContentHost({
  tree,
  cwd,
  leafBodyRefs,
  registerTabDeleted,
  onOpenFile,
  registerCloseGuard,
  onOpen,
  onDeleteSessionRequest,
}: TabContentHostProps) {
  const closeCenterTab = useSplitStore((s) => s.closeCenterTab);
  const { toast } = useToast();
  const hostRef = useRef<HTMLDivElement>(null);
  const entries = useMemo(() => collectLeafTabs(tree), [tree]);
  return (
    <div ref={hostRef} className="tab-content-host">
      {entries.map((entry) => (
        <TabContentSlot
          key={entry.tab.id}
          entry={entry}
          cwd={cwd}
          hostRef={hostRef}
          leafBodyRefs={leafBodyRefs}
          onOpenFile={onOpenFile}
          closeCenterTab={closeCenterTab}
          registerCloseGuard={registerCloseGuard}
          registerTabDeleted={registerTabDeleted}
          onOpen={onOpen}
          onDeleteSessionRequest={onDeleteSessionRequest}
          toast={toast}
        />
      ))}
    </div>
  );
}

interface TabContentSlotProps {
  entry: { leafId: string; tab: Tab; activeTabId: string | null };
  cwd: string;
  hostRef: React.RefObject<HTMLDivElement | null>;
  leafBodyRefs: React.RefObject<Map<string, HTMLElement>>;
  closeCenterTab: (id: string) => void;
  registerTabDeleted: (id: string, v: boolean) => void;
  onOpenFile?: (relPath: string, fileName: string, root: string) => void;
  registerCloseGuard: (id: string, guard: (() => void) | null) => void;
  onOpen?: (req: { key?: string; cwd?: string; name?: string; leafId?: string }) => void;
  onDeleteSessionRequest?: (key: string, name: string, tabId: string) => void;
  toast: (msg: string) => void;
}

interface SlotRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * 单个 tab 的稳定容器：portal target 恒为 slot div（React 19 下容器恒定 → 不重挂载），
 * slot div 绝对定位覆盖到所属 leaf 的内容区矩形。body 可能随树重构被重建（leafId 不变但
 * 容器换了），把 body 纳入 deps 可让效果在 body 重建后重新同步。
 */
function TabContentSlot({
  entry,
  cwd,
  hostRef,
  leafBodyRefs,
  closeCenterTab,
  registerTabDeleted,
  onOpenFile,
  registerCloseGuard,
  onOpen,
  onDeleteSessionRequest,
  toast,
}: TabContentSlotProps) {
  const [rect, setRect] = useState<SlotRect | null>(null);
  const body = leafBodyRefs.current.get(entry.leafId);
  const host = hostRef.current;
  // 记录上次同步的 rect，用于判断「值变化」→ 触发终端 refit（避免渲染期副作用）。
  const lastRectRef = useRef<SlotRect | null>(null);
  useLayoutEffect(() => {
    if (!body || !host) return;
    const sync = () => {
      const br = body.getBoundingClientRect();
      const hr = host.getBoundingClientRect();
      const next: SlotRect = { left: br.left - hr.left, top: br.top - hr.top, width: br.width, height: br.height };
      const last = lastRectRef.current;
      const same = !!last && last.left === next.left && last.top === next.top && last.width === next.width && last.height === next.height;
      lastRectRef.current = next;
      if (same) return; // 值未变：不触发重渲染、不触发 refit
      // ADR-0003 修复：tab 移动到新位置/新 leaf 时，即使尺寸未变（仅位置变），也强制触发
      // 终端 refit，使 canvas 用最新缓冲区重绘（真实 GPU 环境下无 resize 触发 → canvas 空白/旧帧）。
      // 首次挂载（last=null）不触发——避免应用启动时对每个 tab 反复全量 fit。
      if (last) window.dispatchEvent(new CustomEvent(SYNC_FIT_PANES_EVENT));
      setRect(next);
    };
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(body);
    return () => ro.disconnect();
  }, [entry.leafId, body, host]);
  if (!rect) return null;
  return (
    <div className="tab-content-slot" style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}>
      <TabContent
        tab={entry.tab}
        active={entry.tab.id === entry.activeTabId}
        cwd={cwd}
        onOpenFile={onOpenFile}
        closeCenterTab={closeCenterTab}
        registerCloseGuard={registerCloseGuard}
        registerTabDeleted={registerTabDeleted}
        onOpen={onOpen}
        onDeleteSessionRequest={onDeleteSessionRequest}
        toast={toast}
      />
    </div>
  );
}

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
  const splitPaneWithTab = useSplitStore((s) => s.splitPaneWithTab);

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

  // 从 DragContext 获取 leaf 的动态 items 与拖拽状态
  const { leafItems, hoveredLeafId, canDrop, isDragging, pendingSplitEdge, registerLeafBody, tabDeleted } = useDragContext();
  const isDragOver = hoveredLeafId === leaf.id;

  // 注册本 leaf 的内容区容器到 DragContext，供全局 TabContentHost 覆盖层定位（rect-sync）。
  const bodyRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    registerLeafBody(leaf.id, bodyRef.current);
    return () => registerLeafBody(leaf.id, null);
  }, [registerLeafBody, leaf.id]);

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
    // 点击 tab 时同步把键盘焦点交给该 tab 的内容（终端 / 编辑器 / 富文本），
    // 使其立即可输入（对齐 VS Code 点击 tab 即聚焦内容区）。
    const tab = leaf.tabs.find((t) => t.id === id);
    if (!tab) return;
    if (tab.kind === 'session' || tab.kind === 'integrated-terminal') {
      focusPane(id);
      return;
    }
    // preview / diff / session-content：聚焦内容区中第一个可编辑元素。
    // 延迟到下一帧，确保 store 更新 + active 类生效后 DOM 可见。
    // 用 getAttribute 精确匹配而非 CSS 属性选择器：tab id 含 Windows 路径反斜杠，
    // CSS 会把 \w 等当作转义序列导致选择器失配。
    requestAnimationFrame(() => {
      const host = Array.from(document.querySelectorAll<HTMLElement>('[data-tab-content-id]')).find(
        (el) => el.getAttribute('data-tab-content-id') === id,
      );
      if (host) focusEditableIn(host);
    });
  }, [selectTab, leaf.tabs]);

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
        tabDeleted={tabDeleted}
        onReorder={handleReorder}
        onNew={() => onOpen?.({ cwd, leafId: leaf.id })}
        onNewTerminal={onNewTerminal}
        onNewTerminalWithProfile={onNewTerminalWithProfile}
        terminalProfiles={terminalProfiles}
        onSplitPane={onSplitPane}
        sortableItems={sortableItems}
        onTabContextMenu={handleTabContextMenu}
      />
      <div className="center-pane-body" ref={bodyRef}>
        {/* 全局 keep-alive：tab 内容由 TabContentHost 经 portal 投射到本容器
            （跨 leaf 移动不换 React 父节点，终端实例不销毁）。 */}
        {/* ADR-0003：拖拽激活时叠加落点区 + 分屏预览。
            绝对定位覆盖内容区，渲染在末尾，不与 keyed 的 TabContent 冲突（不触发其卸载）。 */}
        {isDragging && hasContent && (
          <>
            <EdgeSplitZone leafId={leaf.id} side="top" />
            <EdgeSplitZone leafId={leaf.id} side="right" />
            <EdgeSplitZone leafId={leaf.id} side="bottom" />
            <EdgeSplitZone leafId={leaf.id} side="left" />
            {/* ADR-0003：所见即所得——预览线框精确等于分屏后新窗格区域。
                新窗格恒占本 leaf 矩形的一半（ratios [0.5,0.5]），左/右、上/下对应
                side=left/right/top/bottom；仅与边缘条带同 leaf 时渲染，鼠标离边即消失。 */}
            {pendingSplitEdge?.leafId === leaf.id && (
              <div className={`split-preview split-preview--${pendingSplitEdge.side}`} />
            )}
          </>
        )}
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
      <SplitPaneDragProvider tree={tree} cwd={cwd} isActive={isActive} {...rest}>
        <SplitPaneNode node={node} tree={tree} cwd={cwd} isActive={isActive} {...rest} />
      </SplitPaneDragProvider>
    </div>
  );
}