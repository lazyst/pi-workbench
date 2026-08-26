import { app, BrowserWindow, Tray, Menu, nativeImage, dialog, ipcMain, shell, protocol, net } from 'electron';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { exec, execSync } from 'node:child_process';
import { UnifiedTerminalPool } from './unifiedTerminalPool';
import { SessionFileManager } from './sessionFileManager';
import type { IPtyLike } from './types';
import { listDir, readFile, writeFile, statFile, mkdir, createFile, rename, remove, copy, listNames, uniqueName, watchDir, watchFile } from './fsBridge';
import { gitStatus, gitLog, gitDiff, gitFileStatusMap, gitIgnoredPaths } from './gitBridge';
import { ReferenceCountedWatcher } from './shared/ReferenceCountedWatcher';
import { PtyOwnershipRegistry } from './ptyOwnershipRegistry';
import { registerTerminalHandlers } from './handlers/terminalHandlers';
import { registerSessionHandlers } from './handlers/sessionHandlers';
import { registerConfigHandlers } from './handlers/configHandlers';
import { registerFsHandlers } from './handlers/fsHandlers';
import { registerSearchHandlers } from './handlers/searchHandlers';
import { registerGitHandlers } from './handlers/gitHandlers';
import { registerPiToolHandlers } from './handlers/piToolHandlers';
import { registerUpdateHandlers } from './handlers/updateHandlers';
import { disposeOperationManager } from './operationManager';
import { getPiDesktopSyncExtensionSource, PI_DESKTOP_SYNC_FILE } from './pi-desktop-sync-source';

// 终端渲染：xterm 的 WebGL(GPU) 渲染器能彻底消除流式高频重绘的闪烁（学习 VS Code 的
// terminal.integrated.gpuAcceleration 机制）。现代 Electron/Chromium 在无硬件 GPU 时
// 默认禁用 WebGL 且不再自动软件回退，会导致 xterm 静默回退到 DOM 渲染器而闪烁。
// 显式允许 SwiftShader 软件回退（对应 VS Code 的 gpuAcceleration: 'swiftshader'）：
// 有硬件 GPU 时仍走硬件 WebGL，无硬件时走软件 WebGL，保证 GPU 渲染器始终可用。
// 必须在 app ready / GPU 进程启动前设置。
app.commandLine.appendSwitch('enable-unsafe-swiftshader');
app.commandLine.appendSwitch('ignore-gpu-blocklist');

// ── 本地文件协议 pi-local://（渲染进程加载 markdown 内嵌图片/音视频等本地资源）──
// 背景：markdown 图片以相对路径引用本地文件，渲染进程需把相对路径解析为可加载 URL。
// 早期实现返回 file:/// 绝对 URL——在生产（file:// 页面）可加载，但开发模式页面由
// vite dev server 以 http://localhost:5173 提供，Chromium 安全策略禁止 http 页面加载
// file:// 子资源（“Not allowed to load local resource”），导致 dev 下预览/富文本都
// 显示不了图片。自定义协议由主进程注册，dev/prod 同样可用，且不受跨协议限制。
// 格式：pi-local://file/?path=<encodeURIComponent(绝对路径)>。
// 必须在 app ready / 任何窗口创建之前注册 scheme 权限。
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'pi-local',
    privileges: {
      standard: true, // 视为标准 URL（有 host/path 结构），img 可直接加载
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true, // 允许跨源 fetch（页面 http/file 与协议不同源时也可读）
    },
  },
]);

// 静默忽略 EPIPE 错误：当父进程（pi）关闭 stdout/stderr 管道后，
// console.log/warn/error 写入时不会崩溃弹窗。
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EPIPE') return;
    console.error('[stream]', err);
  });
}

// 配置存储（主进程唯一真源，见 docs/adr/0001）。纯函数（默认 / 解析 / 合并）在 ./config，
// 便于在无 Electron 环境下单测；此处负责带防抖写盘的实例化与 IPC 暴露。
import { defaultConfig, parseConfig, mergeConfig } from './config';
import { snapshotWindowState, initialBoundsOptions } from './windowState';
import { detectTerminalProfiles } from './shellProfiles';

