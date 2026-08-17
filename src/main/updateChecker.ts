/**
 * GitHub Release 版本检查与下载模块
 *
 * 通过 GitHub Releases 页面的 HTTP 重定向获取最新版本号，
 * 不依赖 GitHub API，避免 60 次/小时的未认证速率限制。
 * 安装包下载 URL 直接按模式构造，无需 API 返回的资产列表。
 * 所有网络错误/解析失败均优雅降级。
 */

import { version as appVersion } from '../../package.json';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawn } from 'node:child_process';

// ============================================================================
// 常量
// ============================================================================

/** GitHub 仓库 owner/name */
const REPO = 'lazyst/pi-workbench';

/**
 * GitHub Releases 最新版重定向 URL（不依赖 API）。
 * 请求此地址会返回 302 → Location: /repos/{REPO}/releases/tag/vX.Y.Z
 * 从 Location 中提取 tag 即可获知最新版本号。
 * GitHub 的页面/CDN 服务没有 API 的 60 次/小时速率限制。
 */
const RELEASE_URL = `https://github.com/${REPO}/releases/latest`;

/** 请求超时（毫秒） */
const FETCH_TIMEOUT_MS = 10_000;

/** 缓存有效期（毫秒），5 分钟内不重复请求 */
const CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * 从版本号 tag 构造安装包下载 URL（不依赖 GitHub API）。
 * 例如：v0.4.2 → https://github.com/lazyst/pi-workbench/releases/download/v0.4.2/pi-workbench%20Setup%200.4.2.exe
 */
function buildDownloadUrl(tag: string): string {
  const base = `https://github.com/${REPO}/releases/download/${tag}`;
  // 去掉 v 前缀用于文件名
  const ver = tag.replace(/^v/i, '');
  const fileName = `pi-workbench%20Setup%20${ver}.exe`;
  return `${base}/${fileName}`;
}

// ============================================================================
// 类型定义
// ============================================================================

export interface UpdateInfo {
  /** 当前版本号（package.json） */
  currentVersion: string;
  /** 最新 release 版本号（tag，如 v0.3.0），检查失败时为 null */
  latestVersion: string | null;
  /** 是否有可用更新 */
  hasUpdate: boolean;
  /** 最新 release 的 GitHub 页面 URL */
  releaseUrl: string | null;
  /** 最新 release 的标题 */
  releaseName: string | null;
  /** 最新 release 的正文（截取前 500 字符） */
  releaseBody: string | null;
  /** 检查时间（ISO 字符串） */
  checkedAt: string | null;
  /** 错误信息（检查失败时） */
  error: string | null;
  /** 可用资产列表（安装包等） */
  assets: ReleaseAsset[];
}

export interface ReleaseAsset {
  /** 文件名 */
  name: string;
  /** 下载 URL */
  url: string;
  /** 文件大小（字节） */
  size: number;
}

export interface DownloadProgress {
  status: 'downloading' | 'completed' | 'error' | 'cancelled';
  percent: number;
  downloadedBytes: number;
  totalBytes: number;
  filePath?: string;
  error?: string;
}

// ============================================================================
// 内部状态
// ============================================================================

/** 缓存的上次检查结果 */
let cachedResult: UpdateInfo | null = null;

/** 上次检查的时间戳 */
let cachedAt = 0;

/** 当前正在进行的下载的 AbortController */
let currentDownloadAbort: AbortController | null = null;

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 比较两个语义化版本号。
 * 支持 "v" 前缀（如 "v0.3.0"），支持 "0.3.0" 格式。
 * 返回正数表示 a > b，负数表示 a < b，0 表示相等。
 */
function compareVersions(a: string, b: string): number {
  const clean = (v: string) => v.replace(/^v/i, '').split('.').map(Number);
  const pa = clean(a);
  const pb = clean(b);

  for (let i = 0; i < 3; i++) {
    const na = pa[i] ?? 0;
    const nb = pb[i] ?? 0;
    if (na !== nb) return na - nb;
  }
  return 0;
}

/**
 * 将未知错误转为可展示的中文消息：AbortError 映射为特定提示，
 * 其余 Error 展示其 message，非 Error 用兜底文案。
 */
function formatError(err: unknown, abortMessage: string, fallback: string): string {
  if (err instanceof Error) {
    if (err.name === 'AbortError') return abortMessage;
    return err.message;
  }
  return fallback;
}

