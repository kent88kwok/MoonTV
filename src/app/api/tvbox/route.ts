import { NextRequest, NextResponse } from 'next/server';

import {
  buildSubscription,
  getRequestOrigin,
  handleCmsRequest,
  proxyImage,
  serveSpiderJar,
  TVBOX_TOKEN_KEYS,
  verifyToken,
} from '@/lib/tvbox';

export const runtime = 'edge';

const JSON_HEADERS: Record<string, string> = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store, no-cache, must-revalidate',
};

function readToken(request: NextRequest): string {
  const { searchParams } = request.nextUrl;
  for (const key of TVBOX_TOKEN_KEYS) {
    const value = searchParams.get(key);
    if (value) {
      return value;
    }
  }
  return '';
}

/**
 * TVBox 接口（查询式）。
 *
 * - 订阅地址： /api/tvbox?ac=config&pwd=你的站点密码
 * - 插件 jar： /api/tvbox?ac=jar（同 /api/tvbox/spider.jar，便于浏览器自测）
 * - 图片代理： /api/tvbox?ac=img&pwd=你的站点密码&url=编码后的图片地址
 * - CMS 数据： /api/tvbox?pwd=你的站点密码&ac=videolist&wd=关键词
 *
 * TVBox 实际使用的主要是路径式入口（见 ./[token]/route.ts），
 * 本入口用于生成订阅、代理封面，并兼容把口令写在查询串里的客户端。
 */
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const token = readToken(request);
  const origin = getRequestOrigin(request);

  // 插件 jar 与业务数据无关，无需口令（同 /api/tvbox/spider.jar）。
  if (searchParams.get('ac') === 'jar') {
    return serveSpiderJar();
  }

  // 图片代理必须带口令，否则站点会沦为开放的公共图床。
  if (searchParams.get('ac') === 'img') {
    if (!verifyToken(token)) {
      return new NextResponse('Unauthorized', { status: 401 });
    }
    return proxyImage(searchParams.get('url') || '');
  }

  if (!verifyToken(token)) {
    return NextResponse.json(
      {
        error: '口令无效或未提供',
        hint: '订阅地址需形如 /api/tvbox?ac=config&pwd=<你的站点登录密码>',
      },
      { status: 401, headers: JSON_HEADERS }
    );
  }

  if (searchParams.get('ac') === 'config') {
    return NextResponse.json(buildSubscription(origin, token), {
      headers: JSON_HEADERS,
    });
  }

  return handleCmsRequest(request, { origin, token });
}
