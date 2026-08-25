import type { AppConfig, FontWeight } from '../renderer/src/types';

// ⚠️ 此模块被 renderer（浏览器沙箱，nodeIntegration:false，无 node:os/path）经
// `defaultConfig` 间接 import。绝不能 import node:os / node:path —— 否则 sandbox
// renderer 模块求值时会尝试加载 node 模块，模块图加载失败，App 无法挂载（表现为
// 启动卡动画或点击新建终端后整屏黑屏，取决于崩溃发生的时机）。
// appWorkDir 的“文件夹名”在此声明（renderer 安全占位）；main 进程在 ensureAppWorkDir
// 中结合 os.homedir() 解析为绝对路径（见 index.ts 的 getDefaultAppWorkDir）。
export const DEFAULT_APP_WORK_DIR_NAME = 'defaultWorkbench';

// 默认应用工作目录根（~/piDesktop），可在「设置 → 终端」改为其他目录。
// 返回文件夹名（renderer 安全）；绝对路径由 main 进程的 getDefaultAppWorkDir 计算。
export function getDefaultAppWorkDir(): string {
  return DEFAULT_APP_WORK_DIR_NAME;
}

// 默认配置（见 docs/adr/0001）。窗口几何默认 1100×720、非最大化。
export function defaultConfig(): AppConfig {
  return {
    theme: 'dark',
    themeFamily: 'github',
    pinnedDirs: [],
    addedDirs: [],
    window: { maximized: false, bounds: { x: 0, y: 0, width: 1100, height: 720 } },
    sidebarWidth: 280,
    filePanelWidth: 260,
    rightPanelWidth: 280,
    closeBehavior: 'minimize-to-tray',
    fontSize: 15,
    // 集成终端：默认 profile（null = 探测到的第一个 / 平台默认）。
    defaultTerminalProfile: null,
    // 用户自定义终端 profile 覆盖（key 为 profile id）。
    terminalProfiles: {},
    // app work dir group root (defaults to ~/piDesktop)
    appWorkDir: getDefaultAppWorkDir(),
    // 终端 scrollback 行数，默认 5000
    scrollback: 5000,
    // 侧边栏折叠的目录分组（cwd 列表），初始全部展开
    collapsedGroups: [],
    // 右栏（文件树/Git）上次活跃会话目录，启动时自动恢复（打开上次的工作目录）
    lastActiveDir: '',
    // 左侧栏初始不折叠
    sidebarCollapsed: false,
    // 右栏初始不折叠
    rightPanelCollapsed: false,

    // 终端光标
    cursorBlink: true,
    cursorStyle: 'bar',
    cursorInactiveStyle: 'outline',
    cursorWidth: 1,

    // 终端字体
    fontFamily: "'JetBrains Mono','Fira Code','Cascadia Code',ui-monospace,monospace",
    lineHeight: 1.0,
    letterSpacing: 0,
    fontWeight: 'normal',
    fontWeightBold: 'bold',

    // 终端滚动
    smoothScrolling: false,
    scrollSensitivity: 1,
    fastScrollSensitivity: 5,

    // 终端滚动条
    scrollbarWidth: 14,

    // 终端字形与渲染
    customGlyphs: true,
    gpuAcceleration: 'auto',

    // Git 配置
    gitAutorefresh: true,
    gitSmartCommit: true,
    gitPromptToSave: true,
    gitEnableCommitSigning: false,
    gitAlwaysSignOff: false,
    gitAllowForcePush: false,
    gitAutofetch: false,
  };
}

// 字体大小允许范围（px）。过小的字号无法阅读、过大撑破布局，故夹在此区间。
export const FONT_SIZE_MIN = 8;
export const FONT_SIZE_MAX = 28;

// 终端 scrollback 行数范围。
export const SCROLLBACK_MIN = 1000;
export const SCROLLBACK_MAX = 100_000;

// 终端光标宽度范围。
export const CURSOR_WIDTH_MIN = 1;
export const CURSOR_WIDTH_MAX = 25;

// 终端行高范围。
export const LINE_HEIGHT_MIN = 0.5;
export const LINE_HEIGHT_MAX = 3.0;

// 终端字间距范围。
export const LETTER_SPACING_MIN = -5;
export const LETTER_SPACING_MAX = 20;

// 滚动灵敏度范围。
export const SCROLL_SENSITIVITY_MIN = 0.1;
export const SCROLL_SENSITIVITY_MAX = 20;

// 快速滚动范围。
export const FAST_SCROLL_SENSITIVITY_MIN = 1;
export const FAST_SCROLL_SENSITIVITY_MAX = 100;

// 滚动条宽度范围。
export const SCROLLBAR_WIDTH_MIN = 6;
export const SCROLLBAR_WIDTH_MAX = 40;

