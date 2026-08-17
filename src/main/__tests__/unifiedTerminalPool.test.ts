import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// ---------------------------------------------------------------------------
// Mock node-pty at module level —— 同一 Vitest Worker 内生效（不可内联到
// describe 内部）。每个 spawn 调用产出一个 MockPty，放入 mockPtys 供按实例 emit。
// ---------------------------------------------------------------------------
interface MockPty {
  write: ReturnType<typeof vi.fn>;
  resize: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  pause: ReturnType<typeof vi.fn>;
  resume: ReturnType<typeof vi.fn>;
  pid: number;
  _cbs: Record<string, (d?: any) => void>;
  emit: (e: string, d?: any) => void;
}

const mockPtys: MockPty[] = [];

vi.mock('node-pty', () => {
  const make = (): MockPty => {
    const cbs: Record<string, Array<(d?: any) => void>> = {};
    const pty = {
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      on: vi.fn((e: string, cb: (d?: any) => void) => {
        if (!cbs[e]) cbs[e] = [];
        cbs[e].push(cb);
      }),
      removeListener: vi.fn((e: string, cb: (d?: any) => void) => {
        if (cbs[e]) cbs[e] = cbs[e].filter((l) => l !== cb);
      }),
      pause: vi.fn(),
      resume: vi.fn(),
      pid: 1234 + mockPtys.length,
      _cbs: cbs,
      emit: (e: string, d?: any) => cbs[e]?.forEach((cb) => cb(d)),
    };
    mockPtys.push(pty);
    return pty;
  };
  return {
    spawn: vi.fn(() => make()),
  };
});

import * as nodePty from 'node-pty';
import { UnifiedTerminalPool } from '../unifiedTerminalPool';
import type { TerminalProfile } from '../../renderer/src/types';

const spawnMock = nodePty.spawn as unknown as ReturnType<typeof vi.fn>;

const shellProfile: TerminalProfile = {
  id: 'bash',
  label: 'Bash',
  path: '/usr/bin/bash',
  args: [],
  platform: 'all',
};

const existingCwd = process.cwd();

// ---------------------------------------------------------------------------
// 辅助：新建 Pool，所有回调均为 vi.fn()
// ---------------------------------------------------------------------------
function makePool(sessionsDir?: string) {
  const onData = vi.fn();
  const onStatus = vi.fn();
  const onExit = vi.fn();
  const onList = vi.fn();
  const onRelink = vi.fn();
  const pool = new UnifiedTerminalPool({
    cols: 80,
    rows: 24,
    sessionsDir,
    onData,
    onStatus,
    onExit,
    onList,
    onRelink,
  });
  return { pool, onData, onStatus, onExit, onList, onRelink };
}

beforeEach(() => {
  mockPtys.length = 0;
  spawnMock.mockClear();
  // 默认模拟进程已死：process.kill(pid, 0) 抛出 ESRCH，模拟进程不存在
  vi.spyOn(process, 'kill').mockImplementation(() => { throw new Error('ESRCH'); });
});

