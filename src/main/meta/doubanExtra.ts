// src/main/meta/doubanExtra.ts — 详情页「相关推荐 / 豆瓣影评」。
//
// 为什么新增这条链路（而不是复用既有 `meta:extra`）：`meta:extra` 是 **TMDB-only**（无用户自带
//   凭据时恒返回 null，见 SpiderHost.metaExtra），而本区块要求「开箱可用」—— 豆瓣 rexxar 无需凭据。
//
// 端点实测（勿凭印象改）：
//   · **条目 id**：`https://movie.douban.com/j/subject_suggest?q=<片名>` → 200，裸数组
//       `[{id,title,year,type,img,sub_title}]`。注意：rexxar 的 `/search` 现在返回
//       `403 {"msg":"need_login","code":103}`，**不能**用它取 id（doubanSearchTitle 目前就是走这条、已失效），
//       故这里改用 subject_suggest（未登录可用）。
//   · **相关推荐**：`{movie|tv}/{id}/recommendations?start=0&count=12&for_mobile=1` → 200，**裸数组**
//       `[{id,title,type,card_subtitle,pic:{large,normal},rating:{value},url}]` —— 条目里**没有 intro**。
//   · **影评**：`{movie|tv}/{id}/reviews?start=0&count=6&order=hot&for_mobile=1` → 200，
//       `{reviews:[{id,title,abstract,rating:{value}(1~5),useful_count,comments_count,user:{name},create_time,url}]}`。
//   · **梗概（intro）**：推荐条目不自带 ⇒ 逐条 `{movie|tv}/{id}?for_mobile=1` 取 `intro`（实测 130~220 字，
//       适合当「梗概」）；并发 4、单项失败即空 ⇒ UI 退用该条的 `card_subtitle`。
//
// 口径：**全部失败返回 null / 空数组，绝不抛**（与 meta 其余链路一致）；rexxar 403/429 复用
//   doubanProvider 的会话熔断（同一 host，同一风控）。
import { LOCAL_PROXY_BASE } from '../../shared/constants';
import type {
  DoubanDetailExtra,
  DoubanExtraItem,
  DoubanReviewBlock,
  DoubanReviewDetail,
  DoubanReviewItem,
  Logger,
} from '../../shared/types';
import { doubanBreakerOpen, doubanJson, noteDoubanStatus } from './doubanProvider';
// 年份提取复用发现页那支（同一份 `card_subtitle` 口径，勿另写一份）
import { yearFromCardSubtitle } from './doubanExplore';

const SUGGEST_API = 'https://movie.douban.com/j/subject_suggest';
const REX = 'https://m.douban.com/rexxar/api/v2';
const IMG_PROXY = `${LOCAL_PROXY_BASE}/img`;

/** 相关推荐条数上限 / 影评条数上限（详情页下方，竖版列表，取少而精） */
export const MAX_RECS = 8;
export const MAX_REVIEWS = 6;
/** 单条梗概截断长度（一行式） */
export const OVERVIEW_MAX = 120;
/** 详情页进出频繁 → 内存缓存 TTL（不写盘，避免污染 meta.json 的封面缓存键） */
const CACHE_TTL_MS = 6 * 3600 * 1000;

// ---------------------------------------------------------------- 纯函数（供单测）

interface SuggestRow {
  id?: string | number;
  title?: string;
  year?: string;
  type?: string;
  img?: string;
}

export interface DoubanSubjectRef {
  id: string;
  mediaType: 'movie' | 'tv';
  title: string;
}

/** 片名归一：NFKC + 小写 + 去空白/标点（与 doubanProvider.matchingDoubanCovers 同口径） */
export function normalizeTitle(value: string): string {
  return String(value || '').normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
}

/**
 * 从 subject_suggest 结果里挑出当前片对应的条目（纯函数）。
 * 分层（先严后宽）：① 同名 + 同年 → ② 仅同名 → ③ 互含（源片名常带「第一季」「（2023）」等后缀）。
 * 第 ② 层刻意忽略年份：豆瓣条目年份与源标注年份常差一年（首映年 vs 上线年），过严会整体取不到。
 * 只接受 `type` 为 movie|tv 且 id 为纯数字的行。
 */
