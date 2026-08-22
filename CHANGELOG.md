# Changelog

## v1.4.0 (2026-08-22)

### 新功能

- **文件树点击高亮保持 + Ctrl/⌘ 多选 + Shift 范围选择** — 对齐 VS Code Explorer 交互：单击行保持高亮并打开/展开目录，Ctrl/⌘ 点击切换多选（不打开），Shift 点击从锚点做连续范围选择（可跨层级）；焦点竖条与选中集分离，空白点击 / 切换工作目录时重置选中。

- **新建文件后立即在编辑器打开并高亮** — 文件树新建文件成功后立即创建编辑器 tab 并高亮选中该行；新建目录仅高亮不打开。

- **文件树删除撤销（Ctrl+Z）** — 删除文件/目录前将内容快照到内存（上限 50MB，超限仍可删除但不可撤销），文件树聚焦时按 Ctrl/Cmd+Z 依次恢复（连续多次删除可逐次撤销，后删先恢复，对齐 VS Code）；恢复后自动刷新父目录并高亮恢复项。删除确认弹窗文案同步更新为「删除后可用 Ctrl+Z 撤销」。

### 修复

- **打开的文件被删除时不再打印 ENOENT 噪音日志** — `fs:readFile` 对已不存在的文件返回 `notFound` 业务结果而非抛错，消除主进程 `Error occurred in handler for 'fs:readFile'` 日志；对应 tab 标题红字+删除线标记，内容区保留旧内容可继续编辑，保存即以原内容重建文件，文件恢复后标记自动清除。

- **外部文件变更时实时刷新编辑器内容** — 代码/富文本编辑器订阅文件变更事件，外部修改后自动重载内容（对齐 VS Code FileWatcher）。

## v1.3.1 (2026-08-19)

### 工程

- **上线 GitHub Actions 自动构建发布流程** — push `v*` tag 时在 `windows-latest` runner 自动构建 Windows 安装包并发布到对应 tag 的 GitHub Release，无需本地构建。新增 `.github/workflows/release.yml` 与 `scripts/extract-release-notes.mjs`（从 CHANGELOG 提取版本说明作为 release 正文）。CI 构建显式跳过 authenticode 签名（`CSC_IDENTITY_AUTO_DISCOVERY=false`）。

- **同步 pnpm-lock.yaml** — package.json 此前移除的 `@radix-ui/react-context-menu` / `@tiptap/extension-underline` / `png-to-ico` 三个依赖未同步到 lockfile，导致 CI `--frozen-lockfile` 安装失败。已重新生成 lockfile。

## v1.3.0 (2026-08-19)

### 新功能

- **体验优化三件套** — 文件树展开记忆 / 点击 tab 聚焦 / markdown 本地图片显示。
  - **文件树展开记忆**：切换工作目录再切回时恢复之前的目录展开状态（按 root 记忆）。
  - **点击 tab 聚焦内容区**：点击终端/编辑器/富文本 tab 后键盘焦点立即落到内容区（对齐 VS Code）。
  - **Markdown 本地图片显示**：pi-local 自定义协议使 dev（`http://localhost`）与 prod（`file://`）模式下 markdown 相对路径图片均可加载，修复 dev 模式 `file://` 被 Chromium 阻止导致预览/富文本图片不显示的问题。

- **文件树打开文件即聚焦内容区** — PreviewTab 新增激活聚焦 effect，覆盖文件树打开新文件（loading→code）与激活已有 tab（active false→true）两条路径；Monaco/TipTap DOM 异步就绪用短轮询（≤1s）兜底。提取共享 `focusEditableIn` 工具（`lib/focusEditable.ts`），消除 SplitPane 与 PreviewTab 中重复的 selector + 聚焦逻辑。

- **会话列表一行显示（名称+相对时间）** — 侧边栏会话列表改为名称靠左、相对时间靠右的单行布局。新增 `formatRelativeTime` 工具函数，将 UTC 时间戳转为「分钟」「小时」「天」三种单位（不带「前」字）。名称过长省略号截断，时间靠右不被挤压，保持始终可见。

### 修复

- **文件树删除确认后弹窗立即关闭** — `confirmDeleteNow` 先捕获目标并立即关闭弹窗/清空选区，删除循环移入后台 IIFE，避免大目录删除时 UI 阻塞。父目录刷新去重后统一执行，避免每删一项就触发全量重拉和 git status 刷新。

