// tests/appCacheDir.spec.ts
// 事故回归护栏：应用私有缓存目录**绝不能与 Chromium 的缓存目录重名**。
//
// 事故：Windows 路径大小写不敏感，而 Electron/Chromium 的磁盘缓存目录是 `<userData>/Cache`。
// 我们曾用 `<userData>/cache` 放应用私有缓存（jar 转换产物 / unidbg / 内嵌 Python / SpiderLocal KV），
// 两者落到**同一个物理目录** → Chromium 启动时清理它「拥有」的缓存目录，把这些全删了。
// 现象：第一次加载完、关掉再开又提示「首次加载」，且每次启动都要重跑数分钟 dex2jar。
//
// 实测（时段，200ms 轮询该目录）
//   DELETED ...\cache\spider          ← 启动 2.5s 后
//   DELETED ...\cache\spider\converted
//   CREATED ...\cache\spider          ← 0.6s 后由本应用重建
//   手动放入的 PROBE.txt / PROBE_DIR 在启动后一并消失，只剩 Chromium 自己的 Cache_Data。
import { afterEach, describe, it, expect, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => 'C:/Users/u/AppData/Roaming/win-box' } }));

import { APP_CACHE_DIR_NAME, cacheDir, spiderCacheDir, localImportsDir } from '../src/main/util/paths';
import { SAFE_USERDATA_SUBDIRS } from '../src/main/util/cacheClean';
import { setPlatformForTest, withPlatform } from '../src/shared/platform';

/** Windows 大小写不敏感比较 */
const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

describe('应用私有缓存目录名 — 不得与 Chromium 缓存目录重名', () => {
  it('不与「清理缓存」列表里的任何 Chromium 自有目录重名（大小写不敏感）', () => {
    for (const sub of SAFE_USERDATA_SUBDIRS) {
      expect(
        same(APP_CACHE_DIR_NAME, sub),
        `应用缓存目录名 "${APP_CACHE_DIR_NAME}" 与 Chromium 目录 "${sub}" 重名 —— ` +
          'Windows 下会变成同一个物理目录，Chromium 启动时会把我们的转换产物/运行时删掉',
      ).toBe(false);
    }
  });

  it('历史 bug：不得再叫 cache / Cache（与 Chromium 的 Cache 同目录）', () => {
    expect(same(APP_CACHE_DIR_NAME, 'cache')).toBe(false);
    expect(same(APP_CACHE_DIR_NAME, 'Cache')).toBe(false);
  });

  it('路径挂载正确：cacheDir / spiderCacheDir 都以该名字开头', () => {
    expect(cacheDir().replace(/\\/g, '/').endsWith(`/win-box/${APP_CACHE_DIR_NAME}`)).toBe(true);
    expect(spiderCacheDir().replace(/\\/g, '/')).toBe(
      `${cacheDir().replace(/\\/g, '/')}/spider`,
    );
  });
});

// ★ 2026-10-12（macOS 适配 P0-8）：任何落盘路径都不得进 `.app` 内部。
describe('落盘路径 — ★ 绝不写进 .app（darwin 一律挂 userData 下）', () => {
  afterEach(() => {
    setPlatformForTest(null);
  });

  it('★ darwin：localImportsDir() 位于 userData/imports 下', () => {
    const dir = withPlatform('darwin', () => localImportsDir());
    expect(dir.replace(/\\/g, '/')).toBe('C:/Users/u/AppData/Roaming/win-box/imports');
  });

  it('★ darwin：缓存目录同样挂在 userData 下（不进 .app）', () => {
    const d = withPlatform('darwin', () => cacheDir());
    expect(d.replace(/\\/g, '/').includes('Win-Box.app')).toBe(false);
    expect(d.replace(/\\/g, '/').startsWith('C:/Users/u/AppData/Roaming/win-box/')).toBe(true);
  });

  it('win32：显式注入与缺省一致（缓存目录不因平台变化）', () => {
    const def = cacheDir();
    const win = withPlatform('win32', () => cacheDir());
    expect(win).toBe(def);
  });
});
