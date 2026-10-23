// tests/windowState.spec.ts — 窗口大小记忆的纯函数（归一 / 夹取）回归
//
// 「添加一个窗口大小记忆的功能，不要每次重新打开软件都要调窗口大小」。
// 这里锁住两条护栏：① 脏数据必须判无效（回落默认尺寸）；② 恢复前必须夹进当前工作区与最小尺寸。
import { describe, it, expect } from 'vitest';
import { fitWindowState, isStorableWindowSize, normalizeWindowState } from '../src/shared/windowState';

const WORK = { x: 0, y: 0, width: 1920, height: 1040 };
const MIN = { width: 960, height: 600 };

describe('normalizeWindowState — 读盘归一（脏数据一律判无效）', () => {
  it('非对象 / 缺尺寸 → null', () => {
    for (const v of [null, undefined, 42, 'x', [], {}, { width: 1280 }, { height: 800 }]) {
      expect(normalizeWindowState(v)).toBeNull();
    }
  });

  it('正常尺寸 → 保留并取整', () => {
    expect(normalizeWindowState({ width: 1280.6, height: 800.2 })).toEqual({ width: 1281, height: 800 });
  });

  it('离谱尺寸（过小 / 过大 / 非有限数）→ null', () => {
    expect(normalizeWindowState({ width: 100, height: 800 })).toBeNull();
    expect(normalizeWindowState({ width: 1280, height: 99999 })).toBeNull();
    expect(normalizeWindowState({ width: Number.NaN, height: 800 })).toBeNull();
    expect(normalizeWindowState({ width: Infinity, height: 800 })).toBeNull();
  });

  it('位置非法（非数字 / 超范围）→ 丢掉位置但保留尺寸', () => {
    expect(normalizeWindowState({ width: 1280, height: 800, x: 'a', y: 10 })).toEqual({ width: 1280, height: 800 });
    expect(normalizeWindowState({ width: 1280, height: 800, x: 99999, y: 0 })).toEqual({ width: 1280, height: 800 });
    expect(normalizeWindowState({ width: 1280, height: 800, x: 100.4, y: 50.6 })).toEqual({ width: 1280, height: 800, x: 100, y: 51 });
  });

  it('maximized 只认真 true', () => {
    expect(normalizeWindowState({ width: 1280, height: 800, maximized: true })).toMatchObject({ maximized: true });
    expect(normalizeWindowState({ width: 1280, height: 800, maximized: 1 })).not.toHaveProperty('maximized');
    expect(normalizeWindowState({ width: 1280, height: 800 })).not.toHaveProperty('maximized');
  });
});

describe('isStorableWindowSize — 落盘前的护栏（「播放器窗口也要记忆」）', () => {
  it('正常窗口尺寸值得记（主窗口 / 播放器正常态 / 最大化还原尺寸）', () => {
    expect(isStorableWindowSize(1280, 800)).toBe(true);
    expect(isStorableWindowSize(1040, 640)).toBe(true);
    expect(isStorableWindowSize(720, 420)).toBe(true);
  });

  it('播放器小窗 384×216 不值得记（记了下次打开播放器就是个小条）', () => {
    expect(isStorableWindowSize(384, 216)).toBe(false);
    expect(isStorableWindowSize(1040, 216)).toBe(false);
    expect(isStorableWindowSize(384, 640)).toBe(false);
  });

  it('非数字 / 超范围 → false', () => {
    expect(isStorableWindowSize(undefined, 640)).toBe(false);
    expect(isStorableWindowSize(1040, 'x')).toBe(false);
    expect(isStorableWindowSize(99999, 640)).toBe(false);
  });
});

describe('fitWindowState — 恢复前夹取（换屏 / 改分辨率也不会跑丢）', () => {
  it('小于当前最小尺寸 → 抬到最小尺寸', () => {
    const r = fitWindowState({ width: 700, height: 500 }, WORK, MIN);
    expect(r).toMatchObject({ width: 960, height: 600 });
  });

  it('大于工作区 → 夹到工作区（4K 上存的尺寸搬到 1K 屏）', () => {
    const r = fitWindowState({ width: 3200, height: 2000 }, WORK, MIN);
    expect(r).toMatchObject({ width: 1920, height: 1040 });
  });

  it('位置越界 → 夹回「完整可见」范围内', () => {
    expect(fitWindowState({ width: 1280, height: 800, x: 5000, y: 5000 }, WORK, MIN)).toMatchObject({ x: 1920 - 1280, y: 1040 - 800 });
    expect(fitWindowState({ width: 1280, height: 800, x: -300, y: -120 }, WORK, MIN)).toMatchObject({ x: 0, y: 0 });
  });

  it('窗口比工作区还大 → 位置贴工作区左/上边（右侧/底部溢出）', () => {
    const work = { x: 100, y: 50, width: 1600, height: 900 };
    const r = fitWindowState({ width: 3000, height: 2000, x: 999, y: 999 }, work, MIN);
    expect(r).toMatchObject({ width: 1600, height: 900, x: 100, y: 50 });
  });

  it('没记过位置 → 不凭空造位置（交给系统决定）', () => {
    const r = fitWindowState({ width: 1280, height: 800 }, WORK, MIN);
    expect(r).not.toHaveProperty('x');
    expect(r).not.toHaveProperty('y');
  });

  it('maximized 原样透传', () => {
    expect(fitWindowState({ width: 1280, height: 800, maximized: true }, WORK, MIN)).toMatchObject({ maximized: true });
    expect(fitWindowState({ width: 1280, height: 800 }, WORK, MIN)).not.toHaveProperty('maximized');
  });

  it('工作区带偏移（副屏 / 任务栏在左）也按工作区夹', () => {
    const work = { x: -1920, y: 0, width: 1920, height: 1040 };
    // 工作区内的位置原样保留（主用法：副屏上的窗口下次仍开在副屏）
    expect(fitWindowState({ width: 1280, height: 800, x: -1900, y: 10 }, work, MIN)).toMatchObject({ x: -1900, y: 10 });
    // 跑到工作区外（副屏被拔掉 / 分辨率变小）→ 夹回工作区
    expect(fitWindowState({ width: 1280, height: 800, x: -5000, y: 3000 }, work, MIN)).toMatchObject({ x: -1920, y: 1040 - 800 });
  });
});
