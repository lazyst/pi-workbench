import * as fs from 'node:fs';
import * as path from 'node:path';
import type { TerminalProfile, Platform } from '../renderer/src/types';

/**
 * 平台 shell 探测模块。
 *
 * 思路参考 VS Code 的 terminalProfiles.ts，但本项目独立实现，不依赖 VS Code 代码。
 * 目标：列举当前平台上「真实存在」的 shell 可执行文件，返回一个稳定的 profile 列表，
 * 供集成终端下拉框使用。所有判断都是同步的（fs.existsSync），不依赖异步 PATH 查询。
 */

/** 返回归一化后的平台标识。 */
function getPlatform(): Platform {
  const p = process.platform;
  if (p === 'win32') return 'windows';
  if (p === 'darwin') return 'macos';
  return 'linux';
}

/** 若给定路径真实存在，则构造一个 profile；否则返回 null。 */
function makeProfileIfExists(
  id: string,
  label: string,
  p: string,
  platform: Platform | 'all',
  args: string[] = [],
): TerminalProfile | null {
  if (!fs.existsSync(p)) return null;
  return { id, label, path: p, args, platform };
}

/** 在 PATH 环境变量中探测某个可执行文件名（跨平台分隔符），返回第一个存在的绝对路径。 */
function findOnPath(name: string): string | null {
  const envPath = process.env.PATH;
  if (!envPath) return null;
  for (const dir of envPath.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

// ───────────────────────── Windows 探测 ─────────────────────────

function detectWindowsProfiles(): TerminalProfile[] {
  const profiles: TerminalProfile[] = [];
  const windir = process.env.windir || 'C:\\Windows';
  // 32 位进程访问 64 位系统目录需要用 Sysnative 而非 System32。
  const is32Bit = process.arch === 'ia32';
  const system32 = is32Bit
    ? path.join(windir, 'Sysnative')
    : path.join(windir, 'System32');

  // Command Prompt（固定位置，始终探测）。
  const cmd = makeProfileIfExists('cmd', 'CMD', path.join(system32, 'cmd.exe'), 'windows');
  if (cmd) profiles.push(cmd);

  // Windows PowerShell（系统自带，固定位置）。
  const winPs = makeProfileIfExists(
    'windows-powershell',
    'Windows PowerShell',
    path.join(system32, 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    'windows',
  );
  if (winPs) profiles.push(winPs);

  // PowerShell 7 (pwsh)：枚举常见安装位置，只保留真实存在的。
  const localAppData = process.env.LOCALAPPDATA;
  const programFiles = process.env.ProgramFiles;
  const programFilesX86 = process.env['ProgramFiles(x86)'];
  const pwshCandidates: string[] = [];
  // Windows Store / Appx 版优先。
  if (localAppData) {
    pwshCandidates.push(path.join(localAppData, 'Microsoft', 'WindowsApps', 'pwsh.exe'));
  }
  // Program Files 下的 7 目录（常见安装位置）。
  if (programFiles) {
    pwshCandidates.push(path.join(programFiles, 'PowerShell', '7', 'pwsh.exe'));
  }
  if (programFilesX86) {
    pwshCandidates.push(path.join(programFilesX86, 'PowerShell', '7', 'pwsh.exe'));
  }
  // 兜底固定位置。
  pwshCandidates.push('C:\\Program Files\\PowerShell\\7\\pwsh.exe');
  pwshCandidates.push('C:\\Program Files (x86)\\PowerShell\\7\\pwsh.exe');
  const pwsh = pwshCandidates
    .map((c) => makeProfileIfExists('pwsh', 'PowerShell', c, 'windows'))
    .find((p): p is TerminalProfile => p !== null);
  if (pwsh) profiles.push(pwsh);

  // Git Bash：尝试多种来源推算 bash.exe 位置。
  const gitBashCandidates: string[] = [];
  // 1) 从 git.exe 所在目录反推（where git / PATH）。
  const gitExe = findOnPath('git.exe');
  if (gitExe) {
    const gitDir = path.dirname(gitExe); // 形如 ...\Git\cmd 或 ...\Git\bin
    gitBashCandidates.push(path.join(gitDir, '..', 'bin', 'bash.exe'));
    gitBashCandidates.push(path.join(gitDir, '..', 'usr', 'bin', 'bash.exe'));
  }
  // 2) 直接从 PATH 中找 bash.exe（用户可能把 Git\bin 或 Git\usr\bin 加进了 PATH）。
  const bashOnPath = findOnPath('bash.exe');
  if (bashOnPath) {
    gitBashCandidates.push(bashOnPath);
  }
  // 3) scoop 安装。
  const userProfile = process.env.UserProfile;
  if (userProfile) {
    gitBashCandidates.push(path.join(userProfile, 'scoop', 'apps', 'git', 'current', 'bin', 'bash.exe'));
  }
  // 3) msys2 / msys64。
  const homeDrive = process.env.HOMEDRIVE || 'C:';
  gitBashCandidates.push(path.join(homeDrive, 'msys64', 'usr', 'bin', 'bash.exe'));
  // 4) cygwin。
  gitBashCandidates.push(path.join(homeDrive, 'cygwin64', 'bin', 'bash.exe'));
  const gitBash = gitBashCandidates
    .map((c) => makeProfileIfExists('git-bash', 'Git Bash', path.normalize(c), 'windows', ['--login', '-i']))
    .find((p): p is TerminalProfile => p !== null);
  if (gitBash) profiles.push(gitBash);

  return profiles;
}

// ───────────────────────── macOS / Linux 探测 ─────────────────────────

function detectUnixProfiles(): TerminalProfile[] {
  const profiles: TerminalProfile[] = [];
  const platform = getPlatform();

  // 默认 shell：读取 $SHELL。
  const shellEnv = process.env.SHELL;
  if (shellEnv && fs.existsSync(shellEnv)) {
    profiles.push({
      id: 'default',
      label: path.basename(shellEnv),
      path: shellEnv,
      args: [],
      platform,
    });
  }

  // 额外探测常见 shell。多个 fish 候选共用同一 id 'fish'，
  // 由下方去重逻辑只保留第一个存在的（id 稳定且唯一）。
  const extra: Array<{ id: string; label: string; p: string; args?: string[] }> = [
    { id: 'bash', label: 'Bash', p: '/bin/bash' },
    { id: 'zsh', label: 'Zsh', p: '/bin/zsh' },
    { id: 'fish', label: 'Fish', p: '/opt/homebrew/bin/fish' },
    { id: 'fish', label: 'Fish', p: '/usr/local/bin/fish' },
    { id: 'fish', label: 'Fish', p: '/usr/bin/fish' },
  ];
  for (const e of extra) {
    const p = makeProfileIfExists(e.id, e.label, e.p, platform, e.args ?? []);
    if (p) profiles.push(p);
  }

  // 去重：若多个 fish 候选都存在，只保留第一个（id 稳定且唯一）。
  const seen = new Set<string>();
  const deduped: TerminalProfile[] = [];
  for (const p of profiles) {
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    deduped.push(p);
  }
  return deduped;
}

/**
 * 探测当前平台真实存在的终端 shell profile 列表。
 * 只返回 fs.existsSync(path) 为 true 的 profile；若全部探测失败（极罕见），
 * 返回平台合理的最小 fallback 集合。
 */
export function detectTerminalProfiles(): TerminalProfile[] {
  const platform = getPlatform();

  let profiles: TerminalProfile[];
  if (platform === 'windows') {
    profiles = detectWindowsProfiles();
  } else {
    profiles = detectUnixProfiles();
  }

  // Fallback：极端情况下什么都不存在，给一个保证可用的 shell。
  if (profiles.length === 0) {
    if (platform === 'windows') {
      const windir = process.env.windir || 'C:\\Windows';
      const system32 = path.join(windir, 'System32');
      profiles = [{ id: 'cmd', label: 'CMD', path: path.join(system32, 'cmd.exe'), args: [], platform: 'windows' }];
    } else {
      // macOS/Linux：优先 $SHELL，否则 /bin/sh，再否则 /bin/bash。
      const shellEnv = process.env.SHELL;
      if (shellEnv) {
        profiles = [{ id: 'default', label: path.basename(shellEnv), path: shellEnv, args: [], platform }];
      } else if (fs.existsSync('/bin/sh')) {
        profiles = [{ id: 'sh', label: 'Shell', path: '/bin/sh', args: [], platform }];
      } else {
        profiles = [{ id: 'bash', label: 'Bash', path: '/bin/bash', args: [], platform }];
      }
    }
  }

  return profiles;
}

/**
 * 返回当前平台的默认 shell profile（用于 pi 会话的 shell-ready 启动）。
 * 优先顺序：
 * 1. $SHELL 环境变量指向的可执行文件
 * 2. 探测到的第一个 profile（detectTerminalProfiles 保证至少返回一个）
 */
export function getDefaultShellProfile(): TerminalProfile {
  const profiles = detectTerminalProfiles();

  // 优先 SHELL 环境变量
  const shellEnv = process.env.SHELL;
  if (shellEnv) {
    const match = profiles.find((p) => p.path === shellEnv);
    if (match) return match;
    // SHELL 指向的路径存在但不在 profile 列表中，构造一个
    if (fs.existsSync(shellEnv)) {
      return {
        id: 'default',
        label: path.basename(shellEnv),
        path: shellEnv,
        args: [],
        platform: getPlatform(),
      };
    }
  }

  return profiles[0];
}