/** 设置 process.kill 模拟：进程存活（kill 成功）或已死（抛出 ESRCH）。 */
function setProcessAlive(alive: boolean) {
  const mock = process.kill as ReturnType<typeof vi.spyOn>;
  if (alive) {
    mock.mockImplementation(() => true);
  } else {
    mock.mockImplementation(() => { throw new Error('ESRCH'); });
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ============================================================================
//  UnifiedTerminalPool —— 创建（pi 类型）
// ============================================================================
describe('UnifiedTerminalPool', () => {
  describe('create (pi type)', () => {
    it('spawns shell with shell-ready config and injects pi command after shell-ready', () => {
      vi.useFakeTimers();
      try {
        const { pool } = makePool();
        const info = pool.create({ command: 'pi', cwd: existingCwd, profile: shellProfile });

        expect(spawnMock).toHaveBeenCalledTimes(1);
        const [bin, args, opts] = spawnMock.mock.calls[0];
        // 不再 spawn 'pi'，而是 spawn shell profile（bash）
        expect(bin).toBe('/usr/bin/bash');
        expect(args[0]).toBe('--rcfile');
        expect(opts.cwd).toBe(existingCwd);
        expect(opts.cols).toBe(80);
        expect(opts.rows).toBe(24);
        expect(opts.env.PI_DESKTOP).toBe('1');
        expect(opts.env.PI_SHELL_READY_MARKER).toBe('1');
        // TERM_PROGRAM 不再设为 'vscode'，避免触发用户 VS Code shell integration
        expect(opts.env.TERM_PROGRAM).not.toBe('vscode');
        // Windows 上 shell:true，Unix 上 shell:false
        expect(opts.shell).toBe(process.platform === 'win32');

        expect(info.id).toMatch(/^live-/);
        expect(info.type).toBe('pi');
        expect(info.status).toBe('running');
        expect(info.title).toBe('pi');
        expect(info.name).toBe('pi');
        expect(info.cwd).toBe(existingCwd);

        // 发送 shell-ready 标记 → 触发 pi 命令注入
        const pty = mockPtys[0];
        pty.emit('data', '\x1b]777;pi-desktop-shell-ready\x07');
        // 推进时间，触发定时器注入
        vi.advanceTimersByTime(200);
        expect(pty.write).toHaveBeenCalledWith('pi\r');
      } finally {
        vi.useRealTimers();
      }
    });

    it('spawns pi with --name when name is provided (via pty.write after shell-ready)', () => {
      vi.useFakeTimers();
      try {
        const { pool } = makePool();
        pool.create({ command: 'pi', cwd: existingCwd, name: 'My Session', profile: shellProfile });

        const pty = mockPtys[0];
        pty.emit('data', '\x1b]777;pi-desktop-shell-ready\x07');
        vi.advanceTimersByTime(200);
        expect(pty.write).toHaveBeenCalledWith('pi --name My Session\r');
      } finally {
        vi.useRealTimers();
      }
    });

    it('returns existing entry for the same key (no duplicate spawn)', () => {
      const { pool } = makePool();
      const first = pool.create({ command: 'pi', cwd: existingCwd, key: 'live-keep', profile: shellProfile });
      const second = pool.create({ command: 'pi', cwd: existingCwd, key: 'live-keep', profile: shellProfile });

      expect(spawnMock).toHaveBeenCalledTimes(1);
      expect(second.id).toBe(first.id);
    });

    it('opens existing sessionFile when provided', () => {
      vi.useFakeTimers();
      try {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'utp-pi-'));
        const file = path.join(tmpDir, 'session.jsonl');
        fs.writeFileSync(file, JSON.stringify({ cwd: existingCwd }) + '\n');

        const { pool } = makePool();
        const info = pool.create({ command: 'pi', cwd: existingCwd, sessionFile: file, profile: shellProfile });

        expect(spawnMock).toHaveBeenCalledTimes(1);
        const [bin] = spawnMock.mock.calls[0];
        expect(bin).toBe('/usr/bin/bash');

        const pty = mockPtys[0];
        pty.emit('data', '\x1b]777;pi-desktop-shell-ready\x07');
        vi.advanceTimersByTime(200);
        expect(pty.write).toHaveBeenCalledWith(`pi --session ${file}\r`);
        expect(info.type).toBe('pi');

        fs.rmSync(tmpDir, { recursive: true, force: true });
      } finally {
        vi.useRealTimers();
      }
    });

    it('spawns with piBin when configured', () => {
      vi.useFakeTimers();
      try {
        const customPool = new UnifiedTerminalPool({
          cols: 80, rows: 24,
          piBin: '/custom/pi',
          onData: vi.fn(), onStatus: vi.fn(), onExit: vi.fn(), onList: vi.fn(),
        });
        customPool.create({ command: 'pi', cwd: existingCwd, profile: shellProfile });

        expect(spawnMock).toHaveBeenCalled();
        const [bin] = spawnMock.mock.calls[0];
        expect(bin).toBe('/usr/bin/bash');

        const pty = mockPtys[0];
        pty.emit('data', '\x1b]777;pi-desktop-shell-ready\x07');
        vi.advanceTimersByTime(200);
        expect(pty.write).toHaveBeenCalledWith('/custom/pi\r');
      } finally {
        vi.useRealTimers();
      }
    });

    it('reuses existing live entry when sessionFile matches an alias', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'utp-alias-'));
      const file = path.join(tmpDir, 'session.jsonl');
      fs.writeFileSync(file, JSON.stringify({ cwd: existingCwd }) + '\n');

      const { pool } = makePool(tmpDir);
      const first = pool.create({ command: 'pi', cwd: existingCwd, sessionFile: file, profile: shellProfile });
      const second = pool.create({ command: 'pi', cwd: existingCwd, sessionFile: file, profile: shellProfile });

      expect(spawnMock).toHaveBeenCalledTimes(1);
      expect(second.id).toBe(first.id);

      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('injects pi command after shell-ready marker in data stream', () => {
      vi.useFakeTimers();
      try {
        const { pool } = makePool();
        pool.create({ command: 'pi', cwd: existingCwd, profile: shellProfile });

        const pty = mockPtys[0];
        pty.emit('data', 'Last login: ...\n');
        expect(pty.write).not.toHaveBeenCalled();

        pty.emit('data', '\x1b]777;pi-desktop-shell-ready\x07');
        vi.advanceTimersByTime(200);
        expect(pty.write).toHaveBeenCalledWith('pi\r');
      } finally {
        vi.useRealTimers();
      }
    });

    it('injects pi command on timeout if shell-ready marker never arrives', () => {
      vi.useFakeTimers();
      try {
        const { pool } = makePool();
        pool.create({ command: 'pi', cwd: existingCwd, profile: shellProfile });

        const pty = mockPtys[0];
        expect(pty.write).not.toHaveBeenCalled();

        vi.advanceTimersByTime(1500);
        expect(pty.write).toHaveBeenCalledWith('pi\r');
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not treat OSC 133 D from shell prompt as a pi exit (terminal lifecycle follows shell)', () => {
      vi.useFakeTimers();
      try {
        const { pool, onStatus, onExit } = makePool();
        pool.create({ command: 'pi', cwd: existingCwd, profile: shellProfile });

        const pty = mockPtys[0];
        pty.emit('data', '\x1b]777;pi-desktop-shell-ready\x07');
        vi.advanceTimersByTime(200); // 触发命令注入

        // shell prompt 的 OSC 133 D 只是间接信号（pi-tui 切换 TUI 模式 / conpty 重发
        // 主缓冲区时也会出现这类内容），不应据此关闭 tab 或标记会话死亡
        pty.emit('data', 'some output\n\x1b]133;D;0\x07prompt> ');

        expect(onExit).not.toHaveBeenCalled();
        expect(onStatus).not.toHaveBeenLastCalledWith(expect.stringMatching(/^live-/), 'dead');

        // 只有当 shell 进程真正退出时才关闭 tab（进程已死验证通过）
        pty.emit('exit', 0);
        expect(onStatus).toHaveBeenLastCalledWith(expect.stringMatching(/^live-/), 'dead');
        expect(onExit).toHaveBeenCalledWith(expect.stringMatching(/^live-/));
      } finally {
        vi.useRealTimers();
      }
    });

    it('keeps terminal open when pty exit fires but process is still alive (false exit)', () => {
      vi.useFakeTimers();
      try {
        setProcessAlive(true); // 模拟进程仍存活
        const { pool, onExit } = makePool();
        pool.create({ command: 'pi', cwd: existingCwd, profile: shellProfile });

        const pty = mockPtys[0];
        pty.emit('data', '\x1b]777;pi-desktop-shell-ready\x07');
        vi.advanceTimersByTime(200); // 触发命令注入

        // conpty 误报 exit，但进程实际仍存活
        pty.emit('exit');
        // 进程存活检查 → 不关闭终端，不调用 onExit
        expect(onExit).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it('closes terminal when pty exit fires and process is dead (real exit)', () => {
      vi.useFakeTimers();
      try {
        setProcessAlive(false); // 进程已死
        const { pool, onExit, onStatus } = makePool();
        const info = pool.create({ command: 'pi', cwd: existingCwd, profile: shellProfile });

        const pty = mockPtys[0];
        pty.emit('data', '\x1b]777;pi-desktop-shell-ready\x07');
        vi.advanceTimersByTime(200); // 触发命令注入

        // 进程真的退出了 → 关闭终端
        pty.emit('exit', 0);
        expect(onStatus).toHaveBeenLastCalledWith(info.id, 'dead');
        expect(onExit).toHaveBeenCalledWith(info.id);
        expect(pool.has(info.id)).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it('terminate() skips process liveness check and closes immediately', () => {
      vi.useFakeTimers();
      try {
        setProcessAlive(true); // 即使进程仍存活，terminate() 也应强制关闭
        const { pool, onExit } = makePool();
        const info = pool.create({ command: 'pi', cwd: existingCwd, profile: shellProfile });

        const pty = mockPtys[0];
        pty.emit('data', '\x1b]777;pi-desktop-shell-ready\x07');
        vi.advanceTimersByTime(200);

        // 用户主动终止 → 跳过进程存活检查，立即关闭
        pool.terminate(info.id);
        expect(onExit).toHaveBeenCalledWith(info.id);
      } finally {
        vi.useRealTimers();
      }
    });

    it('keeps terminal open when exit fires after pi-tui mode switch sequences (shell killed by conpty but pi alive)', () => {
      vi.useFakeTimers();
      try {
        setProcessAlive(false); // shell 已被 ConPTY 误杀，isProcessAlive 返回 false
        const { pool, onExit } = makePool();
        const info = pool.create({ command: 'pi', cwd: existingCwd, profile: shellProfile });

        const pty = mockPtys[0];
        pty.emit('data', '\x1b]777;pi-desktop-shell-ready\x07');
        vi.advanceTimersByTime(200); // 触发命令注入

        // 模拟 pi-tui fullscreen→regular 切换：afterTerminalStop 写 \x1b[?1049l，
        // 新 TUI terminal.start() 写 \x1b[?2004h
        pty.emit('data', '\x1b[?1049l');
        pty.emit('data', '\x1b[?2004hregular-content');

        // ConPTY 误报 exit（shell 已死但 pi 进程存活）
        pty.emit('exit', 0);
        // 识别模式切换序列组合 → 不关闭终端
        expect(onExit).not.toHaveBeenCalled();
        expect(pool.has(info.id)).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it('closes terminal when exit fires with only alt-screen exit but no bracketed paste (real pi exit)', () => {
      vi.useFakeTimers();
      try {
        setProcessAlive(false);
        const { pool, onExit, onStatus } = makePool();
        const info = pool.create({ command: 'pi', cwd: existingCwd, profile: shellProfile });

        const pty = mockPtys[0];
        pty.emit('data', '\x1b]777;pi-desktop-shell-ready\x07');
        vi.advanceTimersByTime(200);

        // 模拟 pi 退出：stopInteractiveTui 写 \x1b[?1049l（switchTuiMode preserveScreen），
        // 但新 TUI 不启动（startRenderer:false），不写 \x1b[?2004h
        pty.emit('data', '\x1b[?1049l');

        pty.emit('exit', 0);
        // 只有 altScreenExit 没有 bracketedPaste → 真的退出，关闭终端
        expect(onStatus).toHaveBeenLastCalledWith(info.id, 'dead');
        expect(onExit).toHaveBeenCalledWith(info.id);
        expect(pool.has(info.id)).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // ==========================================================================
  //  创建（shell 类型）
  // ==========================================================================
  describe('create (shell type)', () => {
    it('spawns shell with TERM/COLORTERM env and VS Code shell integration', () => {
      const { pool } = makePool();
      const info = pool.create({ cwd: existingCwd, profile: shellProfile });

      expect(spawnMock).toHaveBeenCalledTimes(1);
      const [bin, args, opts] = spawnMock.mock.calls[0];
      expect(bin).toBe('/usr/bin/bash');
      expect(args[0]).toBe('--init-file');
      expect(opts.cwd).toBe(existingCwd);
      expect(opts.cols).toBe(80);
      expect(opts.rows).toBe(24);
      expect(opts.env.TERM).toBe('xterm-256color');
      expect(opts.env.COLORTERM).toBe('truecolor');
      expect(opts.env.VSCODE_INJECTION).toBe('1');
      expect(opts.env.TERM_PROGRAM).toBe('vscode');
      expect(opts.shell).toBe(true);

      expect(info.id).toMatch(/^term-/);
      expect(info.type).toBe('shell');
      expect(info.title).toBe('Bash');
      expect(info.name).toBe('Bash');
      expect(pool.has(info.id)).toBe(true);
    });

    it('falls back to process.cwd() when the given cwd does not exist', () => {
      const { pool } = makePool();
      const info = pool.create({ cwd: '/this/does/not/exist/xyz', profile: shellProfile });

      expect(spawnMock.mock.calls[0][2].cwd).toBe(process.cwd());
      expect(info.cwd).toBe(process.cwd());
    });

    it('throws when profile is missing for shell type', () => {
      const { pool } = makePool();
      // @ts-expect-error — intentionally missing profile
      expect(() => pool.create({ cwd: existingCwd })).toThrow('profile is required');
    });
  });

  // ==========================================================================
  //  write
  // ==========================================================================
  describe('write', () => {
    it('forwards input to pty.write', () => {
      const { pool } = makePool();
      const info = pool.create({ command: 'pi', cwd: existingCwd, profile: shellProfile });
      const pty = mockPtys[0];

      pool.write(info.id, 'ls\n');
      expect(pty.write).toHaveBeenCalledWith('ls\n');
    });

    it('safely no-ops for non-existent id', () => {
      const { pool } = makePool();
      expect(() => pool.write('nope', 'x')).not.toThrow();
    });
  });

  // ==========================================================================
  //  resize
  // ==========================================================================
  describe('resize', () => {
    it('forwards to pty.resize', () => {
      const { pool } = makePool();
      const info = pool.create({ command: 'pi', cwd: existingCwd, profile: shellProfile });
      const pty = mockPtys[0];

      pool.resize(info.id, 120, 40);
      expect(pty.resize).toHaveBeenCalledWith(120, 40);
    });

    it('absorbs pty.resize errors (exited pty race)', () => {
      const { pool } = makePool();
      const info = pool.create({ command: 'pi', cwd: existingCwd, profile: shellProfile });
      const pty = mockPtys[0];
      pty.resize.mockImplementation(() => { throw new Error('winpty error'); });

      expect(() => pool.resize(info.id, 100, 30)).not.toThrow();
      expect(pty.resize).toHaveBeenCalledTimes(1);
    });

    it('safely no-ops for non-existent id', () => {
      const { pool } = makePool();
      expect(() => pool.resize('nope', 80, 24)).not.toThrow();
    });
  });

  // ==========================================================================
  //  destroy
  // ==========================================================================
  describe('destroy', () => {
    it('kills pty, removes entry, calls onList', () => {
      const { pool, onList } = makePool();
      const info = pool.create({ command: 'pi', cwd: existingCwd, profile: shellProfile });
      const pty = mockPtys[0];

      pool.destroy(info.id);
      expect(pty.kill).toHaveBeenCalledTimes(1);
      expect(pool.has(info.id)).toBe(false);
      expect(onList).toHaveBeenCalledTimes(1);
    });

    it('calls onExit via destroy() and treats late pty exit as safe no-op', () => {
      const { pool, onExit } = makePool();
      const info = pool.create({ command: 'pi', cwd: existingCwd, profile: shellProfile });
      const pty = mockPtys[0];

      pool.destroy(info.id);
      expect(pool.has(info.id)).toBe(false);
      // destroy() 直接调用 onExit（pi 类型），late exit 是安全 no-op（不重复）
      expect(onExit).toHaveBeenCalledWith(info.id);
      expect(onExit).toHaveBeenCalledTimes(1);

      pty.emit('exit');
      expect(onExit).toHaveBeenCalledTimes(1); // 不重复
    });

    it('safely no-ops for non-existent id', () => {
      const { pool } = makePool();
      expect(() => pool.destroy('nope')).not.toThrow();
    });
  });

  // ==========================================================================
  //  has / list
  // ==========================================================================
  describe('has / list', () => {
    it('has returns true for live entries, false after destroy', () => {
      const { pool } = makePool();
      const info = pool.create({ command: 'pi', cwd: existingCwd, profile: shellProfile });
      expect(pool.has(info.id)).toBe(true);
      pool.destroy(info.id);
      expect(pool.has(info.id)).toBe(false);
    });

    it('list returns all live entries', () => {
      const { pool } = makePool();
      const a = pool.create({ command: 'pi', cwd: existingCwd, profile: shellProfile });
      const b = pool.create({ cwd: existingCwd, profile: shellProfile });
      const all = pool.list();

      expect(all.map((t) => t.id).sort()).toEqual([a.id, b.id].sort());
      expect(all.every((t) => t.status === 'running')).toBe(true);
    });

    it('list excludes destroyed entries', () => {
      const { pool } = makePool();
      const a = pool.create({ command: 'pi', cwd: existingCwd, profile: shellProfile });
      pool.create({ command: 'pi', cwd: existingCwd, profile: shellProfile });
      pool.destroy(a.id);
      expect(pool.list()).toHaveLength(1);
    });
  });

  // ==========================================================================
  //  killAll
  // ==========================================================================
  describe('killAll', () => {
    it('destroys every entry and kills all ptys', () => {
      const { pool } = makePool();
      pool.create({ command: 'pi', cwd: existingCwd, profile: shellProfile });
      pool.create({ cwd: existingCwd, profile: shellProfile });
      pool.killAll();

      expect(pool.list()).toHaveLength(0);
      expect(mockPtys[0].kill).toHaveBeenCalledTimes(1);
      expect(mockPtys[1].kill).toHaveBeenCalledTimes(1);
    });
  });

  // ==========================================================================
  //  updateCwd（仅 shell 类型有效）
  // ==========================================================================
  describe('updateCwd', () => {
    it('updates cwd for shell type and triggers onList', () => {
      const { pool, onList } = makePool();
      const info = pool.create({ cwd: existingCwd, profile: shellProfile });

      pool.updateCwd(info.id, '/new/cwd');
      const entry = pool.list().find((t) => t.id === info.id);
      expect(entry?.cwd).toBe('/new/cwd');
      expect(onList).toHaveBeenCalled();
    });

    it('no-ops for pi type', () => {
      const { pool, onList } = makePool();
      const info = pool.create({ command: 'pi', cwd: existingCwd, profile: shellProfile });

      pool.updateCwd(info.id, '/new/cwd');
      const entry = pool.list().find((t) => t.id === info.id);
      expect(entry?.cwd).toBe(existingCwd);
    });
  });

  // ==========================================================================
  //  acknowledgeDataEvent
  // ==========================================================================
  describe('acknowledgeDataEvent', () => {
    it('forwards to BackpressureController without throwing', () => {
      const { pool } = makePool();
      const info = pool.create({ command: 'pi', cwd: existingCwd, profile: shellProfile });
      expect(() => pool.acknowledgeDataEvent(info.id, 100)).not.toThrow();
    });

    it('safely no-ops for non-existent id', () => {
      const { pool } = makePool();
      expect(() => pool.acknowledgeDataEvent('nope', 100)).not.toThrow();
    });
  });

  // ==========================================================================
  //  liveKeyFor
  // ==========================================================================
  describe('liveKeyFor', () => {
    it('returns the key itself when it is a live entry', () => {
      const { pool } = makePool();
      const info = pool.create({ command: 'pi', cwd: existingCwd, profile: shellProfile });
      expect(pool.liveKeyFor(info.id)).toBe(info.id);
    });

    it('resolves alias when disk key is linked via reconcile', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'utp-lkf-'));
      const { pool } = makePool(tmpDir);

      const info = pool.create({ command: 'pi', cwd: existingCwd, profile: shellProfile });
      const encCwd = existingCwd.replace(/\\/g, '--').replace(/^([A-Za-z]):/, '$1');
      const groupDir = path.join(tmpDir, `--${encCwd}--`);
      fs.mkdirSync(groupDir, { recursive: true });
      const sessionFile = path.join(groupDir, 's.jsonl');
      fs.writeFileSync(sessionFile, JSON.stringify({ cwd: existingCwd }) + '\n');

      await pool.reconcile([{
        cwd: existingCwd,
        sessions: [{ key: sessionFile, name: 'T', time: 't' }],
      }]);

      expect(pool.liveKeyFor(sessionFile)).toBe(info.id);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('returns the given key when there is no alias', () => {
      const { pool } = makePool();
      expect(pool.liveKeyFor('/path/to/nonexistent.jsonl')).toBe('/path/to/nonexistent.jsonl');
    });
  });

  // ==========================================================================
  //  reconcile（晋升 / 别名映射）
  // ==========================================================================
  describe('reconcile', () => {
    it('links a pi session to a new .jsonl file in the same cwd', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'utp-rec-'));
      const { pool, onStatus, onRelink } = makePool(tmpDir);

      const info = pool.create({ command: 'pi', cwd: existingCwd, profile: shellProfile });

      const encCwd = existingCwd.replace(/\\/g, '--').replace(/^([A-Za-z]):/, '$1');
      const groupDir = path.join(tmpDir, `--${encCwd}--`);
      fs.mkdirSync(groupDir, { recursive: true });
      const sessionFile = path.join(groupDir, '2026-07-03T19-07-11-857Z_abc.jsonl');
      fs.writeFileSync(sessionFile, JSON.stringify({ cwd: existingCwd }) + '\n');

      await pool.reconcile([{
        cwd: existingCwd,
        sessions: [{ key: sessionFile, name: 'Test', time: '2026-07-03 19:07' }],
      }]);

      expect(pool.liveKeyFor(sessionFile)).toBe(info.id);
      expect(onStatus).toHaveBeenCalledWith(sessionFile, 'running');
      expect(onRelink).toHaveBeenCalledWith(info.id, sessionFile);

      pool.terminate(sessionFile);
      expect(pool.has(info.id)).toBe(false);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('does not link when the cwd differs', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'utp-rec2-'));
      const { pool } = makePool(tmpDir);

      pool.create({ command: 'pi', cwd: existingCwd, profile: shellProfile });

      const otherCwd = path.resolve(existingCwd, '..');
      const encOther = otherCwd.replace(/\\/g, '--').replace(/^([A-Za-z]):/, '$1');
      const groupDir = path.join(tmpDir, `--${encOther}--`);
      fs.mkdirSync(groupDir, { recursive: true });
      const sessionFile = path.join(groupDir, 'other.jsonl');
      fs.writeFileSync(sessionFile, JSON.stringify({ cwd: otherCwd }) + '\n');

      await pool.reconcile([{
        cwd: otherCwd,
        sessions: [{ key: sessionFile, name: 'Other', time: 't' }],
      }]);

      expect(pool.liveKeyFor(sessionFile)).toBe(sessionFile);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('skips files that were already present at spawn time', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'utp-rec3-'));
      const encCwd = existingCwd.replace(/\\/g, '--').replace(/^([A-Za-z]):/, '$1');
      const groupDir = path.join(tmpDir, `--${encCwd}--`);
      fs.mkdirSync(groupDir, { recursive: true });
      const oldFile = path.join(groupDir, 'old.jsonl');
      fs.writeFileSync(oldFile, JSON.stringify({ cwd: existingCwd }) + '\n');

      const { pool } = makePool(tmpDir);
      const info = pool.create({ command: 'pi', cwd: existingCwd, profile: shellProfile });

      await pool.reconcile([{
        cwd: existingCwd,
        sessions: [{ key: oldFile, name: 'Old', time: 't' }],
      }]);

      expect(pool.liveKeyFor(oldFile)).toBe(oldFile);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });
  });

  // ==========================================================================
  //  5ms 数据聚合窗口（等效 VS Code pty host 端 TerminalDataBufferer）
  // ==========================================================================
  describe('5ms data aggregation window', () => {
    it('merges rapid chunks into a single onData call', async () => {
      vi.useFakeTimers();
      try {
        const { pool, onData } = makePool();
        const info = pool.create({ command: 'pi', cwd: existingCwd, profile: shellProfile });
        const pty = mockPtys[0];

        pty.emit('data', 'chunk-1');
        pty.emit('data', 'chunk-2');
        pty.emit('data', 'chunk-3');
        expect(onData).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(10);
        expect(onData).toHaveBeenCalledTimes(1);
        expect(onData).toHaveBeenCalledWith(info.id, 'chunk-1chunk-2chunk-3');
      } finally {
        vi.useRealTimers();
      }
    });

    it('treats windows separated by >5ms as independent emits', async () => {
      vi.useFakeTimers();
      try {
        const { pool, onData } = makePool();
        const info = pool.create({ command: 'pi', cwd: existingCwd, profile: shellProfile });
        const pty = mockPtys[0];

        pty.emit('data', 'frame-a');
        await vi.advanceTimersByTimeAsync(10);
        pty.emit('data', 'frame-b');
        await vi.advanceTimersByTimeAsync(10);

        expect(onData).toHaveBeenCalledTimes(2);
        expect(onData).toHaveBeenNthCalledWith(1, info.id, 'frame-a');
        expect(onData).toHaveBeenNthCalledWith(2, info.id, 'frame-b');
      } finally {
        vi.useRealTimers();
      }
    });

    it('clears pending buffer on destroy (no late emit)', async () => {
      vi.useFakeTimers();
      try {
        const { pool, onData } = makePool();
        const info = pool.create({ command: 'pi', cwd: existingCwd, profile: shellProfile });
        const pty = mockPtys[0];

        pty.emit('data', 'late');
        pool.destroy(info.id);
        await vi.advanceTimersByTimeAsync(10);
        expect(onData).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // ==========================================================================
  //  terminate（仅 pi 类型）
  // ==========================================================================
  describe('terminate', () => {
    it('kills pi process and reports status/exits', () => {
      const { pool, onStatus, onExit } = makePool();
      const info = pool.create({ command: 'pi', cwd: existingCwd, profile: shellProfile });
      const pty = mockPtys[0];

      pool.terminate(info.id);
      expect(pty.kill).toHaveBeenCalledTimes(1);
      expect(onStatus).toHaveBeenCalledWith(info.id, 'dead');
      expect(onExit).toHaveBeenCalledWith(info.id);
      expect(pool.has(info.id)).toBe(false);
    });

    it('safely no-ops for shell type', () => {
      const { pool } = makePool();
      const info = pool.create({ cwd: existingCwd, profile: shellProfile });
      const pty = mockPtys[0];

      pool.terminate(info.id);
      expect(pty.kill).not.toHaveBeenCalled();
      expect(pool.has(info.id)).toBe(true);
    });

    it('kills the linked live process when called with a disk key', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'utp-termdisk-'));
      const { pool, onExit } = makePool(tmpDir);

      const info = pool.create({ command: 'pi', cwd: existingCwd, profile: shellProfile });
      const encCwd = existingCwd.replace(/\\/g, '--').replace(/^([A-Za-z]):/, '$1');
      const groupDir = path.join(tmpDir, `--${encCwd}--`);
      fs.mkdirSync(groupDir, { recursive: true });
      const sessionFile = path.join(groupDir, 'session.jsonl');
      fs.writeFileSync(sessionFile, JSON.stringify({ cwd: existingCwd }) + '\n');

      await pool.reconcile([{
        cwd: existingCwd,
        sessions: [{ key: sessionFile, name: 'T', time: 't' }],
      }]);

      pool.terminate(sessionFile);
      expect(pool.has(info.id)).toBe(false);
      expect(onExit).toHaveBeenCalledWith(info.id);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });
  });
});