// 默认应用工作目录的绝对路径（仅 main 进程使用，有 node:os）。config.ts 因被
// renderer（sandbox，无 node:os）共享而不能 import node 模块，故在此用 node:os/path 计算。
// 文件夹名 ('defaultWorkSpace') 由 config.DEFAULT_APP_WORK_DIR_NAME 提供，保持单一来源。
// 开发版实例开关：通过 PI_DESKTOP_DEV 环境变量启用，与安装版使用不同的
// app.name 和 config 文件，使两者可同时运行（见设计文档「双实例方案」）。
const isDevInstance = !!process.env.PI_DESKTOP_DEV;

function getDefaultAppWorkDir(): string {
  return path.join(os.homedir(), '.pi', 'pi-workbench', 'defaultWorkbench');
}import type { AppConfig, TerminalProfile } from '../renderer/src/types';

const configPath = () => {
  const suffix = isDevInstance ? '-dev' : '';
  return path.join(os.homedir(), '.pi', 'pi-workbench', `config${suffix}.json`);
};
let configState: AppConfig | undefined;
let configTimer: ReturnType<typeof setTimeout> | undefined;
let configDirty = false;
// 真正退出标志：关闭按钮默认只隐藏窗口（不杀进程），仅「退出」/系统 quit 置位。
let quitting = false;
// 托盘常驻：生命周期与应用一致，不随窗口显隐销毁（见 issue 01 / 04）。
let tray: Tray | undefined;

function loadConfig(): AppConfig {
  try {
    return parseConfig(fs.readFileSync(configPath(), 'utf-8'));
  } catch {
    return defaultConfig();
  }
}

const PI_DESKTOP_MANAGED_MARKER = '@pi-desktop-managed';

/** 确保 pi-desktop 同步扩展已安装到 ~/.pi/agent/extensions/。
 * 每次启动覆盖写入，保证扩展代码与 pi-desktop 版本一致。
 * 扩展源码内联于此，不依赖文件拷贝（避免 electron-vite 构建输出问题）。
 * 带 marker 保护：如果文件存在且不包含 @pi-desktop-managed 标记，
 * 视为用户自维护的扩展，不覆盖。 */
function ensurePiDesktopExtension(): void {
  const extDir = path.join(os.homedir(), '.pi', 'agent', 'extensions');
  const extPath = path.join(extDir, PI_DESKTOP_SYNC_FILE);
  try {
    const existing = fs.readFileSync(extPath, 'utf-8');
    if (!existing.includes(PI_DESKTOP_MANAGED_MARKER)) return;
  } catch {
    // 文件不存在或不可读，继续写入
  }
  try {
    fs.mkdirSync(extDir, { recursive: true });
    fs.writeFileSync(extPath, getPiDesktopSyncExtensionSource(), 'utf-8');
  } catch {
    // 写入失败时静默忽略
  }
}

function ensureAppWorkDir(): string {
  ensureLoaded();
  const cfg = configState!;
  // 旧配置/损坏时补全默认 ~/pi-desktop/defaultWorkSpace，并写回持久化（对齐 ADR §3 A1「自动填默认并写回」）。
  // config.ts 的 defaultConfig 只返回文件夹名（renderer 安全），此处补全为绝对路径。
  let dir = cfg.appWorkDir;
  if (!dir || !path.isAbsolute(dir)) {
    dir = getDefaultAppWorkDir();
    configState = mergeConfig(cfg, { appWorkDir: dir });
    writeConfigNow();
  }
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    console.error('[appWorkDir] failed to create dir:', dir, err);
  }
  return dir;
}

function ensureLoaded(): void {
  if (configState === undefined) configState = loadConfig();
}

function writeConfigNow(): void {
  if (!configState) return;
  try {
    const dir = path.dirname(configPath());
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(configPath(), JSON.stringify(configState, null, 2));
  } catch (err) {
    console.error('[config] failed to write config.json:', err);
  }
}

