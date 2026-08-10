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
    fontSize: 13,
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
    // 右栏（文件树/Git）上一次选择的目录，首次启动为空
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

/** 把任意输入夹进 [FONT_SIZE_MIN, FONT_SIZE_MAX] 且取整；非法输入回退默认 13。 */
export function clampFontSize(n: unknown): number {
  const v = typeof n === 'number' && Number.isFinite(n) ? Math.round(n) : NaN;
  if (!Number.isFinite(v)) return defaultConfig().fontSize;
  return Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, v));
}

/** 把任意输入夹进 [SCROLLBACK_MIN, SCROLLBACK_MAX] 且取整；非法输入回退默认 5000。 */
export function clampScrollback(n: unknown): number {
  const v = typeof n === 'number' && Number.isFinite(n) ? Math.round(n) : NaN;
  if (!Number.isFinite(v)) return defaultConfig().scrollback;
  return Math.min(SCROLLBACK_MAX, Math.max(SCROLLBACK_MIN, v));
}

/** 把任意输入夹进 [CURSOR_WIDTH_MIN, CURSOR_WIDTH_MAX] 且取整；非法输入回退默认 1。 */
export function clampCursorWidth(n: unknown): number {
  const v = typeof n === 'number' && Number.isFinite(n) ? Math.round(n) : NaN;
  if (!Number.isFinite(v)) return defaultConfig().cursorWidth;
  return Math.min(CURSOR_WIDTH_MAX, Math.max(CURSOR_WIDTH_MIN, v));
}

/** 把任意输入夹进 [LINE_HEIGHT_MIN, LINE_HEIGHT_MAX] 且保留一位小数；非法输入回退默认 1.0。 */
export function clampLineHeight(n: unknown): number {
  const v = typeof n === 'number' && Number.isFinite(n) ? Math.round(n * 10) / 10 : NaN;
  if (!Number.isFinite(v)) return defaultConfig().lineHeight;
  return Math.min(LINE_HEIGHT_MAX, Math.max(LINE_HEIGHT_MIN, v));
}

/** 把任意输入夹进 [LETTER_SPACING_MIN, LETTER_SPACING_MAX] 且取整；非法输入回退默认 0。 */
export function clampLetterSpacing(n: unknown): number {
  const v = typeof n === 'number' && Number.isFinite(n) ? Math.round(n) : NaN;
  if (!Number.isFinite(v)) return defaultConfig().letterSpacing;
  return Math.min(LETTER_SPACING_MAX, Math.max(LETTER_SPACING_MIN, v));
}

/** 把任意输入夹进 [SCROLL_SENSITIVITY_MIN, SCROLL_SENSITIVITY_MAX] 且保留一位小数；非法输入回退默认 1。 */
export function clampScrollSensitivity(n: unknown): number {
  const v = typeof n === 'number' && Number.isFinite(n) ? Math.round(n * 10) / 10 : NaN;
  if (!Number.isFinite(v)) return defaultConfig().scrollSensitivity;
  return Math.min(SCROLL_SENSITIVITY_MAX, Math.max(SCROLL_SENSITIVITY_MIN, v));
}

/** 把任意输入夹进 [FAST_SCROLL_SENSITIVITY_MIN, FAST_SCROLL_SENSITIVITY_MAX] 且取整；非法输入回退默认 5。 */
export function clampFastScrollSensitivity(n: unknown): number {
  const v = typeof n === 'number' && Number.isFinite(n) ? Math.round(n) : NaN;
  if (!Number.isFinite(v)) return defaultConfig().fastScrollSensitivity;
  return Math.min(FAST_SCROLL_SENSITIVITY_MAX, Math.max(FAST_SCROLL_SENSITIVITY_MIN, v));
}

/** 把任意输入夹进 [SCROLLBAR_WIDTH_MIN, SCROLLBAR_WIDTH_MAX] 且取整；非法输入回退默认 14。 */
export function clampScrollbarWidth(n: unknown): number {
  const v = typeof n === 'number' && Number.isFinite(n) ? Math.round(n) : NaN;
  if (!Number.isFinite(v)) return defaultConfig().scrollbarWidth;
  return Math.min(SCROLLBAR_WIDTH_MAX, Math.max(SCROLLBAR_WIDTH_MIN, v));
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
    const merged = mergeConfig(defaultConfig(), parsed as Partial<AppConfig>);
    // 数值字段单独校准，避免损坏/越界值污染全局（见 FONT_SIZE_MIN/MAX）。
    merged.fontSize = clampFontSize((parsed as Partial<AppConfig>).fontSize);
    merged.scrollback = clampScrollback((parsed as Partial<AppConfig>).scrollback);
    merged.cursorWidth = clampCursorWidth((parsed as Partial<AppConfig>).cursorWidth);
    merged.lineHeight = clampLineHeight((parsed as Partial<AppConfig>).lineHeight);
    merged.letterSpacing = clampLetterSpacing((parsed as Partial<AppConfig>).letterSpacing);
    merged.scrollSensitivity = clampScrollSensitivity((parsed as Partial<AppConfig>).scrollSensitivity);
    merged.fastScrollSensitivity = clampFastScrollSensitivity((parsed as Partial<AppConfig>).fastScrollSensitivity);
    merged.scrollbarWidth = clampScrollbarWidth((parsed as Partial<AppConfig>).scrollbarWidth);
    merged.fontWeight = clampFontWeight((parsed as Partial<AppConfig>).fontWeight);
    merged.fontWeightBold = clampFontWeight((parsed as Partial<AppConfig>).fontWeightBold);
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
