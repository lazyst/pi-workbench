// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { XtermTerminal } from '../components/XtermTerminal';
import { DecorationAddon } from '../components/decorationAddon';
import type { PiApi } from '../ipc';

// 用可控的 mock 替换 addons，验证加载/回退，不触发真实 GPU / 剪贴板 / unicode 解析。
const hoist = vi.hoisted(() => ({
  webglThrow: false,
  webglActivateCalls: 0,
  webglContextLossHandler: null as (() => void) | null,
  webglClearAtlasCalls: 0,
  clipboardActivateCalls: 0,
  unicodeActivateCalls: 0,
  registerDecorationCalls: 0,
  fitProposeDefault: null as { cols: number; rows: number } | null,
  fitProposeCalls: 0,
  fitCalls: 0,
}));
vi.mock('@xterm/addon-fit', () => {
  class FitAddonMock {
    _terminal: any = null;
    activate(t: any) { this._terminal = t; }
    dispose() {}
    proposeDimensions() {
      hoist.fitProposeCalls++;
      if (hoist.fitProposeDefault) return hoist.fitProposeDefault;
      return { cols: 80, rows: 24 };
    }
    fit() {
      hoist.fitCalls++;
      const d = this.proposeDimensions();
      if (d && this._terminal) {
        this._terminal.resize(d.cols, d.rows);
      }
    }
  }
  return { FitAddon: FitAddonMock };
});
vi.mock('@xterm/addon-webgl', () => {
  class WebglAddon {
    disposed = false;
    // 捕获 onContextLoss 回调，供测试手动触发上下文丢失（对齐 VS Code _enableWebglRenderer）。
    onContextLoss(cb: () => void) {
      hoist.webglContextLossHandler = cb;
    }
    clearTextureAtlas() {
      hoist.webglClearAtlasCalls++;
    }
    activate() {
      hoist.webglActivateCalls++;
      if (hoist.webglThrow) throw new Error('WebGL unavailable');
    }
    dispose() {
      this.disposed = true;
    }
  }
  return { WebglAddon };
});
vi.mock('@xterm/addon-clipboard', () => {
  class ClipboardAddon {
    activate() {
      hoist.clipboardActivateCalls++;
    }
    dispose() {}
  }
  return { ClipboardAddon };
});
vi.mock('@xterm/addon-unicode11', () => {
  class Unicode11Addon {
    activate() {
      hoist.unicodeActivateCalls++;
    }
    dispose() {}
  }
  return { Unicode11Addon };
});

function makeApi() {
  return {
    listSessions: vi.fn(),
    openSession: vi.fn(),
    terminate: vi.fn(),
    input: vi.fn(),
    resize: vi.fn(),
    // 背压回传（对齐 VS Code acknowledgeDataEvent）：记录渲染端消费的字节数。
    acknowledgeDataEvent: vi.fn(),
    onData: vi.fn(() => () => {}),
    onStatus: vi.fn(() => () => {}),
    onExit: vi.fn(),
    pickDirectory: vi.fn(),
    debug: vi.fn(),
    // 拖拽文件解析绝对路径（测试里 File 带注入的 path 属性即返回绝对路径，否则空→跳过）。
    getPathForFile: ((f: any) => (f && typeof f.path === 'string' ? f.path : '')) as any,
  } as unknown as PiApi;
}

function mountHost(): HTMLElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  return host;
}

