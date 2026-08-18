/**
 * 统一终端 PTY 池——合并 SessionPool（spawn pi 进程）+ IntegratedTerminalPool（spawn shell 进程）
 * 的统一终端 PTY 池。
 *
 * 对外隐藏两种终端在 spawn 参数、环境变量、id 前缀等方面的差异，提供统一的
 * create/write/resize/destroy/killAll/updateCwd/acknowledgeDataEvent 接口。
 *
 * - command === 'pi'：spawn shell 进程，等待 shell 就绪后自动注入 pi 命令
 *   （走 Shell-Ready 模式，类似 Orca 的实现），
 *   id 形如 'live-<uuid>'，env 含 PI_DESKTOP=1。
 * - command === undefined：spawn 用户 shell 进程（走原 IntegratedTerminalPool.create 路径），
 *   id 形如 'term-<uuid>'，env 含 TERM=xterm-256color / COLORTERM=truecolor，
 *   并注入 VS Code shell integration 脚本。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as nodePty from 'node-pty';
import { randomUUID } from 'node:crypto';
import type { TerminalProfile } from '../renderer/src/types';
import { getShellIntegrationInjection } from './shell-integration/inject';
import { BackpressureController } from './backpressure';
import { readSessionName, decodeCwd, readGroupCwd } from './sessionUtils';
import { getDefaultShellProfile } from './shellProfiles';
import {
  createShellReadyScanState,
  scanForShellReady,
  injectPiCommand,
  getShellReadyLaunchConfig,
  SHELL_READY_TIMEOUT_MS,
  POST_READY_COMMAND_DELAY_MS,
  POST_READY_FALLBACK_MS,
} from './shell-ready/pi-shell-ready';

// node-pty v1.x 的公开类型只声明 onData/onExit 事件属性，但运行时 Terminal 仍继承
// EventEmitter（内部经 _internalee 转发 'data'/'exit' 事件）。以下类型补齐代码实际
// 使用的 EventEmitter 表面和 spawn 选项中的 shell 字段，避免降级为 any。
type PtyWithEvents = nodePty.IPty & {
  on(event: 'data', listener: (data: string) => void): void;
  on(event: 'exit', listener: (exitCode: number, signal?: number) => void): void;
  removeListener(event: 'data', listener: (...args: unknown[]) => void): void;
};
type PtySpawnOptions = Parameters<typeof nodePty.spawn>[2] & { shell?: boolean };

/** 统一 spawn 入口：补齐 node-pty v1.x 类型声明缺失的 EventEmitter/shell 表面。 */
function spawnPty(file: string, args: string[] | string, options: PtySpawnOptions): PtyWithEvents {
  return nodePty.spawn(file, args, options) as PtyWithEvents;
}

// 主进程端数据缓冲（5ms 时间窗聚合，等效 VS Code pty host 端 TerminalDataBufferer，
// 减少 IPC 消息量）。
const DATA_BUFFER_MS = 5;

/** pi-tui 模式切换序列的时间窗口：\x1b[?1049l 与 \x1b[?2004h 在此窗口内连续出现
 * 唯一标识一次 fullscreen→regular 切换（pi 正常退出时只写前者不写后者）。 */
const MODE_SWITCH_WINDOW_MS = 2000;

/** 从 .jsonl 会话文件首行解析 cwd，不存在时回退 safeCwd。 */
function resolveCwdFromSessionFile(sessionFile: string, safeCwd: string): string {
  try {
    const line = fs.readFileSync(sessionFile, 'utf8').split('\n', 1)[0];
    const obj = JSON.parse(line);
    return typeof obj?.cwd === 'string' && fs.existsSync(obj.cwd) ? obj.cwd : safeCwd;
  } catch { return safeCwd; }
}

/**
 * 检查操作系统进程是否仍在运行。
 * 在 Windows conpty 下，node-pty 的 `exit` 事件通过 `WaitForSingleObject`
 * 监视进程句柄触发。但某些场景下（如 conpty 内部处理 alt screen 切换）
 * 进程句柄可能误触发而进程实际仍存活。
 * 通过 `process.kill(pid, 0)` 验证进程真实存在性。
 */
