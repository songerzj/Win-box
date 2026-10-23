// src/main/torrent/externalPlayer.ts
// 外部播放器接力（磁力 B 的第 2 步）。
//
// 场景：种子里的正片是 MKV / HEVC / AV1 等 Chromium `<video>` 播不了的形态 —— 不内置 ffmpeg 转封装，
// 改为把**本地中继地址**（`http://127.0.0.1:9978/bt/…`，带 Range、自带门控）交给已安装的桌面播放器，
// 由它边下边播（VLC / PotPlayer / mpv / MPC-HC 都吃 HTTP URL + Range）。
//
// 与 CatClaw 的差异：那边 Windows 侧不做外部播放器（WinUI 只能递 URI、传不出 Referer —— 对磁力不成立，
// 磁力给的是本机 127.0.0.1 地址，没有任何防盗链问题），所以这里**能做且值得做**。
//
// 探测策略：只看 Windows 常见安装位置（含 32 位 Program Files / 用户目录便携安装），
// 允许配置页用 `btExternalPlayer` 覆盖（自带路径优先）。
//
// ★ 2026-10-12（macOS 适配 P0-7）：候选表**平台化**。
//   - win32：既有 15 条候选**原样保留**（顺序不动，零回归）；
//   - darwin：VLC.app / IINA.app / mpv.app（`/Applications` + `~/Applications`）+ Homebrew mpv。
//   `mpv` 的 id 与 win32 一致 → `seekArgs('mpv')` 自动生效。

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import {
  appBundleBinary,
  appBundleRoots,
  homebrewBinDirs,
  isMac,
  platformName,
  type PlatformName,
} from '../../shared/platform';

export interface ExternalPlayer {
  id: string;
  name: string;
  path: string;
}

/** 默认 HOME（macOS 的 `~/Applications` 探测用；取不到就退化为环境变量） */
function defaultHome(env: Record<string, string | undefined>): string {
  try {
    const h = homedir();
    if (h) return h;
  } catch {
    /* homedir 不可用（极端环境）→ 走环境变量 */
  }
  return (env.HOME || '').trim();
}

/** ★ darwin 候选表（顺序＝优先级：VLC → IINA → mpv） */
function macCandidates(home: string): ExternalPlayer[] {
  const out: ExternalPlayer[] = [];
  const add = (id: string, name: string, path: string): void => {
    if (!path) return;
    out.push({ id, name, path });
  };
  const roots = appBundleRoots(home, 'darwin');
  // VLC（容器支持最全，Range/慢响应最宽容）
  for (const r of roots) add('vlc', 'VLC', appBundleBinary(r, 'VLC', 'VLC', 'darwin'));
  // IINA（macOS 原生，基于 mpv 内核）
  for (const r of roots) add('iina', 'IINA', appBundleBinary(r, 'IINA', 'IINA', 'darwin'));
  // mpv（.app 版 + Homebrew / /usr/local/bin）
  for (const r of roots) add('mpv', 'mpv', appBundleBinary(r, 'mpv', 'mpv', 'darwin'));
  for (const d of homebrewBinDirs('darwin')) add('mpv', 'mpv', `${d}/mpv`);
  return out;
}

/**
 * 候选表（纯函数：给环境变量快照就出候选路径；顺序＝优先级）。
 * @param platform 缺省 = 当前真实平台（Windows 上行为与改动前逐项相同）
 * @param home macOS 的 `~` 目录（缺省 = `os.homedir()` / `env.HOME`）
 */
export function playerCandidates(
  env: Record<string, string | undefined>,
  platform: PlatformName = platformName(),
  home?: string,
): Array<Omit<ExternalPlayer, 'id'> & { id: string }> {
  if (isMac(platform)) return macCandidates(home ?? defaultHome(env));
  return winCandidates(env);
}

