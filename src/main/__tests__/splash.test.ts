// 启动动画（splash）主进程不变量测试（见 docs/adr/0003）：
//   1) 窗口以 show:false 创建（避免无边框窗口先闪白框）。
//   2) 注册 ipcMain 'splash:done' handler，收到后调用 win.show()；幂等。
//   3) 同文件附带「集成终端 IPC handler」轻量回归：复用 createWindow 已注册的
//      ipcHandlers（无需再 mock 一套 Electron），断言 terminal:* 信道存在且正确
//      转发到 termPool（IntegratedTerminalPool，node-pty 已被 mock，不 spawn 真 shell）。
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';

const showSpy = vi.fn();
const loadFileSpy = vi.fn();
const ipcHandlers: Record<string, (...a: any[]) => any> = {};
let readyResolver: (() => void) | undefined;

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp',
    commandLine: { appendSwitch: vi.fn() },
    whenReady: () => new Promise<void>((res) => { readyResolver = res; }),
    on: vi.fn(),
    quit: vi.fn(),
    requestSingleInstanceLock: () => true,
  },
  BrowserWindow: class {
    constructor(_opts: any) {}
    loadFile = loadFileSpy;
    loadURL = vi.fn();
    show = showSpy;
    setOpacity = vi.fn();
    maximize = vi.fn();
    isDestroyed = () => false;
    isVisible = () => false;
    focus = vi.fn();
    webContents = { send: vi.fn(), on: vi.fn(), setWindowOpenHandler: vi.fn() };
    on = vi.fn();
  },
  Tray: class { constructor() {} setToolTip() {} setContextMenu() {} on() {} },
  Menu: { buildFromTemplate: () => ({}) },
  nativeImage: { createFromPath: () => ({ isEmpty: () => true }) },
  dialog: { showOpenDialog: vi.fn() },
  ipcMain: {
    handle: (channel: string, cb: (...a: any[]) => any) => { ipcHandlers[channel] = cb; },
    on: (channel: string, cb: (...a: any[]) => any) => { ipcHandlers[channel] = cb; },
  },
  protocol: {
    registerSchemesAsPrivileged: vi.fn(),
    handle: vi.fn(),
  },
}));

// node-pty mock：logic.test 风格的 pty 对象（带 on/write/resize/kill + 实例级 emit），
// 仅用于下方「集成终端 IPC handler」回归中真正调用 terminal:create 时能被安全 spawn。
interface MockPty {
  write: ReturnType<typeof vi.fn>;
  resize: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  pid: number;
  _cbs: Record<string, (d?: any) => void>;
  emit: (e: string, d?: any) => void;
}
const mockPtys: MockPty[] = [];
vi.mock('node-pty', () => ({
  spawn: vi.fn(() => {
    const cbs: Record<string, (d?: any) => void> = {};
    const pty: MockPty = {
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      on: vi.fn((e: string, cb: (d?: any) => void) => { cbs[e] = cb; }),
      pid: 1234,
      _cbs: cbs,
      emit: (e: string, d?: any) => cbs[e]?.(d),
    };
    mockPtys.push(pty);
    return pty;
  }),
}));
vi.mock('fs', () => ({ default: { readFileSync: vi.fn(), writeFileSync: vi.fn(), mkdirSync: vi.fn(), existsSync: () => false, watch: vi.fn(), readdirSync: () => [] }, readFileSync: vi.fn(), writeFileSync: vi.fn(), mkdirSync: vi.fn(), existsSync: () => false, watch: vi.fn(), readdirSync: () => [] }));
vi.mock('./sessionPool', () => ({ SessionPool: class { constructor() {} } }));

// 在 ESM 环境下 __dirname 未定义，但 index.ts 中使用 path.join(__dirname, ...)
// Mock path.join 以处理 undefined 参数，确保 createWindow 中 win.loadFile 能正常执行。
vi.mock('node:path', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:path')>();
  return {
    ...actual,
    join: (...args: string[]) => actual.join(...args.filter((a) => a != null)),
  };
});

// 在测试环境中可能设置了 ELECTRON_RENDERER_URL（dev 模式），
// 但此测试验证的是生产构建的 win.loadFile 路径。
delete process.env.ELECTRON_RENDERER_URL;