function getConfig(): AppConfig {
  ensureLoaded();
  return configState!;
}

function setConfig(partial: Partial<AppConfig>): void {
  ensureLoaded();
  // 工作目录变更：从 addedDirs 中被移除的目录不再有 Git 操作，释放对应
  // OperationManager（防止随工作目录切换/移除无限增长，内存泄漏）。
  // 必须在 mergeConfig 之前对比：partial.addedDirs 是移除后的完整列表。
  if (Array.isArray(partial.addedDirs)) {
    const prevAddedDirs = configState?.addedDirs ?? [];
    const nextAddedDirs = new Set(
      partial.addedDirs
        .filter((x): x is string => typeof x === 'string' && x.trim() !== '')
        .map((x) => path.normalize(x.trim())),
    );
    for (const dir of prevAddedDirs) {
      if (!nextAddedDirs.has(dir)) disposeOperationManager(dir);
    }
  }
  configState = mergeConfig(configState!, partial);
  // addedDirs：统一为平台规范路径（path.normalize 会把混合分隔符 / 相对片段规整），
  // 避免混合分隔符（如 "D:\tmp/pi-test"）导致侧边栏精确字符串匹配失败，
  // 使该目录下的会话无法显示（会话文件的 cwd 由 pi 写出为标准反斜杠形式）。
  if (Array.isArray(partial.addedDirs)) {
    const normed = [...new Set(
      partial.addedDirs
        .filter((x): x is string => typeof x === 'string' && x.trim() !== '')
        .map((x) => path.normalize(x.trim()))
    )];
    configState = mergeConfig(configState!, { addedDirs: normed });
  }
  // 应用工作目录变更：确保新目录已创建（递归），使该分组下的终端 cwd 立即可用。
  if (partial.appWorkDir) {
    // 确保传入的路径是绝对路径（renderer 可能只传了相对路径）
    const dir = partial.appWorkDir;
    const absDir = path.isAbsolute(dir) ? dir : path.join(os.homedir(), '.pi', 'pi-workbench', dir);
    if (absDir !== dir) {
      configState = mergeConfig(configState!, { appWorkDir: absDir });
    }
    try { fs.mkdirSync(absDir, { recursive: true }); } catch (err) { console.error('[appWorkDir] failed to create dir:', absDir, err); }
  }
  configDirty = true;
  if (configTimer) clearTimeout(configTimer);
  // 防抖写盘：拖拽 / 缩放等高频变更下避免频繁 IO。
  configTimer = setTimeout(() => {
    configTimer = undefined;
    configDirty = false;
    writeConfigNow();
  }, 100);
}

// 退出前强制落盘，避免 100ms 防抖窗口内的最近一次写入丢失。
app.on('before-quit', () => {
  if (configTimer) {
    clearTimeout(configTimer);
    configTimer = undefined;
  }
  if (configDirty) {
    configDirty = false;
    writeConfigNow();
  }
});