export function pickDoubanSubject(rows: unknown, name: string, year?: string): DoubanSubjectRef | null {
  if (!Array.isArray(rows)) return null;
  const want = normalizeTitle(name);
  if (!want) return null;
  const wantYear = /^\d{4}$/.test(String(year || '')) ? String(year) : '';
  const usable = (rows as SuggestRow[]).filter((r) => {
    const t = String(r?.type ?? '');
    return (t === 'movie' || t === 'tv') && /^\d{5,}$/.test(String(r?.id ?? ''));
  });
  if (!usable.length) return null;
  const asRef = (r: SuggestRow): DoubanSubjectRef => ({
    id: String(r.id),
    mediaType: r.type === 'tv' ? 'tv' : 'movie',
    title: String(r.title ?? '').trim(),
  });
  if (wantYear) {
    const hit = usable.find((r) => normalizeTitle(String(r.title ?? '')) === want && String(r.year || '') === wantYear);
    if (hit) return asRef(hit);
  }
  const sameTitle = usable.find((r) => normalizeTitle(String(r.title ?? '')) === want);
  if (sameTitle) return asRef(sameTitle);
  const contains = usable.find((r) => {
    const t = normalizeTitle(String(r.title ?? ''));
    return !!t && (t.includes(want) || want.includes(t));
  });
  return contains ? asRef(contains) : null;
}

/** 把一行文本压成单行、去掉多余空白并截断（梗概/摘要共用） */
export function oneLine(text: string, max: number): string {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

interface RecRow {
  id?: string | number;
  title?: string;
  type?: string;
  card_subtitle?: string;
  pic?: { large?: string; normal?: string };
  rating?: { value?: number };
  url?: string;
  sharing_url?: string;
}

/**
 * 解析 `{movie|tv}/{id}/recommendations` 响应（纯函数）。
 * 该端点返回的是**裸数组**（不是 `{recommendations:[…]}`）；两种形态都兼容。
 * 无 id / 无标题的条目跳过（详情页列表必须有可点的条目）。
 */
export function parseDoubanRecommendations(json: unknown): DoubanExtraItem[] {
  const rows = Array.isArray(json)
    ? json
    : (Array.isArray((json as { recommendations?: unknown } | null)?.recommendations)
      ? (json as { recommendations: unknown[] }).recommendations
      : []);
  const out: DoubanExtraItem[] = [];
  const seen = new Set<string>();
  for (const raw of rows as RecRow[]) {
    const id = String(raw?.id ?? '').trim();
    const title = String(raw?.title ?? '').trim();
    if (!/^\d{5,}$/.test(id) || !title || seen.has(id)) continue;
    seen.add(id);
    const subtitle = String(raw?.card_subtitle ?? '').trim();
    const poster = String(raw?.pic?.large || raw?.pic?.normal || '').trim();
    const rating = Number(raw?.rating?.value);
    out.push({
      id,
      title,
      year: yearFromCardSubtitle(subtitle),
      poster: relayImg(poster),
      overview: '',
      subtitle,
      ...(Number.isFinite(rating) && rating > 0 ? { rating } : {}),
      mediaType: raw?.type === 'tv' ? 'tv' : 'movie',
      url: String(raw?.url || raw?.sharing_url || '').trim(),
    });
  }
  return out;
}

interface ReviewRow {
  id?: string | number;
  title?: string;
  abstract?: string;
  rating?: { value?: number };
  useful_count?: number;
  comments_count?: number;
  create_time?: string;
  url?: string;
  sharing_url?: string;
  user?: { name?: string };
  author?: { name?: string };
}

/** 解析 `{movie|tv}/{id}/reviews` 响应（纯函数）：`{reviews:[…]}`。 */
export function parseDoubanReviews(json: unknown): DoubanReviewItem[] {
  const rows = (json as { reviews?: unknown } | null)?.reviews;
  if (!Array.isArray(rows)) return [];
  const out: DoubanReviewItem[] = [];
  const seen = new Set<string>();
  for (const raw of rows as ReviewRow[]) {
    const id = String(raw?.id ?? '').trim();
    const title = String(raw?.title ?? '').trim();
    if (!id || !title || seen.has(id)) continue;
    seen.add(id);
    const rating = Number(raw?.rating?.value);
    const author = String(raw?.user?.name ?? raw?.author?.name ?? '').trim();
    out.push({
      id,
      title,
      abstract: oneLine(String(raw?.abstract ?? ''), 220),
      ...(Number.isFinite(rating) && rating > 0 ? { rating } : {}),
      useful: Number(raw?.useful_count) || 0,
      comments: Number(raw?.comments_count) || 0,
      author,
      date: String(raw?.create_time ?? '').trim(),
      url: String(raw?.url || raw?.sharing_url || '').trim(),
    });
  }
  return out;
}

/** 豆瓣 `intro` 响应 → 一行式梗概（纯函数）：`{intro}`，取不到返回空串。 */
export function parseDoubanIntro(json: unknown): string {
  const intro = String((json as { intro?: unknown } | null)?.intro ?? '').trim();
  return intro ? oneLine(intro, OVERVIEW_MAX) : '';
}

/** 影评正文里的图片占位标记（`<img id="img_XXX">` → `[[IMG:XXX]]`，见 parseDoubanReviewDetail） */
const IMG_TOKEN = /^\[\[IMG:([\w-]+)\]\]$/;

/** 极简实体解码（豆瓣正文只出现这几类；**不做通用 HTML 解析**，见下方 strip 说明） */
function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/&#(\d{2,5});/g, (_m, code) => String.fromCodePoint(Number(code)));
}

