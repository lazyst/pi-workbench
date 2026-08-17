/**
 * Pi-Desktop Shell-Ready 模块 —— 在 PTY shell 中等待就绪后注入 pi 命令。
 *
 * 借鉴 Orca 的 shell-ready wrapper 机制：
 * 1. 生成 shell wrapper 文件（临时目录），拦截 shell 启动流程
 * 2. Wrapper 加载用户正常的 rc/profile 文件
 * 3. Wrapper 在 shell 完全就绪后发射 OSC 777 标记
 * 4. 扫描器检测到 OSC 777 后，将 pi 命令写入 PTY
 * 5. pi 退出后，通过 OSC 133 D 检测命令退出，通知调用方
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type * as nodePty from 'node-pty';
import type { TerminalProfile } from '../../renderer/src/types';

// =========================================================================
// 常量
// =========================================================================

/** Shell-ready 标记：OSC 777 序列 */
const SHELL_READY_MARKER_PREFIX = '\x1b]777;pi-desktop-shell-ready';

/** 超时兜底：最长等待 shell 就绪的时间（ms） */
export const SHELL_READY_TIMEOUT_MS = 1500;

/** 命令注入后等待的延迟（ms）—— 等 shell 行编辑器进入 raw 模式 */
export const POST_READY_COMMAND_DELAY_MS = 30;

/** 无 shell-ready 标记时的 fallback 延迟 */
export const POST_READY_FALLBACK_MS = 200;

/** Wrapper 根目录名 */
const WRAPPER_ROOT_NAME = 'pi-shell-ready';

// =========================================================================
// Shell-ready 标记扫描器
// =========================================================================

export interface ShellReadyScanState {
  /** 当前匹配到标记前缀的第几个字符 */
  matchPos: number;
  /** 暂存的可能匹配中的字节 */
  heldBytes: string;
}

export interface ShellReadyScanResult {
  /** 剥离标记后的数据 */
  output: string;
  /** 是否匹配到完整的 shell-ready 标记 */
  matched: boolean;
  /** 标记之后是否还有数据（用于判断是否可立即投递命令） */
  postMarkerBytesObserved: boolean;
}

export function createShellReadyScanState(): ShellReadyScanState {
  return { matchPos: 0, heldBytes: '' };
}

/**
 * 逐字节扫描 PTY 数据，检测 OSC 777 shell-ready 标记。
 * 匹配到标记时返回 matched=true，并将标记后的数据放入 output。
 * 未匹配时返回 output=原始数据（剥离可能的部分匹配前缀）。
 */
export function scanForShellReady(
  state: ShellReadyScanState,
  data: string,
): ShellReadyScanResult {
  let output = '';

  for (let i = 0; i < data.length; i += 1) {
    const ch = data[i] as string;
    if (state.matchPos < SHELL_READY_MARKER_PREFIX.length) {
      if (ch === SHELL_READY_MARKER_PREFIX[state.matchPos]) {
        state.heldBytes += ch;
        state.matchPos += 1;
      } else {
        // 匹配失败，将暂存数据 + 当前字符输出
        output += state.heldBytes;
        state.heldBytes = '';
        state.matchPos = 0;
        // 如果当前字符匹配前缀首字符，重新开始
        if (ch === SHELL_READY_MARKER_PREFIX[0]) {
          state.heldBytes = ch;
          state.matchPos = 1;
        } else {
          output += ch;
        }
      }
    } else if (ch === '\x07') {
      // 匹配到完整的 OSC 777 标记（BEL 终止）
      const remaining = data.slice(i + 1);
      state.heldBytes = '';
      state.matchPos = 0;
      return {
        output: output + remaining,
        matched: true,
        postMarkerBytesObserved: remaining.length > 0,
      };
    } else {
      // 标记前缀已匹配完，但还没收到 BEL → 继续收
      state.heldBytes += ch;
    }
  }

  return { output, matched: false, postMarkerBytesObserved: false };
}

// =========================================================================
// 命令注入器
// =========================================================================

/**
 * 构建注入命令的提交字符串。
 * 对齐 VS Code 的 shell integration 行为：提交符用 \r（Windows）或 \n（POSIX）。
 */
