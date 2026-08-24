import { execFile } from 'node:child_process';
import * as path from 'node:path';

/**
 * 终端 spawn 前的最新 PATH 刷新（对齐 VS Code「创建终端前重新解析 shell 环境」的思路）。
 *
 * 背景：Electron 主进程的 process.env 是应用启动那一刻的快照，之后不再变化。应用运行
 * 期间外部安装全局命令（安装器 / 包管理器写入注册表 User/Machine PATH）后，新 spawn
 * 的终端若直接继承 process.env.PATH，将找不到新命令（bug：「装完命令开新终端不可用」）。
 *
 * 平台策略：
 * - Windows：经 PowerShell（-NoProfile，无第三方依赖）从 .NET 读取 Machine PATH +
 *   User PATH（注册表 REG_EXPAND_SZ 已展开 %VAR%），按系统进程 PATH 语义拼接
 *   （系统在前、用户在后），再与当前 process.env.PATH 去重合并（保留应用启动时的
 *   自定义目录）。脚本内显式将控制台输出编码设为 UTF-8 —— PowerShell 5.1 经管道
 *   输出默认走 ANSI 代码页（中文系统即 GBK），Node 按 UTF-8 解码会使中文目录乱码。
 * - 其他平台：不刷新（始终返回 null）。Unix/macOS 上 spawn 的是交互式 shell，
 *   shell 启动会自行加载 profile（.zprofile/.bashrc 等）构建最新 PATH，无需父进程代劳。
 *
 * 两段式使用（避免把 pool 的同步 spawn 链路改成 async、牵连全部既有测试）：
 * - 异步预热：ensureFreshPathCached() —— IPC handler 在创建终端前 await；
 * - 同步消费：getCachedFreshPath() —— UnifiedTerminalPool 构建 env 时读取；
 *   尚未预热时返回 null，pool 回退原 process.env 快照。
 *
 * 幂等 / 性能：5s TTL 缓存 + 并发去重（同一时刻多次创建只查询一次）；查询失败
 * 静默回退，绝不让环境刷新失败阻塞或破坏终端创建。
 */

/** 缓存有效期：连续创建多个终端时 5s 内复用同一次查询结果。 */
const CACHE_TTL_MS = 5000;
/** 单次查询超时：PowerShell 冷启动通常几百 ms，4s 兜底防止卡死终端创建。 */
const REFRESH_TIMEOUT_MS = 4000;

let cachedAt = 0;
let cachedValue: string | null = null;
let inflight: Promise<string | null> | null = null;

/** 从 Windows 注册表读取最新的 Machine PATH + User PATH（%VAR% 已展开）。失败 resolve null。 */
function readWindowsRegistryPath(): Promise<string | null> {
  return new Promise((resolve) => {
    // ';' 是 PowerShell 语句分隔符，不能出现在 -Command 字符串里直接当字面量，
    // 故用 [char]59 表示 PATH 分隔符；char + string 在 PS 中为字符串拼接（已实测）。
    const script =
      '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;' +
      "[Environment]::GetEnvironmentVariable('Path','Machine') + [char]59 + " +
      "[Environment]::GetEnvironmentVariable('Path','User')";
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeout: REFRESH_TIMEOUT_MS, windowsHide: true, encoding: 'utf8' },
      (err, stdout) => {
        if (err) {
          console.warn('[env-refresh] failed to read registry PATH:', err.message);
          resolve(null);
          return;
        }
        // 清除 NUL 结尾与首尾空白（stdout 含结尾换行）
        const value = String(stdout).replace(/\0/g, '').trim();
        resolve(value.length > 0 ? value : null);
      },
    );
  });
}

/**
 * 合并两份 PATH：fresh（最新系统值）条目在前，base（当前进程快照）中 fresh 未包含的
 * 条目按原顺序追加在后 —— 既保证新装命令的目录生效，又保留应用启动环境的自定义目录。
 * Windows 路径大小写不敏感，去重按平台语义处理；任一侧为空则直接返回另一侧。
 */
export function mergePathEntries(base: string | undefined | null, fresh: string | null): string | null {
  if (!fresh) return base ?? null;
  if (!base) return fresh;
  const seen = new Set<string>();
  const out: string[] = [];
  const dedupKey = (seg: string) => (process.platform === 'win32' ? seg.toLowerCase() : seg);
  for (const seg of [...fresh.split(path.delimiter), ...base.split(path.delimiter)]) {
    const s = seg.trim();
    if (!s) continue;
    const key = dedupKey(s);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out.join(path.delimiter);
}

/**
 * 异步预热：确保缓存中持有一次尽可能新的 PATH（带 TTL 与并发去重）。
 * 查询失败时保留旧缓存、不推进 TTL 时间戳（下次调用会重试）；非 Windows 平台恒为 null。
 */
export function ensureFreshPathCached(): Promise<string | null> {
  if (process.platform !== 'win32') return Promise.resolve(null);
  if (inflight) return inflight;
  if (cachedAt > 0 && Date.now() - cachedAt < CACHE_TTL_MS) return Promise.resolve(cachedValue);
  inflight = (async () => {
    try {
      const registry = await readWindowsRegistryPath();
      // 成功才更新缓存与时间戳；失败保留旧值（可能是 null → pool 回退 process.env）
      if (registry !== null) {
        cachedValue = mergePathEntries(process.env.PATH, registry);
        cachedAt = Date.now();
      }
    } finally {
      inflight = null;
    }
    return cachedValue;
  })();
  return inflight;
}

/** 同步读取当前缓存的最新 PATH（未经 ensureFreshPathCached 预热时为 null）。 */
export function getCachedFreshPath(): string | null {
  return cachedValue;
}

/** 重置内部缓存状态。仅供测试使用。 */
export function __resetEnvCacheForTests(): void {
  cachedAt = 0;
  cachedValue = null;
  inflight = null;
}
