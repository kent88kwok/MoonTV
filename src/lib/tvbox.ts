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

// 分类映射（30 个源的 ?ac=list）整体预算。并发上限是 6，30 个源最少 5 轮，
// 若碰上若干死站、每轮都吃满单站超时，最坏能拖到上百秒 —— 客户端早已超时，
// 表现为"点进分类一直转圈/空白"。这里给一个硬上限：到点就用手上已收集到的源，
// 放弃还没回来的（下个 6 小时周期再补），保证请求时长可预测。
const CATEGORY_MAP_BUDGET_MS = 10000;

// 拉单个源分类列表的超时上限（比通用单站超时短：分类列表只有几 KB）。
const CLASS_LIST_TIMEOUT_MS = 8000;

// 源 key 与视频 ID 的分隔符。两边的字符集都是 [\w-]，不会与 @@ 冲突。
const ID_SEP = '@@';

// 单次搜索返回上限，避免 TVBox 列表过长导致滚动卡顿。
const MAX_RESULTS = 300;

// 豆瓣图源校验 Referer，直连 img*.doubanio.com 会被判盗链返回 418/403。
const DOUBAN_IMAGE_HOST_RE = /(^|\.)doubanio\.com$/i;

// TVBox 启动时会先加载插件 jar（spider）。配置里缺这个字段时，多数客户端
// 会去加载空地址并提示「jar 加载失败」，界面就停在那儿进不去。
// 这里指向 CatVodSpider 的通用 jar（内含 classes.dex，Android 专用）。
const SPIDER_JAR_SOURCES = [
  'https://raw.githubusercontent.com/FongMi/CatVodSpider/main/jar/custom_spider.jar',
  // GitHub raw 在部分网络下直连 403/超时，以下为国内可用的反代镜像。
  'https://ghproxy.net/https://raw.githubusercontent.com/FongMi/CatVodSpider/main/jar/custom_spider.jar',
  'https://gh-proxy.com/raw.githubusercontent.com/FongMi/CatVodSpider/main/jar/custom_spider.jar',
];

const SPIDER_JAR_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';

// jar 内容几乎不变，边缘缓存 7 天，避免每台设备每次启动都回源。
const SPIDER_JAR_TTL = 604800;

const SPIDER_JAR_CACHE_KEY = 'https://tvbox.internal/spider.jar';

/** 分类映射缓存时长（秒）。采集站分类极少变动，6 小时足够。 */
const CATEGORY_MAP_TTL = 21600;

/** 分类浏览结果的内存缓存时长（秒）。 */
const CATEGORY_PAGE_TTL = 300;

/** 每个标准分类最多查询的源数量：兼顾覆盖度与边缘子请求配额。 */
const MAX_SITES_PER_CATEGORY = 12;

/** 分类浏览单页结果上限，避免列表过长导致客户端滚动卡顿。 */
const MAX_CATEGORY_RESULTS = 180;

/** 分类浏览最大页码，防止客户端传入超大页码把上游打爆。 */
const MAX_CATEGORY_PAGE = 500;

/** 顶层分类命中成人特征词的比例超过该值即判定为纯成人采集站，整站跳过。 */
const ADULT_SOURCE_HITS_RATIO = 0.3;

/**
 * 成人内容特征词。站内 yellowWords 只覆盖 20 个词，而采集站常用
 * 「制服丝袜 / 群交淫乱 / 欧美性爱」这类词表外的写法，这里做补充判定。
 * 仅在分类聚合时使用，不改变站内原有的过滤行为。
 */
const EXTRA_ADULT_WORDS = [
  '色情',
  '情色',
  '情欲',
  '伦理',
  '三级',
  '成人',
  '18禁',
  '无码',
  '有码',
  '淫',
  '乱伦',
  '群交',
  '人兽',
  '性爱',
  '做爱',
  '裸',
  '偷拍',
  '盗摄',
  '自拍',
  '走光',
  '美乳',
  '巨乳',
  '人妻',
  '熟女',
  '少妇',
  '丝袜',
  '制服',
  '调教',
  'sm',
  '黑料',
  '换脸',
  '艳照',
  '写真',
  '福利',
  '麻豆',
  '天美',
  '蜜桃',
  '精东',
  'swag',
  '91',
  '主播',
  '成人动漫',
];

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