function buildStartupCommandSubmission(
  command: string,
  submit: string,
  bracketedPasteSafe: boolean,
): string {
  // 多层命令用 bracketed paste 包裹
  if (bracketedPasteSafe && (command.includes('\n') || command.includes('\r'))) {
    return `\x1b[200~${command}\x1b[201~${submit}`;
  }
  return `${command}${submit}`;
}

/**
 * 注入 pi 命令到已就绪的 shell。
 * 由 shell-ready 检测回调调用。
 */
export function injectPiCommand(
  pty: nodePty.IPty,
  piCommand: string,
  bracketedPasteSafe: boolean,
): void {
  const submit = process.platform === 'win32' ? '\r' : '\n';
  const cmd = buildStartupCommandSubmission(piCommand, submit, bracketedPasteSafe);
  pty.write(cmd);
}

// =========================================================================
// Shell-ready wrapper 生成
// =========================================================================

/** 获取 wrapper 文件根目录 */
function getWrapperRoot(): string {
  // 使用 APPDATA 或 tmpdir，与现有 shell-integration 目录保持一致
  const user = (() => {
    try { return os.userInfo().username; } catch { return 'unknown'; }
  })();
  const base = process.env.APPDATA
    ? path.join(process.env.APPDATA, 'pi-desktop', WRAPPER_ROOT_NAME)
    : path.join(os.tmpdir(), `pi-desktop-${user}-${WRAPPER_ROOT_NAME}`);
  return base;
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  try { fs.chmodSync(dir, 0o700); } catch { /* ignore */ }
}

function writeFileAtomic(filePath: string, content: string): void {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, content, 'utf-8');
  try { fs.chmodSync(filePath, 0o600); } catch { /* ignore */ }
}

// ── zsh wrapper ──────────────────────────────────────────────────────

const ZSH_WRAPPER_DIR = 'zsh';

function getZshWrapperDir(): string {
  return path.join(getWrapperRoot(), ZSH_WRAPPER_DIR);
}

function generateZshZshenv(): string {
  return `# pi-desktop zsh shell-ready wrapper — .zshenv
# 加载用户原始 .zshenv，然后恢复 ZDOTDIR 指向 wrapper 目录

# 记录 wrapper 自身的 ZDOTDIR
_pi_orca_wrapper_zdotdir="\${ZDOTDIR:-}"

# 读取用户原始 ZDOTDIR（从环境变量或回退 HOME）
_pi_user_zdotdir="\${PI_ORIG_ZDOTDIR:-\${HOME:-}}"

# 防止嵌套目录循环
case "\${_pi_user_zdotdir}" in
  */${ZSH_WRAPPER_DIR}) _pi_user_zdotdir="\${HOME:-}" ;;
esac

# 源码用户 .zshenv
unset ZDOTDIR
if [[ -n "\${_pi_user_zdotdir}" && -f "\${_pi_user_zdotdir}/.zshenv" ]]; then
  source "\${_pi_user_zdotdir}/.zshenv"
fi

# 恢复 ZDOTDIR 指向 wrapper 目录，让后续 .zprofile/.zshrc/.zlogin 走 wrapper
export ZDOTDIR="\${_pi_orca_wrapper_zdotdir}"
unset _pi_orca_wrapper_zdotdir _pi_user_zdotdir
`;
}

function generateZshZprofile(): string {
  return `# pi-desktop zsh shell-ready wrapper — .zprofile
# 加载用户原始 .zprofile

_pi_user_zdotdir="\${PI_ORIG_ZDOTDIR:-\${HOME:-}}"
case "\${_pi_user_zdotdir}" in
  */${ZSH_WRAPPER_DIR}) _pi_user_zdotdir="\${HOME:-}" ;;
esac

if [[ -o interactive && -f "\${_pi_user_zdotdir}/.zprofile" ]]; then
  _pi_saved_zdotdir="\${ZDOTDIR:-}"
  export ZDOTDIR="\${_pi_user_zdotdir}"
  source "\${_pi_user_zdotdir}/.zprofile"
  export ZDOTDIR="\${_pi_saved_zdotdir}"
  unset _pi_saved_zdotdir
fi
unset _pi_user_zdotdir
`;
}

