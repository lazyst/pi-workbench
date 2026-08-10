# Changelog

## v1.0.9 (2026-08-11)

### 新功能

- **Git 面板从只读升级为完整 Git 工具** — 仿 VS Code Source Control 视图，支持暂存/取消暂存（文件级 + 批量）、提交（Stage All / Amend / Sign-off / 空树提交）、撤销修改（Revert / Clean）、分支管理（创建/切换/删除/重命名 + 分支选择器）、远程同步（Sync / Pull / Push / Fetch）。新增操作队列（OperationManager）控制并发、写操作进度动画、800ms 防抖实时刷新、路径穿越安全检查。

- **Git 提交历史改为可展开的「图表」交互（对齐 VS Code）** — 点击历史提交 → 展开该提交的变更文件子列表（M/A/D/R/C 状态徽章）→ 点击文件打开左右分栏的 Monaco diff 视图 tab。

- **Git diff 页面重构为左右分栏对比视图** — 使用 `@monaco-editor/react` 内置 DiffEditor（`renderSideBySide`），对齐 VS Code Diff Editor 视觉与交互。

- **Monaco 编辑器行号旁 Git 变更标记** — 编辑器行号左侧显示新增/修改的绿/红竖条（VS Code gutter decoration 风格），点击弹出该行所在 diff 的浮动弹窗（DiffPopup）。

- **Git 面板文件点击即打开编辑器** — 点击 Staged / Changes / Untracked 分组中的文件行，直接在中间区打开该文件（对齐 VS Code Source Control）。

- **tab 栏新建 pi 会话按钮 + tab 右键分屏菜单** — 分屏交互增强。

- **Monaco 编辑器体验优化** — 光标默认 block 样式 + 平滑动画；修复 TS worker「Could not find source file」报错；背景色跟随主题 `--editor-surface` 变量。

### 修复

- **Git 面板在干净仓库误显示变更** — 根因：`parseResources` 未跳过 `git status --porcelain -b` 输出的 `## branch...` 头行，`xMap['#']` 查不到值触发 `?? 'M'` 回退，把 `main` 误解析为变更文件。修复：跳过 `## ` 开头行，并修正冲突文件（UU/AA/DD）重复显示。

- **分支选择器点击分支名无法收起** — 根因：点击外部关闭用 `mousedown` 事件、分支名按钮用 `click` 事件，mousedown 先触发关闭、click 再触发 toggle 重新打开。修复：点击外部关闭 handler 排除分支名切换按钮本身，把收/展开交由 toggle 单独处理。

- **文件树底部留白回归** — 滚动到底时最后一项下方预留 28px（一行文件高度）空位，支持右键唤出空白区菜单。

---

## v1.0.8 (2026-08-11)

### 修复

- **终端：write 回调保护缺失导致 PTY 完全冻结** — 根因：`_writeProcessDataViaScheduler` 的 `term.write()` 回调未使用 `runGuardedWriteCompletionStep` 保护，当回调中的 `ackBufferer.ack()`、`resolveWrite()` 或 `onData()` 抛出异常时，异常逃逸到 xterm 的 WriteBuffer 内部，永久楔住 WriteBuffer，导致所有后续 `term.write()` 的回调永不触发，背压 ack 停止发送，主进程 inflight 持续增长超过 HighWatermark(100000) → `pty.pause()` → pi 进程 stdout 被 OS 管道阻塞 → 终端完全冻结。修复：`onWillData` 调用及 `term.write` 回调中的每一步（write-parsed/ack/resolve-write/on-data）分别用 `runGuardedWriteCompletionStep` 保护，catch 块中额外释放 `ackBufferer.ack` 和 `resolveWrite`，防止背压 inflight 永久泄漏。

### 测试

- **完善主进程测试 mock** — 在 `integratedTerminalIpc`/`splash`/`openExternal` 的 `fs` mock 中添加 `mkdirSync`，消除 `ensureAppWorkDir`/`writeConfigNow` 的 stderr 报错；`openExternal.test.ts` 改用 `child_process.exec` 替代 `shell.openExternal` 验证外部链接打开；添加 `__dirname`/`path.join` ESM 兼容处理；添加 `electron.mock` 的 `requestSingleInstanceLock`。
- **渲染层测试重构** — `App`/`CenterPane`/`SettingsPanel`/`XtermTerminal` 等测试文件统一使用 `makeApi` mock 工厂 + 更新 store 状态字段以对齐最新的分屏树架构。

---

## v1.0.7 (2026-08-08)

