# 拖拽 Tab 创建/调整分屏布局

> 状态：规划中
> 关联 ADR：[ADR-0002 跨 leaf Tab 拖拽](../adr/0002-cross-leaf-tab-drag.md)（本方案在其 DndContext 架构上扩展）
> 决策确认：①源窗格只剩 1 个 Tab 时允许拖出，源变空后自动合并（不留空窗格）②落点区采用「边缘条带」样式

## Problem Statement

当前分屏只能通过两种方式创建：
- TabBar 工具栏的「水平/垂直分屏」按钮（`App.handleSplitPane` → `splitPane()` + 自动建终端）
- Tab 右键菜单「向右/向下分屏」（`splitPaneWithTab()`，且源窗格可见 Tab > 1 时才启用）

用户无法通过「拖拽 Tab 到窗格边缘」这一 IDE 标准手势来创建分屏。此外，现有拖拽体系存在一个交互盲区：`leaf-{leafId}` 这个 droppable 仅挂在 `.terminal-tabbar`（Tab 条）上（见 `TabBar.tsx` 的 `useDroppable` + `setDroppableRef`），**窗格内容区（`.center-pane-body`）目前没有任何 droppable**——把 Tab 拖到另一个窗格的内容区中央并不会移入，是个死区。

本方案在 ADR-0002 的「单 DndContext + 多 SortableContext」架构上扩展，新增：
1. **拖到边缘条带 → 创建新分屏**，被拖 Tab 移入新窗格（源窗格可变空）
2. **拖到内容区中央 → 移入该窗格**（补齐现有死区，让中央区域也有「移入当前窗格」语义）

跨窗格移动（`moveTabAcrossLeafs`）与拖分隔线缩放（`SplitPaneNode` 的 mouse 拖拽）保持不变。

## Goals / Non-Goals

### Goals
- 拖拽 Tab 时，每个可见 leaf 的内容区浮现 4 条边缘条带落点（上/下/左/右），命中即创建对应方向的分屏并移入 Tab。
- 内容区中央作为「移入当前窗格」落点，补齐现有死区。
- 源窗格仅 1 个可见 Tab 时也允许拖出，源窗格变空后自动合并空 leaf（不留空窗格：同 leaf 时分屏取消、跨 leaf 时源窗格消失）。
- 复用 `SplitPaneWithTab` 的核心逻辑，新增 `side`（新窗格前置/后置）与 `allowEmptySource`（允许源变空）两个开关，**向后兼容**现有右键菜单与单 Tab 守卫测试。
- 悬停边缘时给出「分屏预览」：条带高亮 + 半透明预览格示意新窗格落位；DragOverlay 追加方向提示。

### Non-Goals
- 不改 TabBar 工具栏分屏按钮与右键菜单的既有行为（右键菜单仍禁用单 Tab 分屏，保留 `canSplit = visibleTabCount > 1`）。
- 不引入嵌套 DndContext 或更换拖拽库。

## User Stories

1. 作为用户，我希望把当前 Tab 拖到窗格右边缘，松手后 Tab 进入右侧新建的分屏窗格。
2. 作为用户，我希望把 Tab 拖到另一窗格的内容区中央，Tab 直接移入该窗格（而非只能拖到 Tab 条）。
3. 作为用户，当源窗格只有这一个 Tab 时，我希望仍能拖到边缘创建分屏，源窗格自动合并（不留空窗格）。
4. 作为用户，拖拽悬停边缘时我希望看到半透明预览格示意新窗格将出现在哪一侧，避免误操作。
5. 作为用户，拖到左/上边缘时新窗格应出现在左/上侧（而非总在右/下），符合「拖向哪边分到哪边」的直觉。
6. 作为用户，边缘条带仅在拖拽激活时出现，平时不遮挡内容区。

## Implementation Decisions

### 1. Store：扩展 `splitPaneWithTab`（新增 `side` / `allowEmptySource`，向后兼容）

**文件**：`src/renderer/src/store/splitStore.ts`

