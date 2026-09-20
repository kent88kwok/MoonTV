/* eslint-disable no-console */

'use client';

const CURRENT_VERSION = '20250804231933';

// 版本检查结果枚举
export enum UpdateStatus {
  HAS_UPDATE = 'has_update', // 有新版本
  NO_UPDATE = 'no_update', // 无新版本
  FETCH_FAILED = 'fetch_failed', // 获取失败
}

// 远程版本检查URL配置
// 【修复 + 性能】原配置为 ghfast.top 镜像 + senshinya/MoonTV，实测两者均已 404
// （镜像失效、上游仓库改名），导致版本检查从未成功过，且每次都要白发请求。
// 现改为：主要 = fork 上游 samqin123/MoonTV（用于判断上游是否发布新版），
//         备用 = 自己的 fork kent88kwok/MoonTV（实测 200，响应最快）。
const VERSION_CHECK_URLS = [
  'https://raw.githubusercontent.com/samqin123/MoonTV/main/VERSION.txt',
  'https://raw.githubusercontent.com/kent88kwok/MoonTV/main/VERSION.txt',
];

// 【性能】PageLayout 会同时挂载两个 UserMenu（移动端头部一个、桌面端一个），
// 两者都在挂载时调用 checkForUpdates，原本每页要发 4 个请求、最坏挂起 10 秒。
// 这里用「模块级单例 + 结果记忆」去重：并发调用复用同一个请求，
// 拿到确定结果后在同一会话内直接复用，不再重复请求。
let versionCheckInFlight: Promise<UpdateStatus> | null = null;
let versionCheckResult: UpdateStatus | null = null;

/**
 * 检查是否有新版本可用。
 * 并发调用会复用同一个请求；拿到确定结果后直接返回缓存，不重复请求。
 * @returns Promise<UpdateStatus> - 返回版本检查状态
 */
export function checkForUpdates(): Promise<UpdateStatus> {
  // 已有确定结果，直接复用
  if (versionCheckResult !== null) {
    return Promise.resolve(versionCheckResult);
  }

  // 已有请求在飞，复用它
  if (versionCheckInFlight) {
    return versionCheckInFlight;
  }

  versionCheckInFlight = doCheckForUpdates()
    .then((status) => {
      // 只记忆确定结果；「获取失败」不缓存，便于下次重试
      if (status !== UpdateStatus.FETCH_FAILED) {
        versionCheckResult = status;
      }
      return status;
    })
    .finally(() => {
      versionCheckInFlight = null;
    });

  return versionCheckInFlight;
}

async function doCheckForUpdates(): Promise<UpdateStatus> {
  try {
    // 尝试从主要URL获取版本信息
    const primaryVersion = await fetchVersionFromUrl(VERSION_CHECK_URLS[0]);
    if (primaryVersion) {
      return compareVersions(primaryVersion);
    }

    // 如果主要URL失败，尝试备用URL
    const backupVersion = await fetchVersionFromUrl(VERSION_CHECK_URLS[1]);
    if (backupVersion) {
      return compareVersions(backupVersion);
    }

    // 如果两个URL都失败，返回获取失败状态
    return UpdateStatus.FETCH_FAILED;
  } catch (error) {
    console.error('版本检查失败:', error);
    return UpdateStatus.FETCH_FAILED;
  }
}

/**
 * 从指定URL获取版本信息
 * @param url - 版本信息URL
 * @returns Promise<string | null> - 版本字符串或null
 */
async function fetchVersionFromUrl(url: string): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 2500); // 2.5秒超时（版本检查不该拖慢页面）

    const response = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      headers: {
        'Content-Type': 'text/plain',
      },
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const version = await response.text();
    return version.trim();
  } catch (error) {
    console.warn(`从 ${url} 获取版本信息失败:`, error);
    return null;
  }
}

/**
 * 比较版本号
 * @param remoteVersion - 远程版本号
 * @returns UpdateStatus - 返回版本比较结果
 */
function compareVersions(remoteVersion: string): UpdateStatus {
  try {
    // 将版本号转换为数字进行比较
    const current = parseInt(CURRENT_VERSION, 10);
    const remote = parseInt(remoteVersion, 10);

    return remote > current ? UpdateStatus.HAS_UPDATE : UpdateStatus.NO_UPDATE;
  } catch (error) {
    console.error('版本比较失败:', error);
    return UpdateStatus.FETCH_FAILED;
  }
}

// 导出当前版本号供其他地方使用
export { CURRENT_VERSION };
