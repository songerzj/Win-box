// src/renderer/components/VirtualGrid.tsx
// （内存专项续，先做 (a) 实现 DOM 真虚拟化）
//   网格的 **DOM 真虚拟化**：只把**滚动视窗内（含上下预取边距）**的卡片挂进 DOM，
//   离屏卡片**从 DOM 移除**、由等高占位块（`.vg-ph`）撑住原来的位置与网格高度。
//   ⇒ 一屏海报墙不再常驻几百张卡（瀑布连翻十几页 / 全源搜索上千条时收益最大）。
//
// 为什么不用「清空 img.src / 只跳过绘制」：
//   · `img.src` 置空已实测**反而更高**（同场景 GPU 231MB → 300MB）——已回退；
//   · 老的 `content-visibility: auto` + `contain-intrinsic-size`（原样写在 global.css `.grid .card-media`）
//     只让离屏格子跳过绘制，节点与 `<img>`（连同解码位图）仍常驻；而且它用**估算高度**撑行，
//     实测与真实卡高对不上（网飝皮肤：声明 240 vs 真实 329，列宽 192）⇒ 行高来回变、内容漂。
//     ⇒ 本组件落地后该对策已删（见 global.css 处注释）：离屏卡是**真移除**，行高由实测占位块给。
//
// 正确性要点
//   ① 占位块高度 = **实测的真实卡片高**（不是 2:3 推算）——换皮肤（--card-w 132/138…）、
//      有无「暂无封面」、有没有备注角标都不影响：网格行高与总滚动高度**逐像素一致**；
//   ② 尺寸测不到时（隐藏页 `display:none` / 首帧）**整表渲染**——宁可多渲染，绝不出现空洞或错位；
//   ③ 窗口按**整行**对齐（列数对齐），不会出现"半行空洞"；
//   ④ 滚动只做 rAF 节流重算，且**窗口没变就不重渲染**（原生滚动本身不需要 React 参与）。
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { computeVirtualWindow, parseColumnCount, type VirtualWindow } from '../lib/virtualWindow';

/** 占位块类名（同时被 global.css 用来把它排除在「卡片入场动画」之外） */
const PH_CLASS = 'vg-ph';
/** 上下预取边距（px）：约 2~3 行，滚动时不会立刻出现空洞 */
const DEFAULT_OVERSCAN = 600;

interface GridMetrics {
  /** 网格列数 */
  cols: number;
  /** 真实卡片高度（px）—— 占位块用它撑高 */
  cardHeight: number;
  /** 行节距 = 卡片高 + 行间距 */
  rowPitch: number;
  /** 滚动容器可视高度 */
  viewport: number;
}

interface GridFrame {
  scrollTop: number;
  /** 网格顶边相对**滚动容器内容顶部**的偏移（与 scrollTop 同坐标系） */
  gridTop: number;
}

export interface VirtualGridProps<T> {
  items: readonly T[];
  /** 稳定 key（同列表内唯一） */
  keyOf: (item: T, index: number) => string;
  /** 渲染一张卡（只会对**窗口内**的条目调用；离屏条目一律不调用） */
  renderItem: (item: T, index: number) => ReactNode;
  className?: string;
  /** 上下预取边距（px） */
  overscan?: number;
}

/** 向上找最近的滚动祖先（点播页 / 搜索页的滚动容器是 `.content`） */
function findScroller(el: HTMLElement | null): HTMLElement | null {
  let p = el?.parentElement ?? null;
  while (p) {
    const oy = getComputedStyle(p).overflowY;
    if (oy === 'auto' || oy === 'scroll') return p;
    p = p.parentElement;
  }
  return null;
}

/** 读网格在滚动容器里的位置（同为「内容坐标系」，滚动时两者差值恒定） */
function readFrame(grid: HTMLElement, scroller: HTMLElement): GridFrame {
  const scrollTop = scroller.scrollTop;
  const gridTop = grid.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scrollTop;
  return { scrollTop, gridTop };
}

