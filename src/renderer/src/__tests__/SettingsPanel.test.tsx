// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { SettingsPanel } from '../components/SettingsPanel';
import { defaultConfig } from '../../../main/config';

const CONFIG = defaultConfig();

// 构建组件挂载所需的 window.pi mock。SettingsPanel 的「常规」页会渲染 UpdateCheck，
// 其在挂载时调用 getCurrentVersion / getUpdateStatus，缺了会抛 “pi.xxx is not a function”。
function makeApi(overrides: Record<string, any> = {}): Record<string, any> {
  return {
    getConfig: vi.fn().mockResolvedValue(CONFIG),
    setConfig: vi.fn().mockResolvedValue(undefined),
    getCurrentVersion: vi.fn().mockResolvedValue('1.0.0'),
    getUpdateStatus: vi.fn().mockResolvedValue(null),
    listSessions: vi.fn().mockResolvedValue([]),
    readSessionContent: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

describe('SettingsPanel', () => {
  // 会话管理相关测试会 handleNav('sessions') 并把导航写入 localStorage，
  // 若不清理，后续测试会从「会话管理」页起步，导致 GeneralSettings（含字体大小）不渲染。
  beforeEach(() => {
    localStorage.removeItem('pi-workbench:settings-nav');
  });

  it('renders a close-behavior segmented control defaulting to minimize-to-tray', async () => {
    const api = makeApi();
    (window as any).pi = api;
    render(<SettingsPanel onClose={() => {}} />);

    expect(await screen.findByText('关闭按钮行为')).toBeInTheDocument();
    const closeBtn = screen.getByText('直接关闭');
    const minimizeBtn = screen.getByText('最小化到托盘');
    expect(closeBtn).toBeInTheDocument();
    expect(minimizeBtn).toBeInTheDocument();

    // default config is minimize-to-tray → that segment is the active one
    expect(minimizeBtn.getAttribute('aria-checked')).toBe('true');
    expect(closeBtn.getAttribute('aria-checked')).toBe('false');
  });

  it('switching close behavior persists via setConfig', async () => {
    const api = makeApi();
    (window as any).pi = api;
    render(<SettingsPanel onClose={() => {}} />);

    const closeBtn = await screen.findByText('直接关闭');
    fireEvent.click(closeBtn);
    expect(api.setConfig).toHaveBeenCalledWith({ closeBehavior: 'close' });
    await waitFor(() =>
      expect(screen.getByText('直接关闭').getAttribute('aria-checked')).toBe('true'),
    );

    fireEvent.click(screen.getByText('最小化到托盘'));
    expect(api.setConfig).toHaveBeenCalledWith({ closeBehavior: 'minimize-to-tray' });
    await waitFor(() =>
      expect(screen.getByText('最小化到托盘').getAttribute('aria-checked')).toBe('true'),
    );
  });

  it('renders 常规 and 会话管理 navigation items', async () => {
    const api = makeApi({ listSessions: vi.fn().mockResolvedValue([]) });
    (window as any).pi = api;
    render(<SettingsPanel onClose={() => {}} />);
    expect(screen.getByText('常规')).toBeInTheDocument();
    expect(screen.getByText('会话管理')).toBeInTheDocument();
  });

  it('会话管理 opens and lists sessions grouped by cwd with delete actions', async () => {
    const groups = [
      { cwd: 'C:\\work\\a', sessions: [{ key: 'k1', name: 'alpha', time: '10:00' }] },
      { cwd: 'C:\\work\\b', sessions: [{ key: 'k2', name: 'beta', time: '11:00' }] },
    ];
    const api = makeApi({
      listSessions: vi.fn().mockResolvedValue(groups),
      deleteSession: vi.fn().mockResolvedValue(undefined),
    });
    (window as any).pi = api;
    render(<SettingsPanel onClose={() => {}} />);

    fireEvent.click(screen.getByText('会话管理'));

    // 分组标题与会话可见
    expect(await screen.findByText('alpha')).toBeInTheDocument();
    expect(screen.getByText('beta')).toBeInTheDocument();
    expect(api.listSessions).toHaveBeenCalled();

    // 单条删除：点击垃圾桶图标按钮后弹确认，确认调用 deleteSession
    fireEvent.click(screen.getByText('alpha').closest('.session-item')!.querySelector('.session-delete')!);
    const dialog = await screen.findByText('删除会话');
    fireEvent.click(dialog.closest('.confirm-dialog')!.querySelector('.btn-danger')!);
    await waitFor(() => expect(api.deleteSession).toHaveBeenCalledWith('k1'));
  });

  it('会话管理：目录默认折叠为 3 个并显示总数，可展开/收起', async () => {
    const cwd = 'C:\\work\\many';
    const sessions = Array.from({ length: 5 }, (_, i) => ({ key: `k${i}`, name: `sess-${i}`, time: '10:0' + i }));
    const groups = [{ cwd, sessions }];
    const api = makeApi({ listSessions: vi.fn().mockResolvedValue(groups) });
    (window as any).pi = api;
    render(<SettingsPanel onClose={() => {}} />);

    fireEvent.click(screen.getByText('会话管理'));

    // 标题显示总数 （会话数：5）
    const groupName = await screen.findByText(/C:\\work\\many/);
    expect(groupName.textContent).toContain('（会话数：5）');

    // 默认只显示前 3 个会话
    expect(screen.getByText('sess-0')).toBeInTheDocument();
    expect(screen.getByText('sess-1')).toBeInTheDocument();
    expect(screen.getByText('sess-2')).toBeInTheDocument();
    expect(screen.queryByText('sess-3')).toBeNull();

    // 出现“展开 2 个”折叠开关
    const expandBtn = screen.getByText('展开 2 个');
    fireEvent.click(expandBtn);
    // 展开后显示全部，并变为“收起”
    expect(screen.getByText('sess-3')).toBeInTheDocument();
    expect(screen.getByText('sess-4')).toBeInTheDocument();
    expect(screen.getByText('收起')).toBeInTheDocument();
  });

  it('字体大小步进器：增大/减小调用 setConfig 并更新显示', async () => {
    const api = makeApi();
    (window as any).pi = api;
    render(<SettingsPanel onClose={() => {}} />);

    // 默认字号 15px（getFontSize 回退默认），显示 “15px”
    expect(await screen.findByText('字体大小')).toBeInTheDocument();
    expect(screen.getByText('15px')).toBeInTheDocument();

    // 点 + 增大到 16px 并持久化
    fireEvent.click(screen.getByLabelText('增大字体'));
    expect(api.setConfig).toHaveBeenCalledWith({ fontSize: 16 });
    await waitFor(() => expect(screen.getByText('16px')).toBeInTheDocument());

    // 点 − 减小回 15px
    fireEvent.click(screen.getByLabelText('减小字体'));
    expect(api.setConfig).toHaveBeenCalledWith({ fontSize: 15 });
    await waitFor(() => expect(screen.getByText('15px')).toBeInTheDocument());
  });
});