// 解析托盘图标路径：dev 用源码、build 用 copy-assets 拷贝出的 out/main/assets，
// 打包（asar）回退到 resources/assets（见 issue 01）。
function resolveTrayIcon(): string {
  const candidates = [
    path.join(__dirname, 'assets', 'tray-icon.png'),
    path.join(__dirname, '..', '..', 'src', 'main', 'assets', 'tray-icon.png'),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  const packed = path.join(process.resourcesPath, 'assets', 'tray-icon.png');
  if (fs.existsSync(packed)) return packed;
  return candidates[0];
}

// 显示并聚焦窗口（托盘「显示」/双击触发）。
// 白闪根因：Windows 无边框窗口从隐藏到显示时，DWM 会在合成首帧前先用纯白填充
// 客户区，Electron 的 backgroundColor 时序上有时来不及，导致「最小化后再打开」出现一瞬白屏。
// 解法（透明桥接）：先以 opacity:0 显示，让白色首帧在不可见状态下绘制，
// 待下一帧（rAF）暗色内容已合成后再 setOpacity(1) 淡入——用户全程看不到白帧。
function showWindow(win: BrowserWindow): void {
  if (win.isDestroyed()) return;
  // 冷启动(initial show:false)与恢复(hide 后 show)在此路径汇合：isVisible 均为 false。
  if (win.isVisible()) { win.focus(); return; }
  // 透明桥接：先以 opacity:0 显示，让 Windows DWM 在 show() 瞬间绘制的纯白首帧
  // 发生在不可见状态；待下一帧(~20ms)暗色 DOM 已合成后再 setOpacity(1) 淡入，
  // 用户全程看不到白帧。主进程是 Node 环境，无 requestAnimationFrame，故用 setTimeout。
  win.setOpacity(0);
  win.show();
  setTimeout(() => {
    if (win.isDestroyed()) return;
    win.setOpacity(1);
    win.focus();
  }, 20);
}

// 创建常驻系统托盘：右键「显示 / 退出」，双击显示并聚焦（见 issue 01）。
// 开发版使用 'pi-workbench [DEV]' 标识，与安装版区分。
function createTray(win: BrowserWindow): void {
  try {
    const iconPath = resolveTrayIcon();
    const icon = nativeImage.createFromPath(iconPath);
    if (icon.isEmpty()) console.warn('[tray] icon missing at', iconPath);
    tray = new Tray(icon);
    tray.setToolTip(isDevInstance ? 'pi-workbench [DEV]' : 'pi-workbench');
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: '显示', click: () => showWindow(win) },
        { label: '退出', click: () => app.quit() },
      ]),
    );
    tray.on('double-click', () => showWindow(win));
  } catch (err) {
    console.error('[tray] failed to create system tray:', err);
  }
}

// SESSIONS_DIR 已由 resolveSessionsDir() 替代（见下方 createWindow）。

// Resolve the `pi` executable to an absolute path.
// 优先 $PI_BIN 环境变量，兜底靠系统 PATH 解析（与 Orca 一致，不硬编码 pnpm 目录）。
function resolvePi(): string {
  const explicit = process.env.PI_BIN;
  if (explicit) return explicit;
  // E2E 测试模式（PI_DESKTOP_FAKE=1，见 e2e/*.spec.ts）：用 node 直接跑 fake-pi.mjs
  // （收到首行 stdin 即写 .jsonl 会话文件，模拟真实 pi 的写盘晋升流程，不依赖真实 pi）。
  // fake-pi.mjs 由 scripts/copy-assets.mjs 复制到构建输出目录（out/main/）。
  if (process.env.PI_DESKTOP_FAKE) {
    return `node ${path.join(__dirname, 'fake-pi.mjs')}`;
  }
  const exts = ['.cmd', '.exe', '.ps1', '.bat', ''];
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const ext of exts) {
      const cand = path.join(dir, 'pi' + ext);
      if (fs.existsSync(cand)) return cand;
    }
  }
  return 'pi';
}

// `pi.cmd` ultimately runs `node cli.js`, so `node` must also be resolvable in the
// child's PATH. When the app is launched without the user's shell PATH (e.g. by
// double-clicking the .exe), `node` may be missing — so resolve it and prepend it.
function resolveNodeDir(): string | undefined {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    if (fs.existsSync(path.join(dir, 'node.exe')) || fs.existsSync(path.join(dir, 'node'))) return dir;
  }
  const miseNode = path.join(os.homedir(), 'AppData', 'Local', 'mise', 'installs', 'node');
  if (fs.existsSync(miseNode)) {
    for (const ver of fs.readdirSync(miseNode)) {
      const d = path.join(miseNode, ver);
      if (fs.existsSync(path.join(d, 'node.exe'))) return d;
    }
  }
  return undefined;
}

function resolveSessionsDir(): string {
  return process.env.PI_DESKTOP_SESSIONS_DIR ?? path.join(app.getPath('home'), '.pi', 'agent', 'sessions');
}

