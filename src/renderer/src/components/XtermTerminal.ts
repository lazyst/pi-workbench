// XtermTerminal —— 完全对齐 VS Code 集成终端的 xterm 装配（见 vscode-src
// src/vs/workbench/contrib/terminal/browser/xterm/xtermTerminal.ts 与 terminalInstance.ts）。
//
// 本次重写回归 VS Code 的标准做法，移除此前堆砌的自创 hack（5ms+行切片+rAF 逐批写、亚像素
// 阈值、流式活跃期冻结列宽、写后逐批锁底、scrollOnEraseInDisplay:false）。对齐 VS Code 后由
// xterm 原生处理同步输出与贴底，复杂场景的防抖交给 VS Code 同款的分轴 resize 与 5ms 时间窗
// 聚合，而非自研多套相互打架的计时器。
//
// 与 VS Code 集成终端对齐的装配点：
//   - 渲染器：open 之后装载 WebGL（对齐 VS Code XtermTerminal.attachToElement 的「TODO: Move
//     before open」之前的原生顺序），上下文丢失后可重试（不再永久锁定）。上下文
//     丢失后降级 DOM，下次可见时由 retryWebglIfNeeded 尝试重建 WebGL。
//   - 数据缓冲：直接订阅 channel.onData，由主进程 emitData 5ms 聚合 + 渲染端二次聚合
//     （5ms 时间窗 + 64KB 上限），双层减少 IPC 消息量和 term.write() 调用次数。
//     聚合后统一 _segmentByShellIntegration → _writeProcessDataViaScheduler。
//     scroll restore 由 writeForegroundTerminalChunk 的 viewport settle 处理（对齐 Orca），
//     不再在 _writeProcessDataViaScheduler 中做 scroll capture/restore。
//   - 命令级分段：对齐 VS Code TerminalInstance._onProcessData，按 OSC 633（C/D）序列把数据切成
//     语义段，各段按序 term.write，使命令边界成为独立写入单元、且可被装饰层差分解析。
//   - 写后背压：term.write 回调里调 pi.acknowledgeDataEvent(key, len)（对齐 VS Code
//     _writeProcessData 的 acknowledgeDataEvent 流控）。
//   - 写完成闸门：_latestWriteSeq === _latestParsedSeq 轮询（对齐 VS Code _flushXtermData）。
//   - resize：对齐 Orca 风格，统一由 ResizeObserver 150ms 防抖处理，不分 X/Y 轴。
//   - 构造选项：逐项对齐 VS Code 默认（cursorBlink/cursorStyle/cursorInactiveStyle/
//     minimumContrastRatio/drawBoldTextInBrightColors/tabStopWidth/letterSpacing/fontWeight 等）。
//     其中 scrollOnEraseInDisplay 恢复为 VS Code 默认 true。
//   - 装饰/导航：加载 DecorationAddon（差分 overlay 基座，对齐 VS Code DecorationAddon）与
//     MarkNavigationAddon（mark 导航，对齐 VS Code MarkNavigationAddon）。
//   - 剪贴板：@xterm/addon-clipboard 接管复制/粘贴（对齐 VS Code ClipboardAddon 装配）。
//   - Unicode：Unicode11Addon 稳定 CJK/宽字符度量（对齐 VS Code _updateUnicodeVersion）。
//
// 对外契约（B2-a 契约保形）：本类只通过构造传入的 pi 接口收发数据，不触碰主进程 / preload / IPC
// 信道名。PTY 链路零接触（见 docs/adr/0002）。
import { Terminal, type IMarker, type IDecoration, type IDecorationOptions } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { ClipboardAddon } from '@xterm/addon-clipboard';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { SearchAddon } from '@xterm/addon-search';
import { SerializeAddon } from '@xterm/addon-serialize';
import { getTheme, getThemeFamily, getTermTheme, type ThemeFamily, type ThemeVariant } from '../theme';
import { getFontSize } from '../fontSize';
import { registerTerminal, unregisterTerminal, type LiveTerminal } from '../lib/terminal-registry';

import { AckDataBufferer } from './ackDataBufferer';

import { TerminalResizeDebouncer } from './terminalResizeDebouncer'
import { DecorationAddon } from './decorationAddon';
import { MarkNavigationAddon } from './markNavigationAddon';
import { SessionChannel } from './terminalChannel';
import type { TerminalChannel } from './terminalChannel';
import type { PiApi } from '../ipc';
import { defaultConfig, SCROLLBACK_MIN, SCROLLBACK_MAX } from '../../../main/config';
import type { FontWeight } from '../types';
import {
  TerminalCapability,
  TerminalCapabilityStore,
  CommandDetectionCapability,
  CwdDetectionCapability,
} from './terminalCapabilities';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { MouseWheelClassifier } from './mouseWheelClassifier';
import { PI_FILE_DRAG_MIME } from './FileTree';
import '@xterm/xterm/css/xterm.css';

// —— lib/terminal 模块注入 ——
import { isXtermInstanceDisposed } from '../lib/terminal/instance-disposed';
import { PtyOutputProcessor } from '../lib/terminal/pty-output-processor';
import { runGuardedWriteCompletionStep } from '../lib/terminal/write-callback-guard';
import { discardInFlightTerminalOutputAckCredits } from '../lib/terminal/ack-credit';
import { forceRepaintThroughRenderPause } from '../lib/terminal/render-pause-release';
import { getTerminalWebglAutoDecision } from '../lib/terminal/webgl-auto-policy';
import { CURSOR_RESET_MINIMAL } from '../lib/terminal/replay-cursor-reset';
import {
  registerUndeliverableWriteHandler,
} from '../lib/terminal/write-pipeline-health';
import { configureTerminalOutputBacklogCap, discardQueuedOutput } from '../lib/terminal/output-scheduler';
import { installGuardedLinkProviderRegistration } from '../lib/terminal/link-provider-guard';
import { installTerminalLinkifierHoverResetOnWrite } from '../lib/terminal/linkifier-hover-reset-on-write';
import {
  captureScrollState as captureScrollStateModule,
  restoreScrollState as restoreScrollStateModule,
  releaseScrollStateMarker,
} from '../lib/terminal/scroll';
import type { ScrollState } from '../lib/terminal/scroll';
import {
  syncTerminalScrollIntentFromViewport,
  enforceTerminalCurrentScrollIntent,
} from '../lib/terminal/scroll-intent';
import { TerminalStructuralReplayCoordinator } from '../lib/terminal/structural-replay-coordinator'
import { attachTerminalScrollIntentTracking } from '../lib/terminal/scroll-intent-dom-tracking';

// 终端字体栈：对齐 VS Code 默认（等宽优先）。鉴于已加载 Unicode11Addon 处理宽字符度量，
// 不再需要此前「含 CJK 的等宽字体栈」hack——VS Code 同样不靠字体栈兜底 CJK 度量，而是交给
// Unicode11Addon + xterm 原生渲染。移除主栈里的 'Microsoft YaHei Mono'/'Microsoft YaHei' 等
// 可变宽 CJK 字体：它们会让 WebGL 渲染器在 CJK 占比变化的帧间出现 cell 度量跳变（全屏 TUI
// 差分重绘时表现为整屏上下抖动）。CJK 兜底交由 xterm 的 generic monospace fallback +
// Unicode11Addon 处理，纯 DOM 渲染器路径仍由 CSS 兜底覆盖。
// 主进程 emitData 的 5ms 聚合 + 渲染端二次聚合（5ms 时间窗 + 64KB 上限），
// 双层减少 IPC 消息量和 term.write() 调用次数。
// xterm.js 内部有 write 缓冲，短时间内大量 write() 调用会自动合并渲染。

/** 从主进程注入的初始配置读取 scrollback 值，进程内恒定（不热更新）。
 * 新建终端时构造 xterm 选项用此值，已存在的终端不受滚动设置变更影响。
 * 回退默认 5000，夹在 [SCROLLBACK_MIN, SCROLLBACK_MAX] 区间。 */
function getScrollback(): number {
  try {
    const cfg = (window as any).pi?.getInitialConfig?.();
    if (cfg && typeof cfg.scrollback === 'number') {
      return Math.min(SCROLLBACK_MAX, Math.max(SCROLLBACK_MIN, Math.round(cfg.scrollback)));
    }
  } catch {
    /* 无注入配置（如测试）时回退默认 */
  }
  return defaultConfig().scrollback;
}

/** 从初始配置读取 cursorBlink。 */
function getCursorBlink(): boolean {
  try {
    const cfg = (window as any).pi?.getInitialConfig?.();
    if (cfg && typeof cfg.cursorBlink === 'boolean') return cfg.cursorBlink;
  } catch { /* */ }
  return defaultConfig().cursorBlink;
}

/** 从初始配置读取 cursorStyle。 */
function getCursorStyle(): 'block' | 'bar' | 'underline' {
  try {
    const cfg = (window as any).pi?.getInitialConfig?.();
    const v = cfg?.cursorStyle;
    if (v === 'block' || v === 'bar' || v === 'underline') return v;
  } catch { /* */ }
  return defaultConfig().cursorStyle;
}

/** 从初始配置读取 cursorInactiveStyle。 */
function getCursorInactiveStyle(): 'none' | 'outline' | 'block' | 'bar' | 'underline' {
  try {
    const cfg = (window as any).pi?.getInitialConfig?.();
    const v = cfg?.cursorInactiveStyle;
    if (v === 'none' || v === 'outline' || v === 'block' || v === 'bar' || v === 'underline') return v;
  } catch { /* */ }
  return defaultConfig().cursorInactiveStyle;
}

/** 从初始配置读取 cursorWidth。 */
function getCursorWidth(): number {
  try {
    const cfg = (window as any).pi?.getInitialConfig?.();
    if (cfg && typeof cfg.cursorWidth === 'number') return Math.min(25, Math.max(1, Math.round(cfg.cursorWidth)));
  } catch { /* */ }
  return defaultConfig().cursorWidth;
}

/** 从初始配置读取 fontFamily。 */
function getFontFamily(): string {
  try {
    const cfg = (window as any).pi?.getInitialConfig?.();
    if (cfg && typeof cfg.fontFamily === 'string' && cfg.fontFamily.trim()) return cfg.fontFamily.trim();
  } catch { /* */ }
  return defaultConfig().fontFamily;
}

/** 从初始配置读取 lineHeight。 */
function getLineHeight(): number {
  try {
    const cfg = (window as any).pi?.getInitialConfig?.();
    if (cfg && typeof cfg.lineHeight === 'number') return Math.min(3.0, Math.max(0.5, cfg.lineHeight));
  } catch { /* */ }
  return defaultConfig().lineHeight;
}

/** 从初始配置读取 letterSpacing。 */
function getLetterSpacing(): number {
  try {
    const cfg = (window as any).pi?.getInitialConfig?.();
    if (cfg && typeof cfg.letterSpacing === 'number') return Math.min(20, Math.max(-5, Math.round(cfg.letterSpacing)));
  } catch { /* */ }
  return defaultConfig().letterSpacing;
}

/** 从初始配置读取 fontWeight。 */
function getFontWeight(): FontWeight {
  try {
    const cfg = (window as any).pi?.getInitialConfig?.();
    const v = cfg?.fontWeight;
    const valid: FontWeight[] = ['normal', 'bold', '100', '200', '300', '400', '500', '600', '700', '800', '900'];
    if (valid.includes(v)) return v;
  } catch { /* */ }
  return defaultConfig().fontWeight;
}

/** 从初始配置读取 fontWeightBold。 */
function getFontWeightBold(): FontWeight {
  try {
    const cfg = (window as any).pi?.getInitialConfig?.();
    const v = cfg?.fontWeightBold;
    const valid: FontWeight[] = ['normal', 'bold', '100', '200', '300', '400', '500', '600', '700', '800', '900'];
    if (valid.includes(v)) return v;
  } catch { /* */ }
  return defaultConfig().fontWeightBold;
}

/** 从初始配置读取 scrollSensitivity。 */
function getScrollSensitivity(): number {
  try {
    const cfg = (window as any).pi?.getInitialConfig?.();
    if (cfg && typeof cfg.scrollSensitivity === 'number') return Math.min(20, Math.max(0.1, cfg.scrollSensitivity));
  } catch { /* */ }
  return defaultConfig().scrollSensitivity;
}

/** 从初始配置读取 fastScrollSensitivity。 */
function getFastScrollSensitivity(): number {
  try {
    const cfg = (window as any).pi?.getInitialConfig?.();
    if (cfg && typeof cfg.fastScrollSensitivity === 'number') return Math.min(100, Math.max(1, Math.round(cfg.fastScrollSensitivity)));
  } catch { /* */ }
  return defaultConfig().fastScrollSensitivity;
}

/** 从初始配置读取 scrollbarWidth。 */
function getScrollbarWidth(): number {
  try {
    const cfg = (window as any).pi?.getInitialConfig?.();
    if (cfg && typeof cfg.scrollbarWidth === 'number') return Math.min(40, Math.max(6, Math.round(cfg.scrollbarWidth)));
  } catch { /* */ }
  return defaultConfig().scrollbarWidth;
}

/** 从初始配置读取 customGlyphs（是否为 Box Drawing / Powerline 等绘制自定义字形）。 */
function getCustomGlyphs(): boolean {
  try {
    const cfg = (window as any).pi?.getInitialConfig?.();
    if (cfg && typeof cfg.customGlyphs === 'boolean') return cfg.customGlyphs;
  } catch { /* */ }
  return defaultConfig().customGlyphs;
}

/** 从初始配置读取 gpuAcceleration（'auto' | 'on' | 'off'）。 */
function getGpuAcceleration(): 'auto' | 'on' | 'off' {
  try {
    const cfg = (window as any).pi?.getInitialConfig?.();
    const v = cfg?.gpuAcceleration;
    if (v === 'auto' || v === 'on' || v === 'off') return v;
  } catch { /* */ }
  return defaultConfig().gpuAcceleration;
}

/** 对齐 VS Code IProcessDataEvent：携带 trackCommit 标记的数据事件。
 * 最后一段数据（实际输出）标记 trackCommit=true，携带 writePromise 供调用方等待写完成。
 * 前导段（OSC 633 标记）标记 trackCommit=false，不跟踪写完成确认。 */
export interface IProcessDataEvent {
  data: string;
  trackCommit: boolean;
  writePromise?: Promise<void>;
}

export interface XtermTerminalOptions {
  // 数据通道抽象：PTY 输出订阅 / 退出订阅 / 键盘输入 / 尺寸通知全部走 channel，
  // XtermTerminal 不再直接引用全局 pi 的会话数据流 API（见 terminalChannel.ts）。
  // 可选：省略时回退为 SessionChannel(pi, sessionKey)（兼容既有测试 / 旧调用方）。
  channel?: TerminalChannel;
  // 仅用于日志/调试标识与数据缓冲 id（保留原 sessionKey 语义，与 channel 对应同一进程）。
  sessionKey: string;
  // 当 channel 未显式提供时，用于构建默认 SessionChannel；也被保留用于非数据流功能
  // （saveImage / getPathForFile / acknowledgeDataEvent）。与重构前一致。
  pi: PiApi;
}