接口签名由
```ts
splitPaneWithTab: (leafId: string, tabId: string, direction: SplitDirection) => void;
```
扩展为
```ts
splitPaneWithTab: (
  leafId: string,
  tabId: string,
  direction: SplitDirection,
  opts?: { side?: 'before' | 'after'; allowEmptySource?: boolean },
) => void;
```
默认 `side = 'after'`、`allowEmptySource = false`，**与现有右键菜单调用 `splitPaneWithTab(leaf.id, tabContextMenu.tabId, direction)` 及测试「源 leaf 只有一个 tab 时，不执行分屏（防御性检查）」完全兼容**（默认仍守卫单 Tab）。

实现要点（相对当前 `splitPaneWithTab`，约 splitStore.ts:1062）：
- 守卫改为 `if (remainingTabs.length === 0 && !opts?.allowEmptySource) return {};`
- `allowEmptySource=true` 且 `remainingTabs=[]` 时：不保留空源 leaf，而是用 `removeLeafFromTree` 移除空 leaf（同 leaf：splitNode 内空 half 移除 → 提升 → 分屏取消；跨 leaf：源窗格整体消失，其余窗格吸收空间）。`removeLeafFromTree` 返回 null 时回退为 `createLeaf()`。
- 子节点顺序按 `side`：
  ```ts
  const side = opts?.side ?? 'after';
  const children = side === 'before' ? [newLeaf, updatedLeaf] : [updatedLeaf, newLeaf];
  const splitNode: SplitNode = { type: 'split', id: nodeId, direction, ratios: [0.5, 0.5], children };
  ```
- 其余（`capturePaneScrollState` 滚动位置捕获、`pushTabHistory`、`cwdActiveLeafId`/`activeLeafId` 指向新 leaf）保持不变。

> 备注：`side='before'` 用于「拖到左/上边缘」——`direction='horizontal'` 时新 leaf 作为首个子节点出现在左侧，`'vertical'` 时出现在顶部。映射见 §4。

### 2. DragContext：新增 `isDragging` 与 `pendingSplitEdge`

**文件**：`src/renderer/src/components/SplitPane.tsx`（`DragContext` / `DragContextValue` / `SplitPaneDragProviderInner`）

```ts
type EdgeSide = 'top' | 'right' | 'bottom' | 'left';

interface DragContextValue {
  leafItems: Record<string, string[]>;
  hoveredLeafId: string | null;
  canDrop: boolean;
  registerScrollContainer: (leafId: string, el: HTMLElement | null) => void;
  // 新增
  isDragging: boolean;                                          // 仅拖拽激活时为 true，驱动边缘条带渲染
  pendingSplitEdge: { leafId: string; side: EdgeSide } | null;  // 当前悬停的边缘落点（驱动预览格高亮）
}
```

- `handleDragStart` 末尾 `setIsDragging(true)`；`handleDragEnd` 与新增 `handleDragCancel` 中 `setIsDragging(false)`、`setPendingSplitEdge(null)`。
- 关键不变量保留：`SplitPaneDragProvider` 仍**恒定返回** `DragContext.Provider > DndContext > children` 结构（注释见 splitPane:820-840），`isActive` 切换不改变根节点类型，避免终端实例被卸载重挂导致黑屏。`isDragging` 是运行期状态、非 `isActive`，激活窗格内才有拖拽，非激活 cwd 的 `isDragging` 恒为 false，不影响 keep-alive。

### 3. 落点区：边缘条带 + 内容区中央 droppable

**新增组件**：`src/renderer/src/components/EdgeSplitZone.tsx`（职责单一、可独立测试，风格对齐 `SplitDivider.tsx`）

```tsx
// 单条边缘条带 droppable。id 形如 split-edge:{leafId}:{side}。
// 仅在 isDragging=true 时由 SplitPaneLeaf 渲染（pointer-events 默认 auto，dnd-kit 用坐标碰撞，无需手动命中）。
export function EdgeSplitZone({ leafId, side }: { leafId: string; side: EdgeSide }) {
  const { setNodeRef, isOver } = useDroppable({ id: `split-edge:${leafId}:${side}` });
  return <div ref={setNodeRef} className={`split-edge-zone split-edge-zone--${side}${isOver ? ' split-edge-zone--hover' : ''}`} />;
}
```