- **e2e 测试使用 fake-pi 驱动，注册 addedDirs 使会话可见** — 各 spec 先用 `pi.setConfig` 注册会话 cwd 为已添加目录再 reload，使侧边栏正确显示临时目录下的会话。resolvePi 支持 `PI_DESKTOP_FAKE=1`：用 node 直接运行 `fake-pi.mjs`，e2e 不再依赖真实 pi 可执行文件。playwright.config 设 `workers=1`，规避 Electron 单实例锁导致并行 worker 撞锁。

- **修复全部类型检查错误（pnpm typecheck 零告警）** — renderer: fsReadFile 返回类型补 `isDirectory`（对齐主进程实际返回）；theme.ts 类型谓词泛型约束 `T extends string`。main: tsconfig.node.json 补 `vitest/globals`；node-pty v1.x 类型缺口提取 `spawnPty` 统一补齐；sessionFileManager 修正 parent 隐式 any。tests: 适配 splitStore 重构（tabs→cwdTrees）、MockPty/_cbs 类型、`vi.mocked` 替代双重断言等。75 个测试文件 / 1041 个测试全部通过。

### 文档

- 在 README 中添加 pi-workbench 界面截图。

## v1.2.1 (2026-08-13)

### 变更

- **移除应用内自动下载更新功能** — 设置面板的「版本更新」不再提供下载进度条、取消、安装按钮；发现新版本时只显示「前往 GitHub 下载」按钮，点击后在系统浏览器打开 release 页面，由用户自行下载安装包运行升级。
  - 动因：应用内构造的下载 URL 与 GitHub 实际存储的 asset 名不匹配（空格 vs 点），导致下载 404；与其维护脆弱的 asset 命名约定，不如直接跳转 release 页面，更稳定也更简单。
  - 移除范围：主进程 `downloadUpdate` / `cancelDownload` / `installUpdate` / 资产筛选与 URL 构造逻辑、`update:download` / `update:cancel-download` / `update:install` / `update:download-progress` IPC 通道、preload bridge 对应 API、渲染进程下载进度 UI 与订阅、`UpdateProgress` / `ReleaseAsset` 类型、下载进度条 CSS。
  - 保留：版本检查（`checkForUpdate` / `getUpdateStatus` / `getCurrentVersion`）与跳转 release 页面能力。

### 修复

- **侧边栏混合斜杠路径下会话不显示** — 历史配置可能写入混合分隔符路径（如 `D:\tmp/pi-test`），而会话文件 cwd 由 pi 写为标准反斜杠形式，两者字符串不等导致会话被 `visibleDirs` 过滤掉。修复：`addedDirs` 写入与加载时统一 `path.normalize` + 去空 + 去重，并自愈写回历史配置。

- **扩展管理 7 项 bug 修复** —
  - 扩展列表同名去重（启用优先），消除双显。
  - `pi-desktop-sync` 标记为系统内置扩展，界面不可禁用/删除。
  - enable/disable 时 rename 目标已存在不再崩溃，改为安全清理。
  - 补充 `settings.json` 中 `extensions` 字段与项目级 `.pi/extensions/` 扩展的扫描与管理。
  - enable package 用 `getPackageSourceString` 统一判断，避免对象形式重复条目。
  - delete package 无论是否从 settings 移除都清理 `disabledExtensions` 残留。
  - 新增 `isSafeLocalName` / `isInsideLocalExtDir` 路径校验，防止 path traversal。

- **会话查看器错误显示全部分叉** — 会话内容查看器未按 `parentId` 链回溯当前分支，导致显示全部对话而非当前分支。修复：按 parentId 链回溯当前分支，只显示当前对话链路。

### 重构与清理

- **分屏 store 大幅瘦身（splitStore 1882 → 1258 行，净减 624 行）** — 提取 `upsertTab` / `closeEmptyLeaf` / `updateLeaf` / `findTargetLeaf` 等助手统一重复样板；删除 `resolveLeaf*` / `createTree` 转发包装 / `iterateLeaves` 重复生成器等死代码；`closeCenterTab` 两个逐字相同的 if/else 合并为一条路径；将运行时被 `as any` 注入的 `activeTabId` 正式写入接口消除类型谎言。

