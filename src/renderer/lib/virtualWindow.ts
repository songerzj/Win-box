// src/renderer/lib/virtualWindow.ts
// （内存专项续，先做 (a) 实现 DOM 真虚拟化）
//   海报墙的 **DOM 真虚拟化** —— 只有「落在滚动视窗内（含上下预取边距）」的卡片才挂进 DOM，
//   离屏卡片**从 DOM 移除**，位置由**等高占位块**撑住（见 components/VirtualGrid.tsx 的 `.vg-ph`）。
//   为什么这么做：一屏海报墙动辄几百张卡（瀑布连翻十几页 / 全源搜索上千条），
//   每张卡都是「div + img + 文本」若干节点 + 一份解码位图；离屏的既看不见又白占内存。
//   与既有 `content-visibility: auto`（global.css `.grid .card-media`）的分工：
//     后者只让离屏格子**跳过绘制**，节点与 `<img>` 仍在（位图也随之常驻）；本模块才是真卸载。
//
// 本文件只放**纯计算**（可单测）：列数解析、可见行区间换算。
// 组件壳（滚动监听 / 尺寸测量 / 占位渲染）在 components/VirtualGrid.tsx。

/** 可见区间（[start, end)，对应 items 的下标） */
export interface VirtualWindow {
  start: number;
  end: number;
}

export interface VirtualWindowInput {
  /** 总条目数 */
  count: number;
  /** 网格列数（`repeat(auto-fill, …)` 的解析列数） */
  cols: number;
  /** 单行「节距」= 卡片高 + 行间距（把滚动偏移换算成行号用） */
  rowPitch: number;
  /** 网格顶边相对**滚动容器内容顶部**的偏移（px，见 VirtualGrid 的测量口径） */
  gridTop: number;
  /** 滚动容器的 scrollTop */
  scrollTop: number;
  /** 滚动容器的可视高度（clientHeight） */
  viewport: number;
  /** 上下各预留的预取边距（px）：多渲染一点，滚动时不会立刻出现空洞 */
  overscan: number;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * 解析 `getComputedStyle(grid).gridTemplateColumns` 的列数。
 * 计算值已被浏览器解析成像素轨道列表（形如 `192.5px 192.5px 192.5px`），按空白切分即列数。
 * 拿不到（元素未参与布局 / `none`）返回 0 —— 调用方据此判定「尺寸未知」并退化为整表渲染。
 */
export function parseColumnCount(gridTemplateColumns: string): number {
  const s = String(gridTemplateColumns || '').trim();
  if (!s || s === 'none') return 0;
  return s.split(/\s+/).filter(Boolean).length;
}

/**
 * 由「滚动位置 + 网格几何」算出该渲染的下标区间。
 * 口径：
 *   · `gridTop` 与 `scrollTop` 同为**滚动容器内容坐标系**（因此滚动时两者差值恒定）；
 *   · 可见像素带 = [scrollTop - overscan, scrollTop + viewport + overscan] ∩ 网格范围；
 *   · 行号 = 像素 / rowPitch，向下取整到「完整行」边界 → 该行整行渲染（列数对齐，不留半行空洞）。
 * 退化（尺寸未测到）：返回整表 —— **宁可多渲染，也绝不出现空白或错位**（隐藏页/首帧即此分支）。
 */
export function computeVirtualWindow(input: VirtualWindowInput): VirtualWindow {
  const count = Math.max(0, Math.floor(input.count) || 0);
  if (count === 0) return { start: 0, end: 0 };
  const cols = Math.max(1, Math.floor(input.cols) || 1);
  if (!(input.rowPitch > 0) || !(input.viewport > 0)) return { start: 0, end: count };
  const totalRows = Math.ceil(count / cols);
  const overscan = Math.max(0, input.overscan || 0);
  const top = input.scrollTop - input.gridTop - overscan;
  const bottom = input.scrollTop + input.viewport - input.gridTop + overscan;
  const firstRow = clamp(Math.floor(top / input.rowPitch), 0, totalRows - 1);
  // 至少一行：滚动位置正好压在行边界时 bottom/rowPitch 可能等于 firstRow，这里 +1 兜住
  const lastRow = clamp(Math.ceil(bottom / input.rowPitch), firstRow + 1, totalRows);
  return { start: Math.min(firstRow * cols, count), end: Math.min(lastRow * cols, count) };
}