/**
 * 筛选当前平台匹配的安装包资产。
 * Windows: 匹配 .exe（不含 .exe.blockmap）
 * macOS: 匹配 .dmg
 * Linux: 匹配 .AppImage
 */
function filterAssets(assets: ReleaseAsset[]): ReleaseAsset[] {
  if (process.platform === 'win32') {
    return assets.filter(
      (a) => a.name.endsWith('.exe') && !a.name.endsWith('.blockmap'),
    );
  }
  if (process.platform === 'darwin') {
    return assets.filter((a) => a.name.endsWith('.dmg'));
  }
  if (process.platform === 'linux') {
    return assets.filter((a) => a.name.endsWith('.AppImage'));
  }
  return [];
}

// ============================================================================
// 公开 API
// ============================================================================

/**
 * 获取当前版本号（package.json 中的 version 字段）。
 */
export function getCurrentVersion(): string {
  return appVersion;
}

/**
 * 通过 GitHub Releases 重定向检查最新版本（不依赖 GitHub API）。
 *
 * 原理：请求 https://github.com/{REPO}/releases/latest 会返回 302 重定向，
 * Location 头形如 /lazyst/pi-desktop/releases/tag/v0.4.2，从中提取 tag。
 * GitHub 页面/CDN 服务没有 API 的 60 次/小时速率限制，且不需要任何认证。
 *
 * 缓存有效期内返回缓存结果，不发起网络请求。
 */
export async function checkForUpdate(): Promise<UpdateInfo> {
  // 缓存有效 → 直接返回
  const now = Date.now();
  if (cachedResult && now - cachedAt < CACHE_TTL_MS) {
    return cachedResult;
  }

  // 构建默认失败结果
  const failed = (error: string): UpdateInfo => ({
    currentVersion: appVersion,
    latestVersion: null,
    hasUpdate: false,
    releaseUrl: null,
    releaseName: null,
    releaseBody: null,
    checkedAt: new Date().toISOString(),
    error,
    assets: [],
  });

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    // 不跟随重定向，手动读取 Location 头以提取 tag
    const response = await fetch(RELEASE_URL, {
      redirect: 'manual',
      signal: controller.signal,
    });

    clearTimeout(timer);

    // 从重定向 Location 中提取版本号
    // Location 形如: /lazyst/pi-workbench/releases/tag/v0.4.2
    const location = response.headers.get('location') || '';
    const tagMatch = location.match(/\/tag\/(.+)$/);
    const latestVersion = tagMatch ? tagMatch[1] : null;

    if (!latestVersion) {
      const error = `无法从重定向中解析最新版本号 (status=${response.status})`;
      cachedResult = failed(error);
      cachedAt = now;
      return cachedResult;
    }

    const releaseUrl = `https://github.com/${REPO}/releases/tag/${latestVersion}`;
    const hasUpdate = compareVersions(latestVersion, appVersion) > 0;

    // 构造安装包资产信息（不依赖 API，直接按模式构造）
    const downloadUrl = buildDownloadUrl(latestVersion);
    const assetName = `pi-workbench Setup ${latestVersion.replace(/^v/i, '')}.exe`;
    const rawAssets: ReleaseAsset[] = [
      { name: assetName, url: downloadUrl, size: 0 },
    ];

    cachedResult = {
      currentVersion: appVersion,
      latestVersion,
      hasUpdate,
      releaseUrl,
      releaseName: latestVersion,
      releaseBody: null,
      checkedAt: new Date().toISOString(),
      error: null,
      assets: rawAssets,
    };
    cachedAt = now;
    return cachedResult;
  } catch (err) {
    const error = formatError(err, '请求超时，请检查网络连接', '未知错误');
    cachedResult = failed(error);
    cachedAt = now;
    return cachedResult;
  }
}

/**
 * 获取缓存的检查结果（不发起网络请求）。
 * 如果从未检查过，返回 null。
 */
export function getUpdateStatus(): UpdateInfo | null {
  return cachedResult;
}

/**
 * 下载最新 release 的安装包。
 *
 * @param onProgress 进度回调，会收到下载进度 / 完成 / 错误事件
 * @returns 下载到本地的文件路径
 */