/**
 * 豆瓣影评全文 → 正文块（纯函数）。
 * 为什么不用通用 HTML 解析：正文是**豆瓣自己的富文本**，我们只需要「段落 + 图片」两种块；
 *   且**绝不能把远端 HTML 直接交给渲染层**（`dangerouslySetInnerHTML` = XSS 面）。
 *   做法：① `<img id="img_X">` → 标记；② 块级闭合标签与 `<br>` → 换行；③ 其余标签一律剥掉；
 *   ④ 按行切块（`[[IMG:X]]` 单独成块 → 图片块，其余 → 文本段落），图片地址由 `photos[]` 按 id 还原。
 */
export function parseReviewBlocks(content: string, photos: unknown): DoubanReviewBlock[] {
  // 图片地址表：`photos[].{id, description, image:{large:{url}, normal}}`
  const imgMap = new Map<string, { url: string; caption: string }>();
  if (Array.isArray(photos)) {
    for (const p of photos as Array<{ id?: unknown; description?: unknown; image?: { large?: { url?: string }; normal?: { url?: string } } }>) {
      const id = String(p?.id ?? '').trim();
      const url = String(p?.image?.large?.url || p?.image?.normal?.url || '').trim();
      if (id && /^https?:\/\//i.test(url)) imgMap.set(id, { url, caption: String(p?.description ?? '').trim() });
    }
  }
  let html = String(content || '');
  if (!html) return [];
  // ① 图片占位（豆瓣的 <img> 只有 id，没有 src）
  html = html.replace(/<img[^>]*\bid=["']img_(?<pid>[\w-]+)["'][^>]*>/gi, (_m, pid) => `\n[[IMG:${pid}]]\n`);
  html = html.replace(/<img[^>]*>/gi, '\n'); // 无 id 的图（多为样式图/表情）直接丢弃
  // ② 块级边界 → 换行
  html = html.replace(/<\s*br\s*\/?\s*>/gi, '\n').replace(/<\s*\/\s*(p|div|blockquote|li|h[1-6])\s*>/gi, '\n').replace(/<\s*hr[^>]*>/gi, '\n');
  // ③ 其余标签剥掉 → 解码实体
  const text = decodeEntities(html.replace(/<[^>]*>/g, ''));
  const blocks: DoubanReviewBlock[] = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/\s+/g, ' ').trim();
    if (!line) continue;
    const m = IMG_TOKEN.exec(line);
    if (m) {
      const hit = imgMap.get(m[1]);
      if (hit) blocks.push({ type: 'image', url: relayImg(hit.url), ...(hit.caption ? { caption: hit.caption } : {}) });
      continue;
    }
    blocks.push({ type: 'text', text: line });
  }
  return blocks;
}

/**
 * 解析 `rexxar/api/v2/review/{id}?for_mobile=1` 响应（纯函数）→ 影评全文。
 * `title` / `user.name` / `rating.value`(1~5) / `create_time` / `useful_count` / `comments_count` / `spoiler`。
 * 正文为空（或只有图片占位却无图）即视为无内容 → null。
 */
export function parseDoubanReviewDetail(json: unknown): DoubanReviewDetail | null {
  const j = json as Record<string, unknown> | null;
  const id = String(j?.id ?? '').trim();
  if (!id) return null;
  const blocks = parseReviewBlocks(String(j?.content ?? ''), j?.photos);
  if (!blocks.length) return null;
  const rating = Number((j?.rating as { value?: unknown } | undefined)?.value);
  const user = j?.user as { name?: unknown } | undefined;
  const author = String(user?.name ?? '').trim();
  return {
    id,
    title: String(j?.title ?? '').trim(),
    author,
    ...(Number.isFinite(rating) && rating > 0 ? { rating } : {}),
    date: String(j?.create_time ?? '').trim(),
    useful: Number(j?.useful_count) || 0,
    comments: Number(j?.comments_count) || 0,
    url: String(j?.url ?? j?.sharing_url ?? '').trim(),
    spoiler: j?.spoiler === true,
    blocks,
  };
}

/** 封面统一经本地 `/img` 中继（与 TMDB/豆瓣封面同口径：渲染层直连图床易被 DNS 污染/防盗链） */
export function relayImg(url: string): string {
  const u = String(url || '').trim();
  if (!u) return '';
  if (u.includes(`${IMG_PROXY}?u=`)) return u; // 已是中继地址 → 不套两层
  return `${IMG_PROXY}?u=${encodeURIComponent(u)}`;
}

/** 有限并发映射（详情页推荐条目取梗概用；单项失败不影响其它项） */
async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

// ---------------------------------------------------------------- 取数编排

const cache = new Map<string, { t: number; data: DoubanDetailExtra | null }>();
/** 影评全文单独一张缓存表（键 `rv:<id>`；正文较长，TTL 24h —— 已发布的影评基本不变） */
const reviewCache = new Map<string, { t: number; data: DoubanReviewDetail | null }>();
const REVIEW_CACHE_TTL_MS = 24 * 3600 * 1000;

/** 测试用：清空内存缓存（不触碰网络） */
export function __clearDoubanExtraCacheForTest(): void {
  cache.clear();
  reviewCache.clear();
}

/** 按片名取豆瓣条目 id（subject_suggest；未登录可用，不做熔断计次） */
async function fetchSubject(logger: Logger, name: string): Promise<DoubanSubjectRef | null> {
  const resp = await doubanJson(`${SUGGEST_API}?q=${encodeURIComponent(name)}`, 10000);
  if (resp.status !== 200) {
    if (resp.status !== 0) logger.w(`meta:豆瓣 suggest 失败 status=${resp.status}`);
    return null;
  }
  try {
    return pickDoubanSubject(JSON.parse(resp.text), name);
  } catch {
    return null;
  }
}

/** rexxar GET + 熔断计次（供推荐/影评/intro 复用） */
async function rexxar(logger: Logger, path: string, timeoutMs: number): Promise<unknown | null> {
  const resp = await doubanJson(`${REX}/${path}`, timeoutMs);
  if (resp.status !== 200) {
    if (resp.status !== 0 && noteDoubanStatus(resp.status)) {
      logger.w(`meta:豆瓣 ${path.split('?')[0]} 触发风控熔断（status=${resp.status}）`);
    }
    return null;
  }
  noteDoubanStatus(200);
  try {
    return JSON.parse(resp.text);
  } catch {
    return null;
  }
}

/**
 * 详情页「相关推荐 + 豆瓣影评」查询（渲染层 tab 区块用）。
 * - 无豆瓣命中 / 风控熔断中 → **null**（区块整体不渲染，不报错、不留空壳）；
 * - 相关推荐与影评**并行**取；推荐条目再并发补 `intro` 梗概（失败即空 ⇒ UI 退用 card_subtitle）；
 * - 内存缓存 6h（详情页来回进出不重复打豆瓣）。
 */
export async function doubanDetailExtra(logger: Logger, name: string, year?: string): Promise<DoubanDetailExtra | null> {
  const n = (name || '').trim();
  if (!n) return null;
  const cacheKey = `${n}|${year || ''}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.t < CACHE_TTL_MS) return hit.data;
  if (doubanBreakerOpen()) return null; // rexxar 风控中：推荐/影评/梗概全取不到，直接放弃
  try {
    const ref = await fetchSubject(logger, n);
    if (!ref) {
      cache.set(cacheKey, { t: Date.now(), data: null });
      return null;
    }
    const base = `${ref.mediaType}/${ref.id}`;
    const [recJson, rvJson] = await Promise.all([
      rexxar(logger, `${base}/recommendations?start=0&count=12&for_mobile=1`, 12000),
      rexxar(logger, `${base}/reviews?start=0&count=${MAX_REVIEWS}&order=hot&for_mobile=1`, 12000),
    ]);
    const recommendations = parseDoubanRecommendations(recJson).slice(0, MAX_RECS);
    const reviews = parseDoubanReviews(rvJson).slice(0, MAX_REVIEWS);
    // 推荐条目无 intro ⇒ 逐条取（并发 4；取不到就留空，UI 用 subtitle 兜底）
    const withIntro = await mapPool(recommendations, 4, async (item) => {
      const j = await rexxar(logger, `${item.mediaType}/${item.id}?for_mobile=1`, 10000);
      return j ? { ...item, overview: parseDoubanIntro(j) } : item;
    });
    const data: DoubanDetailExtra = { id: ref.id, recommendations: withIntro, reviews };
    if (!data.recommendations.length && !data.reviews.length) {
      logger.i?.(`meta:豆瓣增强「${n}」无数据（id=${ref.id}）`);
    } else {
      logger.i?.(`meta:豆瓣增强「${n}」→ 推荐 ${data.recommendations.length} 条 / 影评 ${data.reviews.length} 条（id=${ref.id}）`);
    }
    cache.set(cacheKey, { t: Date.now(), data });
    return data;
  } catch (e) {
    logger.w(`meta:豆瓣增强查询异常: ${(e as Error).message}`);
    return null;
  }
}

/**
 * 影评**全文**（点影评行 → 独立小窗口展示）。
 * **按需拉取**（列表只带 220 字摘要，全文 25KB 级 ⇒ 绝不随列表预取）；内存缓存 24h。
 * 失败 / 风控中 / 无正文一律 null（窗口显示「打不开」并给出「在豆瓣打开」出口），绝不抛。
 */
export async function doubanReviewDetail(logger: Logger, reviewId: string): Promise<DoubanReviewDetail | null> {
  const id = String(reviewId || '').trim();
  if (!/^\d{5,}$/.test(id)) return null;
  const hit = reviewCache.get(id);
  if (hit && Date.now() - hit.t < REVIEW_CACHE_TTL_MS) return hit.data;
  if (doubanBreakerOpen()) return null;
  try {
    const j = await rexxar(logger, `review/${id}?for_mobile=1`, 15000);
    const data = j ? parseDoubanReviewDetail(j) : null;
    if (data) logger.i?.(`meta:豆瓣影评全文「${data.title}」→ ${data.blocks.length} 块（${data.blocks.filter((b) => b.type === 'image').length} 图）`);
    reviewCache.set(id, { t: Date.now(), data });
    return data;
  } catch (e) {
    logger.w(`meta:豆瓣影评全文查询异常: ${(e as Error).message}`);
    return null;
  }
}
