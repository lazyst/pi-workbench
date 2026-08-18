// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import App from '../App';
import { defaultConfig } from '../../../main/config';
import { useTabStore } from '../store/tabStore';
import { getAllTabs } from '../store/splitStore';

const CONFIG = defaultConfig();

// store 是模块级单例，每个用例 render(<App/>) 前重置，保证从干净状态开始
beforeEach(() => {
  useTabStore.setState({
    cwdTrees: {},
    activeCwd: null,
    activeLeafId: null,
    activeTabId: null,
    cwdOrder: [],
    cwdActiveLeafId: {},
    cwdActiveTab: {},
    cwdTabHistory: {},
    terminals: [],
  });
});

// 构造带统一终端 IPC 桩的 pi，供 App 统一 TabBar 终端测试使用。
function makeApi(overrides: Record<string, unknown> = {}) {
  const api = {
    listSessions: vi.fn().mockResolvedValue([]),
    openSession: vi.fn(),
    terminate: vi.fn(),
    input: vi.fn(),
    resize: vi.fn(),
    onData: vi.fn(() => () => {}),
    onStatus: vi.fn(() => () => {}),
    onExit: vi.fn(() => () => {}),
    onIndex: vi.fn(() => () => {}),
    onRelink: vi.fn(() => () => {}),
    onTerminalExit: vi.fn(() => () => {}),
    onTerminalList: vi.fn((cb: (list: any[]) => void) => {
      (api as any)._termListCb = cb;
      return () => { (api as any)._termListCb = null; };
    }),
    pickDirectory: vi.fn(),
    debug: vi.fn(),
    getConfig: vi.fn().mockResolvedValue(CONFIG),
    setConfig: vi.fn().mockResolvedValue(undefined),
    deleteSession: vi.fn(),
    deleteMany: vi.fn(),
    clearDirectory: vi.fn(),
    listTerminalProfiles: vi.fn().mockResolvedValue([
      { id: 'pwsh', name: 'PowerShell', shell: 'pwsh', args: [] },
      { id: 'bash', name: 'bash', shell: 'bash', args: [] },
    ]),
    spawnTerminal: vi.fn(async () => {
      const info = { id: 't-1', key: 't-1', cwd: '/', title: 'PowerShell', name: 'PowerShell', type: 'shell', status: 'running' };
      (api as any)._termListCb?.([info]);
      return info;
    }),
    destroyTerminal: vi.fn(async (id: string) => {
      (api as any)._termListCb?.([]);
      return undefined;
    }),
    terminalInput: vi.fn(),
    terminalResize: vi.fn(),
    onTerminalData: vi.fn(() => () => {}),
    gitWatch: vi.fn(() => () => {}),
    ...overrides,
  };
  (window as any).pi = api;
  return api;
}

describe('App 统一 TabBar 终端（Phase 2）', () => {
  it('关闭终端 tab → 杀 PTY + 移除 tab，侧边栏计数更新', async () => {
    const api = makeApi();
    render(<App />);

    // 通过 store 直接创建终端 tab 模拟侧边栏操作
    act(() => {
      useTabStore.getState().openTerminal('t-1', '/', 'PowerShell');
    });

    // TabBar 中的关闭按钮（class="tab-close"）。
    const closeBtn = document.querySelector('.tab-close') as HTMLButtonElement;
    expect(closeBtn).toBeTruthy();
    fireEvent.click(closeBtn);

    // destroyTerminal 被调用，杀死 PTY
    await waitFor(() => expect(api.destroyTerminal).toHaveBeenCalled());
    // 标签从 DOM 移除
    await waitFor(() => {
      expect(screen.queryByText('PowerShell')).toBeNull();
    });
    // store.terminals 已清空（mock destroyTerminal 回调 _termListCb([])）
    expect(useTabStore.getState().terminals).toEqual([]);
    // tab 被真移除（不再是 hidden）
    expect(getAllTabs(useTabStore.getState()).length).toBe(0);
  });
});
