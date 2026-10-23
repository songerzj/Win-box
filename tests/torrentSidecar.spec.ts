// tests/torrentSidecar.spec.ts — 磁力 B 的主进程组件：
//   · aria2c 引擎命令行（纯构造：参数写错会静默劣化体验 —— 门控/续传/孤儿进程全靠它）
//   · 外部播放器探测（MKV/HEVC 接力）
//   · PlayerSettings 的 btExternalPlayer 归一（老配置容错）
import { afterEach, describe, it, expect, vi } from 'vitest';

// Aria2Sidecar 会 import ../util/paths（依赖 electron 的 app.getPath；本文件只调用纯函数）
vi.mock('electron', () => ({
  app: { getPath: () => process.env.TEMP || '.', isPackaged: false },
}));

import { aria2Args, Aria2Sidecar } from '../src/main/torrent/Aria2Sidecar';
import { playerCandidates, pickPlayers, type ExternalPlayer } from '../src/main/torrent/externalPlayer';
import { normalizePlayerSettings, DEFAULT_PLAYER_SETTINGS } from '../src/shared/player';

describe('aria2Args — BT 引擎命令行（行为关键项锁死）', () => {
  const args = aria2Args(6800, 'sec123', 'C:\\bt', 4242);
  const has = (s: string): boolean => args.includes(s);

  it('RPC 只监听本机 + token 认证 + 指定端口', () => {
    expect(has('--enable-rpc=true')).toBe(true);
    expect(has('--rpc-listen-all=false')).toBe(true); // 绝不暴露到局域网
    expect(has('--rpc-listen-port=6800')).toBe(true);
    expect(has('--rpc-secret=sec123')).toBe(true);
  });

  it('不读用户 aria2.conf（外部配置可能改 dir/端口/限速，甚至抢占端口）', () => {
    expect(has('--no-conf=true')).toBe(true);
  });

  it('起播/续传关键项：首尾优先、不预分配、元数据落盘、只下选中文件', () => {
    expect(has('--bt-prioritize-piece=head=8M,tail=8M')).toBe(true); // mp4 的 moov 常在最尾
    expect(has('--file-allocation=none')).toBe(true);
    expect(has('--bt-save-metadata=true')).toBe(true);
    expect(has('--bt-remove-unselected-file=false')).toBe(true);
    expect(has('--seed-time=0')).toBe(true);
    expect(has('--continue=true')).toBe(true);
    expect(has(`--dir=C:\\bt`)).toBe(true);
  });

  it('tracker 超时压缩（默认 60s 会让死 tracker 拖慢起播）', () => {
    expect(has('--bt-tracker-timeout=20')).toBe(true);
    expect(has('--bt-tracker-connect-timeout=10')).toBe(true);
  });

  it('孤儿进程防护：仅当传入 pid 时带 --stop-with-process（Windows 专有）', () => {
    expect(has('--stop-with-process=4242')).toBe(true);
    expect(aria2Args(6800, 's', 'C:\\bt').some((a) => a.startsWith('--stop-with-process'))).toBe(false);
  });

  it('日志降噪：error 级 + 无摘要（stdout 会被我们转进应用日志）', () => {
    expect(has('--console-log-level=error')).toBe(true);
    expect(has('--log-level=error')).toBe(true);
    expect(has('--summary-interval=0')).toBe(true);
  });
});

// ★ 2026-10-12（macOS 适配 T03 §3.10）：引擎命令行 / 可执行名平台化。
/** 平台注入走 env（`platformName()` 优先读 `WINBOX_TEST_PLATFORM`）；见 T01 说明 */
const PLATFORM_ENV = 'WINBOX_TEST_PLATFORM';
afterEach(() => delete process.env[PLATFORM_ENV]);

