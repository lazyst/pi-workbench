# Architecture Optimization — pi-workbench

Status: `ready-for-agent`

## Problem Statement

pi-workbench 的代码库经过多轮功能迭代，积累了一些架构债务（architectural debt）：
主进程入口文件（`main/index.ts`）达到 1568 行且零测试覆盖；3 个 PTY 池中 2 个已废弃但仍留存在代码库中造成混淆；
5 个工具函数在 2 个文件中完全重复；tab 切换逻辑在 store 中重复 6 次；App.tsx 持有 ~20 个 useState 导致状态流碎片化；
PTY 所有权追踪分散在 4 个数据结构中；IPC 通道命名存在不一致。

这些债务虽然不影响当前功能，但降低了代码库的可测试性、可维护性和 AI 可导航性。

## Solution

通过 6 个独立的深化（deepening）操作清理架构债务。每个操作不改变任何外部行为，只改善模块结构。

## User Stories

1. 作为开发者，我希望 `main/index.ts` 按领域拆分为 handler 模块，以便理解和修改 IPC 逻辑时无需在 1568 行文件中搜索。
2. 作为开发者，我希望 watcher 注册模式被提取为可复用类，以便新增 watcher 类型时无需复制粘贴。
3. 作为开发者，我希望废弃的 `SessionPool` 和 `IntegratedTerminalPool` 被清理，以便不再困惑"到底用哪个池"。
4. 作为开发者，我希望重复的 5 个工具函数被提取到共享模块，以便修改时只需改一处。
5. 作为开发者，我希望 tab 切换逻辑被提取为纯函数，以便测试和修改 tab 切换行为时无需同步 6 个 action。
6. 作为开发者，我希望 App.tsx 的碎片化状态被提取为自定义 hooks，以便状态流更可追踪。
7. 作为开发者，我希望 PTY 所有权追踪被合并为单一注册表，以便理解 `/new` 命令数据流时无需跨越 4 个数据结构。
8. 作为开发者，我希望 IPC 通道命名被统一，以便减少认知摩擦。

## Implementation Decisions

| 决策 | 对应 Issue |
|------|-----------|
| Decision 1 (Handler 模块拆分) + Decision 2 (ReferenceCountedWatcher) | 候选① |
| Decision 3 (sessionUtils.ts) + Decision 4 (IPtyLike 类型迁移) + Decision 5 (废弃文件清理) | 候选② |
| Decision 6 (selectNextTabOnClose 纯函数) | 候选③ |
| Decision 7 (App.tsx Hooks 提取) | 候选④ |
| Decision 8 (PtyOwnershipRegistry) | 候选⑤ |
| Decision 9 (IPC 通道命名统一) | 候选⑥ |

### Decision 1: Handler 模块拆分

`main/index.ts` 中的 IPC handler 注册按领域提取到 `src/main/handlers/` 目录下，每个模块导出一个 register 函数：

```
src/main/handlers/
  terminalHandlers.ts    — registerTerminalHandlers(ipcMain, win, unifiedPool, pushTerminalList)
  sessionHandlers.ts     — registerSessionHandlers(ipcMain, win, sessionFileManager, unifiedPool)
  fsHandlers.ts          — registerFsHandlers(ipcMain, win, ...fsBridge fns)
  gitHandlers.ts         — registerGitHandlers(ipcMain, win, ...gitBridge fns)
  configHandlers.ts      — registerConfigHandlers(ipcMain, win, getConfig, setConfig)
  piToolHandlers.ts      — registerPiToolHandlers(ipcMain, win, piAgentDir)
  updateHandlers.ts      — registerUpdateHandlers(ipcMain, win, ...)
```

`main/index.ts` 的 `createWindow()` 函数末尾调用这些 register 函数，替代当前的 inline 注册。

### Decision 2: ReferenceCountedWatcher

提取 `src/main/shared/ReferenceCountedWatcher.ts`：

```typescript
class ReferenceCountedWatcher<TKey = string> {
  watch(key: TKey, start: (key: TKey) => () => void): void
  unwatch(key: TKey): void
  dispose(): void
}
```

替换 `dirWatchers`、`fileWatchers`、`gitWatchers` 三个几乎相同的引用计数 Map。

### Decision 3: sessionUtils.ts

提取 `src/main/sessionUtils.ts`，包含 5 个纯函数：

- `decodeCwd(encoded: string): string`
- `formatTimestamp(date: Date): string`
- `readSessionCwd(sessionDir: string, filePath: string): string`
- `readSessionName(sessionDir: string, filePath: string): string`
- `readGroupCwd(sessionDir: string, filePath: string): string`

从 `sessionFileManager.ts` 和 `sessionPool.ts` 中删除重复实现，改为导入共享模块。

### Decision 4: IPtyLike 类型迁移

`IPtyLike` 接口从 `sessionPool.ts` 迁移到 `src/main/types.ts`（或 `backpressure.ts` 如果更合适）。

### Decision 5: 废弃文件清理

- `integratedTerminalPool.ts`：删除（仅在测试文件中被引用，测试保留但改为引用 `UnifiedTerminalPool`）
- `sessionPool.ts`：删除 `SessionPool` 类（类型 `IPtyLike` 已迁移），保留 `SessionStatus`/`SessionInfo`/`SessionGroup`（如果被其他地方引用则迁移）

### Decision 6: selectNextTabOnClose 纯函数

在 `src/renderer/src/store/tabStore.ts` 中（或提取为 `src/renderer/src/store/tabUtils.ts`）：

```typescript
function selectNextTabOnClose(
  tabs: Tab[],
  activeTabId: string | null,
  cwdTabHistory: Record<string, string[]>,
  cwd: string
): { nextTabId: string | null; nextCwdActiveTab: string | null }
```