/* ------------------------------------------------------------------ *
 * 分类聚合
 *
 * 30 个采集站各有一套分类体系（有的叫「电影片」，有的叫「电影」，
 * 有的把「电视剧」排在 type_id=1、有的排 2），无法直接透传给 TVBox。
 * 这里把它们归一到一组标准分类，浏览时再映射回各站自己的分类 ID。
 * ------------------------------------------------------------------ */

interface StandardCategory {
  key: string;
  name: string;
}

/** 对外暴露的标准分类（顺序即 TVBox 里分类标签的显示顺序） */
const STANDARD_CATEGORIES: StandardCategory[] = [
  { key: 'movie', name: '电影' },
  { key: 'tv', name: '电视剧' },
  { key: 'anime', name: '动漫' },
  { key: 'variety', name: '综艺' },
  { key: 'documentary', name: '纪录片' },
  { key: 'kids', name: '少儿' },
];

const STANDARD_CATEGORY_KEYS = new Set(STANDARD_CATEGORIES.map((c) => c.key));

/**
 * 把采集站的分类名归一到标准分类。
 *
 * 判定顺序即优先级，几处关键取舍：
 * - 「动漫片 / 综艺片」必须先于「X片」判定，否则会被「片」结尾误判成电影；
 * - 「剧情片 / 动作片」等电影子类以「片」结尾，需先于含「剧」的规则判定，
 *   否则会被当成电视剧；
 * - 「连续剧 / 港剧 / 韩剧」等无「片」结尾，落到电视剧。
 */
function categorizeTypeName(typeName: string): string | null {
  const name = (typeName || '').trim();
  if (!name) {
    return null;
  }
  if (/(动漫|动画|番剧|国漫|日漫|漫画)/.test(name)) {
    return 'anime';
  }
  if (/(少儿|儿童|亲子|儿歌|益智|幼儿)/.test(name)) {
    return 'kids';
  }
  if (/(纪录|记录)/.test(name)) {
    return 'documentary';
  }
  if (/(综艺|真人秀|脱口秀|访谈|晚会)/.test(name)) {
    return 'variety';
  }
  if (/(电影|剧场版|片$)/.test(name)) {
    return 'movie';
  }
  if (/(剧|电视|连续)/.test(name)) {
    return 'tv';
  }
  return null;
}

/** 分类名/标题是否含成人特征（站内词表 + 补充词表） */
function isAdultName(name: string): boolean {
  if (!name) {
    return false;
  }
  const lower = name.toLowerCase();
  if (yellowWords.some((word: string) => lower.includes(word.toLowerCase()))) {
    return true;
  }
  return EXTRA_ADULT_WORDS.some((word) => lower.includes(word));
}

interface SourceClass {
  typeId: string;
  name: string;
  isTop: boolean;
}

/** 拉取单个采集站的分类列表（苹果 CMS `?ac=list`） */
async function fetchSourceClasses(
  apiSite: ApiSite,
  timeoutMs: number = CLASS_LIST_TIMEOUT_MS
): Promise<SourceClass[]> {
  const sep = apiSite.api.includes('?') ? '&' : '?';
  const url = `${apiSite.api}${sep}ac=list`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      headers: API_CONFIG.search.headers,
      signal: controller.signal,
    });
    if (!response.ok) {
      return [];
    }
    const data = await response.json();
    const list = Array.isArray(data?.class) ? data.class : [];
    return list
      .filter((entry: { type_id?: unknown; type_name?: unknown }) => {
        return entry && entry.type_id !== undefined && !!entry.type_name;
      })
      .map(
        (entry: {
          type_id: string | number;
          type_name: string;
          type_pid?: string | number;
        }) => ({
          typeId: String(entry.type_id),
          name: String(entry.type_name),
          // type_pid 为 0/空表示顶层分类；顶层分类通常能汇总其下子分类，覆盖面最广。
          isTop: !Number(entry.type_pid),
        })
      );
  } catch {
    return [];
  } finally {
    clearTimeout(timeoutId);
  }
}