describe('aria2Args / exePath — 平台化（darwin 无 --stop-with-process、无 .exe 后缀）', () => {
  it('★ `--stop-with-process` 是 Windows 专有：darwin 传了 pid 也不带（aria2 会直接报错退出）', () => {
    const darwin = aria2Args(6800, 's', '/tmp/bt', process.pid, 'darwin');
    expect(darwin.some((a) => a.startsWith('--stop-with-process'))).toBe(false);
    const win = aria2Args(6800, 's', 'C:\\bt', 4242, 'win32');
    expect(win).toContain('--stop-with-process=4242');
    // 其余关键项两平台一致（平台化只动这一条）
    for (const f of ['--no-conf=true', '--rpc-listen-all=false', '--bt-prioritize-piece=head=8M,tail=8M', '--file-allocation=none']) {
      expect(darwin).toContain(f);
      expect(win).toContain(f);
    }
  });

  it('★ exePath()：win32 带 `.exe`；darwin 无后缀（写死 .exe 会让 macOS 恒判「引擎缺失」）', () => {
    process.env[PLATFORM_ENV] = 'win32';
    expect(Aria2Sidecar.exePath().endsWith(`aria2c.exe`)).toBe(true);
    process.env[PLATFORM_ENV] = 'darwin';
    const mac = Aria2Sidecar.exePath();
    expect(mac.endsWith('aria2c')).toBe(true);
    expect(mac.includes('.exe')).toBe(false);
  });

  it('★ resolveExe()：内置缺失时走本机探测；全缺 → 人话 hint（darwin 含 brew install aria2）', () => {
    process.env[PLATFORM_ENV] = 'darwin';
    const r = Aria2Sidecar.resolveExe();
    expect(['override', 'bundled', 'system', 'none']).toContain(r.source);
    expect(typeof r.path).toBe('string');
    // 本机（Windows 主机）不可能有 /opt/homebrew/bin/aria2c → 必然是 none + darwin 修复指引
    if (!r.path) {
      expect(r.source).toBe('none');
      expect(r.hint).toContain('brew install aria2');
      // 与 exePath() 自洽：内置候选就是探测链的首选 bundled 路径
      expect(Aria2Sidecar.resolveExe().path).toBe('');
    }
  });

  it('win32 resolveExe()：内置路径与 exePath() 一致（同一候选，不自相矛盾）', () => {
    process.env[PLATFORM_ENV] = 'win32';
    expect(Aria2Sidecar.exePath().endsWith('aria2c.exe')).toBe(true);
    const r = Aria2Sidecar.resolveExe();
    expect(r.path === '' || r.path.endsWith('aria2c.exe')).toBe(true);
  });
});

const ENV: Record<string, string | undefined> = {
  ProgramFiles: 'C:\\Program Files',
  'ProgramFiles(x86)': 'C:\\Program Files (x86)',
  LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local',
};

describe('playerCandidates — 候选安装位置（顺序＝优先级）', () => {
  // ★ 显式 'win32'：本组用例测的是 Windows 候选表；platform 缺省会读进程级全局
  //   `WINBOX_TEST_PLATFORM`（并行 spec 可能写 darwin）→ 不钉死会随机失败
  const cands = playerCandidates(ENV, 'win32');

  it('覆盖率：PotPlayer / VLC / mpv / MPC-HC 都在候选表里', () => {
    const ids = new Set(cands.map((c) => c.id));
    expect([...ids].sort()).toEqual(['mpc-hc', 'mpv', 'potplayer', 'vlc']);
  });

  it('优先级：PotPlayer 在 VLC 之前（国内最常见，用户期望优先）', () => {
    expect(cands[0].id).toBe('potplayer');
    expect(cands.findIndex((c) => c.id === 'vlc')).toBeGreaterThan(cands.findIndex((c) => c.id === 'potplayer'));
  });

  it('路径由环境变量拼出（ProgramFiles / ProgramFiles(x86) / LOCALAPPDATA）', () => {
    const paths = cands.map((c) => c.path);
    expect(paths).toContain('C:\\Program Files\\DAUM\\PotPlayer\\PotPlayerMini64.exe');
    expect(paths).toContain('C:\\Program Files\\VideoLAN\\VLC\\vlc.exe');
    expect(paths).toContain('C:\\Program Files (x86)\\VideoLAN\\VLC\\vlc.exe');
    expect(paths).toContain('C:\\Users\\u\\AppData\\Local\\Programs\\PotPlayer\\PotPlayerMini64.exe');
    expect(paths).toContain('C:\\Program Files\\K-Lite Codec Pack\\MPC-HC64\\mpc-hc64.exe');
  });

  it('环境变量缺失时用默认 Program Files，LOCALAPPDATA 缺失则不产生该候选（不留空串路径）', () => {
    const c = playerCandidates({}, 'win32');
    expect(c.every((x) => x.path.startsWith('C:\\Program Files'))).toBe(true);
    expect(c.some((x) => x.path.includes('AppData'))).toBe(false);
    expect(c.every((x) => x.path.endsWith('.exe'))).toBe(true);
  });
});

