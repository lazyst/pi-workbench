# ADR-0003：拖拽 Tab 到边缘创建分屏

## 状态

已实施（2025-07）

## 背景

ADR-0002 实现了跨 SplitLeaf Tab 拖拽移动，但创建分屏仍需用户点击工具栏按钮或右键菜单。用户期望通过「拖拽 Tab 到窗格边缘」这一 IDE 标准手势来创建分屏（对齐 VS Code / JetBrains）。现有 `leaf-{leafId}` droppable 挂在 `.terminal-tabbar`（Tab 条）上，Tab 在分屏间移动需拖到目标窗格的 Tab 条。

## 决策

### 核心交互

1. **拖到任意窗格边缘条带（上/下/左/右）→ 在该窗格处创建分屏**，被拖 Tab 移入新窗格。不限源窗格——可拖到另一窗格的边缘，分屏建在该窗格上（跨 leaf 分屏）。
2. **所见即所得预览**：悬停边缘时，在对应方向显示一个**精确等于分屏后新窗格区域**的虚线框（leaf 矩形 50%，对应 `ratios:[0.5,0.5]`）。拖到右边缘→右半线框、左边缘→左半、上边缘→上半、下边缘→下半。边缘条带本身仅作**感应区**、无视觉。
3. **Tab 在分屏间移动 → 拖到目标窗格的 Tab 条**（复用 ADR-0002 的 `leaf-{leafId}` / tab 落点）。**内容区中央不是落点**——拖到中央无任何操作、无任何提示线框（避免与「创建分屏」手势混淆）。
4. **源窗格仅 1 个可见 Tab 时也允许拖出**，源窗格保留为空窗格（显示空状态按钮）——同 leaf 与跨 leaf 一致。

### 实现方案

#### Store 层

扩展 `splitPaneWithTab` 签名，新增 `opts` 参数（向后兼容），并支持**跨 leaf 分屏**：

```ts
splitPaneWithTab(
  leafId: string,
  tabId: string,
  direction: SplitDirection,
  opts?: { side?: 'before' | 'after'; allowEmptySource?: boolean },
): void
```

- `leafId` = 分屏发生处的**目标 leaf**（拖拽命中边缘的 leaf）；`tabId` 的**源 leaf** 可在任意位置——`findTabById` 定位源，`findLeaf` 定位目标。
- `side`：`'before'`（新窗格前置）用于拖到左/上边缘，`'after'`（后置，默认）用于拖到右/下边缘。
- `allowEmptySource`：`true` 时解除单 Tab 守卫（源变空），`false`（默认）保留现有右键菜单的 `canSplit` 检查。
- 同 leaf（源===目标）：退化为原有逻辑（右键菜单、同 leaf 拖拽零改动）。跨 leaf：从源移除 tab（源变空时按 `allowEmptySource` 保留空窗格），在目标处建 split node `[目标原样, newLeaf{tab}]`，源另行更新。两个 leaf 互不为后代（leaf 无子树），两次 `updateLeaf` 作用于不同位置、不冲突。

#### 组件层

- **DragContext** 新增 `isDragging: boolean` 与 `pendingSplitEdge: { leafId, side } | null`，驱动边缘条带渲染、预览线框与 DragOverlay 方向箭头。
- **SplitPaneDragProviderInner** 新增 `handleDragCancel` 清理临时状态；`handleDragOver` 在 `over=null`（死区/中央）时清除 `pendingSplitEdge` 与 `hoveredLeafId`，不残留高亮。
- **SplitPaneLeaf** 拖拽激活时在 `.center-pane-body` 渲染 4 条 `EdgeSplitZone`（透明感应区）+ 当 `pendingSplitEdge.leafId === leaf.id` 时渲染 1 个 `split-preview` 线框（半窗格）。
- **DragOverlay** 悬停边缘时显示方向箭头（⇤ 分屏 / 分屏 ⇥ 等）。

#### 碰撞检测

改用纯包含性判定 `edgeAwareCollision`，优先级：**边缘条带 > 排序 Tab > leaf Tab 条 > 无落点**。