/** 既有 Windows 候选表（一字不改；仅从原函数体内抽出，便于平台分支） */
function winCandidates(env: Record<string, string | undefined>): ExternalPlayer[] {
  const pf = env.ProgramFiles || 'C:\\Program Files';
  const pf86 = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const la = env.LOCALAPPDATA || '';
  const out: ExternalPlayer[] = [];
  const add = (id: string, name: string, path: string): void => {
    if (!path) return;
    out.push({ id, name, path });
  };
  // PotPlayer（国内最常见；64 位主程序名 PotPlayerMini64.exe）
  add('potplayer', 'PotPlayer', `${pf}\\DAUM\\PotPlayer\\PotPlayerMini64.exe`);
  add('potplayer', 'PotPlayer', `${pf}\\PotPlayer\\PotPlayerMini64.exe`);
  add('potplayer', 'PotPlayer', la ? `${la}\\Programs\\PotPlayer\\PotPlayerMini64.exe` : '');
  add('potplayer', 'PotPlayer', `${pf}\\DAUM\\PotPlayer\\PotPlayerMini.exe`);
  // VLC（容器支持最全，Range/慢响应最宽容）
  add('vlc', 'VLC', `${pf}\\VideoLAN\\VLC\\vlc.exe`);
  add('vlc', 'VLC', `${pf86}\\VideoLAN\\VLC\\vlc.exe`);
  add('vlc', 'VLC', la ? `${la}\\Programs\\VideoLAN\\VLC\\vlc.exe` : '');
  // mpv / mpv.net
  add('mpv', 'mpv', `${pf}\\mpv\\mpv.exe`);
  add('mpv', 'mpv.net', `${pf}\\mpv.net\\mpvnet.exe`);
  add('mpv', 'mpv', la ? `${la}\\Programs\\mpv\\mpv.exe` : '');
  // MPC-HC（K-Lite 自带一份，最常见）
  add('mpc-hc', 'MPC-HC', `${pf}\\K-Lite Codec Pack\\MPC-HC64\\mpc-hc64.exe`);
  add('mpc-hc', 'MPC-HC', `${pf}\\MPC-HC\\mpc-hc64.exe`);
  add('mpc-hc', 'MPC-HC', `${pf86}\\K-Lite Codec Pack\\MPC-HC64\\mpc-hc64.exe`);
  return out;
}

/** 过滤出真实存在的播放器（注入 exists 便于单测；同名只留第一个命中） */
export function pickPlayers(
  cands: ExternalPlayer[],
  exists: (p: string) => boolean,
): ExternalPlayer[] {
  const out: ExternalPlayer[] = [];
  for (const c of cands) {
    if (out.some((o) => o.path.toLowerCase() === c.path.toLowerCase())) continue;
    try {
      if (exists(c.path)) out.push(c);
    } catch {
      /* 路径异常（非法字符）→ 跳过 */
    }
  }
  return out;
}

/** `detectPlayers` 的可注入上下文（全部可选；缺省 = 当前真实环境） */
export interface DetectPlayersOptions {
  platform?: PlatformName;
  /** macOS 的 `~`（`~/Applications` 探测用）；缺省 `os.homedir()` / `env.HOME` */
  home?: string;
  /** 存在性判定注入（便于单测；缺省 `node:fs.existsSync`） */
  exists?: (p: string) => boolean;
}

/**
 * 运行时探测：用户配置的路径优先，其次常见安装位置。
 * ★ 2026-10-12（macOS 适配 §3.12）：候选表按平台取（darwin = `*.app` + Homebrew），
 *   平台/`home`/`exists` 都可注入 → darwin 行为能在 win32 主机上单测。
 */