function generateZshZshrc(): string {
  return `# pi-desktop zsh shell-ready wrapper — .zshrc
# 加载用户原始 .zshrc，注册 shell-ready 标记发射器

_pi_user_zdotdir="\${PI_ORIG_ZDOTDIR:-\${HOME:-}}"
case "\${_pi_user_zdotdir}" in
  */${ZSH_WRAPPER_DIR}) _pi_user_zdotdir="\${HOME:-}" ;;
esac

# 源码用户 .zshrc
if [[ -f "\${_pi_user_zdotdir}/.zshrc" ]]; then
  _pi_saved_zdotdir="\${ZDOTDIR:-}"
  export ZDOTDIR="\${_pi_user_zdotdir}"
  source "\${_pi_user_zdotdir}/.zshrc"
  export ZDOTDIR="\${_pi_saved_zdotdir}"
  unset _pi_saved_zdotdir
fi

# 注册 shell-ready 标记发射器（zle-line-init 钩子）
# 在 prompt 显示前发射 OSC 777 标记
if [[ "\${PI_SHELL_READY_MARKER:-0}" == "1" ]]; then
  # 保存用户已有的 zle-line-init
  if (( \${+widgets[zle-line-init]} )) && [[ "\${widgets[zle-line-init]}" == user:* ]]; then
    _pi_prev_line_init="\${widgets[zle-line-init]#user:}"
  else
    _pi_prev_line_init=""
  fi

  _pi_prompt_mark() {
    printf '\\033]777;pi-desktop-shell-ready\\007'
    if [[ -n "\${_pi_prev_line_init:-}" ]]; then
      "\${_pi_prev_line_init}" "$@"
    fi
  }
  zle -N zle-line-init _pi_prompt_mark
fi

unset _pi_user_zdotdir _pi_prev_line_init
`;
}

function generateZshZlogin(): string {
  return `# pi-desktop zsh shell-ready wrapper — .zlogin
# 加载用户原始 .zlogin，然后恢复 ZDOTDIR

_pi_user_zdotdir="\${PI_ORIG_ZDOTDIR:-\${HOME:-}}"
case "\${_pi_user_zdotdir}" in
  */${ZSH_WRAPPER_DIR}) _pi_user_zdotdir="\${HOME:-}" ;;
esac

if [[ -o interactive && -f "\${_pi_user_zdotdir}/.zlogin" ]]; then
  _pi_saved_zdotdir="\${ZDOTDIR:-}"
  export ZDOTDIR="\${_pi_user_zdotdir}"
  source "\${_pi_user_zdotdir}/.zlogin"
  export ZDOTDIR="\${_pi_saved_zdotdir}"
  unset _pi_saved_zdotdir
fi

# 恢复 ZDOTDIR 为用户原始值
export ZDOTDIR="\${PI_ORIG_ZDOTDIR:-\${HOME:-}}"
unset _pi_user_zdotdir
`;
}

function ensureZshWrappers(): void {
  const dir = getZshWrapperDir();
  ensureDir(dir);
  writeFileAtomic(path.join(dir, '.zshenv'), generateZshZshenv());
  writeFileAtomic(path.join(dir, '.zprofile'), generateZshZprofile());
  writeFileAtomic(path.join(dir, '.zshrc'), generateZshZshrc());
  writeFileAtomic(path.join(dir, '.zlogin'), generateZshZlogin());
}

// ── bash wrapper ─────────────────────────────────────────────────────

const BASH_WRAPPER_DIR = 'bash';

function getBashWrapperDir(): string {
  return path.join(getWrapperRoot(), BASH_WRAPPER_DIR);
}

function generateBashRcfile(): string {
  return `# pi-desktop bash shell-ready wrapper — rcfile
# 加载用户正常的 bash 启动文件，然后发射 shell-ready 标记

# 源码系统 profile（仅 login shell）
[[ -f /etc/profile ]] && source /etc/profile

# 源码用户 profile
if [[ -f "$HOME/.bash_profile" ]]; then
  source "$HOME/.bash_profile"
elif [[ -f "$HOME/.bash_login" ]]; then
  source "$HOME/.bash_login"
elif [[ -f "$HOME/.profile" ]]; then
  source "$HOME/.profile"
fi

# 启用 bracketed paste（支持多层命令注入）
[[ $- == *i* ]] && bind 'set enable-bracketed-paste on' 2>/dev/null

# 注册 shell-ready 标记发射器（PROMPT_COMMAND）
if [[ "\${PI_SHELL_READY_MARKER:-0}" == "1" ]]; then
  _pi_shell_ready_mark() {
    # 只发射一次，避免每个 prompt 都发射
    if [[ -z "\${_pi_shell_ready_done:-}" ]]; then
      _pi_shell_ready_done=1
      printf '\\033]777;pi-desktop-shell-ready\\007'
    fi
  }
  # 追加到已有的 PROMPT_COMMAND
  if [[ -n "\${PROMPT_COMMAND:-}" ]]; then
    PROMPT_COMMAND="_pi_shell_ready_mark; \${PROMPT_COMMAND}"
  else
    PROMPT_COMMAND="_pi_shell_ready_mark"
  fi
fi
`;
}

