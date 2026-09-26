import { NextResponse } from 'next/server';

import { getRequestOrigin, handleCmsRequest, verifyToken } from '@/lib/tvbox';

export const runtime = 'edge';

/**
 * TVBox 接口（路径式）。
 *
 * 订阅生成的站点 api 指向 /api/tvbox/<口令>，TVBox 会在此基础地址后
 * 追加 ?ac=videolist&wd=/&ids= 等参数。口令放在路径段而不放查询串，
 * 是为了兼容各版本 TVBox 拼接查询参数方式不一致的问题
 * （放查询串可能出现 ?pwd=x?ac=... 或参数被覆盖）。
 */
export async function GET(
  request: Request,
  { params }: { params: { token: string } }
) {
  const token = decodeURIComponent(params.token || '');

  if (!verifyToken(token)) {
    return NextResponse.json({ error: '口令无效' }, { status: 401 });
  }

  return handleCmsRequest(request, {
    origin: getRequestOrigin(request),
    token,
  });
}