/** 把任意输入夹进 [min, max]；非法输入回退 fallback。round 控制取整方式（默认 Math.round）。 */
function clampNumber(
  n: unknown,
  min: number,
  max: number,
  fallback: number,
  round: (v: number) => number = Math.round,
): number {
  const v = typeof n === 'number' && Number.isFinite(n) ? round(n) : NaN;
  if (!Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, v));
}

/** 字体大小（px），取整；非法输入回退默认 15。 */
export function clampFontSize(n: unknown): number {
  return clampNumber(n, FONT_SIZE_MIN, FONT_SIZE_MAX, defaultConfig().fontSize);
}

/** 终端 scrollback 行数，取整；非法输入回退默认 5000。 */
export function clampScrollback(n: unknown): number {
  return clampNumber(n, SCROLLBACK_MIN, SCROLLBACK_MAX, defaultConfig().scrollback);
}

/** 终端光标宽度，取整；非法输入回退默认 1。 */
export function clampCursorWidth(n: unknown): number {
  return clampNumber(n, CURSOR_WIDTH_MIN, CURSOR_WIDTH_MAX, defaultConfig().cursorWidth);
}

/** 终端行高，保留一位小数；非法输入回退默认 1.0。 */
export function clampLineHeight(n: unknown): number {
  return clampNumber(n, LINE_HEIGHT_MIN, LINE_HEIGHT_MAX, defaultConfig().lineHeight, (v) => Math.round(v * 10) / 10);
}

/** 终端字间距，取整；非法输入回退默认 0。 */
export function clampLetterSpacing(n: unknown): number {
  return clampNumber(n, LETTER_SPACING_MIN, LETTER_SPACING_MAX, defaultConfig().letterSpacing);
}

/** 滚动灵敏度，保留一位小数；非法输入回退默认 1。 */
export function clampScrollSensitivity(n: unknown): number {
  return clampNumber(n, SCROLL_SENSITIVITY_MIN, SCROLL_SENSITIVITY_MAX, defaultConfig().scrollSensitivity, (v) => Math.round(v * 10) / 10);
}

/** 快速滚动灵敏度，取整；非法输入回退默认 5。 */
export function clampFastScrollSensitivity(n: unknown): number {
  return clampNumber(n, FAST_SCROLL_SENSITIVITY_MIN, FAST_SCROLL_SENSITIVITY_MAX, defaultConfig().fastScrollSensitivity);
}

/** 滚动条宽度，取整；非法输入回退默认 14。 */
export function clampScrollbarWidth(n: unknown): number {
  return clampNumber(n, SCROLLBAR_WIDTH_MIN, SCROLLBAR_WIDTH_MAX, defaultConfig().scrollbarWidth);
}

/** 校验字体粗细值；非法输入回退默认。 */
export function clampFontWeight(n: unknown): FontWeight {
  const valid: FontWeight[] = ['normal', 'bold', '100', '200', '300', '400', '500', '600', '700', '800', '900'];
  if (valid.includes(n as FontWeight)) return n as FontWeight;
  return 'normal';
}

// 解析 config.json 原文；损坏 / 非对象时回退默认（不抛异常，保证启动不崩）。
export function parseConfig(raw: string | null): AppConfig {
  if (!raw) return defaultConfig();
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return defaultConfig();
    const p = parsed as Partial<AppConfig>;
    const merged = mergeConfig(defaultConfig(), p);
    // 数值字段单独校准，避免损坏/越界值污染全局（见 FONT_SIZE_MIN/MAX）。
    merged.fontSize = clampFontSize(p.fontSize);
    merged.scrollback = clampScrollback(p.scrollback);
    merged.cursorWidth = clampCursorWidth(p.cursorWidth);
    merged.lineHeight = clampLineHeight(p.lineHeight);
    merged.letterSpacing = clampLetterSpacing(p.letterSpacing);
    merged.scrollSensitivity = clampScrollSensitivity(p.scrollSensitivity);
    merged.fastScrollSensitivity = clampFastScrollSensitivity(p.fastScrollSensitivity);
    merged.scrollbarWidth = clampScrollbarWidth(p.scrollbarWidth);
    merged.fontWeight = clampFontWeight(p.fontWeight);
    merged.fontWeightBold = clampFontWeight(p.fontWeightBold);
    return merged;
  } catch {
    console.warn('[config] config.json corrupt, using defaults');
    return defaultConfig();
  }
}

// 浅合并：顶层字段替换（如传入 window 会整体替换，不深合并）。
export function mergeConfig(base: AppConfig, partial: Partial<AppConfig>): AppConfig {
  return { ...base, ...partial };
}