- **Skills 管理移除 npx skills 依赖** — 改为直接读写 `~/.agents/.skill-lock.json`（`readSkillSources` / `removeSkillFromLock`），删除 `refreshSkillSourceCache` 状态缓存与 `execSync` 依赖；修复 `findSkillRoot` 两阶段扫描在跨 root 残留禁用副本时误判为已禁用的 bug。

- **清理死代码与冗余导出** — 删除 5 个未使用文件（`MonacoDiffEditor` / `mouse-hide-while-typing` / `stable-fit` / `terminal-renderer-policy` / `terminal-webgl-atlas-recovery`）；解除 terminal-registry 对 WebGL 图集恢复的死调用链；删除误提交的 `null` 文件并加入 gitignore；移除未用依赖 `@radix-ui/react-context-menu` / `@tiptap/extension-underline` / `png-to-ico`。

- **渲染进程功能视图模块简化** — `MonacoCodeEditor` / `DiffPopup` / `SideBySideDiffView` 多处嵌套三元改查表（`LINE_META` / `CELL` 背景色）；`PiExtensionsManager` / `PiSkillsManager` 三段重复 try/catch 提取为 `runWithReload`；`SettingsPanel` 8 路嵌套三元改 switch、8 个重复导航按钮抽为 `NAV_ITEMS` 列表；`FileTree` 提取 `renderRow` / `computeBubble` 纯函数，删除无调用的死方法。

- **终端模块代码简化** — `XtermTerminal` 抽取 `readConfig` 助手 + 5 个归一化器，16 个 `getXxx()` 收敛为单行声明；`terminalChannel.ts` 提取 `TerminalChannelBase` 基类统一 `onData`/`onExit` 订阅；移除数据热路径上的 `console.log`（主进程卡顿潜在诱因）；`terminalHandlers.ts` 提取 `createAndList` 消除 3 份重复 try/catch。

- **主进程与 preload 简化** — `fsBridge.readFile` 合并逻辑相同的 `TEXT_EXTS` 分支；`config` 提取 `clampNumber` 合并 8 个结构相同的 clamp 函数；7 个 handler 消除冗余 `async/await` 包装；preload 提取 `subscribe` 助手收敛 13 个 `on*` 订阅样板，跨文件类型提取到 `types.ts`；修正 `checkUpdate` 返回类型漏写 `assets` 的漂移。

- **会话内容视图落地三段式布局** — `SessionContentView` 改为用户气泡 + Process 折叠（默认收起）+ Pi 回复三段式；提取 `tryParseJson` 统一 JSON 解析回退、`toggleOnKey` 高阶函数消除三处重复 `onKeyDown`；`SessionMarkdownRenderer` 包裹 `memo` 避免不必要重渲染。

- **杂项重构** — `piToolHandlers` 提取 6 个助手函数（`settingsPathFor` / `getMcpConfigFiles` / `scanSkillDir` / `disableSkillByName` / `removeSkillDirs` / `removePackageFromSettings`）；`index.ts` 提取 `sendDataToTerminal` 消除 3 次重复数据路由、提升 `openUrlInExternal` / `unescapeField` 到模块级；`updateChecker` 提取 `formatError` 消除嵌套三元；池暴露 `debugSnapshot()` 只读调试接口，`reconcile` 改用 `fs.promises` 异步 I/O 避免阻塞主进程。

## v1.2.0 (2026-08-12)

### 新功能

- **终端链接：Ctrl+左键在系统默认浏览器打开（修复弹窗回归）** — 修复终端内 http/https 链接点击弹出 xterm 原生 confirm() 确认框、且普通左键即触发的问题。
  - 根因：pi 会话输出的 Markdown 链接以 OSC 8 超链接序列渲染，此前删除 `linkHandler` 导致 xterm 回退到内置默认 handler（`confirm("Do you want to navigate to ...")` + `window.open`）。
  - 修复：恢复 `linkHandler`（处理 OSC 8 超链接）并与 WebLinksAddon（处理普通文本 URL）统一到同一套逻辑——仅 **Ctrl/Cmd+左键** 才激活，走 `pi.openExternal`（主进程 `child_process.exec` 在系统默认浏览器打开，无对话框）。
  - hover 链接时显示「ctrl+左键 打开链接」工具提示（复用 `.terminal-link-tooltip` CSS 类），移出后自动消失。
  - 支持 `file://` 链接：Ctrl+左键调用系统默认程序打开本地文件。
  - 抽取 `_handleLinkActivate` / `_showLinkTooltip` / `_hideLinkTooltip` 三个私有方法，两条链接路径（OSC 8 + 普通 URL）共用，去除原先 WebLinksAddon 与 linkHandler 间重复的实现。

