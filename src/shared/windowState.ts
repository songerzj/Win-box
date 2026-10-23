// src/shared/windowState.ts
//   主窗口的位置 / 尺寸 / 最大化态落盘，下次启动恢复。**纯函数放这里**（可单测，不 import electron），
//   electron 侧（screen / JsonStore / 事件接线）在 `main/ui/windowState.ts`。
//
// 口径（勿走样）：
//   · 记忆的是**用户亲手调过的那份**：最大化时不取 `getBounds()`（那给的是最大化后的框），
//     取 `getNormalBounds()`（还原后的尺寸）—— 见 `main/ui/windowState.ts` 的 watch。
//   · 一律**先夹再恢复**：尺寸夹进「当前显示器工作区」与「当前倍率下的最小尺寸」，
//     位置夹进工作区 ⇒ **换显示器 / 改分辨率 / 拔掉副屏后绝不会跑到屏幕外找不回来**。
//   · 脏数据（缺字段 / 非数字 / 明显离谱）一律判无效 → 回落「按屏幕推导的默认尺寸」（首启行为不变）。

/** 落盘的窗口状态（DIP；x/y 可缺省 = 只记大小、位置交给系统） */
export interface StoredWindowState {
  x?: number;
  y?: number;
  width: number;
  height: number;
  /** 上次退出时是不是最大化（最大化下也记着还原尺寸） */
  maximized?: boolean;
}

export interface WorkArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 尺寸护栏：低于/高于这个范围一律视为脏数据（防手改配置或半截写入） */
const MIN_W = 480;
const MIN_H = 360;
const MAX_W = 20000;
const MAX_H = 20000;
/** 位置护栏：窗口左上角允许的偏移上限（超大可视为脏数据） */
const MAX_POS = 20000;

function finite(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** 位置夹取：优先「完整放在工作区内」；窗口比工作区还大时贴工作区左/上边（右侧/底部溢出） */
function clampPos(pos: number, size: number, start: number, span: number): number {
  const max = Math.max(start, start + span - size);
  return Math.round(Math.min(Math.max(pos, start), max));
}

/** 读盘 → 归一：非法/脏数据返回 null（调用方回落默认尺寸） */
export function normalizeWindowState(raw: unknown): StoredWindowState | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const w = finite(o.width);
  const h = finite(o.height);
  if (w === undefined || h === undefined) return null;
  if (w < MIN_W || h < MIN_H || w > MAX_W || h > MAX_H) return null;
  const out: StoredWindowState = { width: Math.round(w), height: Math.round(h) };
  const x = finite(o.x);
  const y = finite(o.y);
  if (x !== undefined && y !== undefined && Math.abs(x) <= MAX_POS && Math.abs(y) <= MAX_POS) {
    out.x = Math.round(x);
    out.y = Math.round(y);
  }
  if (o.maximized === true) out.maximized = true;
  return out;
}

/**
 * 这份尺寸值不值得记？（落盘前的护栏）
 * 播放器窗口的**小窗态**只有 384×216 ⇒ 若照记，用户下次打开播放器会得到一个小条 ✗；
 *   而用户真正调过的正常尺寸/最大化还原尺寸都 ≥ 720×420（见 main/player/PlayerWindow.ts）⇒ 用同一个下限挡住即可。
 */
export function isStorableWindowSize(width: unknown, height: unknown): boolean {
  const w = finite(width);
  const h = finite(height);
  if (w === undefined || h === undefined) return false;
  return w >= MIN_W && h >= MIN_H && w <= MAX_W && h <= MAX_H;
}

/**
 * 把记忆的状态夹到「当前工作区 + 当前最小尺寸」内。
 * @param min 当前倍率下的最小可交互尺寸（`scaledWindowSize` 的 minWidth/minHeight）
 */
export function fitWindowState(
  state: StoredWindowState,
  work: WorkArea,
  min: { width: number; height: number },
): StoredWindowState {
  const width = Math.min(Math.max(state.width, min.width), Math.max(min.width, work.width));
  const height = Math.min(Math.max(state.height, min.height), Math.max(min.height, work.height));
  const out: StoredWindowState = { width, height, ...(state.maximized ? { maximized: true } : {}) };
  if (state.x !== undefined && state.y !== undefined) {
    out.x = clampPos(state.x, width, work.x, work.width);
    out.y = clampPos(state.y, height, work.y, work.height);
  }
  return out;
}