describe('pickPlayers — 只保留真实存在的（注入 exists）', () => {
  const cands: ExternalPlayer[] = [
    { id: 'potplayer', name: 'PotPlayer', path: 'C:\\PF\\PotPlayer\\PotPlayerMini64.exe' },
    { id: 'vlc', name: 'VLC', path: 'C:\\PF\\VLC\\vlc.exe' },
    { id: 'vlc', name: 'VLC', path: 'C:\\PF86\\VLC\\vlc.exe' },
  ];

  it('存在的留下、缺失的剔除；不同路径各自保留', () => {
    const found = pickPlayers(cands, (p) => p === 'C:\\PF\\VLC\\vlc.exe');
    expect(found.map((f) => f.name)).toEqual(['VLC']);
    const both = pickPlayers(cands, () => true);
    expect(both.length).toBe(3); // PotPlayer + 两条 VLC（PF / PF86 各算一个安装位）
    expect(pickPlayers(cands, (p) => p.toLowerCase().includes('potplayer'))[0].name).toBe('PotPlayer');
  });

  it('同路径不同大小写只留一个（Windows 路径大小写不敏感）', () => {
    const dup: ExternalPlayer[] = [
      { id: 'vlc', name: 'VLC', path: 'C:\\PF\\VLC\\vlc.exe' },
      { id: 'vlc', name: 'VLC', path: 'c:\\pf\\vlc\\VLC.EXE' },
    ];
    expect(pickPlayers(dup, () => true).length).toBe(1);
  });

  it('exists 抛异常（非法路径）→ 跳过而不是整体失败', () => {
    const found = pickPlayers(cands, (p) => {
      if (p.includes('PF86')) throw new Error('bad path');
      return p.includes('vlc');
    });
    expect(found.length).toBe(1);
  });
});

