// src/main/player/MpvController.ts
// MPV 高兼容播放内核的主进程侧 —— 单会话管理。
//
// 生命周期：渲染层 `mpvStart` → spawn mpv（`--wid` 钉进播放器窗口）→ 等 JSON IPC 管道就绪 →
//   下发属性观察 + `loadfile`；状态由 mpv 事件驱动（节流 200ms 推给渲染层）；`mpvStop`/换集/
//   关窗口/退出应用都会 quit + 兜底 kill，绝不留下孤儿进程。
//
// 单会话是刻意的：同一时刻只有「独立播放器窗口」的一个 mpv（换集 = stop + start 新进程）。
import { spawn, type ChildProcess } from 'node:child_process';
import { connect, type Socket } from 'node:net';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrowserWindow } from 'electron';
import type { Logger } from '../../shared/types';
import type { MpvCommand, MpvKernelState, MpvStartOptions, MpvStatus } from '../../shared/player';
import { IPC } from '../../shared/ipc-channels';
import { cacheDir, resourcesDir } from '../util/paths';
import { exeName, isWin, mpvEmbedSupported, mpvIpcPath, spawnOptions } from '../../shared/platform';
import { playerSettings } from './playerSettings';
import { playerIsFullscreen, playerIsMini } from './PlayerWindow';
import {
  buildMpvArgs,
  initialKernelState,
  mpvCmdLine,
  mpvCommandLines,
  mpvObserveLines,
  mpvShadersCmd,
  reduceMpvMessage,
  resolveMpvPath,
} from './mpvCore';

/** 状态推送节流（mpv 的 time-pos 事件很密；200ms ≈ 进度条刷新率，够用） */
const PUSH_INTERVAL_MS = 200;
/** IPC 管道连接总超时（mpv 启动到建管道通常 <1s） */
const CONNECT_TIMEOUT_MS = 6000;
/** quit 后的强杀宽限 */
const QUIT_GRACE_MS = 1500;
/**
 * 随包 Mozilla CA 包（给 mpv 的 TLS 用）。
 *   内置的 Yaozhi 核心其 FFmpeg 走 OpenSSL 而没有 CA 路径 ⇒ **https 校验必失败**；
 *   启动 mpv 时把这个路径注入 `SSL_CERT_FILE` 即可（见 spawn 处注释）。缺失则该变量不注入。
 */
const CA_BUNDLE = join(resourcesDir(), 'mpv', 'cacert.pem');

/**
 * 取原生窗口句柄（win32 = HWND / macOS = NSView 指针）的十进制字符串
 * （mpv `--wid` 接受十进制 int64；`getNativeWindowHandle()` 在两个平台都返回 Buffer，取值口径一致）。
 */
export function hwndOf(win: BrowserWindow): string {
  try {
    const buf = win.getNativeWindowHandle();
    if (buf.length >= 8) return buf.readBigUInt64LE(0).toString();
    return String(buf.readUInt32LE(0));
  } catch {
    return '';
  }
}

/** ★ 2026-10-12（macOS 适配 §3.8-1）：语义化别名（同一实现，两处名字都留着，避免改动既有调用点） */
export const nativeWindowIdOf = hwndOf;

export class MpvController {
  private proc: ChildProcess | null = null;
  private sock: Socket | null = null;
  private state: MpvKernelState = initialKernelState();
  private session = 0;
  private target: BrowserWindow | null = null;
  private pushTimer: NodeJS.Timeout | null = null;
  private retiring = new Set<ChildProcess>();
  private pipeSeq = 0;
  private lineBuf = '';
  /**
   * `start()` can be called twice before the first process has finished
   * connecting (React effect cleanup/start does exactly that when the kernel
   * is switched).  Serialising the whole start operation prevents the second
   * call from missing the first process and leaving two mpv instances alive.
   */
  private startChain: Promise<void> = Promise.resolve();
  private unbindViewport: (() => void) | null = null;
  /** 本次会话是否已挂上外挂字幕（换字幕前先 sub-remove） */
  private subOn = false;
  /**
   * ★ 2026-10-12（风险 R1 缓解）：上一次「嵌入尝试」是否失败（进程内一次性）。
   *   darwin 的 `--wid` 能否嵌进 NSView **未经真机验证** —— 一旦 JSON IPC 在超时内连不上
   *   （多半是 `--wid` 导致 mpv 起不来），就置位并让 `status().embeddable` 转 false，
   *   渲染层下次不再给 MPV 入口。**不阻塞 HTML5 / 外部播放器链路**。
   */
  private embedFailed = false;

  constructor(private log: Logger) {}

