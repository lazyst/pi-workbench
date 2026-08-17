// 主进程侧 PTY 输出背压。
//
// VS Code 的 TerminalProcess 在 pty 每吐一块数据时累加「已发未确认」字符数，
// 超 HighWatermark 即调用 ptyProcess.pause() 直接掐断 PTY 进程输出（shell 被 OS
// 管道阻塞，数据堵在内核缓冲而非 VS Code 内存），渲染端 ack 追上降到 LowWatermark
// 以下再 ptyProcess.resume() 恢复。三层阈值见下方 FlowControlConstants。
//
// 本项目数据流：PTY → 主进程 5ms 聚合(emitData，等效 VS Code pty host 端
// TerminalDataBufferer，减少 IPC 消息量) → IPC(terminal:data / session:data)
// → 渲染端直接 xterm.write → ack 经 IPC 回传主进程。
// 由于 node-pty 的 IPty 原生提供 pause()/resume()（VS Code 同款接口），本项目
// 采用与 VS Code 完全一致的「源头反压」：BackpressureController 在翻转阈值时
// 经 onPause/onResume 回调直接 pause/resume 底层 PTY，而非把数据堆在主进程内存里。
// 这样 `cat` 大文件时 shell 被 OS 管道阻塞、几乎不占主进程内存，与 VS Code 行为等价。

/** 对齐 VS Code FlowControlConstants（字符数，非字节）。 */
export const FlowControlConstants = {
  /** 已发未确认字符数超此即 pause PTY（VS Code: 100000 ≈ 98KB）。 */
  HighWatermarkChars: 100000,
  /** 降到此以下才 resume PTY（VS Code: 5000 ≈ 4.9KB）。 */
  LowWatermarkChars: 5000,
  /** 渲染端累积消费字符数达此值才发送一次 ack IPC（VS Code: 5000）。
   * 减少高频小段 term.write 回调下主进程 ↔ 渲染程通信量。 */
  CharCountAckSize: 5000,
} as const;

export class BackpressureController {
  /** 已下发、尚未收到渲染端 ack 的累计字符数（对齐 VS Code _unacknowledgedCharCount）。 */
  private inflight = 0;
  /** 当前是否处于暂停（超 HighWatermark）状态（对齐 VS Code _isPtyPaused）。 */
  private paused = false;
  /** 翻转至高水位时调用：掐断底层 PTY 输出（从源头反压）。 */
  private readonly onPause: () => void;
  /** 翻转至低水位时调用：恢复底层 PTY 输出。 */
  private readonly onResume: () => void;
  /**
   * 同步写路径的「无需等待 ack」标记（@internal 自创功能，非 VS Code 对齐项）。
   * 在高优先级写（如 exit 消息、关键状态通知）时临时标记，避免 PTY pause 后
   * 等待 ack 队列排空才写入——同步写直接写入内核 PTY 缓冲，不受背压水位影响。
   * 当标记为 true 时，onData 不计入 inflight，也不触发 pause。
   */
  private _writeSyncMode = false;

  constructor(onPause: () => void, onResume: () => void) {
    this.onPause = onPause;
    this.onResume = onResume;
  }

  /**
   * 主进程从 PTY 读到一块数据时调用，累加未确认计数；
   * 若未暂停且超过高水位，触发 onPause（暂停 PTY 输出）。
   * 在 writeSync 模式下不计入 inflight，也不触发 pause。
   */
  onData(charCount: number): void {
    if (this._writeSyncMode) return;
    this.inflight += charCount;
    if (!this.paused && this.inflight > FlowControlConstants.HighWatermarkChars) {
      this.paused = true;
      this.onPause();
    }
  }

  /**
   * 渲染端回传已消费字符数。推进 inflight；若已暂停且降到低水位以下，
   * 触发 onResume（恢复 PTY 输出）。
   */
  acknowledge(charCount: number): void {
    this.inflight = Math.max(0, this.inflight - charCount);
    if (this.paused && this.inflight < FlowControlConstants.LowWatermarkChars) {
      this.paused = false;
      this.onResume();
    }
  }

  /**
   * 进入同步写模式（@internal 自创功能，非 VS Code 对齐项）。
   * 在此模式下，onData 不计入 inflight，不回传背压，直接写入 PTY。
   * 使用场景：高优先级写入（如 exit 通知、关键 OSC 序列），
   * 避免被已暂停的背压阻塞。
   * 调用 exitWriteSync() 退出该模式。
   */
  enterWriteSync(): void {
    this._writeSyncMode = true;
  }

  /**
   * 退出同步写模式，恢复正常背压记账。
   * 退出 writeSync 时检查是否需要恢复 PTY。
   * 如果在 writeSync 期间 inflight 已降到 LowWatermark 以下，立即恢复 PTY 输出。
   */
  exitWriteSync(): void {
    this._writeSyncMode = false;
    if (this.paused && this.inflight < FlowControlConstants.LowWatermarkChars) {
      this.paused = false;
      this.onResume();
    }
  }

  /** 当前是否处于同步写模式（测试/诊断用）。 */
  isWriteSyncMode(): boolean {
    return this._writeSyncMode;
  }

  /** 实例销毁 / 进程退出时强制恢复（对齐 VS Code clearUnacknowledgedChars + force resume）。
   * 会触发 onResume 回调恢复 PTY 输出。同时退出 writeSync 模式。 */
  dispose(): void {
    this.clearUnacknowledgedChars();
    this._writeSyncMode = false;
  }

  /** 清除未确认字符计数并强制 resume（对齐 VS Code clearUnacknowledgedChars 的语义）。
   * VS Code 的 terminalProcess.ts:590-595 在清除计数后即使 inflight 为 0 也强制 resume PTY。
   * 用于 PTY 已退出等场景，确保 PTY 恢复输出。
   * 与 dispose 的区别：dispose 同时退出 writeSync 模式；本方法保留 writeSync 状态。 */
  clearUnacknowledgedChars(): void {
    this.inflight = 0;
    if (this.paused) {
      this.paused = false;
      this.onResume();
    }
  }

  /** 当前是否在反压暂停中（测试 / 诊断用）。 */
  isPaused(): boolean {
    return this.paused;
  }
}