describe('createWindow splash behavior', () => {
  beforeAll(async () => {
    await import('../index');
    readyResolver!(); // → app.whenReady().then(createWindow)
    await new Promise((r) => setTimeout(r, 30)); // 让微任务跑完，完成 createWindow
  });

  it('creates the window hidden and reveals it exactly once on splash:done', () => {
    // createWindow 未主动 show；splash:done 之前窗口保持隐藏。
    expect(loadFileSpy).toHaveBeenCalled();
    expect(showSpy).not.toHaveBeenCalled();

    // 渲染进程首屏就绪后发 splash:done → 主进程 show()。
    expect(typeof ipcHandlers['splash:done']).toBe('function');
    ipcHandlers['splash:done']();
    expect(showSpy).toHaveBeenCalledTimes(1);

    // 幂等：重复通知不应再次 show（dismissSplash 守卫，且兜底超时也不会二次 show）。
    ipcHandlers['splash:done']();
    expect(showSpy).toHaveBeenCalledTimes(1);
  });
});

// ───────────────────────── 集成终端 IPC handler 轻量回归 ─────────────────────────
// 复用 createWindow 已通过 ipcHandlers 捕获的 terminal:* 信道，验证它们存在且把
// 参数正确转发到 termPool（IntegratedTerminalPool）。node-pty 已 mock，不 spawn 真 shell。
describe('integrated terminal IPC handlers (terminal:*)', () => {
  beforeAll(async () => {
    if (!readyResolver) return; // 已在上方 beforeAll 触发；此处确保 import 完成
    await new Promise((r) => setTimeout(r, 0));
  });

  afterEach(() => {
    mockPtys.length = 0;
  });

  it('registers all five terminal channels', () => {
    expect(typeof ipcHandlers['terminal:listProfiles']).toBe('function');
    expect(typeof ipcHandlers['terminal:create']).toBe('function');
    expect(typeof ipcHandlers['terminal:input']).toBe('function');
    expect(typeof ipcHandlers['terminal:resize']).toBe('function');
    expect(typeof ipcHandlers['terminal:destroy']).toBe('function');
  });

  it('terminal:listProfiles returns a non-empty TerminalProfile array with the right shape', () => {
    const profiles = ipcHandlers['terminal:listProfiles']();
    expect(Array.isArray(profiles)).toBe(true);
    expect(profiles.length).toBeGreaterThan(0);
    const p = profiles[0];
    expect(typeof p.id).toBe('string');
    expect(typeof p.label).toBe('string');
    expect(typeof p.path).toBe('string');
    expect(Array.isArray(p.args)).toBe(true);
  });

  it('terminal:create returns TerminalInfo and terminal:input/resize forward to pty', () => {
    const profiles = ipcHandlers['terminal:listProfiles']();
    const info = ipcHandlers['terminal:create'](null, { profile: profiles[0], cwd: '/tmp' });
    expect(typeof info.id).toBe('string');
    expect(info.id).toMatch(/^term-/);
    expect(info.type).toBe('shell');
    expect(info.title).toBe(profiles[0].label);

    const pty = mockPtys[0];
    expect(pty).toBeDefined();

    // input → pty.write（handler 直接 termPool.write）
    expect(() => ipcHandlers['terminal:input'](null, { id: info.id, data: 'echo hi\r' })).not.toThrow();
    expect(pty.write).toHaveBeenCalledWith('echo hi\r');

    // resize → pty.resize（handler 直接 termPool.resize）
    expect(() => ipcHandlers['terminal:resize'](null, { id: info.id, cols: 120, rows: 40 })).not.toThrow();
    expect(pty.resize).toHaveBeenCalledWith(120, 40);
  });

  it('terminal:destroy kills the pty and tears down the terminal', () => {
    const profiles = ipcHandlers['terminal:listProfiles']();
    const info = ipcHandlers['terminal:create'](null, { profile: profiles[0], cwd: '/tmp' });
    const pty = mockPtys[0];
    expect(pty.kill).not.toHaveBeenCalled();

    expect(() => ipcHandlers['terminal:destroy'](null, info.id)).not.toThrow();
    expect(pty.kill).toHaveBeenCalledTimes(1);

    // 销毁后再次 input/resize 应安全跳过（termPool.write/resize 对不存在 id 走 ?. 安全路径）。
    expect(() => ipcHandlers['terminal:input'](null, { id: info.id, data: 'x' })).not.toThrow();
    expect(() => ipcHandlers['terminal:resize'](null, { id: info.id, cols: 1, rows: 1 })).not.toThrow();
  });
});