  /** mpv 可用性与路径（配置覆盖 → 随包内置 → 本机探测） */
  status(): MpvStatus {
    // ★ 2026-10-12（macOS 适配 P0-4）：可执行名平台化（darwin 上没有 `.exe`）。
    //   Windows 下 `exeName('mpv')` === 'mpv.exe'，与改动前逐字节相同。
    const bundled = join(resourcesDir(), 'mpv', exeName('mpv'));
    const r = resolveMpvPath({
      override: playerSettings.settings.mpvPath,
      bundled,
      env: process.env,
      exists: existsSync,
    });
    // ★ 2026-10-12（风险 R1）：`--wid` 嵌入能力开关（win32 恒 true；darwin 可用环境变量关，
    //   或运行时 IPC 连不上 → `embedFailed` 自动降级）。不可嵌入时给中文人话提示，
    //   引导用户走外部播放器（绝不静默失败）。
    const embeddable = mpvEmbedSupported(process.env) && !this.embedFailed;
    const note =
      r.source === 'override'
        ? '使用自定义路径'
        : r.source === 'bundled'
          ? '使用随包内置构建（安装目录内）'
          : r.source === 'system'
            ? '使用本机已安装的 mpv'
            : `未找到 mpv：随包构建缺失且本机未安装（可在配置页「播放」指定 ${exeName('mpv')} 路径）`;
    return {
      available: r.source !== 'none',
      path: r.path,
      source: r.source,
      note: !embeddable && r.source !== 'none'
        ? `${note}；当前环境不支持把 mpv 嵌入播放窗口，已改用内置 HTML5 内核（如需 mpv 画面请用外部播放器）`
        : note,
      embeddable,
    };
  }

  get running(): boolean {
    return !!this.proc;
  }

  /**
   * 启动一次 mpv 会话（换集/换源 = 新会话）。
   * 注意：本方法返回时 mpv 已 `loadfile` 目标地址；状态经 MPV_STATE 事件持续推送。
   */
  async start(win: BrowserWindow, opts: MpvStartOptions): Promise<{ session: number; path: string }> {
    this.stop();
    const reservation = this.session;
    const run = this.startChain.then(() => this.startInternal(win, opts, reservation));
    // Keep the queue usable after a failed start, while returning the actual
    // result/error to the caller that requested this start.
    this.startChain = run.then(() => undefined, () => undefined);
    return run;
  }

