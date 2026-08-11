import { useState, useRef, useEffect, useCallback } from 'react';
import { useDroppable } from '@dnd-kit/core';
import {
  SortableContext,
  horizontalListSortingStrategy,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { IconClose, IconNewSession, IconFile, IconGitDiff, IconSession, IconTerminal, IconArrowDown, IconSplitHorizontal, IconSplitVertical } from './icons';
import { buildGroupedRows } from './tabGrouping';
import { useDragContext } from './SplitPane';
export type TabKind = 'session' | 'preview' | 'diff' | 'integrated-terminal' | 'session-content';

export interface TabBarItem {
  id: string;
  title: string;
  kind: TabKind;
  closable?: boolean;   // 默认 true；某些特殊 tab 可设为不可关闭
  /** 分组归并键（ADR-0001 TabAutoGroup）：同键的 tab 在 tab 条上归为一段，段间插视觉分隔。
   *  不传则视为「无分组键」，与其他无键 tab 混排。纯展示层，不进 store 数据模型。
   *  例：中间区 session/diff 用 cwd、preview 用 root；终端区用 cwd。 */
  groupKey?: string;
}

interface Props {
  tabs: TabBarItem[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNew?: () => void;     // 可选：提供则在最右显示「+」新建按钮
  showNew?: boolean;      // 是否显示新建按钮（默认 onNew 存在且为 true）
  // 拖拽重排（ADR-0001 TabReorder）：传入则启用 @dnd-kit 同区域排序；
  // 拖拽结束后回调「按当前视觉顺序的 id 列表」，由父层（CenterPane）调 store.reorderTabs。
  // 不传则纯展示（如右栏固定 files/git 两个 tab）。
  onReorder?: (orderedIds: string[]) => void;
  // tab 脏状态标记（如 Git 工作区有改动时显示小黄点），key 为 tab id，值为 true 表示有未读改动。
  tabDirty?: Record<string, boolean>;
  // TabAutoGroup（ADR-0001 E3）：传入则按 item.groupKey 归并分组，组间插视觉分隔。
  // 纯展示层归类，不进 store（无 group 实体）；与 onReorder 拖拽重排互不冲突——
  // 分隔符为非 sortable 静态元素，所有 tab 仍在同一 SortableContext 中可跨段拖拽。
  // 分组仅改变展示顺序/分隔，不改变 tabs 数据顺序（父层传入顺序即视觉顺序）。
  groupBy?: (t: TabBarItem) => string | undefined;
  // 新建终端按钮（VS Code 风格）：加号创建默认终端，下拉箭头展开选择指定终端类型
  onNewTerminal?: () => void;
  onNewTerminalWithProfile?: (profileId: string) => void;
  terminalProfiles?: Array<{ id: string; label: string }>;
  // 所属 SplitLeaf 的 id（分屏模式下使用），用于 closeTab/selectTab/reorderTabsInLeaf 等操作
  leafId?: string;
  // 分屏回调：点击分屏按钮时触发
  onSplitPane?: (leafId: string, direction: 'horizontal' | 'vertical') => void;
  // 跨 leaf 拖拽时，由 SplitPaneDragProvider 提供的 SortableContext items（动态管理）
  sortableItems?: string[];
  // tab 右键回调：参数为被右键的 tab id 与鼠标事件（用于定位右键菜单）。
  onTabContextMenu?: (tabId: string, e: React.MouseEvent) => void;
}

const renderKindIcon = (kind: TabKind) => {
  switch (kind) {
    case 'session':
      return <IconSession size={14} />;
    case 'preview':
      return <IconFile size={14} />;
    case 'diff':
      return <IconGitDiff size={14} />;
    case 'integrated-terminal':
      return <IconTerminal size={14} />;
    case 'session-content':
      return <IconFile size={14} />;
    default:
      return null;
  }
};

// 单个可排序的 tab：接入 useSortable，拖拽时应用 transform/transition。
// 整个 tab 可拖；关闭 × 仍走 onClick（stopPropagation 已阻止切 tab）。
function SortableTab({
  item,
  activeId,
  onSelect,
  onClose,
  dirty,
  onContextMenu,
}: {
  item: TabBarItem;
  activeId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  dirty?: boolean;
  onContextMenu?: (tabId: string, e: React.MouseEvent) => void;
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } =
    useSortable({ id: item.id });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    // 拖拽中的 tab 提到最上层并略降透明度，避免被非 active 样式盖住。
    zIndex: isDragging ? 1 : undefined,
    opacity: isDragging ? 0.85 : undefined,
  };

  const closable = item.closable ?? true;

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      role="tab"
      aria-selected={item.id === activeId}
      className={item.id === activeId ? 'terminal-tab active' : 'terminal-tab'}
      onClick={() => onSelect(item.id)}
      onContextMenu={(e) => onContextMenu?.(item.id, e)}
      title={item.title}
    >
      <span className="terminal-tab-icon">{renderKindIcon(item.kind)}</span>
      <span className="terminal-tab-title">{item.title}</span>
      {dirty && <span className="tab-dirty-dot" />}
      {closable && (
        <button
          type="button"
          className="tab-close"
          aria-label="关闭"
          title="关闭"
          ref={setActivatorNodeRef}
          onClick={(e) => {
            e.stopPropagation();
            onClose(item.id);
          }}
        >
          <IconClose size={12} />
        </button>
      )}
    </div>
  );
}

