// tests/externalPlayer.spec.ts — 点播外部播放器「起播位置」参数（新增）
//
// 「从历史记录启动第三方播放器，播放器也应该正确识别历史播放的位置。」
// 各播放器的命令行语法互不兼容 → 这里把「秒 → 参数」的映射按类型钉住：
// 传错会被当成待打开的文件名（弹一堆错误窗口），所以未知/无稳定参数的播放器**必须不传**。
import { beforeEach, describe, it, expect, vi } from 'vitest';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
import { spawn } from 'node:child_process';
import {
  seekArgs,
  playerCandidates,
  pickPlayers,
  detectPlayers,
  launchPlayer,
  type ExternalPlayer,
} from '../src/main/torrent/externalPlayer';
import { platformName, type PlatformName } from '../src/shared/platform';

/** spawn 的假子进程（只要够 `on` / `unref` 即可） */
const fakeChild = (): { on: () => void; unref: () => void } => ({ on: vi.fn(), unref: vi.fn() });
/** 最近一次 spawn 的 (命令, 参数)（复制成可变数组，便于断言） */
const lastSpawn = (): { cmd: string; args: string[] } => {
  const call = vi.mocked(spawn).mock.calls.at(-1)!;
  return { cmd: String(call[0]), args: [...(call[1] as readonly string[])] };
};

describe('seekArgs — 各播放器的起播参数（互不兼容，只对确认支持的传）', () => {
  it('PotPlayer：/seek=hh:mm:ss', () => {
    expect(seekArgs('potplayer', 0)).toEqual([]);
    expect(seekArgs('potplayer', 75)).toEqual(['/seek=0:01:15']);
    expect(seekArgs('potplayer', 3725)).toEqual(['/seek=1:02:05']);
    expect(seekArgs('potplayer', 3600)).toEqual(['/seek=1:00:00']);
  });

  it('VLC：--start-time=<秒>；mpv：--start=<秒>', () => {
    expect(seekArgs('vlc', 75)).toEqual(['--start-time=75']);
    expect(seekArgs('mpv', 75)).toEqual(['--start=75']);
    // mpv.net 与 mpv 同 id（候选表里同名）
    expect(seekArgs('mpv', 3725)).toEqual(['--start=3725']);
  });

  it('MPC-HC / 自定义 / 未知播放器：不传（语法不保证，传错会被当成文件名）', () => {
    expect(seekArgs('mpc-hc', 75)).toEqual([]);
    expect(seekArgs('custom', 75)).toEqual([]);
    expect(seekArgs('', 75)).toEqual([]);
  });

  it('非法/非正数秒一律不传', () => {
    expect(seekArgs('vlc', 0)).toEqual([]);
    expect(seekArgs('vlc', -3)).toEqual([]);
    expect(seekArgs('vlc', NaN)).toEqual([]);
    expect(seekArgs('vlc', Number.POSITIVE_INFINITY)).toEqual([]);
    expect(seekArgs('vlc', 0.9)).toEqual([]); // 向下取整 → 0 → 不传
    expect(seekArgs('vlc', 1.9)).toEqual(['--start-time=1']); // 向下取整到整秒
  });
});

describe('播放器候选表（回归：起播参数依赖 id 判定，id 不能漂）', () => {
  it('PotPlayer / VLC / mpv / MPC-HC 的 id 与 seekArgs 的判据一致', () => {
    // ★ 显式 'win32'：该用例测的是 Windows 候选表的 id 集合，不能依赖环境默认平台
    const ids = new Set(playerCandidates({ ProgramFiles: 'C:\\PF' }, 'win32').map((p) => p.id));
    for (const id of ['potplayer', 'vlc', 'mpv', 'mpc-hc']) expect(ids.has(id)).toBe(true);
  });

  it('pickPlayers 按**路径**去重（同一 exe 只留第一个命中）', () => {
    const cands: ExternalPlayer[] = [
      { id: 'mpv', name: 'mpv', path: 'C:\\a\\mpv.exe' },
      { id: 'mpv', name: 'mpv', path: 'C:\\a\\mpv.exe' },
      { id: 'vlc', name: 'VLC', path: 'C:\\c\\vlc.exe' },
    ];
    const out = pickPlayers(cands, () => true);
    expect(out.map((p) => p.path)).toEqual(['C:\\a\\mpv.exe', 'C:\\c\\vlc.exe']);
  });

  it('pickPlayers 过滤不存在的路径（exists 返回 false 的不列出）', () => {
    const cands: ExternalPlayer[] = [
      { id: 'mpv', name: 'mpv', path: 'C:\\no\\mpv.exe' },
      { id: 'vlc', name: 'VLC', path: 'C:\\c\\vlc.exe' },
    ];
    const out = pickPlayers(cands, (p) => p.includes('vlc'));
    expect(out.map((p) => p.path)).toEqual(['C:\\c\\vlc.exe']);
  });
});