- **文件树目录右键「添加为工作目录」** — 在右侧栏文件树的目录右键菜单中新增「添加为工作目录」，点击后把该目录的绝对路径加入左侧侧边栏的工作目录分组（含无会话的空分组），并持久化到 config `addedDirs`。
  - 去重：目标目录已在左侧显示（含「应用工作目录」，即 `visibleDirs`）时静默忽略，不重复添加、不弹提示。
  - 成功添加后弹出 Toast「已添加工作目录：<目录名>」。
  - `useSidebarState` 新增按路径添加的 `handleAddDirectory`，原系统对话框选择的 `handlePickDirectory` 复用同一逻辑。


## v1.1.0 (2026-08-11)

### 新功能

- **Git 面板重构为 IDEA Commit Dialog 风格** — 替代原 VS Code 风格，改为三区（Changes to be committed / Unversioned Files / Modified (not staged)）文件树 + 底部提交信息区。文件按目录树分组，可展开/折叠；目录 checkbox 支持级联全选/半选（indeterminate）；新增右键菜单（显示差异/撤销更改/添加到 .gitignore/复制路径/在文件管理器中显示）。

- **Git 提交历史（右侧栏 inline）** — 可折叠的「提交历史」section，展开后显示最近 50 条提交。点击提交展开该次提交的改动文件列表（M/A/D/R/C 状态徽章），点击文件打开中间区单栏 Monaco unified diff（只读，`renderSideBySide: false`）。支持搜索过滤（防抖 300ms）+ 无限滚动加载。

- **悬浮预览卡片** — hover 提交行 300ms 后弹出紧凑卡片（类似右键菜单），显示短 hash、提交信息、作者、日期。Portal 渲染到 `document.body` 避免右侧栏 `transform` 影响 fixed 定位。

- **全部分支/当前分支切换** — 提交历史可切换显示当前分支（`git log`）或全部分支（`git log --all`），切换分支时历史自动刷新。`gitLogAdvanced` 新增 `allBranches` 参数。

- **分支选择器下拉菜单优化** — 弹出列表改为绝对定位下拉菜单（`top: 100%`），不推开下方布局；hover 指针变化 + accent 高亮。

### 视觉优化

- **Checkbox 美化** — 自定义样式（`appearance: none`），15px 大小、1px 细边框、3px 圆角；勾选态 accent 填充 + 白色对勾，目录半选态白色短横线。
- **CSS 过渡动画** — hover 背景 0.18s、chevron 旋转 0.2s（改为 CSS border 三角形，旋转中心居中）、展开/收起 0.25s max-height 动画。
- **MonacoDiffView 对齐主编辑器配置** — 补齐 `cursorStyle: 'block'`、`smoothScrolling: true`、`diffWordWrap: 'on'`、`renderLineHighlight: 'line'`。

### 修复

- **中文路径 git 操作失败** — 修复 `core.quotepath` 导致中文路径被八进制转义，所有 git 命令添加 `-c core.quotepath=false`。
- **无提交仓库 revert 报 invalid reference: HEAD** — revert 改为 `git checkout HEAD -- <path>` 后在无 HEAD 仓库中容错降级。
- **fsReadFile 目录返回 EISDIR** — 点击目录时不再创建空 tab，改用系统默认程序打开。
- **Git 面板 '+' 按钮事件冒泡** — 点击暂存/取消暂存/撤销/删除按钮时调用 `e.stopPropagation()` 防止同时打开文件。
- **切换分支后提交历史不刷新** — 新增 `useEffect` 监听 `status?.branch` 自动刷新。

### 清理

- 删除无引用文件：`SingleDiffView.tsx`、`use-terminal-container-fit-sync.ts`
- 删除 ~280 行旧 VS Code 风格 Git 面板 CSS（已全部被 IDEA 风格替代）
- 移除未使用的重导出 `RenderedRow`、`LogTab`/`openLog` store 类型和通道

---

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