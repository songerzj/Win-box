// tests/dataDirBootstrap.spec.ts
// dataDirBootstrap 接线单测（mock electron）——
//   dev 不动 / 打包态切到安装目录/data 并迁移 / 目标不可写回退 / 迁移失败回滚 setPath 并保留旧目录。
//   模块是「import 即执行」，每个用例先 vi.resetModules() 再动态 import 拿全新实例。
import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setPlatformForTest } from '../src/shared/platform';

const state = vi.hoisted(() => ({
  isPackaged: false,
  userData: '',
  exe: '',
  setPathCalls: [] as Array<[string, string]>,
}));

vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return state.isPackaged;
    },
    getPath: (name: string) => (name === 'userData' ? state.userData : state.exe),
    setPath: (name: string, p: string) => {
      state.setPathCalls.push([name, p]);
    },
  },
}));

const dirs: string[] = [];
function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'datadir-boot-'));
  dirs.push(d);
  return d;
}

beforeEach(() => {
  state.isPackaged = false;
  state.userData = '';
  state.exe = '';
  state.setPathCalls = [];
  delete process.env.PORTABLE_EXECUTABLE_DIR;
  // ★ 双向清理：进用例前也清一次，避免并行 spec 文件留下的注入值影响本文件
  delete process.env.WINBOX_TEST_PLATFORM;
});

afterEach(() => {
  // ★ 平台注入必须还原（env + 模块级变量两处都清）
  delete process.env.WINBOX_TEST_PLATFORM;
  setPlatformForTest(null);
  for (const d of dirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  dirs.length = 0;
});

/**
 * 平台注入说明（★★ 实测结论，两条别改）：
 *
 * ① **本模块是「import 即执行」，spec 必须在动态 import 之前把平台注入到位。**
 *    vitest 的 `vi.resetModules()` 会重建模块上下文，模块内的注入状态会丢；
 *    实测可靠做法 = spec 直接写 `process.env.WINBOX_TEST_PLATFORM`
 *    （`src/shared/platform.ts` 的 `platformName()` 会优先读它）。
 *    所以别改成 `withPlatform()` —— 对这类模块无效。
 *
 * ② **每一条用例都必须显式钉死平台（`importBootstrap('win32')`），绝不能依赖「环境默认值」。**
 *    `process.env` 是**进程级全局**，而 vitest `vmThreads` 的多个 worker 是同进程的不同线程
 *    → 并行跑的**其它 spec 文件**若写了 `WINBOX_TEST_PLATFORM='darwin'`，
 *    这里读到的默认值就会变成 darwin，用例随机失败（已实际观测到）。
 *    显式钉死 = 与主机平台、与并行污染都无关。
 */
async function importBootstrap(platform: 'win32' | 'darwin' = 'win32') {
  process.env.WINBOX_TEST_PLATFORM = platform;
  vi.resetModules();
  return await import('../src/main/util/dataDirBootstrap');
}

describe('dataDirBootstrap — 启动接线', () => {
  it('开发态：不切换、不迁移（沿用系统默认位置）', async () => {
    const base = tmpDir();
    state.isPackaged = false;
    state.userData = join(base, 'appdata', 'win-box');
    state.exe = join(base, 'node_modules', 'electron.exe');
    const { dataDirReport } = await importBootstrap('win32');
    expect(dataDirReport.mode).toBe('dev');
    expect(state.setPathCalls.length).toBe(0);
  });

  it('打包态：切到安装目录/data，老数据自动迁移（含旧目录清理）', async () => {
    const base = tmpDir();
    const legacy = join(base, 'appdata', 'win-box');
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, 'user-config.json'), '{"version":2}');
    state.isPackaged = true;
    state.userData = legacy;
    state.exe = join(base, 'install', 'Win-Box.exe');
    const { dataDirReport } = await importBootstrap('win32');
    expect(dataDirReport.mode).toBe('activated');
    expect(dataDirReport.target).toBe(join(base, 'install', 'data'));
    expect(state.setPathCalls).toEqual([['userData', join(base, 'install', 'data')]]);
    expect(existsSync(join(base, 'install', 'data', 'user-config.json'))).toBe(true);
    expect(existsSync(legacy)).toBe(false); // 旧 C 盘目录已清理
  });

  it('安装目录不可写：回退系统默认位置、不迁移、不动旧目录', async () => {
    const base = tmpDir();
    const legacy = join(base, 'appdata', 'win-box');
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, 'user-config.json'), 'cfg');
    mkdirSync(join(base, 'install'), { recursive: true });
    writeFileSync(join(base, 'install', 'data'), 'occupied'); // 目标路径被同名文件占据 → 探测失败
    state.isPackaged = true;
    state.userData = legacy;
    state.exe = join(base, 'install', 'Win-Box.exe');
    const { dataDirReport } = await importBootstrap('win32');
    expect(dataDirReport.mode).toBe('fallback');
    expect(state.setPathCalls.length).toBe(0); // 未切换
    expect(existsSync(join(legacy, 'user-config.json'))).toBe(true); // 旧数据原样
  });

  it('迁移失败：回滚 setPath 到旧目录、旧数据保留、下次启动重试', async () => {
    const base = tmpDir();
    const legacy = join(base, 'appdata', 'win-box');
    const target = join(base, 'install', 'data');
    mkdirSync(legacy, { recursive: true });
    mkdirSync(target, { recursive: true });
    writeFileSync(join(legacy, 'user-config.json'), 'cfg');
    mkdirSync(join(target, 'user-config.json'), { recursive: true }); // 同名目录 → 复制必失败
    state.isPackaged = true;
    state.userData = legacy;
    state.exe = join(base, 'install', 'Win-Box.exe');
    const { dataDirReport } = await importBootstrap('win32');
    expect(dataDirReport.mode).toBe('fallback');
    // 先切到目标、失败后回滚到旧目录
    expect(state.setPathCalls).toEqual([
      ['userData', target],
      ['userData', legacy],
    ]);
    expect(existsSync(join(legacy, 'user-config.json'))).toBe(true);
    expect(dataDirReport.migration?.status).toBe('failed');
  });

  it('便携版：PORTABLE_EXECUTABLE_DIR 优先作为数据目录根', async () => {
    const base = tmpDir();
    const portableDir = join(base, 'usb', 'Win-Box');
    mkdirSync(portableDir, { recursive: true });
    state.isPackaged = true;
    state.userData = join(base, 'appdata', 'win-box');
    state.exe = join(base, 'temp-extract', 'Win-Box.exe'); // portable 运行时的临时解压目录
    process.env.PORTABLE_EXECUTABLE_DIR = portableDir;
    const { dataDirReport } = await importBootstrap('win32');
    expect(dataDirReport.mode).toBe('activated');
    expect(dataDirReport.target).toBe(join(portableDir, 'data'));
  });
});