describe('PlayerSettings 归一 — btExternalPlayer / vodExternalPlayer（容错旧配置）', () => {
  it('默认值：m3u8Purify=false、外部播放器留空（= 自动探测）、点播总开关默认不勾选、mpv 路径覆盖为空', () => {
    expect(DEFAULT_PLAYER_SETTINGS.btExternalPlayer).toBe('');
    expect(DEFAULT_PLAYER_SETTINGS.vodExternalPlayer).toBe('');
    expect(DEFAULT_PLAYER_SETTINGS.vodExternalPlayerEnabled).toBe(false);
    expect(DEFAULT_PLAYER_SETTINGS.mpvPath).toBe('');
    expect(DEFAULT_PLAYER_SETTINGS.srMode).toBe('off'); // 超分插件（M1）：默认关
    // R11：插件播放内核默认全关（空表）
    expect(DEFAULT_PLAYER_SETTINGS.engineEnabled).toEqual({});
    expect(DEFAULT_PLAYER_SETTINGS.enginePaths).toEqual({});
    expect(normalizePlayerSettings(undefined)).toEqual({
      m3u8Purify: false,
      btExternalPlayer: '',
      vodExternalPlayer: '',
      vodExternalPlayerEnabled: false,
      mpvPath: '',
      srMode: 'off',
      engineEnabled: {},
      enginePaths: {},
    });
  });

  it('路径两端空白被去掉；非字符串一律回落空串（老档案里可能是布尔/数字）', () => {
    expect(normalizePlayerSettings({ btExternalPlayer: '  D:\\PotPlayer\\PotPlayerMini64.exe  ' }).btExternalPlayer)
      .toBe('D:\\PotPlayer\\PotPlayerMini64.exe');
    expect(normalizePlayerSettings({ btExternalPlayer: 5 as unknown as string }).btExternalPlayer).toBe('');
    expect(normalizePlayerSettings({ btExternalPlayer: null as unknown as string }).btExternalPlayer).toBe('');
    // 老配置（无该字段）也能读：m3u8 开关保持
    expect(normalizePlayerSettings({ m3u8Purify: true }).btExternalPlayer).toBe('');
    expect(normalizePlayerSettings({ m3u8Purify: true }).m3u8Purify).toBe(true);
  });

  it('点播外部播放器与磁力分开（vodExternalPlayer 独立归一）', () => {
    expect(normalizePlayerSettings({ vodExternalPlayer: '  C:\\PF\\PotPlayer\\PotPlayerMini64.exe  ' }).vodExternalPlayer)
      .toBe('C:\\PF\\PotPlayer\\PotPlayerMini64.exe');
    expect(normalizePlayerSettings({ vodExternalPlayer: 5 as unknown as string }).vodExternalPlayer).toBe('');
    // 只绑磁力时，点播侧保持空（= 自动探测），两边互不影响
    expect(normalizePlayerSettings({ btExternalPlayer: 'D:\\vlc.exe' }).vodExternalPlayer).toBe('');
    expect(normalizePlayerSettings({ vodExternalPlayer: 'D:\\vlc.exe' }).btExternalPlayer).toBe('');
  });

  // 
  it('点播总开关 —— 显式值优先，旧配置按「路径非空」迁移', () => {
    // 旧配置（无该字段）：有路径 → 迁移为启用（保持 09-30 起「填了就直接用它播」的既有行为）
    expect(normalizePlayerSettings({ vodExternalPlayer: 'D:\\PotPlayer\\PotPlayerMini64.exe' }).vodExternalPlayerEnabled).toBe(true);
    // 旧配置无路径 → 不启用（新装默认）
    expect(normalizePlayerSettings({}).vodExternalPlayerEnabled).toBe(false);
    // 显式 false **必须压过路径**（不勾选依旧不使用第三方播放器）
    expect(normalizePlayerSettings({ vodExternalPlayer: 'D:\\vlc.exe', vodExternalPlayerEnabled: false }).vodExternalPlayerEnabled).toBe(false);
    // 显式 true → 启用；非布尔（老档案脏值）一律按「路径非空」推导
    expect(normalizePlayerSettings({ vodExternalPlayer: 'D:\\vlc.exe', vodExternalPlayerEnabled: true }).vodExternalPlayerEnabled).toBe(true);
    expect(normalizePlayerSettings({ vodExternalPlayer: 'D:\\vlc.exe', vodExternalPlayerEnabled: 5 as unknown as boolean }).vodExternalPlayerEnabled).toBe(true);
    expect(normalizePlayerSettings({ vodExternalPlayerEnabled: true }).vodExternalPlayerEnabled).toBe(true);
  });

  // MPV 内核路径覆盖归一（空 = 用随包内置构建）
  it('mpvPath —— 去空白 / 脏值回落空串 / 老配置可读', () => {
    expect(normalizePlayerSettings({ mpvPath: '  R:\\resources\\mpv\\mpv.exe  ' }).mpvPath).toBe('R:\\resources\\mpv\\mpv.exe');
    expect(normalizePlayerSettings({ mpvPath: 5 as unknown as string }).mpvPath).toBe('');
    expect(normalizePlayerSettings({ mpvPath: null as unknown as string }).mpvPath).toBe('');
    // 老配置（无该字段）：mpvPath 空、其余字段不受影响
    const old = normalizePlayerSettings({ m3u8Purify: true, btExternalPlayer: 'D:\\vlc.exe' });
    expect(old.mpvPath).toBe('');
    expect(old.m3u8Purify).toBe(true);
    expect(old.btExternalPlayer).toBe('D:\\vlc.exe');
  });
});