**`SplitPaneLeaf` 渲染**（`center-pane-body` 内，覆盖内容区）：
```tsx
const { isDragging, pendingSplitEdge } = useDragContext();
// …
<div className="center-pane-body" style={{ position: 'relative' }}>
  {/* keep-alive tab 内容，不变 */}
  {leaf.tabs.map((t) => <TabContent ... />)}
  {/* 拖拽激活时叠加落点区（渲染在末尾，不与 keyed 的 TabContent 冲突，不触发其卸载） */}
  {isDragging && hasContent && (
    <>
      <EdgeSplitZone leafId={leaf.id} side="top" />
      <EdgeSplitZone leafId={leaf.id} side="right" />
      <EdgeSplitZone leafId={leaf.id} side="bottom" />
      <EdgeSplitZone leafId={leaf.id} side="left" />
      {/* 内容区中央 droppable：移入当前窗格（补齐死区） */}
      <LeafBodyDropZone leafId={leaf.id} />
      {/* 分屏预览格：悬停边缘时示意新窗格落位 */}
      {pendingSplitEdge?.leafId === leaf.id && (
        <div className={`split-preview split-preview--${pendingSplitEdge.side}`} />
      )}
    </>
  )}
</div>
```
- `LeafBodyDropZone` 用 `useDroppable({ id: 'leaf-body:${leafId}' })`，覆盖内容区中央（避开 4 条带的中部矩形），命中即「移入当前窗格」。
- 条带几何（CSS §5）：上/下条带 full-width、高 25%；左/右条带位于上下条带之间、宽 25%；中央 droppable 占剩余中部矩形。四向无重叠，`closestCorners` 无歧义。
- `hasContent` = `orderedVisibleTabs.length > 0`；空窗格不渲染条带（空窗格本就显示空状态，无需再分屏目标）。

### 4. DnD 事件处理：`onDragOver` / `onDragEnd` 识别 `split-edge:` 与 `leaf-body:`

**`handleDragOver`**（在现有「忽略 `split-divider-`」之后插入，先于 leaf/tab 处理）：
```ts
// 边缘分屏落点
if (overId.startsWith('split-edge:')) {
  const [, leafId, side] = overId.split(':') as [string, string, EdgeSide];
  setPendingSplitEdge({ leafId, side });
  setHoveredLeafId(null);   // 不触发 leaf 整体高亮，改由预览格表达
  setCanDrop(true);         // 新 leaf 恒空，去重永不冲突
  return;                   // 跳过 SortableContext items 动态管理
}
// 内容区中央 → 移入当前窗格（复用既有 leaf 处理分支）
if (overId.startsWith('leaf-body:')) {
  const leafId = overId.slice('leaf-body:'.length);
  setPendingSplitEdge(null);
  setHoveredLeafId(leafId);
  // 走现有 canMoveTabToLeaf 去重 + items 管理逻辑（与 leaf-{leafId} 同语义）
  // …fallthrough 到既有 targetLeafId=leafId 路径
}
// 非边缘/非中央命中 → 清除预览
setPendingSplitEdge(null);
```

**`handleDragEnd`**（在现有「忽略 `split-divider-`」之后插入）：
```ts
if (overId.startsWith('split-edge:')) {
  const [, targetLeafId, side] = overId.split(':') as [string, string, EdgeSide];
  if (!dragItem) return;
  const { tabId, sourceLeafId } = dragItem;
  const { direction, side: childSide } = edgeToDirSide(side);
  // side → (direction, childSide) 映射：
  //   left  → horizontal, before   right → horizontal, after
  //   top   → vertical,   before   bottom→ vertical,   after
  splitPaneWithTab(targetLeafId, tabId, direction, { side: childSide, allowEmptySource: true });
  return;
}
if (overId.startsWith('leaf-body:')) {
  // 当作 leaf-{leafId} 处理：移入目标窗格末尾（与现有 leaf- 分支合并）
  targetLeafId = overId.slice('leaf-body:'.length);
  // …复用现有 moveTabAcrossLeafs / reorderTabsInLeaf 路径
}
```
- 辅助函数：
  ```ts
  function edgeToDirSide(side: EdgeSide): { direction: SplitDirection; side: 'before' | 'after' } {
    switch (side) {
      case 'left':  return { direction: 'horizontal', side: 'before' };
      case 'right': return { direction: 'horizontal', side: 'after' };
      case 'top':   return { direction: 'vertical',   side: 'before' };
      case 'bottom':return { direction: 'vertical',   side: 'after' };
    }
  }
  ```