/**
 * 单个会话的 xterm 终端封装。生命周期：
 *   new → mount(host)（首次进入 active 时构造 open + 装载 addons + 锁定渲染器 + 绑 IPC）
 *   → setActive(bool)（切 tab 时 keep-alive，不重建）→ unmount()（真正销毁，如会话被删除）。
 * 对 React 壳完全透明：壳在首次 active 时调用 mount、非 active 时调用 setActive(false)、
 * 再次 active 时调用 setActive(true)，会话删除时调用 unmount()，并把 host div / 置底按钮的
 * DOM 事件转交本类。
 */
export class XtermTerminal implements LiveTerminal {
  private readonly sessionKey: string;
  private readonly channel: TerminalChannel;
  // 保留 pi 引用仅用于「非会话数据流」功能：剪贴板图片落盘(saveImage)、拖拽文件路径解析
  // (getPathForFile)、写后背压回传(acknowledgeDataEvent)。所有 PTY 输入/输出/退出/resize
  // 数据通信均改走 this.channel（见 terminalChannel.ts）。
  private readonly pi: PiApi;
  private term: Terminal | null = null;
  private fit: FitAddon | null = null;
  private opened = false;
  private mounted = false; // 是否已完成首次 mount（keep-alive 下不再重建）
  private active = false; // keep-alive：当前是否可见（对齐 VS Code setVisible）
  private disposed = false;
  private host: HTMLElement | null = null;
  // 当前装载的 WebGL addon 实例引用（open 后锁定、会话内恒定；上下文丢失时置回退）。
  private webgl: WebglAddon | null = null;
  // WebGL 上下文是否丢失（丢失后整会话降级 DOM，待下次可见/resize 触发重建尝试）。
  private webglContextLost = false;
  // WebGL 上下文丢失标记：上下文丢失后设置，由 retryWebglIfNeeded 在可见时尝试重建。
  // 与 webglContextLost 的区别：webglContextLost 用于 forceRedraw 等跳过守卫；
  // webglDisabledAfterContextLoss 是 retry 触发器，重建成功后清除。
  private webglDisabledAfterContextLoss = false;
  // WebGL 附加失败锁：首次 new WebglAddon() 失败后 latch，避免后续反复重试（如 title 变化触发
  // 重新 attach 时再次失败，浪费 CPU 并产生 console 噪音）。
  // 由 retryWebglIfNeeded 在可见时显式清除后重试，或 unmount 时清除。
  private webglAttachFailed = false;

  // —— 写入调度器（output-scheduler.ts）——
  // 使用基于优先级的调度器替代 5ms 聚合定时器。调度器提供 parse-clock pacer、
  // 前台/后台优先级队列、drain 时间预算和 backlog 上限，避免 5ms 定时器导致的
  // 脉冲式输出写入和渲染帧率波动。

  // —— 数据写通道订阅（直接订阅 channel.onData）——
  // 主进程 emitData 的 5ms 聚合 + 渲染端二次聚合，双层减少 IPC 消息量和 term.write() 调用次数。
  private stopBuffering: (() => void) | null = null;

  // —— resize（对齐 VS Code TerminalResizeDebouncer 分轴防抖）——
  private resizeDebouncer: TerminalResizeDebouncer | null = null;

  // —— 装饰 / 导航（对齐 VS Code DecorationAddon / MarkNavigationAddon）——
  private decorationAddon: DecorationAddon | null = null;
  private markNavigationAddon: MarkNavigationAddon | null = null;

  // —— shell integration capability（对齐 VS Code CommandDetectionCapability / CwdDetectionCapability）——
  // 消费注入脚本发的 OSC 633 序列：命令生命周期 + 可信 cwd 检测。
  private caps: TerminalCapabilityStore | null = null;
  private searchAddon: SearchAddon | null = null;
  private serializeAddon: SerializeAddon | null = null;
  // 终端内链接 provider 的反注册函数（对齐 VS Code registerLinkProvider 的 IDisposable）。
  private linkProviderDisposable: { dispose: () => void } | null = null;
  // 链接 hover 缓存重置的反注册函数（输出落地后自动清除缓存，使新 URL 立即可链接化）。
  private linkifierHoverResetDisposable: { dispose: () => void } | null = null;
  // cwd 变化回调：集成终端把检测到的可信 cwd 回传主进程，驱动侧边栏目录分组实时刷新。
  onCwdChange: ((cwd: string) => void) | null = null;
  // 文件链接点击回调：把命中文件（含行号）回传壳，由文件树/编辑器定位选中（额外于系统打开）。
  onOpenFile: ((path: string, line?: number, col?: number) => void) | null = null;
  // 命令完成回调（供未来「重跑 / 复制命令」等能力使用）。
  onCommandFinished: ((command: string) => void) | null = null;
  // 终端标题变化回调（OSC 0/1/2 标题序列）：xterm 解析 \x1b]0;title\x07 后触发。
  // 供壳更新 tab 标题——pi 扩展的 spinner 标题帧依赖此回调才能显示（见 pi-desktop-sync-source）。
  onTitleChange: ((title: string) => void) | null = null;
  // 代理状态变化回调：代理开始工作（spinner 启动）。
  onAgentBecameWorking: (() => void) | null = null;
  // 代理状态变化回调：代理变为空闲（spinner 停止）。
  onAgentBecameIdle: (() => void) | null = null;
  // 侧效果处理器实例（标题/铃声/代理状态聚合、批内去重、微任务调度 flush）。
  private outputProcessor: PtyOutputProcessor | null = null;

  // 最近一次 xterm 解析到的标题（OSC 0/1/2），供 getTitle() 查询。
  private _latestTitle: string | null = null;

  // —— 写前/写后通知（对齐 VS Code TerminalInstance._onWillData / _onData）——
  // 外部消费者可在 onWillData 中保存滚动状态、在 onData 中恢复。
  onWillData: ((data: string) => void) | null = null;
  onData: ((data: string) => void) | null = null;

  // —— 铃响 / 选区变化 / 缓冲区变化（对齐 VS Code onBell / onSelectionChange / onBufferChange）——
  /** 铃响回调：终端发出 BEL 时触发，供壳播放提示音或视觉指示。 */
  onBell: (() => void) | null = null;
  /** 选区变化回调：选区变化时触发，供壳更新菜单状态（复制按钮可用性等）。 */
  onSelectionChange: (() => void) | null = null;
  /** 缓冲区变化回调：alt/normal buffer 切换时触发，供壳更新状态栏/上下文键。 */
  onBufferChange: ((bufferType: 'normal' | 'alt') => void) | null = null;

  /** 获取底层 xterm Terminal 实例。供 scroll-visibility-memory 等外部模块只读访问。 */
  get rawTerminal(): Terminal | null {
    return this.term;
  }

  // —— 写完成确认（对齐 VS Code _flushXtermData 的「已写入=已解析」闸门）——
  private _latestWriteSeq = 0;
  private _latestParsedSeq = 0;
  // 背压累积缓冲（对齐 VS Code AckDataBufferer 独立类）：累积 xterm.write 回调上报的已消费字符数，
  // 达到 CharCountAckSize 阈值时一次性发送 ack IPC，减少高频小段通信量。
  private ackBufferer: AckDataBufferer | null = null;
  private _flushTimer: ReturnType<typeof setTimeout> | null = null;

  // —— 写完成 Promise（对齐 VS Code IProcessDataEvent.writePromise）——
  // 由 _writeProcessData 在 trackCommit=true 时设置，供 flush() 等待实际输出被 xterm 解析完成。
  // 替代此前 (this as any)._pendingWritePromise 的类型 hack。
  private _pendingWritePromise: Promise<void> | undefined;

  // —— 反注册函数 ——
  private offExit: (() => void) | null = null;
  // 主题 / 字号变更不再由本实例订阅（见 lib/terminal-registry 单点订阅刷新所有存活实例），
  // 故无 offTheme / offFontSize 字段，mount 时经 registerTerminal 登记、unmount 时 unregister。
  // 滚动状态回调：视口是否贴底变化时通知 React 壳（驱动「跳到底部」浮钮显隐）。
  onScrollState: ((atBottom: boolean) => void) | null = null;
  // 最近一次通知给壳的贴底状态（避免重复回调）。
  private _lastAtBottom = true;

  // 键盘快捷键处理器（Ctrl/Cmd+V 粘贴、Ctrl/Cmd+Shift+C 复制、Ctrl/Cmd+A 全选）。
  // 绑定在 host 上，卸载时解绑（见 unmount）。
  private _keydownHandler: ((e: KeyboardEvent) => void) | null = null;

  // 拖拽文件落终端：dragover / drop 处理器（绑定在 host，卸载时解绑，见 unmount）。
  // 拖入文件时把绝对路径转义拼接后粘贴（对齐 VS Code 拖拽文件语义）。
  private _dragOverHandler: ((e: DragEvent) => void) | null = null;
  private _dropHandler: ((e: DragEvent) => void) | null = null;

  // 最近一次计算出的 cols/rows，仅在真变时才通知 PTY（对齐 VS Code 整数比较、避免无谓 resize）。
  private _lastCols = 0;
  private _lastRows = 0;

  // 物理滚轮检测 wheel 事件处理器引用（unmount 时清理，对齐 VS Code MouseWheelClassifier）。
  private _wheelHandler: ((e: globalThis.WheelEvent) => void) | null = null;

  // 用户平滑滚动偏好（来自设置面板），wheel handler 必须尊重此偏好，
  // 不可在物理滚轮检测时自动覆盖。默认 false（不启用平滑滚动）。
  private _smoothScrolling = false;

  // 用户 GPU 加速模式（来自设置面板）。'auto' 自动探测，'on' 强制 WebGL，'off' 强制 DOM。
  // 默认 'auto'。enableWebgl() 决策时优先尊重此偏好。
  private _gpuAcceleration: 'auto' | 'on' | 'off' = getGpuAcceleration();

  // 用户自定义字形偏好（来自设置面板）。默认 true（对齐 VS Code 默认）。
  private _customGlyphs = getCustomGlyphs();

  // 结构重放协调器：清屏/重放时保护滚动意图，确保视口位置精确恢复到用户阅读位置。
  private replayCoordinator: TerminalStructuralReplayCoordinator | null = null;

  // 打字时隐藏鼠标的 disposable（在 _initXterm 中安装，unmount 时释放）。
  private _mouseHideDisposable: { dispose: () => void } | null = null;

  // DOM 事件驱动的滚动意图跟踪的反注册函数（在 _initXterm 末尾挂载，unmount 时释放）。
  private _scrollIntentTrackingDisposable: { dispose: () => void } | null = null;

  // —— 已移除：_fixTuiScrollbarWideChars 异步注入 CUP 序列会干扰 pi-tui 的差分渲染光标状态，
  // 导致光标位置错位和内容重叠。由 pi-tui 自身处理其滚动条宽字符。


  constructor(opts: XtermTerminalOptions) {
    this.sessionKey = opts.sessionKey;
    // channel 优先；省略时回退为 SessionChannel（与重构前 XtermTerminal 直接调 pi 的会话
    // 数据流行为完全等价）。TerminalPane 等新版调用方显式注入 channel。
    this.channel =
      opts.channel ?? new SessionChannel(opts.pi, opts.sessionKey);
    // 保留 pi 引用仅用于「非会话数据流」功能：剪贴板图片落盘(saveImage)、拖拽文件路径解析
    // (getPathForFile)、写后背压回传(acknowledgeDataEvent)。所有 PTY 输入/输出/退出/resize
    // 数据通信均改走 this.channel（见 terminalChannel.ts）。
    this.pi = opts.pi;

    // 创建结构重放协调器（terminal 引用在 _initXterm 中设置）
    this.replayCoordinator = new TerminalStructuralReplayCoordinator();
  }

  /**
   * 在首次进入 active 且 host 就绪时挂载终端：构造 xterm、装载 addons、open、锁定渲染器、绑定 IPC。
   * 与 VS Code XtermTerminal._initialization 等价（构造 → loadAddon 系列 → open → webgl）。
   * keep-alive：仅在首次进入时调用一次；后续 active 切换走 setActive，不重建实例。
   */
  mount(host: HTMLElement): void {
    if (this.mounted) return;
    this.host = host;
    this.mounted = true;
    this._initXterm(host);
    this.active = true;
    // 登记到存活终端注册表：主题/字号全局变更由 registry 单点订阅后统一刷新本实例
    // （见 lib/terminal-registry），无需本实例各自订阅 onThemeChange/onFontSizeChange。
    registerTerminal(this);
  }

  /**
   * keep-alive：active 切换时调用，不销毁实例（对齐 VS Code terminalInstance.setVisible）。
   * active=false 时仅标记不可见；active=true 时恢复并立即 refit（对齐 VS Code setVisible 的
   * doResize(true)），使切回的终端即时用最新尺寸渲染，消除切 tab 回来的
   * 首帧尺寸跳变闪烁。
   */
  setActive(active: boolean): void {
    if (this.active === active) return;
    this.active = active;
    if (active && this.host && this.term && !this.disposed) {
      // 可见时尝试重建 WebGL 渲染器（上下文丢失或此前附加失败后）
      this.retryWebglIfNeeded();
      // 关键：先清除 xterm RenderService 的暂停标记（隐藏期由 IntersectionObserver 置位）。
      // 若跳过此步，doResize 的 term.resize() 在暂停状态下不会重绘 canvas，用户会看到
      // 旧帧/单列/黑屏，直到 _flushAndRender 的异步延迟刷新才恢复（对齐 VS Code setVisible
      // 中 setVisible → _resize 的同步重绘语义）。forceRepaintThroughRenderPause 幂等，
      // 后续 _flushAndRender 再调一次也无副作用。
      forceRepaintThroughRenderPause(this.term);
      // 同步校准尺寸（此时 RenderService 已恢复，resize 立即触发 canvas 重绘）
      this.doResize(true);
      // 异步等待所有 pending 的 term.write() 被解析完成，再执行渲染。
      // 这样隐藏期间累积的写入数据在可见时正确渲染，避免"旧帧残留"。
      this._flushAndRender().catch(() => { /* fire-and-forget */ });
      // 强制执行当前滚动意图，确保切回可见时视口位置正确
      enforceTerminalCurrentScrollIntent(this.term);
      // 注意：不再调度图集恢复（此前由 scheduleTabRevealWebglAtlasRecovery 触发）。
      // _flushAndRender() 已通过 refresh + forceRepaintThroughRenderPause 完成全屏刷新，
      // 在此之上再触发一次 atlas clear + refresh 会导致 100ms 内的双重全屏闪烁。
    }
  }