/**
 * 量出一张**真实卡片**的高度。
 * 必须优先挑**视口内**的那张：离屏格子被 `content-visibility: auto` 折叠成
 * `contain-intrinsic-size`（global.css 给的 138×240 估算值），量到的不是真实高度 ——
 * 换皮肤（--card-w 不同）后偏差会随行数累积成"滚动高度越滚越歪"。
 * @param hint 从「上次上屏窗口的首条」附近开始扫（避免从头遍历几百个格子）
 */
function probeCardHeight(grid: HTMLElement, scroller: HTMLElement, hint: number): number {
  const kids = grid.children;
  const n = kids.length;
  if (n === 0) return 0;
  const box = scroller.getBoundingClientRect();
  for (let i = Math.max(0, Math.min(n - 1, hint)); i < n; i++) {
    const el = kids[i];
    if (el.classList.contains(PH_CLASS)) continue;
    const r = el.getBoundingClientRect();
    if (r.height > 0 && r.bottom > box.top && r.top < box.bottom) return (el as HTMLElement).offsetHeight;
  }
  // 兜底：任意一张真实卡（网格在视口外时的常态；卡高此时同样精确，见「无 content-visibility 折叠」）
  for (let i = 0; i < n; i++) {
    const el = kids[i];
    if (el.classList.contains(PH_CLASS)) continue;
    const h = (el as HTMLElement).offsetHeight;
    if (h > 0) return h;
  }
  return 0;
}

function measure(grid: HTMLElement, scroller: HTMLElement, hint: number): GridMetrics {
  const cs = getComputedStyle(grid);
  const cols = parseColumnCount(cs.gridTemplateColumns) || 1;
  const rowGap = parseFloat(cs.rowGap) || 0;
  const cardHeight = probeCardHeight(grid, scroller, hint);
  return {
    cols,
    cardHeight,
    rowPitch: cardHeight > 0 ? cardHeight + rowGap : 0,
    viewport: scroller.clientHeight,
  };
}