/** 某个采集站对某个标准分类的映射：候选分类 ID 可能多个，见 buildCategoryMap */
type CategoryEntry = { site: string; typeIds: string[] };

/** 标准分类 → 各采集站对应的候选分类 ID */
type CategoryMap = Record<string, CategoryEntry[]>;

let categoryMapMemo: { at: number; value: CategoryMap } | null = null;

/** `源::标准分类` → 已确认无法用于分类浏览的分类 ID，避免重复试错 */
const categoryInvalidMemo = new Map<string, Set<string>>();

/** 单源单次最多尝试的候选分类数，控制边缘子请求总量 */
const CATEGORY_FALLBACK_TRIES = 2;

/** 分类浏览结果的内存缓存（只存原始列表，不含口令，可安全复用） */
const categoryPageMemo = new Map<
  string,
  { at: number; value: SearchResult[] }
>();

/** 并发拉取全部启用的采集站分类，归一后建立映射 */
async function buildCategoryMap(): Promise<CategoryMap> {
  const config = await getConfig();
  const apiSites = (config.SourceConfig || []).filter((site) => !site.disabled);
  const filterAdult = !config.SiteConfig?.DisableYellowFilter;

  const deadline = Date.now() + CATEGORY_MAP_BUDGET_MS;

  const perSite = await mapWithConcurrency(
    apiSites,
    MAX_CONCURRENCY,
    async (site) => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        // 预算用尽：放掉这个源，用已收集到的部分建映射（不阻塞用户请求）。
        return { site, classes: [] as SourceClass[] };
      }
      return {
        site,
        classes: await fetchSourceClasses(
          site,
          Math.min(remaining, CLASS_LIST_TIMEOUT_MS)
        ),
      };
    }
  );

  const map: CategoryMap = {};

  for (const { site, classes } of perSite) {
    if (classes.length === 0) {
      continue;
    }

    const topClasses = classes.filter((entry) => entry.isTop);

    // 纯成人采集站整站剔除：这类站的分类名（制服丝袜 / 欧美性爱…）会大面积
    // 命中特征词，若只按分类名逐个过滤，其「卡通动漫」之类的中性分类
    // 仍会混进正常的动漫入口。
    if (filterAdult && topClasses.length >= 2) {
      const hits = topClasses.filter((entry) => isAdultName(entry.name)).length;
      if (hits / topClasses.length >= ADULT_SOURCE_HITS_RATIO && hits >= 2) {
        continue;
      }
    }

    // 收集该源在每个标准分类下的全部候选分类 ID。
    //
    // 候选顺序是关键：实测采集站普遍只接受「叶子分类」的 ID，
    // 传顶层分类（type_pid=0）常常返回空列表 —— 例如 ffzy 传 t=1（电影片）
    // 得到 0 条，传 t=6（动作片）则有 4 千多条。所以叶子分类在前、
    // 顶层分类兜底，同级按 ID 升序（ID 小的通常为主分类）。
    const matched = new Map<
      string,
      { typeId: string; isTop: boolean; id: number }[]
    >();

    for (const entry of classes) {
      if (filterAdult && isAdultName(entry.name)) {
        continue;
      }
      const key = categorizeTypeName(entry.name);
      if (!key || !STANDARD_CATEGORY_KEYS.has(key)) {
        continue;
      }
      const list = matched.get(key) || [];
      list.push({
        typeId: entry.typeId,
        isTop: entry.isTop,
        id: Number(entry.typeId) || 0,
      });
      matched.set(key, list);
    }

    matched.forEach((list, key) => {
      list.sort((a, b) => {
        if (a.isTop !== b.isTop) {
          return a.isTop ? 1 : -1;
        }
        return a.id - b.id;
      });
      (map[key] ||= []).push({
        site: site.key,
        typeIds: list.map((entry) => entry.typeId),
      });
    });
  }

  return map;
}

