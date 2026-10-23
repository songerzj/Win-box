// src/renderer/lib/imageSize.ts
// （内存专项续 (b)：少解码 —— 已执行）：
//   渲染层在把**豆瓣图床**的海报交给 `<img>`/`background-image` 前，按「显示框 × DPR」把它**降到刚够用的一档**。
//
// 为什么值得做（实测，非估算）：豆瓣图床同样的 photo id 有三档（`.tmp/douban-img-size.cjs` 逐档拉取实测）：
//     `s` / `s_ratio_poster` = **270** 宽（约 38KB）· `m` / `m_ratio_poster` = **540** 宽（约 120KB）· `l` / `raw` = **1080** 宽（约 400KB）
//   而我们的海报框最宽约 200 CSS px（DPR 1.5 ⇒ 只需约 300 物理像素）。
//   实测发现页（隔离实例 + 跑 dist）：「**90 张海报全部是 `m=540`，解码位图合计 146MB**」——
//     而这一整页里真正在屏的只有几张：**是 `useCovers` 的封面校验（`preloadImage` 会真解码）把整列表都解码了**。
//     降到 `s` 后同样 90 张只需约 **38MB**（-74%）。
//
// 三条纪律（勿走样）：
//   ① **只降不升**：目标档位取「够用的最小档」，但绝不大于原档（否则大框会把 `m` 升成 `l`，反而更费）。
//   ② **签名 URL 一律不动**：`*-sign.doubanio.com` 或带 `sign/sig/token` 参数的地址，路径被签名覆盖，改路径必 403。
//   ③ 只有豆瓣 `doubanio.com` 的 `/view/<kind>/<size>/` 路径会被改写；其它图床（TMDB / 源站）原样返回。

/**
 * 豆瓣图床档位表（**实测**，勿凭印象改）：
 * `/view/photo/{s|m|l|raw|*_ratio_poster}/public/pXXX.jpg` —— `s`=270 宽、`m`=540 宽、`l`/`raw`=1080 宽。
 * 升序排列，供「取够用的最小档」用。
 */
export const DOUBAN_IMG_SIZES: ReadonlyArray<{ token: string; width: number }> = [
  { token: 's', width: 270 },
  { token: 'm', width: 540 },
  { token: 'l', width: 1080 },
];

/** 需要的最小物理像素（盒宽 × DPR）允许 10% 欠采样 —— 肉眼不可辨，但能把 `192×1.5=288` 落到 `s(270)` */
const SLACK = 0.9;
/** 当前窗口的 DPR（多显示器拖动后会变 ⇒ 每次现读；用 `globalThis` 而非 `window`：
 *  本模块被单测直接 import，而主进程那套 tsconfig 不含 DOM lib —— 走 globalThis 两边都能编译） */
export function currentDpr(): number {
  try {
    const v = (globalThis as { devicePixelRatio?: number }).devicePixelRatio;
    return typeof v === 'number' && v > 0 ? v : 1;
  } catch {
    return 1;
  }
}

/**
 * @param url    可能是豆瓣原图，也可能是本地 `/img?u=<豆瓣原图>` 中继地址（主进程产出的一律是后者）
 * @param boxCssPx 该图**实际显示**的 CSS 宽度（调用方按该处海报框给常量）
 * @param dpr    设备像素比
 */
export function sizedImageUrl(url: string, boxCssPx: number, dpr: number = currentDpr()): string {
  const raw = String(url || '');
  if (!raw) return raw;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return raw;
  }
  // 本地中继：只换内层 `u`，其余参数（ref 等）原样；内层没变就原样返回
  const inner = u.searchParams.get('u');
  if (inner) {
    const next = shrinkDouban(u.searchParams.get('u') || '', boxCssPx, dpr);
    if (next === inner) return raw;
    u.searchParams.set('u', next);
    return u.toString();
  }
  const next = shrinkDouban(raw, boxCssPx, dpr);
  return next === raw ? raw : next;
}

/** 档位 token → 升序表下标（`raw` 与 `l` 同宽 ⇒ 记为最后一档；不在表里 → -1） */
function sizeIndex(token: string): number {
  if (token === 'raw') return DOUBAN_IMG_SIZES.length - 1;
  return DOUBAN_IMG_SIZES.findIndex((x) => x.token === token);
}

/** 只处理「直接给的豆瓣原图地址」；其它一律原样返回 */
function shrinkDouban(url: string, boxCssPx: number, dpr: number): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return url;
  }
  if (!/(^|\.)doubanio\.com$/i.test(u.hostname)) return url;
  if (/-sign/i.test(u.hostname)) return url; // 签名主机（`xxx-sign.doubanio.com`）：路径被签名，改了必 403
  if (u.search) return url; // 带查询串（可能是签名/追踪参数）⇒ 一律不猜，原样返回
  const m = /^(\/view\/[a-zA-Z_]+\/)(s|m|l|raw)((?:_ratio_[a-zA-Z]+)?)(\/.*)$/.exec(u.pathname);
  if (!m) return url;
  const curIdx = sizeIndex(m[2]);
  if (curIdx < 0) return url;
  const need = boxCssPx * dpr * SLACK;
  // 「够用的最小档」；都不够就用最大档，再与**原档**取小（只降不升）
  const fitIdx = DOUBAN_IMG_SIZES.findIndex((x) => x.width >= need);
  const wantIdx = fitIdx < 0 ? DOUBAN_IMG_SIZES.length - 1 : fitIdx;
  const idx = Math.min(curIdx, wantIdx);
  if (idx === curIdx) return url;
  u.pathname = `${m[1]}${DOUBAN_IMG_SIZES[idx].token}${m[3]}${m[4]}`;
  return u.toString();
}
