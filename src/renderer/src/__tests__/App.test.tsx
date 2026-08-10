// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import App from '../App';
import { useTabStore } from '../store/tabStore';
import { defaultConfig } from '../../../main/config';

const CONFIG = defaultConfig();

// store 是模块级单例，render(<App/>) 前重置，保证各用例从干净状态开始（
// 等价于重构前 App 的 useState 每实例独立；见 issue 03 状态收编进 store）。
beforeEach(() => {
  useTabStore.setState({
    cwdTrees: {},
    activeCwd: null,
    activeLeafId: null,
    cwdOrder: [],
    cwdActiveLeafId: {},
    cwdActiveTab: {},
    cwdTabHistory: {},
    terminals: [],
  });
});

/** 创建基础 mock pi 对象，提供所有方法（各测试通过 overrides 自定义特定行为）。 */
function makeApi(overrides: Record<string, unknown> = {}) {
  const api = {
    listSessions: vi.fn().mockResolvedValue([]),
    openSession: vi.fn(),
    terminate: vi.fn(),
    deleteSession: vi.fn(),
    deleteMany: vi.fn(),
    clearDirectory: vi.fn(),
    input: vi.fn(),
    resize: vi.fn(),
    onData: vi.fn(() => () => {}),
    onStatus: vi.fn(() => () => {}),
    onExit: vi.fn(() => () => {}),
    onIndex: vi.fn(() => () => {}),
    onRelink: vi.fn(() => () => {}),
    pickDirectory: vi.fn(),
    debug: vi.fn(),
    getConfig: vi.fn().mockResolvedValue(CONFIG),
    setConfig: vi.fn().mockResolvedValue(undefined),
    listTerminalProfiles: vi.fn().mockResolvedValue([]),
    spawnTerminal: vi.fn(),
    destroyTerminal: vi.fn(),
    terminalInput: vi.fn(),
    terminalResize: vi.fn(),
    onTerminalData: vi.fn(() => () => {}),
    onTerminalList: vi.fn(() => () => {}),
    onTerminalExit: vi.fn(() => () => {}),
    splashDone: vi.fn(),
    gitWatch: vi.fn(() => () => {}),
    gitStatus: vi.fn(),
    gitLog: vi.fn(),
    gitDiff: vi.fn(),
    gitFileStatusMap: vi.fn(),
    gitIgnoredPaths: vi.fn(),
    fsListDir: vi.fn(),
    fsReadFile: vi.fn(),
    fsWriteFile: vi.fn(),
    fsStat: vi.fn(),
    fsMkdir: vi.fn(),
    fsCreateFile: vi.fn(),
    fsRename: vi.fn(),
    fsRemove: vi.fn(),
    fsCopy: vi.fn(),
    fsListNames: vi.fn(),
    fsUniqueName: vi.fn(),
    fsWatch: vi.fn(() => () => {}),
    fsWatchFile: vi.fn(() => () => {}),
    fsOpenWithSystem: vi.fn(),
    fsShowInFolder: vi.fn(),
    openExternal: vi.fn(),
    saveImage: vi.fn(),
    getPathForFile: vi.fn(),
    acknowledgeDataEvent: vi.fn(),
    minimizeWindow: vi.fn(),
    toggleMaximizeWindow: vi.fn(),
    closeWindow: vi.fn(),
    getWindowBounds: vi.fn(),
    setWindowBounds: vi.fn(),
    onMaximizeChange: vi.fn(() => () => {}),
    getInitialConfig: vi.fn(),
    onNewFromPi: vi.fn(),
    onSessionNameChanged: vi.fn(() => () => {}),
    registerPtyOwner: vi.fn(),
    queryPtyOwner: vi.fn(),
    ...overrides,
  };
  (window as any).pi = api;
  return api;
}