/** 取分类映射（内存 → 边缘缓存 → 回源构建） */
async function getCategoryMap(): Promise<CategoryMap> {
  const now = Date.now();
  if (categoryMapMemo && now - categoryMapMemo.at < CATEGORY_MAP_TTL * 1000) {
    return categoryMapMemo.value;
  }

  const cache = getEdgeCache();
  const cacheKey = new Request('https://tvbox.internal/category-map.json');
  if (cache) {
    try {
      const cached = await cache.match(cacheKey);
      if (cached) {
        const value = (await cached.json()) as CategoryMap;
        categoryMapMemo = { at: now, value };
        return value;
      }
    } catch {
      // 缓存不可用不影响主流程
    }
  }

  const value = await buildCategoryMap();
  if (Object.keys(value).length === 0) {
    // 全部源都失败时不缓存，让下次请求重试，避免把空结果锁 6 小时。
    return value;
  }

  categoryMapMemo = { at: now, value };
  if (cache) {
    try {
      await cache.put(
        cacheKey,
        new Response(JSON.stringify(value), {
          headers: {
            'Content-Type': 'application/json',
            'Cache-Control': `public, s-maxage=${CATEGORY_MAP_TTL}`,
          },
        })
      );
    } catch {
      // 写缓存失败不影响本次响应
    }
  }
  return value;
}

/** 采集站列表条目 → 站内统一结构 */
function rawToSearchResult(raw: RawCmsItem, apiSite: ApiSite): SearchResult {
  return {
    id: String(raw.vod_id ?? ''),
    title: (raw.vod_name || '').trim().replace(/\s+/g, ' '),
    poster: raw.vod_pic || '',
    episodes: [],
    source: apiSite.key,
    source_name: apiSite.name,
    class: raw.vod_class,
    year: raw.vod_year ? raw.vod_year.match(/\d{4}/)?.[0] || '' : 'unknown',
    desc: cleanHtmlTags(raw.vod_content || ''),
    type_name: raw.type_name,
    douban_id: raw.vod_douban_id,
  };
}

/**
 * 分类浏览单源单页。
 *
 * 分类参数名用 `t` 而非 `type_id`：实测 type_id 会被所有采集站忽略
 * （返回的是全站最新，与不带参数完全一致），真正生效的是 `t`。
 * typeId 为空时退化为「全站最新」，由调用方按条目分类名二次过滤。
 */
async function fetchCategoryPage(
  apiSite: ApiSite,
  typeId: string,
  page: number
): Promise<SearchResult[]> {
  const sep = apiSite.api.includes('?') ? '&' : '?';
  const categoryQuery = typeId ? `&t=${encodeURIComponent(typeId)}` : '';
  const url = `${apiSite.api}${sep}ac=videolist&pg=${page}${categoryQuery}`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), PER_SITE_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      headers: API_CONFIG.search.headers,
      signal: controller.signal,
    });
    if (!response.ok) {
      return [];
    }
    const data = await response.json();
    const list = Array.isArray(data?.list) ? data.list : [];
    return list
      .map((raw: RawCmsItem) => rawToSearchResult(raw, apiSite))
      .filter((result: SearchResult) => !!result.id && !!result.title);
  } catch {
    return [];
  } finally {
    clearTimeout(timeoutId);
  }
}

/** 退化路径：拉全站最新，再按条目自身的分类名筛出目标分类 */
async function fetchWholeListFiltered(
  apiSite: ApiSite,
  categoryKey: string,
  page: number
): Promise<SearchResult[]> {
  const list = await fetchCategoryPage(apiSite, '', page);
  return list.filter(
    (result) => categorizeTypeName(result.type_name || '') === categoryKey
  );
}