  /**
   * 等待所有待写入的 term.write() 被 xterm 解析完成，再执行强制渲染穿透暂停。
   *
   * 当 tab 从非 active 切回 active 时，隐藏期间累积的 term.write() 调用可能尚未
   * 被 xterm 解析完成，若直接渲染会导致"旧帧残留"——用户看到的是隐藏前的缓冲区状态，
   * 而非最新输出。
   *
   * 先 flush() 确保所有 pending 写入被解析完成（通过 await _pendingWritePromise +
   * 轮询 _latestWriteSeq === _latestParsedSeq），再执行 refresh + forceRepaint。
   * resize 已由 caller（setActive）同步完成，无需在此重复。
   *
   * 使用 fire-and-forget 模式：setActive 保持同步返回，不阻塞 caller。
   */
  private async _flushAndRender(): Promise<void> {
    // 1. 等待所有 pending 的 term.write() 被 xterm 解析完成
    await this.flush();

    // 2. 再次检查生命周期状态（flush 期间可能被 unmount 或切走）
    if (this.disposed || !this.active || !this.term || !this.host) return;

    // 3. 清除 RenderService 暂停状态（flush 后缓冲区已包含最新数据，
    //    但 RenderService 可能仍处于暂停状态，需先清除暂停标记）
    forceRepaintThroughRenderPause(this.term);

    // 4. 双 rAF settle 刷新：第一帧等待布局稳定，第二帧执行 refresh。
    //    避免同步刷新导致的同帧全屏闪烁。
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (this.disposed || !this.term) return;
        try { this.term.refresh(0, this.term.rows - 1); } catch { /* 渲染器未就绪边界 */ }
      });
    });
  }

  /** 非 active / 卸载时销毁终端，释放所有监听与定时器。
   * 在销毁前 flush 剩余 ack 字符，确保主进程背压控制器水位准确。
   * 对齐 VS Code clearUnacknowledgedChars + dispose 语义：
   * 先 flush 剩余 ack，再 dispose ackBufferer（强制 resume PTY 避免 inflight 不归零）。 */
  unmount(): void {
    // 丢弃调度器中待处理的输出（需要 this.term 仍有效），再标记 disposed
    if (this.term) {
      discardQueuedOutput(this.term);
    }
    this.disposed = true;
    // 侧效果处理器：先 flush 尾部侧效果（标题/铃声/状态回调不丢失），再销毁。
    this.outputProcessor?.dispose();
    this.outputProcessor = null;
    // 对齐 VS Code：先 flush 待写数据，确保所有写入完成
    this.ackBufferer?.flush();
    this.ackBufferer?.dispose();
    this.ackBufferer = null;
    if (this._flushTimer != null) clearTimeout(this._flushTimer);
    this._flushTimer = null;
    this._pendingWritePromise = undefined;
    this.stopBuffering?.();
    this.stopBuffering = null;
    this.resizeDebouncer?.dispose();
    this.resizeDebouncer = null;

    this.webglContextLost = false;
    this.webglDisabledAfterContextLoss = false;
    this.webglAttachFailed = false;
    this.webgl = null;
    this.decorationAddon?.dispose();
    this.decorationAddon = null;
    this.markNavigationAddon?.dispose();
    this.markNavigationAddon = null;
    this.searchAddon?.dispose();
    this.searchAddon = null;
    this.serializeAddon?.dispose();
    this.serializeAddon = null;
    this.linkProviderDisposable?.dispose();
    this.linkProviderDisposable = null;
    this.linkifierHoverResetDisposable?.dispose();
    this.linkifierHoverResetDisposable = null;
    this.caps = null;
    this.offExit?.();
    this.offExit = null;
    // 主题/字号刷新生效于存活实例（registry 单点订阅），故 unmount 时只需从注册表注销，
    // 不再持有本实例的 offTheme/offFontSize 反注册（避免重复订阅导致的不一致）。
    unregisterTerminal(this);
    // 键盘快捷键走 xterm attachCustomKeyEventHandler，term.dispose 时随实例清理；
    // 这里只清幂等标记，无需手动 removeEventListener（已不再绑 host）。
    this._keydownHandler = null;
    // 拖拽监听绑在 host 上，需手动解绑（否则 host 复用/移除时泄漏）。
    if (this.host && this._dragOverHandler && this._dropHandler) {
      this.host.removeEventListener('dragover', this._dragOverHandler);
      this.host.removeEventListener('drop', this._dropHandler as EventListener);
    }
    this._dragOverHandler = null;
    this._dropHandler = null;
    // 物理滚轮 wheel 事件处理器解绑（对齐 VS Code MouseWheelClassifier）。
    if (this._wheelHandler && this.term?.element) {
      this.term.element.removeEventListener('wheel', this._wheelHandler);
      this._wheelHandler = null;
    }
    // 释放 DOM 事件驱动的滚动意图跟踪
    this._scrollIntentTrackingDisposable?.dispose();
    this._scrollIntentTrackingDisposable = null;
    // 治本：显式释放 WebGL context，避免关闭 tab 卸载实例时 context 泄漏累积。
    // @xterm/addon-webgl 的 dispose() 不调用 WEBGL_lose_context.loseContext()，导致浏览器
    // WebGL context 上限（~16）到达后，新实例 new WebglAddon() 创建失败、降级为 DOM 渲染器；
    // 而 .xterm-viewport 在 DOM 模式下 overflow-y:hidden 禁用了滚动 → “不能滚动”。
    // 使用 releaseWebglContext 通过内部渲染器获取 context 并 loseContext，同时将 canvas
    // 尺寸设为 0 确保 ANGLE 驱动层释放。
    this.releaseWebglContext();
    // 释放打字时隐藏鼠标的监听器
    this._mouseHideDisposable?.dispose();
    this._mouseHideDisposable = null;

    // 释放结构重放协调器：中断正在执行的任务并清空队列
    this.replayCoordinator?.dispose();
    this.replayCoordinator = null;

    // 丢弃飞行中 ACK 信用：确保在 dispose 前释放所有未解析的写 ACK，
    // 避免因回调永不触发而泄漏主进程的背压窗口。
    if (this.term) {
      discardInFlightTerminalOutputAckCredits(this.term);
    }
    try {
      this.term?.dispose();
    } catch {
      /* 已销毁 */
    }
    this.term = null;
    this.fit = null;
    this.opened = false;
    this.mounted = false;
    this.host = null;
  }

  /**
   * 写完成确认（对齐 VS Code _flushXtermData）：轮询确认所有已 term.write 的数据都被 xterm
   * 解析完（_latestWriteSeq === _latestParsedSeq），最多重试 5 次 × 20ms。
   * 在会话结束/卸载前 await，避免尾部帧撕裂或丢失。
   * resolve 前 flush 剩余 ack 字符，确保主进程背压控制器水位准确。
   *
   * 对齐 VS Code IProcessDataEvent.writePromise：若有待完成的 writePromise（来自最近一段
   * trackCommit=true 的写入），先 await 它，确保实际输出已被 xterm 解析完成。
   *
   * 对齐 VS Code _flushXtermData 的轮询策略：使用 20ms 间隔、最多 5 次重试。
   * 不同于 setTimeout 的开销，用 setInterval 避免每次重试重新创建定时器，
   * 消除在高速写入时 flush 被尾部写入不断推迟的竞态窗口。
   */
  async flush(): Promise<void> {
    // 对齐 VS Code：先 await 最近一段 trackCommit 写入的 writePromise，
    // 确保实际输出已被 xterm 解析完成，而非仅靠轮询 _latestWriteSeq === _latestParsedSeq。
    const pendingPromise = this._pendingWritePromise;
    if (pendingPromise && !this.disposed) {
      try { await pendingPromise; } catch { /* 写完成 promise 异常忽略 */ }
    }
    this._pendingWritePromise = undefined;

    if (this.disposed || !this.term || this._latestWriteSeq === this._latestParsedSeq) {
      this.ackBufferer?.flush();
      return;
    }
    let retries = 0;
    return new Promise<void>((resolve) => {
      const interval = setInterval(() => {
        if (this.disposed || this._latestWriteSeq === this._latestParsedSeq || ++retries > 5) {
          clearInterval(interval);
          if (this._flushTimer != null) clearTimeout(this._flushTimer);
          this._flushTimer = null;
          this.ackBufferer?.flush();
          resolve();
        }
      }, 20);
    });
  }

  /** 刷出剩余未确认的 ack 字符。
   * 当需要立即发送 ack 时调用（如 unmount/flush 时），确保 ackBufferer 中不足
   * CharCountAckSize 的剩余字符被立即发送，避免尾部 ack 积压。
   * 代理到 ackBufferer.flush()，确保状态单一来源。 */
  private flushAck(): void {
    this.ackBufferer?.flush();
  }

  /**
   * 同帧 RIS 重置（对齐 VS Code SeamlessRelaunch 的 triggerSwap 同帧语义）：发全清序列
   * \x1bc。紧随其后的首段写会在 xterm 同一次重绘中呈现，避免「清屏→旧内容残留→重画」的
   * 中间帧闪。用于会话重置/复用时需要彻底清屏的场景（如 onRelink 后需清旧缓冲）。
   */
  resetSameFrame(): void {
    if (!this.term || this.disposed) return;
    // 通过结构重放协调器执行清屏，确保清屏后滚动意图被保持
    this.replayCoordinator?.run(() => {
      if (!this.term) return;
      // 清屏（RIS）后立即重置光标样式和可见性，避免 TUI 残留的 DECSCUSR/DECTCEM 污染
      this.term.write('\x1bc' + CURSOR_RESET_MINIMAL);
    }).catch(() => { /* fire-and-forget：清屏失败不影响主流程 */ });
  }

  /** 强制重绘：清空 WebGL 纹理图集并触发一次完整重绘（对齐 VS Code forceRedraw/clearTextureAtlas）。
   * 主题切换 / 字体变更后调用，避免 WebGL 下纹理残留导致旧配色/旧字形闪留。无 WebGL 时静默跳过。
   *
   * 使用双 rAF settle：第一帧清 atlas，第二帧 refresh。
   * 避免此前「清 atlas + 立即 refresh」导致的同帧全屏闪烁——
   * 清 atlas 后立即 refresh 会导致所有 glyph 消失再重新出现，产生可见闪烁。
   * 双 rAF 让浏览器在清 atlas 后有一帧的缓冲时间重建纹理，再 refresh 时已有缓存。 */
  forceRedraw(): void {
    if (!this.term || this.disposed || this.webglContextLost) return;
    try {
      this.webgl?.clearTextureAtlas();
    } catch {
      /* DOM 渲染器或无纹理图集时忽略 */
    }
    // 双 rAF settle：第一帧等待纹理重建，第二帧刷新确保新纹理已就绪
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (!this.term || this.disposed) return;
        try {
          this.term.refresh(0, this.term.rows - 1);
        } catch { /* 刷新失败时静默忽略 */ }
      });
    });
  }

  /**
   * 主题切换刷新（由 lib/terminal-registry 单点订阅 onThemeChange 后统一调用）。
   * 运行时重新构造 xterm 主题（背景/前景取当前容器 --bg-app / --text），再 forceRedraw 清
   * WebGL 纹理残留，避免旧配色闪留、确保与容器背景严格一致（对齐 VS Code getBackgroundColor）。
   *
   * 注意：不在此处直接 refresh——forceRedraw 已通过双 rAF settle 处理刷新。
   * 直接 refresh 会在清 atlas 后立即触发全屏闪烁，双 rAF 让浏览器有一帧缓冲。
   */
  applyTheme(family: ThemeFamily, variant: ThemeVariant): void {
    if (!this.term || this.disposed) return;
    this.term.options.theme = getTermTheme(family, variant);
    this.forceRedraw();
  }

  /**
   * 全局字号变化刷新（由 lib/terminal-registry 单点订阅 onFontSizeChange 后统一调用）。
   * 同步 fontSize + resize（cell 度量变化必须重建渲染纹理）+ forceRedraw。
   *
   * 先 resize 再 forceRedraw（双 rAF settle），避免 resize + atlas clear 交织
   * 导致的多次重排和全屏闪烁。
   */
  applyFontSize(size: number): void {
    if (!this.term || this.disposed) return;
    this.term.options.fontSize = size;
    this.doResize(true); // fit + 通知 PTY，对齐窗口尺寸变化时的校准路径。
    this.forceRedraw();
  }

  /** 右键上下文菜单：有选区则复制并清空，否则粘贴（对齐原 handleContextMenu 语义）。
   * 剪贴板读写已由 addon-clipboard 接管（对齐 VS Code 的 ClipboardAddon 装配）；
   * 粘贴直接走 term.paste()，由 addon 从系统剪贴板读取，无需自管 navigator.clipboard。 */
  handleContextMenu(e: { preventDefault: () => void }): void {
    e.preventDefault();
    const term = this.term;
    if (!term) return;
    try {
      if (term.hasSelection()) {
        const text = term.getSelection();
        if (text) navigator.clipboard?.writeText(text).catch(() => {});
        term.clearSelection();
      } else {
        // 无选区：智能粘贴（图片优先，回退文本）。复用 pasteFromClipboard 保证
        // 右键与 Ctrl+V 行为一致（图片落临时文件再粘贴路径，对齐 VS Code 拖拽文件语义）。
        this.pasteFromClipboard().catch(() => {});
      }
    } catch {
      /* 剪贴板不可用（如非安全上下文）时静默跳过 */
    }
  }

  /**
   * 把文本粘贴进终端。直接调用 xterm 的 term.paste()，换行归一化为 \r。
   * bracketed paste 模式由 xterm 的 paste() 内部自动处理（它会在模式开启时自行包裹
   * \x1b[200~...\x1b[201~），**绝不能**在这里手动拼接 escape 序列——否则序列会被当作
   * 字面量发进 PTY，shell 不识别，反而把 `[200~` 原样打印出来（即本次 bug 的根因）。
   */
  pasteText(text: string): void {
    const term = this.term;
    if (!term || this.disposed || !text) return;
    const data = text.replace(/\r?\n/g, '\r');
    term.paste(data);
  }

  /**
   * 绑定「拖文件到终端」交互（在 mount 时调用，绑定到 host DOM）。
   *  - dragover 且 dataTransfer 含 Files：preventDefault + dropEffect='copy'（接管默认拖放，
   *    避免浏览器把文件当导航/下载；非文件拖拽放行，保留终端内拖选）。
   *  - drop 且含 Files：解析每个文件绝对路径（shell-safe 转义、空格拼接）后粘贴（复用 pasteText）。
   * 对齐 VS Code 终端「拖拽文件到终端即插入路径」语义。卸载时由 unmount 解绑。
   */
  private bindDragAndDrop(host: HTMLElement): void {
    if (this._dragOverHandler || this._dropHandler) return; // 幂等
    const onDragOver = (e: DragEvent) => {
      if (!e.dataTransfer) return;
      const types = Array.from(e.dataTransfer.types);
      // 接管两类拖拽：
      //  - 系统文件管理器拖入（types 含 'Files'）；
      //  - 内部文件树节点拖入（自定义 MIME 'application/x-pi-file'）。
      // 文本/其它内部拖拽放行给 xterm。
      if (types.includes('Files') || types.includes(PI_FILE_DRAG_MIME)) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      }
    };
    const onDrop = (e: DragEvent) => {
      if (!e.dataTransfer) return;
      const types = Array.from(e.dataTransfer.types);
      const dt = e.dataTransfer as DataTransfer & { getData?: (t: string) => string };
      // 优先处理内部文件树拖入：直接读绝对路径（已归一化，无需再解析）。
      // 现承载 JSON 数组（多选拖拽）以空白分隔拼接；兼容旧版单字符串。
      // 用可选调用兜底：部分测试/旧环境注入的 dataTransfer 可能无 getData 方法。
      const piFile = typeof dt.getData === 'function' ? dt.getData(PI_FILE_DRAG_MIME) : '';
      if (piFile) {
        e.preventDefault();
        let paths: string[] = [];
        try {
          const parsed = JSON.parse(piFile);
          if (Array.isArray(parsed)) paths = parsed.filter((p) => typeof p === 'string');
          else if (typeof parsed === 'string') paths = [parsed];
        } catch {
          // 非 JSON：视为单路径（旧版格式）
          paths = [piFile];
        }
        if (paths.length) {
          const joined = paths.map((p) => this._shellQuote(p)).join(' ');
          this.pasteText(joined);
          // 拖拽落盘后把焦点转移到终端，使其可直接键盘输入（对齐 VS Code）。
          this.term?.focus();
        }
        return;
      }
      // 回退到系统文件管理器拖入（Files）。
      if (!types.includes('Files')) return;
      e.preventDefault();
      const files = Array.from(e.dataTransfer.files ?? []);
      if (!files.length) return;
      this.pasteDroppedFiles(files)
        .catch(() => {})
        .finally(() => this.term?.focus());
    };
    this._dragOverHandler = onDragOver;
    this._dropHandler = onDrop;
    host.addEventListener('dragover', onDragOver);
    host.addEventListener('drop', onDrop as EventListener);
  }

  /**
   * 把拖入的文件列表转成可粘贴的路径串并粘贴（对齐 VS Code 拖拽文件语义）：
   *  - 每个文件必须用【绝对路径】——经 pi.getPathForFile（Electron 31+ 官方 API，同步回绝对路径）
   *    解析；兼容旧 Electron 的 File.path（若 getPathForFile 不可用）。
   *  - 图片也直接用原图绝对路径（不经 saveImage 落临时文件，与 Ctrl+V 图片分支区分）；
   *  - 拿不到绝对路径的文件直接跳过（绝不退化成相对/裸文件名，违背「都用绝对路径」的硬要求）；
   *  - 路径含空格/特殊字符时用双引号包裹（shell-safe）；
   *  - 多个文件用空格拼接，一次性粘贴。
   */
  private async pasteDroppedFiles(files: File[]): Promise<void> {
    const parts: string[] = [];
    for (const f of files) {
      // 绝对路径来源（优先级：webUtils.getPathForFile > 旧版 File.path）。
      let p: string | undefined;
      try {
        p = this.pi.getPathForFile?.(f);
      } catch {
        p = undefined;
      }
      if (!p && (f as any).path) p = (f as any).path as string;
      if (typeof p === 'string' && p) parts.push(this._shellQuote(p));
      // 拿不到绝对路径：跳过该文件（不插入裸文件名）。
    }
    const joined = parts.join(' ');
    if (joined) this.pasteText(joined);
  }

  /** shell-safe 引用：路径含空格或 shell 元字符时用双引号包裹（引号本身转义）。
   * 对齐 VS Code 拖拽文件时对路径的 shellQuoted 处理。 */
  private _shellQuote(p: string): string {
    return /\s|["'`$&|;<>()*?{}\\[\]]/.test(p) ? `"${p.replace(/"/g, '\\"')}"` : p;
  }

  /**
   * 智能粘贴：优先粘贴图片（剪贴板含 image 类型时，把图片落临时文件再粘贴其路径，
   * 模拟 VS Code「拖拽文件到终端」行为）；否则回退到文本粘贴。
   * 对齐 VS Code 终端不支持在 PTY 内渲染图片数据的事实——只接收文件路径。
   */
  async pasteFromClipboard(): Promise<void> {
    const term = this.term;
    if (!term || this.disposed) return;
    try {
      // 优先探测图片：navigator.clipboard.read 返回带类型的 ClipboardItem。
      const items = await (navigator.clipboard as any)?.read?.();
      if (Array.isArray(items)) {
        for (const item of items) {
          const type = item.types?.find((t: string) => t.startsWith('image/'));
          if (type) {
            const blob: Blob = await item.getType(type);
            const ext = type.split('/')[1] || 'png';
            const base64 = await this._blobToBase64(blob);
            const filePath = await this.pi.saveImage?.(base64, ext);
            if (filePath) {
              this.pasteText(filePath);
              return;
            }
          }
        }
      }
    } catch {
      /* 剪贴板读取不可用 / 非安全上下文：回退文本粘贴 */
    }
    // 文本路径：从系统剪贴板读文本并粘贴（bracketed paste 包裹在 pasteText 内完成）。
    const text = await navigator.clipboard?.readText();
    if (text) this.pasteText(text);
  }

  /** Blob → base64（不含 data: 前缀）。用于把剪贴板图片送主进程落盘。 */
  private _blobToBase64(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error);
      reader.onloadend = () => {
        const result = reader.result as string;
        const comma = result.indexOf(',');
        resolve(comma >= 0 ? result.slice(comma + 1) : result);
      };
      reader.readAsDataURL(blob);
    });
  }

  /** 复制当前选区（对齐 VS Code copySelection）；无选区时不动作。 */
  copySelection(): void {
    const term = this.term;
    if (!term || this.disposed || !term.hasSelection()) return;
    const text = term.getSelection();
    if (text) navigator.clipboard?.writeText(text).catch(() => {});
  }

  /** 全选（对齐 VS Code selectAll）。 */
  selectAll(): void {
    const term = this.term;
    if (!term || this.disposed) return;
    term.focus();
    term.selectAll();
  }

  /** 清除选区（对齐 VS Code clearSelection）。 */
  clearSelection(): void {
    this.term?.clearSelection();
  }

  /** 获取当前终端标题（xterm 最近解析到的 OSC 0/1/2 标题；尚未收到任何标题序列时为 null）。
   * 供壳在未设置 onTitleChange 回调时主动查询标题。 */
  getTitle(): string | null {
    return this._latestTitle;
  }

  /**
   * 绑定键盘快捷键（在 mount 时调用，用 xterm 的 attachCustomKeyEventHandler 拦截——
   * 这是 xterm 在所有按键处理“之前”的官方拦截点，先于 xterm 把 Ctrl+V 当 \x16 输入，
   * 命中即返回 false 阻止默认输入，从而让粘贴/复制/全选走我们的逻辑）。
   *   - Ctrl/Cmd+V：智能粘贴（图片优先，回退文本）
   *   - Ctrl/Cmd+Shift+C：复制选区
   *   - Ctrl/Cmd+A：全选
   *   - Shift+Enter：软换行（仅写入 \n 续行，不提交执行；必须在无 Ctrl/Cmd
   *     修饰时命中，故逻辑位于 Ctrl/Cmd 组合键守卫之前）。
   * 注意：bind 在 host 的 keydown 会“晚于”xterm 在 textarea 层的默认处理，导致真实 Ctrl+V
   * 已被 xterm 转成 \x16 输入（见 e2e 复现），故必须用 attachCustomKeyEventHandler。
   */
  private bindKeyShortcuts(_host: HTMLElement): void {
    const term = this.term;
    if (!term || this._keydownHandler) return;
    this._keydownHandler = () => {}; // 幂等标记：已绑定
    const handler = (e: KeyboardEvent): boolean => {
      if (e.type !== 'keydown') return true;
      const mod = e.ctrlKey || e.metaKey; // Ctrl（Win/Linux）或 Cmd（mac）
      const key = e.key.toLowerCase();
      // Shift+Enter：软换行（仅续行、不提交）。必须“无 Ctrl/Cmd 修饰”才命中，
      // 否则会与各类带修饰的 Enter 组合（如终端某些绑定的 Ctrl+Enter）冲突。
      // 注意：此分支必须在 `if (!mod) return true` 之前，因为 Shift+Enter 不带
      // Ctrl/Cmd，否则会被提前放行而失效。
      // 关键：不能 term.write('\n')——term.write 写入的是 PTY 输出方向（stdout），
      // 运行在 PTY 里的程序（如 pi 编辑器）收不到，只会视觉换行。必须走输入通道
      // pi.input（→ 主进程 pty.write，PTY 输入方向/stdin），与正常按键经 term.onData
      // → pi.input 完全一致。写 \n（LF）而非默认 Enter 的 \r（CR）：readline/bash/zsh
      // 把 LF 当续行收集、CR 才提交，从而在不执行命令的前提下插入换行。
      if (e.key === 'Enter' && e.shiftKey && !mod && !e.altKey) {
        e.preventDefault();
        this.channel.send('\n');
        return false; // 阻止 xterm 把 Enter 当 \r 经 onData 再次送出
      }
      if (!mod) return true;
      // Ctrl/Cmd+V：粘贴（图片优先，回退文本）
      if (key === 'v' && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        this.pasteFromClipboard().catch(() => {});
        return false; // 阻止 xterm 把 Ctrl+V 当 \x16 输入
      }
      // Ctrl/Cmd+Shift+C：复制选区（仅精确组合，避免吞掉普通 Ctrl+C）
      if (key === 'c' && e.shiftKey && !e.altKey) {
        e.preventDefault();
        this.copySelection();
        return false;
      }
      // Ctrl/Cmd+A：全选
      if (key === 'a' && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        this.selectAll();
        return false;
      }
      return true;
    };
    // 存一份供单测直接验证拦截逻辑（生产无副作用）
    (this as any)._customKeyHandler = handler;
    term.attachCustomKeyEventHandler(handler);
  }

  /** 窗口/侧边栏 resize 时由壳的 ResizeObserver 调用，执行直接 refit。
   * 防抖由壳的 ResizeObserver 150ms 处理，此处直接执行 resize。 */
  scheduleResize(): void {
    this.doResize(false);
  }

  /** 立即 fit（同步预绘制路径）：跳过防抖，直接执行 fit + PTY 通知。
   * 由 SYNC_FIT_PANES_EVENT 的监听器在 useLayoutEffect 中调用，
   * 确保终端在浏览器绘制前同步到新容器尺寸，消除 ~16ms 尺寸跳变闪烁。 */
  fitImmediate(): void {
    this.doResize(true);
  }

  // —— 装饰 / 导航（对齐 VS Code DecorationAddon / MarkNavigationAddon）——
  /** 注册一行覆盖层装饰（对齐 VS Code DecorationAddon.registerCommandDecoration 的差分 overlay）。
   * 装饰由 marker 锚定到 buffer 行，渲染为 DOM 覆盖层，命令状态变化只更新 overlay 而不进 VT 流。
   * @param marker 锚定到某 buffer 行的标记
   * @param opts 装饰呈现选项（背景/前景色、overview ruler、宽高、anchor）
   * @returns 已注册的 IDecoration，或 undefined（无 term / marker 失效）。可保存用于后续 dispose。 */
  registerLineDecoration(marker: IMarker, opts: IDecorationOptions): IDecoration | undefined {
    if (!this.term || this.disposed || !this.decorationAddon) return undefined;
    try {
      return this.decorationAddon.registerCommandDecoration({ marker }, false, { marker });
    } catch {
      return undefined;
    }
  }

  /** 注册一条 mark 装饰（gutter/overview-ruler）。 */
  registerMarkDecoration(marker: IMarker): IDecoration | undefined {
    if (!this.term || this.disposed || !this.decorationAddon) return undefined;
    try {
      return this.decorationAddon.registerMarkDecoration({ marker });
    } catch {
      return undefined;
    }
  }

  /** 清除全部行覆盖层装饰（对齐 VS Code DecorationAddon.clearDecorations）。命令状态重置/会话清屏时调用。 */
  clearDecorations(): void {
    this.decorationAddon?.clearDecorations();
  }

  /** 滚动到指定 buffer 行（对齐 VS Code MarkNavigationAddon.scrollToLine）。
   * 装饰点击/错误跳转等场景调用，把视口带到目标行。 */
  scrollToLine(line: number): void {
    this.markNavigationAddon?.scrollToLine(line);
  }

  /** 跳到底部：把视口滚动到最新输出（对齐 VS Code 终端视口贴底）。同时通知壳隐藏浮钮。
   * 由 React 壳的「跳到底部」浮钮点击调用。 */
  scrollToBottom(): void {
    if (!this.term || this.disposed) return;
    this.term.scrollToBottom();
    this.notifyScrollState();
  }

  /**
   * 保存当前滚动位置的全量快照（对齐 Orca captureScrollState）。
   * 委托给 scroll.ts 模块，使用 IMarker 做精确逻辑行跟踪。
   * 返回 ScrollState 类型（来自 scroll.ts），包含物理标记和逻辑行标记。
   */
  captureScrollState(): ScrollState | null {
    if (!this.term || this.disposed) return null;
    return captureScrollStateModule(this.term);
  }

  /**
   * 恢复滚动位置（对齐 Orca restoreTerminalStructuralScrollIntent）。
   * 委托给 scroll.ts 模块，优先用 marker（精确），marker 失效后回退到绝对行号。
   * 如果 wasAtBottom 为 true 或计算后目标行超出范围，scrollToBottom。
   */
  restoreScrollState(state: ScrollState | null): void {
    if (!this.term || this.disposed || !state) return;
    restoreScrollStateModule(this.term, state);
  }

  /** 终端内查找：前/后搜索（对齐 VS Code XtermTerminal.findNext/findPrevious + SearchAddon）。
   * 由 React 壳的查找面板调用；首次调用时 searchAddon 已在 mount 预装载。
   * @returns 是否命中（驱动面板显示「无结果」）。 */
  findNext(termStr: string, options?: { regex?: boolean; caseSensitive?: boolean; wholeWord?: boolean }): boolean {
    if (!this.searchAddon || this.disposed) return false;
    return this.searchAddon.findNext(termStr, {
      regex: options?.regex ?? false,
      caseSensitive: options?.caseSensitive ?? false,
      wholeWord: options?.wholeWord ?? false,
    });
  }
  findPrevious(termStr: string, options?: { regex?: boolean; caseSensitive?: boolean; wholeWord?: boolean }): boolean {
    if (!this.searchAddon || this.disposed) return false;
    return this.searchAddon.findPrevious(termStr, {
      regex: options?.regex ?? false,
      caseSensitive: options?.caseSensitive ?? false,
      wholeWord: options?.wholeWord ?? false,
    });
  }

  /** 序列化当前滚动缓冲区（对齐 VS Code SerializeAddon + XtermSerializer）。
   * 返回可 replay 的 VT 数据流字符串；未装载序列化 addon 时返回 null。 */
  serializeScrollback(): string | null {
    if (!this.serializeAddon || this.disposed || !this.term) return null;
    try {
      return this.serializeAddon.serialize({ scrollback: (this.term as any).options?.scrollback ?? getScrollback() });
    } catch {
      return null;
    }
  }

  /** 还原滚动缓冲区（对齐 VS Code triggerReplay / reviveTerminalProcesses 的 initialText replay）。
   * 把 serializeScrollback 产出的 VT 数据流重新写回终端。仅在 mount 后、首次数据到达前调用。 */
  restoreScrollback(data: string): void {
    if (!data || this.disposed || !this.term) return;
    // 通过结构重放协调器执行重放，确保重放后滚动意图被保持
    this.replayCoordinator?.run(() => {
      if (!this.term || this.disposed) return;
      try {
        // 在重放数据后追加光标重置序列，确保 scrollback 中 TUI 残留的
        // DECSCUSR 光标样式覆盖（如 \x1b[2 q）和 \x1b[?25l 光标隐藏被清除。
        this.term.write(data + CURSOR_RESET_MINIMAL);
      } catch {
        /* 还原失败忽略 */
      }
    }).catch(() => { /* fire-and-forget：重放失败不影响主流程 */ });
  }

  /** 统一的链接激活逻辑：仅 Ctrl/Cmd+左键才激活，按 scheme 分发打开。
   * 供 WebLinksAddon（普通 URL）与 Terminal linkHandler（OSC 8 超链接）共用。 */
  private _handleLinkActivate(event: MouseEvent, url: string): void {
    // 检查修饰键（Ctrl/Cmd+click 才激活）
    if (!event || !(event.ctrlKey || event.metaKey)) return;
    // 提取 scheme 判断类型
    const colonIdx = url.indexOf(':');
    if (colonIdx === -1) return;
    const scheme = url.substring(0, colonIdx);
    // file:// 链接：走文件打开
    if (scheme === 'file') {
      const path = decodeURIComponent(url.slice('file://'.length));
      if (this.onOpenFile) {
        this.onOpenFile(path);
      } else {
        this.pi.fsOpenWithSystem?.(path).catch(() => {});
      }
      return;
    }
    // http/https/mailto 等：走 pi.openExternal（主进程 child_process.exec 打开默认浏览器）
    this.pi.openExternal(url).catch(() => {});
  }

  /** 链接 hover 提示：显示「ctrl+左键 打开链接」工具提示（复用 .terminal-link-tooltip CSS 类）。 */
  private _showLinkTooltip(event: MouseEvent): void {
    const doc = document;
    const existing = doc.querySelector('.terminal-link-tooltip');
    if (existing) existing.remove();

    const tooltip = doc.createElement('div');
    tooltip.className = 'terminal-link-tooltip';
    tooltip.textContent = 'ctrl+左键 打开链接';
    tooltip.style.left = `${event.clientX}px`;
    tooltip.style.top = `${event.clientY - 28}px`;
    doc.body.appendChild(tooltip);
    requestAnimationFrame(() => {
      tooltip.style.opacity = '1';
    });
  }

  /** 链接 hover 离开：移除工具提示。 */
  private _hideLinkTooltip(): void {
    const tooltip = document.querySelector('.terminal-link-tooltip');
    if (tooltip) tooltip.remove();
  }

  /** 加载 WebLinksAddon（@xterm/addon-web-links）：检测终端输出中的普通 URL 并使其可点击。
   * 鼠标悬停时显示下划线和「ctrl+左键」工具提示，Ctrl+click 在系统默认浏览器中打开。
   * 返回反注册函数（unmount 时调用）。 */
  private _loadWebLinksAddon(term: Terminal): { dispose: () => void } {
    const addon = new WebLinksAddon(
      (event: MouseEvent, url: string) => this._handleLinkActivate(event, url),
      {
        hover: (event: MouseEvent) => this._showLinkTooltip(event),
        leave: () => this._hideLinkTooltip(),
      },
    );
    term.loadAddon(addon);
    return addon;
  }

  /** 当前视口是否贴底（对齐 VS Code：viewportY >= baseY 即贴底）。xterm 6 WebGL 下
   * scrollTop 恒为 0，故用 buffer 的 viewportY/baseY 判定，而非 DOM 原生 scroll。
   * 注意：VSCode 用 `viewportY >= baseY`（非 `baseY - 1`），以确保「新建终端/清屏后」
   * 首次输出时 scrollState 正确为贴底，避免浮钮误显。 */
  private isAtBottom(): boolean {
    const buf = (this.term as any)?.buffer?.active;
    if (!buf) return true;
    return buf.viewportY >= buf.baseY;
  }

  /** 视口贴底状态变化时通知 React 壳（驱动浮钮显隐），仅在状态翻转时回调以省渲染。 */
  private notifyScrollState(): void {
    if (!this.onScrollState) return;
    const atBottom = this.isAtBottom();
    if (atBottom === this._lastAtBottom) return;
    this._lastAtBottom = atBottom;
    this.onScrollState(atBottom);
  }



  // —— 私有实现 ——

  /** 构造 xterm、装载 addons、open、锁定渲染器、绑定 IPC（mount 内部调用一次）。 */
  private _initXterm(host: HTMLElement): void {
    const term = new Terminal({
      allowProposedApi: true, // 启用提案 API（pi-tui 使用同步输出 ?2026 APM 序列所需）
      // 初始维度：VS Code 构造时即传入 cols/rows，避免 0 尺寸下的首帧测量异常；
      // 随后由 doResize(true) 用 FitAddon 测量宿主尺寸对齐。
      cols: 80,
      rows: 24,
      // Alt+点击移动光标：对齐 VS Code 默认 false（依赖 multiCursorModifier，本应用无此绑定）。
      altClickMovesCursor: false,
      // 日志级别：对齐 VS Code 精神（生产按日志级别收敛），'off' 避免 xterm 内部 console 噪音。
      logLevel: 'off',
      // 不开启 convertEol。PTY 已输出标准 \r\n，convertEol 会把裸 \n 也转 \r\n，
      // 在 pi-tui 差分渲染里偶尔多出回车字节，导致行错位/重排式闪烁。VS Code 终端同样不对 PTY 数据开 convertEol。
      cursorBlink: getCursorBlink(),
      // VS Code 默认 cursorStyle: 'bar'（terminal.integrated.cursorStyle 默认 'bar'）。
      cursorStyle: getCursorStyle(),
      // 非活跃光标样式：对齐 VS Code 默认 'outline'（光标停在非激活面板时不闪烁实心）。
      cursorInactiveStyle: getCursorInactiveStyle(),
      // minimumContrastRatio 对齐 VS Code 默认（1）。过高会让 xterm 每帧重算 cell 前景对比度，
      // 流式时增加重绘；VS Code 默认 1。
      minimumContrastRatio: 1,
      drawBoldTextInBrightColors: true,
      // 字重：对齐 VS Code 默认（normal / bold），避免依赖 xterm 隐式默认导致平台差异。
      fontWeight: getFontWeight(),
      fontWeightBold: getFontWeightBold(),
      letterSpacing: getLetterSpacing(),
      tabStopWidth: 8,
      // scrollOnEraseInDisplay：对齐 VS Code 默认 true。ED2（Erase in Display）清屏时
      // 不把旧内容推入 scrollback，避免全屏 TUI 场景下每帧清屏重画导致的底部跳动。
      scrollOnEraseInDisplay: true,
      // 滚轮/快速滚动灵敏度：对齐 VS Code 默认（fastScrollSensitivity 5 / scrollSensitivity 1）。
      fastScrollSensitivity: getFastScrollSensitivity(),
      scrollSensitivity: getScrollSensitivity(),
      // 关闭平滑滚动：始终为 0，避免物理滚轮/触控板滚动时的平滑动画与拖影。
      smoothScrollDuration: 0,
      // macOS 选项键行为：对齐 VS Code 默认 false（electron 桌面端行为一致）。
      macOptionIsMeta: false,
      macOptionClickForcesSelection: false,
      // 右键选择单词：对齐 VS Code 默认 false（你的 handleContextMenu 已自定义右键语义）。
      rightClickSelectsWord: false,
      // 词分隔符：对齐 VS Code 默认，保证双击选词/链接检测一致。
      wordSeparator: " ()[]{}\',\"\`─‘’“”|",
      // 忽略 bracketed paste 模式：对齐 VS Code 默认 false（粘贴时由 addon-clipboard 接管）。
      ignoreBracketedPasteMode: false,
      // 重叠字形重缩放：对齐 VS Code 默认 true。改善重叠/组合字形（部分 CJK、组合字符）的
      // cell 度量，从源头减少中英混排与字形重叠时的度量跳变（正对 WebGL 度量抖动根因）。
      rescaleOverlappingGlyphs: true,
      // 不启用透明度（你用实色主题背景，allowTransparency 会引发合成层开销与过滚动露黑边）。
      allowTransparency: false,
      // windowsPty：对齐 VS Code，在 processReady 时根据 conpty 信息设置，
      // 此处先设置 undefined（默认），后续由 processReady 回调更新。
      windowsPty: undefined,
      // 窗口尺寸查询：对齐 VS Code 默认开启，使 TUI 能经 escape 序列获取像素/字符尺寸。
      windowOptions: {
        getWinSizePixels: true,
        getCellSizePixels: true,
        getWinSizeChars: true,
      },
      // 用户滚动后输入是否跳回底部：对齐 VS Code 默认 true（全屏 TUI 本就无手动滚动，保持默认）。
      scrollOnUserInput: true,
      // 光标行重排：对齐 VS Code 默认 true（resize 时光标所在行内容重排，避免错位）。
      reflowCursorLine: true,
      // 自定义字形（连字/组合字渲染）：默认 true（对齐 VS Code 默认），可从设置面板关闭。
      customGlyphs: this._customGlyphs,
      // 滚动条宽度：对齐 VS Code 默认（14px）。xterm 6 支持 scrollbar 选项配置宽度与
      // overview ruler。本应用全屏 TUI 场景下 CSS 已 overflow:hidden 禁用滚动条，但
      // 配置此值确保 xterm 内部布局计算与 VSCode 一致，避免因缺省值导致的 cell 度量差异。
      // 滑块配色由 theme.scrollbarSlider* 注入（见 theme.ts）。
      scrollbar: {
        width: getScrollbarWidth(),
        overviewRuler: { showTopBorder: true },
      },
      fontFamily: getFontFamily(),
      // 跟随全局字体大小（fontSize.ts）：默认基准 13px，可 8–28px 调节。
      fontSize: getFontSize(),
      // lineHeight 对齐 VS Code 默认 1.0（VS Code 终端默认行高 1.0）。
      lineHeight: getLineHeight(),
      scrollback: getScrollback(),
      // 背景色跟随容器 --bg-app（对齐 VS Code getBackgroundColor 的「与容器像素一致」语义）。
      // 使用 getTermTheme 运行时读取当前 CSS 变量，而非 TERM_THEMES 模块级常量——
      // 后者在模块加载时求值，此时 paint() 尚未执行，导致所有变体都捕获了默认暗色值。
      theme: getTermTheme(getThemeFamily(), getTheme()),
      // 链接处理器（对齐 VS Code TerminalLinkManager 的 linkHandler）：
      // 拦截 xterm 原生 OSC 8 超链接（pi 会话中 AI 输出的 Markdown 链接被渲染为
      // OSC 8 序列）。必须提供此 handler，否则 xterm 默认使用 confirm() 弹窗
      // （见 xterm 源码 Hn 函数）。activate/hover/leave 与 WebLinksAddon 共用
      // 同一套逻辑（_handleLinkActivate / _showLinkTooltip / _hideLinkTooltip）。
      linkHandler: {
        allowNonHttpProtocols: true,
        activate: (event: MouseEvent, text: string) => this._handleLinkActivate(event, text),
        hover: (event: MouseEvent) => this._showLinkTooltip(event),
        leave: () => this._hideLinkTooltip(),
      },
    } as any);
    const fit = new FitAddon();
    term.loadAddon(fit);
    this.term = term;
    this.fit = fit;

    // 设置结构重放协调器的 terminal 引用
    this.replayCoordinator?.setTerminal(term);

    // Unicode11Addon：宽字符 / CJK 度量由 xterm 原生处理（对齐 VS Code _updateUnicodeVersion），
    // 从源头消除中英混排度量漂移，替代此前含 CJK 的字体栈 hack。
    // 必须显式激活 Unicode 11 宽度表（Unicode11Addon 仅注册版本提供者，不自动切换），
    // 否则 xterm 默认使用 Unicode 6.3 宽度表，emoji 被当作宽度 1 的普通字符，
    // 导致宽字符（CJK/emoji）的 continuation cell 无法被正确识别（getWidth() 返回 1 而非 0），
    // 进而引起光标位置漂移和内容重叠。
    try {
      term.loadAddon(new Unicode11Addon());
      term.unicode.activeVersion = '11';
    } catch {
      /* addon 加载失败不影响核心终端 */
    }

    // ClipboardAddon：由官方 addon 接管系统剪贴板的复制/粘贴（对齐 VS Code 的 ClipboardAddon
    // 装配，替代此前自管 navigator.clipboard 的 handleContextMenu 逻辑）。
    try {
      term.loadAddon(new ClipboardAddon());
    } catch {
      /* addon 加载失败不影响核心终端 */
    }

    // 装饰 / 导航 addons（对齐 VS Code DecorationAddon / MarkNavigationAddon 装载）。
    try {
      this.decorationAddon = new DecorationAddon();
      term.loadAddon(this.decorationAddon);
    } catch {
      this.decorationAddon = null;
    }
    try {
      this.markNavigationAddon = new MarkNavigationAddon();
      term.loadAddon(this.markNavigationAddon);
    } catch {
      this.markNavigationAddon = null;
    }

    // shell integration capability（对齐 VS Code ShellIntegrationAddon 激活后创建的 store）：
    // 命令检测 + cwd 检测。命令 marker 用 xterm.registerMarker(0) 锚定当前行。
    this.caps = new TerminalCapabilityStore();
    const cmdCap = new CommandDetectionCapability(() => {
      try { return (term as any).registerMarker?.(0); } catch { return undefined; }
    });
    cmdCap.onCommandFinished((c) => { if (c.command) this.onCommandFinished?.(c.command); });
    const cwdCap = new CwdDetectionCapability();
    cwdCap.onDidChangeCwd((cwd) => { this.onCwdChange?.(cwd); });
    this.caps.add(TerminalCapability.CommandDetection, cmdCap);
    this.caps.add(TerminalCapability.CwdDetection, cwdCap);

    // open（对齐 VS Code attachToElement: raw.open 在前，webgl 在其后装载）。
    try {
      term.open(host);
      this.opened = true;
    } catch {
      /* jsdom/headless: ignore open failures */
    }

    // 渲染器策略（S1）：open 之后探测 WebGL 可用性并锁定（会话内恒定、不中途切换）。
    // 对齐 VS Code attachToElement 的原生顺序（VS Code 自身也标注「TODO: Move before open」），
    this.enableWebgl();

    // 启动 WebGL 渲染去同步检测器（issue 06）：仅当 WebGL 启用时有效，
    // 检测器内部守卫 this.webgl 和 this.active，非 WebGL 模式静默跳过。
    // 已禁用——在 TUI 流式输出场景下，clearTextureAtlas + refresh 触发全屏闪烁，
    // 导致底部跳动。

    // 查找 addon（对齐 VS Code SearchAddon 装载）：预装载以便 Ctrl+F 即用。
    try {
      this.searchAddon = new SearchAddon();
      term.loadAddon(this.searchAddon);
    } catch {
      this.searchAddon = null;
    }

    // 滚动缓冲区序列化 addon（对齐 VS Code @xterm/addon-serialize）：用于窗口关闭/终端重建时
    // 保存 scrollback，重开时 replay 还原（见 serializeScrollback / restoreScrollback）。
    try {
      this.serializeAddon = new SerializeAddon();
      term.loadAddon(this.serializeAddon);
    } catch {
      this.serializeAddon = null;
    }

    // 安装 link provider 守卫：防止 provideLinks 中同步 throw 逃逸到 window.onerror 导致渲染器崩溃。
    // 必须在任何 loadAddon/registerLinkProvider 调用之前执行（否则 web-links addon 内部注册的
    // LinkComputer 不会被守卫）。
    installGuardedLinkProviderRegistration(term);

    // 链接 hover 缓存重置：输出落地后自动清除 xterm linkifier 的 hover 缓存，
    // 使 AI 流式输出的 URL 无需鼠标移动即可被检测为可点击链接。
    try {
      this.linkifierHoverResetDisposable = installTerminalLinkifierHoverResetOnWrite(term);
    } catch {
      this.linkifierHoverResetDisposable = null;
    }

    // 加载 WebLinksAddon（@xterm/addon-web-links）：检测终端输出中的 URL 并使其可点击。
    // 替换了此前自定义的 terminal-links 文件路径链接检测。
    try {
      this.linkProviderDisposable = this._loadWebLinksAddon(term);
    } catch {
      this.linkProviderDisposable = null;
    }

    // 写完成确认计数器：xterm 每解析完一批写数据即递增解析序号（对齐 VS Code onWriteParsed）。
    try {
      (term as any).onWriteParsed?.(() => { this._latestParsedSeq = this._latestWriteSeq; });
    } catch {
      /* 旧版 xterm 无 onWriteParsed：降级为「写即解析」，flush 立即 resolves */
    }

    // 注意：不再包装 term.write 注入 _fixTuiScrollbarWideChars 校正——
    // 异步注入 CUP 序列会干扰 pi-tui 差分渲染的光标状态跟踪，
    // 导致光标位置错位和内容重叠。pi-tui 自身处理其滚动条宽字符。

    // 滚动状态：xterm 视口随输出/滚轮变化时经 onScroll 驱动浮钮显隐。
    try {
      term.onScroll(() => this.notifyScrollState());
    } catch {
      /* 旧版 xterm 无 onScroll：降级为始终贴底，浮钮不出现 */
    }

    // 终端标题变化（OSC 0/1/2 序列）与铃声——统一经侧效果处理器聚合。
    // 先创建处理器实例（确保 onBell 订阅时 this.outputProcessor 已就绪），
    // 再注册 xterm 事件。
    // AFTER 路径：xterm 已处理跨块拆分，解析后的标题和铃声经处理器批内去重、
    // 状态判定与 working/idle 回调，flush 时统一转发给壳（原始标题透传）。
    try {
      this.outputProcessor = new PtyOutputProcessor({

        onTitleChange: (rawTitle) => {
          this.onTitleChange?.(rawTitle);
        },
        onBell: () => {
          this.onBell?.();
        },
        onAgentBecameWorking: () => {
          this.onAgentBecameWorking?.();
        },
        onAgentBecameIdle: () => {
          this.onAgentBecameIdle?.();
        },
      });
      // xterm 解析标题后 → 处理器 AFTER 路径
      term.onTitleChange((title) => {
        this._latestTitle = title; // 同步更新，供 getTitle() 查询
        this.outputProcessor?.onTitleChange(title);
      });
      // 铃声 → 处理器 AFTER 路径（处理器已创建，onBell 订阅安全）
      term.onBell(() => {
        this.outputProcessor?.handleBell();
      });
    } catch {
      /* 旧版 xterm 无 onTitleChange 或 onBell */
    }

    // 选区变化（对齐 VS Code onSelectionChange）：选区变化时触发，供壳更新菜单状态。
    try {
      term.onSelectionChange(() => this.onSelectionChange?.());
    } catch {
      /* 旧版 xterm 无 onSelectionChange */
    }

    // 缓冲区变化（对齐 VS Code onBufferChange）：alt/normal buffer 切换时触发，
    // 供壳在 alt buffer 模式下禁用历史滚轮等，并强制激活 xterm mouse tracking。
    try {
      term.buffer.onBufferChange(() => {
        const buf = term.buffer.active;
        const isAlt = (buf as any).type === 'alternate';
        if (isAlt) {
          // 全屏 TUI（备选屏幕）下强制确保 xterm 鼠标跟踪已激活，
          // 使 pi-tui 能接收鼠标滚轮事件以滚动消息区。
          // 同时启用 SGR 鼠标模式（获得扩展坐标），对齐 VS Code 的终端鼠标处理。
          const hasMouse = term.element?.classList.contains('enable-mouse-events');
          if (!hasMouse) {
            // 通过写入 escape 序列激活 mouse tracking
            // 1003h = any-event tracking（含滚轮事件）
            // 1006h = SGR 鼠标模式（扩展坐标，支持 >223 行列）
            term.write('\x1b[?1003h\x1b[?1006h');
          }
        }
        this.onBufferChange?.(isAlt ? 'alt' : 'normal');
      });
    } catch {
      /* 旧版 xterm 无 onBufferChange */
    }

    // 物理滚轮检测（对齐 VS Code MouseWheelClassifier）：监听终端元素的滚轮事件，
    // 通过分析 delta 模式判断是否为物理滚轮，用于控制平滑滚动动画。
    // 触控板/魔术鼠标禁用平滑滚动，避免与系统触控板手势冲突。
    // 注意：必须尊重用户配置的 _smoothScrolling 偏好。当用户关闭平滑滚动时，
    // 即使检测到物理滚轮也不应启用平滑滚动（修复 wheel handler 覆盖用户设置的问题）。
    try {
      const wheelHandler = (e: globalThis.WheelEvent) => {
        const classifier = MouseWheelClassifier.INSTANCE;
        classifier.accept(e.deltaX, e.deltaY);
        const isPhysical = classifier.isPhysicalMouseWheel();
        // 触控板/魔术鼠标：无论用户偏好如何，始终禁用平滑滚动，
        // 避免与系统触控板手势冲突。
        if (!isPhysical) {
          const currentDuration = (this.term as any)?.options?.smoothScrollDuration;
          if (currentDuration !== 0) {
            this.term!.options.smoothScrollDuration = 0;
          }
          return;
        }
        // 物理滚轮：仅当用户启用了平滑滚动时才启用
        if (!this._smoothScrolling) {
          const currentDuration = (this.term as any)?.options?.smoothScrollDuration;
          if (currentDuration !== 0) {
            this.term!.options.smoothScrollDuration = 0;
          }
          return;
        }
        // 用户启用平滑滚动 + 物理滚轮 → 启用平滑滚动动画
        const currentDuration = (this.term as any)?.options?.smoothScrollDuration;
        if (currentDuration !== 125) {
          this.term!.options.smoothScrollDuration = 125;
        }
      };
      term.element?.addEventListener('wheel', wheelHandler, { passive: true });
      // 挂载到实例上以便 unmount 时清理
      this._wheelHandler = wheelHandler;
    } catch {
      /* 旧版 xterm 无 element 或 wheel 事件 */
    }

    // 初始状态：新终端默认贴底。
    this._lastAtBottom = true;

    // 输入：终端按键 → pi.input → 主进程 pty.write。
    // 注：window.__piOnDataSpy 是可选的测试钩子（e2e 用它观测真实写入 PTY 的字节），
    // 生产中不存在该字段，无副作用。
    term.onData((d) => {
      const spy = (window as any).__piOnDataSpy;
      if (typeof spy === 'function') spy(d);
      this.channel.send(d);
    });

    // 输出：主进程 pty 数据（经主进程 emitData 5ms 聚合）→ IPC → 渲染端二次聚合（5ms 时间窗 + 64KB 上限）
    // → 聚合后统一 _segmentByShellIntegration → _writeProcessData。双层聚合减少 term.write() 调用次数。
    this.stopBuffering = this.channel.onData((data) => this.handleProcessData(this.sessionKey, data));

    // 背压累积缓冲（对齐 VS Code AckDataBufferer 独立类）：
    // 在 _writeProcessData 的 xterm.write 回调中调用 ackBufferer.ack(data.length)，
    // 累积到 CharCountAckSize 阈值时发送 ack IPC，减少通信频次。
    this.ackBufferer = new AckDataBufferer(
      (len) => this.pi.acknowledgeDataEvent?.(this.sessionKey, len),
    );

    // 写管道健康监控：注册写管道死锁处理器。
    // 当 xterm 写管道因同步 throw 逃逸或实例已销毁而永久停滞时，
    // 注册的处理器会被通知以触发面板恢复（重建 xterm 并重新挂载存活 PTY）。
    registerUndeliverableWriteHandler(this.term, (reason) => {
      console.warn(`[terminal] 写管道死锁 (${reason})，等待面板恢复。`);
    });

    // 配置输出 backlog 上限：基于 scrollback 行数计算容量，
    // 超出上限时丢弃旧数据并写入警告消息，防止内存无限增长。
    configureTerminalOutputBacklogCap(getScrollback());

    // 进程退出（含会话结束 onStatus('dead')）统一走 channel.onExit：exit 即 dead，语义等价。
    // 收尾 resize 对齐视口（原 onStatus('dead') 行为）。集成终端 exit 时壳已 unmount，无副作用。
    this.offExit = this.channel.onExit(() => {
      this.doResize(true);
    });
    // 主题切换 / 全局字号变化不再由本实例订阅（见 lib/terminal-registry 单点订阅刷新所有存活实例）；
    // 初始主题 / 字号在 _initXterm 构造 term 时已取当前值（theme: getTermTheme(getThemeFamily(), getTheme())、fontSize: getFontSize()），
    // 后续变更经 registry → applyTheme / applyFontSize 刷新本实例。

    // resize 分轴防抖器（对齐 VS Code TerminalResizeDebouncer）：Y 即时、X 100ms 防抖。
    this.resizeDebouncer = new TerminalResizeDebouncer(
      () => this.active,
      (cols, rows) => { this._resizeBoth(cols, rows); this._notifyPtyIfChanged(); },
      (cols) => { this._resizeX(cols); this._notifyPtyIfChanged(); },
      (rows) => { this._resizeY(rows); this._notifyPtyIfChanged(); },
    );

    // 键盘快捷键：Ctrl/Cmd+V 粘贴、Ctrl/Cmd+Shift+C 复制、Ctrl/Cmd+A 全选（绑定到 host DOM）。
    this.bindKeyShortcuts(host);

    // 拖拽文件到终端：拖入即插入绝对路径（对齐 VS Code 拖拽文件语义）。
    this.bindDragAndDrop(host);

    // 挂载 DOM 事件驱动的滚动意图跟踪
    // 监听滚轮、滚动条拖拽、键盘输入、鼠标报告等事件，自动标记滚动意图
    try {
      this._scrollIntentTrackingDisposable = attachTerminalScrollIntentTracking(
        term,
        host,
        { intentKey: this.sessionKey },
      );
    } catch {
      /* 跟踪挂载失败不影响核心功能 */
    }

    this.doResize(true);
  }

  /** 渲染器策略（S1）：open 之后探测 WebGL 可用性并装载，可重试（不再永久锁定）。
   * 可用环境变量 PI_DESKTOP_RENDERER 强制渲染器，用于排查「WebGL cell 度量跳变导致编辑器漂移」：
   *   - 未设置 / 'auto'：探测 WebGL，可用则 GPU，否则 DOM
   *   - 'webgl'：强制 WebGL（不可用则警告并回退 DOM）
   *   - 'dom'：强制 DOM 渲染器（绕过 WebGL，验证是否 WebGL 度量问题）
   *
   * 对齐 VS Code _enableWebglRenderer：注册 onContextLoss，GPU 上下文丢失时降级 DOM 但不永久锁定；
   * 下次可见时由 retryWebglIfNeeded 尝试重建 WebGL。
   *
   * auto 决策委托给 webgl-auto-policy.ts 的 getTerminalWebglAutoDecision 模块。
   *
   * 注意：不再设置 rendererLocked 永久锁。已装载 WebGL（this.webgl != null）时跳过。
   * webglAttachFailed 标记由 retryWebglIfNeeded 在可见时清除后重试。
   *
   * 平滑切换：加载 WebGL 前先 refresh() 确保 DOM 渲染器准备好，
   * 加载后通过 rAF 等待一帧再 refresh() 确保新渲染器立即呈现。 */
  private enableWebgl(): void {
    const term = this.term;
    if (!term || this.webgl) return;
    // WebGL 附加失败锁：首次 new WebglAddon() 失败后暂时跳过
    // （避免每次 title 变化/重新 attach 时都尝试 new WebglAddon() 失败并打印警告）。
    // 由 retryWebglIfNeeded 在可见时清除后重试。
    if (this.webglAttachFailed) return;
    // 用户设置 gpuAcceleration=off → 强制 DOM，不启用 WebGL（对齐 VS Code gpuAcceleration:'off'）。
    if (this._gpuAcceleration === 'off') {
      console.info('[terminal] 渲染器已按 gpuAcceleration=off 使用 DOM 渲染器。');
      return;
    }
    const forced = (import.meta.env?.VITE_PI_DESKTOP_RENDERER ?? '').toLowerCase();
    if (forced === 'dom') {
      console.info('[terminal] 渲染器已按 PI_DESKTOP_RENDERER=dom 强制使用 DOM 渲染器。');
      return;
    }
    // 用户设置 gpuAcceleration=on → 强制 WebGL：跳过 auto 策略探测（对齐 VS Code gpuAcceleration:'on'）。
    // env 变量 forced==='webgl' 同样强制跳过 auto 探测。
    if (this._gpuAcceleration !== 'on' && forced !== 'webgl') {
      // auto 决策：委托给 webgl-auto-policy.ts 模块
      // 在非 Linux 系统上直接允许 WebGL；Linux 上检测渲染器类型（硬件/软件）
      const decision = getTerminalWebglAutoDecision();
      if (!decision.allowWebgl) {
        console.info(
          `[terminal] WebGL 已按 auto 策略禁用（${decision.reason}），使用 DOM 渲染器。`,
        );
        return;
      }
    }
    try {
      const addon = new WebglAddon();
      // 上下文丢失回调：设置标记、释放 WebGL 资源，但不永久禁止重试。
      // 下次可见时由 retryWebglIfNeeded 尝试重建。
      addon.onContextLoss(() => {
        this.webglContextLost = true;
        this.webglDisabledAfterContextLoss = true;
        this.releaseWebglContext();
        this.webgl = null;
        console.warn('[terminal] WebGL 上下文丢失，降级为 DOM 渲染器（下次可见时尝试重建）。');
        // 上下文丢失后 cell 度量由 WebGL 变 DOM，强制一次整屏重测，避免尺寸错位。
        if (this.active && this.host && !this.disposed) this.doResize(true);
      });
      // 加载前先 refresh 确保 DOM 渲染器准备好，避免 canvas 替换闪烁
      try { term.refresh(0, term.rows - 1); } catch { /* 忽略 */ }

      term.loadAddon(addon); // open 后 load：与 VS Code attachToElement 顺序一致
      this.webgl = addon;
      this.webglDisabledAfterContextLoss = false;
      console.info('[terminal] WebGL 渲染器已启用。');

      // 加载后通过 rAF 等待一帧再 refresh，确保新渲染器立即呈现
      requestAnimationFrame(() => {
        if (!this.term || this.disposed) return;
        try { this.term.refresh(0, this.term.rows - 1); } catch { /* 忽略 */ }
      });
    } catch (e) {
      this.webglAttachFailed = true;
      console.warn(
        '[terminal] WebGL 渲染器不可用，降级为 DOM 渲染器（下次可见时重试）。\n' +
          '若环境无硬件 GPU，请确认主进程已设置 --enable-unsafe-swiftshader 以启用软件 WebGL。',
        e,
      );
    }
  }

  /** 在可见时尝试重建 WebGL 渲染器。
   * 由 setActive(true) 和 doResize() 调用，覆盖以下场景：
   *   - 上下文丢失后（webglDisabledAfterContextLoss === true）→ 清除标记并调用 enableWebgl
   *   - 附加失败后（webglAttachFailed === true）→ 清除标记并调用 enableWebgl
   * 仅当 active === true 且未 disposed 时执行。 */
  private retryWebglIfNeeded(): void {
    if (this.disposed || !this.active || !this.term || !this.host) return;
    // 已拥有 WebGL，无需重试
    if (this.webgl) return;

    if (this.webglDisabledAfterContextLoss) {
      this.webglDisabledAfterContextLoss = false;
      this.webglContextLost = false;
      this.enableWebgl();
      return;
    }

    if (this.webglAttachFailed) {
      this.webglAttachFailed = false;
      this.enableWebgl();
    }
  }

  /** 显式释放 WebGL 上下文，避免 context 泄露达到浏览器上限导致新终端无法使用 GPU 渲染。
   * 通过内部渲染器获取 WebGL context 并调用 loseContext，同时将 canvas 尺寸设为 0
   * 确保 ANGLE 驱动层释放。
   * 在 unmount() 和上下文丢失时调用。 */
  private releaseWebglContext(): void {
    try {
      // 优先通过 addon 内部渲染器获取 context（比 DOM querySelector 更可靠）
      const gl = (this.webgl as any)?._renderer?._gl as WebGLRenderingContext | undefined;
      gl?.getExtension('WEBGL_lose_context')?.loseContext();
      // 将 canvas 尺寸设为 0，确保 ANGLE 驱动层释放 GPU 资源
      if (this.term?.element) {
        const canvas = this.term.element.querySelector('canvas');
        if (canvas) {
          canvas.width = 0;
          canvas.height = 0;
        }
      }
    } catch {
      // WebGL context 释放失败不影响主流程
    }
  }

  /** 启动 WebGL 渲染去同步检测器。仅当 WebGL 启用时有效。
   * 检测器内部守卫 this.webgl 和 this.active，非 WebGL 模式静默跳过。
  /** 处理 PTY 输出数据：按 OSC 633 切分后写入 xterm。 } */
  private handleProcessData(id: string, data: string): void {
    if (id !== this.sessionKey || !this.term) return;

    // 先按 OSC 633 切分数据（确保跨消息的 OSC 序列能被正确识别）
    const segments = this._segmentByShellIntegration(data);

    if (segments.length <= 1) {
      // 无 OSC 序列：单段，通过调度器写入
      this._writeProcessDataViaScheduler(data, true);
    } else {
      // 对齐 VS Code：前导段（OSC 633 标记）不用 trackCommit，仅最后一段追踪
      for (let i = 0; i < segments.length - 1; i++) {
        this._writeProcessDataViaScheduler(segments[i], false);
      }
      this._writeProcessDataViaScheduler(segments[segments.length - 1], true);
    }
  }

  /** 通过直接 term.write 写入一段数据，处理背压 ack。
   * 对齐 VS Code TerminalInstance._writeProcessData，不做任何额外 settle/refresh/scroll restore。
   * 回调仅推进解析序号 + 背压 ack + 写完成 Promise + onData 通知。 */
  private _writeProcessDataViaScheduler(data: string, trackCommit: boolean): void {
    if (this.disposed || !this.term || isXtermInstanceDisposed(this.term)) return;

    const term = this.term;
    const seq = ++this._latestWriteSeq;

    // 对齐 VS Code _onWillData：写前通知外部消费者
    // 使用 runGuardedWriteCompletionStep 保护，防止同步 throw 逃逸（见 write-callback-guard.ts 的说明）
    runGuardedWriteCompletionStep('will-data', () => {
      this.onWillData?.(data);
    });

    // 当 trackCommit=true 时记录 writePromise 供 flush() 等待
    let resolveWrite: (() => void) | null = null;
    const writePromise = trackCommit ? new Promise<void>((r) => { resolveWrite = r; }) : undefined;

    try {
      term.write(data, () => {
        // 使用 runGuardedWriteCompletionStep 保护每一步，防止同步 throw 逃逸到 xterm WriteBuffer
        // （见 write-callback-guard.ts 的说明：未捕获的异常会永久冻结终端面板）
        runGuardedWriteCompletionStep('write-parsed', () => {
          // 对齐 VS Code _latestXtermParseData = messageId：推进解析序号
          this._latestParsedSeq = Math.max(this._latestParsedSeq, seq);
        });

        runGuardedWriteCompletionStep('ack', () => {
          // 背压回传（对齐 VSCode AckDataBufferer 独立类）：
          // 通过 ackBufferer.ack 累积消费字符数到阈值再发 IPC，
          // 对齐 VS Code terminalProcessManager.ts 的 CharCountAckSize=5000 累积策略，
          // 减少高频小段 write 回调下的主进程 ↔ 渲染程通信量。
          this.ackBufferer?.ack(data.length);
        });

        runGuardedWriteCompletionStep('resolve-write', () => {
          // 对齐 VS Code cb?.()：写完成回调（resolve writePromise），
          // 在 onData 之前触发，与 VSCode 的 cb?.() → _onData 顺序一致。
          resolveWrite?.();
        });

        runGuardedWriteCompletionStep('on-data', () => {
          // 对齐 VS Code _onData：写解析完毕后通知外部消费者
          this.onData?.(data);
        });
      });
    } catch {
      /* 终端已销毁等边界：term.write 同步抛异常（如 xterm WriteBuffer 内部 pendingData 超限），
         必须释放 ack 和 resolveWrite，否则主进程背压 inflight 永久泄漏 → 终端冻结。 */
      runGuardedWriteCompletionStep('ack-on-catch', () => {
        this.ackBufferer?.ack(data.length);
      });
      runGuardedWriteCompletionStep('resolve-write-on-catch', () => {
        (resolveWrite as (() => void) | null)?.();
      });
    }

    // 对齐 VS Code：将 writePromise 挂载到 _pendingWritePromise 私有字段上
    if (trackCommit && writePromise) {
      this._pendingWritePromise = writePromise;
    }
  }

  /** 按 shell integration 的 OSC 序列切分输入为语义段（对齐 VS Code TerminalInstance._onProcessData）。
   * 匹配 VS Code 系 \x1b]633;A/B/C/D/F/G 与 FinalTerm 系 \x1b]133;A/B/C/D（\x1b]([16]33;...），
   * 在标记边界把数据切成多段，使命令级输出可被差分写入；xterm 原生处理 ?2026 同步输出，
   * 故无需自研同步帧切分。无 OSC 序列时原样返回单段（零开销）。
   * 注意：仅做「输出分段」这一层（消除闪烁），不解析命令/cwd/mark 语义——后者本项目无宿主消费。
   *
   * 对齐 VS Code _onProcessData 的 /(?<seq>\x1b\][16]33;(?:C|D(?:;\d+)?)\x07)/ 正则：
   * 使用具名捕获组 <seq> 提取完整 OSC 序列，与 VSCode 完全一致。 */
  private _segmentByShellIntegration(data: string): string[] {
    // 对齐 VS Code 的 /(?<seq>\x1b\][16]33;(?:C|D(?:;\d+)?)\x07)/：
    // [16]33 同时覆盖 VS Code(633) 与 FinalTerm/iTerm(133) 两系标记。
    // 使用具名捕获组 <seq> 提取完整序列，与 VSCode 完全一致。
    const re = /(?<seq>\x1b\][16]33;(?:A|B|C|D|F|G)(?:;\d+)?\x07)/g;
    const segments: string[] = [];
    let last = 0;
    let m: RegExpExecArray | null;
    re.lastIndex = 0;
    while ((m = re.exec(data)) !== null) {
      if (m.groups?.seq === undefined) {
        // 不可能发生——正则定义保证了 seq 必有值，但防御性处理
        continue;
      }
      if (m.index > last) segments.push(data.slice(last, m.index));
      const seq = m.groups.seq;
      segments.push(seq);
      // 路由给命令检测 capability（去掉 \x1b]633; 前缀与 \x07 ST 后缀，对齐 VS Code _doHandleVSCodeSequence）。
      this._routeOscToCapabilities(seq);
      last = m.index + seq.length;
    }
    if (last < data.length) segments.push(data.slice(last));
    return segments.length ? segments : [data];
  }

  /** 把命中的 OSC 633/133 段交给对应 capability 解析（对齐 VS Code ShellIntegrationAddon 的 OSC 路由）。
   * 命令生命周期 A/B/C/D/E → CommandDetectionCapability；属性 P;Cwd= → CwdDetectionCapability。 */
  private _routeOscToCapabilities(seq: string): void {
    if (!this.caps) return;
    // seq 形如 \x1b]633;A\x07 或 \x1b]633;D;0\x07 或 \x1b]633;P;Cwd=/foo\x07
    const body = seq.replace(/^\x1b\]/, '').replace(/\x07$/, '');
    const cmdCap = this.caps.get<CommandDetectionCapability>(TerminalCapability.CommandDetection);
    if (cmdCap?.handleSequence(body)) return;
    const cwdCap = this.caps.get<CwdDetectionCapability>(TerminalCapability.CwdDetection);
    cwdCap?.handleProperty(body);
  }

  /** 写入一段数据，回复背压 ack，但**不创建 writePromise**（对齐 VS Code _writeProcessData 的 trackCommit=false 语义）。
   * 用于 shell integration 的 OSC 633 前导标记（如 \x1b]633;C\x07 等），不携带实际输出，
   * 不需要调用方 await 写完成，故不创建 writePromise。
   *
   * 与 VSCode 对齐：VSCode 在 _writeProcessData 中为所有写入（包括前导段）都调用
   * acknowledgeDataEvent(data.length)，本方法同样调用 ackBufferer.ack(data.length)，
   * 使 inflight 准确反映所有已发出但未确认的字符（含 OSC 标记），确保背压水位正确。
   *
   * 与 _writeProcessData 的区别：仅缺少 trackCommit（不创建 writePromise），
   * ack 行为完全一致——所有段都调 ackBufferer.ack，用 inflight 准确反映。
   *
   * flush 对齐：递增 _latestWriteSeq 并在回调中推进 _latestParsedSeq，
   * 使 flush 的写完成确认涵盖所有写入段。 */
  private _writeProcessDataUnsafe(data: string): void {
    if (this.disposed || !this.term || isXtermInstanceDisposed(this.term)) return;
    const term = this.term;
    const seq = ++this._latestWriteSeq;

    // 对齐 VS Code _onWillData：写前通知外部消费者
    this.onWillData?.(data);

    // 对齐 VS Code：写前保存滚动位置
    const savedState = this.captureScrollState();

    try {
      term.write(data, () => {
        // 使用 runGuardedWriteCompletionStep 保护每一步，防止同步 throw 逃逸到 xterm WriteBuffer
        // （见 write-callback-guard.ts 的说明：未捕获的异常会永久冻结终端面板）
        runGuardedWriteCompletionStep('write-parsed', () => {
          // 对齐 VS Code _latestXtermParseData = messageId：推进解析序号
          this._latestParsedSeq = Math.max(this._latestParsedSeq, seq);
        });

        runGuardedWriteCompletionStep('ack', () => {
          // 背压 ack：对齐 VS Code，所有写入段（含前导 OSC 标记）都调 acknowledgeDataEvent
          this.ackBufferer?.ack(data.length);
        });

        runGuardedWriteCompletionStep('restore-scroll', () => {
          // 对齐 VS Code：写后恢复滚动位置（仅当用户曾上滚离底时恢复）
          // 视口在底部时跳过：pi-tui 等全屏 TUI 自己管理视口贴底，
          // 外部 restoreScrollState 会与差分渲染器打架导致跳动。
          if (savedState && !savedState.wasAtBottom) {
            this.restoreScrollState(savedState);
          }
        });

        runGuardedWriteCompletionStep('on-data', () => {
          // 对齐 VS Code _onData：写解析完毕后通知外部消费者
          this.onData?.(data);
        });

        runGuardedWriteCompletionStep('sync-scroll-intent', () => {
          // 从当前视口位置同步滚动意图
          // 确保新数据写入后视口意图反映真实状态
          syncTerminalScrollIntentFromViewport(term);
        });
      });
    } catch {
      /* 终端已销毁等边界 */
    }
  }

  /** 写入一段数据并回传背压（对齐 VS Code TerminalInstance._writeProcessData）。
   * 单一 term.write（无行切片/rAF 逐批 hack），回调里推进解析序号 + acknowledgeDataEvent。
   *
   * 对齐 VS Code：写前/写后分别触发 onWillData / onData 事件，并在写前后自动 save/restore
   * 滚动位置，防止新增输出导致用户已上滚的视口意外跳到底部或顶部。
   *
   * 与 _writeProcessDataUnsafe 的区别：本方法带 commit 跟踪（推进 _latestParsedSeq）
   * 和背压回传（通过 ackBufferer.ack），适用于携带实际输出数据的最后一段。
   *
   * @param trackCommit 是否跟踪写完成确认。true 时记录 writePromise 供外部 await。
   *                    对齐 VS Code IProcessDataEvent.trackCommit 语义。 */
  private _writeProcessData(data: string, trackCommit = false): void {
    if (this.disposed || !this.term || isXtermInstanceDisposed(this.term)) return;
    const term = this.term;
    const seq = ++this._latestWriteSeq;

    // 对齐 VS Code _onWillData：写前通知外部消费者
    this.onWillData?.(data);

    // 对齐 VS Code：写前保存滚动位置，防止写入过程中 xterm 因 buffer 滚动/ED2/ED3 等
    // 操作意外改变视口位置。captureScrollState 使用 marker 做精确逻辑行跟踪。
    const savedState = this.captureScrollState();

    // 对齐 VS Code IProcessDataEvent.writePromise：当 trackCommit=true 时，
    // 创建一个 Promise 供调用方（如 flush()）等待写完成确认。
    let resolveWrite: (() => void) | null = null;
    const writePromise = trackCommit ? new Promise<void>((r) => { resolveWrite = r; }) : undefined;

    try {
      term.write(data, () => {
        // 使用 runGuardedWriteCompletionStep 保护每一步，防止同步 throw 逃逸到 xterm WriteBuffer
        // （见 write-callback-guard.ts 的说明：未捕获的异常会永久冻结终端面板）
        runGuardedWriteCompletionStep('write-parsed', () => {
          this._latestParsedSeq = Math.max(this._latestParsedSeq, seq);
        });

        runGuardedWriteCompletionStep('ack', () => {
          // 背压回传（对齐 VSCode AckDataBufferer 独立类）：
          // 通过 ackBufferer.ack 累积消费字符数到阈值再发 IPC，
          // 对齐 VS Code terminalProcessManager.ts 的 CharCountAckSize=5000 累积策略，
          // 减少高频小段 write 回调下的主进程 ↔ 渲染程通信量。
          this.ackBufferer?.ack(data.length);
        });

        runGuardedWriteCompletionStep('resolve-write', () => {
          // 对齐 VS Code cb?.()：写完成回调（resolve writePromise），
          // 在 onData 之前触发，与 VSCode 的 cb?.() → _onData 顺序一致。
          resolveWrite?.();
        });

        runGuardedWriteCompletionStep('on-data', () => {
          // 对齐 VS Code _onData：写解析完毕后通知外部消费者
          this.onData?.(data);
        });

        runGuardedWriteCompletionStep('restore-scroll', () => {
          // 对齐 VS Code：写后恢复滚动位置（仅当用户曾上滚离底时恢复）
          // 视口在底部时跳过：pi-tui 等全屏 TUI 自己管理视口贴底，
          // 外部 restoreScrollState 会与差分渲染器打架导致跳动。
          if (savedState && !savedState.wasAtBottom) {
            this.restoreScrollState(savedState);
          }
        });

        runGuardedWriteCompletionStep('sync-scroll-intent', () => {
          // 从当前视口位置同步滚动意图
          // 确保新数据写入后视口意图反映真实状态
          syncTerminalScrollIntentFromViewport(term);
        });
      });
    } catch {
      /* 终端已销毁等边界 */
      (resolveWrite as (() => void) | null)?.();
    }

    // 对齐 VS Code：将 writePromise 挂载到 _pendingWritePromise 私有字段上
    // 供外部调用方（如 flush）等待实际输出的写完成确认。
    // 替代此前 (this as any)._pendingWritePromise 的类型 hack。
    if (trackCommit && writePromise) {
      this._pendingWritePromise = writePromise;
    }
  }

  /** 仅在 cols/rows 真变时才通知 PTY（对齐 VS Code 整数 dims 比较，避免无谓 resize）。 */
  private _notifyPtyIfChanged(): void {
    if (!this.term) return;
    const { cols, rows } = this.term;
    if (cols === this._lastCols && rows === this._lastRows) return;
    this._lastCols = cols;
    this._lastRows = rows;
    this.channel.resize(cols, rows);
  }

  // —— 配置热更新方法（对齐 VS Code XtermTerminal.updateConfig）——
  /** 运行时更新游标闪烁（对齐 VS Code _setCursorBlink）。
   * 配置变更时由外部调用，无需重建 xterm 实例。 */
  setCursorBlink(blink: boolean): void {
    if (!this.term || this.disposed) return;
    if (this.term.options.cursorBlink !== blink) {
      this.term.options.cursorBlink = blink;
      this.term.refresh(0, this.term.rows - 1);
    }
  }

  /** 运行时更新游标样式（对齐 VS Code _setCursorStyle）。
   * 配置变更时由外部调用，无需重建 xterm 实例。 */
  setCursorStyle(style: 'block' | 'bar' | 'underline'): void {
    if (!this.term || this.disposed) return;
    if (this.term.options.cursorStyle !== style) {
      this.term.options.cursorStyle = style;
    }
  }

  /** 运行时更新非活跃游标样式（对齐 VS Code _setCursorStyleInactive）。 */
  setCursorInactiveStyle(style: 'none' | 'outline' | 'block' | 'bar' | 'underline'): void {
    if (!this.term || this.disposed) return;
    if (this.term.options.cursorInactiveStyle !== style) {
      this.term.options.cursorInactiveStyle = style;
    }
  }

  /** 运行时更新游标宽度（对齐 VS Code _setCursorWidth）。 */
  setCursorWidth(width: number): void {
    if (!this.term || this.disposed) return;
    if (this.term.options.cursorWidth !== width) {
      this.term.options.cursorWidth = width;
    }
  }

  /** 运行时更新 scrollback 值（对齐 VS Code raw.options.scrollback）。 */
  setScrollback(scrollback: number): void {
    if (!this.term || this.disposed) return;
    this.term.options.scrollback = Math.min(SCROLLBACK_MAX, Math.max(SCROLLBACK_MIN, Math.round(scrollback)));
  }

  /** 运行时更新字体（对齐 VS Code raw.options.fontFamily / fontSize / lineHeight / letterSpacing）。 */
  setFont(fontFamily: string, fontSize: number, lineHeight?: number, letterSpacing?: number): void {
    if (!this.term || this.disposed) return;
    this.term.options.fontFamily = fontFamily;
    this.term.options.fontSize = fontSize;
    if (lineHeight !== undefined) this.term.options.lineHeight = lineHeight;
    if (letterSpacing !== undefined) this.term.options.letterSpacing = letterSpacing;
    this.doResize(true);
    this.forceRedraw();
  }

  /** 运行时更新平滑滚动（对齐 VS Code _updateSmoothScrolling）。
   * @param enabled 是否启用平滑滚动
   * @param isPhysicalMouseWheel 是否为物理滚轮（触控板应禁用平滑滚动） */
  setSmoothScrolling(enabled: boolean, isPhysicalMouseWheel?: boolean): void {
    if (!this.term || this.disposed) return;
    const useSmooth = enabled && (isPhysicalMouseWheel ?? true);
    this.term.options.smoothScrollDuration = useSmooth ? 125 : 0;
  }

  /** 运行时更新 scrollbar 宽度（对齐 VS Code scrollbarWidth + _getScrollbarOptions）。 */
  setScrollbarWidth(width: number): void {
    if (!this.term || this.disposed) return;
    (this.term.options as any).scrollbar = { width, overviewRuler: { showTopBorder: true } };
  }

  /** 运行时更新滚动灵敏度。 */
  setScrollSensitivity(sensitivity: number): void {
    if (!this.term || this.disposed) return;
    this.term.options.scrollSensitivity = sensitivity;
  }

  /** 运行时更新快速滚动速度。 */
  setFastScrollSensitivity(sensitivity: number): void {
    if (!this.term || this.disposed) return;
    this.term.options.fastScrollSensitivity = sensitivity;
  }

  /** 运行时更新字重。 */
  setFontWeight(fontWeight: string, fontWeightBold?: string): void {
    if (!this.term || this.disposed) return;
    if (fontWeight !== undefined) (this.term.options as any).fontWeight = fontWeight;
    if (fontWeightBold !== undefined) (this.term.options as any).fontWeightBold = fontWeightBold;
  }

  /** 运行时更新自定义字形开关（对齐 VS Code raw.options.customGlyphs）。
   * 覆盖 Box Drawing / Block Elements / Powerline 等 Unicode 范围的字形渲染。
   * 切换后需要强制重绘以刷新已缓存的字形位图。 */
  setCustomGlyphs(enabled: boolean): void {
    if (!this.term || this.disposed) return;
    this._customGlyphs = enabled;
    const opts = this.term.options as any;
    if (opts.customGlyphs !== enabled) {
      opts.customGlyphs = enabled;
      this.forceRedraw();
    }
  }

  /** 运行时更新 GPU 加速模式（对齐 VS Code gpuAcceleration: auto/on/off）。
   *  - 'off'：卸载已装载的 WebGL，降级 DOM。
   *  - 'on'：若未装载 WebGL，立即尝试装载（跳过 auto 探测）。
   *  - 'auto'：若未装载，按系统策略探测；已装载则保持。
   * 注意：此方法仅在 active 且已挂载时立即生效；否则标记，下次可见时由
   * retryWebglIfNeeded 根据最新 _gpuAcceleration 决策。 */
  setGpuAcceleration(mode: 'auto' | 'on' | 'off'): void {
    if (this.disposed) return;
    this._gpuAcceleration = mode;
    if (!this.term || !this.active || !this.host) return;
    if (mode === 'off') {
      // 卸载 WebGL，降级 DOM
      if (this.webgl) {
        this.webgl.dispose();
        this.webgl = null;
        this.webglAttachFailed = false;
        this.webglDisabledAfterContextLoss = false;
        try { this.term.refresh(0, this.term.rows - 1); } catch { /* 忽略 */ }
      }
    } else {
      // 'on' / 'auto'：若未装载 WebGL，尝试装载
      this.retryWebglIfNeeded();
    }
  }

  /** 运行时批量更新配置（对齐 VS Code XtermTerminal.updateConfig）。
   * 一次性应用多个配置项，避免逐个调用导致多次 xterm 内部重排。
   * @param config 部分配置项，未提供的项保持不变。 */
  updateConfig(config: any): void {
    if (!this.term || this.disposed) return;
    if (config.cursorBlink !== undefined) this.setCursorBlink(config.cursorBlink);
    if (config.cursorStyle !== undefined) this.setCursorStyle(config.cursorStyle);
    if (config.cursorInactiveStyle !== undefined) this.setCursorInactiveStyle(config.cursorInactiveStyle);
    if (config.cursorWidth !== undefined) this.setCursorWidth(config.cursorWidth);
    if (config.scrollback !== undefined) this.setScrollback(config.scrollback);
    if (config.smoothScrolling !== undefined) {
      this._smoothScrolling = config.smoothScrolling;
      this.setSmoothScrolling(config.smoothScrolling, config.isPhysicalMouseWheel);
    }
    if (config.scrollbarWidth !== undefined) this.setScrollbarWidth(config.scrollbarWidth);
    if (config.scrollSensitivity !== undefined) this.setScrollSensitivity(config.scrollSensitivity);
    if (config.fastScrollSensitivity !== undefined) this.setFastScrollSensitivity(config.fastScrollSensitivity);
    if (config.fontWeight !== undefined || config.fontWeightBold !== undefined) {
      this.setFontWeight(
        config.fontWeight ?? this.term.options.fontWeight,
        config.fontWeightBold,
      );
    }
    if (config.fontFamily !== undefined || config.fontSize !== undefined ||
        config.lineHeight !== undefined || config.letterSpacing !== undefined) {
      this.setFont(
        config.fontFamily ?? this.term.options.fontFamily,
        config.fontSize ?? this.term.options.fontSize,
        config.lineHeight ?? this.term.options.lineHeight,
        config.letterSpacing ?? this.term.options.letterSpacing,
      );
    }
    if (config.customGlyphs !== undefined) this.setCustomGlyphs(config.customGlyphs);
    if (config.gpuAcceleration !== undefined) this.setGpuAcceleration(config.gpuAcceleration);
  }

  /** resize 回调：X/Y 同时变化（对齐 VS Code _resizeBothCallback）。
   * 对齐 VS Code：直接 xterm.resize(cols, rows)，不做 scroll restore——
   * xterm 的 resize 会重置 ydisp = ybase（视口跳底），这正是 VS Code 的行为，
   * 避免 scroll restore 与 pi-agent 的差分渲染器打架。 */
  private _resizeBoth(cols: number, rows: number): void {
    if (this.disposed || !this.term || isXtermInstanceDisposed(this.term)) return;
    if (cols === this.term.cols && rows === this.term.rows) return;
    try {
      this.term.resize(cols, rows);
    } catch { /* resize 边界 */ }
  }

  /** resize 回调：仅 X（列宽）变化（对齐 VS Code _resizeXCallback）。 */
  private _resizeX(cols: number): void {
    if (this.disposed || !this.term || isXtermInstanceDisposed(this.term)) return;
    if (cols === this.term.cols) return;
    try {
      this.term.resize(cols, this.term.rows);
    } catch { /* resize 边界 */ }
  }

  /** resize 回调：仅 Y（行数）变化（对齐 VS Code _resizeYCallback）。 */
  private _resizeY(rows: number): void {
    if (this.disposed || !this.term || isXtermInstanceDisposed(this.term)) return;
    if (rows === this.term.rows) return;
    try {
      this.term.resize(this.term.cols, rows);
    } catch { /* resize 边界 */ }
  }

  /** 立即用宿主最新尺寸校准终端并通知 PTY（首挂载 / 切回可见 / 会话结束收尾调用，force=true）。
   * 对齐 VS Code：直接 resize 并通知 PTY，不分轴防抖（避免分轴 resize 导致 pi-agent 双重重绘跳动）。 */
  private doResize(force = false): void {
    if (this.disposed || !this.fit || !this.term || !this.host) return;
    // 先清除 RenderService 暂停标记（隐藏期由 IntersectionObserver 置位），
    // 确保 resize 时 term.resize() 触发 canvas 重绘而非存到 _pausedResizeTask。
    // 此调用幂等，已 unpause 时无副作用。
    forceRepaintThroughRenderPause(this.term);
    // resize 时尝试重建 WebGL 渲染器（上下文丢失或此前附加失败后）
    this.retryWebglIfNeeded();
    const proposed = this.fit.proposeDimensions();
    if (!proposed) return;
    if (proposed.cols <= 1 || proposed.rows <= 1) return;
    // 当 FitAddon 因 getComputedStyle 返回 0 尺寸而给出极小值（2列/1行）时
    // （父容器隐藏 / contain:strict / display:none 过渡等场景），用宿主的
    // clientWidth/clientHeight 直接重测，避免终端缩到最小宽高造成「一列宽/黑屏」。
    if (proposed.cols <= 2 && proposed.rows <= 1) {
      const width = this.host.clientWidth;
      const height = this.host.clientHeight;
      const cellWidth = this.term.dimensions?.css.cell.width ?? 0;
      const cellHeight = this.term.dimensions?.css.cell.height ?? 0;
      if (width <= 0 || height <= 0 || cellWidth <= 0 || cellHeight <= 0) {
        // 宿主确实无尺寸或 cell 度量未就绪，跳过 resize
        return;
      }
      proposed.cols = Math.max(2, Math.floor(width / cellWidth));
      proposed.rows = Math.max(1, Math.floor(height / cellHeight));
    }
    if (proposed.cols === this.term.cols && proposed.rows === this.term.rows) return;
    try {
      this.term.resize(proposed.cols, proposed.rows);
    } catch { /* resize 边界 */ }
    this._notifyPtyIfChanged();
  }
}
