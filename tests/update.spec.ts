// tests/update.spec.ts
// 启动更新的纯逻辑单测：版本归一化/比较、是否需更新、加速地址拼接、
// Setup 安装包挑选、Release JSON 解析、字节格式化。零 Electron 依赖。
import { describe, expect, it } from 'vitest';
import {
  FORCE_UPDATE_CHECK_ENV,
  GH_ACCEL_PREFIXES,
  UPDATE_RELEASES_API,
  buildAccelUrls,
  compareVersions,
  envForcesUpdateCheck,
  formatBytes,
  isUpdateAvailable,
  normalizeVersion,
  parseLatestRelease,
  parseVersion,
  pickInstallerAsset,
  pickSetupAsset,
  rankBySpeed,
  sampleBps,
  shouldSkipUpdateCheck,
  type ReleaseAssetInput,
  type SpeedSample,
} from '../src/shared/update';

describe('更新测速：rankBySpeed / sampleBps', () => {
  const s = (url: string, bytes: number, ms: number, ok = true): SpeedSample => ({ url, bytes, ms, ok });

  it('sampleBps：ok=false / 非法耗时 → 0', () => {
    expect(sampleBps(s('a', 1000, 1000))).toBe(1000);
    expect(sampleBps(s('a', 1000, 0))).toBe(0);
    expect(sampleBps(s('a', 0, 100))).toBe(0);
    expect(sampleBps(s('a', 1000, 1000, false))).toBe(0);
  });

  it('有 ttfb 时按「去掉首字节」的段算速率（小样本窗口不被握手时间带偏）', () => {
    // 同一节点：64KB/1.5s 与 2MB/3.5s 两个样本，扣掉首字节后速率才可比
    const small: SpeedSample = { url: 'a', bytes: 64 * 1024, ms: 1500, ok: true, ttfb: 1200 };
    const big: SpeedSample = { url: 'a', bytes: 2 * 1024 * 1024, ms: 3500, ok: true, ttfb: 500 };
    expect(sampleBps(small)).toBe(Math.round((64 * 1024 * 1000) / 300)); // 300ms 内收 64KB
    expect(sampleBps(big)).toBe(Math.round((2 * 1024 * 1024 * 1000) / 3000));
    // 无 ttfb → 退回整段耗时口径（夹具）
    expect(sampleBps({ url: 'a', bytes: 1000, ms: 1000, ok: true, ttfb: 0 })).toBe(1000);
  });

  it('ttfb 非法（负数/超过整段耗时）→ 夹紧到 [0, ms-1]，不产生除零', () => {
    expect(sampleBps({ url: 'a', bytes: 1000, ms: 1000, ok: true, ttfb: -5 })).toBe(1000);
    expect(sampleBps({ url: 'a', bytes: 1000, ms: 1000, ok: true, ttfb: 9999 })).toBe(1000);
  });

  it('按实测速率降序排列；样本不足（错误页）的线路垫底但仍保留', () => {
    const ranked = rankBySpeed([
      s('slow', 300 * 1024, 3000),
      s('fast', 900 * 1024, 1000),
      s('mid', 500 * 1024, 2000),
    ], 256 * 1024);
    expect(ranked).toEqual(['fast', 'mid', 'slow']);
  });

  it('样本字节数不够（< minBytes）视为不可用，排到末尾', () => {
    const ranked = rankBySpeed([
      s('tiny', 1024, 100), // 加速站错误页
      s('ok', 400 * 1024, 2000),
    ], 256 * 1024);
    expect(ranked).toEqual(['ok', 'tiny']);
  });

  it('全部不可用时保持原始顺序（仍作失败回退）', () => {
    const ranked = rankBySpeed([s('a', 0, 50, false), s('b', 0, 60, false)], 256 * 1024);
    expect(ranked).toEqual(['a', 'b']);
  });

  it('空输入 → 空数组', () => {
    expect(rankBySpeed([], 1)).toEqual([]);
  });

  it('加速前缀顺序：代理在前、直连垫底（优先走代理链路）', () => {
    const urls = buildAccelUrls('https://github.com/o/r/releases/download/x/a.exe');
    expect(urls[0].startsWith(GH_ACCEL_PREFIXES[0])).toBe(true);
    expect(urls[urls.length - 1]).toBe('https://github.com/o/r/releases/download/x/a.exe');
  });
});