  private async startInternal(win: BrowserWindow, opts: MpvStartOptions, reservation: number): Promise<{ session: number; path: string }> {
    const st = this.status();
    if (!st.available) throw new Error(st.note);
    const url = String(opts?.url || '').trim();
    if (!url) throw new Error('播放地址为空');

    if (reservation !== this.session || win.isDestroyed()) return { session: reservation, path: st.path };
    // A retiring process must release the embedded HWND before another VO attaches to it.
    await Promise.all([...this.retiring].map(proc => new Promise<void>(resolve => {
      if (proc.exitCode !== null || proc.signalCode !== null) { resolve(); return; }
      proc.once('exit', () => resolve());
    })));
    if (reservation !== this.session || win.isDestroyed()) return { session: reservation, path: st.path };
    this.session += 1;
    const session = this.session;
    this.target = win;
    this.state = initialKernelState(!!opts.live);
    this.subOn = false;
    this.lineBuf = '';

    // ★ 2026-10-12（macOS 适配 §3.8-5）：不可嵌入时不需要 wid（mpv 走独立窗口）。
    const embed = mpvEmbedSupported(process.env);
    const hwnd = hwndOf(win);
    if (embed && !hwnd) throw new Error('无法取得播放器窗口句柄（mpv 无法嵌入）');
    // ★ 2026-10-12（macOS 适配 §3.8-3）：win32 命名管道 / darwin unix socket，统一由 platform 层给。
    const pipe = mpvIpcPath({ pid: process.pid, seq: ++this.pipeSeq, nonce: Date.now().toString(36) });
    // darwin：清理上次崩溃残留的 socket 文件（残留会让 mpv 的 bind 失败 → 建连超时 → 假性"嵌入不可用"）
    if (!isWin()) {
      try {
        rmSync(pipe, { force: true });
      } catch {
        /* 本来就不存在 / 无权限 → 忽略 */
      }
    }
    const args = buildMpvArgs({
      pipe,
      wid: hwnd,
      start: opts.startTime,
      volume: opts.volume ?? 1,
      rate: opts.rate ?? 1,
      fit: opts.fit,
      env: process.env,
    });
    this.log.i(`mpv: 启动（session=${session}，${st.note}）→ ${url.slice(0, 120)}`);
    // CA 包缺失就明确告警（否则「https 全播不了」会以「源有问题」的面目出现，极难排查）
    if (!existsSync(CA_BUNDLE)) {
      this.log.w(`mpv: 未找到随包 CA 包（${CA_BUNDLE}）—— https 源可能因证书校验失败而打不开；内置 Yaozhi 核心的 FFmpeg 必须依赖它`);
    }
    // ★ 2026-10-12：spawn 选项平台化（win32 `windowsHide:true`；darwin 只留 stdio，行为不变）
    const proc = spawn(st.path, args, {
      ...spawnOptions(),
      stdio: ['ignore', 'pipe', 'pipe'],
      //   根因 = **自编译的 FFmpeg 走 OpenSSL 且没有可用的 CA 路径**（构建前缀是 CI 上的 Linux 目录）
      //   ⇒ 证书校验必然失败（实测日志 `[e][ffmpeg] tls: error:0A000086` = `SSL_R_CERTIFICATE_VERIFY_FAILED`，
      //   随后 `[stream] Failed to open` + `finished playback, loading failed (reason 4)`）；
      //   它自带的 libcurl 先试、ffmpeg 兜底，两者都过不了 ⇒ **所有 https 源全播不了**，
      //   而本地文件与 http 源不受影响（正好对上「很多内容播不了」的观感）。
      //   修：注入 `SSL_CERT_FILE` 指向**随包 Mozilla CA 包**（resources/mpv/cacert.pem）——
      //   校验保持开启，**不用** `--tls-verify=no` 那种降级（那会让中间人有机可乘）。
      //   官方 mpv 若本来走 Schannel/系统证书，这个变量对它无副作用。
      ...(existsSync(CA_BUNDLE) ? { env: { ...process.env, SSL_CERT_FILE: CA_BUNDLE } } : {}),
    });
    this.proc = proc;
    proc.on('error', (e) => {
      this.log.w(`mpv: 进程错误 ${e.message}`);
      if (session === this.session) this.markExited();
    });
    proc.on('exit', (code) => {
      this.log.i(`mpv: 进程退出 code=${String(code)}`);
      if (session === this.session) this.markExited();
    });
    const onOut = (chunk: Buffer): void => {
      for (const line of String(chunk).split(/\r?\n/)) {
        const s = line.trim();
        if (s) this.log.w(`mpv: ${s.slice(0, 200)}`);
      }
    };
    proc.stdout?.on('data', onOut);
    proc.stderr?.on('data', onOut);

    let sock: Socket;
    try { sock = await this.connectPipe(pipe, CONNECT_TIMEOUT_MS); }
    catch (e) {
      if (proc === this.proc) this.stop();
      // ★ 风险 R1 缓解：连不上多半是 `--wid` 让 mpv 起不来（darwin 未验证）→ 标记嵌入失败并降级，
      //   绝不把整条播放链路挂死（渲染层下次走 HTML5 / 外部播放器）。
      if (embed) {
        this.embedFailed = true;
        this.log.w(`mpv: 嵌入窗口失败（已降级为独立窗口/HTML5 内核）：${(e as Error)?.message || e}`);
      }
      throw isWin()
        ? e
        : new Error(`mpv 无法嵌入播放窗口（已改用内置 HTML5 内核，或用外部播放器）：${String((e as Error)?.message || e)}`);
    }
    // 连接期间可能已被 stop/换集 → 丢弃这条管道
    if (session !== this.session || proc !== this.proc) {
      try {
        sock.destroy();
      } catch {
        /* ignore */
      }
      return { session, path: st.path };
    }
    this.sock = sock;
    const updateViewport = () => {
      if (session !== this.session || win.isDestroyed()) return;
      const height = win.getContentBounds().height;
      const titleHeight = playerIsFullscreen() ? 0 : playerIsMini() ? 18 : 38;
      sock.write(mpvCmdLine(['set_property', 'video-margin-ratio-top', titleHeight / Math.max(1, height)]));
      win.webContents.invalidate();
    };
    win.on('resize', updateViewport);
    win.on('enter-full-screen', updateViewport);
    win.on('leave-full-screen', updateViewport);
    this.unbindViewport = () => {
      win.removeListener('resize', updateViewport);
      win.removeListener('enter-full-screen', updateViewport);
      win.removeListener('leave-full-screen', updateViewport);
    };
    updateViewport();
    sock.on('data', (d: Buffer) => this.onSockData(d, session));
    sock.on('error', () => undefined);
    sock.on('close', () => {
      if (this.sock === sock) this.sock = null;
    });
    sock.write(mpvObserveLines().join(''));
    sock.write(mpvCmdLine(['set_property', 'mute', 'no']));
    sock.write(mpvCmdLine(['set_property', 'pause', opts.paused ? 'yes' : 'no']));
    sock.write(mpvCmdLine(['set_property', 'volume', Math.max(0, Math.min(1, opts.volume ?? 1)) * 100]));
    // 超分插件（M1）：初始着色器链必须在 loadfile **之前**下发（逐条 clr+append，见 mpvShadersCmd）；
    //   运行期换档走 `command({type:'glsl-shaders'})`，同样即时生效、不重启会话。
    const shaders = (opts.shaders ?? []).map((s) => String(s ?? '').trim()).filter(Boolean);
    if (shaders.length) for (const l of mpvShadersCmd(shaders)) sock.write(l);
    sock.write(mpvCmdLine(['loadfile', url, 'replace']));
    return { session, path: st.path };
  }