/**
 * 从单个采集站取某一页分类内容。
 *
 * 采集站支持程度差异很大，这里按三级策略处理：
 *   1. 有候选分类 → 按页码轮转候选（翻页时能依次看到该分类下的不同子类，
 *      如动作片 → 喜剧片 → …），命中的候选直接返回；
 *   2. 候选试完仍为空 → 记住失效的 ID，返回空页（不误伤同源其它分类）；
 *   3. 该源压根没提供分类信息 / 候选全部失效 → 退化到「全站最新 + 本地过滤」，
 *      保证任何源都能贡献内容，且不会把不相干分类混进来。
 */
async function fetchCategoryFromSite(
  apiSite: ApiSite,
  categoryKey: string,
  typeIds: string[],
  page: number
): Promise<SearchResult[]> {
  const memoKey = `${apiSite.key}::${categoryKey}`;
  const invalid = categoryInvalidMemo.get(memoKey) || new Set<string>();

  if (typeIds.length === 0) {
    return fetchWholeListFiltered(apiSite, categoryKey, page);
  }

  const usable = typeIds.filter((typeId) => !invalid.has(typeId));
  if (usable.length === 0) {
    return fetchWholeListFiltered(apiSite, categoryKey, page);
  }

  const tries = Math.min(usable.length, CATEGORY_FALLBACK_TRIES);
  for (let index = 0; index < tries; index++) {
    const typeId = usable[(page - 1 + index) % usable.length];
    const list = await fetchCategoryPage(apiSite, typeId, page);
    if (list.length > 0) {
      return list;
    }
    // 该分类 ID 在这个源上拿不到数据，记录下来避免后续重复试。
    invalid.add(typeId);
    categoryInvalidMemo.set(memoKey, invalid);
  }

  return [];
}

export interface CategoryListResult {
  list: CmsItem[];
  page: number;
  pagecount: number;
  total: number;
}

/**
 * 分类浏览：并发查询映射到该分类的若干采集站，交错合并后返回一页。
 * 交错（round-robin）是为了让不同源的条目混排，避免整页都来自同一个源。
 */
export async function getCategoryList(
  categoryKey: string,
  page: number,
  ctx: TvboxContext
): Promise<CategoryListResult> {
  const empty: CategoryListResult = { list: [], page, pagecount: 0, total: 0 };
  if (!STANDARD_CATEGORY_KEYS.has(categoryKey)) {
    return empty;
  }

  const config = await getConfig();
  const filterAdult = !config.SiteConfig?.DisableYellowFilter;
  const apiSites = (config.SourceConfig || []).filter((site) => !site.disabled);
  const siteByKey = new Map(apiSites.map((site) => [site.key, site]));

  // 分类映射只影响「精确度」，不该影响「有没有内容」。
  // 映射构建失败（边缘超时、子请求受限等）或该分类在映射里为空时，
  // 退化为「全站最新 + 按条目分类名本地过滤」——内容依然正确，只是单页稀疏些，
  // 而不是让用户点进去看到一片空白。
  let entries: CategoryEntry[] = [];
  try {
    const map = await getCategoryMap();
    entries = (map[categoryKey] || []).slice(0, MAX_SITES_PER_CATEGORY);
  } catch (error) {
    console.warn(
      'TVBox 分类映射构建失败，退化为全站过滤:',
      (error as Error).message
    );
  }
  if (entries.length === 0) {
    entries = apiSites
      .slice(0, MAX_SITES_PER_CATEGORY)
      .map((site) => ({ site: site.key, typeIds: [] }));
  }
  if (entries.length === 0) {
    return empty;
  }

  const pageMemoKey = `${categoryKey}:${page}`;
  const memo = categoryPageMemo.get(pageMemoKey);
  let merged: SearchResult[];

  if (memo && Date.now() - memo.at < CATEGORY_PAGE_TTL * 1000) {
    merged = memo.value;
  } else {
    const perSite = await mapWithConcurrency(
      entries,
      MAX_CONCURRENCY,
      async (entry) => {
        const site = siteByKey.get(entry.site);
        if (!site) {
          return [] as SearchResult[];
        }
        const results = await fetchCategoryFromSite(
          site,
          categoryKey,
          entry.typeIds,
          page
        );
        if (!filterAdult) {
          return results;
        }
        return results.filter(
          (result) =>
            !isAdultName(result.title) && !isAdultName(result.type_name || '')
        );
      }
    );

    const interleaved: SearchResult[] = [];
    const maxLen = perSite.reduce((max, list) => Math.max(max, list.length), 0);
    for (let index = 0; index < maxLen; index++) {
      for (const list of perSite) {
        if (list[index]) {
          interleaved.push(list[index]);
        }
      }
    }

    const seen = new Set<string>();
    merged = [];
    for (const result of interleaved) {
      const id = encodeVodId(result.source, result.id);
      if (seen.has(id)) {
        continue;
      }
      seen.add(id);
      merged.push(result);
      if (merged.length >= MAX_CATEGORY_RESULTS) {
        break;
      }
    }

    if (merged.length > 0) {
      categoryPageMemo.set(pageMemoKey, { at: Date.now(), value: merged });
    }
  }

  return {
    list: merged.map((result) => toCmsItem(result, ctx)),
    page,
    // 聚合源无法预知总页数：有数据就继续放行翻页，翻到空页即自然结束。
    pagecount: merged.length > 0 ? MAX_CATEGORY_PAGE : Math.max(0, page - 1),
    total: merged.length,
  };
}

