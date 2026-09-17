import { DoubanItem, DoubanResult } from './types';
import { getDoubanProxyUrl } from './utils';

interface DoubanCategoriesParams {
  kind: 'tv' | 'movie';
  category: string;
  type: string;
  pageLimit?: number;
  pageStart?: number;
}

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

/**
 * 带超时的 fetch 请求
 */
async function fetchWithTimeout(
  url: string,
  options: RequestInit = {}
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000); // 10秒超时

  // 检查是否使用代理
  const proxyUrl = getDoubanProxyUrl();
  const finalUrl = proxyUrl ? `${proxyUrl}${encodeURIComponent(url)}` : url;

  const fetchOptions: RequestInit = {
    ...options,
    signal: controller.signal,
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
      Referer: 'https://movie.douban.com/',
      Accept: 'application/json, text/plain, */*',
      ...options.headers,
    },
  };

  try {
    const response = await fetch(finalUrl, fetchOptions);
    clearTimeout(timeoutId);
    return response;
  } catch (error) {
    clearTimeout(timeoutId);
    throw error;
  }
}

/**
 * 检查是否应该使用客户端获取豆瓣数据
 */
export function shouldUseDoubanClient(): boolean {
  return getDoubanProxyUrl() !== null;
}

/**
 * 触发全局错误提示
 */
function emitGlobalError(message: string): void {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(
      new CustomEvent('globalError', {
        detail: { message },
      })
    );
  }
}

/**
 * 【内核】浏览器端豆瓣分类数据获取，不做错误提示（供回退逻辑判断使用）
 * 注意：豆瓣不返回 CORS 头，因此该函数必须经由代理（proxyUrl）才能成功；
 * 若未配置代理或代理已失效，它一定会抛错 —— 调用方应回退到服务端 API。
 */
async function fetchDoubanCategoriesRaw(
  params: DoubanCategoriesParams
): Promise<DoubanResult> {
  const { kind, category, type, pageLimit = 20, pageStart = 0 } = params;

  // 验证参数
  if (!['tv', 'movie'].includes(kind)) {
    throw new Error('kind 参数必须是 tv 或 movie');
  }

  if (!category || !type) {
    throw new Error('category 和 type 参数不能为空');
  }

  if (pageLimit < 1 || pageLimit > 100) {
    throw new Error('pageLimit 必须在 1-100 之间');
  }

  if (pageStart < 0) {
    throw new Error('pageStart 不能小于 0');
  }

  const target = `https://m.douban.com/rexxar/api/v2/subject/recent_hot/${kind}?start=${pageStart}&limit=${pageLimit}&category=${category}&type=${type}`;

  const response = await fetchWithTimeout(target);

  if (!response.ok) {
    throw new Error(`HTTP error! Status: ${response.status}`);
  }

  const doubanData: DoubanCategoryApiResponse = await response.json();

  // 转换数据格式
  const list: DoubanItem[] = doubanData.items.map((item) => ({
    id: item.id,
    title: item.title,
    poster: item.pic?.normal || item.pic?.large || '',
    rate: item.rating?.value ? item.rating.value.toFixed(1) : '',
    year: item.card_subtitle?.match(/(\d{4})/)?.[1] || '',
  }));

  return {
    code: 200,
    message: '获取成功',
    list: list,
  };
}

/**
 * 浏览器端豆瓣分类数据获取函数（对外，含全局错误提示）
 */
export async function fetchDoubanCategories(
  params: DoubanCategoriesParams
): Promise<DoubanResult> {
  try {
    return await fetchDoubanCategoriesRaw(params);
  } catch (error) {
    emitGlobalError('获取豆瓣分类数据失败');
    throw new Error(`获取豆瓣分类数据失败: ${(error as Error).message}`);
  }
}

/**
 * 服务端 API 兜底：/api/douban/categories
 */
async function fetchDoubanCategoriesFromServer(
  params: DoubanCategoriesParams
): Promise<DoubanResult> {
  const { kind, category, type, pageLimit = 20, pageStart = 0 } = params;
  const response = await fetch(
    `/api/douban/categories?kind=${kind}&category=${category}&type=${type}&limit=${pageLimit}&start=${pageStart}`
  );

  if (!response.ok) {
    throw new Error('获取豆瓣分类数据失败');
  }

  return response.json();
}