describe('normalizeVersion', () => {
  it('剥离 release / v 前后缀', () => {
    expect(normalizeVersion('release1.13.0')).toBe('1.13.0');
    expect(normalizeVersion('v1.13.0')).toBe('1.13.0');
    expect(normalizeVersion('V1.13.0')).toBe('1.13.0');
    expect(normalizeVersion('release-1.2.3')).toBe('1.2.3');
    expect(normalizeVersion('1.13.0')).toBe('1.13.0');
    expect(normalizeVersion('  release1.13.0 ')).toBe('1.13.0');
  });
});

describe('parseVersion', () => {
  it('抽取数字段', () => {
    expect(parseVersion('1.13.0')).toEqual([1, 13, 0]);
    expect(parseVersion('release1.13.0')).toEqual([1, 13, 0]);
    expect(parseVersion('release97')).toEqual([97]);
    expect(parseVersion('v1.13.0-beta.2')).toEqual([1, 13, 0, 2]);
    expect(parseVersion('nope')).toEqual([]);
  });
});

describe('compareVersions', () => {
  it('语义化比较（缺位补 0）', () => {
    expect(compareVersions('1.12.0', '1.13.0')).toBe(-1);
    expect(compareVersions('1.13.0', '1.12.0')).toBe(1);
    expect(compareVersions('1.13.0', '1.13.0')).toBe(0);
    expect(compareVersions('1.13', '1.13.0')).toBe(0);
    expect(compareVersions('1.13.0', '1.13')).toBe(0);
    expect(compareVersions('1.9.0', '1.10.0')).toBe(-1);
    expect(compareVersions('2.0.0', '1.99.99')).toBe(1);
  });
});

describe('isUpdateAvailable', () => {
  it('远端更高 → 需更新；相等/更低/解析不出 → 否', () => {
    expect(isUpdateAvailable('1.12.0', 'release1.13.0')).toBe(true);
    expect(isUpdateAvailable('1.13.0', 'release1.13.0')).toBe(false);
    expect(isUpdateAvailable('1.13.0', 'release1.12.0')).toBe(false);
    // 远端版本解析不出来 → 绝不判定为有更新（避免误锁死软件）
    expect(isUpdateAvailable('1.12.0', '')).toBe(false);
    expect(isUpdateAvailable('1.12.0', 'nightly')).toBe(false);
  });
});

describe('★ 2026-10-12 shouldSkipUpdateCheck · 开发模式跳过启动强制更新', () => {
  it('开发模式（未打包）默认跳过 → true（放行界面，不锁死）', () => {
    expect(shouldSkipUpdateCheck({ isPackaged: false, forceCheck: false })).toBe(true);
  });

  it('开发模式 + 逃生舱 forceCheck → 不跳过（照常检查）', () => {
    expect(shouldSkipUpdateCheck({ isPackaged: false, forceCheck: true })).toBe(false);
  });

  it('正式安装包（已打包）恒不跳过 → false（硬约束：已发布版本行为零变更）', () => {
    expect(shouldSkipUpdateCheck({ isPackaged: true, forceCheck: false })).toBe(false);
    expect(shouldSkipUpdateCheck({ isPackaged: true, forceCheck: true })).toBe(false);
  });
});

describe('★ 2026-10-12 envForcesUpdateCheck · WINBOX_FORCE_UPDATE_CHECK 解析', () => {
  it('真值（1/true/yes/on，大小写不敏感，含空格）→ true', () => {
    expect(envForcesUpdateCheck({ [FORCE_UPDATE_CHECK_ENV]: '1' })).toBe(true);
    expect(envForcesUpdateCheck({ [FORCE_UPDATE_CHECK_ENV]: 'true' })).toBe(true);
    expect(envForcesUpdateCheck({ [FORCE_UPDATE_CHECK_ENV]: 'YES' })).toBe(true);
    expect(envForcesUpdateCheck({ [FORCE_UPDATE_CHECK_ENV]: '  On  ' })).toBe(true);
  });

  it('缺失 / 空串 / 0 / false 等假值 → false', () => {
    expect(envForcesUpdateCheck({})).toBe(false);
    expect(envForcesUpdateCheck({ [FORCE_UPDATE_CHECK_ENV]: '' })).toBe(false);
    expect(envForcesUpdateCheck({ [FORCE_UPDATE_CHECK_ENV]: '0' })).toBe(false);
    expect(envForcesUpdateCheck({ [FORCE_UPDATE_CHECK_ENV]: 'false' })).toBe(false);
    expect(envForcesUpdateCheck({ [FORCE_UPDATE_CHECK_ENV]: undefined })).toBe(false);
  });
});