/** 取 Cloudflare 边缘缓存；本地 dev 等环境无 Cache API 时降级为不回源缓存。 */
function getEdgeCache(): Cache | null {
  try {
    const store = (globalThis as { caches?: { default?: Cache } }).caches;
    return store?.default ?? null;
  } catch {
    return null;
  }
}

/**
 * 转发 TVBox 插件 jar。
 *
 * 让 TVBox 只连本站：国内直连 GitHub raw 常被拦，而本站域名可达。
 * 取回后校验 zip 魔数（PK），避免把上游错误页当成 jar 发出去——
 * 那种情况在客户端同样表现为「jar 加载失败」，且极难排查。
 */
export async function serveSpiderJar(): Promise<Response> {
  const cache = getEdgeCache();
  const cacheKey = new Request(SPIDER_JAR_CACHE_KEY);

  try {
    const cached = await cache?.match(cacheKey);
    if (cached) {
      return cached;
    }
  } catch {
    // 缓存不可用不影响主流程
  }

  const failures: string[] = [];
  for (const source of SPIDER_JAR_SOURCES) {
    try {
      const upstream = await fetch(source, {
        headers: { 'User-Agent': SPIDER_JAR_UA },
      });
      if (!upstream.ok) {
        failures.push(`${source} → HTTP ${upstream.status}`);
        continue;
      }

      const buffer = await upstream.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
        failures.push(`${source} → 非 jar 内容（${bytes.length}B）`);
        continue;
      }

      const headers: Record<string, string> = {
        'Content-Type': 'application/java-archive',
        'Content-Length': String(bytes.length),
        'Cache-Control': `public, max-age=${SPIDER_JAR_TTL}, s-maxage=${SPIDER_JAR_TTL}`,
        'CDN-Cache-Control': `public, s-maxage=${SPIDER_JAR_TTL}`,
      };

      try {
        await cache?.put(
          cacheKey,
          new Response(buffer, { status: 200, headers })
        );
      } catch {
        // 写缓存失败不影响本次响应
      }

      return new Response(buffer, { status: 200, headers });
    } catch (error) {
      failures.push(`${source} → ${(error as Error).message}`);
    }
  }

  console.error('TVBox 插件 jar 获取失败:', failures.join('; '));
  return NextResponse.json(
    { error: '插件 jar 获取失败', sources: failures },
    { status: 502, headers: JSON_HEADERS }
  );
}

