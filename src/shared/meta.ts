// src/shared/meta.ts
// 元数据（封面/简介/演职员）来源配置 —— 主进程 Provider 与渲染层配置页共用。
// 封面固定使用：用户配置的 TMDB → 源封面 → 豆瓣 → 暂无封面。
// MetaSource 保留以兼容旧配置，不再控制封面；图片搜索只用于详情背景图。

export type MetaSource = 'auto' | 'tmdb' | 'douban' | 'search';

export interface MetaSettings {
  /** 用户自填 TMDB API Key 或 v4 读访问令牌（空 = 禁用 TMDB） */
  tmdbApiKey: string;
  /** 用户自填 API 代理地址（空 = https://api.themoviedb.org/3） */
  tmdbApiBase: string;
  /** 用户自填图片镜像地址（空 = https://image.tmdb.org/t/p/w342） */
  tmdbImageBase: string;
  /** 元数据来源策略 */
  metaSource: MetaSource;
}

export const DEFAULT_META_SETTINGS: MetaSettings = {
  tmdbApiKey: '',
  tmdbApiBase: '',
  tmdbImageBase: '',
  metaSource: 'auto',
};

/** 配置页展示用视图（含能力位，便于「未填 Key 时禁用『仅 TMDB』」） */
export interface MetaSettingsView extends MetaSettings {
  /** 兼容旧版视图；内置凭据已停用，固定为 false。 */
  hasBuiltin: boolean;
  /** 用户是否已填自己的 Key */
  hasUserKey: boolean;
}

/** 搜索面板「自动联想」条目 */
export interface MetaSuggestion {
  title: string;
  year: number | '';
  mediaType: 'movie' | 'tv';
}

/**
 * 生效口径（纯函数，配置页与主进程共用）：
 *   未填自己的 TMDB API 时**不允许**「仅 TMDB」（会静默回落「全走」）——
 * 内置默认凭据不足以支撑「只用 TMDB」这种确定性诉求。
 */
export function normalizeMetaSettings(s: MetaSettings): MetaSettings {
  if (s.metaSource === 'tmdb' && !(s.tmdbApiKey || '').trim()) return { ...s, metaSource: 'auto' };
  return s;
}

/** 该策略下是否允许/需要走 TMDB（auto 与 tmdb 都允许） */
export function metaUsesTmdb(src: MetaSource): boolean {
  return src === 'auto' || src === 'tmdb';
}