describe('buildAccelUrls', () => {
  it('前缀顺序拼接 + 直连兜底；空地址 → 空数组', () => {
    const raw = 'https://github.com/o/r/releases/download/t/a.exe';
    const urls = buildAccelUrls(raw, GH_ACCEL_PREFIXES);
    expect(urls).toHaveLength(GH_ACCEL_PREFIXES.length + 1);
    expect(urls[0]).toBe(GH_ACCEL_PREFIXES[0] + raw);
    expect(urls[urls.length - 1]).toBe(raw);
    expect(buildAccelUrls('', GH_ACCEL_PREFIXES)).toEqual([]);
  });

  it('前缀末尾有无斜杠都能正确拼接', () => {
    expect(buildAccelUrls('https://g.com/x', ['https://p.test'])).toEqual(['https://p.test/https://g.com/x', 'https://g.com/x']);
  });

  it('API 端点同样可加速', () => {
    const urls = buildAccelUrls(UPDATE_RELEASES_API, GH_ACCEL_PREFIXES);
    expect(urls[0]).toContain('/https://api.github.com/repos/');
  });
});

describe('pickSetupAsset', () => {
  const assets = [
    { name: 'Win-Box.1.13.0.exe', browser_download_url: 'https://g/portable', size: 100 },
    { name: 'Win-Box.Setup.1.13.0.exe', browser_download_url: 'https://g/setup', size: 200 },
    { name: 'Win-Box Setup 1.13.0 增量更新.exe', browser_download_url: 'https://g/incr', size: 10 },
  ];

  it('优先挑 Setup 安装包（版本匹配者）', () => {
    expect(pickSetupAsset(assets, '1.13.0')?.name).toBe('Win-Box.Setup.1.13.0.exe');
  });

  it('无版本参数时取第一个 setup', () => {
    expect(pickSetupAsset(assets)?.name).toBe('Win-Box.Setup.1.13.0.exe');
  });

  it('没有 setup 时回退到任意 .exe；没有 .exe → null', () => {
    const onlyPortable = assets.filter((a) => !/setup/i.test(a.name));
    expect(pickSetupAsset(onlyPortable)?.name).toBe('Win-Box.1.13.0.exe');
    expect(pickSetupAsset([{ name: 'src.zip', browser_download_url: 'u', size: 1 }])).toBeNull();
    expect(pickSetupAsset([])).toBeNull();
  });
});

describe('★ 2026-10-12 pickInstallerAsset · darwin（原实现只认 .exe → darwin 恒 null，本次修复）', () => {
  const a = (name: string): ReleaseAssetInput => ({ name, browser_download_url: `https://g/${name}`, size: 100 });
  // 故意把 x64 排在 arm64 前面：验证「按 arch 挑」而不是「取第一个」
  const both = [a('Win-Box-1.20.10-x64.dmg'), a('Win-Box-1.20.10-arm64.dmg'), a('Win-Box-1.20.10-x64.zip'), a('Win-Box-1.20.10-arm64.zip')];

  it('arm64 → 优先 -arm64.dmg（原实现在此恒返回 null）', () => {
    expect(pickInstallerAsset(both, { platform: 'darwin', arch: 'arm64' })?.name).toBe('Win-Box-1.20.10-arm64.dmg');
  });

  it('x64 → 优先 -x64.dmg', () => {
    expect(pickInstallerAsset(both, { platform: 'darwin', arch: 'x64' })?.name).toBe('Win-Box-1.20.10-x64.dmg');
  });

  it('arch 缺省（= 当前架构 archTag()）仍能挑出 dmg，不再恒 null', () => {
    expect(pickInstallerAsset(both, { platform: 'darwin' })?.name).toMatch(/\.dmg$/);
  });

  it('① 无对应架构的 dmg → ② 回退到含版本号的 dmg', () => {
    const list = [a('Win-Box-1.19.0.dmg'), a('Win-Box-1.20.10.dmg')];
    expect(pickInstallerAsset(list, { platform: 'darwin', arch: 'arm64', version: 'release1.20.10' })?.name).toBe('Win-Box-1.20.10.dmg');
  });

  it('② 版本号也对不上 → ③ 任意 .dmg（按 Release 里的原始顺序取第一条）', () => {
    const list = [a('Win-Box-0.0.1.dmg'), a('Win-Box-9.9.9.dmg')];
    expect(pickInstallerAsset(list, { platform: 'darwin', arch: 'arm64', version: '1.20.10' })?.name).toBe('Win-Box-0.0.1.dmg');
  });

  it('③ 完全没有 dmg → ④ 回退 .zip（darwin 便携包兜底）', () => {
    const list = [a('Win-Box-1.20.10-arm64.zip'), a('src.tar.gz')];
    expect(pickInstallerAsset(list, { platform: 'darwin', arch: 'arm64' })?.name).toBe('Win-Box-1.20.10-arm64.zip');
  });

  it('④ 什么安装包都没有 → null（不做强制更新，绝不锁死软件）', () => {
    expect(pickInstallerAsset([a('latest.yml'), a('src.tar.gz')], { platform: 'darwin', arch: 'arm64' })).toBeNull();
    expect(pickInstallerAsset([], { platform: 'darwin' })).toBeNull();
  });

  it('arch=""（未知架构）→ 跳过架构档，仍按版本 → 任意 dmg → zip', () => {
    const list = [a('Win-Box-1.20.10-arm64.dmg'), a('Win-Box-1.20.10-x64.dmg')];
    expect(pickInstallerAsset(list, { platform: 'darwin', arch: '' })?.name).toBe('Win-Box-1.20.10-arm64.dmg');
  });

  it('字段缺失 / 非数组的容错（不抛异常）', () => {
    expect(pickInstallerAsset([{ name: '', browser_download_url: 'u', size: 1 }], { platform: 'darwin' })).toBeNull();
    expect(pickInstallerAsset(undefined as unknown as ReleaseAssetInput[], { platform: 'darwin' })).toBeNull();
  });
});