function isProcessAlive(pid: number): boolean {
  try {
    // signal 0 不发送实际信号，仅检查进程是否存在。
    // Windows 上，进程存在时返回 true；不存在时抛出 ESRCH。
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

interface DataBuffer {
  chunks: string[];
  timer: NodeJS.Timeout | null;
}

/** 创建终端的选项。 */
export interface SpawnOptions {
  /** 'pi' → pi 会话，undefined → 默认 shell（使用 profile）。 */
  command?: string;
  /** 终端工作目录。不存在时回退 process.cwd()。 */
  cwd: string;
  /** Shell profile，command 为 undefined 时必填；command 为 'pi' 时可选（使用默认 shell）。 */
  profile?: TerminalProfile;
  /** 打开已有 .jsonl 会话文件（command==='pi' 时有效），传此值时 cwd 可从文件首行解析。 */
  sessionFile?: string;
  /** 新建会话的名称（command==='pi' 时有效）。 */
  name?: string;
  /** 显式指定会话 key（command==='pi' 时有效，存活检查用）。 */
  key?: string;
}

/** 单个终端实例的对外信息。 */
export interface TerminalInfo {
  id: string;
  /** 兼容旧 SessionInfo.key，与 id 相同。 */
  key: string;
  cwd: string;
  title: string;
  /** 兼容旧 SessionInfo.name，与 title 相同。 */
  name: string;
  type: 'pi' | 'shell';
  /** 兼容旧 SessionInfo.status，新建/打开的终端始终是 'running'。 */
  status: 'running' | 'dead';
}

/** 调试用只读终端快照（供 session:debug 等调试场景，不暴露内部 Entry/PTY 对象）。 */
export interface TerminalDebugSnapshot {
  id: string;
  type: 'pi' | 'shell';
  status: 'running' | 'dead';
  pid: number;
}

/** UnifiedTerminalPool 的可选配置。 */
export interface UnifiedTerminalPoolOptions {
  cols: number;
  rows: number;
  /** pi 二进制路径，command==='pi' 时用于 spawn。默认 'pi'。 */
  piBin?: string;
  /** pi 会话的 sessions 目录（~/.pi/agent/sessions），用于关联新 .jsonl 文件。 */
  sessionsDir?: string;
  /** 数据回调：id=终端实例 id，data=PTY 聚合后的输出。 */
  onData: (id: string, data: string) => void;
  /** pi 会话状态变更（running / dead），供侧边栏绿点更新。 */
  onStatus: (id: string, status: 'running' | 'dead') => void;
  /** pi 会话退出回调。 */
  onExit: (id: string) => void;
  /** 实例列表变化（create/destroy/cwd 变更）时推送最新列表。 */
  onList: (list: TerminalInfo[]) => void;
  /** pi 会话晋升回调（live key → disk key 映射），供侧边栏高亮。 */
  onRelink?: (from: string, to: string) => void;
}

/** 内部存储的单个终端实例条目。 */
interface Entry {
  pty: nodePty.IPty;
  info: TerminalInfo;
  type: 'pi' | 'shell';
  /** 主进程→渲染端 IPC 投递的背压控制器（对齐 VS Code acknowledgeDataEvent 真流控）。 */
  bp: BackpressureController;
  /** pi 会话是否已与磁盘 .jsonl 关联。 */
  linked?: boolean;
  /** 关联的磁盘 .jsonl key（已晋升的 pi 会话）。 */
  diskKey?: string;
  /** 创建时该 cwd 下已有的磁盘 .jsonl key 集合，用于避免关联到旧文件。
   * 由后台异步收集后回填；reconcile 通过 existingKeysReady 等待其完成。 */
  existingDiskKeys?: Set<string>;
  /** existingDiskKeys 后台收集完成的信号（resolve 后 entry.existingDiskKeys 已可用）。 */
  existingKeysReady?: Promise<void>;
  /** 用户主动终止（terminate）标记：置位后 pty 'exit' 跳过退出确认窗口直接关闭。 */
  terminating?: boolean;
  /** 最近检测到 \x1b[?1049l（退出 alt screen）的时间戳，用于识别 pi-tui 模式切换误报。 */
  altScreenExitTime?: number;
  /** 最近检测到 \x1b[?2004h（启用 bracketed paste）的时间戳，用于识别 pi-tui 模式切换误报。 */
  bracketedPasteTime?: number;
}

/**
 * 统一终端 PTY 池——替代 SessionPool（spawn pi 进程）+ IntegratedTerminalPool（spawn shell 进程）。
 */
export class UnifiedTerminalPool {
  private opts: UnifiedTerminalPoolOptions;
  /** 实例 id → 条目（create 后保留，destroy/killAll 才移除）。 */
  private entries = new Map<string, Entry>();
  /** 每实例聚合缓冲（id 为终端实例 id）。 */
  private dataBuffers = new Map<string, DataBuffer>();

  constructor(opts: UnifiedTerminalPoolOptions) {
    this.opts = opts;
  }

  /** 磁盘 .jsonl 路径 → live key（已晋升的 pi 会话）。 */
  private alias = new Map<string, string>();

  /**
   * 根据 SpawnOptions 创建终端：
   * - command === 'pi' → spawn pi 进程（id 形如 'live-<uuid>'）
   * - command === undefined → spawn shell 进程（id 形如 'term-<uuid>'），需要 profile
   */
  create(opts: SpawnOptions): TerminalInfo {
    if (opts.command === 'pi') {
      // 检查 key 是否已有存活实例（避免重复创建进程）
      if (opts.key && this.entries.has(opts.key)) {
        return this.entries.get(opts.key)!.info;
      }
      // 检查 .jsonl 是否已关联到某个 live 进程
      if (opts.sessionFile && this.alias.has(opts.sessionFile)) {
        const liveKey = this.alias.get(opts.sessionFile)!;
        const existing = this.entries.get(liveKey);
        if (existing) return existing.info;
      }
      return this.spawnPi(opts);
    }
    // command === undefined → shell
    if (!opts.profile) {
      throw new Error('SpawnOptions.profile is required when command is undefined (shell)');
    }
    return this.spawnShell(opts.profile, opts.cwd);
  }

  /**
   * 解析 disk key → live key（用于 terminate 等）。
   * 若 key 自身在 entries 中则直接返回；否则查 alias 映射。
   */
  liveKeyFor(key: string): string {
    if (this.entries.has(key)) return key;
    const linked = this.alias.get(key);
    if (linked && this.entries.has(linked)) return linked;
    return key;
  }

  /**
   * 终止 pi 会话：杀掉 pty、清理别名映射、通知 onExit/onStatus。
   * 同时处理 disk key 反查 live key（侧边栏传入的是 .jsonl 路径）。
   */
  terminate(key: string): void {
    const liveKey = this.liveKeyFor(key);
    const e = this.entries.get(liveKey);
    if (!e || e.type !== 'pi') return;
    for (const [dk, lk] of this.alias) if (lk === liveKey) this.alias.delete(dk);
    // 标记主动终止：pty.on('exit') 将跳过退出确认窗口，直接关闭（避免延迟）。
    e.terminating = true;
    try { e.pty.kill(); } catch { /* 进程可能已退出 */ }
    this.clearDataBuffer(liveKey);
    e.bp.dispose();
    this.entries.delete(liveKey);
    if (e.diskKey) {
      this.clearDataBuffer(e.diskKey);
      this.opts.onStatus(e.diskKey, 'dead');
    }
    this.opts.onStatus(liveKey, 'dead');
    this.opts.onExit(liveKey);
  }

  /**
   * 关联已晋升的 disk session 到 live 进程。由外部（pushIndex）在文件变化时调用。
   * 从传入的 SessionGroup 中找到新创建的文件，匹配到对应 cwd 的 live 进程。
   *
   * 异步实现：先 await 所有 entry 的 existingKeysReady（保证后台收集的旧文件集
   * 已回填，避免旧文件被误关联），再用 fs.promises.stat 并行读取磁盘文件 mtime，
   * 不阻塞主进程事件循环。
   */
  async reconcile(groups: Array<{ cwd: string; sessions: Array<{ key: string; name: string; time: string }> }>): Promise<void> {
    // 等待后台 existingDiskKeys 收集完成，避免把创建时已存在的旧文件关联到新进程。
    const pending = [...this.entries.values()]
      .map((e) => e.existingKeysReady)
      .filter((p): p is Promise<void> => !!p);
    if (pending.length > 0) await Promise.all(pending);

    const disk = await Promise.all(
      groups.flatMap((g) =>
        g.sessions
          .filter((s) => !this.entries.has(s.key) && !this.alias.has(s.key))
          .map(async (s) => {
            let mtime = 0;
            try { mtime = (await fs.promises.stat(s.key)).mtimeMs; } catch { /* ignore unreadable */ }
            return { key: s.key, cwd: g.cwd, mtime };
          }),
      ),
    );
    disk.sort((a, b) => b.mtime - a.mtime);
    for (const [liveKey, e] of this.entries) {
      if (e.linked || e.type !== 'pi') continue;
      const cand = disk.find(
        (d) => d.cwd === e.info.cwd && !this.alias.has(d.key) && !e.existingDiskKeys?.has(d.key),
      );
      if (!cand) continue;
      e.linked = true;
      e.diskKey = cand.key;
      this.alias.set(cand.key, liveKey);
      this.opts.onStatus(cand.key, 'running');
      this.opts.onRelink?.(liveKey, cand.key);
    }
  }

  /** 返回某 cwd 在 sessionsDir 下已有的 .jsonl 路径集合（创建时用于排除旧文件）。
   * 异步实现（fs.promises + withFileTypes），不阻塞主进程；
   * 由 spawnPi 后台调用并在 existingKeysReady 后回填 entry.existingDiskKeys。
   *
   * @param spawnAt spawn 时刻时间戳（ms）：仅收集 mtime 早于该时刻的文件，
   *   避免异步收集晚于 spawn 完成时，把 spawn 之后刚写入的新会话文件误判为旧文件。 */
  private async existingDiskKeysForCwd(sessionsDir: string, cwd: string, spawnAt: number): Promise<Set<string>> {
    if (!sessionsDir) return new Set();
    try {
      await fs.promises.access(sessionsDir);
    } catch {
      return new Set();
    }
    const entries = await fs.promises.readdir(sessionsDir, { withFileTypes: true });
    for (const encEntry of entries) {
      if (!encEntry.isDirectory()) continue;
      const dir = path.join(sessionsDir, encEntry.name);
      const groupCwd = readGroupCwd(dir) ?? decodeCwd(encEntry.name);
      if (groupCwd !== cwd) continue;
      const files = await fs.promises.readdir(dir);
      const keys = new Set<string>();
      for (const f of files) {
        if (!f.endsWith('.jsonl')) continue;
        const file = path.join(dir, f);
        try {
          const st = await fs.promises.stat(file);
          if (st.mtimeMs < spawnAt) keys.add(file);
        } catch { /* 不可读（如正在写入）→ 视为新文件，不排除 */ }
      }
      return keys;
    }
    return new Set();
  }

  /** spawn pi 进程（shell-ready 模式）：先 spawn shell，等待就绪后自动注入 pi 命令。
   * id 形如 'live-<uuid>'，env 含 PI_DESKTOP=1。
   *
   * 支持以下场景：
   * - 新建会话：`spawnPi({ cwd, name })` → 传 pi --name 参数
   * - 打开已有 .jsonl：`spawnPi({ sessionFile: '/path/to/session.jsonl' })` → 传 pi --session 参数
   * - 指定 key：`spawnPi({ key: 'live-xxx', cwd, name })` → 复用传入的 key
   *
   * Shell 就绪后自动注入 pi 命令；pi 退出后 shell 保留，用户可继续交互。
   * Pi 退出通过 OSC 133 D 序列检测，通知 UI 更新状态。 */
  private spawnPi(opts: SpawnOptions): TerminalInfo {
    const safeCwd = opts.cwd && fs.existsSync(opts.cwd) ? opts.cwd : process.cwd();
    const resolvedCwd = opts.sessionFile ? resolveCwdFromSessionFile(opts.sessionFile, safeCwd) : safeCwd;
    const id = opts.key ?? `live-${randomUUID()}`;

    // 环境变量：不设 TERM_PROGRAM=vscode 以免触发用户的 VS Code shell integration（
    // 它会在每次 prompt 发射 OSC 133 D 序列，对终端输出造成干扰）。
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PI_DESKTOP: '1',
    };

    // ── 获取默认 shell profile ──
    const profile = opts.profile ?? getDefaultShellProfile();

    // ── 构建 pi 命令参数 ──
    const piBin = this.opts.piBin ?? 'pi';
    const piArgs: string[] = [];
    if (opts.sessionFile) {
      piArgs.push('--session', opts.sessionFile);
    } else if (opts.name) {
      piArgs.push('--name', opts.name);
    }
    const piCommand = piArgs.length > 0 ? `${piBin} ${piArgs.join(' ')}` : piBin;

    // ── 获取 shell-ready launch config ──
    const readyConfig = getShellReadyLaunchConfig(profile);
    const spawnArgs = readyConfig.shellArgs;
    Object.assign(env, readyConfig.envMixin);

    // ── spawn shell（不是 pi） ──
    const pty = spawnPty(profile.path, spawnArgs, {
      cwd: resolvedCwd,
      cols: this.opts.cols,
      rows: this.opts.rows,
      env,
      // Windows 关键：shell:true 避开 conpty 附着竞态导致的原生崩溃
      shell: process.platform === 'win32',
      // Windows 关键：使用 node-pty 自带的 conpty.dll 替代内置 ConPTY。
      // 当 pi-tui 从 fullscreen 切换到 regular 时，pi 进程会调用 process.stdin.pause()
      // 和 setRawMode(false)，这会导致内置 ConPTY 误杀 shell 进程。
      // 使用 conpty.dll 后，_$onProcessExit 不调用 _flushDataAndCleanUp，
      // socket 不会被销毁，exit 事件不会触发，终端保持打开。
      ...(process.platform === 'win32' ? { useConptyDll: true, conptyInheritCursor: true } : {}),
    });

    // 打开已有 .jsonl 时尝试从文件读取会话名作为标题
    let title = 'pi';
    if (opts.sessionFile) {
      try {
        const name = readSessionName(opts.sessionFile);
        if (name) title = name;
      } catch { /* 忽略 */ }
    } else if (opts.name) {
      title = opts.name;
    }

    const info: TerminalInfo = {
      id,
      key: id,
      cwd: resolvedCwd,
      title,
      name: title,
      type: 'pi',
      status: 'running',
    };

    // 收集该 cwd 下已有的 .jsonl keys，用于 reconcile 时排除（避免关联到旧文件）。
    // 异步后台收集，不阻塞 spawn 主路径：existingKeysReady 供 reconcile 等待，
    // 确保其解析前不会把创建时已存在的旧文件误关联到新进程。
    let resolveExistingKeys: (() => void) | undefined;
    const existingKeysReady = new Promise<void>((resolve) => { resolveExistingKeys = resolve; });
    // spawn 时刻基准：异步收集仅保留 mtime 早于该时刻的文件，避免把
    // spawn 之后刚写入的新会话文件误判为「创建时已存在」的旧文件。
    const spawnedAt = Date.now();
    void this.existingDiskKeysForCwd(this.opts.sessionsDir ?? '', resolvedCwd, spawnedAt)
      .then((keys) => {
        const e = this.entries.get(id);
        if (e && keys.size > 0) e.existingDiskKeys = keys;
      })
      .catch(() => { /* 收集失败按无既有文件处理 */ })
      .finally(() => resolveExistingKeys?.());

    // ── shell-ready 状态 ──
    let commandInjected = false;
    let shellReadyTimer: NodeJS.Timeout | null = null;
    let postReadyTimer: NodeJS.Timeout | null = null;
    const scanState = createShellReadyScanState();

    /** 真正关闭终端条目。由 pty exit（进程真退出）或用户主动调用 terminate 触发。 */
    const closeEntry = () => {
      const e = this.entries.get(id);
      // 已被 terminate() 等路径关闭过（entry 已删除），跳过，避免重复 onExit。
      if (!e) return;
      clearTimers();
      this.clearDataBuffer(id);
      e.bp.dispose();
      this.entries.delete(id);
      this.opts.onStatus(id, 'dead');
      if (e.diskKey) this.opts.onStatus(e.diskKey, 'dead');
      this.opts.onExit(id);
    };

    // 清理定时器
    const clearTimers = () => {
      if (shellReadyTimer) { clearTimeout(shellReadyTimer); shellReadyTimer = null; }
      if (postReadyTimer) { clearTimeout(postReadyTimer); postReadyTimer = null; }
    };

    // 注入 pi 命令
    const doInject = () => {
      if (commandInjected) return;
      commandInjected = true;
      clearTimers();
      injectPiCommand(pty, piCommand, readyConfig.bracketedPasteSafe);
    };

    const entry: Entry = {
      pty,
      info,
      type: 'pi',
      bp: new BackpressureController(() => pty.pause(), () => pty.resume()),
      linked: !!opts.sessionFile,
      diskKey: opts.sessionFile,
      existingKeysReady,
    };

    pty.on('data', (d: string) => {
      // 实时背压计数
      this.entries.get(id)?.bp.onData(d.length);

      // 检测 pi-tui 模式切换信号（fullscreen→regular）：
      //  - \x1b[?1049l 退出 alt screen（由 afterTerminalStop 写入）
      //  - \x1b[?2004h 启用 bracketed paste（由新 TUI 的 terminal.start() 写入）
      // 两者连续出现唯一标识一次模式切换（pi 正常退出时只写 \x1b[?1049l 不写 \x1b[?2004h）。
      // Windows ConPTY 会在 pi 调用 process.stdin.pause()/setRawMode(false) 时误杀 shell、
      // 触发 node-pty 的 exit 事件，但 pi 进程实际仍存活。识别此序列组合后，exit 事件可被忽略。
      this.trackTuiModeSwitch(id, d);

      if (!commandInjected) {
        // ── 扫描 shell-ready 标记 ──
        const result = scanForShellReady(scanState, d);
        if (result.matched) {
          // 标记已收到，shell 就绪
          if (result.postMarkerBytesObserved) {
            // 标记后已有数据 → 短延迟后注入（等行编辑器进入 raw 模式）
            postReadyTimer = setTimeout(doInject, POST_READY_COMMAND_DELAY_MS);
          } else {
            // 标记后无数据 → 等下一个 data 事件
            const onNextData = () => {
              pty.removeListener('data', onNextData);
              postReadyTimer = setTimeout(doInject, POST_READY_COMMAND_DELAY_MS);
            };
            pty.on('data', onNextData);
            // 超时兜底
            postReadyTimer = setTimeout(() => {
              pty.removeListener('data', onNextData);
              doInject();
            }, POST_READY_FALLBACK_MS);
          }
        }
        // 剥离标记后的数据发给渲染端（matched 与未匹配在此路径汇合）
        if (result.output) this.emitData(id, result.output);
      } else {
        // 转发数据到渲染端。
        //
        // 注意：这里刻意不再检测 pi 退出（移除了原来的 detectPiExit / OSC 133 D
        // 检测）。原实现依赖 shell prompt 的 OSC 133 D 序列来判断「pi 是否退出」，
        // 但该序列是 shell 的间接信号，会在多种场景下出现——pi 真正退出时 shell
        // 恢复 prompt、pi-tui 切换 TUI 模式（fullscreen↔regular）时 conpty 重发
        // 主缓冲区内容、消息或工具输出中嵌入的 OSC 终码序列等——极易被误判，
        // 典型表现就是「从 fullscreen 切到 regular 时终端被误关」。
        //
        // 改为让终端 tab 的生命周期跟随 shell 进程：pi 退出后 shell 继续运行、
        // prompt 恢复，tab 保持打开；仅当 shell 进程真正退出或用户主动终止时
        // 才关闭 tab。这与普通集成终端的语义一致。
        this.emitData(id, d);
      }
    });

    pty.on('exit', () => {
      // 用户主动终止时（terminate()），直接跳过（terminate() 处理清理）。
      const e = this.entries.get(id);
      if (e?.terminating) { console.log(`[terminal] pty exit ignored: ${id} terminating`); return; }

      // 关键检查：验证进程是否真的退出了。
      // 在 Windows conpty 下，node-pty 的 exit 事件通过 WaitForSingleObject
      // 监视进程句柄触发。但某些场景（如 ci-tui 切换 alt screen 模式、
      // conpty 内部处理管道）可能导致进程句柄误触发而进程实际仍存活。
      // 用 process.kill(pid, 0) 验证进程真实存在性。
      if (isProcessAlive(pty.pid)) {
        // 进程仍存活 → 这是误报 exit，不关闭终端。
        // 注意：不应调用 onExit/onStatus/closeEntry，保持 tab 打开。
        console.warn(`[terminal] pty exit ignored: process ${pty.pid} is still alive`);
        return;
      }

      // 第二道防线：entry 已存在（未被 destroy 删除）且检测到 pi-tui 模式切换序列
      // （\x1b[?1049l 后跟 \x1b[?2004h）说明 shell 虽被 ConPTY 误杀但 pi 进程仍存活。
      // 此时 isProcessAlive(pty.pid) 返回 false（因为 shell 已死），但终端不应关闭。
      if (e && this.isTuiModeSwitch(e)) {
        console.warn(`[terminal] pty exit ignored: pi-tui mode switch detected (altScreen + bracketedPaste)`);
        // 重置标记，避免下次 exit 误判
        e.altScreenExitTime = undefined;
        e.bracketedPasteTime = undefined;
        return;
      }

      console.log(`[terminal] pty exit: ${id} process ${pty.pid} is dead, closing terminal`);

      // 进程真的退出了 → 关闭终端
      closeEntry();
    });

    // ── shell-ready 超时兜底 ──
    shellReadyTimer = setTimeout(() => {
      if (!commandInjected) {
        console.warn('[pi-shell-ready] shell-ready timeout, injecting pi command anyway');
        doInject();
      }
    }, SHELL_READY_TIMEOUT_MS);

    this.entries.set(id, entry);
    // 打开已有 .jsonl 时立即建立 alias 映射
    if (opts.sessionFile) {
      this.alias.set(opts.sessionFile, id);
      this.opts.onStatus(opts.sessionFile, 'running');
      this.opts.onRelink?.(id, opts.sessionFile);
    }
    this.opts.onStatus(id, 'running');
    return info;
  }

  /** spawn shell 进程：id 形如 'term-<uuid>'，env 含 TERM=xterm-256color / COLORTERM=truecolor，
   * 并注入 VS Code shell integration 脚本。 */
  private spawnShell(profile: TerminalProfile, cwd: string): TerminalInfo {
    const safeCwd = cwd && fs.existsSync(cwd) ? cwd : process.cwd();
    const id = `term-${randomUUID()}`;

    // 像 VS Code / 其他终端模拟器一样，向 pty 显式声明终端类型与真彩色支持。
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
    };

    // 计算 shell integration 注入（对齐 VS Code getShellIntegrationInjection）：
    // 改写 args 让 shell 加载注入脚本，混入 nonce/injection 等 env。
    // 不支持的 shell（如 cmd.exe）返回 undefined，走原始 args / 原始 env。
    const injection = getShellIntegrationInjection(profile.path, profile.args);
    let spawnArgs = profile.args;
    if (injection) {
      spawnArgs = injection.newArgs;
      Object.assign(env, injection.envMixin); // 含 TERM_PROGRAM='vscode' / VSCODE_INJECTION / VSCODE_NONCE
    }

    const pty = spawnPty(profile.path, spawnArgs, {
      cwd: safeCwd,
      cols: this.opts.cols,
      rows: this.opts.rows,
      env,
      // Windows 关键：与 SessionPool 的 ptyFactory + pi 分支对齐，显式 shell:true。
      // 否则 node-pty 的 conpty 后端在 pty 被 kill() 销毁时会调用 conpty_console_list_agent
      // 的 getConsoleProcessList → AttachConsole failed → 抛 0xC0000005 原生崩溃，
      // 直接拖垮整个 Electron 主进程（表现为"新建终端一闪即逝 / 应用闪退"）。
      // shell:true 让 node-pty 走 cmd.exe 包裹路径，避开该 conpty 附着竞态。
      shell: true,
      // Windows 关键：使用 node-pty 自带的 conpty.dll，避免 pi-tui 模式切换时
      // 内置 ConPTY 误杀 shell 触发 exit 事件导致集成终端被关。
      ...(process.platform === 'win32' ? { useConptyDll: true, conptyInheritCursor: true } : {}),
    });

    const info: TerminalInfo = {
      id,
      key: id,
      cwd: safeCwd,
      // 首版用 profile.label 作为标题（如 'PowerShell'），后续可改为 cwd 末段。
      title: profile.label,
      name: profile.label,
      type: 'shell',
      status: 'running',
    };

    const entry: Entry = {
      pty,
      info,
      type: 'shell',
      // 源头背压：超高水位 pause PTY、降到低水位 resume PTY（对齐 VS Code ptyProcess.pause/resume）。
      bp: new BackpressureController(() => pty.pause(), () => pty.resume()),
    };

    pty.on('data', (d: string) => {
      // 实时背压计数：PTY 数据一到立即累加，对齐 VS Code TerminalProcess.onProcessData
      // 的源头流控（先算背压再 fire 数据）。消除 5ms 聚合窗口导致的背压响应延迟。
      this.entries.get(id)?.bp.onData(d.length);
      // 检测 pi-tui 模式切换序列（与 spawnPi 对齐）
      this.trackTuiModeSwitch(id, d);
      this.emitData(id, d);
    });

    pty.on('exit', () => {
      // 已被 destroy() 主动关闭（entry 已删除）→ 直接跳过，onExit 已由 destroy() 调用。
      const e = this.entries.get(id);
      if (!e) return;
      // 用户主动终止（destroy）→ 跳过存活检查（destroy() 已调用 onExit）。
      if (e.terminating) return;

      // 关键检查（与 spawnPi 对齐）：Windows conpty 下 node-pty 的 exit 事件可能因
      // alt screen 切换（pi-tui fullscreen↔regular）/ conpty 内部管道处理而误触发，
      // 但进程实际仍存活。用 process.kill(pid, 0) 验证进程真实存在性；
      // 存活则视为误报，不关闭终端（集成终端里跑 pi 时同样需要此防线）。
      if (isProcessAlive(pty.pid)) {
        console.warn(`[terminal] pty exit ignored: process ${pty.pid} is still alive`);
        return;
      }

      // 第二道防线：与 spawnPi 对齐，识别 pi-tui 模式切换误报。
      if (this.isTuiModeSwitch(e)) {
        console.warn(`[terminal] pty exit ignored: pi-tui mode switch detected (altScreen + bracketedPaste)`);
        e.altScreenExitTime = undefined;
        e.bracketedPasteTime = undefined;
        return;
      }

      // 进程真的退出了 → 关闭终端
      this.clearDataBuffer(id);
      this.entries.delete(id);
      this.opts.onExit(id);
    });

    this.entries.set(id, entry);
    return info;
  }

  /** 检测 PTY 输出中的 pi-tui 模式切换序列（\x1b[?1049l 退出 alt screen、\x1b[?2004h 启用 bracketed paste）。
   * 两者在 MODE_SWITCH_WINDOW_MS 窗口内连续出现唯一标识一次 fullscreen→regular 模式切换，
   * 用于在 exit 事件误报时抑制终端关闭。 */
  private trackTuiModeSwitch(id: string, data: string): void {
    const e = this.entries.get(id);
    if (!e) return;
    const now = Date.now();
    if (data.includes('\x1b[?1049l')) e.altScreenExitTime = now;
    if (data.includes('\x1b[?2004h')) e.bracketedPasteTime = now;
  }

  /** 判断 entry 是否在 MODE_SWITCH_WINDOW_MS 内经历了完整的模式切换序列，
   * 即 \x1b[?1049l（退出 alt screen）后跟 \x1b[?2004h（启用 bracketed paste）。
   * pi 正常退出时只写前者不写后者。 */
  private isTuiModeSwitch(e: Entry): boolean {
    if (!e.altScreenExitTime || !e.bracketedPasteTime) return false;
    const now = Date.now();
    return (
      now - e.altScreenExitTime < MODE_SWITCH_WINDOW_MS &&
      now - e.bracketedPasteTime < MODE_SWITCH_WINDOW_MS &&
      e.bracketedPasteTime >= e.altScreenExitTime
    );
  }

  /** 键盘输入 → pty.write。 */
  write(id: string, data: string): void {
    this.entries.get(id)?.pty.write(data);
  }

  /** 调整终端尺寸。pty 已退出时安全跳过（resize 会抛错）。 */
  resize(id: string, cols: number, rows: number): void {
    const e = this.entries.get(id);
    if (!e) return;
    try { e.pty.resize(cols, rows); } catch { /* pty 已退出，吸收竞态 */ }
  }

  /** 杀掉并清理指定终端。清理缓冲，回调 onList 推送最新列表。 */
  destroy(id: string): void {
    const e = this.entries.get(id);
    if (!e) return;
    // 标记主动终止（shell 与 pi 都置位），使 pty 'exit' 跳过存活检查、不重复关闭。
    e.terminating = true;
    try { e.pty.kill(); } catch { /* 进程可能已退出 */ }
    this.clearDataBuffer(id);
    e.bp.dispose();
    this.entries.delete(id);
    // 直接回调 onExit（shell 与 pi 都调用），避免依赖 pty 'exit' 事件（可能被
    // conpty 误报 / 延迟 / 被存活检查拦截而漏掉，导致 tab 残留）。
    this.opts.onExit(id);
    this.opts.onList(this.list()); // create/destroy 都推最新列表
  }

  /** 退出时全清。 */
  killAll(): void {
    for (const id of [...this.entries.keys()]) this.destroy(id);
  }

  /** 实例是否仍存在（存活或尚未 destroy）。 */
  has(id: string): boolean {
    return this.entries.has(id);
  }

  /** 返回所有存活终端信息。 */
  list(): TerminalInfo[] {
    return [...this.entries.values()].map((e) => e.info);
  }

  /** 调试用只读快照：返回所有终端的 id/type/status/pid。
   * 供 session:debug 等调试场景读取池状态，无需直接访问私有 entries 字段。 */
  debugSnapshot(): TerminalDebugSnapshot[] {
    return [...this.entries.values()].map((e) => ({
      id: e.info.id,
      type: e.type,
      status: e.info.status,
      pid: e.pty.pid ?? -1,
    }));
  }

  /** 更新终端 cwd。仅 shell 类型有效（pi 会话的 cwd 由 pi 进程自身管理）。 */
  updateCwd(id: string, cwd: string): void {
    const e = this.entries.get(id);
    if (!e || e.type !== 'shell' || !cwd) return;
    e.info.cwd = cwd;
    this.opts.onList(this.list());
  }

  /** 背压回传：渲染端每消费 N 字节即经 IPC 上报，推进该实例的水位；
   * 水位降到阈值以下时 BackpressureController 自动恢复 PTY 输出。
   * 对齐 VS Code acknowledgeDataEvent 的真流控（而非仅记账）。 */
  acknowledgeDataEvent(id: string, bytes: number): void {
    this.entries.get(id)?.bp.acknowledge(bytes);
  }

  /** 聚合并下发单块 pty 数据（5ms 时间窗，等效 VS Code pty host 端 TerminalDataBufferer，
   * 用于减少 IPC 消息量）。
   * 背压计数已在 pty.on('data') 实时处理，此处仅做数据聚合后投递，
   * 不再重复累加 inflight（对齐 VS Code TerminalProcess.onProcessData
   * 的「先计算背压再 fire 数据」时序）。 */
  private emitData(id: string, data: string): void {
    let buf = this.dataBuffers.get(id);
    if (!buf) {
      buf = { chunks: [], timer: null };
      this.dataBuffers.set(id, buf);
    }
    buf.chunks.push(data);
    if (buf.timer) return; // 窗口已开，等待 flush
    buf.timer = setTimeout(() => {
      const b = this.dataBuffers.get(id);
      if (!b) return;
      const joined = b.chunks.join('');
      b.chunks = [];
      b.timer = null;
      this.dataBuffers.delete(id);
      // 背压计数已在 pty.on('data') 实时处理，此处不再重复累加。
      // 数据照常发往渲染端（pause 只掐断 PTY 后续输出，已读出的这块照发）。
      this.opts.onData(id, joined);
    }, DATA_BUFFER_MS);
  }

  /** 清理某实例的待发聚合缓冲，避免 destroy 后迟到数据回调已销毁的渲染实例。 */
  private clearDataBuffer(id: string): void {
    const b = this.dataBuffers.get(id);
    if (b?.timer) clearTimeout(b.timer);
    this.dataBuffers.delete(id);
  }

  /** 解除 live key 关联的磁盘 session alias。
   * 用于 /new 命令后，使旧 session 的磁盘条目能 spawn 新进程而非复用已有 PTY。
   * 同时重置 entry 的 linked/diskKey 状态，使 reconcile 能重新关联新 .jsonl。 */
  unlinkDiskSession(liveKey: string): void {
    for (const [dk, lk] of this.alias) {
      if (lk === liveKey) {
        this.alias.delete(dk);
        break;
      }
    }
    const e = this.entries.get(liveKey);
    if (e) {
      e.linked = false;
      e.diskKey = undefined;
    }
  }
}
