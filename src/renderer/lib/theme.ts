// src/renderer/lib/theme.ts
// 皮肤：内置 4 套（网飝 默认 / 哔哔 / 大果 / 大豆）+ **插件皮肤**统一走「注册表 + data-theme」。
// 选择持久化到 localStorage，并同步到 <html data-theme>，驱动 global.css + netflix.css/bilibili.css/apple.css/douban.css
// 的 CSS 变量；插件皮肤的令牌由本模块注入一段 <style id="winbox-plugin-themes">。
// 同时通过 IPC 通知主进程设置 nativeTheme.themeSource（按皮肤 base 取亮/暗），让窗口底色对齐。
// 新增 useSkinLayout() —— 组件读 layout 结构枚举，不再按皮肤 id 分支。
import { useEffect, useState } from 'react';
import { client } from '../api/client';
import {
  DEFAULT_THEME, allSkins, normalizeTheme, registerPluginSkins, skinBase, skinLayout, type Theme,
} from './themeTokens';
import type { ThemeLayout } from '../../shared/plugin';

export type { Theme };
const KEY = 'winbox-theme';
/** 插件皮肤令牌样式表（宿主拥有；每次注册表刷新整表重写） */
const STYLE_ID = 'winbox-plugin-themes';
/** 令牌值护栏：契约层已校验，渲染层再兜一道（命中即丢弃该条声明） */
const UNSAFE_VALUE = /[;{}<>]|url\s*\(|expression\s*\(|@import|\/\*/i;
const SAFE_NAME = /^--[a-z0-9-]+$/i;
/** 主题切换广播事件（App 据此切换外壳布局） */
export const THEME_EVENT = 'winbox:theme-changed';
/** 皮肤注册表变化事件（装/卸插件皮肤后，设置页与外壳据此重算） */
export const THEMES_EVENT = 'winbox:themes-changed';

/** 当前皮肤（从 DOM 读取，本地持久化后的最终生效值）。 */
export function currentTheme(): Theme {
  return normalizeTheme(document.documentElement.getAttribute('data-theme'));
}

/**
 * 把 `layout` 声明里的**布局度量**写成宿主 CSS 变量（`--nav-h` / `--side-w` / `--card-w`）。
 * 这三个不是皮肤令牌（词表外，宿主自用）—— 皮肤只声明数值，CSS 由 global.css 的壳层规则消费。
 * 未声明 → 移除内联值，回落到 global.css 的 `:root` 缺省（54 / 208 / 132）。
 */
function applyLayoutVars(layout: ThemeLayout): void {
  const root = document.documentElement;
  const set = (name: string, px?: number): void => {
    if (typeof px === 'number' && Number.isFinite(px)) root.style.setProperty(name, `${px}px`);
    else root.style.removeProperty(name);
  };
  set('--nav-h', layout.navHeight);
  set('--side-w', layout.sideWidth);
  set('--card-w', layout.cardWidth);
}

/** `layout.radiusScale`：按倍率放大皮肤声明的三个圆角令牌（无声明 = 不动） */
function applyRadiusScale(scale?: number): void {
  const root = document.documentElement;
  const KEYS = ['--radius', '--radius-sm', '--radius-lg'];
  // 先清掉上一轮的内联倍率，让皮肤令牌重新生效（皮肤切换时会换一套值）
  for (const k of KEYS) root.style.removeProperty(k);
  if (typeof scale !== 'number' || scale === 1) return;
  const cs = getComputedStyle(root);
  for (const k of KEYS) {
    const base = parseFloat(cs.getPropertyValue(k));
    if (Number.isFinite(base) && base > 0) root.style.setProperty(k, `${(base * scale).toFixed(2)}px`);
  }
}

/**
 * 应用皮肤：设置 DOM 属性 + 写入 localStorage + 通知主进程对齐原生主题 + 广播给 React。
 * 只把**归一后**的 id 写进 DOM；localStorage 里保留用户原始选择 —— 插件皮肤在注册表载入前
 *   会先落到默认皮肤，若此时把回落值写盘，用户的选择就被抹掉了（见 initTheme 的二段式恢复）。
 * 除 `data-theme`（皮肤 id）外还写两个**宿主属性**（不由皮肤控制）：
 *   `data-base`（dark|light，选基线）与 `data-shell`（外壳枚举）—— global.css 的壳层规则按它们生效。
 */
export function applyTheme(t: Theme) {
  const want = typeof t === 'string' && t ? t : DEFAULT_THEME;
  const theme = normalizeTheme(want);
  const layout = skinLayout(theme);
  const root = document.documentElement;
  root.setAttribute('data-theme', theme);
  root.setAttribute('data-base', skinBase(theme));
  root.setAttribute('data-shell', layout.shell ?? 'topbar');
  // 结构枚举属性：详情 / 发现 / 筛选排版（缺省 = 基础排版），global.css 的宿主结构层按它们生效
  root.setAttribute('data-detail', layout.detailStyle ?? 'basic');
  root.setAttribute('data-discover', layout.discoverStyle ?? 'basic');
  root.setAttribute('data-filter', layout.filterStyle ?? 'plain');
  applyLayoutVars(layout);
  applyRadiusScale(layout.radiusScale);
  try {
    localStorage.setItem(KEY, want);
  } catch {
    /* ignore */
  }
  // 主进程只需知道亮/暗（深色皮肤 / 亮色皮肤），失败静默
  void client.setTheme(skinBase(theme) === 'light' ? 'light' : 'dark').catch(() => undefined);
  try {
    window.dispatchEvent(new Event(THEME_EVENT));
  } catch {
    /* ignore */
  }
}

/**
 * 把**全部插件皮肤**的令牌写进一段 `<style>`（每套一个 `:root[data-theme='plugin:x']` 块）。
 * 值已过契约校验；这里再过滤一次非法名/值，任何一条异常都不会影响其余皮肤。
 */
function injectPluginSkinCss(): void {
  const css = allSkins()
    .filter((s) => s.kind === 'plugin' && s.tokens)
    .map((s) => {
      const decls = Object.entries(s.tokens as Record<string, string>)
        .filter(([k, v]) => SAFE_NAME.test(k) && typeof v === 'string' && v.trim() !== '' && !UNSAFE_VALUE.test(v))
        .map(([k, v]) => `${k}:${v.trim()}`)
        .join(';');
      // id 形如 `plugin:<skinId>`，skinId 已被契约校验为 [a-z0-9-]{3,40} → 放进属性选择器安全
      return decls ? `:root[data-theme="${s.id}"]{${decls}}` : '';
    })
    .filter(Boolean)
    .join('\n');
  let el = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!el) {
    el = document.createElement('style');
    el.id = STYLE_ID;
    document.head.appendChild(el);
  }
  el.textContent = css;
}

/** 读持久化的**原始**选择（可能是尚未注册的插件皮肤 id / 旧值） */
function rawStored(): string {
  try {
    const v = localStorage.getItem(KEY);
    return typeof v === 'string' && v ? v : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

/**
 * 载入插件皮肤注册表（宿主 `plugins.themes()`）并**收敛当前选择**。
 * 装 / 卸 / 停用插件后都要调用一次（设置页在插件增删改后调用）：
 *   · 偏好仍是合法皮肤 → DOM 若落后就补一次 applyTheme（启动二段式的第二段）；
 *   · 偏好是**已被卸载/停用**的插件皮肤（或旧值）→ 回落默认皮肤并广播（规范 §4.3）。
 * 主进程不可用时**不动偏好**（宁可保留选择，也不误写盘）。
 */
export async function loadSkinRegistry(): Promise<void> {
  let ok = false;
  try {
    registerPluginSkins(await client.pluginThemes());
    ok = true;
  } catch {
    /* 主进程不可用 / 插件系统未就绪：保持内置皮肤 */
  }
  injectPluginSkinCss();
  const raw = rawStored();
  const want = normalizeTheme(raw);
  if (want !== currentTheme()) applyTheme(want);
  else if (ok && raw !== want) applyTheme(want); // 清掉无效 / 已卸载的存档值
  try {
    window.dispatchEvent(new Event(THEMES_EVENT));
  } catch {
    /* ignore */
  }
}

/**
 * 初始化：读持久化偏好并应用（在 React 挂载前调用，避免白屏闪烁）。
 * 插件皮肤是异步的 → 先按内置皮肤上屏（localStorage 里保留**原始意图**），注册表到位后再收敛。
 */
export function initTheme(): Theme {
  applyTheme(rawStored());
  void loadSkinRegistry();
  return currentTheme();
}

/** React Hook：订阅当前皮肤（设置页切换 / 装卸载插件皮肤后，外壳布局立即跟着变） */
export function useTheme(): Theme {
  const [theme, setTheme] = useState<Theme>(() => currentTheme());
  useEffect(() => {
    const onChange = (): void => setTheme(currentTheme());
    window.addEventListener(THEME_EVENT, onChange);
    window.addEventListener(THEMES_EVENT, onChange);
    return () => {
      window.removeEventListener(THEME_EVENT, onChange);
      window.removeEventListener(THEMES_EVENT, onChange);
    };
  }, []);
  return theme;
}

/**
 * React Hook：当前皮肤的**结构声明**（组件据此刻画外壳/详情/发现/筛选排版）。
 * 同一皮肤返回同一对象引用（registry 侧按 id 缓存）→ 可安全进依赖数组。
 */
export function useSkinLayout(): ThemeLayout {
  return skinLayout(useTheme());
}