// ★ 2026-10-12（macOS 适配 P0-8）：darwin 下 bootstrap 必须**完全不动** userData
//   —— 不 setPath、不迁移、不删旧目录（写进 `.app` 会破坏签名密封）。
describe('dataDirBootstrap — darwin（绝不搬运、绝不写进 .app）', () => {
  it('★ darwin 打包态：activate=false，不 setPath、不迁移、不动旧目录', async () => {
    const base = tmpDir();
    const legacy = join(base, 'Library', 'Application Support', 'Win-Box');
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, 'user-config.json'), '{"version":2}');
    state.isPackaged = true;
    state.userData = legacy;
    state.exe = join(base, 'Applications', 'Win-Box.app', 'Contents', 'MacOS', 'Win-Box');
    const { dataDirReport } = await importBootstrap('darwin');
    expect(dataDirReport.mode).toBe('dev');
    expect(dataDirReport.target).toBe(legacy);
    expect(state.setPathCalls.length).toBe(0);
    expect(dataDirReport.migration).toBeUndefined();
    // 旧目录原样保留（根本没有迁移发生）
    expect(existsSync(join(legacy, 'user-config.json'))).toBe(true);
    expect(existsSync(join(base, 'Applications', 'Win-Box.app', 'Contents', 'data'))).toBe(false);
  });

  it('★ darwin：target 绝不含 .app', async () => {
    const base = tmpDir();
    state.isPackaged = true;
    state.userData = join(base, 'Library', 'Application Support', 'Win-Box');
    state.exe = join(base, 'Applications', 'Win-Box.app', 'Contents', 'MacOS', 'Win-Box');
    const { dataDirReport } = await importBootstrap('darwin');
    expect(dataDirReport.target.includes('.app')).toBe(false);
    expect(dataDirReport.planned.includes('.app')).toBe(false);
  });

  it('★ win32：显式注入后行为与缺省（Windows 主机）一致 —— 零回归', async () => {
    const base = tmpDir();
    const legacy = join(base, 'appdata', 'win-box');
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, 'user-config.json'), 'cfg');
    state.isPackaged = true;
    state.userData = legacy;
    state.exe = join(base, 'install', 'Win-Box.exe');
    const { dataDirReport } = await importBootstrap('win32');
    expect(dataDirReport.mode).toBe('activated');
    expect(dataDirReport.target).toBe(join(base, 'install', 'data'));
  });
});