### 修复

- **文件树：提交后 git 状态高亮不实时取消** — 根因：FileTree 依赖 `fs:watch`（`recursive: false`）触发 git 状态刷新，但 `git commit` 只会修改 `.git/` 内部文件（HEAD/index/refs/objects），这些不是根目录的直接子项，`recursive: false` 的 watcher 探测不到。修复：订阅 `git:change` 事件（`pi.gitWatch`），git 元数据变化时即时刷新文件树 git 状态。

- **终端：分屏时终端重载导致滚动位置丢失** — 根因：分屏前直接渲染 `SplitPaneLeaf`，分屏后切换为 `SplitPaneNode`，React 树根节点类型变化导致原 leaf 全部子节点被卸载，终端实例销毁重建后 scrollback 为空。修复：始终渲染 `SplitPaneNode`，单 leaf 时包裹为 `ratios=[1]` 的单 child split node，`key={leaf.id}` 恒定使 React 复用组件，不卸载终端。

- **终端：跨工作目录切换黑屏** — 根因：`SplitPaneDragProviderInner` 在 `isActive` 切换时根节点类型在 Fragment ↔ `DragContext.Provider` 之间变化，React 卸载/重挂所有终端实例导致 canvas 黑屏。修复：保持 `DragContext.Provider > DndContext > children` 结构恒定，仅 `DragOverlay` 条件渲染。

- **终端：重构 tab 切换机制，对齐 VS Code 始终挂载策略** — 核心改动：终端始终 `display:block`，隐藏仅靠 `opacity:0`；`SessionPane/IntegratedPane` 不再调用 `setPaneActive(false)`，`RenderService` 不暂停、WebGL context 不丢失；`doResize` 增加 `clientWidth/clientHeight` 兜底重测。

- **终端：移除 `_fixTuiScrollbarWideChars` hack 修复光标错位与内容重叠** — 该 hack 注入 CUP 光标定位序列，在 pi-tui 差分渲染两帧之间触发时导致光标不同步，表现为光标不在编辑器区域、Shift+Enter 换行后内容重叠。移除 74 行 hack 代码。

---

## v1.0.6 (2026-08-08)

### 修复

- **终端：pi-tui fullscreen → regular 切换时 Shell 被误杀** — 根因：pi 进程调用 `process.stdin.pause()` + `setRawMode(false)` 时，Windows 内置 ConPTY 误杀 shell 进程，触发 node-pty exit 事件导致终端关闭。
  - 使用 node-pty 自带的 `conpty.dll`（`useConptyDll: true`），改变 `_$onProcessExit` 行为，不再调用 `_flushDataAndCleanUp` 销毁 socket，exit 事件不触发，终端保持打开。
  - 保留 `isProcessAlive(pid)` 存活校验与 `\x1b[?1049l` + `\x1b[?2004h` 序列检测作为多层防线。
  - 修复 `destroy()` 对集成终端（shell 类型）也设置 `terminating` 标记并直接调用 `onExit`，避免依赖 exit 事件可能被拦截。
  - 新增 2 个覆盖测试（模式切换误报抑制、真实退出场景）。

---

## v1.0.5 (2026-08-07)

### 修复

- **终端：pi-tui fullscreen → regular 切换时终端被误关** — 根因：Windows conpty 在处理 `\x1b[?1049l`（退出 alternate screen）时可能误关输出管道，导致 node-pty 触发假的 pty `exit` 事件（shell 进程仍存活），终端 tab 被错误关闭。
  - 移除了脆弱的 `detectPiExit` 机制——原实现依赖 shell prompt 的 OSC 133 D 间接信号判断 pi 退出，该序列易在多种场景下误判（切换 TUI 模式时 conpty 重发主缓冲区、消息内容嵌入等）。终端 tab 生命周期改为跟随 shell 进程：pi 退出后 tab 保持打开，仅当 shell 真正退出或用户主动终止时才关闭。
  - 抑制 conpty 误报的 pty `exit` 事件——在 data handler 中检测 `\x1b[?1049l` 序列并记录时间戳，若 pty `exit` 紧跟其后（1 秒窗口内）视为 conpty 误报并忽略。
  - 新增 3 个 `UnifiedTerminalPool` 覆盖测试。

### 技术

- 新增 `UnifiedTerminalPool` conpty 误报抑制相关测试。

---

## v1.0.4 (2026-08-07)

### 修复

