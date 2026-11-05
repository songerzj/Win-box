import { useEffect, useMemo, useState } from 'react';
import { client } from '../api/client';
import { wrapImageUrlForRelay } from '../../shared/driveProvider';
import { preloadImage, resolveCover, type CoverRequest } from './coverPick';

export interface CoverItem extends CoverRequest { id: string }
/**
 * 单次挂载允许解析的封面条数上限（默认）。
 *
 * 为什么必须设上限：`resolveCover` 的 `validate` 是 `preloadImage(url)` —— 它会**真实解码**一张图。
 * 之前对 `items` **全量**入队（并发 4 lane 只限制了速度，没限制总量）⇒
 * 500 条历史 / 收藏就解码 500 张封面，解码位图常驻数百 MB。
 * 而虚拟滚动只让 **DOM** 只挂 ~20 张卡，`useCovers` 在 DOM 之外，完全不受虚拟化约束。
 *
 * 有上限也**不会出空白**：`picOf` 对未解析项返回 `item.pic`（源封面）兜底，
 * 只是少了「换成 TMDB 更优图 / 中继」这一层增强。列表按时间倒序，前 N 条覆盖绝大多数使用场景。
 */
export const COVER_PARSE_CAP = 120;
// 同一窗口中的重复片名共享请求；队列限制主进程查询和图片预加载的并发。
const queries = new Map<string, Promise<string>>();
const lanes: Promise<unknown>[] = Array.from({ length: 4 }, () => Promise.resolve());
let lane = 0;
function enqueue<T>(job: () => Promise<T>): Promise<T> {
  const slot = lane++ % lanes.length;
  const pending = lanes[slot].then(job);
  lanes[slot] = pending.catch(() => undefined);
  return pending;
}

/** 所有页面共用封面链路，始终保留原始源图，不把补图写回来源或历史。 */
export function useCovers(items: CoverItem[], enabled = true, cap: number = COVER_PARSE_CAP) {
  const [settings, setSettings] = useState<{ key: string; hasTmdb: boolean } | null>(null);
  const [covers, setCovers] = useState<Record<string, string>>({});
  const [failed, setFailed] = useState<Record<string, string[]>>({});
  const signature = JSON.stringify(items);
  const stableItems: CoverItem[] = useMemo(() => JSON.parse(signature), [signature]);
  useEffect(() => {
    let alive = true;
    let request = 0;
    const load = (): void => {
      const current = ++request;
      void client.metaGetSettings().then(s => {
        if (!alive || current !== request) return;
        const key = JSON.stringify([s.tmdbApiKey, s.tmdbApiBase, s.tmdbImageBase]);
        setSettings(prev => prev?.key === key ? prev : { key, hasTmdb: s.hasUserKey });
      }).catch(() => { if (alive && current === request) setSettings(prev => prev || { key: '', hasTmdb: false }); });
    };
    load();
    const storage = (event: StorageEvent): void => { if (event.key === 'winbox-meta-revision') load(); };
    window.addEventListener('focus', load);
    window.addEventListener('winbox:meta-changed', load);
    window.addEventListener('storage', storage);
    return () => {
      alive = false;
      window.removeEventListener('focus', load);
      window.removeEventListener('winbox:meta-changed', load);
      window.removeEventListener('storage', storage);
    };
  }, []);
  const itemKey = (item: CoverItem): string => JSON.stringify([settings?.key, item.id, item.name, item.year, item.pic]);
  useEffect(() => {
    if (!enabled || !settings) return;
    let alive = true;
    // 只解析前 cap 条（见 COVER_PARSE_CAP 注释）：超出部分由 picOf 的源封面兜底
    for (const item of stableItems.slice(0, cap)) {
      const key = JSON.stringify([settings.key, item.id, item.name, item.year, item.pic]);
      if (covers[key] !== undefined) continue;
      void enqueue(async () => {
        if (!alive) return;
        const cover = await resolveCover(item, {
          hasTmdb: settings.hasTmdb,
          query: provider => {
            if (!item.name.trim()) return Promise.resolve('');
            const queryKey = JSON.stringify([settings.key, provider, item.name, item.year]);
            let job = queries.get(queryKey);
            if (!job) {
              job = client.metaSearch(item.name, item.year, provider).then(hit => hit?.poster || '').catch(() => '');
              if (queries.size >= 500) queries.delete(queries.keys().next().value!);
              queries.set(queryKey, job);
            }
            return job;
          },
          validate: url => failed[key]?.includes(url) ? Promise.resolve(false) : preloadImage(url),
          relay: url => /\/(?:img|file)\?/.test(url) ? '' : wrapImageUrlForRelay(url, navigator.userAgent),
        });
        if (alive) setCovers(prev => ({ ...prev, [key]: cover }));
      });
    }
    return () => { alive = false; };
    // 完成结果不重启批次，避免仍在处理的队列被取消。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stableItems, settings, enabled, failed, cap]);
  return {
    picOf: (item: CoverItem): string => {
      const key = itemKey(item);
      const source = item.pic?.trim() || '';
      return covers[key] ?? (failed[key]?.includes(source) ? '' : source);
    },
    onError: (item: CoverItem, url: string): void => {
      const key = itemKey(item);
      if (failed[key]?.includes(url)) return;
      setFailed(prev => ({ ...prev, [key]: [...(prev[key] || []), url] }));
      setCovers(prev => { const next = { ...prev }; delete next[key]; return next; });
    },
  };
}