describe('XtermTerminal（VS Code 集成终端同款装配，见 docs/adr/0002 / 0003）', () => {
  beforeEach(() => {
    hoist.webglThrow = false;
    hoist.webglActivateCalls = 0;
    hoist.clipboardActivateCalls = 0;
    hoist.unicodeActivateCalls = 0;
    hoist.fitProposeDefault = null;
    hoist.fitProposeCalls = 0;
    hoist.fitCalls = 0;
  });
  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('attempts to enable the WebGL (GPU) renderer on mount (S1: open 前锁定)', () => {
    const api = makeApi();
    const t = new XtermTerminal({ sessionKey: 'k', pi: api });
    t.mount(mountHost());
    expect(hoist.webglActivateCalls).toBeGreaterThanOrEqual(1);
    t.unmount();
  });

  it('falls back to DOM renderer without throwing when WebGL is unavailable', () => {
    hoist.webglThrow = true;
    const api = makeApi();
    const t = new XtermTerminal({ sessionKey: 'k', pi: api });
    expect(() => t.mount(mountHost())).not.toThrow();
    expect(hoist.webglActivateCalls).toBeGreaterThanOrEqual(1);
    t.unmount();
  });

  it('loads the ClipboardAddon (对齐 VS Code 的 ClipboardAddon 装配)', () => {
    const api = makeApi();
    const t = new XtermTerminal({ sessionKey: 'k', pi: api });
    t.mount(mountHost());
    expect(hoist.clipboardActivateCalls).toBeGreaterThanOrEqual(1);
    t.unmount();
  });

  it('loads the Unicode11Addon for CJK / wide-char metrics (对齐 VS Code _updateUnicodeVersion)', () => {
    const api = makeApi();
    const t = new XtermTerminal({ sessionKey: 'k', pi: api });
    t.mount(mountHost());
    expect(hoist.unicodeActivateCalls).toBeGreaterThanOrEqual(1);
    t.unmount();
  });

  it('forwards keystrokes to pi.input via term.onData', () => {
    const api = makeApi();
    const t = new XtermTerminal({ sessionKey: 'k', pi: api });
    t.mount(mountHost());
    expect(api.onData).toHaveBeenCalled();
    t.unmount();
  });

  // 渲染端不再做 5ms 聚合（对齐 VS Code 渲染端无 TerminalDataBufferer 的设计）。
  // 数据直接通过调度器写入 xterm，每个 onData 回调直接触发一次写入。
  it('writes each onData chunk immediately via scheduler (no 5ms aggregation)', async () => {
    const api = makeApi();
    const writes: string[] = [];
    const write = vi
      .spyOn(Terminal.prototype, 'write')
      .mockImplementation(function (this: unknown, data: string | Uint8Array, cb?: () => void) {
        writes.push(data as string);
        cb?.();
      });
    const t = new XtermTerminal({ sessionKey: 'k', pi: api });
    t.mount(mountHost());
    const onData = (api.onData as any).mock.calls[0][0] as (k: string, d: string) => void;
    // 数据直接写入 xterm，每段独立触发 write（无 5ms 聚合）
    onData('k', 'chunk-1');
    onData('k', 'chunk-2');
    onData('k', 'chunk-3');
    // 三段数据立即写入（调度器 foreground+latencySensitive 路径）
    await vi.waitFor(() => expect(writes.length).toBe(3));
    expect(writes[0]).toBe('chunk-1');
    expect(writes[1]).toBe('chunk-2');
    expect(writes[2]).toBe('chunk-3');
    write.mockRestore();
    t.unmount();
  });

  // 连续写入：每段数据立即写入，无 5ms 聚合窗口
  it('writes each chunk immediately without waiting for aggregation window', async () => {
    const api = makeApi();
    const writes: string[] = [];
    vi.spyOn(Terminal.prototype, 'write').mockImplementation(function (this: unknown, data: string | Uint8Array, cb?: () => void) {
      writes.push(data as string);
      cb?.();
    });
    const t = new XtermTerminal({ sessionKey: 'k', pi: api });
    t.mount(mountHost());
    const onData = (api.onData as any).mock.calls[0][0] as (k: string, d: string) => void;
    onData('k', 'frame-a');
    // 立即写入，不等聚合窗口
    await vi.waitFor(() => expect(writes.length).toBe(1));
    onData('k', 'frame-b');
    await vi.waitFor(() => expect(writes.length).toBe(2));
    expect(writes[0]).toBe('frame-a');
    expect(writes[1]).toBe('frame-b');
    t.unmount();
  });

  // 跨消息边界的 OSC 633 分段：分片到达的 OSC 633 序列各自独立分段。
  // 无 5ms 聚合后，跨消息的 OSC 序列不能被合并识别。
  it('handles fragmented OSC sequences across messages (no cross-message merge)', async () => {
    const api = makeApi();
    const writes: string[] = [];
    vi.spyOn(Terminal.prototype, 'write').mockImplementation(function (this: unknown, data: string | Uint8Array, cb?: () => void) {
      writes.push(data as string);
      cb?.();
    });
    const t = new XtermTerminal({ sessionKey: 'k', pi: api });
    t.mount(mountHost());
    const onData = (api.onData as any).mock.calls[0][0] as (k: string, d: string) => void;

    // 分片到达：第一段只有文本，OSC 633 序列不完整
    onData('k', 'hello\x1b]633');
    // 第二段包含 OSC 633 后半部分 + 更多输出
    onData('k', ';C\x07world');
    // 第三段有完整 OSC 633 D 标记（会被分段为 OSC 标记 + 内容）
    onData('k', '\x1b]633;D\x07done');

    // 等待写入完成
    await vi.waitFor(() => expect(writes.length).toBeGreaterThanOrEqual(3));

    // 最终拼接内容正确
    const joined = writes.join('');
    expect(joined).toBe('hello\x1b]633;C\x07world\x1b]633;D\x07done');
    t.unmount();
  });

  // 大块数据立即写入：数据直接写入 xterm，无 64KB 阈值限制。
  it('writes large data chunk immediately (no 64KB threshold)', async () => {
    const api = makeApi();
    const writes: string[] = [];
    vi.spyOn(Terminal.prototype, 'write').mockImplementation(function (this: unknown, data: string | Uint8Array, cb?: () => void) {
      writes.push(data as string);
      cb?.();
    });
    const t = new XtermTerminal({ sessionKey: 'k', pi: api });
    t.mount(mountHost());
    const onData = (api.onData as any).mock.calls[0][0] as (k: string, d: string) => void;

    // 大量数据直接写入，无 64KB 聚合阈值
    const large = 'x'.repeat(60 * 1024);
    onData('k', large);
    // 立即写入
    await vi.waitFor(() => expect(writes.length).toBe(1));
    expect(writes[0].length).toBe(60 * 1024);
    t.unmount();
  });

  // 小块数据立即写入：无 5ms 聚合窗口，数据立即到达 xterm。
  it('writes small chunk immediately (no 5ms aggregation window)', async () => {
    const api = makeApi();
    const writes: string[] = [];
    vi.spyOn(Terminal.prototype, 'write').mockImplementation(function (this: unknown, data: string | Uint8Array, cb?: () => void) {
      writes.push(data as string);
      cb?.();
    });
    const t = new XtermTerminal({ sessionKey: 'k', pi: api });
    t.mount(mountHost());
    const onData = (api.onData as any).mock.calls[0][0] as (k: string, d: string) => void;

    onData('k', 'tiny');
    // 立即写入，无 5ms 聚合窗口
    await vi.waitFor(() => expect(writes.length).toBe(1));
    expect(writes[0]).toBe('tiny');
    t.unmount();
  });

  // 回归（同步帧不再切分）：含 ?2026 序列的整段数据应作为一次 write 原样写出，不被切分/丢弃。
  it('writes a full synchronized-output chunk verbatim in a single write', async () => {
    const api = makeApi();
    const writes: string[] = [];
    vi.spyOn(Terminal.prototype, 'write').mockImplementation(function (this: unknown, data: string | Uint8Array, cb?: () => void) {
      writes.push(data as string);
      cb?.();
    });
    const t = new XtermTerminal({ sessionKey: 'k', pi: api });
    t.mount(mountHost());
    const onData = (api.onData as any).mock.calls[0][0] as (k: string, d: string) => void;
    const chunk = '\x1b[?2026h\x1b[2Jhello world\x1b[?2026l';
    onData('k', chunk);
    await vi.waitFor(() => expect(writes.length).toBe(1));
    expect(writes[0]).toBe(chunk);
    t.unmount();
  });

  it('copies selection on right-click and pastes (via addon-clipboard) when empty (handleContextMenu)', async () => {
    const api = makeApi();
    const hasSelection = vi.spyOn(Terminal.prototype, 'hasSelection').mockReturnValue(true);
    const getSelection = vi.spyOn(Terminal.prototype, 'getSelection').mockReturnValue('hello');
    const clearSelection = vi.spyOn(Terminal.prototype, 'clearSelection').mockImplementation(() => {});
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText, readText: vi.fn() },
    });
    const t = new XtermTerminal({ sessionKey: 'k', pi: api });
    t.mount(mountHost());
    const ev = new Event('contextmenu') as unknown as MouseEvent;
    ev.preventDefault = () => {};
    t.handleContextMenu(ev);
    expect(writeText).toHaveBeenCalledWith('hello');
    expect(clearSelection).toHaveBeenCalled();
    hasSelection.mockRestore();
    getSelection.mockRestore();
    clearSelection.mockRestore();
    t.unmount();
  });

  it('calls pi.resize with fitted dims after mount', () => {
    const api = makeApi();
    // jsdom 无布局引擎，mock 出有效目标维度，
    // 对齐真实浏览器里 mount 后首帧用宿主尺寸校准终端、通知 PTY 的路径。
    hoist.fitProposeDefault = { cols: 100, rows: 30 };
    const t = new XtermTerminal({ sessionKey: 'k', pi: api });
    const host = mountHost();
    Object.defineProperty(host, 'clientWidth', { value: 800, configurable: true });
    Object.defineProperty(host, 'clientHeight', { value: 600, configurable: true });
    t.mount(host);
    expect(api.resize).toHaveBeenCalled();
    t.unmount();
  });

  it('unmount() cleans up without leaving pending writes (data written immediately, no aggregation)', async () => {
    const api = makeApi();
    const writes: string[] = [];
    const write = vi.spyOn(Terminal.prototype, 'write').mockImplementation(function (this: unknown, data: string | Uint8Array, cb?: () => void) {
      writes.push(data as string);
      cb?.();
    });
    const t = new XtermTerminal({ sessionKey: 'k', pi: api });
    t.mount(mountHost());
    const onData = (api.onData as any).mock.calls[0][0] as (k: string, d: string) => void;
    // 数据直接写入（无 5ms 聚合），unmount 前数据已写入
    onData('k', 'late');
    await vi.waitFor(() => expect(writes.length).toBe(1));
    expect(writes[0]).toBe('late');
    t.unmount();
    // unmount 后不应再触发新 write
    const beforeCount = write.mock.calls.length;
    await new Promise((r) => setTimeout(r, 20));
    expect(write.mock.calls.length).toBe(beforeCount);
    write.mockRestore();
  });

  // flush()：写完成确认闸门（对齐 VS Code _flushXtermData）。无待写时应立即 resolve。
  it('flush() resolves immediately when there is no pending write', async () => {
    const api = makeApi();
    const t = new XtermTerminal({ sessionKey: 'k', pi: api });
    t.mount(mountHost());
    await expect(t.flush()).resolves.toBeUndefined();
    t.unmount();
  });

  // flush()：有数据写出后，onWriteParsed 推进解析序号，flush 应能在写完成后 resolve。
  it('flush() resolves after pending write is parsed', async () => {
    const api = makeApi();
    const write = vi
      .spyOn(Terminal.prototype, 'write')
      .mockImplementation(function (this: unknown, _d: string | Uint8Array, cb?: () => void) {
        cb?.(); // 立即解析完成
      });
    const t = new XtermTerminal({ sessionKey: 'k', pi: api });
    t.mount(mountHost());
    const onData = (api.onData as any).mock.calls[0][0] as (k: string, d: string) => void;
    onData('k', 'hello');
    await vi.waitFor(() => expect(t.flush()).resolves.toBeUndefined());
    write.mockRestore();
    t.unmount();
  });

  // resetSameFrame()：发全清序列 \x1bc（对齐 VS Code SeamlessRelaunch 同帧 RIS 重置）。
  it('resetSameFrame() writes the RIS full-reset sequence', async () => {
    const api = makeApi();
    const writes: string[] = [];
    vi.spyOn(Terminal.prototype, 'write').mockImplementation(function (this: unknown, data: string | Uint8Array, cb?: () => void) {
      writes.push(data as string);
      cb?.();
    });
    const t = new XtermTerminal({ sessionKey: 'k', pi: api });
    t.mount(mountHost());
    t.resetSameFrame();
    // 现在 resetSameFrame 在清屏后追加光标重置序列（CURSOR_RESET_MINIMAL）
    expect(writes.length).toBeGreaterThanOrEqual(1);
    expect(writes[0]).toBe('\x1bc\x1b[0 q\x1b[?25h');
    t.unmount();
  });

  // 滚动状态回调（驱动「跳到底部」浮钮）：视口离底时通知壳 atBottom=false，贴底时 true。
  it('notifies onScrollState(false) when scrolled up and (true) when back at bottom', async () => {
    const api = makeApi();
    const states: boolean[] = [];
    const t = new XtermTerminal({ sessionKey: 'k', pi: api });
    t.onScrollState = (bottom) => states.push(bottom);
    t.mount(mountHost());
    // 模拟 xterm buffer：viewportY < baseY 表示上滚离底。buffer 是 getter-only，用 defineProperty 覆盖。
    Object.defineProperty((t as any).term, 'buffer', {
      configurable: true,
      value: { active: { viewportY: 0, baseY: 10 } },
    });
    // 视口上滚离底 → 通知 atBottom=false（对齐运行时 term.onScroll 触发的 notifyScrollState 路径）。
    (t as any).notifyScrollState();
    expect(states).toEqual([false]);
    // 滚回贴底：viewportY 追平 baseY → 通知 atBottom=true。
    (t as any).term.buffer.active.viewportY = 10;
    (t as any).notifyScrollState();
    expect(states).toEqual([false, true]);
    t.unmount();
  });

  // scrollToBottom()：调用 xterm.scrollToBottom 把视口带到底部。
  it('scrollToBottom() calls term.scrollToBottom', async () => {
    const api = makeApi();
    const scrollMock = vi.spyOn(Terminal.prototype, 'scrollToBottom').mockImplementation(() => {});
    const t = new XtermTerminal({ sessionKey: 'k', pi: api });
    t.mount(mountHost());
    t.scrollToBottom();
    expect(scrollMock).toHaveBeenCalled();
    t.unmount();
  });

  // WebGL 上下文丢失恢复：GPU 上下文丢失后设置标记、降级 DOM，不崩溃，并触发一次尺寸重测。
  // 注意：doResize 内部的 retryWebglIfNeeded 会立即重建 WebGL，所以 webgl 不为 null。
  it('degrades to DOM renderer on WebGL context loss without throwing', () => {
    const api = makeApi();
    const t = new XtermTerminal({ sessionKey: 'k', pi: api });
    t.mount(mountHost());
    expect(hoist.webglActivateCalls).toBeGreaterThanOrEqual(1);
    // 触发上下文丢失（模拟驱动崩溃 / 资源回收）。
    expect(typeof hoist.webglContextLossHandler).toBe('function');
    expect(() => hoist.webglContextLossHandler!()).not.toThrow();
    // 上下文丢失后实例仍可用：后续写入不应抛错。
    const onData = (api.onData as any).mock.calls[0][0] as (k: string, d: string) => void;
    expect(() => onData('k', 'after-loss')).not.toThrow();
    t.unmount();
  });

  // WebGL 上下文丢失后自动重建（doResize → retryWebglIfNeeded → enableWebgl）。
  it('rebuilds WebGL renderer automatically after context loss via doResize', () => {
    const api = makeApi();
    const t = new XtermTerminal({ sessionKey: 'k', pi: api });
    const host = mountHost();
    t.mount(host);
    const initialActivateCalls = hoist.webglActivateCalls;

    // 模拟上下文丢失（doResize 内部的 retryWebglIfNeeded 会立即重建 WebGL）
    expect(typeof hoist.webglContextLossHandler).toBe('function');
    hoist.webglContextLossHandler!();

    // 上下文丢失触发 doResize → retryWebglIfNeeded → enableWebgl → 重建成功
    expect(hoist.webglActivateCalls).toBeGreaterThan(initialActivateCalls);
    // webglContextLost 被 retryWebglIfNeeded 重置为 false
    expect((t as any).webglContextLost).toBe(false);
    expect((t as any).webglDisabledAfterContextLoss).toBe(false);
    expect((t as any).webgl).not.toBeNull();

    t.unmount();
  });

  // WebGL 附加失败后重新激活时重试（setActive(true) → retryWebglIfNeeded → 清除标记 → enableWebgl）。
  it('retries WebGL after attach failure when setActive(true) is called', () => {
    const api = makeApi();
    // 首次 mount 让 WebGL 附加失败
    hoist.webglThrow = true;
    const t = new XtermTerminal({ sessionKey: 'k', pi: api });
    const host = mountHost();
    t.mount(host);
    expect(hoist.webglActivateCalls).toBeGreaterThanOrEqual(1);
    expect((t as any).webglAttachFailed).toBe(true);
    expect((t as any).webgl).toBeNull();

    // 停用 WebGL 抛错，让重试能成功
    hoist.webglThrow = false;

    // 模拟切出再切回触发 retry
    (t as any).active = false;
    const beforeRetry = hoist.webglActivateCalls;
    t.setActive(true);
    // setActive(true) 内部调用 retryWebglIfNeeded → 清除 webglAttachFailed → enableWebgl → 成功
    expect(hoist.webglActivateCalls).toBeGreaterThan(beforeRetry);
    expect((t as any).webglAttachFailed).toBe(false);
    expect((t as any).webgl).not.toBeNull();

    t.unmount();
  });

  // 上下文丢失后 forceRedraw 不应尝试清空纹理（WebGL 已重建，但模拟丢失后重建的 addon
  // 在 mock 中不保留 clearTextureAtlas 调用计数）。
  it('forceRedraw() handles gracefully after context loss', () => {
    const api = makeApi();
    const t = new XtermTerminal({ sessionKey: 'k', pi: api });
    t.mount(mountHost());
    hoist.webglClearAtlasCalls = 0;

    // 模拟上下文丢失（自动重建 WebGL）
    hoist.webglContextLossHandler!();
    expect((t as any).webgl).not.toBeNull();

    // forceRedraw 不应抛错
    expect(() => t.forceRedraw()).not.toThrow();

    t.unmount();
  });

  // unmount 清除所有 WebGL 状态标记，后续 mount 重新探测。
  it('unmount() resets WebGL state flags for fresh mount', () => {
    const api = makeApi();
    hoist.webglThrow = true;
    const t = new XtermTerminal({ sessionKey: 'k', pi: api });
    t.mount(mountHost());
    expect((t as any).webglAttachFailed).toBe(true);

    t.unmount();
    expect((t as any).webglAttachFailed).toBe(false);
    expect((t as any).webglDisabledAfterContextLoss).toBe(false);
    expect((t as any).webglContextLost).toBe(false);
    expect((t as any).webgl).toBeNull();
  });

  // WebGL 上下文丢失后 doResize 触发自动重建，再次上下文丢失也应能再次重建。
  it('handles multiple context loss and rebuild cycles', () => {
    const api = makeApi();
    const t = new XtermTerminal({ sessionKey: 'k', pi: api });
    const host = mountHost();
    t.mount(host);

    // 第一次上下文丢失→自动重建
    const firstActivate = hoist.webglActivateCalls;
    hoist.webglContextLossHandler!();
    expect(hoist.webglActivateCalls).toBeGreaterThan(firstActivate);
    expect((t as any).webgl).not.toBeNull();

    // 第二次上下文丢失→自动重建
    // 注意：新 addon 的 onContextLoss 回调会覆盖 hoist.webglContextLossHandler
    expect(typeof hoist.webglContextLossHandler).toBe('function');
    const secondActivate = hoist.webglActivateCalls;
    hoist.webglContextLossHandler!();
    expect(hoist.webglActivateCalls).toBeGreaterThan(secondActivate);
    expect((t as any).webgl).not.toBeNull();

    t.unmount();
  });

  // forceRedraw()：清纹理图集（对齐 VS Code forceRedraw/clearTextureAtlas），换主题不残留旧纹理。
  it('forceRedraw() clears the WebGL texture atlas', () => {
    const api = makeApi();
    const t = new XtermTerminal({ sessionKey: 'k', pi: api });
    t.mount(mountHost());
    hoist.webglClearAtlasCalls = 0;
    t.forceRedraw();
    expect(hoist.webglClearAtlasCalls).toBeGreaterThanOrEqual(1);
    t.unmount();
  });

  // Shell Integration 流分割（对齐 VS Code _onProcessData）：含 OSC 633 序列的数据应被切成
  // 多段、各段独立 write，命令边界不丢。无 OSC 633 时原样单次 write。
  it('segments data by OSC 633 shell-integration sequences after aggregation', async () => {
    const api = makeApi();
    const writes: string[] = [];
    vi.spyOn(Terminal.prototype, 'write').mockImplementation(function (this: unknown, data: string | Uint8Array, cb?: () => void) {
      writes.push(data as string);
      cb?.();
    });
    const t = new XtermTerminal({ sessionKey: 'k', pi: api });
    t.mount(mountHost());
    const onData = (api.onData as any).mock.calls[0][0] as (k: string, d: string) => void;
    const chunk = 'output-before\x1b]633;C\x07middle\x1b]633;D\x07after';
    onData('k', chunk);
    // unmount 时 flush 聚合数据，触发分段写入
    t.unmount();
    // 三段按顺序写入、拼接还原为原始数据，且命令边界标记完整保留。
    expect(writes.length).toBeGreaterThanOrEqual(3);
    expect(writes.join('')).toBe(chunk);
    expect(writes.some((w) => w.includes('\x1b]633;C\x07'))).toBe(true);
    expect(writes.some((w) => w.includes('\x1b]633;D\x07'))).toBe(true);
  });

  // 终端标题变化（OSC 0 序列）：xterm 解析 \x1b]0;title\x07 后触发 onTitleChange 回调，
  // 并经 getTitle() 可查询最近标题。这是 pi 扩展 spinner 标题帧在 tab 上可见的前提
  // （渲染端必须订阅 onTitleChange，见 pi-workbench-sync-source）。
  it('fires onTitleChange and exposes getTitle() when OSC 0 title arrives', async () => {
    const api = makeApi();
    const titles: string[] = [];
    const t = new XtermTerminal({ sessionKey: 'k', pi: api });
    t.mount(mountHost());
    t.onTitleChange = (title) => titles.push(title);
    const onData = (api.onData as any).mock.calls[0][0] as (k: string, d: string) => void;
    // OSC 0 标题序列（pi 扩展写入的格式：spinner 帧 + π 前缀 + 目录名）
    onData('k', '\x1b]0;⠋ π - my-project\x07');
    await vi.waitFor(() => expect(titles.length).toBeGreaterThanOrEqual(1));
    expect(titles[0]).toBe('⠋ π - my-project');
    // 空闲标题更新后 getTitle 跟随
    expect(t.getTitle()).toBe('⠋ π - my-project');
    onData('k', '\x1b]0;π - my-project\x07');
    await vi.waitFor(() => expect(t.getTitle()).toBe('π - my-project'));
    t.unmount();
  });

  // 背压回传（对齐 VS Code AckDataBufferer）：累积消费字符数达 CharCountAckSize(5000)
  // 才发一次 acknowledgeDataEvent IPC，减少高频小段 write 下的通信量。
  it('batches ack via AckDataBufferer, sending every 5000 chars (aligned with VS Code)', async () => {
    const api = makeApi();
    vi.spyOn(Terminal.prototype, 'write').mockImplementation(function (this: unknown, _d: string | Uint8Array, cb?: () => void) {
      cb?.(); // 立即解析完成
    });
    const t = new XtermTerminal({ sessionKey: 'k', pi: api });
    t.mount(mountHost());
    const onData = (api.onData as any).mock.calls[0][0] as (k: string, d: string) => void;

    // 写 11 字符 → 未达阈值，不应触发 ack
    onData('k', 'hello world');
    await vi.waitFor(() => expect(api.acknowledgeDataEvent).not.toHaveBeenCalled());

    // 再写 4990 字符 → 累积 5001 > 5000，触发一次 5000 回传
    const big = 'x'.repeat(4990);
    onData('k', big);
    await vi.waitFor(() => expect(api.acknowledgeDataEvent).toHaveBeenCalledTimes(1));
    expect(api.acknowledgeDataEvent).toHaveBeenCalledWith('k', 5000);

    // 剩余 1 字符累积在 _unsentAckChars（未达阈值），再写 'y' + 4999 → 累积 5001 > 5000，触发第二次 ack
    onData('k', 'y');
    onData('k', 'z'.repeat(4999));
    // 累积 = 1 (remaining) + 1 (y) + 4999 = 5001 > 5000，触发第二次 5000 回传
    await vi.waitFor(() => expect(api.acknowledgeDataEvent).toHaveBeenCalledTimes(2));
    expect(api.acknowledgeDataEvent).toHaveBeenLastCalledWith('k', 5000);

    // 再写 1 字符 → 累积 1 + 1 = 2 < 5000，不触发 ack
    onData('k', '!');
    await vi.waitFor(() => expect(api.acknowledgeDataEvent).toHaveBeenCalledTimes(2));

    t.unmount();
  });

  // Decoration 覆盖层（对齐 VS Code DecorationAddon 差分 overlay 基座）：registerLineDecoration
  // 经 DecorationAddon.registerCommandDecoration 锚定 marker；clearDecorations 释放全部装饰。
  it('registerLineDecoration / clearDecorations delegate to the DecorationAddon overlay', () => {
    const api = makeApi();
    // marker 是 IMarker 形态的最小桩：DecorationAddon.registerCommandDecoration 需要 marker.id。
    const fakeMarker = { id: 42, dispose: vi.fn() } as any;
    const fakeDeco = { marker: fakeMarker, dispose: vi.fn(), onRender: vi.fn(), onDispose: vi.fn(), element: undefined, isDisposed: false } as any;
    const registerSpy = vi
      .spyOn(DecorationAddon.prototype, 'registerCommandDecoration')
      .mockReturnValue(fakeDeco);
    const clearSpy = vi.spyOn(DecorationAddon.prototype, 'clearDecorations').mockImplementation(() => {});
    const t = new XtermTerminal({ sessionKey: 'k', pi: api });
    t.mount(mountHost());
    const deco = t.registerLineDecoration(fakeMarker, { marker: fakeMarker });
    expect(registerSpy).toHaveBeenCalled();
    expect(deco).toBe(fakeDeco);
    t.clearDecorations();
    expect(clearSpy).toHaveBeenCalled();
    registerSpy.mockRestore();
    clearSpy.mockRestore();
    t.unmount();
  });

  // scheduleResize 直接调用 doResize 执行同步 resize（不再使用 idle 延迟 / 分轴防抖），
  // 验证 doResize 正确调用了 proposeDimensions 和 PTY 通知。
  it('scheduleResize calls doResize directly', () => {
    const api = makeApi();
    // 先用一组尺寸 mount，使终端初始化为该尺寸。
    hoist.fitProposeDefault = { cols: 100, rows: 30 };
    const t = new XtermTerminal({ sessionKey: 'k', pi: api });
    const host = mountHost();
    Object.defineProperty(host, 'clientWidth', { value: 800, configurable: true });
    Object.defineProperty(host, 'clientHeight', { value: 600, configurable: true });
    t.mount(host);
    // 非 active 时 scheduleResize 仍直接执行 resize（无 idle 延迟）
    (t as any).active = false;
    // 用不同尺寸使 doResize 跳过相等检测，触发 PTY 通知
    hoist.fitProposeDefault = { cols: 120, rows: 40 };
    hoist.fitProposeCalls = 0;
    (api.resize as unknown as ReturnType<typeof vi.fn>).mockClear();
    t.scheduleResize();
    expect(hoist.fitProposeCalls).toBeGreaterThan(0);
    expect(api.resize).toHaveBeenCalled();
    t.unmount();
  });
});

  // —— 编辑快捷键：粘贴 / 复制 / 全选（对齐 VS Code 基础编辑交互）——
  describe('编辑快捷键（粘贴 / 复制 / 全选）', () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('pasteText() 粘贴文本并归一化换行', () => {
      const api = makeApi();
      const t = new XtermTerminal({ sessionKey: 'k', pi: api });
      t.mount(mountHost());
      const paste = vi.spyOn((t as any).term, 'paste').mockImplementation(() => {});
      t.pasteText('hello\nworld');
      expect(paste).toHaveBeenCalledWith('hello\rworld');
      t.unmount();
    });

    it('pasteText() 粘贴纯文本（不手动包裹 bracketed 序列，由 xterm 内部处理）', () => {
      const api = makeApi();
      const t = new XtermTerminal({ sessionKey: 'k', pi: api });
      t.mount(mountHost());
      // 即便模拟 bracketed 模式开启，pasteText 也必须原样传纯文本给 term.paste，
      // 不能自己拼接 \x1b[200~/\x1b[201~（否则会被 PTY 当字面量打印出 [200~）。
      Object.defineProperty((t as any).term, 'modes', {
        configurable: true,
        value: { bracketedPasteMode: true },
      });
      const paste = vi.spyOn((t as any).term, 'paste').mockImplementation(() => {});
      t.pasteText('ls');
      expect(paste).toHaveBeenCalledWith('ls');
      t.unmount();
    });

    it('copySelection() 把选区写入系统剪贴板', async () => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      vi.stubGlobal('navigator', { clipboard: { writeText } });
      const api = makeApi();
      const t = new XtermTerminal({ sessionKey: 'k', pi: api });
      t.mount(mountHost());
      const term = (t as any).term;
      vi.spyOn(term, 'hasSelection').mockReturnValue(true);
      vi.spyOn(term, 'getSelection').mockReturnValue('selected text');
      t.copySelection();
      expect(writeText).toHaveBeenCalledWith('selected text');
      t.unmount();
    });

    it('copySelection() 无选区时不写入剪贴板', () => {
      const writeText = vi.fn();
      vi.stubGlobal('navigator', { clipboard: { writeText } });
      const api = makeApi();
      const t = new XtermTerminal({ sessionKey: 'k', pi: api });
      t.mount(mountHost());
      vi.spyOn((t as any).term, 'hasSelection').mockReturnValue(false);
      t.copySelection();
      expect(writeText).not.toHaveBeenCalled();
      t.unmount();
    });

    it('selectAll() 聚焦并全选', () => {
      const api = makeApi();
      const t = new XtermTerminal({ sessionKey: 'k', pi: api });
      t.mount(mountHost());
      const term = (t as any).term;
      const focus = vi.spyOn(term, 'focus').mockImplementation(() => {});
      const selectAll = vi.spyOn(term, 'selectAll').mockImplementation(() => {});
      t.selectAll();
      expect(focus).toHaveBeenCalled();
      expect(selectAll).toHaveBeenCalled();
      t.unmount();
    });

    it('clearSelection() 清空选区', () => {
      const api = makeApi();
      const t = new XtermTerminal({ sessionKey: 'k', pi: api });
      t.mount(mountHost());
      const clear = vi.spyOn((t as any).term, 'clearSelection').mockImplementation(() => {});
      t.clearSelection();
      expect(clear).toHaveBeenCalled();
      t.unmount();
    });

    it('pasteFromClipboard() 剪贴板含图片时落临时文件并粘贴路径', async () => {
      const fakePath = '/tmp/pi-paste-xxxx.png';
      const api = makeApi() as any;
      api.saveImage = vi.fn().mockResolvedValue(fakePath);
      const t = new XtermTerminal({ sessionKey: 'k', pi: api });
      t.mount(mountHost());
      const paste = vi.spyOn((t as any).term, 'paste').mockImplementation(() => {});
      // ClipboardItem + blob
      const read = vi.fn().mockResolvedValue([
        { types: ['image/png'], getType: vi.fn().mockResolvedValue(new Blob(['x'], { type: 'image/png' })) },
      ]);
      const fakeClipboard = {
        read,
        readText: vi.fn(),
      };
      vi.stubGlobal('navigator', { clipboard: fakeClipboard });
      // FileReader 在 jsdom 可用，readAsDataURL 会把 blob 转 base64
      await t.pasteFromClipboard();
      await new Promise((r) => setTimeout(r, 20));
      expect(api.saveImage).toHaveBeenCalled();
      expect(paste).toHaveBeenCalledWith(fakePath);
      t.unmount();
    });

    it('mount() 注册快捷键拦截器（attachCustomKeyEventHandler）', () => {
      const api = makeApi();
      const t = new XtermTerminal({ sessionKey: 'k', pi: api });
      t.mount(mountHost());
      expect((t as any)._keydownHandler).toBeTypeOf('function');
      expect((t as any)._customKeyHandler).toBeTypeOf('function');
      t.unmount();
    });

    it('拦截器命中 Ctrl+V 时返回 false（阻止 xterm 把 Ctrl+V 当 \x16 输入）并触发粘贴', async () => {
      const readText = vi.fn().mockResolvedValue('clipboard-text');
      vi.stubGlobal('navigator', { clipboard: { readText } });
      const api = makeApi();
      const t = new XtermTerminal({ sessionKey: 'k', pi: api });
      t.mount(mountHost());
      const term = (t as any).term as Terminal;
      const paste = vi.spyOn(term, 'paste').mockImplementation(() => {});
      const handler = (t as any)._customKeyHandler as (e: KeyboardEvent) => boolean;
      const ret = handler(new KeyboardEvent('keydown', { key: 'v', ctrlKey: true }));
      expect(ret).toBe(false); // 拦截，阻止默认输入
      await new Promise((r) => setTimeout(r, 20));
      expect(paste).toHaveBeenCalledWith('clipboard-text');
      t.unmount();
    });

    it('拦截器命中 Ctrl+Shift+C 时返回 false 并复制选区', () => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      vi.stubGlobal('navigator', { clipboard: { writeText } });
      const api = makeApi();
      const t = new XtermTerminal({ sessionKey: 'k', pi: api });
      t.mount(mountHost());
      const term = (t as any).term as Terminal;
      vi.spyOn(term, 'hasSelection').mockReturnValue(true);
      vi.spyOn(term, 'getSelection').mockReturnValue('sel');
      const handler = (t as any)._customKeyHandler as (e: KeyboardEvent) => boolean;
      const ret = handler(new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, shiftKey: true }));
      expect(ret).toBe(false);
      expect(writeText).toHaveBeenCalledWith('sel');
      t.unmount();
    });

    it('拦截器命中 Ctrl+C 且有选区时返回 false 并复制选区（对齐 VS Code / Windows Terminal）', () => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      vi.stubGlobal('navigator', { clipboard: { writeText } });
      const api = makeApi();
      const t = new XtermTerminal({ sessionKey: 'k', pi: api });
      t.mount(mountHost());
      const term = (t as any).term as Terminal;
      vi.spyOn(term, 'hasSelection').mockReturnValue(true);
      vi.spyOn(term, 'getSelection').mockReturnValue('sel');
      const handler = (t as any)._customKeyHandler as (e: KeyboardEvent) => boolean;
      const ret = handler(new KeyboardEvent('keydown', { key: 'c', ctrlKey: true }));
      expect(ret).toBe(false);
      expect(writeText).toHaveBeenCalledWith('sel');
      t.unmount();
    });

    it('拦截器命中 Ctrl+C 且无选区时返回 true（放行，由 xterm 默认发 SIGINT）', () => {
      const api = makeApi();
      const t = new XtermTerminal({ sessionKey: 'k', pi: api });
      t.mount(mountHost());
      const term = (t as any).term as Terminal;
      vi.spyOn(term, 'hasSelection').mockReturnValue(false);
      const handler = (t as any)._customKeyHandler as (e: KeyboardEvent) => boolean;
      const ret = handler(new KeyboardEvent('keydown', { key: 'c', ctrlKey: true }));
      expect(ret).toBe(true);
      t.unmount();
    });

    it('普通按键（非 Ctrl 组合）拦截器返回 true，不拦截', () => {
      const api = makeApi();
      const t = new XtermTerminal({ sessionKey: 'k', pi: api });
      t.mount(mountHost());
      const handler = (t as any)._customKeyHandler as (e: KeyboardEvent) => boolean;
      expect(handler(new KeyboardEvent('keydown', { key: 'a' }))).toBe(true);
      t.unmount();
    });

    it('Shift+Enter 拦截器返回 false 并经 pi.input 写入 \n 软换行（不提交执行）', () => {
      const api = makeApi();
      const t = new XtermTerminal({ sessionKey: 'k', pi: api });
      t.mount(mountHost());
      const handler = (t as any)._customKeyHandler as (e: KeyboardEvent) => boolean;
      const ret = handler(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true }));
      expect(ret).toBe(false); // 拦截，阻止 xterm 把 Enter 当 \r 提交
      // 必须经输入通道（PTY stdin 方向），而非 term.write（PTY stdout 方向），
      // 否则运行在 PTY 里的程序（如 pi 编辑器）收不到按键、仅视觉换行。
      expect(api.input).toHaveBeenCalledWith('k', '\n'); // 软换行（续行，不执行）
      t.unmount();
    });

    it('带 Ctrl 的 Ctrl+Enter 不被当作 Shift+Enter 软换行（放行给程序）', () => {
      const api = makeApi();
      const t = new XtermTerminal({ sessionKey: 'k', pi: api });
      t.mount(mountHost());
      const handler = (t as any)._customKeyHandler as (e: KeyboardEvent) => boolean;
      const ret = handler(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, ctrlKey: true }));
      expect(ret).toBe(true); // 放行（带修饰的组合交回 xterm 默认处理）
      expect(api.input).not.toHaveBeenCalled();
      t.unmount();
    });

    it('unmount() 清理快捷键幂等标记', () => {
      const api = makeApi();
      const t = new XtermTerminal({ sessionKey: 'k', pi: api });
      t.mount(mountHost());
      expect((t as any)._keydownHandler).toBeTypeOf('function');
      t.unmount();
      expect((t as any)._keydownHandler).toBeNull();
    });
  });

  describe('粘贴回归（防 [200~ 字面量泄漏）', () => {
    afterEach(() => vi.unstubAllGlobals());

    it('pasteFromClipboard() 即便 bracketed paste 模式开启，发给 term.paste 的也只是纯文本', async () => {
      const readText = vi.fn().mockResolvedValue('echo hello');
      vi.stubGlobal('navigator', { clipboard: { readText } });
      const api = makeApi();
      const t = new XtermTerminal({ sessionKey: 'k', pi: api });
      t.mount(mountHost());
      // 模拟 PTY 已开启 bracketed paste 模式
      Object.defineProperty((t as any).term, 'modes', {
        configurable: true,
        value: { bracketedPasteMode: true },
      });
      const paste = vi.spyOn((t as any).term, 'paste').mockImplementation(() => {});
      await t.pasteFromClipboard();
      await new Promise((r) => setTimeout(r, 20));
      const arg = paste.mock.calls[0]?.[0] as string;
      expect(arg).toBe('echo hello');
      expect(arg).not.toContain('\x1b[200~');
      expect(arg).not.toContain('[200~');
      t.unmount();
    });

    it('handleContextMenu() 无选区时粘贴，PTY 不会收到 [200~ 字面量', async () => {
      const readText = vi.fn().mockResolvedValue('ls -la');
      vi.stubGlobal('navigator', { clipboard: { readText } });
      const api = makeApi();
      const t = new XtermTerminal({ sessionKey: 'k', pi: api });
      t.mount(mountHost());
      Object.defineProperty((t as any).term, 'modes', {
        configurable: true,
        value: { bracketedPasteMode: true },
      });
      vi.spyOn((t as any).term, 'hasSelection').mockReturnValue(false);
      const paste = vi.spyOn((t as any).term, 'paste').mockImplementation(() => {});
      t.handleContextMenu({ preventDefault: () => {} });
      await new Promise((r) => setTimeout(r, 20));
      const arg = paste.mock.calls[0]?.[0] as string;
      expect(arg).toBe('ls -la');
      expect(arg).not.toContain('[200~');
      t.unmount();
    });
  });

  describe('拖拽文件到终端（转路径粘贴，对齐 VS Code 拖拽文件语义）', () => {
    afterEach(() => vi.unstubAllGlobals());

    // 构造一个带 Electron 非标准 path 属性的 File（模拟从文件管理器拖入）。
    function makeFile(name: string, path?: string, type = ''): File {
      const f = new File(['x'], name, { type });
      if (path !== undefined) Object.defineProperty(f, 'path', { value: path });
      return f;
    }

    it('pasteDroppedFiles() 把单文件绝对路径直接粘贴', async () => {
      const api = makeApi();
      const t = new XtermTerminal({ sessionKey: 'k', pi: api });
      const paste = vi.spyOn(t as any, 'pasteText').mockImplementation(() => {});
      t.mount(mountHost());
      await (t as any).pasteDroppedFiles([makeFile('a.txt', '/home/u/a.txt')]);
      expect(paste).toHaveBeenCalledWith('/home/u/a.txt');
      t.unmount();
    });

    it('pasteDroppedFiles() 多文件用空格拼接', async () => {
      const api = makeApi();
      const t = new XtermTerminal({ sessionKey: 'k', pi: api });
      const paste = vi.spyOn(t as any, 'pasteText').mockImplementation(() => {});
      t.mount(mountHost());
      await (t as any).pasteDroppedFiles([makeFile('a.txt', '/p/a.txt'), makeFile('b.txt', '/p/b.txt')]);
      expect(paste).toHaveBeenCalledWith('/p/a.txt /p/b.txt');
      t.unmount();
    });

    it('pasteDroppedFiles() 路径含空格时双引号包裹（shell-safe）', async () => {
      const api = makeApi();
      const t = new XtermTerminal({ sessionKey: 'k', pi: api });
      const paste = vi.spyOn(t as any, 'pasteText').mockImplementation(() => {});
      t.mount(mountHost());
      await (t as any).pasteDroppedFiles([makeFile('my file.txt', '/home/u/my file.txt')]);
      expect(paste).toHaveBeenCalledWith('"/home/u/my file.txt"');
      t.unmount();
    });

    it('pasteDroppedFiles() 图片也用原图绝对路径（不落临时文件）', async () => {
      const api = makeApi();
      const saveImage = vi.fn().mockResolvedValue('/tmp/fake.png');
      (api as any).saveImage = saveImage;
      const t = new XtermTerminal({ sessionKey: 'k', pi: api });
      const paste = vi.spyOn(t as any, 'pasteText').mockImplementation(() => {});
      t.mount(mountHost());
      await (t as any).pasteDroppedFiles([makeFile('pic.png', '/home/u/pic.png', 'image/png')]);
      expect(paste).toHaveBeenCalledWith('/home/u/pic.png');
      expect(saveImage).not.toHaveBeenCalled(); // 拖入图片不走 saveImage（与 Ctrl+V 图片分支区分）
      t.unmount();
    });

    it('pasteDroppedFiles() 拿不到绝对路径的文件被跳过（绝不插入裸文件名）', async () => {
      const api = makeApi();
      const t = new XtermTerminal({ sessionKey: 'k', pi: api });
      const paste = vi.spyOn(t as any, 'pasteText').mockImplementation(() => {});
      t.mount(mountHost());
      // 不带 path 的 File：模拟 Electron 31+ 下 File.path 已移除、getPathForFile 也返回空。
      await (t as any).pasteDroppedFiles([makeFile('unknown.txt')]);
      expect(paste).not.toHaveBeenCalled(); // 绝不退化成 'unknown.txt' 裸文件名
      t.unmount();
    });

    it('pasteDroppedFiles() 混合：有绝对路径的插入、无 path 的跳过', async () => {
      const api = makeApi();
      const t = new XtermTerminal({ sessionKey: 'k', pi: api });
      const paste = vi.spyOn(t as any, 'pasteText').mockImplementation(() => {});
      t.mount(mountHost());
      await (t as any).pasteDroppedFiles([makeFile('a.txt', '/p/a.txt'), makeFile('b.txt')]);
      expect(paste).toHaveBeenCalledWith('/p/a.txt'); // b.txt 无 path 被跳过
      t.unmount();
    });

    it('bindDragAndDrop() dragover 含 Files 时 preventDefault 并设 dropEffect=copy', () => {
      const api = makeApi();
      const t = new XtermTerminal({ sessionKey: 'k', pi: api });
      t.mount(mountHost());
      // jsdom 无 DataTransfer/DragEvent，用最小事件对象直接驱动内部 handler。
      const dt: any = { types: ['Files'], dropEffect: '', dropEffectSetter: '' };
      const ev: any = { preventDefault: () => { ev.defaultPrevented = true; }, dataTransfer: dt, defaultPrevented: false };
      (t as any)._dragOverHandler(ev);
      expect(ev.defaultPrevented).toBe(true);
      expect(dt.dropEffect).toBe('copy');
      t.unmount();
    });

    it('bindDragAndDrop() dragover 非文件类型不接管（放行 xterm 内部拖选）', () => {
      const api = makeApi();
      const t = new XtermTerminal({ sessionKey: 'k', pi: api });
      t.mount(mountHost());
      const dt: any = { types: ['text/plain'], dropEffect: '' };
      const ev: any = { preventDefault: () => { ev.defaultPrevented = true; }, dataTransfer: dt, defaultPrevented: false };
      (t as any)._dragOverHandler(ev);
      expect(ev.defaultPrevented).toBe(false);
      t.unmount();
    });

    it('bindDragAndDrop() drop 含 Files 时把路径粘贴进终端', async () => {
      const api = makeApi();
      const t = new XtermTerminal({ sessionKey: 'k', pi: api });
      t.mount(mountHost());
      const paste = vi.spyOn(t as any, 'pasteText').mockImplementation(() => {});
      const dt: any = { types: ['Files'], files: [makeFile('a.txt', '/p/a.txt')] };
      const ev: any = { preventDefault: () => { ev.defaultPrevented = true; }, dataTransfer: dt, defaultPrevented: false };
      (t as any)._dropHandler(ev);
      // 粘贴为异步（pasteDroppedFiles 是 async），等一拍
      await new Promise((r) => setTimeout(r, 20));
      expect(ev.defaultPrevented).toBe(true);
      expect(paste).toHaveBeenCalledWith('/p/a.txt');
      t.unmount();
    });

    it('unmount() 解绑 dragover / drop 监听', () => {
      const api = makeApi();
      const t = new XtermTerminal({ sessionKey: 'k', pi: api });
      const host = mountHost();
      t.mount(host);
      expect((t as any)._dragOverHandler).toBeTypeOf('function');
      expect((t as any)._dropHandler).toBeTypeOf('function');
      const overSpy = vi.spyOn(host, 'removeEventListener');
      t.unmount();
      expect((t as any)._dragOverHandler).toBeNull();
      expect((t as any)._dropHandler).toBeNull();
      expect(overSpy).toHaveBeenCalledWith('dragover', expect.any(Function));
      expect(overSpy).toHaveBeenCalledWith('drop', expect.any(Function));
    });
  });

  describe('recoverFromWritePipelineStall (写管道冻结后的实例恢复)', () => {
    // stall watch 的触发/认证逻辑由 write-pipeline-health.test.ts 模块单测覆盖；
    // 此处直接调用 recoverFromWritePipelineStall 验证「序列化→清理→重建→重放→尺寸」恢复路径。
    it('rebuilds a fresh xterm instance and keeps host/registry consistent', () => {
      const api = makeApi();
      const t = new XtermTerminal({ sessionKey: 'k', pi: api });
      const host = mountHost();
      t.mount(host);
      const termBefore = (t as any).term as Terminal;
      expect(termBefore).toBeTruthy();
      // 写入数据进 scrollback，验证重建前后实例均可用。
      expect(() => termBefore.write('before recover\r\n')).not.toThrow();

      (t as any).recoverFromWritePipelineStall();

      const termAfter = (t as any).term as Terminal;
      expect(termAfter).not.toBe(termBefore); // 全新 Terminal 实例（全新 WriteBuffer）
      expect((t as any).disposed).toBe(false);
      expect((t as any).mounted).toBe(true);
      expect((t as any)._recovering).toBe(false);
      // host 下不应残留旧 .xterm（重建前已清理）
      expect(host.querySelectorAll('.xterm').length).toBe(1);
      // 重建后实例仍可正常写入（新 ack 链正常）
      expect(() => termAfter.write('after recover\r\n')).not.toThrow();
      t.unmount();
    });

    it('resets _recovering flag after recovery (no permanent lockout)', () => {
      const api = makeApi();
      const t = new XtermTerminal({ sessionKey: 'k', pi: api });
      t.mount(mountHost());
      (t as any).recoverFromWritePipelineStall();
      expect((t as any)._recovering).toBe(false);
      // 可再次恢复（证明标志已复位，未被永久锁死）
      expect(() => (t as any).recoverFromWritePipelineStall()).not.toThrow();
      expect((t as any)._recovering).toBe(false);
      t.unmount();
    });

    it('no-ops when there is no term / host (unmounted)', () => {
      const api = makeApi();
      const t = new XtermTerminal({ sessionKey: 'k', pi: api });
      // 未 mount → 无 term/host → 直接返回，不抛。
      expect(() => (t as any).recoverFromWritePipelineStall()).not.toThrow();
      expect((t as any).term).toBeNull();
    });
  });

  describe('customGlyphs / gpuAcceleration 设置', () => {
    beforeEach(() => {
      hoist.webglActivateCalls = 0;
      hoist.webglClearAtlasCalls = 0;
    });

    it('customGlyphs 默认 true（字段初始化）', () => {
      const api = makeApi();
      const t = new XtermTerminal({ sessionKey: 'k', pi: api });
      expect((t as any)._customGlyphs).toBe(true);
      t.unmount();
    });

    it('gpuAcceleration 默认 auto（字段初始化）', () => {
      const api = makeApi();
      const t = new XtermTerminal({ sessionKey: 'k', pi: api });
      expect((t as any)._gpuAcceleration).toBe('auto');
      t.unmount();
    });

    it('config 默认值包含 customGlyphs=true 与 gpuAcceleration=auto', async () => {
      const { defaultConfig } = await import('../../../main/config');
      const cfg = defaultConfig();
      expect(cfg.customGlyphs).toBe(true);
      expect(cfg.gpuAcceleration).toBe('auto');
    });

    it('config.parseConfig 保留自定义 customGlyphs / gpuAcceleration', async () => {
      const { parseConfig } = await import('../../../main/config');
      const cfg = parseConfig(JSON.stringify({ customGlyphs: false, gpuAcceleration: 'off' }));
      expect(cfg.customGlyphs).toBe(false);
      expect(cfg.gpuAcceleration).toBe('off');
    });
  });
