import { NextResponse } from 'next/server';

import { getCacheTime, getDoubanProxy } from '@/lib/config';
import {
  STALE_TTL_SECONDS,
  doubanCacheKey,
  readDoubanCache,
  writeDoubanCache,
} from '@/lib/douban-cache';
import { DoubanItem, DoubanResult } from '@/lib/types';

interface DoubanCategoryApiResponse {
  total: number;
  items: Array<{
    id: string;
    title: string;
    card_subtitle: string;
    pic: {
      large: string;
      normal: string;
    };
    rating: {
      value: number;
    };
  }>;
}

// 豆瓣对 Cloudflare 边缘出口存在偶发限速，单次请求可能 6s 内不返回。
// 原实现只尝试一次，超时即返回 500；首页会并发请求 3 个分类，
// 只要一个失败整块豆瓣区就空白。改为「最多 3 次尝试 + 超时逐次放宽」。
const DOUBAN_ATTEMPTS = 3;
const DOUBAN_BASE_TIMEOUT_MS = 6000;
const DOUBAN_RETRY_DELAY_MS = 300;

async function fetchDoubanDataOnce(
  url: string,
  timeoutMs: number
): Promise<DoubanCategoryApiResponse> {
  // 若配置了豆瓣代理（后台设置 或 NEXT_PUBLIC_DOUBAN_PROXY），则通过代理请求，
  // 绕过 Cloudflare 边缘节点出口 IP 被豆瓣风控拦截的问题（直连会从 CF 出口 IP 被拒）。
  const proxy = await getDoubanProxy();
  const finalUrl = proxy ? `${proxy}${encodeURIComponent(url)}` : url;

  // 添加超时控制
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  // 设置请求选项，包括信号和头部
  const fetchOptions = {
    signal: controller.signal,
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
      // rexxar API 来自 m.douban.com，Referer 需与之匹配
      Referer: 'https://m.douban.com/',
      Accept: 'application/json, text/plain, */*',
    },
  };

  try {
    // 尝试访问豆瓣API（或经代理）
    const response = await fetch(finalUrl, fetchOptions);

    if (!response.ok) {
      throw new Error(`HTTP error! Status: ${response.status}`);
    }

    return await response.json();
  } finally {
    clearTimeout(timeoutId);
  }
}

async function fetchDoubanData(
  url: string
): Promise<DoubanCategoryApiResponse> {
  let lastError: unknown = new Error('获取豆瓣数据失败');

  for (let attempt = 1; attempt <= DOUBAN_ATTEMPTS; attempt++) {
    try {
      return await fetchDoubanDataOnce(
        url,
        DOUBAN_BASE_TIMEOUT_MS + (attempt - 1) * 2000
      );
    } catch (error) {
      lastError = error;
      // 最后一次失败不再退避等待
      if (attempt < DOUBAN_ATTEMPTS) {
        await new Promise((resolve) =>
          setTimeout(resolve, DOUBAN_RETRY_DELAY_MS * attempt)
        );
      }
    }
  }

  throw lastError;
}

export const runtime = 'edge';

function buildResponse(body: string, cacheTime: number, cacheState: string) {
  return new NextResponse(body, {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': `public, max-age=${cacheTime}, s-maxage=${cacheTime}`,
      'CDN-Cache-Control': `public, s-maxage=${cacheTime}`,
      'Vercel-CDN-Cache-Control': `public, s-maxage=${cacheTime}`,
      // 便于排查：HIT = 边缘缓存命中，MISS = 回源成功，STALE = 回源失败用旧数据兜底
      'X-Douban-Cache': cacheState,
    },
  });
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);

  // 获取参数
  const kind = searchParams.get('kind') || 'movie';
  const category = searchParams.get('category');
  const type = searchParams.get('type');
  const pageLimit = parseInt(searchParams.get('limit') || '20');
  const pageStart = parseInt(searchParams.get('start') || '0');

  // 验证参数
  if (!kind || !category || !type) {
    return NextResponse.json(
      { error: '缺少必要参数: kind 或 category 或 type' },
      { status: 400 }
    );
  }

  if (!['tv', 'movie'].includes(kind)) {
    return NextResponse.json(
      { error: 'kind 参数必须是 tv 或 movie' },
      { status: 400 }
    );
  }

  if (pageLimit < 1 || pageLimit > 100) {
    return NextResponse.json(
      { error: 'pageSize 必须在 1-100 之间' },
      { status: 400 }
    );
  }

  if (pageStart < 0) {
    return NextResponse.json(
      { error: 'pageStart 不能小于 0' },
      { status: 400 }
    );
  }

  const target = `https://m.douban.com/rexxar/api/v2/subject/recent_hot/${kind}?start=${pageStart}&limit=${pageLimit}&category=${category}&type=${type}`;

  const cacheTime = await getCacheTime();
  const freshKey = doubanCacheKey(request.url);
  const staleKey = doubanCacheKey(request.url, true);

  // 1) 命中新鲜缓存直接返回，完全不回源，既快又稳
  const freshBody = await readDoubanCache(freshKey);
  if (freshBody) {
    return buildResponse(freshBody, cacheTime, 'HIT');
  }

  try {
    // 调用豆瓣 API
    const doubanData = await fetchDoubanData(target);

    // 转换数据格式
    const list: DoubanItem[] = doubanData.items.map((item) => ({
      id: item.id,
      title: item.title,
      poster: item.pic?.normal || item.pic?.large || '',
      rate: item.rating?.value ? item.rating.value.toFixed(1) : '',
      year: item.card_subtitle?.match(/(\d{4})/)?.[1] || '',
    }));

    const response: DoubanResult = {
      code: 200,
      message: '获取成功',
      list: list,
    };

    const body = JSON.stringify(response);

    // 同时写两档缓存：新鲜档按站点配置的 cache_time，陈旧档 24h 用于失败兜底
    await Promise.all([
      writeDoubanCache(freshKey, body, cacheTime),
      writeDoubanCache(staleKey, body, STALE_TTL_SECONDS),
    ]);

    return buildResponse(body, cacheTime, 'MISS');
  } catch (error) {
    // 2) 回源失败：优先用陈旧缓存兜底，保证首页不出现空白
    const staleBody = await readDoubanCache(staleKey);
    if (staleBody) {
      return buildResponse(staleBody, 60, 'STALE');
    }

    return NextResponse.json(
      { error: '获取豆瓣数据失败', details: (error as Error).message },
      { status: 500 }
    );
  }
}