// ★ 2026-10-12（macOS 适配 T01）：候选表平台化 + IINA 起播参数。
describe('候选表平台化 — darwin 覆盖 VLC / IINA / mpv，win32 一字不变', () => {
  const MAC_ENV = { HOME: '/Users/u' };

  it('★ darwin：含 VLC.app / IINA.app / mpv.app（/Applications + ~/Applications）+ Homebrew mpv', () => {
    const paths = playerCandidates(MAC_ENV, 'darwin', '/Users/u').map((p) => p.path);
    expect(paths).toContain('/Applications/VLC.app/Contents/MacOS/VLC');
    expect(paths).toContain('/Users/u/Applications/VLC.app/Contents/MacOS/VLC');
    expect(paths).toContain('/Applications/IINA.app/Contents/MacOS/IINA');
    expect(paths).toContain('/Users/u/Applications/IINA.app/Contents/MacOS/IINA');
    expect(paths).toContain('/Applications/mpv.app/Contents/MacOS/mpv');
    expect(paths).toContain('/Users/u/Applications/mpv.app/Contents/MacOS/mpv');
    expect(paths).toContain('/opt/homebrew/bin/mpv');
    expect(paths).toContain('/usr/local/bin/mpv');
  });

  it('★ darwin：优先级 = VLC → IINA → mpv（首个命中即首选）', () => {
    const ids = playerCandidates(MAC_ENV, 'darwin', '/Users/u').map((p) => p.id);
    expect(ids[0]).toBe('vlc');
    expect(ids.indexOf('iina')).toBeLessThan(ids.indexOf('mpv'));
    expect(new Set(ids)).toEqual(new Set(['vlc', 'iina', 'mpv']));
  });

  it('★ win32：候选与改动前逐项相同（15 条 Program Files 系，一条不少）', () => {
    const pf = 'C:\\PF';
    const pf86 = 'C:\\PF86';
    const la = 'C:\\Users\\u\\AppData\\Local';
    const env = { ProgramFiles: pf, 'ProgramFiles(x86)': pf86, LOCALAPPDATA: la } as Record<string, string | undefined>;
    const expectWin: Array<[string, string, string]> = [
      ['potplayer', 'PotPlayer', `${pf}\\DAUM\\PotPlayer\\PotPlayerMini64.exe`],
      ['potplayer', 'PotPlayer', `${pf}\\PotPlayer\\PotPlayerMini64.exe`],
      ['potplayer', 'PotPlayer', `${la}\\Programs\\PotPlayer\\PotPlayerMini64.exe`],
      ['potplayer', 'PotPlayer', `${pf}\\DAUM\\PotPlayer\\PotPlayerMini.exe`],
      ['vlc', 'VLC', `${pf}\\VideoLAN\\VLC\\vlc.exe`],
      ['vlc', 'VLC', `${pf86}\\VideoLAN\\VLC\\vlc.exe`],
      ['vlc', 'VLC', `${la}\\Programs\\VideoLAN\\VLC\\vlc.exe`],
      ['mpv', 'mpv', `${pf}\\mpv\\mpv.exe`],
      ['mpv', 'mpv.net', `${pf}\\mpv.net\\mpvnet.exe`],
      ['mpv', 'mpv', `${la}\\Programs\\mpv\\mpv.exe`],
      ['mpc-hc', 'MPC-HC', `${pf}\\K-Lite Codec Pack\\MPC-HC64\\mpc-hc64.exe`],
      ['mpc-hc', 'MPC-HC', `${pf}\\MPC-HC\\mpc-hc64.exe`],
      ['mpc-hc', 'MPC-HC', `${pf86}\\K-Lite Codec Pack\\MPC-HC64\\mpc-hc64.exe`],
    ];
    const got = playerCandidates(env, 'win32');
    expect(got.length).toBe(expectWin.length);
    expect(got).toEqual(expectWin.map(([id, name, path]) => ({ id, name, path })));
  });

  it('缺省 platform 与显式传「当前生效平台」逐项一致（与主机、与并行注入都无关）', () => {
    const env = { ProgramFiles: 'C:\\PF' } as Record<string, string | undefined>;
    // ★ 两侧都传同一个「当前生效平台」；真正的 win32 零回归锁在上一组**显式 platform:'win32'** 用例里
    expect(playerCandidates(env)).toEqual(playerCandidates(env, platformName(), undefined));
  });

  it('各平台候选均非空且路径无重复（darwin / win32）', () => {
    for (const p of ['win32', 'darwin'] as PlatformName[]) {
      const list = playerCandidates(MAC_ENV, p, '/Users/u');
      expect(list.length).toBeGreaterThan(0);
      expect(new Set(list.map((x) => x.path)).size).toBe(list.length);
    }
  });
});

