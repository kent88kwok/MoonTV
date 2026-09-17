// 豆瓣接口的边缘缓存工具
//
// 背景：MoonTV 全站有登录墙，所有 /api/* 请求都带 Cookie，而 Cloudflare 不会缓存
// 带 Cookie 的响应 —— 所以路由里设置的 `s-maxage` 实际不生效，每次打开首页都会
// 重新回源豆瓣（首页一次并发 3 个分类）。豆瓣对 Cloudflare 边缘出口存在偶发限速，
// 单次请求有时 6 秒内不返回，路由因此返回 500，首页整块豆瓣区就变空。
//
// 这里用 Cache API 手动做两级缓存（与用户无关的公共数据）：
//   fresh —— 新鲜缓存，TTL 取站点配置的 cache_time，命中直接返回，不回源
//   stale —— 24 小时的陈旧缓存，仅在回源失败时兜底：宁可给旧数据，也不要空白
//
// 所有缓存操作都做了容错：运行时不支持 Cache API 时自动跳过，不影响主流程。

const STALE_TTL_SECONDS = 24 * 60 * 60;

interface EdgeCacheLike {
  match: (key: string) => Promise<Response | undefined>;
  put: (key: string, response: Response) => Promise<void>;
}

function getEdgeCache(): EdgeCacheLike | null {
  try {
    const cachesAny = (
      globalThis as unknown as { caches?: { default?: EdgeCacheLike } }
    ).caches;
    return cachesAny && cachesAny.default ? cachesAny.default : null;
  } catch {
    return null;
  }
}

/** 缓存键：同一份请求 URL 共用一份数据（豆瓣数据与用户无关） */
export function doubanCacheKey(requestUrl: string, stale = false): string {
  return `https://douban-cache.moontv.internal/${
    stale ? 'stale' : 'fresh'
  }/${encodeURIComponent(requestUrl)}`;
}

export async function readDoubanCache(key: string): Promise<string | null> {
  const cache = getEdgeCache();
  if (!cache) return null;
  try {
    const hit = await cache.match(key);
    if (!hit) return null;
    return await hit.text();
  } catch {
    return null;
  }
}

export async function writeDoubanCache(
  key: string,
  body: string,
  ttlSeconds: number
): Promise<void> {
  if (ttlSeconds <= 0) return;
  const cache = getEdgeCache();
  if (!cache) return;
  try {
    await cache.put(
      key,
      new Response(body, {
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': `public, max-age=${ttlSeconds}`,
        },
      })
    );
  } catch {
    // 缓存写入失败不影响正常返回
  }
}

export { STALE_TTL_SECONDS };
