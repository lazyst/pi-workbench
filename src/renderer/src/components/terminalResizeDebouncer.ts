/**
 * TerminalResizeDebouncer —— 移植自 VS Code
 * src/vs/workbench/contrib/terminal/browser/terminalResizeDebouncer.ts。
 *
 * 作用：终端 resize 分轴防抖。垂直（Y/行数）resize 便宜，立即执行；水平（X/列宽）resize
 * 昂贵（改列宽 = 整屏重排 → WebGL handleResize 强制全重绘，是流式输出跳动的核心放大器），
 * 故列宽变化必须 debounce（默认 100ms）且只在尺寸真变时才触发。
 *
 * 与 VS Code 原版差异（仅适配）：
 *   - VS Code 用 `runWhenWindowIdle`（基于 DOM 空闲调度）；本项目用 `requestIdleCallback` 降级
 *     `setTimeout(0)`，语义等价——不可见终端的 resize 推迟到浏览器空闲执行，避免后台隐藏面板
 *     抢占主线程做整屏重排。
 *   - 「buffer 小才立即 resize」阈值：VS Code 用 `buffer.normal.length < 200`；本项目无 VS Code 的
 *     buffer 概念，用「近期是否在流式输出活跃期」近似（`StartDebouncingThreshold` 改为时间窗），
 *     但更贴近本项目的 pi-tui 全屏 TUI 场景——其实全屏 TUI 整屏是满的，故统一走 debounce。
 */

const enum Constants {
  /** buffer 长度阈值，低于此值直接立即 resize（对齐 VS Code StartDebouncingThreshold=200）。 */
  StartDebouncingThreshold = 200,
  /** 水平 resize 防抖延迟（对齐 VS Code DebounceResizeXDelay=100）。 */
  DebounceResizeXDelay = 100,
}

export class TerminalResizeDebouncer {
  private _latestX = 0;
  private _latestY = 0;

  private _resizeXTimer: ReturnType<typeof setTimeout> | null = null;
  private _resizeYTimer: ReturnType<typeof setTimeout> | null = null;
  private _idleX: (() => void) | null = null;
  private _idleY: (() => void) | null = null;

  private _disposed = false;

  constructor(
    private readonly _isVisible: () => boolean,
    private readonly _resizeBothCallback: (cols: number, rows: number) => void,
    private readonly _resizeXCallback: (cols: number) => void,
    private readonly _resizeYCallback: (rows: number) => void,
  ) {}

  dispose(): void {
    this._disposed = true;
    if (this._resizeXTimer != null) clearTimeout(this._resizeXTimer);
    if (this._resizeYTimer != null) clearTimeout(this._resizeYTimer);
    this._resizeXTimer = this._resizeYTimer = null;
    this._idleX = this._idleY = null;
  }

  /**
   * 请求一次 resize。
   * @param cols 目标列数
   * @param rows 目标行数
   * @param immediate 是否立即执行（首挂载/切回可见/会话结束收尾时应为 true）
   * @param smallBuffer 是否视为「小 buffer」（立即 resize，不防抖）。本项目由调用方判断。
   */
  resize(cols: number, rows: number, immediate: boolean, smallBuffer: boolean): void {
    if (this._disposed) return;
    this._latestX = cols;
    this._latestY = rows;

    // 显式立即，或 buffer 小 → 直接同步 resize（对齐 VS Code immediate || buffer < 阈值）。
    if (immediate || smallBuffer) {
      this._clearPending();
      this._resizeBothCallback(cols, rows);
      return;
    }

    // 不可见：推迟到 idle 执行（对齐 VS Code runWhenWindowIdle），X/Y 各自 idle 调度。
    if (!this._isVisible()) {
      const ric: typeof window.requestIdleCallback | undefined = (window as any).requestIdleCallback;
      if (!this._idleX) {
        this._idleX = () => {
          if (this._disposed) return;
          this._resizeXCallback(this._latestX);
          this._idleX = null;
        };
        if (ric) ric(this._idleX, { timeout: 200 });
        else setTimeout(this._idleX, 0);
      }
      if (!this._idleY) {
        this._idleY = () => {
          if (this._disposed) return;
          this._resizeYCallback(this._latestY);
          this._idleY = null;
        };
        if (ric) ric(this._idleY, { timeout: 200 });
        else setTimeout(this._idleY, 0);
      }
      return;
    }

    // 可见：Y 即时（便宜），X 防抖 100ms（昂贵）。
    this._resizeYCallback(rows);
    if (this._resizeXTimer != null) clearTimeout(this._resizeXTimer);
    this._resizeXTimer = setTimeout(() => {
      if (this._disposed) return;
      this._resizeXCallback(this._latestX);
      this._resizeXTimer = null;
    }, Constants.DebounceResizeXDelay);
  }

  /** 立即 flush 所有待执行的 resize（切回可见时调用，对齐 VS Code flush）。 */
  flush(): void {
    if (this._disposed) return;
    const pendingX = this._resizeXTimer != null;
    const pendingY = this._idleX != null || this._idleY != null;
    this._clearPending();
    if (pendingX || pendingY) {
      this._resizeBothCallback(this._latestX, this._latestY);
    }
  }

  private _clearPending(): void {
    if (this._resizeXTimer != null) {
      clearTimeout(this._resizeXTimer);
      this._resizeXTimer = null;
    }
    if (this._resizeYTimer != null) {
      clearTimeout(this._resizeYTimer);
      this._resizeYTimer = null;
    }
    this._idleX = this._idleY = null;
  }
}