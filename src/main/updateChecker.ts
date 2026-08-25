/**
 * GitHub Release 版本检查模块
 *
 * 通过 GitHub Releases 页面的 HTTP 重定向获取最新版本号，
 * 不依赖 GitHub API，避免 60 次/小时的未认证速率限制。
 * 检查到新版本时仅提供 release 页面 URL，由用户自行前往下载安装包。
 * 所有网络错误/解析失败均优雅降级。
 */

import { version as appVersion } from '../../package.json';

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
}

// ============================================================================
// 内部状态
// ============================================================================

/** 缓存的上次检查结果 */
let cachedResult: UpdateInfo | null = null;

/** 上次检查的时间戳 */
let cachedAt = 0;

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
 * Location 头形如 /lazyst/pi-workbench/releases/tag/v0.4.2，从中提取 tag。
 * GitHub 页面/CDN 服务没有 API 的 60 次/小时速率限制，且不需要任何认证。
 *
 * @param force 为 true 时绕过缓存，强制发起网络请求。
 *
 * 缓存有效期内返回缓存结果，不发起网络请求。
 */
export async function checkForUpdate(force = false): Promise<UpdateInfo> {
  // 缓存有效且非强制 → 直接返回
  const now = Date.now();
  if (!force && cachedResult && now - cachedAt < CACHE_TTL_MS) {
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

    cachedResult = {
      currentVersion: appVersion,
      latestVersion,
      hasUpdate,
      releaseUrl,
      releaseName: latestVersion,
      releaseBody: null,
      checkedAt: new Date().toISOString(),
      error: null,
    };
    cachedAt = now;
    return cachedResult;
  } catch (err) {
    const error = err instanceof Error
      ? (err.name === 'AbortError' ? '请求超时，请检查网络连接' : err.message)
      : '未知错误';
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