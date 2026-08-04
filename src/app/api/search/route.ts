import { NextResponse } from 'next/server';

import { getCacheTime, getConfig } from '@/lib/config';
import { searchFromApi } from '@/lib/downstream';
import { yellowWords } from '@/lib/yellow';

export const runtime = 'edge';

// Cloudflare Workers 每请求最多 6 个并发出向连接（Free / Paid 相同）。
// 一次性并发全部站点会让多余的站点排在 CF 的 pending 队列里，被慢/死站挡住。
// 这里把在飞数限制在 6，配合下游的「按源缓存」让热查询直接短路。
const MAX_CONCURRENCY = 6;

// 单站兜底超时：借鉴 LunaTV，单个站点最多阻塞这么久；超时后会被缓存为
// timeout，后续 10 分钟内不再重试该站该页，绝不会拖垮整个搜索。
const PER_SITE_TIMEOUT_MS = 20000;

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker)
  );
  return results;
}

function cacheHeaders(cacheTime: number): Record<string, string> {
  return {
    'Cache-Control': `public, max-age=${cacheTime}, s-maxage=${cacheTime}`,
    'CDN-Cache-Control': `public, s-maxage=${cacheTime}`,
    'Vercel-CDN-Cache-Control': `public, s-maxage=${cacheTime}`,
  };
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const query = searchParams.get('q');

  const cacheTime = await getCacheTime();

  if (!query) {
    return NextResponse.json({ results: [] }, { headers: cacheHeaders(cacheTime) });
  }

  const config = await getConfig();
  const apiSites = config.SourceConfig.filter((site) => !site.disabled);

  try {
    const perSiteResults = await mapWithConcurrency(
      apiSites,
      MAX_CONCURRENCY,
      (site) =>
        // 借鉴 LunaTV：每个站点独立兜底，失败/超时返回 []，绝不抛出
        Promise.race([
          searchFromApi(site, query),
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error(`${site.name} timeout`)),
              PER_SITE_TIMEOUT_MS
            )
          ),
        ]).catch((err) => {
          console.warn(`搜索失败 ${site.name}:`, (err as Error).message);
          return [] as any[];
        })
    );

    let flattenedResults = perSiteResults.flat();
    if (!config.SiteConfig.DisableYellowFilter) {
      flattenedResults = flattenedResults.filter((result) => {
        const typeName = result.type_name || '';
        return !yellowWords.some((word: string) => typeName.includes(word));
      });
    }

    return NextResponse.json(
      { results: flattenedResults },
      { headers: cacheHeaders(cacheTime) }
    );
  } catch (error) {
    return NextResponse.json({ error: '搜索失败' }, { status: 500 });
  }
}
