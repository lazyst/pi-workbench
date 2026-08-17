// 存活终端实例注册表（对齐 orca 的「单点订阅、批量刷新」思路）。
//
// 解耦目标（见 issue 05）：把「主题切换 / 全局字号变化 → 刷新所有存活 xterm 实例」的逻辑从
// 每个 XtermTerminal 实例内部上提为单点订阅——避免 N 个实例各自订阅 onThemeChange /
// onFontSizeChange（既重复、又与 XtermTerminal 关注点混杂）。
//
// 机制：XtermTerminal 在 mount 时 register、unmount 时 unregister；本模块在模块加载时一次性
// 订阅 onThemeChange / onFontSizeChange，任一全局变更即通过实例的 applyTheme / applyFontSize
// 刷新所有存活实例，并在 WebGL 下 forceRedraw 清纹理图集，避免旧配色/旧字形残留闪留。
import { onThemeChange, type ThemeFamily, type ThemeVariant } from '../theme';
import { onFontSizeChange } from '../fontSize';

/** 终端配置更新 payload（映射 XtermTerminal.updateConfig 参数，避免循环依赖）。 */
export interface TerminalConfigUpdate {
  cursorBlink?: boolean;
  cursorStyle?: 'block' | 'bar' | 'underline';
  cursorInactiveStyle?: 'none' | 'outline' | 'block' | 'bar' | 'underline';
  cursorWidth?: number;
  scrollback?: number;
  fontFamily?: string;
  fontSize?: number;
  lineHeight?: number;
  letterSpacing?: number;
  fontWeight?: string;
  fontWeightBold?: string;
  smoothScrolling?: boolean;
  isPhysicalMouseWheel?: boolean;
  scrollbarWidth?: number;
  scrollSensitivity?: number;
  fastScrollSensitivity?: number;
  customGlyphs?: boolean;
  gpuAcceleration?: 'auto' | 'on' | 'off';
}

/** 存活终端必须实现的刷新接口（由 XtermTerminal 实现，避免循环依赖本模块直接 import 具体类）。 */
export interface LiveTerminal {
  applyTheme(family: ThemeFamily, variant: ThemeVariant): void;
  applyFontSize(size: number): void;
  /** 运行时批量更新终端配置（对齐 VS Code updateConfig）。 */
  updateConfig(config: TerminalConfigUpdate): void;
  /** 强制重绘：清空 WebGL 纹理图集并触发一次完整重绘。 */
  forceRedraw(): void;
}

const liveTerminals = new Set<LiveTerminal>();

/** 注册一个存活终端（mount 时调用）。 */
export function registerTerminal(t: LiveTerminal): void {
  liveTerminals.add(t);
}

/** 注销一个终端（unmount 销毁时调用）。 */
export function unregisterTerminal(t: LiveTerminal): void {
  liveTerminals.delete(t);
}

/** 取当前存活终端数量（测试 / 调试用）。 */
export function liveTerminalCount(): number {
  return liveTerminals.size;
}

// ─── 配置变更聚合（16ms rAF 窗口） ───────────────────────────────────────────
// 避免连续多次主题/字号变更（如同时加载配置时）触发多次全屏 redraw。
// 使用 requestAnimationFrame 聚合，确保同一帧内的多次变更只触发一次刷新。

let pendingThemeChange: { family: ThemeFamily; variant: ThemeVariant } | null = null
let pendingFontSizeChange: number | null = null
let pendingConfigUpdates: TerminalConfigUpdate[] = []
let configAggregatorRafId: number | null = null

function flushAggregatedConfigChanges(): void {
  configAggregatorRafId = null

  // 先处理字号变更（需要 doResize，影响布局）
  if (pendingFontSizeChange !== null) {
    const size = pendingFontSizeChange
    pendingFontSizeChange = null
    liveTerminals.forEach((t) => t.applyFontSize(size))
  }

  // 再处理主题变更（仅刷新纹理，不影响布局）
  if (pendingThemeChange !== null) {
    const { family, variant } = pendingThemeChange
    pendingThemeChange = null
    liveTerminals.forEach((t) => t.applyTheme(family, variant))
  }

  // 最后处理批量配置更新
  if (pendingConfigUpdates.length > 0) {
    const updates = pendingConfigUpdates
    pendingConfigUpdates = []
    // 合并所有配置更新为一次 broadcast
    const merged: TerminalConfigUpdate = {}
    for (const u of updates) {
      Object.assign(merged, u)
    }
    liveTerminals.forEach((t) => t.updateConfig(merged))
  }
}

function scheduleFlushConfigChanges(): void {
  if (configAggregatorRafId !== null) return
  configAggregatorRafId = requestAnimationFrame(() => {
    flushAggregatedConfigChanges()
  })
}

// 单点订阅：主题切换 → 聚合后刷新所有存活实例
onThemeChange((family: ThemeFamily, variant: ThemeVariant) => {
  pendingThemeChange = { family, variant }
  scheduleFlushConfigChanges()
});

// 单点订阅：全局字号变化 → 聚合后同步所有存活实例
onFontSizeChange((size: number) => {
  pendingFontSizeChange = size
  scheduleFlushConfigChanges()
});

/** 将配置更新广播到所有存活终端实例（聚合后立即生效）。
 * 同一帧内的多次 broadcast 合并为一次 updateConfig 调用。 */
export function broadcastConfigUpdate(config: TerminalConfigUpdate): void {
  pendingConfigUpdates.push(config)
  scheduleFlushConfigChanges()
}

