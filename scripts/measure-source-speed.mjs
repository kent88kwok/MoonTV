#!/usr/bin/env node
/**
 * 在电视上实测各采集站线路的下载速度，生成 src/lib/tvbox-source-speed.json。
 *
 * 为什么不在服务端猜：
 *   一开始想用「播放域名是否解析到境内 IP」排序，实测不可靠 —— 采集站 CDN 的
 *   GeoDNS 对阿里 DoH（即使用你的网段做 ECS）和对你家路由器的解析结果并不一致：
 *   例如 vod1.maowushi.com 经 DoH 返回 209.142.71.11（美国），而电视自己解析到
 *   59.37.89.219（国内），实际播放很流畅。拿 DNS 判属地会系统性判错。
 *
 * 所以这里取真值：把同一个分片下载两次，量电视到该 CDN 的真实吞吐。
 *   片源码率是已知的（3000k ≈ 300KB/s），这个数字直接决定会不会卡。
 *
 * 用法：node scripts/measure-source-speed.mjs [--device 192.168.2.174:5555] [--samples 1]
 *   需要电视已开启「网络调试」并 adb connect。测完建议关掉。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'src/lib/tvbox-source-speed.json');

const argv = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const DEVICE = argOf('device', '192.168.2.174:5555');
const SAMPLES = Number(argOf('samples', '1'));

const TMP = '/data/local/tmp/spd.ts';

function loadSources() {
  for (const name of ['sources_import.json', 'config.json']) {
    const p = resolve(ROOT, name);
    if (!existsSync(p)) continue;
    const data = JSON.parse(readFileSync(p, 'utf8'));
    const list = Array.isArray(data) ? data : data.SourceConfig;
    if (Array.isArray(list) && list.length) {
      return list
        .filter((s) => !s.disabled && s.api)
        .map((s) => ({ key: s.key, name: s.name, api: s.api }));
    }
  }
  return [];
}

const withQuery = (api, q) => api + (api.includes('?') ? '&' : '?') + q;

async function fetchText(url, timeoutMs = 15000) {
  const r = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.text();
}

/** 取该源第一条带播放地址的条目的第 2 个分片（避开首片可能的预加载差异） */
async function sampleUrlOf(site) {
  const data = JSON.parse(await fetchText(withQuery(site.api, 'ac=videolist&pg=1')));
  const list = Array.isArray(data?.list) ? data.list : [];
  for (const item of list) {
    const m = /https?:\/\/[^\s#$"'<>]+\.m3u8[^\s#$"'<>]*/.exec(item?.vod_play_url || '');
    if (!m) continue;
    try {
      const seg = await pickSegment(m[0]);
      if (seg) return seg;
    } catch {
      continue;
    }
  }
  return '';
}

/**
 * 从 m3u8 里取一个可下载的分片。
 * 注意多数采集站给的是 master playlist（里面是各码率的子 playlist），
 * 必须先解一层，否则取到的是 .m3u8 而不是 .ts，wget 会直接失败。
 */
async function pickSegment(m3u8Url, depth = 0) {
  if (depth > 2) return '';
  const body = await fetchText(m3u8Url);
  const lines = body
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));

  // 子 playlist：按 BANDWIDTH 选最高码率那一档
  const variants = lines.filter((l) => /\.m3u8(\?|$)/i.test(l));
  if (variants.length > 0) {
    let best = variants[0];
    let bestBw = -1;
    const raw = body.split('\n');
    for (let i = 0; i < raw.length; i++) {
      if (!/^#EXT-X-STREAM-INF/i.test(raw[i].trim())) continue;
      const next = (raw[i + 1] || '').trim();
      if (!next || next.startsWith('#')) continue;
      const bw = Number((/BANDWIDTH=(\d+)/i.exec(raw[i]) || [])[1] || 0);
      if (bw > bestBw) {
        bestBw = bw;
        best = next;
      }
    }
    return pickSegment(new URL(best, m3u8Url).toString(), depth + 1);
  }

  const seg = lines[1] || lines[0];
  return seg ? new URL(seg, m3u8Url).toString() : '';
}

/**
 * 在电视上 wget 一个分片，返回 KB/s。
 * 用 /proc/uptime（有小数秒）计时 —— 这台 Android 6 的 date 不支持 %N，
 * 曾经因此算出 0 并被误判成「所有源都很慢」。
 */
async function measureOnTv(url) {
  // 这台电视（Android 6 / toybox）的 wget 不支持 HTTPS，只能走 http。
  // 多数采集站 CDN 同时监听 80，协议不影响吞吐判断。
  const target = url.replace(/^https:/i, 'http:');
  const cmd =
    "S=$(cut -d' ' -f1 /proc/uptime); wget -q -T 15 -O " +
    TMP +
    " '" +
    target +
    "' 2>/dev/null; E=$(cut -d' ' -f1 /proc/uptime); " +
    'SZ=$(stat -c %s ' +
    TMP +
    ' 2>/dev/null || echo 0); echo "$S $E $SZ"';
  const { stdout } = await run('adb', ['-s', DEVICE, 'shell', cmd], {
    timeout: 45000,
  });
  const parts = stdout.trim().split(/\s+/);
  const start = Number(parts[0] || 0);
  const end = Number(parts[1] || 0);
  const size = Number(parts[2] || 0);
  const seconds = end - start;
  if (!(seconds > 0) || !size) return 0;
  return Math.round(size / seconds / 1024); // KB/s
}

(async () => {
  const sources = loadSources();
  if (!sources.length) {
    console.error('没找到源列表（sources_import.json / config.json）');
    process.exit(1);
  }
  console.log('设备:', DEVICE, '| 源数:', sources.length, '| 每源样本:', SAMPLES);

  const kbps = {};
  const detail = {};
  const failed = [];
  for (const site of sources) {
    let url = '';
    try {
      url = await sampleUrlOf(site);
    } catch (e) {
      console.log('  ' + site.key.padEnd(10) + '取地址失败: ' + e.message);
      continue;
    }
    if (!url) {
      console.log('  ' + site.key.padEnd(10) + '无 m3u8 地址');
      continue;
    }
    const samples = [];
    for (let i = 0; i < SAMPLES; i++) {
      try {
        samples.push(await measureOnTv(url));
      } catch (e) {
        samples.push(0);
      }
    }
    // 用中位数，避免偶发的一次抖动决定结论
    samples.sort((a, b) => a - b);
    const value = samples[Math.floor(samples.length / 2)] || 0;
    if (value <= 0) {
      // 测不出来就当没测过（unknown），不要写成 0 被当成"很慢"
      failed.push(site.key);
      console.log('  ' + site.key.padEnd(10) + '    测量失败（不写入表）  ' + (site.name || ''));
      continue;
    }
    kbps[site.key] = value;
    detail[site.key] = { name: site.name, url: url.slice(0, 120) };
    console.log('  ' + site.key.padEnd(10) + String(value).padStart(6) + ' KB/s   ' + (site.name || ''));
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    device: DEVICE,
    note: '电视端实测的线路下载速度（KB/s，中位数）。3000k 片源约需 300KB/s 才不卡。由 scripts/measure-source-speed.mjs 生成。',
    kbps,
    detail,
    failed,
  };
  writeFileSync(OUT, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  console.log('\n已写入', OUT);
})();
