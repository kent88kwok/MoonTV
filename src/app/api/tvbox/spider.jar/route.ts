import { serveSpiderJar } from '@/lib/tvbox';

export const runtime = 'edge';

/**
 * TVBox 插件 jar（spider）。
 *
 * 订阅里的 `spider` 字段指向本路由，由边缘代取上游 jar 并做 7 天缓存。
 * 路径带 .jar 后缀是为了兼容那些会按扩展名判断的客户端。
 */
export async function GET() {
  return serveSpiderJar();
}