export default function VirtualGrid<T>({ items, keyOf, renderItem, className, overscan = DEFAULT_OVERSCAN }: VirtualGridProps<T>) {
  const gridRef = useRef<HTMLDivElement | null>(null);
  const scrollerRef = useRef<HTMLElement | null>(null);
  const [metrics, setMetrics] = useState<GridMetrics | null>(null);
  const [frame, setFrame] = useState<GridFrame>({ scrollTop: 0, gridTop: 0 });
  const rafRef = useRef(0);
  /** 最近一次已上屏的窗口：滚动时用它判断「窗口是否真的变了」（没变就不重渲染） */
  const winRef = useRef<VirtualWindow | null>(null);
  /** 滚动处理器要读到的"最新值"（处理器只注册一次，不能捕获首轮渲染的闭包） */
  const metricsRef = useRef<GridMetrics | null>(null);
  const countRef = useRef(0);
  metricsRef.current = metrics;
  countRef.current = items.length;

  /** 重测几何并落 state（值没变则保持原引用 → React 不重渲染） */
  const applyMeasure = useCallback((): void => {
    const grid = gridRef.current;
    if (!grid) return;
    if (!scrollerRef.current) scrollerRef.current = findScroller(grid);
    const scroller = scrollerRef.current;
    if (!scroller) return;
    /**
     * 隐藏页（伪墓碑的 `display:none`）不测也不改：此时 scroller 无盒（clientHeight 0）、
     * grid 的 rect 全 0、scrollTop 读回 0 —— 照测会把 frame 改错（窗口指向错误的行段），
     * 而**保留上一次有效几何**恰好是想要的：缓存页在后台也只挂 ~20 张卡（零开销且省内存）。
     * 重新可见时容器尺寸 0 → 实际会触发下面的 ResizeObserver，再收敛一次（含 scrollTop 对齐）。
     */
    if (scroller.clientHeight <= 0) return;
    const m = measure(grid, scroller, winRef.current?.start ?? 0);
    if (m.cardHeight > 0) {
      setMetrics((prev) => (prev && prev.cols === m.cols && prev.cardHeight === m.cardHeight && prev.rowPitch === m.rowPitch && prev.viewport === m.viewport ? prev : m));
    }
    setFrame((prev) => {
      const f = readFrame(grid, scroller);
      return prev.scrollTop === f.scrollTop && prev.gridTop === f.gridTop ? prev : f;
    });
  }, []);

  /**
   * 布局变化即测量：首帧 / 条目增减（翻页换页、瀑布追加）/ 换源换分类。
   * 用 layout effect ⇒ 在浏览器绘制前完成收敛（不会"先看到一堆卡再突然变成占位"）。
   */
  useLayoutEffect(() => { applyMeasure(); }, [applyMeasure, items.length]);

  // 尺寸变化（窗口缩放、换皮肤、`--card-w` 变）→ 重测：行高/列数/可视高度都得跟着变
  useEffect(() => {
    const grid = gridRef.current;
    const scroller = scrollerRef.current;
    if (!grid || !scroller) return;
    const ro = new ResizeObserver(() => applyMeasure());
    ro.observe(grid);
    ro.observe(scroller);
    // 换皮肤/换布局/改主题/改缩放只改 documentElement 上的属性，未必触发 resize → 一并监听
    const mo = new MutationObserver(() => applyMeasure());
    mo.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'data-base', 'data-shell', 'data-detail', 'data-discover', 'data-filter', 'data-motion', 'data-scale'],
    });
    return () => { ro.disconnect(); mo.disconnect(); };
  }, [applyMeasure]);

  /**
   * 滚动 → rAF 节流重算窗口；**窗口没变就完全不动 React**（滚动本身由浏览器负责）。
   * 也覆盖「页面从隐藏变回可见」（display:none 会把 scrollTop 归零 + 尺寸 0→实际）：
   * 尺寸变化触发上面的 ResizeObserver 重测，这里再补一次 scrollTop 对齐。
   */
  useEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;
    if (!scrollerRef.current) scrollerRef.current = findScroller(grid);
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const onScroll = (): void => {
      if (rafRef.current) return;
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = 0;
        const f = readFrame(grid, scroller);
        const m = metricsRef.current;
        if (m) {
          const next = computeVirtualWindow({
            count: countRef.current, cols: m.cols, rowPitch: m.rowPitch,
            gridTop: f.gridTop, scrollTop: f.scrollTop, viewport: m.viewport, overscan,
          });
          const cur = winRef.current;
          if (cur && cur.start === next.start && cur.end === next.end) return; // 窗口没变 → 不重渲染
        }
        setFrame((prev) => (prev.scrollTop === f.scrollTop && prev.gridTop === f.gridTop ? prev : f));
      });
    };
    scroller.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      scroller.removeEventListener('scroll', onScroll);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
    };
  }, [overscan]);

  const win = useMemo(
    () =>
      metrics
        ? computeVirtualWindow({
            count: items.length, cols: metrics.cols, rowPitch: metrics.rowPitch,
            gridTop: frame.gridTop, scrollTop: frame.scrollTop, viewport: metrics.viewport, overscan,
          })
        : null,
    [metrics, frame, items.length, overscan],
  );
  winRef.current = win;

  const kids: ReactNode[] = [];
  if (!win) {
    // 尺寸未知（隐藏页 / 首帧）：整表渲染 —— 与虚拟化前完全一致，绝不出现空洞或错位
    for (let i = 0; i < items.length; i++) kids.push(<Fragment key={keyOf(items[i], i)}>{renderItem(items[i], i)}</Fragment>);
  } else {
    const spacerHeight = metrics ? metrics.cardHeight : 0;
    for (let i = 0; i < items.length; i++) {
      if (i >= win.start && i < win.end) kids.push(<Fragment key={keyOf(items[i], i)}>{renderItem(items[i], i)}</Fragment>);
      else kids.push(<div key={`ph:${i}`} className={PH_CLASS} aria-hidden="true" style={{ height: spacerHeight }} />);
    }
  }
  return <div ref={gridRef} className={className}>{kids}</div>;
}
