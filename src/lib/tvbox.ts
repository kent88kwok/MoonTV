/* eslint-disable @typescript-eslint/no-explicit-any, no-console */

import { NextResponse } from 'next/server';

import type { ApiSite } from '@/lib/config';
import { API_CONFIG, getConfig } from '@/lib/config';
import { getDetailFromApi, searchFromApi } from '@/lib/downstream';
import type { SearchResult } from '@/lib/types';
import { cleanHtmlTags } from '@/lib/utils';
import { yellowWords } from '@/lib/yellow';

// Cloudflare Workers 每请求最多 6 个并发出向连接（与 /api/search 保持一致）。
const MAX_CONCURRENCY = 6;

// 单站兜底超时：死站/慢站不能拖垮整个 TVBox 请求。
const PER_SITE_TIMEOUT_MS = 20000;

// 源 key 与视频 ID 的分隔符。两边的字符集都是 [\w-]，不会与 @@ 冲突。
const ID_SEP = '@@';

// 单次搜索返回上限，避免 TVBox 列表过长导致滚动卡顿。
const MAX_RESULTS = 300;

// 豆瓣图源校验 Referer，直连 img*.doubanio.com 会被判盗链返回 418/403。
const DOUBAN_IMAGE_HOST_RE = /(^|\.)doubanio\.com$/i;

// 可直连播放的媒体地址特征。部分采集站返回的是「分享页/跳转页」而非直链，
// 这类地址交给 TVBox 会播放失败，需要剔除后走站内解析兜底。
const PLAYABLE_URL_RE = /\.(m3u8|mp4|flv|mkv|ts|mov|avi|m4v)(\?|&|#|$)/i;

const JSON_HEADERS: Record<string, string> = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store, no-cache, must-revalidate',
};

// TVBox 侧可用的口令参数名（社区里不统一，全部兼容）
export const TVBOX_TOKEN_KEYS = ['pwd', 'token', 'password', 'key'] as const;