export function detectPlayers(overridePath = '', opts: DetectPlayersOptions = {}): ExternalPlayer[] {
  const p = opts.platform ?? platformName();
  const exists = opts.exists ?? ((q: string): boolean => existsSync(q));
  const safeExists = (q: string): boolean => {
    try {
      return !!q && exists(q);
    } catch {
      return false;
    }
  };
  const list = pickPlayers(playerCandidates(process.env, p, opts.home), safeExists);
  const ov = (overridePath || '').trim();
  if (ov) {
    try {
      if (safeExists(ov)) {
        // ★ 2026-09-30：用户填的路径若就是某个已知播放器 → 沿用它的名字（别显示「自定义播放器」）
        const known = list.find((q) => q.path.toLowerCase() === ov.toLowerCase());
        return [{ id: known?.id ?? 'custom', name: known?.name ?? '自定义播放器', path: ov }, ...list.filter((q) => q.path !== ov)];
      }
    } catch {
      /* 用户填的路径非法 → 忽略，继续用探测结果 */
    }
  }
  return list;
}

/**
 * 「从第 N 秒起播」的命令行参数（纯函数，可单测）。
 *
 * 各播放器的语法**互不兼容**，只对确认支持的命令行传；未知播放器宁可不传 ——
 * 传错会被当成待打开的文件名，反而弹一堆错误窗口。
 * - PotPlayer：`/seek=hh:mm:ss`（也接受 +mm:ss）
 * - VLC：`--start-time=<秒>`
 * - mpv / mpv.net：`--start=<秒>`
 * - IINA（★ 2026-10-12 macOS 适配）：`--start=<秒>`（IINA 基于 mpv 内核，参数同 mpv）
 * - MPC-HC 等：无稳定的起播参数（`/start` 语义随版本而变）→ 不传
 */
export function seekArgs(id: string, seconds: number, _platform?: PlatformName): string[] {
  const s = Math.floor(Number(seconds) || 0);
  if (!Number.isFinite(s) || s <= 0) return [];
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const hhmmss = `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  if (id === 'potplayer') return [`/seek=${hhmmss}`];
  if (id === 'vlc') return [`--start-time=${s}`];
  if (id === 'mpv' || id === 'iina') return [`--start=${s}`];
  return [];
}

/** `launchPlayer` 的可注入上下文（缺省 = 当前真实平台） */
export interface LaunchPlayerOptions {
  platform?: PlatformName;
}

/**
 * `.app` 包形态（darwin 专有）：用户可能把 `/Applications/VLC.app` 整包填进配置页。
 * 目录不能直接 spawn（EACCES），必须走 `open -a` 交给 LaunchServices。
 */
function isAppBundle(p: string): boolean {
  return /\.app\/?$/i.test(String(p || '').trim());
}

/**
 * 拉起外部播放器播 URL（分离进程：应用退出不带走播放器）。
 * @param extraArgs 播放器专用参数（起播位置等）—— 一律排在 URL 之前（各播放器的约定）
 * @returns 是否成功 spawn（同步部分；播放器自身能否播放由它自己决定）
 *
 * ★ 2026-10-12（macOS 适配 §3.12）：
 *   - darwin + `.app` 目录 → `open -a <App.app> --args <extraArgs…> <url>`
 *     （直接 spawn `.app` 目录必失败：它不是可执行文件）；
 *   - darwin + `*.app/Contents/MacOS/<bin>`（候选表给的就是这个形态）与 win32 → 原路径直接 spawn，
 *     win32 行为逐字节不变。
 */
export function launchPlayer(
  path: string,
  url: string,
  extraArgs: string[] = [],
  opts: LaunchPlayerOptions = {},
): boolean {
  const p = opts.platform ?? platformName();
  try {
    const target = String(path || '').trim();
    if (!target) return false;
    const argv = [...extraArgs, url];
    const [cmd, args] = isMac(p) && isAppBundle(target)
      ? ['open', ['-a', target, '--args', ...argv]]
      : [target, argv];
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: false });
    child.on('error', () => undefined); // spawn 失败（权限/被拦）→ 不冒泡成主进程未捕获异常
    child.unref();
    return true;
  } catch {
    return false;
  }
}