/** 在默认浏览器中打开 URL。
 * 使用 child_process.exec 调用 OS 原生命令，绕过 Electron 30+ 的
 * shell.openExternal 安全确认对话框（该对话框无法通过用户手势规避）。
 * macOS: open <url>，Windows: start "" <url>，Linux: xdg-open <url> */
function openUrlInExternal(url: string): void {
  const escaped = url.replace(/"/g, '\\"');
  const cmd = process.platform === 'darwin'
    ? `open "${escaped}"`
    : process.platform === 'win32'
      ? `start "" "${escaped}"`
      : `xdg-open "${escaped}"`;
  exec(cmd, (err) => {
    if (err) console.error('[openUrlInExternal] failed:', err.message);
  });
}

/** 反转义 OSC 字段中的转义字符。 */
function unescapeField(s: string): string {
  let r = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && i + 1 < s.length) {
      const c = s[i + 1];
      if (c === ';') r += ';';
      else if (c === 'a') r += '\x07';
      else if (c === '\\') r += '\\';
      else { r += s[i]; r += c; }
      i++;
    } else {
      r += s[i];
    }
  }
  return r;
}

function createWindow() {
  // 确保 pi-desktop 同步扩展已安装
  ensurePiDesktopExtension();
  // 确保 appWorkDir 已解析为绝对路径并已创建目录，避免 renderer 拿到相对路径后报错。
  ensureAppWorkDir();
  const cfg = getConfig();
  // 还原上次窗口几何（最大化状态单独存标志，bounds 永远是非最大化尺寸）。
  // show:false —— 启动动画（splash）由 renderer 首屏就绪后经 splash:done IPC 触发
  // show()，避免在「无边框窗口 + 内容异步加载」下先闪白框再显示内容（见 docs/adr/0003）。
  // backgroundColor 必须跟随主题设置：无边框窗口不指定时 OS 合成器默认给纯白背景，
  // 最小化为 hide() 后再 show() 会先闪一下亮白再被 React 暗色 DOM 覆盖（托盘恢复路径
  // 不经过 splash 遮挡）。取值与 index.html 的 --bg-app 回退色、theme.ts 的静态等价色一致，
  // 三处同源，杜绝亮闪。
  const win = new BrowserWindow({
    ...initialBoundsOptions(cfg.window.bounds),
    show: false,
    frame: false, // 无边框：原生菜单与标题条随之消失（任务 2），标题条改由渲染进程自建（任务 3）
    backgroundColor: cfg.theme === 'light' ? '#ffffff' : '#0d1117',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      // 把初始 config 同步注入渲染进程（见 preload 的 getInitialConfig），
      // 使其首屏即可拿到正确主题，避免异步读取导致的暗→亮闪烁。
      additionalArguments: [`--pi-initial-config=${encodeURIComponent(JSON.stringify(cfg))}`],
    },
  });
  if (cfg.window.maximized) win.maximize();
  // 开发版窗口标题加 [DEV] 后缀，用于任务栏和系统识别。
  if (isDevInstance) win.setTitle('pi-workbench [DEV]');
  // 开发调试：Ctrl+Shift+I / F12 切换 DevTools，便于查看渲染进程 console / 网络。
  // （本应用无内置 DevTools 入口，故在此补一个快捷键。）
  win.webContents.on('before-input-event', (_e, input) => {
    const isDevToolsKey =
      input.key === 'F12' ||
      (input.control && input.shift && (input.key === 'I' || input.key === 'i'));
    if (isDevToolsKey) {
      if (win.webContents.isDevToolsOpened()) win.webContents.closeDevTools();
      else win.webContents.openDevTools();
    }
  });

  // ── 链接跳转纵深防御（对齐 VS Code setWindowOpenHandler + will-frame-navigate）──
  // 终端链接通过 window.open(url, '_blank', 'noopener') 保留用户手势上下文，
  // setWindowOpenHandler 拦截后调用 shell.openExternal（有用户手势 → 不弹安全对话框）。
  // will-frame-navigate 做双重保险，阻止外部 URL 在窗口内导航。
  // 注意：本项目未注册自定义 app:// 协议，生产以 file:// 加载，故放行集为 file:// + 本地 dev。
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      openUrlInExternal(url);
    }
    return ({ action: 'deny' });
  });
  // will-frame-navigate：Electron 32 替代 will-navigate 的新事件。
  // 拦截外部 URL 导航，防止默认行为弹出安全确认对话框。
  // URL 打开由各 handler（setWindowOpenHandler / app:openExternal）负责。
  win.webContents.on('will-frame-navigate', (details) => {
    const url = details.url;
    if (!url.startsWith('file://') && !/^https?:\/\/localhost(:\d+)?\//.test(url)) {
      details.preventDefault();
    }
  });

  // ===== 统一终端池 + 会话文件管理器 =====
  // 统一终端数据发送：发送到主 session 及其所有子路由，消除重复的路由模式
  const sendDataToTerminal = (id: string, data: string) => {
    if (win.isDestroyed()) return;
    win.webContents.send('terminal:data', { id, data });
    const routes = ptyRegistry.getRoutes(id);
    if (routes) {
      for (const routeId of routes) {
        win.webContents.send('terminal:data', { id: routeId, data });
      }
    }
  };
  const sessionsDir = resolveSessionsDir();
  const sessionFileManager = new SessionFileManager(sessionsDir);
  const piBin = resolvePi();
  // PTY 所有权注册表：统一管理 dataRoutes + ptyOwners + 虚拟 session 映射
  const ptyRegistry = new PtyOwnershipRegistry();
  const unifiedPool = new UnifiedTerminalPool({
    cols: 80, rows: 24,
    piBin,
    sessionsDir,
    // 所有终端数据统一经 terminal:data 通道发送
    // 同时检测 pi 扩展输出的 OSC 序列（/new 命令通知）
    onData: (id, data) => {
      if (win.isDestroyed()) return;
      // 检测 PiNew OSC 序列: \x1b]633;PiNew;uuid;cwd;name\x07
      const piNewMatch = data.match(
        /\x1b\]633;PiNew;((?:[^;\x07\\]|\\.)*);((?:[^;\x07\\]|\\.)*);((?:[^;\x07\\]|\\.)*)\x07/,
      );
      if (piNewMatch) {
        const [, uuidRaw, cwdRaw, nameRaw] = piNewMatch;
        const uuid = unescapeField(uuidRaw);
        const cwd = unescapeField(cwdRaw);
        const name = unescapeField(nameRaw);
        // 把新 session key 加入路由表，使子 session 的 tab 也能收到 PTY 数据
        const newKey = `pi-${uuid}`;
        ptyRegistry.addRoute(id, newKey);
        // 通知渲染进程：新 session 已创建
        win.webContents.send('session:new-from-pi', { ptyId: id, uuid, cwd, name });
        // 解除旧 session 的磁盘 alias，使点击磁盘条目时 spawn 新进程而非复用已有 PTY
        unifiedPool.unlinkDiskSession(id);
        // 从数据中剥离 OSC 序列，避免显示在终端中
        const cleanData = data.replace(/\x1b\]633;PiNew;[^\x07]*\x07/, '');
        if (cleanData) {
          sendDataToTerminal(id, cleanData);
        }
        return;
      }

      // 检测 PiName OSC 序列: \x1b]633;PiName;name\x07（会话名变更）
      const piNameMatch = data.match(
        /\x1b\]633;PiName;((?:[^;\x07\\]|\\.)*)\x07/,
      );
      if (piNameMatch) {
        const name = unescapeField(piNameMatch[1]);
        win.webContents.send('session:name-changed', { ptyId: id, name });
        // 从数据中剥离 OSC 序列
        const cleanData = data.replace(/\x1b\]633;PiName;[^\x07]*\x07/, '');
        if (cleanData) {
          sendDataToTerminal(id, cleanData);
        }
        return;
      }

      sendDataToTerminal(id, data);
    },
    // pi 会话状态变更（running / dead），供侧边栏绿点更新
    onStatus: (key, status) => { if (!win.isDestroyed()) win.webContents.send('session:status', { key, status }); },
    // 所有终端退出统一经 terminal:exit 通道发送
    onExit: (id) => {
      if (!win.isDestroyed()) {
        win.webContents.send('terminal:exit', { id });
        // 清理路由表中的子 session
        const result = ptyRegistry.remove(id);
        for (const routeId of result.routes) {
          win.webContents.send('terminal:exit', { id: routeId });
        }
        pushTerminalList();
      }
    },
    onRelink: (from, to) => { if (!win.isDestroyed()) win.webContents.send('session:relink', { from, to }); },
    // 实例列表变化时推送
    onList: (list) => { if (!win.isDestroyed()) win.webContents.send('terminal:list', { list }); },
  });

  function pushTerminalList(): void {
    if (win.isDestroyed()) return;
    win.webContents.send('terminal:list', { list: unifiedPool.list() });
  }

  // ===== 统一终端 IPC =====
  registerTerminalHandlers(ipcMain, win, unifiedPool, pushTerminalList, ensureAppWorkDir, ptyRegistry);

  // 添加 session:query-owner IPC handler 供 renderer 查询 PTY 所有权
  ipcMain.handle('session:query-owner', (_e, key: string) => {
    const owner = ptyRegistry.getOwner(key);
    const ptyId = ptyRegistry.findPtyByOwnerKey(key);
    const virtual = ptyRegistry.getVirtual(key);
    return { owner, ptyId, virtual };
  });

  // 受控外部链接通道：渲染层经此桥请求打开外部程序（系统浏览器/mail 客户端）。
  // 使用 child_process.exec 绕过 Electron 30+ 的 shell.openExternal 安全确认对话框。
  // 文件系统 + Git IPC
  registerFsHandlers(ipcMain, win);
  registerGitHandlers(ipcMain, win);
  registerSearchHandlers(ipcMain, win);

  // Pi 工具配置 IPC（settings、models、MCP、skills、extensions）
  const piAgentDir = path.join(os.homedir(), '.pi', 'agent');
  registerPiToolHandlers(ipcMain, win, piAgentDir);

  // 版本更新检查 IPC
  registerUpdateHandlers(ipcMain, win);

  // 文件系统 IPC 已在 registerFsHandlers 中注册

  // 记住窗口几何与最大化状态（见 docs/adr/0001 决策②）：maximize / unmaximize /
  // resize / move 实时（防抖 200ms）回写 config.window。用 getNormalBounds() 取非
  // 最大化几何，无论当前是否最大化，存进去的都是「还原后」的尺寸。
  let winStateTimer: ReturnType<typeof setTimeout> | undefined;
  const persistWindowState = () => {
    if (winStateTimer) clearTimeout(winStateTimer);
    winStateTimer = setTimeout(() => {
      winStateTimer = undefined;
      if (win.isDestroyed()) return;
      setConfig({ window: snapshotWindowState(win) });
    }, 200);
  };
  win.on('maximize', persistWindowState);
  win.on('unmaximize', persistWindowState);
  win.on('resize', persistWindowState);
  win.on('move', persistWindowState);

  // 配置存储：渲染进程经 IPC 读写主进程 config.json（唯一真源，见 docs/adr/0001）。
  // 配置存储 + 窗口控制 IPC
  registerConfigHandlers(ipcMain, win, getConfig, setConfig);

  // ===== 会话文件管理 IPC（session:*） =====
  registerSessionHandlers(ipcMain, win, sessionFileManager, unifiedPool, sessionsDir);

  // Git 工作区实时监听已在 registerGitHandlers 中注册

  // 无边框窗口的窗口控制（自建标题条调用）已在 registerConfigHandlers 中注册

  // 关闭语义（见 issue 03 / docs/adr/0001 决策③）：
  //  - minimize-to-tray（默认）：拦截关闭、隐藏窗口、进程继续跑（托盘可恢复）。
  //  - close：真正退出应用；app.quit() 经 before-quit 置 quitting 并杀掉全部 pi 进程。
  // 开发版默认直接退出（即使 closeBehavior 设为 minimize-to-tray 也忽略），
  // 因为开发版主要用于测试，关闭窗口后应彻底退出，避免残留进程。
  win.on('close', (e) => {
    if (quitting) return; // 真正退出路径：放行 window 关闭
    if (isDevInstance || getConfig().closeBehavior !== 'minimize-to-tray') {
      // 开发版或「直接关闭」模式：改走统一退出流程。
      e.preventDefault();
      app.quit();
    } else {
      e.preventDefault();
      win.hide();
    }
  });

  // 真正退出统一走 before-quit：置 quitting、杀掉所有运行中的 pi 进程。
  // 关闭按钮（minimize-to-tray）只隐藏窗口、不会触发 before-quit，故进程保持存活。
  app.on('before-quit', () => {
    quitting = true;
    unifiedPool.killAll();
  });

  // 启动动画（splash）：窗口以 show:false 创建，避免无边框窗口先闪白框。
  // renderer 首屏（App 挂载）后发 splash:done → 切淡出并 show()。
  // 仅「真冷启动」走此路径；托盘恢复走 showWindow()。两处都经 showWindow 的
  // 透明(opacity 0→1)桥接，统一吞掉 show() 瞬间的 OS 合成白首帧（见 showWindow）。
  // 兜底：若渲染进程未在 3s 内通知（异常/未挂载），强制显示，避免窗口永远不可见。
  let splashDismissed = false;
  const dismissSplash = () => {
    if (splashDismissed) return;
    splashDismissed = true;
    if (!win.isDestroyed()) showWindow(win);
  };
  ipcMain.on('splash:done', () => dismissSplash());
  const splashFallback = setTimeout(dismissSplash, 3000);
  win.on('closed', () => clearTimeout(splashFallback));

  // 常驻托盘在窗口就绪后创建（见 issue 01）。
  createTray(win);

  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else win.loadFile(path.join(__dirname, '../renderer/index.html'));
}