/** 恒定时间比较，避免口令被逐字符试探 */
export function safeEqual(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/** 校验 TVBox 访问口令（复用站点登录密码 PASSWORD） */
export function verifyToken(token: string | null | undefined): boolean {
  const expected = process.env.PASSWORD || '';
  if (!expected) {
    // 站点未设置密码时拒绝对外提供接口，避免裸奔。
    return false;
  }
  return safeEqual(token || '', expected);
}

/** 解析站点对外的绝对地址：优先 SITE_BASE，其次按请求头拼装 */
export function getRequestOrigin(request: Request): string {
  const siteBase = process.env.SITE_BASE;
  if (siteBase) {
    return siteBase.replace(/\/+$/, '');
  }

  const url = new URL(request.url);
  const host = request.headers.get('host') || url.host;
  const forwardedProto = request.headers.get('x-forwarded-proto');
  const isLocal = host.startsWith('localhost') || host.startsWith('127.0.0.1');
  const proto = forwardedProto || (isLocal ? 'http' : 'https');
  return `${proto}://${host}`;
}

function isDoubanImage(url: string): boolean {
  try {
    return DOUBAN_IMAGE_HOST_RE.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

/**
 * 与前端 processImageUrl 同策略：只把「豆瓣图」与「http 图」收回站内代理，
 * 其余 https 图保持原样，不额外引入失败面。
 */
function toProxiedImage(poster: string, ctx: TvboxContext): string {
  if (!poster) {
    return '';
  }
  if (poster.startsWith('/api/tvbox')) {
    return poster;
  }
  if (!isDoubanImage(poster) && !poster.startsWith('http://')) {
    return poster;
  }

  const params = new URLSearchParams({ ac: 'img', url: poster });
  if (ctx.token) {
    params.set('pwd', ctx.token);
  }
  return `${ctx.origin}/api/tvbox?${params.toString()}`;
}

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

export interface TvboxContext {
  origin: string;
  token: string;
}

/** TVBox（苹果 CMS 协议）单条数据结构 */
export interface CmsItem {
  vod_id: string;
  vod_name: string;
  vod_pic: string;
  vod_year?: string;
  type_name?: string;
  vod_content?: string;
  vod_remarks?: string;
  vod_play_from?: string;
  vod_play_url?: string;
  vod_douban_id?: number;
}

export function encodeVodId(source: string, id: string): string {
  return `${source}${ID_SEP}${id}`;
}

export function decodeVodId(
  vodId: string
): { source: string; id: string } | null {
  const index = vodId.indexOf(ID_SEP);
  if (index <= 0) {
    return null;
  }
  const source = vodId.slice(0, index);
  const id = vodId.slice(index + ID_SEP.length);
  if (!source || !id) {
    return null;
  }
  return { source, id };
}

function toCmsItem(
  result: SearchResult,
  ctx: TvboxContext,
  withPlay = false
): CmsItem {
  const item: CmsItem = {
    vod_id: encodeVodId(result.source, result.id),
    vod_name: result.title,
    vod_pic: toProxiedImage(result.poster, ctx),
    vod_year: result.year && result.year !== 'unknown' ? result.year : '',
    type_name: result.type_name || result.class || '',
    vod_content: result.desc || '',
    vod_remarks: result.source_name || '',
  };

  if (result.douban_id) {
    item.vod_douban_id = result.douban_id;
  }

  if (withPlay) {
    const episodes = (result.episodes || []).filter((url: string) => !!url);
    // TVBox 线路内格式：剧集名$地址，剧集之间用 # 分隔。
    const playList = episodes
      .map((url: string, index: number) =>
        episodes.length === 1 ? `正片$${url}` : `第${index + 1}集$${url}`
      )
      .join('#');
    item.vod_play_from = result.source_name || 'MoonTV';
    item.vod_play_url = playList;
  }

  return item;
}

/**
 * 聚合搜索：并发全部启用的采集站，合并去重后按相关度排序。
 * 一次 TVBox 搜索 = 站内 30 个源一起搜，这是「聚合源」相比「源清单」的核心价值。
 */
export async function searchAggregated(
  keyword: string,
  ctx: TvboxContext
): Promise<CmsItem[]> {
  const config = await getConfig();
  const apiSites = (config.SourceConfig || []).filter((site) => !site.disabled);
  if (apiSites.length === 0) {
    return [];
  }

  const perSiteResults = await mapWithConcurrency(
    apiSites,
    MAX_CONCURRENCY,
    (site) =>
      Promise.race([
        searchFromApi(site, keyword),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(`${site.name} timeout`)),
            PER_SITE_TIMEOUT_MS
          )
        ),
      ]).catch(() => [] as SearchResult[])
  );

  let results: SearchResult[] = perSiteResults.flat();

  // 黄色内容过滤：与 /api/search 保持一致（按 type_name 命中词表）。
  if (!config.SiteConfig?.DisableYellowFilter) {
    results = results.filter((result: SearchResult) => {
      const typeName = result.type_name || '';
      return !yellowWords.some((word: string) => typeName.includes(word));
    });
  }

  // 去重：同一源同一 ID 只保留一条（同名不同源保留，便于挑画质）。
  const seen = new Set<string>();
  results = results.filter((result: SearchResult) => {
    const key = encodeVodId(result.source, result.id);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });

  // 相关度排序：完全匹配 > 前缀匹配 > 包含 > 其他，同级保持原源顺序。
  const normalized = keyword.trim().toLowerCase();
  const rank = (title: string): number => {
    const t = (title || '').toLowerCase();
    if (t === normalized) {
      return 0;
    }
    if (t.startsWith(normalized)) {
      return 1;
    }
    if (t.includes(normalized)) {
      return 2;
    }
    return 3;
  };

  results = results
    .map((result: SearchResult, index: number) => ({ result, index }))
    .sort((a, b) => {
      const diff = rank(a.result.title) - rank(b.result.title);
      return diff !== 0 ? diff : a.index - b.index;
    })
    .map((entry) => entry.result);

  return results.slice(0, MAX_RESULTS).map((result) => toCmsItem(result, ctx));
}

/** 采集站原始详情条目（苹果 CMS 返回结构，字段并非都有） */
interface RawCmsItem {
  vod_id?: string | number;
  vod_name?: string;
  vod_pic?: string;
  vod_year?: string;
  vod_class?: string;
  type_name?: string;
  vod_content?: string;
  vod_play_from?: string;
  vod_play_url?: string;
  vod_douban_id?: number;
}