- **终端：pi-tui fullscreen 滚动条在 emoji 行占 2 列** — 根因：xterm 的 Unicode 宽度表未激活为 11，Unicode11Addon 仅注册版本提供者，xterm 默认使用 Unicode 6.3 导致 emoji 被视为宽度 1 的普通字符，`_fixTuiScrollbarWideChars` 检测 `getWidth() === 0` 永远不匹配。修复：激活 Unicode 11 宽度表（`term.unicode.activeVersion = '11'`），用 `term.write` 包装替代事件触发确保每次写后执行修复，改进检测逻辑覆盖 `getWidth() === 0/2` 两种场景。
- **终端：xterm overview ruler z-index 覆盖问题** — 修复 overview ruler 被其他元素遮挡的问题，改用裸选择器 + `!important` 确保 z-index 优先级。

### 特性

- **终端设置：Custom Glyphs 与 GPU Acceleration** — 设置面板新增「渲染」区域，支持运行时切换自定义字形开关（`customGlyphs`）与 GPU 加速模式（`gpuAcceleration`：auto/on/off），对齐 VS Code 终端设置。

### 技术

- 添加 `XtermTerminal` 与 `SettingsPanel` 覆盖测试。

---

## v1.0.3 (2026-03-27)

### 修复
- **终端：pi-tui 全屏 TUI 宽字符滚动条错位** — 在 xterm 写完成后检测最右列 null continuation cell（宽字符延伸），仅对含宽字符的行写入校正序列替换为单列空格，消除滚动条 2 列宽偏移。对齐 VS Code 的 buffer 后处理方案。
- **终端：pi-tui 全屏 TUI 鼠标滚轮不滚动** — 在进入 alternate screen 时自动激活 xterm mouse tracking（`\x1b[?1003h` + `\x1b[?1006h`），使 pi-tui 能接收鼠标滚轮事件滚动消息区。
- **终端：/name 命令后侧边栏会话名不更新** — 修复会话名变更后侧边栏未同步更新的问题。
- **终端：阻止 pi-tui 全屏 TUI 渲染时终端视口跳动** — 抑制差分渲染与视口贴底的冲突导致的跳动。

### 终端渲染重构（6 阶段 14 项）

- **写入路径对齐 VS Code** — 升级 xterm 6.1.0-beta.292，重构写入管道完全对齐 VS Code 的 `_writeProcessData` 路径，消除自研 hack（5ms 行切片、亚像素阈值等），修复滚动条白边。
- **防闪烁优化** — 重写终端渲染管线，解决流式输出闪烁、光标抖动、滚动跳动等 14 项问题。
- **写入管道优化** — 启用 parse-clock pacer + 渲染端二次聚合器（5ms 时间窗 + 64KB 上限），双层减少 IPC 消息量。
- **WebGL 渲染器可重试** — 移除永久锁定，上下文丢失后可自动重建 WebGL 上下文。
- **WebGL 去同步检测器** — 检测 WebGL 渲染器与 xterm 缓冲区之间的去同步状态并在恢复时自动修复。
- **WebGL 附加失败防抖锁** — 防止 WebGL 附加失败时高频重试。
- **DOM 事件驱动的滚动意图跟踪** — 精确跟踪用户滚动意图，避免流式输出时意外跳转。
- **结构重放协调器** — 清屏/重放时保护滚动意图，确保视口位置精确恢复到用户阅读位置。
- **稳定硬件光标** — 6 项改进对齐 Orca 方案，消除光标闪烁/抖动。
- **滚动意图核心 + 重建保护** — 滚动意图与 xterm 集成，终端重建时恢复滚动位置。
- **滚动意图跟踪 + 可见性记忆 + 渲染暂停修复** — 完整终端滚动状态管理，标签页切换后恢复滚动位置。

### 其他
- **会话查看页面** — 添加复制文件路径/会话ID按钮及 toast 提示。
- **用 @xterm/addon-web-links 替换自定义文件路径链接检测** — 消除安全对话框，使用 Ctrl+click 打开链接。
- **Pi 扩展 spinner + OSC 标题提取 + 侧效果处理器 + 渲染帧同步** — 优化终端渲染稳定性。
- 删除计划文件 `plan.md`。

---

## v1.0.2 (2026-03-18)

### 修复
- 修复打包构建后终端始终使用暗色主题的问题。
- 其他稳定性修复。

---

## v1.0.1 (2026-03-16)

- 版本号更新。

---

## v1.0.0 (2026-03-16)

初始发布：pi-workbench 桌面 IDE，包装 pi CLI 的实时终端 UI。