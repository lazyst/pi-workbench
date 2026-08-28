// 集成终端的 Shell Integration 注入——对齐 VS Code
// src/vs/platform/terminal/node/terminalEnvironment.ts 的 getShellIntegrationInjection。
//
// 作用：在启动真实用户 shell（bash / pwsh / fish / zsh）时，把 VS Code 的
// shellIntegration 脚本注入进去，使 shell 在 prompt / 命令执行 / 输出结束时主动发出
// OSC 633 系序列（A=prompt 开始 / B=命令输入开始 / C=命令执行完=输出开始 /
// D=输出结束）。渲染端 XtermTerminal._segmentByShellIntegration 据此做命令级分段写入，
// 消除流式输出的中间帧闪烁，并为未来命令/目录/标记级能力预留语义边界。
//
// 与 VS Code 原版的差异（仅适配，不改语义）：
//  - VS Code 在 PtyHost 上下文里用 FileAccess.asFileUri('').fsPath 定位脚本；
//    本项目主进程用 __dirname 相对本文件定位（脚本随 src/main/shell-integration/* 打包进 out/main）。
//  - VS Code 完整处理 environmentVariableCollections / a11y / Windows build 判定；
//    本项目只保留差分渲染必需的 nonce + injection 标记 + TERM_PROGRAM，其余裁剪。
//  - VS Code 把脚本拷到临时目录再让 shell 加载；本项目同样拷到 os.tmpdir() 下的
//    稳定子目录（带 sticky bit 防其他用户读），避免 dev/build 路径差异。
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface IShellIntegrationInjection {
  /** 改写后的 shell 启动参数（注入脚本加载指令）。 */
  newArgs: string[];
  /** 需混入 PTY 环境变量的额外键值。 */
  envMixin: NodeJS.ProcessEnv;
  /** 需从打包目录拷到临时目录的脚本（source 为相对本文件的打包内路径）。 */
  filesToCopy: { source: string; dest: string }[];
}

// 脚本查找路径（兼容多种运行场景）：
//   - vitest:     __dirname = src/main/shell-integration/（脚本在同一目录）
//   - 打包后      __dirname = out/main/，且 copy-assets.mjs 已执行（脚本在 out/main/）
//   - dev 模式    __dirname = out/main/，但 copy-assets.mjs 可能被 clean 掉 → 回退源码树
// 对齐 index.ts 中 resolveTrayIcon 的 fallback 模式。
const SCRIPTS_DIR = (() => {
  if (fs.existsSync(path.join(__dirname, 'shellIntegration.ps1'))) {
    return __dirname;
  }
  // dev 模式回退：out/main/ 向上两级到项目根，进 src/main/shell-integration/
  const src = path.resolve(__dirname, '..', '..', 'src', 'main', 'shell-integration');
  if (fs.existsSync(path.join(src, 'shellIntegration.ps1'))) {
    return src;
  }
  return __dirname;
})();

/** 注入后脚本统一落地到临时目录下，带 sticky bit 防其他用户读取。 */
function integrationTmpDir(shell: string): string {
  const user = (() => {
    try {
      return os.userInfo().username;
    } catch {
      return 'unknown';
    }
  })();
  const base = process.env.APPDATA
    ? path.join(process.env.APPDATA, 'pi-workbench', 'shell-integration')
    : path.join(os.tmpdir(), `pi-workbench-${user}-shell-integration`);
  return path.join(base, shell);
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  // 限定仅 owner 可读写执行，避免同机其他用户读到可能含路径的脚本。
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    /* 某些平台 chmod 失败可忽略 */
  }
}

function copyScript(relName: string, dest: string): void {
  const src = path.join(SCRIPTS_DIR, relName);
  ensureDir(path.dirname(dest));
  fs.copyFileSync(src, dest);
  try {
    fs.chmodSync(dest, 0o600);
  } catch {
    /* 忽略 */
  }
}

/**
 * 为给定 shell 计算 shell integration 注入方案。返回 undefined 表示该 shell 不支持。
 * @param shellPath shell 可执行文件绝对路径（用 basename 判定类型）
 * @param originalArgs 用户/ profile 传入的原始 args
 */