- 边缘条带四向互不重叠，指针恰中其一 → 分屏；
- Tab / leaf Tab 条：指针落在其矩形内才成为落点（支持插入位置）；
- 内容区死区/中央、分隔线、右栏 → 返回空，`over=null` → 无操作、无反馈。

**不用 `closestCorners` 兜底**：它对「指针远在中央」也会返回最近的 droppable，会把内容区中央误判为最近的边缘条带（分屏）或残留高亮，违反「中央无落点」。上一版因此缺陷（拖到下边缘误判为中央移入）被 e2e 捕获，改为纯包含性判定后根治。

#### 落点区几何

感应条带：上/下 full-width 高 30%，左/右介于其间宽 30%，中央 40%×40% 为无落点死区（用户选定的命中率/防误触平衡点）。预览线框：上/下占 full-width 高 50%，左/右占宽 50%（与实际 `ratios:[0.5,0.5]` 一致）。均仅拖拽激活时渲染（`isDragging=true`），不遮挡常态内容。

### 新增文件

- `EdgeSplitZone.tsx` —— 导出 `EdgeSplitZone`（边缘条带 droppable），id 规则 `split-edge:{leafId}:{side}`。

## 考虑过的方案

1. **中心十字（VS Code 风格）**：窗格中央显示 5 按钮十字，4 向分屏 + 中央移入。视觉清晰但需自绘十字并新设 center droppable，与「中央无操作」的简化诉求冲突。当前方案更简。
2. **内容区中央作为移入落点**：曾实现 `LeafBodyDropZone`，但用户反馈中央出现提示线框、与创建分屏手势混淆，最终移除——移入窗格统一走 Tab 条。
3. **阻止单 Tab 拖出**：与右键菜单一致，但限制灵活性。用户确认「允许，源窗格变空（对齐 VS Code）」。
4. **提示风格演进**：初版有「条带高亮 + 中央线框 + 分屏预览格」三层叠加，过于复杂被简化为「仅条带高亮」；但条带高亮面积太小（20% 带），与分屏后新窗格实际占的半窗格不匹配，用户期望「所见即所得」。最终定为：条带退化为透明感应区，预览线框（半窗格）为唯一视觉，面积 = 分屏后新窗格实际区域。

## 后果

- 新分屏从「仅工具栏/右键菜单」变为「拖拽手势也可创建」；移入窗格统一走 Tab 条，手势语义清晰无歧义。
- 预览线框「所见即所得」：线框面积 = 分屏后新窗格实际区域（半窗格），用户拖拽时即可预判分屏结果。
- 碰撞检测从 `closestCorners` 改为纯包含性判定，行为完全确定（无距离回退的意外命中）。
- 扩展 `splitPaneWithTab` 签名不改现有调用方（右键菜单），测试全部通过。
- 逻辑集中在 `SplitPane.tsx` 的 DragProvider 中，`EdgeSplitZone.tsx` 是纯组件（对齐 `SplitDivider.tsx` 风格）。

## 测试覆盖

- 单测（6 条新增）：`side:'before'` 新 leaf 前置、`side:'after'` 后置、`allowEmptySource:true` 单 Tab 源变空、`allowEmptySource + side:'before'` 组合、**跨 leaf 分屏**（拖另一 leaf 的 tab 到本 leaf 边缘）、**跨 leaf 源变空保留空 leaf**。
- 向后兼容（71 条原有全部通过）：默认无 opts 时守卫单 Tab 的行为不变。
- **E2E（`e2e/drag-tab-split.spec.ts`，7 条新增）**：用真实鼠标事件（`page.mouse`）驱动 @dnd-kit PointerSensor——
  1. 拖到右边缘 → 水平分屏，被拖 Tab 进入右侧新窗格；
  2. 拖到左边缘 → 水平分屏，被拖 Tab 进入左侧新窗格（'before' 子节点）；
  3. 单 Tab 拖到下边缘 → 垂直分屏，源窗格变空（空状态按钮）；
  4. 拖到另一窗格 **Tab 条** → 移入该窗格，源空后树回退为单 leaf；
  5. 拖到内容区**中央** → 无操作（不创建分屏、不移入、无残留高亮）；
  6. 拖到右边缘**进行中** → 预览线框精确等于 leaf 右半（left≈中位线、右边对齐 leaf 右边缘），松手后水平分屏成立；
  7. **跨窗格分屏**：先水平分屏 [左{b,c}|右{a}]，再拖 b 到右 leaf 右边缘 → 在右 leaf 处新建水平分屏 [右{a}|new{b}]，左 leaf 剩 c。