// 开发版使用不同的 app.name，使单实例锁与安装版隔离，两者可同时运行。
if (isDevInstance) {
  app.name = 'pi-workbench-dev';
}

const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  // 已有实例在运行，直接退出新启动的副本。
  app.quit();
} else {
  // 当用户再次打开应用时，聚焦到已有窗口（托盘隐藏场景也适用）。
  app.on('second-instance', () => {
    const [existingWin] = BrowserWindow.getAllWindows();
    if (existingWin) {
      if (existingWin.isMinimized()) existingWin.restore();
      existingWin.show();
      existingWin.focus();
    }
  });

  app.whenReady().then(() => {
    // pi-local://file/?path=... → 读取本地文件（见文件顶部协议注册注释）。
    // net.fetch(file://…) 在 dev(http://localhost) 与 prod(file:// 页面) 下均可用。
    protocol.handle('pi-local', (request) => {
      try {
        const abs = new URL(request.url).searchParams.get('path');
        // URLSearchParams.get 已做 URL 解码，勿再 decodeURIComponent（否则路径含 % 会被二次解码解错）。
        if (!abs) return new Response('Bad Request: missing path', { status: 400 });
        if (!path.isAbsolute(abs)) return new Response('Forbidden: not absolute', { status: 403 });
        return net.fetch(pathToFileURL(abs).toString());
      } catch (e) {
        return new Response(`Not Found: ${e instanceof Error ? e.message : String(e)}`, { status: 404 });
      }
    });
    createWindow();
  });
}

// 窗口隐藏（非关闭）时应用保持存活；托盘常驻即入口，真正退出只经 before-quit
// （见 issue 04）。macOS 本就不退出，其余平台也不再因窗口"关闭"（实为隐藏）而退出。
app.on('window-all-closed', () => { /* 托盘常驻：不自动退出，仅 before-quit 触发真正退出 */ });