describe('seekArgs — IINA（★ 2026-10-12 macOS 适配；IINA 基于 mpv 内核，参数同 mpv）', () => {
  it('IINA：--start=<秒>', () => {
    expect(seekArgs('iina', 75)).toEqual(['--start=75']);
    expect(seekArgs('iina', 3725)).toEqual(['--start=3725']);
    expect(seekArgs('iina', 0)).toEqual([]);
    expect(seekArgs('iina', -1)).toEqual([]);
    expect(seekArgs('iina', NaN)).toEqual([]);
  });

  it('既有分支一字不变（potplayer / vlc / mpv / mpc-hc / custom）', () => {
    expect(seekArgs('potplayer', 75)).toEqual(['/seek=0:01:15']);
    expect(seekArgs('vlc', 75)).toEqual(['--start-time=75']);
    expect(seekArgs('mpv', 75)).toEqual(['--start=75']);
    expect(seekArgs('mpc-hc', 75)).toEqual([]);
    expect(seekArgs('custom', 75)).toEqual([]);
  });
});

// ★ 2026-10-12（macOS 适配 T03 §3.12）：拉起播放器 / 探测播放器的**接入层**平台化。
describe('launchPlayer — darwin `.app` 必须走 `open -a`（目录不能直接 spawn）', () => {
  beforeEach(() => vi.clearAllMocks());

  it('★ darwin + `.app` 目录 → `open -a <App.app> --args <extraArgs…> <url>`', () => {
    vi.mocked(spawn).mockReturnValue(fakeChild() as any);
    const ok = launchPlayer('/Applications/VLC.app', 'http://127.0.0.1:9978/bt/h/0', ['--start-time=75'], { platform: 'darwin' });
    expect(ok).toBe(true);
    const { cmd, args } = lastSpawn();
    expect(cmd).toBe('open');
    expect(args).toEqual(['-a', '/Applications/VLC.app', '--args', '--start-time=75', 'http://127.0.0.1:9978/bt/h/0']);
  });

  it('★ darwin + `.app/Contents/MacOS/<bin>`（候选表形态）→ 直接 spawn，不经 open', () => {
    vi.mocked(spawn).mockReturnValue(fakeChild() as any);
    expect(launchPlayer('/Applications/IINA.app/Contents/MacOS/IINA', 'http://u/1', [], { platform: 'darwin' })).toBe(true);
    const { cmd, args } = lastSpawn();
    expect(cmd).toBe('/Applications/IINA.app/Contents/MacOS/IINA');
    expect(args).toEqual(['http://u/1']);
  });

  it('win32 行为逐字节不变（直接 spawn 播放器 exe，extraArgs 在 URL 之前）', () => {
    vi.mocked(spawn).mockReturnValue(fakeChild() as any);
    launchPlayer('C:\\PF\\VideoLAN\\VLC\\vlc.exe', 'http://u/2', ['--start-time=1'], { platform: 'win32' });
    const { cmd, args } = lastSpawn();
    expect(cmd).toBe('C:\\PF\\VideoLAN\\VLC\\vlc.exe');
    expect(args).toEqual(['--start-time=1', 'http://u/2']);
    // win32 上 `.app` 不是特殊形态（不会被误判成 open -a）
    vi.clearAllMocks();
    vi.mocked(spawn).mockReturnValue(fakeChild() as any);
    launchPlayer('C:\\weird.app', 'http://u/3', [], { platform: 'win32' });
    expect(lastSpawn().cmd).toBe('C:\\weird.app');
  });

  it('空路径 → false 且不 spawn（用户配置被清空时不炸）', () => {
    expect(launchPlayer('   ', 'http://u/4', [], { platform: 'darwin' })).toBe(false);
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe('detectPlayers — 接入层平台化（★ darwin 不再恒空 → 外部接力可用）', () => {
  it('★ darwin：装了 VLC.app → 能真的探到（id=vlc，外部接力不再全断）', () => {
    const vlc = '/Applications/VLC.app/Contents/MacOS/VLC';
    const got = detectPlayers('', { platform: 'darwin', home: '/Users/u', exists: (p) => p === vlc });
    expect(got.map((p) => p.id)).toEqual(['vlc']);
    expect(got[0]).toEqual({ id: 'vlc', name: 'VLC', path: vlc });
  });

  it('★ darwin：只装了 ~/Applications/IINA.app → 探到 IINA（Homebrew 与 /Applications 都空）', () => {
    const iina = '/Users/u/Applications/IINA.app/Contents/MacOS/IINA';
    const got = detectPlayers('', { platform: 'darwin', home: '/Users/u', exists: (p) => p === iina });
    expect(got.map((p) => p.id)).toEqual(['iina']);
    expect(got[0].path).toBe(iina);
  });

  it('★ darwin：Homebrew mpv 也能探到；优先级 VLC → IINA → mpv', () => {
    const vlc = '/Applications/VLC.app/Contents/MacOS/VLC';
    const mpvBrew = '/opt/homebrew/bin/mpv';
    const got = detectPlayers('', { platform: 'darwin', home: '/Users/u', exists: (p) => p === vlc || p === mpvBrew });
    expect(got.map((p) => p.id)).toEqual(['vlc', 'mpv']);
  });

  it('darwin 未装任何播放器 → 空数组（上层给「可安装 VLC / IINA / mpv」提示）', () => {
    expect(detectPlayers('', { platform: 'darwin', home: '/Users/u', exists: () => false })).toEqual([]);
  });

  it('win32：候选仍是 Program Files 系（不受 darwin 分支影响）', () => {
    const pf = process.env.ProgramFiles || 'C:\\Program Files';
    const vlc = `${pf}\\VideoLAN\\VLC\\vlc.exe`;
    const got = detectPlayers('', { platform: 'win32', exists: (p) => p === vlc });
    expect(got.map((p) => p.id)).toEqual(['vlc']);
  });

  it('用户覆盖路径优先，且路径就是已知播放器时沿用其 id/name（win32 既有行为不变）', () => {
    const pf = process.env.ProgramFiles || 'C:\\Program Files';
    const vlc = `${pf}\\VideoLAN\\VLC\\vlc.exe`;
    const got = detectPlayers(vlc, { platform: 'win32', exists: (p) => p === vlc });
    expect(got[0]).toEqual({ id: 'vlc', name: 'VLC', path: vlc });
    expect(got).toHaveLength(1);

    // 自定义路径（不是候选表里的）→ id=custom，且排在探测结果之前
    const other = 'D:\\tools\\my-player.exe';
    const custom = detectPlayers(other, { platform: 'win32', exists: (p) => p === vlc || p === other });
    expect(custom[0]).toEqual({ id: 'custom', name: '自定义播放器', path: other });
    expect(custom.map((p) => p.path)).toContain(vlc);
  });
});