- 分屏后若源 leaf 变空（`allowEmptySource` 且源仅剩被移 Tab）：自动合并——`removeLeafFromTree` 移除空 leaf。同 leaf 自拖到自身边缘 → 分屏取消（树回退单 leaf，Tab 留在原位）；跨 leaf 拖出 → 源窗格消失，其余窗格吸收空间。

### 5. DragOverlay 方向提示

悬停边缘时给 DragOverlay 追加方向角标（复用现有 `drag-overlay` 类）：
```tsx
{pendingSplitEdge && (
  <span className="drag-overlay-split-hint">
    {pendingSplitEdge.side === 'left'  && '⇤ 分屏'}
    {pendingSplitEdge.side === 'right' && '分屏 ⇥'}
    {pendingSplitEdge.side === 'top'   && '⇧ 分屏'}
    {pendingSplitEdge.side === 'bottom'&& '分屏 ⇩'}
  </span>
)}
```

### 6. CSS

**文件**：`src/renderer/src/styles/app.css`（紧接现有 `.split-pane-leaf--drag-over` 区块后追加）

```css
/* ── 拖拽创建分屏：边缘条带 + 预览格 ── */
.split-edge-zone {
  position: absolute;
  z-index: 5;                 /* 高于内容区，低于 TabBar(z 未设) 与 DragOverlay(portal) */
  background: transparent;
  transition: background-color var(--transition);
}
.split-edge-zone--top    { top: 0;    left: 0; right: 0;  height: 25%; }
.split-edge-zone--bottom { bottom: 0; left: 0; right: 0;  height: 25%; }
.split-edge-zone--left   { left: 0;  top: 25%; bottom: 25%; width: 25%; }
.split-edge-zone--right  { right: 0; top: 25%; bottom: 25%; width: 25%; }
.split-edge-zone--hover {
  background: color-mix(in srgb, var(--accent) 22%, transparent);
  outline: 1px solid var(--accent);
}

/* 内容区中央 droppable（移入当前窗格）占中部矩形，透明命中 */
.leaf-body-drop { position: absolute; inset: 25%; z-index: 4; }

/* 分屏预览格：半透明示意新窗格落位 */
.split-preview { position: absolute; z-index: 6; pointer-events: none;
  background: color-mix(in srgb, var(--accent) 30%, transparent);
  border: 1px dashed var(--accent); }
.split-preview--top    { top: 0;    left: 0; right: 0; height: 50%; }
.split-preview--bottom { bottom: 0; left: 0; right: 0; height: 50%; }
.split-preview--left   { left: 0;  top: 0; bottom: 0; width: 50%; }
.split-preview--right  { right: 0; top: 0; bottom: 0; width: 50%; }

/* DragOverlay 方向提示 */
.drag-overlay-split-hint { margin-left: 4px; opacity: 0.9; }
```
> `color-mix` 需浏览器支持（Electron Chromium 已支持）。预览格高度/宽度固定 50%，与 `ratios:[0.5,0.5]` 实际结果一致。

## Files to Change

| 文件 | 变更 |
|---|---|
| `src/renderer/src/store/splitStore.ts` | `SplitStore.splitPaneWithTab` 签名加 `opts?{side,allowEmptySource}`；实现加 `side` 子节点排序 + `allowEmptySource` 解除单 Tab 守卫 |
| `src/renderer/src/components/SplitPane.tsx` | `DragContextValue` 加 `isDragging`/`pendingSplitEdge`；`SplitPaneDragProviderInner` 加 state、`handleDragOver`/`handleDragEnd` 识别 `split-edge:`/`leaf-body:`、新增 `handleDragCancel`；DragOverlay 方向提示；`SplitPaneLeaf` 渲染 4 条带 + 中央 droppable + 预览格 |
| `src/renderer/src/components/EdgeSplitZone.tsx` | **新增**：单条边缘条带 droppable 组件（`useDroppable`，id `split-edge:{leafId}:{side}`） |
| `src/renderer/src/styles/app.css` | 追加 `.split-edge-zone*` / `.leaf-body-drop` / `.split-preview*` / `.drag-overlay-split-hint` 样式 |
| `src/renderer/src/store/__tests__/splitStore.test.ts` | `splitPaneWithTab` describe 下新增：`side:'before'` 子节点前置、`side:'after'` 后置、`allowEmptySource:true` 单 Tab 源变空且 Tab 进新 leaf、默认仍守卫单 Tab（不破坏 line 522 既有断言） |
| `docs/adr/0003-drag-to-edge-split.md` | **新增**：记录「边缘条带 + 单 Tab 允许变空」决策与备选（中心十字/阻止单 Tab）及取舍 |

