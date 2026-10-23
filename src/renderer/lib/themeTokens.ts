// src/renderer/lib/themeTokens.ts
// 皮肤「值层」：**动态注册表**（内置 4 套 + 插件皮肤）+ 纯函数，**不碰 DOM/window**（便于单测与契约复用）。
//   · 内置：`netflix`（网飝，**默认**）/ `bilibili`（哔哔）/ `apple`（大果）/ `douban`（大豆）。
//   · 插件：id 形如 `plugin:<skinId>`，令牌来自插件 manifest 的 `theme` 贡献项。
// 皮肤从「写死四套的联合类型 + 组件里按皮肤 id 分支」
//   改为**注册表 + layout 声明** —— 组件只读 `layout` 里的结构枚举（shell / detailStyle /
//   discoverStyle / filterStyle），新增皮肤（含插件皮肤）不需要改任何组件代码。
//   唯一权威规范：docs/design/皮肤与主题规范.md。
// DOM 应用逻辑见 ./theme.ts（applyTheme / useTheme / useSkinLayout）。
import type { ThemeLayout, ThemeSkinView } from '../../shared/plugin';

/** 皮肤 id：内置 = 固定名；插件 = `plugin:<skinId>`（**直接**用作 `<html data-theme>`） */
export type Theme = string;

/** 默认皮肤（首次启动 / 值非法 / 原皮肤被卸载时回落） */
export const DEFAULT_THEME: Theme = 'netflix';

/** 内置皮肤展示名（设置页按此渲染切换项；插件皮肤展示名来自插件 manifest） */
export const THEME_LABELS: Record<string, string> = {
  netflix: '🎬 网飝',
  bilibili: '📺 哔哔',
  apple: '🍎 大果',
  douban: '🫘 大豆',
};

/** 皮肤注册表条目 */
export interface SkinEntry {
  /** 直接用作 `data-theme` 的生效值 */
  id: string;
  label: string;
  kind: 'builtin' | 'plugin';
  /** 原生窗口底色（主进程 nativeTheme 对齐用） */
  base: 'dark' | 'light';
  /** 结构声明（组件据此选外壳/排版，不再按皮肤 id 分支） */
  layout: ThemeLayout;
  /** **仅插件皮肤**：令牌 → 值；内置皮肤的令牌写在各自 CSS 文件里 */
  tokens?: Record<string, string>;
}

/**
 * 四套内置皮肤的结构声明（定稿，勿改）
 *   netflix = 单行顶栏 + 影院式详情 + 内容行；bilibili = 双行头；apple = 玻璃侧边栏 + 玻璃详情 + 宽内容行；
 *   douban = 胶囊导航 + 左海报右信息详情 + 海报墙 + 卡片筛选条。
 */
const BUILTIN_SKINS: SkinEntry[] = [
  {
    id: 'netflix', label: THEME_LABELS.netflix, kind: 'builtin', base: 'dark',
    layout: { shell: 'topbar', detailStyle: 'cinema', discoverStyle: 'shelf', navHeight: 58, cardWidth: 176 },
  },
  {
    id: 'bilibili', label: THEME_LABELS.bilibili, kind: 'builtin', base: 'dark',
    layout: { shell: 'dualbar' },
  },
  {
    id: 'apple', label: THEME_LABELS.apple, kind: 'builtin', base: 'light',
    layout: { shell: 'sidebar', detailStyle: 'glass', discoverStyle: 'shelfWide', navHeight: 52, sideWidth: 212 },
  },
  {
    id: 'douban', label: THEME_LABELS.douban, kind: 'builtin', base: 'light',
    layout: { shell: 'pillbar', detailStyle: 'poster', discoverStyle: 'wall', filterStyle: 'card' },
  },
];

/** 插件皮肤（宿主在启动时载入；卸载后自动从表里消失） */
let pluginSkins: SkinEntry[] = [];

/** 合并后的 `layout` 缓存（同一 id 返回**同一对象**，便于组件把它当稳定引用用于依赖数组） */
const layoutCache = new Map<string, ThemeLayout>();

/** 全部皮肤（内置在前，插件在后）—— 设置页遍历它渲染切换项 */
export function allSkins(): SkinEntry[] {
  return [...BUILTIN_SKINS, ...pluginSkins];
}

/** 按 id 取皮肤（未知 id → undefined） */
export function findSkin(id: unknown): SkinEntry | undefined {
  if (typeof id !== 'string' || !id) return undefined;
  return BUILTIN_SKINS.find((s) => s.id === id) ?? pluginSkins.find((s) => s.id === id);
}

/**
 * 载入插件皮肤注册表（宿主 `plugins.themes()` 的结果）。
 * 每次全量替换（重复 id 以先出现者为准），并清掉 layout 缓存。
 */
export function registerPluginSkins(list: ThemeSkinView[] | undefined): void {
  const seen = new Set<string>();
  const next: SkinEntry[] = [];
  for (const s of list ?? []) {
    if (!s || typeof s.id !== 'string' || !s.id || seen.has(s.id)) continue;
    if (!s.tokens || typeof s.tokens !== 'object') continue;
    seen.add(s.id);
    next.push({
      id: s.id,
      label: s.label || s.id,
      kind: 'plugin',
      base: s.base === 'light' ? 'light' : 'dark',
      layout: s.layout || {},
      tokens: s.tokens,
    });
  }
  pluginSkins = next;
  layoutCache.clear();
}

/**
 * 任意值 → 合法皮肤 id（未知 / 空 / 旧值 / 已被卸载的插件皮肤 → 默认皮肤网飝）。
 * 注意：插件皮肤在**注册表载入之前**会先落到默认皮肤，载入后由 initTheme 还原真实意图。
 */
export function normalizeTheme(v: unknown): Theme {
  return findSkin(v) ? (v as string) : DEFAULT_THEME;
}

/** 皮肤的**结构声明**（未声明的字段回落缺省：单行顶栏 + 朴素筛选条） */
export function skinLayout(id: unknown): ThemeLayout {
  const key = normalizeTheme(id);
  const hit = layoutCache.get(key);
  if (hit) return hit;
  const merged: ThemeLayout = { shell: 'topbar', filterStyle: 'plain', ...(findSkin(key)?.layout || {}) };
  layoutCache.set(key, merged);
  return merged;
}

/** 皮肤的原生底色（主进程 nativeTheme 对齐用） */
export function skinBase(id: unknown): 'dark' | 'light' {
  return findSkin(normalizeTheme(id))?.base === 'light' ? 'light' : 'dark';
}