describe('★ 2026-10-12 pickInstallerAsset · win32 ≡ pickSetupAsset（Windows 零回归）', () => {
  const a = (name: string): ReleaseAssetInput => ({ name, browser_download_url: `https://g/${name}`, size: 100 });
  const cases: ReleaseAssetInput[][] = [
    [a('Win-Box.1.13.0.exe'), a('Win-Box.Setup.1.13.0.exe'), a('Win-Box Setup 1.13.0 增量更新.exe')],
    [a('Win-Box.1.13.0.exe')],
    [a('src.zip')],
    [a('Win-Box-1.20.10-arm64.dmg')],
    [],
  ];

  it('逐组结果完全一致（有/无 version 参数都要一致）', () => {
    for (const assets of cases) {
      expect(pickInstallerAsset(assets, { platform: 'win32' })).toBe(pickSetupAsset(assets));
      expect(pickInstallerAsset(assets, { platform: 'win32', version: '1.13.0' })).toBe(pickSetupAsset(assets, '1.13.0'));
    }
  });

  it('platform 缺省 = win32（既有调用点不传平台，行为不变）', () => {
    const assets = [a('Win-Box.1.13.0.exe'), a('Win-Box.Setup.1.13.0.exe')];
    expect(pickInstallerAsset(assets)?.name).toBe('Win-Box.Setup.1.13.0.exe');
    expect(pickInstallerAsset(assets, {})?.name).toBe(pickSetupAsset(assets)?.name);
  });

  it('win32 下即便 Release 里混了 dmg，也只挑 exe', () => {
    const assets = [a('Win-Box-1.20.10-arm64.dmg'), a('Win-Box.Setup.1.20.10.exe')];
    expect(pickInstallerAsset(assets, { platform: 'win32', version: '1.20.10' })?.name).toBe('Win-Box.Setup.1.20.10.exe');
  });
});

describe('parseLatestRelease', () => {
  it('解析 tag/版本/名称/说明/时间/资产', () => {
    const r = parseLatestRelease({
      tag_name: 'release1.13.0',
      name: 'release1.13.0 · v1.13.0',
      body: 'notes',
      published_at: '2026-09-29T10:00:00Z',
      assets: [{ name: 'a.exe', browser_download_url: 'https://g/a', size: 5 }],
    });
    expect(r).toMatchObject({ tag: 'release1.13.0', version: '1.13.0', name: 'release1.13.0 · v1.13.0', notes: 'notes' });
    expect(r.assets).toHaveLength(1);
  });

  it('字段缺失容错', () => {
    const r = parseLatestRelease({});
    expect(r).toMatchObject({ tag: '', version: '', name: '', notes: '', assets: [] });
  });
});

describe('formatBytes', () => {
  it('B / KB / MB / GB', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(formatBytes(2 * 1024 * 1024 * 1024)).toBe('2.00 GB');
    expect(formatBytes(-1)).toBe('0 B');
  });
});
