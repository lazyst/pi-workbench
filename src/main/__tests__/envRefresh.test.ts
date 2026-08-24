import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';

// envRefresh 通过 child_process.execFile 调 PowerShell 读注册表，单测中 mock 掉，
// 由测试代码手动触发回调来控制成功 / 失败两条路径。
vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

import { execFile } from 'node:child_process';
import {
  ensureFreshPathCached,
  getCachedFreshPath,
  mergePathEntries,
  __resetEnvCacheForTests,
} from '../envRefresh';

const execFileMock = vi.mocked(execFile);

/** 捕获 execFile 的回调，由测试主动触发（模拟 PowerShell 异步返回）。 */
function captureExecCallback() {
  let cb: ((err: Error | null, stdout: string) => void) | null = null;
  execFileMock.mockImplementation(((_file: unknown, _args: unknown, _opts: unknown, callback: unknown) => {
    cb = callback as typeof cb;
  }) as never);
  return {
    succeed: (stdout: string) => cb?.(null, stdout),
    fail: (err: Error) => cb?.(err, ''),
  };
}

describe('mergePathEntries', () => {
  it('returns base when fresh is null', () => {
    expect(mergePathEntries('C:\\a', null)).toBe('C:\\a');
    expect(mergePathEntries(null, null)).toBeNull();
  });

  it('returns fresh when base is empty', () => {
    expect(mergePathEntries(null, 'C:\\new')).toBe('C:\\new');
    expect(mergePathEntries('', 'C:\\new')).toBe('C:\\new');
  });

  it('puts fresh entries first, appends base-only entries after (deduped)', () => {
    const base = ['C:\\a', 'C:\\b'].join(path.delimiter);
    const fresh = ['C:\\b', 'C:\\new'].join(path.delimiter);
    const result = mergePathEntries(base, fresh);
    expect(result).toBe(['C:\\b', 'C:\\new', 'C:\\a'].join(path.delimiter));
  });
});

describe('ensureFreshPathCached', () => {
  beforeEach(() => {
    __resetEnvCacheForTests();
    execFileMock.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns null immediately on non-Windows platforms without querying', async () => {
    const spy = vi.spyOn(process, 'platform', 'get').mockReturnValue('linux' as never);
    await expect(ensureFreshPathCached()).resolves.toBeNull();
    expect(execFileMock).not.toHaveBeenCalled();
    expect(getCachedFreshPath()).toBeNull();
    spy.mockRestore();
  });

  it('queries PowerShell once and caches merged PATH on Windows', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32' as never);
    const ctl = captureExecCallback();
    const base = process.env.PATH;

    const p = ensureFreshPathCached();
    expect(execFileMock).toHaveBeenCalledTimes(1);
    // 断言 PowerShell 调用参数：-NoProfile 且脚本要求 UTF-8 输出（防中文乱码）
    const args = execFileMock.mock.calls[0][1] as string[];
    expect(args).toContain('-NoProfile');
    expect(args).toContain('-NonInteractive');
    expect(args.join('\n')).toContain('[Console]::OutputEncoding');

    ctl.succeed(`C:\\new\\bin${path.delimiter}${base}`);
    await expect(p).resolves.not.toBeNull();
    expect(getCachedFreshPath()).not.toBeNull();
    expect(getCachedFreshPath()).toContain('C:\\new\\bin');
  });

  it('falls back to null on query failure (spawn never blocks)', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32' as never);
    const ctl = captureExecCallback();
    const p = ensureFreshPathCached();
    ctl.fail(new Error('powershell boom'));
    await expect(p).resolves.toBeNull();
    expect(getCachedFreshPath()).toBeNull();
  });

  it('reuses in-flight query for concurrent callers (dedupe)', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32' as never);
    const { succeed } = captureExecCallback();

    const p1 = ensureFreshPathCached();
    const p2 = ensureFreshPathCached();
    expect(p1).toBe(p2); // 同一 Promise，仅一次查询
    expect(execFileMock).toHaveBeenCalledTimes(1);
    succeed('C:\\new');
    await p1;
  });

  it('does not re-query within TTL window', async () => {
    vi.useFakeTimers();
    try {
      vi.spyOn(process, 'platform', 'get').mockReturnValue('win32' as never);
      const { succeed } = captureExecCallback();
      const p = ensureFreshPathCached();
      succeed('C:\\new');
      await p;
      expect(execFileMock).toHaveBeenCalledTimes(1);

      // TTL 内再次调用 → 直接命中缓存，不再查询
      await ensureFreshPathCached();
      expect(execFileMock).toHaveBeenCalledTimes(1);

      // 超过 TTL → 重新查询
      vi.advanceTimersByTime(6000);
      const { succeed: succeed2 } = captureExecCallback();
      const p2 = ensureFreshPathCached();
      succeed2('C:\\newest');
      await p2;
      expect(execFileMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });
});