## Testing

### 单元测试（`splitStore.test.ts`，vitest）
在 `describe('splitPaneWithTab — 分屏并移动 tab')` 内新增：
1. `side:'before'` → `tree.children[0]` 为新 leaf（含被移 Tab），`children[1]` 为源 leaf。
2. `side:'after'`（默认）→ 顺序反之，与既有「水平分屏后被移动的 tab 在新 leaf 中」一致。
3. `allowEmptySource:true` + 源仅 1 Tab → 树变为 split，源 leaf `tabs=[]`、`activeTabId=null`，新 leaf 含该 Tab 且 `activeTabId` 指向它；`activeLeafId`/`cwdActiveLeafId[cwd]` 指向新 leaf。
4. 默认（无 opts）+ 源仅 1 Tab → 仍是 no-op（**保留 line 522 既有测试不变**，验证向后兼容）。
5. `canMoveTabToLeaf` 对全空目标 leaf 返回 true（新 leaf 恒空，分屏永不冲突）——既有覆盖可补充一条。

### 组件/交互测试
- `SplitPane` 目前无组件级测试（codegraph 标注 `⚠️ no covering tests found`）。本方案核心逻辑下沉到 store 已由单测覆盖；拖拽坐标碰撞属 dnd-kit 行为，组件层仅加 **e2e 冒烟**（`e2e/` 已有 Playwright + 真实 Electron）：
  - 新建两 Tab → 拖第一个到右边缘 → 断言出现两个窗格、被拖 Tab 在右侧。
  - 拖到另一窗格中央 → 断言 Tab 移入。
  - 单 Tab 拖到下边缘 → 断言源窗格变空（含空状态按钮）、新窗格含 Tab。
- 若 e2e 拖拽坐标耦合成本高，退化为手测清单（附于 ADR-0003）。

## Edge Cases / 验证清单

- [ ] 同 leaf 自拖到边缘（单窗格场景）：产生 `[空源 | 新 Tab]`，源 leaf 显示空状态。
- [ ] 同 leaf 自拖到边缘（单窗格场景）：源空自动合并 → 分屏取消，树回退单 leaf（Tab 留在原位）。
- [ ] 源 leaf 仅 1 Tab 且 `allowEmptySource`：跨 leaf 拖出时源窗格消失，其余窗格吸收空间。
- [ ] 右键菜单分屏（`allowEmptySource:false`）仍守卫单 Tab（源 leaf 多 Tab 才可分屏），不受影响。
- [ ] 拖到边缘后立即再拖分隔线缩放：`SplitPaneNode` mouse 拖拽逻辑不受影响（`split-divider-` 仍在 onDragOver 中被忽略）。
- [ ] 嵌套分屏：边缘条带递归出现在每个 leaf；`updateLeaf` 按叶子 id 替换，嵌套结构正确（既有 `updateLeaf` 已支持）。
- [ ] 非激活 cwd：`isDragging` 恒 false，不渲染条带，DndContext 闲置——不破坏「切 cwd 黑屏」修复（根节点结构恒定，仅 opacity 切换）。
- [ ] DragOverlay 在 `isActive` 时才渲染（既有条件），方向提示随之。
- [ ] `pendingSplitEdge` 在 `onDragCancel`（Esc / 窗口失焦）时清除，避免残留预览格。
- [ ] 右键菜单「向右/向下分屏」行为不变（默认 `side:'after'`、`allowEmptySource:false`，`canSplit` 守卫不动）。

## 后续可演进（非本期）

- 窗格整体拖拽重排（交换/插入窗格顺序）——需引入窗格级 droppable 与树重平衡，复杂度高，单独成期。
- 右键菜单放开单 Tab 分屏（与拖拽统一）——UX 一致性优化，改 `canSplit` 守卫即可，低风险。