function ensureBashWrappers(): void {
  const dir = getBashWrapperDir();
  ensureDir(dir);
  writeFileAtomic(path.join(dir, 'rcfile'), generateBashRcfile());
}

// ── PowerShell wrapper ───────────────────────────────────────────────

function generatePowerShellBootstrap(): string {
  return `# pi-desktop PowerShell shell-ready bootstrap
# 通过 -EncodedCommand 注入，在 profile 加载后执行
# 替换 prompt 函数，在首次 prompt 时发射 OSC 777 标记

# 设置 UTF-8 编码
try {
    [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
    [Console]::InputEncoding = [System.Text.UTF8Encoding]::new()
    $OutputEncoding = [Console]::OutputEncoding
} catch { Write-Error $_ -ErrorAction Continue }

# 保存原始 prompt 函数
$Global:__PiShellReadyState = @{
    OriginalPrompt = $function:prompt
    HasSeenPrompt = $false
    Esc = [char]27
    Bel = [char]7
}

function Global:prompt {
    $fakeExitCode = [int](!$global:?)
    $result = ""

    # 首次 prompt 发射 OSC 777 shell-ready 标记
    if (-not $Global:__PiShellReadyState.HasSeenPrompt) {
        $result += "$($Global:__PiShellReadyState.Esc)]777;pi-desktop-shell-ready$($Global:__PiShellReadyState.Bel)"
    }

    # 发射 OSC 133 序列（命令退出 + prompt 开始）
    if ($Global:__PiShellReadyState.HasSeenPrompt) {
        $result += "$($Global:__PiShellReadyState.Esc)]133;D;$fakeExitCode$($Global:__PiShellReadyState.Bel)"
    }
    $Global:__PiShellReadyState.HasSeenPrompt = $true
    $result += "$($Global:__PiShellReadyState.Esc)]133;A$($Global:__PiShellReadyState.Bel)"

    # 调用原始 prompt
    if ($fakeExitCode -ne 0) { Write-Error "failure" -ea ignore }
    $result += $Global:__PiShellReadyState.OriginalPrompt.Invoke()
    $result += "$($Global:__PiShellReadyState.Esc)]133;B$($Global:__PiShellReadyState.Bel)"
    $result
}
`;
}

// ── Git Bash (Windows) wrapper ───────────────────────────────────────

function generateGitBashRcfile(): string {
  // Git Bash 本质是 bash，但需要额外 chcp 65001 切换 UTF-8
  return `# pi-desktop Git Bash shell-ready wrapper — rcfile
# 切换 UTF-8 编码，然后加载用户正常配置

chcp.com 65001 >/dev/null 2>&1

# 源码系统 profile
[[ -f /etc/profile ]] && source /etc/profile

# 源码用户 profile
if [[ -f "$HOME/.bash_profile" ]]; then
  source "$HOME/.bash_profile"
elif [[ -f "$HOME/.bash_login" ]]; then
  source "$HOME/.bash_login"
elif [[ -f "$HOME/.profile" ]]; then
  source "$HOME/.profile"
fi

# 启用 bracketed paste
[[ $- == *i* ]] && bind 'set enable-bracketed-paste on' 2>/dev/null

# 注册 shell-ready 标记
if [[ "\${PI_SHELL_READY_MARKER:-0}" == "1" ]]; then
  _pi_shell_ready_mark() {
    if [[ -z "\${_pi_shell_ready_done:-}" ]]; then
      _pi_shell_ready_done=1
      printf '\\033]777;pi-desktop-shell-ready\\007'
    fi
  }
  if [[ -n "\${PROMPT_COMMAND:-}" ]]; then
    PROMPT_COMMAND="_pi_shell_ready_mark; \${PROMPT_COMMAND}"
  else
    PROMPT_COMMAND="_pi_shell_ready_mark"
  fi
fi
`;
}