/**
 * 统一的豆瓣分类数据获取函数。
 *
 * 策略（自愈设计）：
 *   1. 未配置代理 URL → 直接走服务端 API（推荐路径，服务端不受 CORS 限制）
 *   2. 配置了代理 URL → 先尝试客户端代理获取；
 *      一旦失败（代理失效 / 死链 / CORS），自动回退到服务端 API，
 *      避免因为浏览器里残留的旧代理地址导致「豆瓣整块不可用」。
 */
export async function getDoubanCategories(
  params: DoubanCategoriesParams
): Promise<DoubanResult> {
  if (shouldUseDoubanClient()) {
    try {
      return await fetchDoubanCategoriesRaw(params);
    } catch (clientError) {
      console.warn(
        '[douban] 客户端代理获取分类失败，已自动回退服务端 API：',
        clientError
      );
    }
  }

  try {
    return await fetchDoubanCategoriesFromServer(params);
  } catch (serverError) {
    emitGlobalError('获取豆瓣分类数据失败');
    throw serverError;
  }
}

interface DoubanListParams {
  tag: string;
  type: string;
  pageLimit?: number;
  pageStart?: number;
}

/**
 * 【内核】浏览器端豆瓣列表数据获取，不做错误提示
 */
async function fetchDoubanListRaw(
  params: DoubanListParams
): Promise<DoubanResult> {
  const { tag, type, pageLimit = 20, pageStart = 0 } = params;

  // 验证参数
  if (!tag || !type) {
    throw new Error('tag 和 type 参数不能为空');
  }

  if (!['tv', 'movie'].includes(type)) {
    throw new Error('type 参数必须是 tv 或 movie');
  }

  if (pageLimit < 1 || pageLimit > 100) {
    throw new Error('pageLimit 必须在 1-100 之间');
  }

  if (pageStart < 0) {
    throw new Error('pageStart 不能小于 0');
  }

  const target = `https://movie.douban.com/j/search_subjects?type=${type}&tag=${tag}&sort=recommend&page_limit=${pageLimit}&page_start=${pageStart}`;

  const response = await fetchWithTimeout(target);

  if (!response.ok) {
    throw new Error(`HTTP error! Status: ${response.status}`);
  }

  const doubanData: DoubanCategoryApiResponse = await response.json();

  // 转换数据格式
  const list: DoubanItem[] = doubanData.items.map((item) => ({
    id: item.id,
    title: item.title,
    poster: item.pic?.normal || item.pic?.large || '',
    rate: item.rating?.value ? item.rating.value.toFixed(1) : '',
    year: item.card_subtitle?.match(/(\d{4})/)?.[1] || '',
  }));

  return {
    code: 200,
    message: '获取成功',
    list: list,
  };
}

/**
 * 服务端 API 兜底：/api/douban
 */
async function fetchDoubanListFromServer(
  params: DoubanListParams
): Promise<DoubanResult> {
  const { tag, type, pageLimit = 20, pageStart = 0 } = params;
  const response = await fetch(
    `/api/douban?tag=${tag}&type=${type}&pageSize=${pageLimit}&pageStart=${pageStart}`
  );

  if (!response.ok) {
    throw new Error('获取豆瓣列表数据失败');
  }

  return response.json();
}

/**
 * 统一的豆瓣列表数据获取函数（同样带服务端自动回退）
 */
export async function getDoubanList(
  params: DoubanListParams
): Promise<DoubanResult> {
  if (shouldUseDoubanClient()) {
    try {
      return await fetchDoubanListRaw(params);
    } catch (clientError) {
      console.warn(
        '[douban] 客户端代理获取列表失败，已自动回退服务端 API：',
        clientError
      );
    }
  }

  try {
    return await fetchDoubanListFromServer(params);
  } catch (serverError) {
    emitGlobalError('获取豆瓣列表数据失败');
    throw serverError;
  }
}

/**
 * 浏览器端豆瓣列表数据获取函数（对外，含全局错误提示）
 */
export async function fetchDoubanList(
  params: DoubanListParams
): Promise<DoubanResult> {
  try {
    return await fetchDoubanListRaw(params);
  } catch (error) {
    emitGlobalError('获取豆瓣列表数据失败');
    throw new Error(`获取豆瓣分类数据失败: ${(error as Error).message}`);
  }
}