export function getShellIntegrationInjection(
  shellPath: string,
  originalArgs: string[],
): IShellIntegrationInjection | undefined {
  const shell = path.basename(shellPath).toLowerCase();
  const nonce = crypto.randomUUID();
  const envMixin: NodeJS.ProcessEnv = {
    // VS Code 脚本靠此标记判定"是被注入而非手动安装"，从而加载用户 rc/profile。
    VSCODE_INJECTION: '1',
    // 脚本内部把它从环境移除前暂存，用于 OSC 633 的 nonce 校验。
    VSCODE_NONCE: nonce,
    // fish 脚本头部 `string match --quiet "$TERM_PROGRAM" "vscode"` 依赖此标记激活；
    // 集成终端默认不声明 TERM_PROGRAM（那是给 pi-tui 看的），此处仅对集成终端补上，
    // 使 VS Code 系脚本原样可用（bash 脚本靠 VSCODE_INJECTION，fish 靠 TERM_PROGRAM）。
    TERM_PROGRAM: 'vscode',
  };

  // Windows
  if (process.platform === 'win32') {
    if (shell === 'pwsh.exe' || shell === 'powershell.exe') {
      const dir = integrationTmpDir('pwsh');
      const dest = path.join(dir, 'shellIntegration.ps1');
      copyScript('shellIntegration.ps1', dest);
      // 对齐 VS Code：powershell -noexit -command ". <脚本>"
      const newArgs = [
        '-noexit',
        '-command',
        `. "${dest.replace(/"/g, '`"')}"`,
      ];
      return { newArgs, envMixin, filesToCopy: [] };
    }
    // Windows 上的 bash.exe / git-bash 走 bash 分支（下方 Unix 逻辑通用）。
  }

  // Unix & Windows 的 bash.exe
  switch (shell) {
    case 'bash':
    case 'bash.exe': {
      const dir = integrationTmpDir('bash');
      const dest = path.join(dir, 'shellIntegration-bash.sh');
      copyScript('shellIntegration-bash.sh', dest);
      // 对齐 VS Code：bash --init-file <脚本>（保留用户原始 -i/-l 等意图由脚本内部处理）
      const newArgs = ['--init-file', dest];
      return { newArgs, envMixin, filesToCopy: [] };
    }
    case 'fish': {
      const dir = integrationTmpDir('fish');
      const dest = path.join(dir, 'shellIntegration.fish');
      copyScript('shellIntegration.fish', dest);
      const newArgs = ['--init-command', `source "${dest}"`];
      return { newArgs, envMixin, filesToCopy: [] };
    }
    case 'pwsh': {
      const dir = integrationTmpDir('pwsh');
      const dest = path.join(dir, 'shellIntegration.ps1');
      copyScript('shellIntegration.ps1', dest);
      const newArgs = ['-noexit', '-command', `. "${dest.replace(/"/g, '`"')}"`];
      return { newArgs, envMixin, filesToCopy: [] };
    }
    case 'zsh': {
      // zsh 需要把 .zshrc 等挪到 ZDOTDIR 指向的临时目录，用注入脚本接管。
      const dir = integrationTmpDir('zsh');
      ensureDir(dir);
      const filesToCopy = [
        { source: path.join(dir, '.zshrc'), dest: path.join(dir, '.zshrc') },
        { source: path.join(dir, '.zprofile'), dest: path.join(dir, '.zprofile') },
        { source: path.join(dir, '.zshenv'), dest: path.join(dir, '.zshenv') },
        { source: path.join(dir, '.zlogin'), dest: path.join(dir, '.zlogin') },
      ];
      // 实际源是打包内脚本，dest 是临时目录；拷贝在下方统一做。
      copyScript('shellIntegration-rc.zsh', path.join(dir, '.zshrc'));
      copyScript('shellIntegration-profile.zsh', path.join(dir, '.zprofile'));
      copyScript('shellIntegration-env.zsh', path.join(dir, '.zshenv'));
      copyScript('shellIntegration-login.zsh', path.join(dir, '.zlogin'));
      const newArgs = ['-i'];
      envMixin['ZDOTDIR'] = dir;
      // 记住用户真实 home，脚本据此回退加载用户原有配置。
      envMixin['USER_ZDOTDIR'] = os.homedir();
      return { newArgs, envMixin, filesToCopy: [] };
    }
    default:
      return undefined;
  }
}