function ensureGitBashWrappers(): void {
  const dir = getBashWrapperDir();
  ensureDir(dir);
  writeFileAtomic(path.join(dir, 'git-bash-rcfile'), generateGitBashRcfile());
}

// =========================================================================
// Shell 类型检测
// =========================================================================

type ShellKind = 'zsh' | 'bash' | 'pwsh' | 'powershell' | 'fish' | 'cmd' | 'git-bash' | 'unknown';

function detectShellKind(shellPath: string): ShellKind {
  const name = path.basename(shellPath).toLowerCase().replace(/\.exe$/, '');
  switch (name) {
    case 'zsh': return 'zsh';
    case 'bash': return 'bash';
    case 'pwsh': return 'pwsh';
    case 'powershell': return 'powershell';
    case 'fish': return 'fish';
    case 'cmd': return 'cmd';
    default: return 'unknown';
  }
}

function isGitBash(shellPath: string): boolean {
  const lower = shellPath.toLowerCase();
  return lower.includes('git') && lower.includes('bash');
}

// =========================================================================
// Shell-ready launch config（对外核心接口）
// =========================================================================

export interface ShellReadyLaunchConfig {
  /** 改写后的 shell 启动参数 */
  shellArgs: string[];
  /** 需混入环境变量的额外键值 */
  envMixin: NodeJS.ProcessEnv;
  /** 是否支持 shell-ready 标记检测 */
  supportsReadyMarker: boolean;
  /** 是否支持 bracketed paste */
  bracketedPasteSafe: boolean;
}

/**
 * 为给定 shell profile 计算 shell-ready launch config。
 * 返回改写后的 shell args 和 env，供 spawn 时使用。
 */
export function getShellReadyLaunchConfig(profile: TerminalProfile): ShellReadyLaunchConfig {
  const shellKind = isGitBash(profile.path) ? 'git-bash' : detectShellKind(profile.path);
  const envMixin: NodeJS.ProcessEnv = {
    PI_DESKTOP: '1',
    PI_SHELL_READY_MARKER: '1',
  };

  switch (shellKind) {
    case 'zsh': {
      ensureZshWrappers();
      // 记住用户原始 ZDOTDIR，wrapper 脚本据此回退
      envMixin['PI_ORIG_ZDOTDIR'] = process.env.ZDOTDIR || os.homedir();
      envMixin['ZDOTDIR'] = getZshWrapperDir();
      return {
        shellArgs: ['-i'], // 交互模式
        envMixin,
        supportsReadyMarker: true,
        bracketedPasteSafe: true,
      };
    }

    case 'bash': {
      ensureBashWrappers();
      return {
        shellArgs: ['--rcfile', path.join(getBashWrapperDir(), 'rcfile')],
        envMixin,
        supportsReadyMarker: true,
        bracketedPasteSafe: true,
      };
    }

    case 'git-bash': {
      ensureGitBashWrappers();
      return {
        shellArgs: ['--rcfile', path.join(getBashWrapperDir(), 'git-bash-rcfile'), '--login', '-i'],
        envMixin,
        supportsReadyMarker: true,
        bracketedPasteSafe: true,
      };
    }

    case 'pwsh':
    case 'powershell': {
      const bootstrap = generatePowerShellBootstrap();
      // 用 base64 编码传给 -EncodedCommand
      const base64 = Buffer.from(bootstrap, 'utf-16le').toString('base64');
      return {
        shellArgs: ['-NoLogo', '-NoExit', '-EncodedCommand', base64],
        envMixin,
        // PowerShell 的 -EncodedCommand 在 profile 之后执行，
        // 但 prompt 替换是可靠的，无需标记检测，用超时兜底即可
        supportsReadyMarker: false,
        bracketedPasteSafe: false,
      };
    }

    case 'fish': {
      // fish 不支持 wrapper 注入，直接用超时
      return {
        shellArgs: profile.args.length > 0 ? profile.args : ['-i'],
        envMixin,
        supportsReadyMarker: false,
        bracketedPasteSafe: false,
      };
    }

    case 'cmd':
    default: {
      return {
        shellArgs: profile.args.length > 0 ? profile.args : [],
        envMixin,
        supportsReadyMarker: false,
        bracketedPasteSafe: false,
      };
    }
  }
}