- 所有 DOM 读取限定在「含 `.tab-content` 的活跃 `.split-pane`」内（右栏 RightPanel 也用 TabBar 渲染 `.terminal-tab`，需规避选择器污染）。

## 变更记录

### 2025-07-16 — 二次修复：跨 leaf 移动后 canvas 空白（无 resize 触发则不重绘）

**症状**：3 窗格布局（左 | 右上 / 右下）下，把右下 tab 拖到左窗格下边缘分屏后，右上（未移动）
与被移动 tab 的终端内容消失（只剩光标 / 全空白）；左上（尺寸从整高变半高）正常。

**根因（e2e 实测验证）**：实例与 DOM 均未销毁——paneManager 注册表 key 不变、scrollback 完整、
WebGL 状态正常。真正问题是**渲染重绘触发缺口**：
- 终端尺寸变化（左上）→ ResizeObserver → doResize → canvas 重绘 ✓
- 终端尺寸不变（右上、被移动的 tab 尺寸相同）→ 无 resize 触发 → canvas 保留旧帧/空白 ✗

**修复（三处）**：
1. `TabContentSlot` 的 rect 同步变化时派发 `SYNC_FIT_PANES_EVENT`（位置变化也触发，不只尺寸）；
2. `XtermTerminal.doResize(force=true)` 在尺寸未变时也 `term.refresh(0, rows-1)` 强制整屏重绘
   （此前只清 RenderService 暂停标记，不实际重绘）；
3. 防御性 scrollback 还原：`acquirePane` 新建实例时从主进程取回上次 `saveTerminalBuffer`
   保存的缓冲区，mount 后重放（补上 `loadTerminalBuffer` 无调用方的缺口——若任何路径导致
   实例重建，内容也能恢复）。

**验证**：1093 单测 + 28 e2e 全量通过；test 8 增加实例层面断言（paneCount/key/scrollLen）。

### 2025-07-16 — 变更：源空窗格自动合并（不留空窗格）

**需求**：单 tab 分屏/移动后不留下空的分屏，空窗格自动合并。

**决策（用户确认）**：
1. 统一「不留空窗格」不变量：`splitPaneWithTab` 拖拽分屏（`allowEmptySource:true`）时，源 leaf
   变空即用 `removeLeafFromTree` 移除——同 leaf 自拖边缘 → 分屏取消（树回退单 leaf，Tab 留在原位）；
   跨 leaf 拖出 → 源窗格消失，其余窗格吸收空间。
2. 接受「分屏成立但布局被相邻窗格吸收」的结果。
3. 右键菜单分屏（`allowEmptySource:false`）单 Tab 守卫保持不变；`moveTabAcrossLeafs`（拖到 Tab 条
   移入）的既有「末 Tab 移走自动摘除空 leaf」逻辑本就符合该不变量，无需改动。

**实现**：`splitStore.ts` `splitPaneWithTab`：`sourceRemaining.length===0` 时不再保留空源 leaf，
改为 `newTree = removeLeafFromTree(newTree, sourceLeaf.id) ?? createLeaf()`（父链单 child 自动提升、
根全空回退空 leaf）。

**验证**：单测新增「同 leaf 分屏取消」「跨 leaf 源窗格消失」「3 窗格嵌套场景全树无空 leaf」；
e2e test 3 改为「单 tab 拖自己边缘 → 分屏取消」、test 8 改为「跨窗格分屏 + 源空合并 + keep-alive
终端实例保留」。全量 1094 单测 + 28 e2e 通过。
