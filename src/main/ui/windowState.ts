// src/main/ui/windowState.ts — 「窗口位置 / 尺寸 / 最大化态」记忆（electron 侧接线，按窗口 key 复用）
// 目标：记住窗口大小，不必每次重新打开软件都重新调（主窗口与播放器窗口都适用）。
//   纯逻辑（归一 / 夹取 / 值得记与否）在 `shared/windowState.ts`；这里只做三件事：
//     ① 启动时读盘 + 按当前显示器和最小尺寸夹好 → 交给创建窗口的地方当初始尺寸；
//     ② 变更时**防抖落盘**（拖动期间不写盘）、`flush()` 立即写（关闭路径）；
//     ③ 落盘用 `JsonStore`（`<userData>/window-state.json`，键 `main` / `player` / `playerMini`，
//        与 ui-scale.json / bosskey.json 同一套口径）。
//
// 三条口径（勿走样）：
//   · 最大化时**不能**取 `getBounds()`（那是最大化后的框）⇒ 取 `getNormalBounds()`，
//     否则「上次最大化 → 记忆成整屏尺寸 → 下次还原态也是一整屏」。
//   · 只记「用户真正调过」的状态：夹取只发生在**恢复**时，不写回盘（盘上留原值），
//     换回原显示器还能恢复到用户当初调的大小。
//   · **过小的尺寸不记**（`isStorableWindowSize`）：挡住播放器小窗态（384×216）把正常尺寸覆盖掉。

import { BrowserWindow, screen } from 'electron';
import { join } from 'node:path';
import { JsonStore } from '../store/JsonStore';
import { userDataDir } from '../util/paths';
import { fileLogger } from '../util/logger';
import { fitWindowState, isStorableWindowSize, normalizeWindowState, type StoredWindowState } from '../../shared/windowState';

/** 落盘的键：主窗口 / 播放器窗口（只记**正常态**；小窗 384×216 会被「过小」护栏挡掉，见 isStorableWindowSize） */
export type WindowStateKey = 'main' | 'player';

/** resize/move 期间的落盘防抖（拖动结束再写，避免每帧写盘） */
const SAVE_DEBOUNCE_MS = 800;

/** 惰性建 store：不在模块导入期碰 `app.getPath`（同 uiScale.ts 的口径，便于单测） */
let storeRef: JsonStore | null = null;
function store(): JsonStore {
  if (!storeRef) storeRef = new JsonStore(join(userDataDir(), 'window-state.json'));
  return storeRef;
}

export interface WindowStateWriter {
  /** 读盘 + 按当前显示器与最小尺寸夹好（无记忆 / 脏数据 → null） */
  load(min: { width: number; height: number }): StoredWindowState | null;
  /** 防抖落盘（过小尺寸按口径丢弃，不覆盖已有记忆） */
  remember(bounds: { x: number; y: number; width: number; height: number }, maximized?: boolean, label?: string): void;
  /** 立即写盘（关闭路径用） */
  flush(): void;
}

/** 取某个窗口的记忆读写器（同一 key 复用同一实例，避免重复建 store） */
const writers = new Map<WindowStateKey, WindowStateWriter>();
export function windowStateWriter(key: WindowStateKey): WindowStateWriter {
  const hit = writers.get(key);
  if (hit) return hit;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const write = (b: { x: number; y: number; width: number; height: number }, maximized: boolean, label: string): void => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    const state: StoredWindowState = {
      x: b.x,
      y: b.y,
      width: b.width,
      height: b.height,
      ...(maximized ? { maximized: true } : {}),
    };
    store().setObject(key, state);
    fileLogger.i(
      `window-state[${key}]: 记 ${state.width}x${state.height}@${state.x},${state.y}${state.maximized ? '（最大化）' : ''}${label ? `（${label}）` : ''}`,
    );
  };
  const writer: WindowStateWriter = {
    load(min) {
      const saved = normalizeWindowState(store().getObject<unknown>(key, null));
      if (!saved) return null;
      const display =
        saved.x !== undefined && saved.y !== undefined
          ? screen.getDisplayMatching({ x: saved.x, y: saved.y, width: saved.width, height: saved.height })
          : screen.getPrimaryDisplay();
      const work = display.workArea;
      const fit = fitWindowState(saved, { x: work.x, y: work.y, width: work.width, height: work.height }, min);
      fileLogger.i(
        `window-state[${key}]: 恢复 ${fit.width}x${fit.height}${fit.x !== undefined ? `@${fit.x},${fit.y}` : ''}${fit.maximized ? '（最大化）' : ''}` +
          `（工作区 ${work.width}x${work.height}，记忆值 ${saved.width}x${saved.height}）`,
      );
      return fit;
    },
    remember(b, maximized = false, label) {
      if (!isStorableWindowSize(b.width, b.height)) {
        fileLogger.i(`window-state[${key}]: 跳过落盘（尺寸 ${b.width}x${b.height} 过小/离谱${label ? `，${label}` : ''}）`);
        return;
      }
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        write(b, !!maximized, label || '');
      }, SAVE_DEBOUNCE_MS);
    },
    flush() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      store().flush();
    },
  };
  writers.set(key, writer);
  return writer;
}

/**
 * 记住一个「普通窗口」：resize/move 防抖 + 最大化/还原 + 关闭时立即落盘。
 * @param shouldSave 额外闸门（例如播放器窗口要求「非小窗态、非全屏」才记）——返回 false 则本次不记
 */
export function watchWindowState(
  key: WindowStateKey,
  win: BrowserWindow,
  shouldSave?: (w: BrowserWindow) => boolean,
): void {
  const writer = windowStateWriter(key);
  const save = (label: string): void => {
    if (win.isDestroyed()) return;
    if (shouldSave && !shouldSave(win)) return;
    try {
      const maximized = win.isMaximized();
      const b = maximized ? win.getNormalBounds() : win.getBounds();
      writer.remember(b, maximized, label);
    } catch {
      /* 窗口状态读取失败（销毁竞态等）：忽略 */
    }
  };
  win.on('resize', () => save('resize'));
  win.on('move', () => save('move'));
  win.on('maximize', () => save('maximize'));
  win.on('unmaximize', () => save('unmaximize'));
  win.on('close', () => {
    save('close');
    writer.flush();
  });
}