/** TVBox 订阅配置：只暴露一个「MoonTV 聚合」源 */
export function buildSubscription(origin: string, token: string) {
  return {
    // 缺 spider 字段时 TVBox 会报「jar 加载失败」。指向本站代理，
    // 客户端只需能连上本站域名即可拿到 jar。
    spider: `${origin}/api/tvbox/spider.jar`,
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
    rules: [],
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
 * 苹果 CMS 协议统一入口。TVBox 会用它发四类请求：
 *   - ?ac=list                          → 分类列表（归一后的标准分类）
 *   - ?ac=videolist&t=分类&pg=页码        → 分类浏览
 *   - ?ac=videolist&wd=关键词            → 搜索
 *   - ?ac=detail&ids=源key@@视频id        → 详情（含播放地址）
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
  // 分类标识：我们对外用标准分类 key（movie/tv/…），客户端回传的即它。
  const categoryKey =
    searchParams.get('t') || searchParams.get('type_id') || '';
  const pageRaw = searchParams.get('pg') || searchParams.get('page') || '1';
  const page = Math.min(
    Math.max(parseInt(pageRaw, 10) || 1, 1),
    MAX_CATEGORY_PAGE
  );

  if (ids) {
    const singleId = ids.split(',')[0].trim();
    try {
      const item = await getAggregatedDetail(singleId, ctx);
      return NextResponse.json(
        {
          code: 1,
          msg: '数据列表',
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
        {
          code: 1,
          msg: '数据列表',
          list: [],
          page: 1,
          pagecount: 1,
          limit: 0,
          total: 0,
        },
        { headers: JSON_HEADERS }
      );
    }
  }

  if (keyword) {
    try {
      const list = await searchAggregated(keyword, ctx);
      return NextResponse.json(
        {
          code: 1,
          msg: '数据列表',
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
        {
          code: 1,
          msg: '数据列表',
          list: [],
          page: 1,
          pagecount: 1,
          limit: 0,
          total: 0,
        },
        { headers: JSON_HEADERS }
      );
    }
  }

  // 分类浏览：无关键词、无 ids，只带分类与页码。
  if (categoryKey) {
    try {
      const result = await getCategoryList(categoryKey, page, ctx);
      return NextResponse.json(
        {
          code: 1,
          msg: '数据列表',
          ...result,
          limit: result.list.length,
        },
        { headers: JSON_HEADERS }
      );
    } catch (error) {
      console.warn('TVBox 分类浏览失败:', (error as Error).message);
      return NextResponse.json(
        {
          code: 1,
          msg: '数据列表',
          class: [],
          list: [],
          page,
          pagecount: 0,
          limit: 0,
          total: 0,
        },
        { headers: JSON_HEADERS }
      );
    }
  }

  // 分类列表：恒定返回静态的 6 个标准分类，**不做任何上游请求**。
  //
  // 这一条是 TVBox 首页标签栏的唯一来源（客户端启动时对 api 地址发一次裸 GET，
  // 或带 ?ac=list），所以它必须"永远成功、永远够快"。
  //
  // 早期实现把它挂在 getCategoryMap() 上：要先并发拉 30 个采集站的 ?ac=list
  // （约 5 秒、30 个子请求）映射出各站分类，一旦这次构建超时或失败，
  // class 就是空数组 —— 客户端表现为「完全没有分类菜单」，且重新导入也不恢复。
  // 映射只对"点进某个分类之后"才有用，不该挡在入口上，故推迟到那时按需构建。
  //
  // 响应必须带上 code/msg：苹果 CMS 的标准 ac=list 是
  // {code,msg,page,pagecount,limit,total,class,list}，而 FongMi 系客户端
  // （影视仓 / OK影视等）会先看 code 是否为 1，缺字段就直接当失败处理，
  // 连 class 都不会去读 —— 表现同样是"没有分类菜单"。
  if (ac === 'list' || ac === '') {
    return NextResponse.json(
      {
        code: 1,
        msg: '数据列表',
        page: 1,
        pagecount: 1,
        limit: 0,
        total: 0,
        class: STANDARD_CATEGORIES.map((category) => ({
          type_id: category.key,
          type_name: category.name,
        })),
        list: [],
      },
      { headers: JSON_HEADERS }
    );
  }

  return NextResponse.json(
    { code: 1, msg: '数据列表', class: [], list: [] },
    { headers: JSON_HEADERS }
  );
}
