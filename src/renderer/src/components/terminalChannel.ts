import type { PiApi } from '../ipc';

/**
 * TerminalChannel —— 终端「数据通道」抽象。
 *
 * 把「PTY 进程 ↔ 渲染层」的数据流（输出订阅 / 退出订阅 / 键盘输入 / 尺寸通知）从具体 IPC
 * 信道中解耦出来，使同一个 XtermTerminal 封装既能驱动会话终端（SessionChannel，复用 session:*
 * IPC），也能驱动集成终端（IntegratedChannel，复用 terminal:* IPC），还能驱动统一终端
 * （UnifiedChannel，统一复用 term:* IPC），而 XtermTerminal 本身不感知差异。
 *
 * UnifiedChannel 收编了 SessionChannel + IntegratedChannel 的设计，统一通过 term:* IPC 通信，
 * 是未来新代码的首选实现。SessionChannel 和 IntegratedChannel 保留作为向后兼容。
 *
 * 设计要点（与重构前会话终端行为 100% 等价）：
 *  - onData / onExit / send / resize 四个原语，覆盖原 XtermTerminal 内全部 `this.pi.input /
 *    onData / onStatus / resize` 调用。
 *  - 原「会话结束收尾 resize」由 `pi.onStatus('dead')` 触发；这里统一收敛到 `onExit`（exit 即
 *    dead，语义等价），会话终端与集成终端走同一收尾路径，XtermTerminal 无需保留 onStatus 分支。
 *
 * 三条通道差异仅在「订阅哪个原始事件 / 调哪个 IPC 方法」，id 过滤订阅逻辑完全相同，
 * 故收编到 TerminalChannelBase 的 onData/onExit，子类只补 4 个 pi 方法绑定。
 */
export interface TerminalChannel {
  // 订阅 PTY 输出；返回取消订阅函数
  onData(cb: (data: string) => void): () => void;
  // 订阅进程退出
  onExit(cb: () => void): () => void;
  // 键盘/粘贴输入 → PTY stdin
  send(data: string): void;
  // 通知 PTY 尺寸变化
  resize(cols: number, rows: number): void;
}

/**
 * 共享基类：持有 pi 与 id，统一实现 onData/onExit 的 id 过滤订阅。
 * 子类只需绑定「订阅原始事件」与「发送输入/尺寸」对应的 pi 方法。
 */
abstract class TerminalChannelBase implements TerminalChannel {
  constructor(
    protected readonly pi: PiApi,
    protected readonly id: string,
  ) {}

  onData(cb: (data: string) => void): () => void {
    // 原始订阅回调带 key/id，仅当匹配本通道 id 时才转发给消费者。
    return this.subscribeData((key, data) => {
      if (key === this.id) cb(data);
    });
  }

  onExit(cb: () => void): () => void {
    return this.subscribeExit((key) => {
      if (key === this.id) cb();
    });
  }

  /** 订阅原始 (key, data) 数据事件，返回取消订阅函数。 */
  protected abstract subscribeData(cb: (key: string, data: string) => void): () => void;
  /** 订阅原始 (key) 退出事件，返回取消订阅函数。 */
  protected abstract subscribeExit(cb: (key: string) => void): () => void;
  // send / resize 由子类直接绑定到对应 pi 方法（见各子类）。
  abstract send(data: string): void;
  abstract resize(cols: number, rows: number): void;
}

// 会话终端通道：包现有的 session:* IPC（与当前 XtermTerminal 硬编码行为一致）
export class SessionChannel extends TerminalChannelBase {
  constructor(pi: PiApi, sessionKey: string) {
    super(pi, sessionKey);
  }
  protected subscribeData(cb: (key: string, data: string) => void): () => void {
    return this.pi.onData(cb);
  }
  protected subscribeExit(cb: (key: string) => void): () => void {
    return this.pi.onExit(cb);
  }
  send(data: string): void {
    this.pi.input(this.id, data);
  }
  resize(cols: number, rows: number): void {
    this.pi.resize(this.id, cols, rows);
  }
}

// 集成终端通道：包 terminal:* IPC（T5 壳会用）
export class IntegratedChannel extends TerminalChannelBase {
  constructor(pi: PiApi, terminalId: string) {
    super(pi, terminalId);
  }
  protected subscribeData(cb: (key: string, data: string) => void): () => void {
    return this.pi.onTerminalData(cb);
  }
  protected subscribeExit(cb: (key: string) => void): () => void {
    return this.pi.onTerminalExit(cb);
  }
  send(data: string): void {
    this.pi.terminalInput(this.id, data);
  }
  resize(cols: number, rows: number): void {
    this.pi.terminalResize(this.id, cols, rows);
  }
}

// 统一终端通道：同时支持 pi 会话和 shell 终端的 UnifiedChannel。
// 收编 SessionChannel + IntegratedChannel，统一通过 term:* IPC 通信。
// 与 IntegratedChannel 行为一致（共享 term:* IPC），独立成类以保留语义标识（未来新代码首选）。
export class UnifiedChannel extends IntegratedChannel {}
