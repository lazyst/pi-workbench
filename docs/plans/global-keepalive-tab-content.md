# 全局 keep-alive：终端 tab 跨 leaf 移动不丢内容

## 问题

终端 tab 跨 leaf 移动（拖到另一窗格 Tab 条移入 / 拖到另一窗格边缘分屏）时，
**XtermTerminal 实例被销毁重建，scrollback 历史内容丢失**。

### 根因

- `SplitPaneLeaf` 在自己的 `.center-pane-body` 下 `leaf.tabs.map(<TabContent key={t.id}>)`
  渲染——**per-leaf keep-alive**。
- 跨 leaf 移动：tab.id 不变，但 React 父节点（leaf 的 div）变了 → 源 leaf 的 TabContent
  **unmount** → `IntegratedPane` effect cleanup → `releasePane(terminalId)` 销毁
  XtermTerminal（canvas/WebGL/scrollback 全释放）。
- 目标 leaf 新 `IntegratedPane` mount → `acquirePane` 查 `panes` Map 已空 → `new XtermTerminal`
  空实例。cleanup 前虽 `saveTerminalBuffer` 存了 buffer，但 `loadTerminalBuffer` 全代码
  **无调用方**，scrollback 不恢复。
- session tab 不受影响：内容从 jsonl 重新加载，"看起来没丢"；只有终端的内存 scrollback 丢。

## 方案（B：全局 keep-alive 容器）

把 TabContent 从 per-leaf 渲染提升到**每个 cwd 一个全局 `TabContentHost`**，用
React `createPortal` 把每个 TabContent 投射到其**所属 leaf 的 body ref**。

- TabContent 挂在 host 下（公共父，`key=tab.id` 稳定）→ 跨 leaf 移动只改 portal target
  （leaf body），**不换 React 父节点 → 不 unmount → IntegratedPane 不 cleanup →
  XtermTerminal 实例保留**。
- portal target 变化时 DOM **reparent（不 remount）**，xterm canvas 节点移到新 host；
  尺寸变化由 `IntegratedPane` 的 ResizeObserver / active effect refit 兜底。

## 实现

### DragContext

- 新增 `registerLeafBody(leafId, el)`：leaf 的 `.center-pane-body` 用 ref 回调注册/注销。
- DragProvider 内 `leafBodyRefs = useRef<Map<string, HTMLElement>>(new Map())`，
  ref 变化后 `forceUpdate` 触发 host 重渲染（portal target 更新）。

### SplitPaneDragProvider

- 收 `tree` + rest props（供 host 渲染 TabContent）。
- `collectLeafTabs(tree)`：前序遍历收集 `{ leafId, tab, activeTabId }`（含 hidden，保持原顺序）。
- 在 `DndContext` 内、`children`（SplitPaneNode）之后渲染 `TabContentHost`（覆盖层）——
  见下方「最终架构：rect-sync」；每个 tab 一个 `TabContentSlot`。

### TabContentHost / TabContentSlot（最终架构：rect-sync）

> ⚠️ React 19 的 `updatePortal` 在 portal 容器变化（`containerInfo` 不等）时直接新建
> fiber → 旧内容卸载。因此**不能用「改投 leaf body」迁移**（初版的 fallback 方案失败：
> 旧 leaf 随树重构卸载时连带销毁 portal 内容，即使换提交顺序也不行）。

最终实现：

- `TabContentHost` 渲染一个 `position:absolute; inset:0` 的覆盖层 `.tab-content-host`
  （`z-index:0`，低于边缘条带 z5/预览 z6；`pointer-events:none`），覆盖整个 split pane。
- 每个 tab 一个 `TabContentSlot`（key=tab.id）：
  - portal **恒定**投射到自身的 `.tab-content-slot` div（React 19 下容器不变 → 零重挂载
    → 终端实例保留）。
  - slot div 用 CSS 绝对定位覆盖到所属 leaf 内容区矩形：`getBoundingClientRect` 计算
    `left/top/width/height`（相对覆盖层），`ResizeObserver` 跟踪尺寸变化（分栏拖拽、
    窗口缩放、分屏重排）。
  - leaf body 可能随树重构被重建（leafId 不变但容器换）→ 把 `body` 纳入 effect deps，
    重建后重新同步。