// 新建终端按钮组（VS Code 风格）
function NewTerminalButton({
  onNewTerminal,
  onNewTerminalWithProfile,
  terminalProfiles,
}: {
  onNewTerminal: () => void;
  onNewTerminalWithProfile?: (profileId: string) => void;
  terminalProfiles?: Array<{ id: string; label: string }>;
}) {
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!dropdownOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [dropdownOpen]);

  return (
    <div className="terminal-new-btn-group" ref={ref}>
      <button
        type="button"
        className="terminal-new-btn-main"
        aria-label="新建终端"
        title="新建终端"
        onClick={() => { onNewTerminal(); setDropdownOpen(false); }}
      >
        <IconTerminal size={14} />
      </button>
      <button
        type="button"
        className="terminal-new-btn-arrow"
        aria-label="选择终端类型"
        title="选择终端类型"
        onClick={() => setDropdownOpen(!dropdownOpen)}
      >
        <IconArrowDown size={10} />
      </button>
      {dropdownOpen && (
        <div className="terminal-profile-dropdown">
          {terminalProfiles && terminalProfiles.length > 0 ? (
            terminalProfiles.map((p) => (
              <div
                key={p.id}
                className="terminal-profile-dropdown-item"
                onClick={() => {
                  onNewTerminalWithProfile?.(p.id);
                  setDropdownOpen(false);
                }}
              >
                {p.label}
              </div>
            ))
          ) : (
            <div className="terminal-profile-dropdown-item disabled">
              暂无可用终端
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── TabBar 滚动逻辑 ──

/** 单个箭头按钮，点击时滚动一个 tab 宽度的距离。 */
function ScrollArrow({ direction, onClick }: { direction: 'left' | 'right'; onClick: () => void }) {
  return (
    <button
      type="button"
      className={`tabbar-scroll-arrow tabbar-scroll-arrow--${direction}`}
      onClick={onClick}
      aria-label={direction === 'left' ? '向左滚动' : '向右滚动'}
      tabIndex={-1}
    >
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
        <path
          d={direction === 'left' ? 'M9 3L5 7l4 4' : 'M5 3l4 4-4 4'}
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );
}

/**
 * 可滚动的 TabBar 容器。
 * 将 tabs 包裹在 overflow-x: auto 的容器中，左右边缘显示箭头按钮 + 渐变阴影。
 * 按钮组（新建终端、分屏）固定在右侧，不参与滚动。
 */
function ScrollableTabBar({ children, leafId }: {
  children: React.ReactNode;
  leafId?: string;
}) {
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const scrollbarThumbRef = useRef<HTMLDivElement | null>(null);
  const [scrollState, setScrollState] = useState({ left: 0, right: 0 });
  const [hasOverflow, setHasOverflow] = useState(false);

  // 更新滚动状态 + 自定义滚动条缩略图位置
  const updateScrollState = useCallback(() => {
    const el = scrollContainerRef.current;
    const thumb = scrollbarThumbRef.current;
    if (!el) return;
    const maxScroll = el.scrollWidth - el.clientWidth;
    const scrollLeft = el.scrollLeft;
    setScrollState({
      left: scrollLeft,
      right: maxScroll - scrollLeft,
    });
    setHasOverflow(maxScroll > 0);
    // 同步缩略图位置和宽度
    if (thumb && maxScroll > 0) {
      const thumbWidth = Math.max(20, el.clientWidth * (el.clientWidth / el.scrollWidth));
      const thumbLeft = (scrollLeft / maxScroll) * (el.clientWidth - thumbWidth);
      thumb.style.width = `${thumbWidth}px`;
      thumb.style.transform = `translateX(${thumbLeft}px)`;
    }
  }, []);

  // 监听滚动事件 + 鼠标滚轮水平滚动
  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;

    const handleWheel = (e: WheelEvent) => {
      // 如果已是水平滚轮手势，让浏览器原生处理
      if (e.deltaX !== 0 && e.deltaY === 0) return;
      // 将垂直滚轮转换为水平滚动
      const scrollAmount = e.deltaY;
      el.scrollLeft += scrollAmount;
      e.preventDefault();
    };

    el.addEventListener('scroll', updateScrollState, { passive: true });
    el.addEventListener('wheel', handleWheel, { passive: false });

    // 初始计算
    updateScrollState();
    // 用 ResizeObserver 监听容器尺寸变化（tab 增删时）
    const ro = new ResizeObserver(updateScrollState);
    ro.observe(el);
    return () => {
      el.removeEventListener('scroll', updateScrollState);
      el.removeEventListener('wheel', handleWheel);
      ro.disconnect();
    };
  }, [updateScrollState]);

  // 注册 scroll container 到 DragContext（供拖拽自动滚动使用）
  const { registerScrollContainer } = useDragContext();
  const scrollContainerCallbackRef = useCallback((el: HTMLDivElement | null) => {
    scrollContainerRef.current = el;
    registerScrollContainer(leafId ?? '', el);
  }, [leafId, registerScrollContainer]);

  const canScrollLeft = scrollState.left > 0;
  const canScrollRight = scrollState.right > 1; // 1px 容差

  // 点击箭头滚动一个 tab 宽度（160px）
  const scrollBy = useCallback((dir: 'left' | 'right') => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const amount = 160;
    el.scrollBy({ left: dir === 'left' ? -amount : amount, behavior: 'smooth' });
  }, []);

  return (
    <div className="tabbar-scroll-area">
      {canScrollLeft && <ScrollArrow direction="left" onClick={() => scrollBy('left')} />}
      <div
        className="tabbar-scroll-container"
        ref={scrollContainerCallbackRef}
        onScroll={updateScrollState}
      >
        <div className="tabbar-scroll-inner">
          {children}
        </div>
      </div>
      {canScrollRight && <ScrollArrow direction="right" onClick={() => scrollBy('right')} />}
      {canScrollLeft && <div className="tabbar-scroll-gradient tabbar-scroll-gradient--left" />}
      {canScrollRight && <div className="tabbar-scroll-gradient tabbar-scroll-gradient--right" />}
      {hasOverflow && (
        <div className="tabbar-scrollbar" aria-hidden="true">
          <div className="tabbar-scrollbar-thumb" ref={scrollbarThumbRef} />
        </div>
      )}
    </div>
  );
}

// 固定按钮组（新建终端、分屏等）
function TabBarActions({
  newVisible, onNew, onNewTerminal, onNewTerminalWithProfile, terminalProfiles,
  onSplitPane, leafId,
}: {
  newVisible: boolean;
  onNew?: () => void;
  onNewTerminal?: () => void;
  onNewTerminalWithProfile?: (profileId: string) => void;
  terminalProfiles?: Array<{ id: string; label: string }>;
  onSplitPane?: (leafId: string, direction: 'horizontal' | 'vertical') => void;
  leafId?: string;
}) {
  return (
    <div className="tabbar-actions">
      {newVisible && onNew && (
        <button
          type="button"
          className="tab-new terminal-new-btn"
          aria-label="新建"
          title="新建"
          onClick={onNew}
        >
          <IconNewSession size={14} />
        </button>
      )}
      {onNewTerminal && (
        <NewTerminalButton
          onNewTerminal={onNewTerminal}
          onNewTerminalWithProfile={onNewTerminalWithProfile}
          terminalProfiles={terminalProfiles}
        />
      )}
      {onSplitPane && leafId && (
        <>
          <div className="split-pane-btn-sep" />
          <button
            type="button"
            className="split-pane-btn"
            aria-label="水平分屏"
            title="水平分屏（左右）"
            onClick={(e) => { e.stopPropagation(); onSplitPane(leafId, 'horizontal'); }}
          >
            <IconSplitHorizontal size={14} />
          </button>
          <button
            type="button"
            className="split-pane-btn"
            aria-label="垂直分屏"
            title="垂直分屏（上下）"
            onClick={(e) => { e.stopPropagation(); onSplitPane(leafId, 'vertical'); }}
          >
            <IconSplitVertical size={14} />
          </button>
        </>
      )}
    </div>
  );
}

// 通用 Tab 条：支持三种 tab kind（session/preview/diff）显示不同前缀图标，
// 每个 tab 右侧 × 关单个 tab，最右可选「+」新建按钮。复用 TerminalTabBar 的
// 视觉类名体系（terminal-tabbar / terminal-tab / tab-close / tab-new），CSS 无需大改。
// 当前 active 的 tab 加 active class；关闭 × 默认隐藏，hover 才显示（CSS 控制）。
//
// 拖拽重排（ADR-0001 TabReorder）：当传入 onReorder 时，整个 tab 条包进
// SortableContext（每个 tab 成为 useSortable 项），但 DndContext 已提升到
// 父层 SplitPaneDragProvider 中（ADR-0002 跨 leaf 拖拽），由父层统一管理
// onDragStart/onDragOver/onDragEnd。
//
// 渲染顺序完全由父层传入的 tabs 顺序（即 store.order 排序后的结果）决定，本组件不
// 另存一份顺序快照，从而保证 store 重排后 TabBar 视觉顺序即时跟随。
export function TabBar({ tabs, activeId, onSelect, onClose, onNew, showNew, onReorder, groupBy, tabDirty, onNewTerminal, onNewTerminalWithProfile, terminalProfiles, leafId, onSplitPane, sortableItems, onTabContextMenu }: Props) {
  // 分组展示行（TabAutoGroup）：纯展示归类，不影响 tabs 数据顺序。
  const rows = buildGroupedRows(tabs, groupBy);

  const newVisible = showNew ?? onNew !== undefined;

  // leaf 级 droppable（拖到 TabBar 空白区域时定位到 leaf 容器）
  const { setNodeRef: setDroppableRef } = useDroppable({ id: leafId ? `leaf-${leafId}` : 'unknown' });

  // 渲染 tab 列表（共享逻辑，用于两个分支）
  const renderTabs = () => rows.map((row, i) =>
    row.type === 'sep' ? (
      <span key={`sep-${i}`} className="terminal-tab-group-sep" aria-hidden="true" />
    ) : (
      <div
        key={row.item.id}
        role="tab"
        aria-selected={row.item.id === activeId}
        className={row.item.id === activeId ? 'terminal-tab active' : 'terminal-tab'}
        onClick={() => onSelect(row.item.id)}
        onContextMenu={(e) => onTabContextMenu?.(row.item.id, e)}
        title={row.item.title}
      >
        <span className="terminal-tab-icon">{renderKindIcon(row.item.kind)}</span>
        <span className="terminal-tab-title">{row.item.title}</span>
        {tabDirty?.[row.item.id] && <span className="tab-dirty-dot" />}
        {(row.item.closable ?? true) && (
          <button
            type="button"
            className="tab-close"
            aria-label="关闭"
            title="关闭"
            onClick={(e) => {
              e.stopPropagation();
              onClose(row.item.id);
            }}
          >
            <IconClose size={12} />
          </button>
        )}
      </div>
    ),
  );

  // 渲染 SortableTab 列表
  const renderSortableTabs = () => rows.map((row, i) =>
    row.type === 'sep' ? (
      <span key={`sep-${i}`} className="terminal-tab-group-sep" aria-hidden="true" />
    ) : (
      <SortableTab
        key={row.item.id}
        item={row.item}
        activeId={activeId}
        onSelect={onSelect}
        onClose={onClose}
        dirty={tabDirty?.[row.item.id]}
        onContextMenu={onTabContextMenu}
      />
    ),
  );

  // 无可重排（无 onReorder）时退化为纯展示
  if (!onReorder) {
    return (
      <div className="terminal-tabbar" role="tablist" ref={setDroppableRef}>
        <ScrollableTabBar leafId={leafId}>
          {renderTabs()}
        </ScrollableTabBar>
        <TabBarActions
          newVisible={newVisible}
          onNew={onNew}
          onNewTerminal={onNewTerminal}
          onNewTerminalWithProfile={onNewTerminalWithProfile}
          terminalProfiles={terminalProfiles}
          onSplitPane={onSplitPane}
          leafId={leafId}
        />
      </div>
    );
  }

  // 使用动态 sortableItems（如果提供），否则使用默认的 tabs id 列表
  const items = sortableItems ?? tabs.map((t) => t.id);

  return (
    <SortableContext items={items} strategy={horizontalListSortingStrategy}>
      <div className="terminal-tabbar" role="tablist" ref={setDroppableRef}>
        <ScrollableTabBar leafId={leafId}>
          {renderSortableTabs()}
        </ScrollableTabBar>
        <TabBarActions
          newVisible={newVisible}
          onNew={onNew}
          onNewTerminal={onNewTerminal}
          onNewTerminalWithProfile={onNewTerminalWithProfile}
          terminalProfiles={terminalProfiles}
          onSplitPane={onSplitPane}
          leafId={leafId}
        />
      </div>
    </SortableContext>
  );
}