export async function downloadUpdate(
  onProgress: (progress: DownloadProgress) => void,
): Promise<string> {
  // 1. 获取 release 信息（优先缓存）
  const info = cachedResult ?? (await checkForUpdate());
  if (!info.latestVersion) {
    throw new Error('暂无版本信息，请先检查更新');
  }

  // 2. 筛选当前平台的安装包
  // 优先从 info.assets 中匹配，匹配不到时按模式构造下载 URL
  let matched = filterAssets(info.assets);
  if (matched.length === 0 && info.latestVersion) {
    // 资产列表为空（非 API 模式）或没有匹配项，直接构造 URL
    const url = buildDownloadUrl(info.latestVersion);
    const name = `pi-workbench Setup ${info.latestVersion.replace(/^v/i, '')}.exe`;
    matched = [{ name, url, size: 0 }];
  }

  if (matched.length === 0) {
    throw new Error(
      `未找到适用于 ${process.platform} 平台的安装包`,
    );
  }

  // 取第一个匹配项（通常只有一个）
  const asset = matched[0];

  // 3. 准备下载
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-workbench-update-'));
  const localPath = path.join(tempDir, asset.name);

  const abortController = new AbortController();
  currentDownloadAbort = abortController;

  try {
    const response = await fetch(asset.url, {
      headers: {
        Accept:
          'application/octet-stream, application/vnd.github.v3.raw;q=0.9',
        'User-Agent': 'pi-workbench',
      },
      signal: abortController.signal,
      // 不跟随重定向，手动处理以获取 Content-Disposition 等响应头
      redirect: 'follow',
    });

    if (!response.ok) {
      throw new Error(
        `下载失败，服务器返回 ${response.status} ${response.statusText}`,
      );
    }

    const totalBytes =
      Number(response.headers.get('content-length')) || asset.size || 0;
    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('无法读取响应数据流');
    }

    const writeStream = fs.createWriteStream(localPath);
    let downloadedBytes = 0;

    // 逐块读取并写入文件
    const pump = async () => {
      while (true) {
        const { done, value } = await reader!.read();
        if (done) break;

        writeStream.write(Buffer.from(value));
        downloadedBytes += value.length;

        const percent = totalBytes > 0
          ? Math.round((downloadedBytes / totalBytes) * 100)
          : 0;

        onProgress({
          status: 'downloading',
          percent: Math.min(percent, 99),
          downloadedBytes,
          totalBytes,
        });
      }
    };

    await pump();
    writeStream.end();

    // 等待写入完成
    await new Promise<void>((resolve, reject) => {
      writeStream.on('finish', resolve);
      writeStream.on('error', reject);
    });

    // 下载完成
    onProgress({
      status: 'completed',
      percent: 100,
      downloadedBytes,
      totalBytes,
      filePath: localPath,
    });

    currentDownloadAbort = null;
    return localPath;
  } catch (err) {
    currentDownloadAbort = null;
    // 清理临时文件
    try {
      if (fs.existsSync(localPath)) fs.unlinkSync(localPath);
      if (fs.existsSync(tempDir)) fs.rmdirSync(tempDir);
    } catch { /* 忽略清理错误 */ }

    const error = formatError(err, '下载已取消', '下载失败');

    onProgress({
      status: 'error',
      percent: 0,
      downloadedBytes: 0,
      totalBytes: 0,
      error,
    });
    throw new Error(error);
  }
}

/**
 * 取消当前正在进行的下载。
 */
export function cancelDownload(): void {
  if (currentDownloadAbort) {
    currentDownloadAbort.abort();
    currentDownloadAbort = null;
  }
}

/**
 * 运行已下载的安装包。
 * 在 Windows 上启动 installer，然后退出应用以便安装程序覆盖文件。
 */
export function installUpdate(filePath: string): void {
  if (!fs.existsSync(filePath)) {
    throw new Error(`安装包不存在: ${filePath}`);
  }

  if (process.platform === 'win32') {
    // Windows: 使用 `start` 命令正确启动 GUI 安装程序（与 openUrlInExternal 一致），
    // 避免 execFile + detached 模式下 GUI 窗口不显示的问题。
    // `cmd.exe /c start "" "installer.exe"` 是 Windows 上启动 GUI 应用的标准方式。
    spawn('cmd.exe', ['/c', 'start', '', filePath], {
      detached: true,
      stdio: 'ignore',
    }).unref();
  } else if (process.platform === 'darwin') {
    // macOS: 使用 `open` 命令打开 dmg 或 zip
    spawn('open', [filePath], {
      detached: true,
      stdio: 'ignore',
    }).unref();
  } else {
    // Linux: 执行 AppImage
    fs.chmodSync(filePath, 0o755);
    spawn(filePath, [], {
      detached: true,
      stdio: 'ignore',
    }).unref();
  }
}