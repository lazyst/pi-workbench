import { pi } from './ipc';
import type { ThemeFamily, ThemeVariant } from './types';
export type { ThemeFamily, ThemeVariant };
// 向后兼容导出 Theme 别名
import type { ThemeVariant as Theme } from './types';
export type { Theme };
// 终端主题已抽到独立的 lib/terminal-themes（对齐 orca lib/terminal-theme.ts），
// 主题定义/背景跟随容器逻辑集中于该模块，本文件仅做向后兼容委托导出，不重复维护调色板。
import { getTermTheme, TERM_THEMES } from './lib/terminal-themes';
export { getTermTheme, TERM_THEMES };

const listeners = new Set<(family: ThemeFamily, variant: ThemeVariant) => void>();

// 有效的主题家族与变体，用于校验。
const VALID_FAMILIES: ThemeFamily[] = ['github', 'aurora', 'mineral'];
const VALID_VARIANTS: ThemeVariant[] = ['dark', 'light'];

function isValidFamily(v: string | null): v is ThemeFamily {
  return v !== null && VALID_FAMILIES.includes(v as ThemeFamily);
}

function isValidVariant(v: string | null): v is ThemeVariant {
  return v !== null && VALID_VARIANTS.includes(v as ThemeVariant);
}

// 同步读取主进程在窗口创建时经 additionalArguments 注入的初始 config（见 preload 的
// getInitialConfig），使首屏主题（含随后打开的终端）无需等待异步 IPC，杜绝暗→亮闪烁。
function readInitialConfig<T extends string>(key: string, validate: (v: string | null) => v is T, fallback: T): T {
  try {
    const cfg = (window as any).pi?.getInitialConfig?.();
    if (cfg && validate(cfg[key])) return cfg[key];
  } catch { /* 无注入配置（如测试）时回退默认 */ }
  return fallback;
}

// 主题持久化改为主进程 config（见 docs/adr/0001），不再用 localStorage。

// Drive the whole UI from two attributes on <html>. `:root` holds the default
// (github dark) palette; `[data-theme-family="..."]` + `[data-theme="..."]` override
// the same token names, so every component — sidebar, title bar, modals — follows
// the theme for free.
function paint(family: ThemeFamily, variant: ThemeVariant) {
  document.documentElement.setAttribute('data-theme-family', family);
  document.documentElement.setAttribute('data-theme', variant);
}

export function getThemeFamily(): ThemeFamily {
  return (document.documentElement.getAttribute('data-theme-family') as ThemeFamily) ?? 'github';
}

export function getTheme(): ThemeVariant {
  return (document.documentElement.getAttribute('data-theme') as ThemeVariant) ?? 'dark';
}

export function setThemeFamily(f: ThemeFamily) {
  const v = getTheme();
  paint(f, v);
  pi.setConfig({ themeFamily: f }).catch(() => {});
  listeners.forEach((l) => l(f, v));
}

export function setTheme(t: ThemeVariant) {
  const f = getThemeFamily();
  paint(f, t);
  // config 经异步 IPC 持久化；用 .catch 吸收拒绝（try/catch 抓不到 Promise 拒绝）。
  pi.setConfig({ theme: t }).catch(() => {});
  listeners.forEach((l) => l(f, t));
}

/** 同时设置主题家族与变体（一步到位，只触发一次通知）。 */
export function setThemeBoth(family: ThemeFamily, variant: ThemeVariant) {
  paint(family, variant);
  pi.setConfig({ themeFamily: family, theme: variant }).catch(() => {});
  listeners.forEach((l) => l(family, variant));
}

export function onThemeChange(cb: (family: ThemeFamily, variant: ThemeVariant) => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

// 首屏尽早上色以避免闪烁：config 在主进程、须经异步 IPC 读取，
// 故先以 readInitialFamily/Variant()（同步注入值，回退默认）上色，App 挂载后由 initTheme() 校正。
paint(readInitialConfig('themeFamily', isValidFamily, 'github'), readInitialConfig('theme', isValidVariant, 'dark'));

// App 挂载后调用：从主进程配置读取持久化主题并应用（config 为异步来源）。
export async function initTheme(): Promise<void> {
  try {
    const cfg = await pi.getConfig();
    // 同步初始主题已先行上色；仅当与持久化值不一致才纠正并持久化，
    // 避免每次启动都多发一次无谓的 config 写与 listener 通知。
    const family = isValidFamily(cfg.themeFamily) ? cfg.themeFamily : 'github';
    const variant = isValidVariant(cfg.theme) ? cfg.theme : 'dark';
    if (family !== getThemeFamily() || variant !== getTheme()) {
      setThemeBoth(family, variant);
    }
  } catch {
    /* 读取失败则保持默认主题 */
  }
}