- **不做任何 React 之外的 DOM 移动**（纯 DOM appendChild 移动 slot 会导致 React 的
  insertBefore 崩溃：`NotFoundError: node before which... is not a child`）。

### SplitPaneLeaf

- `.center-pane-body` 加 ref，经 `useLayoutEffect` 调用 `registerLeafBody(leaf.id, body)`
  （挂载注册 / 卸载注销）。
- **移除** `leaf.tabs.map(<TabContent>)`（改由 host 覆盖层投射）。
- 保留 edge zones + empty state（仍在 leaf body 内，z 高于覆盖层）。

### SplitPane

- 把 `tree` + rest 透传给 `SplitPaneDragProvider`（host 需要）。
- `.split-pane` 加 `position: relative`（覆盖层的定位基准）。

## 不变量（必须保持）

1. **切 cwd 不黑屏**：`SplitPaneDragProvider` 恒定返回
   `DragContext.Provider > DndContext > children`。host 在 DndContext 内、children 之后，
   不改变根结构。所有 cwd 的 SplitPane 仍常挂（opacity 切换）。
2. **TabContent memo 隔离**：`tabContentPropsEqual` 不变，未变 tab 跳过重渲染。
3. **多 leaf 多 active**：每个 leaf 的 active tab 都 `active=true`（各自可见）。
4. **closeTab 正常销毁**：tab 从 store 移除 → host tabEntries 去掉 → TabContent unmount
   → `releasePane`。pty 杀仍由点 × 的 `destroyTerminal` 负责。

## 风险

- **首帧 slot 无 rect**：slot 首次 render 时 leaf body 尚未注册 → 返回 null；leaf body
  `registerLeafBody` 的 `forceUpdate` 触发重渲染后补上（可见延迟 ≤ 1 帧）。
- **xterm 覆盖层 refit**：slot 尺寸 = leaf 内容区矩形，尺寸变化经 ResizeObserver 同步 →
  xterm 自带 RO 对 `.terminal-host` refit；尺寸不变时 active effect refit 兜底。
- **rect 同步成本**：每个 tab 一个 ResizeObserver 观察其 leaf body，仅在 leafId/body 变化
  或 body 尺寸变化时 setState（值相等跳过 → 无重渲染循环）。
- **无 resize 触发 → canvas 空白**（2025-07-16 修复）：tab 移动到新 leaf 但尺寸未变时，
  ResizeObserver 不触发，canvas 无重绘。在硬件 GPU 环境下表现为仅剩光标/全空白。
  修复：rect 同步变化时派发 SYNC_FIT_PANES_EVENT 触发全量 fit + doResize 在 force 时
  即使尺寸未变也 `term.refresh` 强制整屏重绘。
- **防御性 scrollback 还原**（2025-07-16）：`acquirePane` 新建实例时从主进程取回
  saveTerminalBuffer 保存的缓冲区，mount 后重放（补上 loadTerminalBuffer 无调用方的缺口）。
- **栈叠**：覆盖层 z-index:0 低于边缘条带(5)/预览(6)，拖拽感应不受阻；pointer-events:none
  不拦截，active tab 内容自身 pointer-events:auto。
- **e2e 结构变化**：`.tab-content` 不再 DOM 嵌套于 leaf 内 → `splitInfo.draggedIndex` 改
  为位置判定（中心点落在哪个 child 矩形）。

## 测试

- 新增 e2e（drag-tab-split.spec.ts 测试 8）：终端 tab 跨 leaf 移动（拖到右边缘分屏）后
  XtermTerminal 实例保留——在 `.terminal-host` DOM 节点上打 JS 标记，分屏后该节点仍存活
  且带标记（reparent 保留、重建丢失），并定位到新 leaf 内容区。
  - fake-pi 模式下 xterm 不渲染 `.xterm-rows`，无法直接读 scrollback；DOM 标记法直接验证
    「未卸载」机制（实例不销毁 ⇒ scrollback 必然保留）。
- 全量 e2e（28 条：20 既有 + 8 drag-tab-split）+ 单测（1093 条）全部通过。
- `tsc --noEmit`。