替换 `closeTab`、`hideTab`、`setHidden`、`removeSessionTab`、`removeTerminalTab`、`closeCenterTab` 中的重复模式。

> **注意**：`closeCenterTab` 内部有两个分支路径都包含 select-next-tab 模式，`selectNextTabOnClose` 需要覆盖这两种情况。

### Decision 7: App.tsx Hooks 提取

将 App.tsx 中的状态按职责分组提取为 3 个 hooks：

- `useSidebarState` — 侧边栏相关状态（disk, pinned, addedDirs, appWorkDir, sidebarWidth, collapsedGroups, liveUnsaved, virtualSessions）
- `useSessionStatus` — 会话状态追踪（statusMap, liveToDisk, ptyOwnersRef）
- `usePanelLayout` — 面板布局（sidebarWidth, rightPanelWidth, sidebarCollapsed, rightPanelCollapsed）

每个 hook 内部管理自己的 IPC 订阅和清理。

> **注意**：`_virtualToPty` 作为模块级变量保留在 App.tsx 中，不从 App.tsx 移入 hooks，因为它是模块级变量被多个函数和回调共享。`useSessionStatus` hook 通过参数或 ref 引用它。

### Decision 8: PtyOwnershipRegistry

在 `src/main/ptyOwnershipRegistry.ts` 中：

```typescript
class PtyOwnershipRegistry {
  private ptyToOwner = new Map<string, string>()
  private ptyRoutes = new Map<string, Set<string>>()
  private virtualToPty = new Map<string, string>()

  setOwner(ptyId: string, ownerKey: string): void
  getOwner(ptyId: string): string | undefined
  addRoute(ptyId: string, subKey: string): void
  getRoutes(ptyId: string): Set<string>
  remove(ptyId: string): string[]
  resolveVirtual(virtualKey: string): string | undefined
  setVirtual(virtualKey: string, ptyId: string): void
  deleteVirtual(virtualKey: string): void
}
```

替换 renderer 端的 `ptyOwnersRef` + `_virtualToPty` 和 main 端的 `dataRoutes` + `ptyOwners`。

> **API 语义**：`setOwner` 为 1:1 映射（ptyId → ownerKey），`addRoute` 为 1:N 映射（ptyId → Set<subKey>）。两者服务于不同的查询场景，不可互换。
> **IPC 查询通道**：renderer 端通过 `session:query-owner` 通道查询 PTY 的所有者。

### Decision 9: IPC 通道命名统一

- `term:data` → `terminal:data`
- `term:exit` → `terminal:exit`
- `term:list` → `terminal:list`

涉及文件：`src/preload/index.ts`、`src/main/index.ts`、`src/renderer/src/ipc.ts`、`src/renderer/src/App.tsx`、`src/renderer/src/components/IntegratedPane.tsx`、`src/renderer/src/components/XtermTerminal.ts` 等。

> **注意**：`terminal:list` 已作为 `ipcMain.handle` 存在（invoke 模式），rename 后 `terminal:list` 将同时作为 invoke 和 push 通道，两者不冲突但需在代码中注明用途。

## Testing Decisions

- **好的测试**：只测试外部行为，不测试实现细节。对于纯函数（sessionUtils, selectNextTabOnClose, PtyOwnershipRegistry），测试输入/输出对。对于 handler 模块，使用 mock ipcMain 验证 handler 被正确注册。
- **测试的模块**：
  - `sessionUtils.ts` — 纯函数测试（现有先例：`config.test.ts`）
  - `selectNextTabOnClose` — 纯函数测试（现有先例：`tabStore.test.ts`）
  - `PtyOwnershipRegistry` — 类方法测试（现有先例：`sessionPool.test.ts`）
  - handler 模块 — 集成测试（使用 mock ipcMain）
  - `ReferenceCountedWatcher` — 类方法测试
- **不测试的模块**：纯重命名（IPC 通道命名）不新增测试，靠 grep 确保完整性。

## Out of Scope

- 将 Zustand 扩展到更多状态（App.tsx hooks 使用的是本地 useState，不是 Zustand 迁移）
- 引入新的测试框架或工具
- 修改任何外部行为或 API 契约
- 重构 `UnifiedTerminalPool` 内部实现

## Further Notes

- 每个候选可独立合并，无需一次性完成
- 候选①和②是 Strong 推荐，建议先做
- 候选⑥（IPC 命名）是纯重命名，可能与其他候选产生冲突，建议最后做

### 跨候选依赖关系

- **候选① → 候选⑤**：候选①（Handler 拆分）应先于候选⑤（PTY 所有权合并），因为两者都修改 `main/index.ts`，先拆分能减少冲突半径
- **候选① → 候选②**：候选②需要基于 handler 模块结构操作，候选①先拆分 handler 后候选②的清理更清晰
- **候选④ → 候选⑤**：候选⑤需要修改 App.tsx 中的 PTY 所有权代码，候选④先提取 hooks 后候选⑤的替换范围更明确
- **候选⑥ → 所有其他候选**：候选⑥是纯重命名，可能与其他候选产生冲突，应在其他所有候选完成后最后实施
- **候选③**：无外部依赖，可独立进行

### 测试迁移策略

删除 `SessionPool` 类后，相关测试的迁移方式：
- `sessionPool.test.ts` 和 `sessionPool.realpty.test.ts` 中与 `SessionPool` 类相关的测试 → 迁移到 `UnifiedTerminalPool` 的测试文件（`unifiedTerminalPool.test.ts` 或新建 `unifiedTerminalPool.realpty.test.ts`）
- 与工具函数（`decodeCwd`、`formatTimestamp` 等）相关的测试 → 迁移到 `sessionUtils.test.ts`