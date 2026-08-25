import { pi } from './ipc';
import type { AppConfig } from './types';
import { FONT_SIZE_MIN, FONT_SIZE_MAX, defaultConfig } from '../../main/config';

export { FONT_SIZE_MIN, FONT_SIZE_MAX };

// 与主题同构：单一根属性驱动整个 UI 与终端字号。
// UI 通过 CSS 变量 --font-scale（= fontSize / 13）在 tokens.css 中按比例缩放各 --fs-*；
// 终端（xterm 字体为硬编码 px）由 XtermTerminal 订阅本模块变更后 setOption('fontSize')。
// 13 为缩放归一化基准（与默认字号解耦）；默认字号见 defaultConfig()。

const listeners = new Set<(size: number) => void>();

/** 同步读取主进程在窗口创建时经 additionalArguments 注入的初始 config（见 preload 的
 * getInitialConfig），使首屏字体无需等待异步 IPC，杜绝默认→持久化的跳变闪烁。 */
function readInitialFontSize(): number {
  try {
    const cfg = (window as any).pi?.getInitialConfig?.();
    if (cfg && typeof cfg.fontSize === 'number') {
      return Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, Math.round(cfg.fontSize)));
    }
  } catch {
    /* 无注入配置（如测试）时回退默认字号 */
  }
  return defaultConfig().fontSize;
}

/** 把字号写到根节点：设 --font-scale 供 CSS 按比例缩放 UI，并缓存当前值供订阅者读取。 */
function paint(size: number): void {
  document.documentElement.style.setProperty('--font-scale', String(size / 13));
}

export function getFontSize(): number {
  const raw = document.documentElement.style.getPropertyValue('--font-scale');
  if (raw) {
    const n = Number.parseFloat(raw) * 13;
    if (Number.isFinite(n)) return Math.round(n);
  }
  return defaultConfig().fontSize;
}

export function setFontSize(size: number): number {
  const next = Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, Math.round(size)));
  paint(next);
  pi.setConfig({ fontSize: next }).catch(() => {});
  listeners.forEach((l) => l(next));
  return next;
}

/** 步进调整（设置面板按钮 / Ctrl+滚轮），delta 为相对步长（如 ±1）。 */
export function bumpFontSize(delta: number): number {
  return setFontSize(getFontSize() + delta);
}

export function onFontSizeChange(cb: (size: number) => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

// 首屏尽早应用初始字号以避免闪烁。
paint(readInitialFontSize());

// App 挂载后调用：从主进程配置读取持久化字号并应用（config 为异步来源）。
export async function initFontSize(): Promise<void> {
  try {
    const cfg: AppConfig = await pi.getConfig();
    if (typeof cfg.fontSize === 'number') {
      const next = Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, Math.round(cfg.fontSize)));
      // 仅当与当前不一致才纠正并通知，避免无谓的重绘/通知。
      if (next !== getFontSize()) {
        paint(next);
        listeners.forEach((l) => l(next));
      }
    }
  } catch {
    /* 读取失败则保持首屏字号 */
  }
}
