export type SessionStatus = 'running' | 'dead';
export interface SessionInfo {
  key: string;
  cwd: string;
  name: string;
  status: SessionStatus;
}
export interface SessionGroup {
  cwd: string;
  sessions: Array<{ key: string; name: string; time: string }>;
}
export interface OpenRequest { key?: string; cwd?: string; name?: string; }

/** 主题家族：决定整体配色风格 */
export type ThemeFamily = 'github' | 'aurora' | 'mineral';

/** 主题明暗变体 */
export type ThemeVariant = 'dark' | 'light';

/** 向后兼容别名 */
export type Theme = ThemeVariant;

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WindowState {
  maximized: boolean;
  bounds: Bounds;
}

export type CloseBehavior = 'close' | 'minimize-to-tray';

export interface AppConfig {
  theme: ThemeVariant;
  /** 主题家族（配色风格），默认 'github' */
  themeFamily: ThemeFamily;
  pinnedDirs: string[];
  // 用户在侧边栏“添加目录”显式注册、需要常驻展示的目录列表（不含子路径匹配）。
  // 左侧栏仅展示这些目录下的会话；其余磁盘会话只在设置面板“会话管理”中可见。
  addedDirs: string[];
  // 文件管理器面板（Sidebar 与终端区之间的独立栏）宽度，持久化、可拖拽右缘调整。
  filePanelWidth: number;
  // 右栏（文件树 / Git）宽度，持久化、可拖拽。
  rightPanelWidth: number;
  window: WindowState;
  sidebarWidth: number;
  closeBehavior: CloseBehavior;
  // 全局字体大小（UI + 终端统一基准，单位 px）。持久化于主进程 config，
  // 与主题同构：单一根属性驱动整个 UI 与终端字号。范围 8–28，默认 13。
  fontSize: number;
  // 集成终端：默认终端 profile 的 id；null 表示用探测到的第一个 / 平台默认。
  defaultTerminalProfile: string | null;
  // 用户自定义的终端 profile 覆盖（key 为 profile id，如 'custom'），覆盖探测到的 profile。
  terminalProfiles: Record<string, { path: string; args: string[] }>;
  // 终端 scrollback 行数（xterm scrollback 选项）。默认 5000，范围 1000–100000。
  scrollback: number;
  // 应用工作目录分组的根目录：用于收容与具体项目无关、与 pi-agent 闲聊或临时用的集成终端。
  // 默认 ~/piDesktop（见 config.defaultConfig）；可在「设置 → 终端」中改为其他目录。
  // 该目录下的集成终端统一归入侧边栏的「应用工作目录」分组，不挂靠任何项目 cwd。
  appWorkDir: string;
  // 侧边栏中已折叠的目录分组 cwd 列表，用于跨会话持久化折叠状态。
  collapsedGroups: string[];
  // 右栏（文件树/Git）上一次选择的目录，跨会话持久化。
  // 首次打开时为空，应用自动选择 appWorkDir；后续启动恢复此值。
  lastActiveDir: string;
  // 左侧栏是否折叠
  sidebarCollapsed: boolean;
  // 右栏（文件树/Git）是否折叠
  rightPanelCollapsed: boolean;

  // ── 终端光标配置 ──
  // 光标闪烁，默认 true。
  cursorBlink: boolean;
  // 光标样式：block | bar | underline，默认 'bar'。
  cursorStyle: 'block' | 'bar' | 'underline';
  // 非活跃光标样式：none | outline | block | bar | underline，默认 'outline'。
  cursorInactiveStyle: 'none' | 'outline' | 'block' | 'bar' | 'underline';
  // 光标宽度（px），默认 1。
  cursorWidth: number;

  // ── 终端字体配置 ──
  // 终端的字体系列（覆盖全局 fontFamily），默认包含 JetBrains Mono / Fira Code / Cascadia Code 的回退链。
  fontFamily: string;
  // 终端行高倍数，默认 1.0。
  lineHeight: number;
  // 字符间距（px），默认 0。
  letterSpacing: number;
  // 常规字重，默认 'normal'。
  fontWeight: FontWeight;
  // 粗体字重，默认 'bold'。
  fontWeightBold: FontWeight;

  // ── 终端滚动配置 ──
  // 平滑滚动（触控板禁用），默认 false。
  smoothScrolling: boolean;
  // 滚轮滚动灵敏度倍数，默认 1。
  scrollSensitivity: number;
  // 按住 Shift 时快速滚动速度倍数，默认 5。
  fastScrollSensitivity: number;