/** 直采采集站详情接口，拿回未经裁剪的 vod_play_from / vod_play_url */
async function fetchRawCmsDetail(
  apiSite: ApiSite,
  id: string
): Promise<RawCmsItem | null> {
  const url = `${apiSite.api}${API_CONFIG.detail.path}${id}`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);

  try {
    const response = await fetch(url, {
      headers: API_CONFIG.detail.headers,
      signal: controller.signal,
    });
    if (!response.ok) {
      return null;
    }
    const data = await response.json();
    const item: RawCmsItem | undefined = data?.list?.[0];
    return item && item.vod_play_url ? item : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * 逐线路剔除不可直连播放的剧集（分享页、跳转页等）。
 * 全部线路都不可播时返回 null，交由站内解析兜底。
 */
function filterPlayableLines(
  playFrom: string | undefined,
  playUrl: string | undefined
): { from: string; url: string } | null {
  if (!playUrl) {
    return null;
  }

  const fromList = (playFrom || '').split('$$$');
  const keptFrom: string[] = [];
  const keptUrl: string[] = [];

  playUrl.split('$$$').forEach((line, index) => {
    const episodes = line.split('#').filter((episode) => {
      const parts = episode.split('$');
      const address = parts[parts.length - 1] || '';
      return PLAYABLE_URL_RE.test(address);
    });
    if (episodes.length > 0) {
      keptFrom.push(fromList[index] || `线路${index + 1}`);
      keptUrl.push(episodes.join('#'));
    }
  });

  if (keptUrl.length === 0) {
    return null;
  }
  return { from: keptFrom.join('$$$'), url: keptUrl.join('$$$') };
}

function rawToCmsItem(
  raw: RawCmsItem,
  lines: { from: string; url: string },
  apiSite: ApiSite,
  ctx: TvboxContext
): CmsItem {
  const item: CmsItem = {
    vod_id: encodeVodId(apiSite.key, String(raw.vod_id ?? '')),
    vod_name: (raw.vod_name || '').trim().replace(/\s+/g, ' '),
    vod_pic: toProxiedImage(raw.vod_pic || '', ctx),
    vod_year: raw.vod_year ? raw.vod_year.match(/\d{4}/)?.[0] || '' : '',
    type_name: raw.type_name || raw.vod_class || '',
    vod_content: cleanHtmlTags(raw.vod_content || ''),
    vod_remarks: apiSite.name,
    vod_play_from: lines.from,
    vod_play_url: lines.url,
  };

  if (raw.vod_douban_id) {
    item.vod_douban_id = raw.vod_douban_id;
  }
  return item;
}

/** 详情：vod_id 形如 `源key@@视频id`，据此回源抓取各线路播放地址 */
export async function getAggregatedDetail(
  vodId: string,
  ctx: TvboxContext
): Promise<CmsItem | null> {
  const decoded = decodeVodId(vodId);
  if (!decoded) {
    return null;
  }
  const { source, id } = decoded;
  if (!/^[\w-]+$/.test(id)) {
    return null;
  }

  const config = await getConfig();
  const apiSite = (config.SourceConfig || []).find(
    (site) => site.key === source
  );
  if (!apiSite) {
    return null;
  }

  // 优先直采采集站详情：能完整保留线路名与集数名（站内解析会把它们丢掉，
  // 导致 TVBox 里只剩一条线路、剧集名退化成「第 N 集」）。
  const raw = await fetchRawCmsDetail(apiSite, id);
  const lines = raw
    ? filterPlayableLines(raw.vod_play_from, raw.vod_play_url)
    : null;
  if (raw && lines) {
    return rawToCmsItem(raw, lines, apiSite, ctx);
  }

  // 兜底：直采不可用或线路全是跳转页时，退回站内详情解析
  // （含 ffzy 这类需要抓详情页 HTML 提取 m3u8 的特殊源）。
  const fallback = await getDetailFromApi(apiSite, id);
  return toCmsItem(fallback, ctx, true);
}

/** TVBox 订阅配置：只暴露一个「MoonTV 聚合」源 */
export function buildSubscription(origin: string, token: string) {
  return {
    sites: [
      {
        key: 'moontv',
        name: 'MoonTV 聚合',
        type: 1,
        // 口令放在路径里：TVBox 各版本拼接 ?ac=videolist&wd= 的方式不一，
        // 路径式可避免出现两个 ? 或参数被覆盖。
        api: `${origin}/api/tvbox/${encodeURIComponent(token)}`,
        searchable: 1,
        // 聚合搜索会并发几十个上游，关掉「输入即搜」避免误触造成重负载。
        quickSearch: 0,
        filterable: 0,
        ext: '',
      },
    ],
    parses: [],
    lives: [],
    ads: [],
  };
}

/** 图片代理：补 Referer + UA 换取豆瓣图，带半年边缘缓存 */
export async function proxyImage(rawUrl: string): Promise<Response> {
  if (!rawUrl) {
    return NextResponse.json(
      { error: '缺少 url 参数' },
      { status: 400, headers: JSON_HEADERS }
    );
  }

  let target: URL;
  try {
    target = new URL(rawUrl);
  } catch {
    return NextResponse.json(
      { error: 'url 参数非法' },
      { status: 400, headers: JSON_HEADERS }
    );
  }

  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    return NextResponse.json(
      { error: '仅支持 http/https 图片' },
      { status: 400, headers: JSON_HEADERS }
    );
  }

  try {
    const upstream = await fetch(target.toString(), {
      headers: {
        Referer: 'https://movie.douban.com/',
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
      },
    });

    if (!upstream.ok || !upstream.body) {
      return NextResponse.json(
        { error: `上游返回 ${upstream.status}` },
        { status: upstream.status || 502, headers: JSON_HEADERS }
      );
    }

    const headers = new Headers();
    const contentType = upstream.headers.get('content-type');
    if (contentType) {
      headers.set('Content-Type', contentType);
    }
    headers.set('Cache-Control', 'public, max-age=15720000, s-maxage=15720000');
    headers.set('CDN-Cache-Control', 'public, s-maxage=15720000');

    return new Response(upstream.body, { status: 200, headers });
  } catch (error) {
    console.error('TVBox 图片代理失败:', (error as Error).message);
    return NextResponse.json(
      { error: '拉取图片失败' },
      { status: 502, headers: JSON_HEADERS }
    );
  }
}