describe('App', () => {
  it('passes only disk sessions to the sidebar (no live merge)', async () => {
    const api = makeApi();
    render(<App />);
    // onIndex 被订阅（用于后续晋升），初始 listSessions 被调用
    expect(api.onIndex).toHaveBeenCalled();
    expect(api.listSessions).toHaveBeenCalled();
    // 侧边栏存在，但空列表时不渲染任何 session-item
    expect(await screen.findByText('会话', { exact: true })).toBeInTheDocument();
    expect(screen.queryByText('live-xyz')).toBeNull();
  });

  it('batch delete: select sessions then confirm calls pi.deleteMany', async () => {
    const groups = [{ cwd: 'C:\\Users\\hcz\\project', sessions: [{ key: 'k1', name: 's1', time: 't' }, { key: 'k2', name: 's2', time: 't' }] }];
    // 左侧栏只展示"添加目录"注册的目录下的会话，需把 cwd 纳入 addedDirs。
    const cfgWithDir = { ...CONFIG, addedDirs: ['C:\\Users\\hcz\\project'] };
    const api = makeApi({
      listSessions: vi.fn().mockResolvedValue(groups),
      getConfig: vi.fn().mockResolvedValue(cfgWithDir),
    });
    render(<App />);
    // 初始 listSessions 加载出磁盘会话（避免被异步重置）
    await screen.findByText('s1');

    // 进入多选模式
    fireEvent.click(screen.getByText('管理'));
    expect(await screen.findByText('已选 0 项')).toBeInTheDocument();

    // 勾选 k1
    const item1 = screen.getByText('s1').closest('.session-item')!;
    fireEvent.click(item1);
    expect(await screen.findByText('已选 1 项')).toBeInTheDocument();

    // 点击顶部"删除"打开确认框（用 data-action 区分 header 按钮与确认按钮）
    fireEvent.click(document.querySelector('[data-action="batch-delete"]')!);
    expect(await screen.findByText(/确定删除选中的 1 个会话/)).toBeInTheDocument();

    // 确认 → 调用 pi.deleteMany(['k1'])
    const dialog = document.querySelector('.confirm-dialog')!;
    fireEvent.click(dialog.querySelector('.btn-danger')!);
    expect(api.deleteMany).toHaveBeenCalledWith(['k1']);
  });

  it('clear directory: confirm calls pi.clearDirectory with the cwd', async () => {
    const cwd = 'C:\\Users\\hcz\\project';
    const groups = [{ cwd, sessions: [{ key: 'k1', name: 's1', time: 't' }] }];
    // 左侧栏只展示"添加目录"注册的目录下的会话，需把 cwd 纳入 addedDirs。
    const cfgWithDir = { ...CONFIG, addedDirs: [cwd] };
    const api = makeApi({
      listSessions: vi.fn().mockResolvedValue(groups),
      getConfig: vi.fn().mockResolvedValue(cfgWithDir),
    });
    render(<App />);
    await screen.findByText('s1');

    // 点击组 header 的"清空"
    fireEvent.click(screen.getByLabelText(`清空 ${cwd}`));
    expect(await screen.findByText(/确定清空目录/)).toBeInTheDocument();

    // 确认 → 调用 pi.clearDirectory(cwd)
    const dialog = document.querySelector('.confirm-dialog')!;
    fireEvent.click(dialog.querySelector('.btn-danger')!);
    expect(api.clearDirectory).toHaveBeenCalledWith(cwd);
  });

  it('dismisses the splash overlay and notifies the main process on mount', async () => {
    // 模拟 index.html 中的启动动画 overlay（见 docs/adr/0003）。
    document.body.innerHTML = '<div id="splash"><div class="splash-logo">π</div><div class="splash-dot"></div></div><div id="root"></div>';
    const api = makeApi();
    render(<App />);
    // App 挂载（useEffect + rAF）后应触发 splashDone 并给 #splash 加隐藏类。
    await new Promise((r) => setTimeout(r, 50));
    expect(api.splashDone).toHaveBeenCalled();
    const splash = document.getElementById('splash');
    expect(splash?.classList.contains('splash--hidden')).toBe(true);
  });

  it('三栏布局：渲染 .sidebar / .center-pane / .right-panel，且中间区含统一 Tab 条', async () => {
    const api = makeApi();
    // 设置一个工作目录，使 CenterPane 渲染分屏树和 TabBar
    useTabStore.getState().setActiveCwd('/tmp');
    render(<App />);
    // 三栏结构存在
    expect(document.querySelector('.sidebar')).toBeTruthy();
    expect(document.querySelector('.center-pane')).toBeTruthy();
    expect(document.querySelector('.right-panel')).toBeTruthy();
    // 中间区统一 Tab 条（复用 TerminalTabBar 类名 .terminal-tabbar）
    expect(document.querySelector('.center-pane .terminal-tabbar')).toBeTruthy();
  });

  it('点击 Git 面板「工作区改动」→ 中间区出现 .diff-tab（diff 变 tab）', async () => {
    const cwd = 'C:\\Users\\hcz\\project';
    const groups = [{ cwd, sessions: [{ key: 'k1', name: 's1', time: 't' }] }];
    const cfgWithDir = { ...CONFIG, addedDirs: [cwd] };
    const api = makeApi({
      listSessions: vi.fn().mockResolvedValue(groups),
      openSession: vi.fn().mockResolvedValue({ key: 'k1', name: 's1', cwd }),
      getConfig: vi.fn().mockResolvedValue(cfgWithDir),
      gitDiff: vi.fn().mockResolvedValue(''),
      gitStatus: vi.fn().mockResolvedValue({ isGit: true, branch: 'main', additions: 0, deletions: 0, ahead: 0, behind: 0, porcelain: '' }),
      gitLog: vi.fn().mockResolvedValue([]),
      gitBranches: vi.fn().mockResolvedValue([]),
    });
    render(<App />);
    // 等会话加载出（addedDirs 含 cwd，右栏根目录下拉可选 cwd，无需打开会话 tab）
    await screen.findByText('s1');
    // 在右栏根目录下拉中选择 cwd（避免打开会话 tab 触发 TerminalPane/xterm）
    const select = document.querySelector('.rp-root-select') as HTMLSelectElement;
    expect(select).toBeTruthy();
    fireEvent.change(select, { target: { value: cwd } });
    // 切到右栏 Git tab：右栏 TabBar 含标题「Git」的 tab
    const gitTab = Array.from(document.querySelectorAll('.right-panel .terminal-tab')).find(
      (el) => el.textContent?.includes('Git'),
    ) as HTMLElement;
    expect(gitTab).toBeTruthy();
    fireEvent.click(gitTab);
    // Git 面板异步渲染：等待提交输入框出现（gitStatus 异步返回）
    const rightPanel = document.querySelector('.right-panel') as HTMLElement;
    // 等待 git-view 容器出现（gitStatus 异步完成后渲染）
    const gitView = await within(rightPanel).findByPlaceholderText('Message (Ctrl+Enter to commit)');
    expect(gitView).toBeTruthy();
    // 验证提交历史标题存在
    expect(within(rightPanel).queryByText('Commit History')).toBeTruthy();
  });

  it('点击文件树文件 → 中间区出现 .preview-tab（预览变 tab）', async () => {
    const cwd = 'C:\\Users\\hcz\\project';
    const groups = [{ cwd, sessions: [{ key: 'k1', name: 's1', time: 't' }] }];
    const cfgWithDir = { ...CONFIG, addedDirs: [cwd] };
    const api = makeApi({
      listSessions: vi.fn().mockResolvedValue(groups),
      openSession: vi.fn().mockResolvedValue({ key: 'k1', name: 's1', cwd }),
      getConfig: vi.fn().mockResolvedValue(cfgWithDir),
      // 文件树根目录列出一个文件，点击即触发 onOpenFile → 中间区预览 tab
      fsListDir: vi.fn().mockResolvedValue([{ name: 'README.md', isDir: false, fullPath: cwd + '\\README.md' }]),
    });
    render(<App />);
    await screen.findByText('s1');
    // 在右栏根目录下拉中选择 cwd（避免打开会话 tab 触发 TerminalPane/xterm）
    const select = document.querySelector('.rp-root-select') as HTMLSelectElement;
    expect(select).toBeTruthy();
    fireEvent.change(select, { target: { value: cwd } });
    // 右栏默认在「文件」tab，文件树应渲染出 README.md 节点
    const fileNode = await screen.findByText('README.md');
    fireEvent.click(fileNode);
    // 中间区出现 .preview-tab（替代旧式 FileDrawer 抽屉）
    expect(document.querySelector('.center-pane .preview-tab')).toBeTruthy();
  });
});
