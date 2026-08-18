// @vitest-environment jsdom
//
// PaneManager 单元测试（issue 06）：验证实例注册表 + 统一 keep-alive / resize / 通道驱动。
//
// 覆盖点：
//  - acquirePane 按 key 复用同一实例（keep-alive：不重建），session / integrated 两种 kind 选不同 channel；
//  - releasePane 注销实例（实例 unmount 被调用）；
//  - setPaneActive / schedulePaneResize / scrollPaneToBottom / paneHandleContextMenu 正确路由到存活实例；
//  - 集成终端用 IntegratedChannel、会话终端用 SessionChannel（统一入口的通道差异）。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  acquirePane,
  releasePane,
  hasPane,
  paneCount,
  setPaneActive,
  schedulePaneResize,
  scrollPaneToBottom,
  paneHandleContextMenu,
  setPaneScrollHandler,
  resetPanes,
  focusPane,
} from '../components/paneManager';
import { XtermTerminal } from '../components/XtermTerminal';
import { SessionChannel, IntegratedChannel } from '../components/terminalChannel';
import { IntegratedPane } from '../components/IntegratedPane';
import { render } from '@testing-library/react';
import type { PiApi } from '../ipc';

// 无头 jsdom 无 WebGL 上下文，用轻量 mock 替换真实 WebglAddon。
vi.mock('@xterm/addon-webgl', () => {
  class WebglAddon {
    activate() {}
    onContextLoss() {}
    dispose() {}
  }
  return { WebglAddon };
});

function makeApi() {
  return {
    listSessions: vi.fn(), openSession: vi.fn(), terminate: vi.fn(),
    input: vi.fn(), resize: vi.fn(), onData: vi.fn(() => () => {}), onStatus: vi.fn(() => () => {}),
    onExit: vi.fn(), pickDirectory: vi.fn(), debug: vi.fn(),
    createTerminal: vi.fn(async () => ({ id: 'term-1', profileId: 'p', cwd: '/', title: 'shell' })),
    destroyTerminal: vi.fn(async () => {}),
    terminalInput: vi.fn(), terminalResize: vi.fn(),
    onTerminalData: vi.fn(() => () => {}), onTerminalExit: vi.fn(() => () => {}),
  } as unknown as PiApi;
}

describe('PaneManager 实例注册表与统一通道', () => {
  beforeEach(() => {
    resetPanes();
    (window as any).pi = makeApi();
  });
  afterEach(() => {
    resetPanes();
    vi.restoreAllMocks();
  });

  it('acquirePane 按 key 复用同一实例（keep-alive：不重建）', () => {
    const a = acquirePane({ key: 'k1', kind: 'session', pi: (window as any).pi });
    const b = acquirePane({ key: 'k1', kind: 'session', pi: (window as any).pi });
    expect(a).toBe(b);
    expect(paneCount()).toBe(1);
    expect(hasPane('k1')).toBe(true);
  });

  it('不同 key 各占一个实例，互不干扰', () => {
    acquirePane({ key: 'k1', kind: 'session', pi: (window as any).pi });
    acquirePane({ key: 'k2', kind: 'integrated', pi: (window as any).pi });
    expect(paneCount()).toBe(2);
  });

  it('session kind 注入 SessionChannel、integrated kind 注入 IntegratedChannel', () => {
    const api = (window as any).pi as PiApi;
    const sTerm = acquirePane({ key: 's-x', kind: 'session', pi: api });
    const iTerm = acquirePane({ key: 'i-x', kind: 'integrated', pi: api });
    expect((sTerm as any).channel).toBeInstanceOf(SessionChannel);
    expect((iTerm as any).channel).toBeInstanceOf(IntegratedChannel);
  });

  it('releasePane 注销实例且调用 XtermTerminal.unmount', () => {
    const unmountSpy = vi.spyOn(XtermTerminal.prototype, 'unmount');
    acquirePane({ key: 'k1', kind: 'session', pi: (window as any).pi });
    expect(paneCount()).toBe(1);
    releasePane('k1');
    expect(paneCount()).toBe(0);
    expect(hasPane('k1')).toBe(false);
    expect(unmountSpy).toHaveBeenCalled();
  });

  it('setPaneActive 路由到存活实例（active 切换不重建）', () => {
    const setActiveSpy = vi.spyOn(XtermTerminal.prototype, 'setActive');
    acquirePane({ key: 'k1', kind: 'session', pi: (window as any).pi });
    setPaneActive('k1', true);
    setPaneActive('k1', false);
    expect(setActiveSpy).toHaveBeenCalledWith(true);
    expect(setActiveSpy).toHaveBeenCalledWith(false);
  });

  it('schedulePaneResize / scrollPaneToBottom / paneHandleContextMenu 路由到存活实例', () => {
    const resizeSpy = vi.spyOn(XtermTerminal.prototype, 'scheduleResize');
    const bottomSpy = vi.spyOn(XtermTerminal.prototype, 'scrollToBottom');
    const ctxSpy = vi.spyOn(XtermTerminal.prototype, 'handleContextMenu');
    acquirePane({ key: 'k1', kind: 'session', pi: (window as any).pi });
    schedulePaneResize('k1');
    scrollPaneToBottom('k1');
    paneHandleContextMenu('k1', { preventDefault: () => {} });
    expect(resizeSpy).toHaveBeenCalled();
    expect(bottomSpy).toHaveBeenCalled();
    expect(ctxSpy).toHaveBeenCalled();
  });

  it('focusPane 路由到存活实例（点击 tab 聚焦终端）', () => {
    const focusSpy = vi.spyOn(XtermTerminal.prototype, 'focus');
    acquirePane({ key: 'k1', kind: 'session', pi: (window as any).pi });
    focusPane('k1');
    expect(focusSpy).toHaveBeenCalled();
    // 不存在的 key 安全无操作
    expect(() => focusPane('no-such')).not.toThrow();
  });

  it('setPaneScrollHandler 设置实例的 onScrollState 回调', () => {
    const term = acquirePane({ key: 'k1', kind: 'session', pi: (window as any).pi });
    const cb = vi.fn();
    setPaneScrollHandler('k1', cb);
    expect((term as any).onScrollState).toBe(cb);
    setPaneScrollHandler('k1', null);
    expect((term as any).onScrollState).toBeNull();
  });

  it('路由方法对不存在的 key 安全无操作（不抛错）', () => {
    expect(() => {
      setPaneActive('no-such', true);
      schedulePaneResize('no-such');
      scrollPaneToBottom('no-such');
      paneHandleContextMenu('no-such', { preventDefault: () => {} });
      setPaneScrollHandler('no-such', null);
      releasePane('no-such');
    }).not.toThrow();
  });

  it('IntegratedPane 经 PaneManager 注册实例（集成终端 keep-alive 入口打通）', () => {
    vi.spyOn(XtermTerminal.prototype, 'mount').mockImplementation(function (this: any) {
      this.mounted = true;
    });
    const { unmount } = render(<IntegratedPane terminalId="term-pm" active={true} />);
    expect(hasPane('term-pm')).toBe(true);
    expect(paneCount()).toBeGreaterThanOrEqual(1);
    unmount();
    // 卸载后实例被 releasePane 注销。
    expect(hasPane('term-pm')).toBe(false);
  });
});