/**
 * 苹果 CMS 协议统一入口。TVBox 会用它发三类请求：
 *   - ?ac=list                        → 分类列表（聚合源无统一分类，返回空）
 *   - ?ac=videolist&wd=关键词          → 搜索
 *   - ?ac=detail&ids=源key@@视频id      → 详情（含播放地址）
 */
export async function handleCmsRequest(
  request: Request,
  ctx: TvboxContext
): Promise<Response> {
  const { searchParams } = new URL(request.url);
  const ac = (searchParams.get('ac') || '').toLowerCase();
  const ids = searchParams.get('ids') || searchParams.get('id') || '';
  const keyword =
    searchParams.get('wd') ||
    searchParams.get('keyword') ||
    searchParams.get('k') ||
    '';

  // 分类列表：30 个采集站的分类体系各不相同，无法合并，故返回空。
  // TVBox 会退化为「搜索型源」，搜索功能不受影响。
  if (ac === 'list') {
    return NextResponse.json(
      { class: [], list: [] },
      { headers: JSON_HEADERS }
    );
  }

  if (ids) {
    const singleId = ids.split(',')[0].trim();
    try {
      const item = await getAggregatedDetail(singleId, ctx);
      return NextResponse.json(
        {
          list: item ? [item] : [],
          page: 1,
          pagecount: 1,
          limit: 1,
          total: item ? 1 : 0,
        },
        { headers: JSON_HEADERS }
      );
    } catch (error) {
      console.warn('TVBox 详情获取失败:', (error as Error).message);
      return NextResponse.json(
        { list: [], page: 1, pagecount: 1, limit: 0, total: 0 },
        { headers: JSON_HEADERS }
      );
    }
  }

  if (keyword) {
    try {
      const list = await searchAggregated(keyword, ctx);
      return NextResponse.json(
        {
          list,
          page: 1,
          pagecount: 1,
          limit: list.length,
          total: list.length,
        },
        { headers: JSON_HEADERS }
      );
    } catch (error) {
      console.warn('TVBox 聚合搜索失败:', (error as Error).message);
      return NextResponse.json(
        { list: [], page: 1, pagecount: 1, limit: 0, total: 0 },
        { headers: JSON_HEADERS }
      );
    }
  }

  return NextResponse.json({ class: [], list: [] }, { headers: JSON_HEADERS });
}