  // ── 终端滚动条配置 ──
  // 滚动条宽度（px），默认 14。
  scrollbarWidth: number;

  // ── 终端字形与渲染 ──
  // 是否为 Box Drawing / Block Elements / Powerline 等 Unicode 范围绘制自定义字形，
  // 而不是使用字体。默认 true（对齐 VS Code 默认）。
  customGlyphs: boolean;
  // 终端 GPU 加速模式：'auto' 自动探测，'on' 强制开启，'off' 强制关闭。
  gpuAcceleration: 'auto' | 'on' | 'off';

  // ── Git 配置 ──
  /** 文件变更自动刷新开关。 */
  gitAutorefresh: boolean;
  /** 无暂存变更时提交自动包含全部。 */
  gitSmartCommit: boolean;
  /** 提交前提示保存未保存文件。 */
  gitPromptToSave: boolean;
  /** 启用提交签名。 */
  gitEnableCommitSigning: boolean;
  /** 始终在提交消息后追加 Signed-off-by。 */
  gitAlwaysSignOff: boolean;
  /** 允许 force push。 */
  gitAllowForcePush: boolean;
  /** 后台自动 fetch。 */
  gitAutofetch: boolean;
}

export type FontWeight = 'normal' | 'bold' | '100' | '200' | '300' | '400' | '500' | '600' | '700' | '800' | '900';

export type Platform = 'windows' | 'macos' | 'linux';

// 一个可用的终端 profile（shell 描述）。id 稳定（如 'pwsh' / 'cmd' / 'git-bash' / 'default' / 'custom'）。
export interface TerminalProfile {
  id: string;
  label: string;       // 展示名，如 'PowerShell' / 'CMD' / 'Git Bash'
  path: string;        // shell 可执行文件绝对路径
  args: string[];      // 启动参数，如 git-bash 用 ['--login','-i']
  platform: Platform | 'all';
  isCustom?: boolean;  // 用户自定义的「其他」路径
}

// 一个已创建的集成终端实例信息。
export interface IntegratedTerminalInfo {
  id: string;          // 形如 'term-<uuid>'
  profileId: string;
  cwd: string;
  title: string;       // 展示标题（profile label 或 cwd 末段）
}

// ── Git 写操作结果（与主进程 gitBridge.GitWriteResult 对应）──
export interface GitWriteResult {
  success: boolean;
  error?: string;
}

// ── pi-tool 批量操作单项结果（skills batch disable/delete）──
export interface PiBatchResult {
  name: string;
  success: boolean;
  error?: string;
}

// ── pi-tool 集成：Skills / 扩展 / MCP（与主进程 piToolHandlers 对应）──
export interface PiSkill {
  name: string;
  disabled: boolean;
  description?: string;
  source: string | null;
  sourceUrl: string | null;
  sourceType: string | null;
}
export interface PiExtension {
  name: string;
  type: string;
  source: string;
  disabled: boolean;
  managed: boolean;
  dir?: string;
}
export interface PiMcpConfig {
  id: string;
  label: string;
  path: string;
  exists: boolean;
  config: unknown;
}

// ── 版本更新（与主进程 updateChecker.UpdateInfo 对应）──
export interface UpdateInfo {
  currentVersion: string;
  latestVersion: string | null;
  hasUpdate: boolean;
  releaseUrl: string | null;
  releaseName: string | null;
  releaseBody: string | null;
  checkedAt: string | null;
  error: string | null;
}

// ── Git 文件树状态（与主进程 gitBridge.GitFileStatusEntry 对应）──
export interface GitFileStatusEntry {
  /** 简化类别，用于 CSS 颜色 */
  category: 'modified' | 'added' | 'deleted' | 'ignored' | 'conflict' | 'submodule';
  /** 是否已暂存（staged） */
  staged: boolean;
  /** 是否工作区有未暂存改动 */
  unstaged: boolean;
  /** 短徽章字母：M/A/D/?/U/R/C/! */
  badge: string;
  /** 是否为符号链接 */
  isSymlink: boolean;
  /** 是否为子模块 */
  isSubmodule: boolean;
  /** 子模块是否有未提交的改动（仅 isSubmodule=true 时有效） */
  submoduleDirty?: boolean;
}