  /** 控制命令（成功只代表已写入管道） */
  command(cmd: MpvCommand): boolean {
    const sock = this.sock;
    if (!sock) return false;
    try {
      if (cmd?.type === 'sub-add') {
        const text = String(cmd.text || '');
        if (!text.trim()) return false;
        const dir = join(cacheDir(), 'mpv');
        mkdirSync(dir, { recursive: true });
        const file = join(dir, 'subtitle.srt');
        writeFileSync(file, text, 'utf-8');
        if (this.subOn) sock.write(mpvCmdLine(['sub-remove']));
        sock.write(mpvCmdLine(['sub-add', file, 'select']));
        this.subOn = true;
        return true;
      }
      if (cmd?.type === 'sub-clear') {
        if (this.subOn) sock.write(mpvCmdLine(['sub-remove']));
        this.subOn = false;
        return true;
      }
      const lines = mpvCommandLines(cmd);
      if (!lines.length) return false;
      for (const l of lines) sock.write(l);
      return true;
    } catch {
      return false;
    }
  }

  /** 停止会话（quit → 宽限后强杀；幂等） */
  stop(): void {
    this.unbindViewport?.();
    this.unbindViewport = null;
    const sock = this.sock;
    const proc = this.proc;
    this.sock = null;
    this.proc = null;
    this.target = null;
    this.session += 1; // 在途事件/连接立即作废
    if (this.pushTimer) {
      clearTimeout(this.pushTimer);
      this.pushTimer = null;
    }
    try {
      sock?.write(mpvCmdLine(['quit']));
    } catch {
      /* ignore */
    }
    try {
      sock?.end();
    } catch {
      /* ignore */
    }
    if (proc && !proc.killed && proc.exitCode === null && proc.signalCode === null) {
      this.retiring.add(proc);
      const quitTimer = setTimeout(() => {
        try {
          proc.kill();
        } catch {
          /* ignore */
        }
      }, QUIT_GRACE_MS);
      proc.once('exit', () => {
        clearTimeout(quitTimer);
        this.retiring.delete(proc);
      });
    }
    this.state = initialKernelState();
    this.subOn = false;
  }

  /** 退出应用（index.ts will-quit） */
  dispose(): void {
    this.stop();
  }

  // ---- 内部 ----

  private async connectPipe(pipe: string, timeoutMs: number): Promise<Socket> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const ok = await new Promise<Socket | null>((resolve) => {
        const s = connect(pipe);
        const onErr = (): void => {
          s.removeListener('connect', onOk);
          s.destroy();
          resolve(null);
        };
        const onOk = (): void => {
          s.removeListener('error', onErr);
          resolve(s);
        };
        s.once('error', onErr);
        s.once('connect', onOk);
      });
      if (ok) return ok;
      if (Date.now() > deadline) throw new Error('mpv 通信管道连接超时（进程可能启动失败）');
      await new Promise((r) => setTimeout(r, 120));
    }
  }

  private onSockData(d: Buffer, session: number): void {
    if (session !== this.session) return;
    this.lineBuf += String(d);
    const lines = this.lineBuf.split('\n');
    this.lineBuf = lines.pop() || '';
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      let msg: unknown;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      const changed = reduceMpvMessage(this.state, msg);
      if (!changed) continue;
      // 关键节点（加载完成/播完）立即推，其余节流合并
      this.schedulePush(this.state.loaded || this.state.eof || this.state.exited);
    }
  }

  private markExited(): void {
    if (this.state.exited) return;
    this.state.exited = true;
    this.schedulePush(true);
  }

  private schedulePush(immediate: boolean): void {
    if (immediate) {
      this.pushNow();
      return;
    }
    if (this.pushTimer) return;
    this.pushTimer = setTimeout(() => {
      this.pushTimer = null;
      this.pushNow();
    }, PUSH_INTERVAL_MS);
  }

  private pushNow(): void {
    const w = this.target;
    if (!w || w.isDestroyed()) return;
    try {
      w.webContents.send(IPC.MPV_STATE, { session: this.session, state: { ...this.state } });
    } catch {
      /* 窗口已关：忽略 */
    }
  }
}
