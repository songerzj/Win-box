// src/main/player/PlayerWindow.ts
// 独立播放器窗口控制器：主窗口停留在「选集」页，播放在独立 BrowserWindow。
// 支持主窗口换集时同步切换本窗口当前集（player:switchEp）。
// 支持「小窗口模式」：无边框小窗只保留 上/下集 + 播放暂停（playerSetMini）。
import { app, BrowserWindow, screen, shell } from 'electron';
import { join } from 'node:path';
import { applyWindowCorner } from '../util/windowCorner';
import { applyUiScale, registerUiWindow, scaledWindowFor, uiScaleState } from '../ui/uiScale';
// 播放器窗口的位置/尺寸/最大化态落盘并恢复
import { watchWindowState, windowStateWriter } from '../ui/windowState';
import { applyEpisodeSwitch, type PlayerEpisodeSwitch } from '../../shared/playerEpisode';
import { isMac } from '../../shared/platform';

// 与渲染层 PlayerPage 约定的初始播放数据（可序列化）
export interface PlayerInit {
  key: string; // 播放源 key
  flag: string; // 线路
  episodes: { name: string; url: string }[];
  epIndex: number;
  title: string; // 资源名（不含集）
  subtitleTitle?: string; // 供字幕检索的剧名副名（详情页主标题，独立于集名）
  lastUrl: string; // 当前集解析出的真实地址
  lastName: string; // 当前集展示名（资源名 - 集名）
  meta?: {
    pic?: string;
    remarks?: string;
    sourceName?: string;
    vodId?: string;
    fromKey?: string;
    id?: string;
    profileId?: string;
  };
  /** 历史续播：上次播放进度（秒），交给播放器自动 seek（详情页正常播放不传） */
  startTime?: number;
}

let playerWin: BrowserWindow | null = null;
/**
 * `player:init` 的**单调序号** + 待发送的那一份。
 *
 * 解决两类竞态：
 *  ① 窗口还没加载完就先到的 init —— 直接 send 会丢，改为存下最新一份、`did-finish-load` 再发；
 *  ② 旧解析晚到的 init（用户已换源/换集）顶掉新内容 —— 渲染层凭序号丢弃更旧的那次。
 */
let initSeq = 0;
let pendingInit: (PlayerInit & { initSeq: number }) | null = null;

/** 盖章（序号 +1）并缓存为「最新一份待发 init」 */
function stampInit(init: PlayerInit): PlayerInit & { initSeq: number } {
  initSeq += 1;
  pendingInit = { ...init, initSeq };
  return pendingInit;
}

/** 播放器窗口关闭回调（index.ts 注册：触发夸克落盘文件清理等；每个回调只执行一次随窗口销毁） */
const closeHooks: Array<() => void> = [];
export function onPlayerWindowClosed(cb: () => void): void {
  closeHooks.push(cb);
}

/**
 * 「有声音无图像」类问题的根因修复
 *   本窗口是**透明窗**（mpv 画面从播放区透明处透出），任何把它改回不透明底色的路径
 *   都会把 mpv 画面整块盖住（实测：`setBackgroundColor('#0a0c10')` 后透明失效、屏幕全黑）。
 *   已知来源：`THEME_SET` IPC 处理器会按暗/亮给**发起窗口**设置不透明底色，而播放器窗口
 *   自己也跑主题引导（`renderer/lib/theme.ts` → `client.setTheme`）——因此必须排除本窗口。
 */
export function isPlayerWindow(w: BrowserWindow | null | undefined): boolean {
  return !!w && w === playerWin && !w.isDestroyed();
}

// ---- 小窗口模式状态 ----
// 小窗尺寸：宽 384 × 高 216（16:9，无标题栏 —— 渲染层 mini 态改用一条 18px 细拖拽条），
// 远小于播放器默认 1040×640；用户还可继续拖到最小 240×135。
// （界面缩放）：上面这些是 **100% 基准值**，实际用时按 `uiScaleState().scale` 等比放大
//   （窗口内容已被 setZoomFactor 放大，窗口尺寸必须同步放大，否则小窗里控制条会被裁掉）。
const MINI_W = 384;
const MINI_H = 216;
/** 小窗最小尺寸（16:9）：再小于这个尺寸控制条就点不到了 */
const MINI_MIN_W = 240;
const MINI_MIN_H = 135;
/** 播放器**正常模式**的基准尺寸（100% 档）；实际尺寸由 `scaledWindowFor` 按倍率给 */
const PLAYER_NORMAL = { width: 1040, height: 640, minWidth: 720, minHeight: 420 } as const;
let mini = false; // 是否处于小窗口模式
/** 进入小窗口前的正常窗口 bounds（含用户拖拽后的位置，move/resize 时保持最新） */
let normalBounds: Electron.Rectangle | null = null;
/** 记忆上次小窗口位置，再次进入时沿用 */
let miniBounds: Electron.Rectangle | null = null;

declare const __dirname: string;

function isDev(): boolean {
  return !app.isPackaged && process.env.NODE_ENV !== 'production';
}

/** 是否有独立播放器窗口打开 */
export function isPlayerOpen(): boolean {
  return !!playerWin && !playerWin.isDestroyed();
}

/** 取播放器窗口实例（未打开返回 null）——供老板键等隐藏/显示用 */
export function playerWindow(): BrowserWindow | null {
  return playerWin && !playerWin.isDestroyed() ? playerWin : null;
}

/** 是否处于小窗口模式 */
export function playerIsMini(): boolean {
  return mini;
}

export function playerIsFullscreen(): boolean {
  return !!playerWin && !playerWin.isDestroyed() && (fullscreenActive || playerWin.isFullScreen());
}

/**
 * 无边框播放器的 HTML5 元素全屏不会触发 BrowserWindow 的原生全屏事件，
 * 但窗口本身仍可能在屏幕边缘进入 Windows 的 resize 命中区。全屏期间
 * 必须显式关闭 resizable；退出后再恢复，避免全屏时拖动边缘改变窗口大小。
 */
export function playerSetResizable(resizable: boolean): boolean {
  const w = playerWin;
  if (!w || w.isDestroyed()) return false;
  const value = !!resizable;
  w.setResizable(value);
  return value;
}

let fullscreenRequest: Promise<boolean> = Promise.resolve(false);
let fullscreenBounds: Electron.Rectangle | null = null;
// Transparent Windows windows emit fullscreen events but may keep reporting
// false from BrowserWindow.isFullScreen(). The event-backed flag is therefore
// part of the actual state used by the MPV player.
let fullscreenActive = false;

/**
 * Restore the bounds captured immediately before entering native fullscreen.
 * The native `leave-full-screen` event is the source of truth here: transparent
 * windows may report `isFullScreen() === false` even while the native transition
 * is active, so checking only that method can leave the window at fullscreen bounds.
 *
 * ★ 2026-10-12（macOS 适配 §3.13）：**darwin 直接 no-op** —— macOS 原生全屏由系统用
 *   Space/SpaceBar 管理窗口尺寸（`setSimpleFullScreen` 之外的路径），Electron 会在退出
 *   全屏时把窗口放回进入前的 frame；再手动 `setBounds()` 反而会把窗口挪到错误位置。
 *   ⇒ Windows 的透明窗补偿逻辑原样保留，只在非 win32 时跳过这一层。
 */
function restoreFullscreenBounds(w: BrowserWindow): void {
  // darwin：系统自己恢复边界，绝不能手动写回（需真机验证，见下方 playerSetFullscreen 注释）
  if (isMac()) return;
  const bounds = fullscreenBounds;
  if (!bounds || w.isDestroyed() || fullscreenActive) return;
  if (w.isMaximized()) w.unmaximize();
  w.setBounds(bounds);
  if (fullscreenBounds === bounds) fullscreenBounds = null;
}

/**
 * Electron changes fullscreen asynchronously on Windows.  Returning the
 * requested value here made the renderer briefly believe it had entered
 * fullscreen even when the native transition was still pending (and a fast
 * second click could therefore toggle the wrong direction).  Wait for the
 * native event and report the actual state instead.
 */
export function playerSetFullscreen(fullscreen: boolean): Promise<boolean> {
  const w = playerWin;
  if (!w || w.isDestroyed() || mini) return Promise.resolve(false);
  const wanted = !!fullscreen;
  fullscreenRequest = fullscreenRequest.then(async () => {
    const current = playerWin;
    if (!current || current.isDestroyed() || mini) return false;
    /**
     * ★★ 2026-10-12（macOS 适配 §3.13）：darwin 走**原生全屏**分支 ★★
     *
     * Windows 那套补偿（透明窗 `isFullScreen()` 不可靠 → `fullscreenActive` 旗标 +
     * `setResizable(false)` + 手动 `setBounds()` + 1500ms 超时兜底）在 macOS 上**必须跳过**：
     *   · macOS 全屏是「切 Space」的动画，`setResizable(false)` 会卡住动画、留下不可缩放窗口；
     *   · 退出全屏时系统会把窗口恢复成进入前的 frame，手动 `setBounds()` 会打架。
     * 这里只做两件事：等原生 `enter/leave-full-screen` 事件（超时兜底），返回**真实**状态。
     *
     * ⚠️ 需真机验证（Windows 上无法伪验证）：
     *   ① 进/退原生全屏后窗口边界是否回到进入前的位置（多显示器 / 非主屏尤其要看）；
     *   ② 全屏态下控制条（HTML 覆盖层）可见性与自动隐藏是否正常；
     *   ③ mpv 视口同步 —— `MpvController.updateViewport()` 用
     *      `playerIsFullscreen() ? 0 : …` 算 `video-margin-ratio-top`，全屏时应为 0；
     *      需确认 `enter/leave-full-screen` 事件在 darwin 上的触发时机与该计算一致
     *      （事件由下方 openPlayerWindow 的监听器置 `fullscreenActive`）。
     */
    if (isMac()) {
      const alreadyNative = fullscreenActive || current.isFullScreen();
      if (alreadyNative === wanted) return wanted ? alreadyNative : false;
      await new Promise<void>((resolve) => {
        let settled = false;
        const finish = (): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          // 两个事件都摘掉（未注册的那个 removeListener 是无害的）
          current.removeListener('enter-full-screen', finish);
          current.removeListener('leave-full-screen', finish);
          resolve();
        };
        // 与 win32 同口径的超时兜底（事件万一不来，也不能让 Promise 悬着）
        const timer = setTimeout(finish, 1500);
        if (wanted) current.once('enter-full-screen', finish);
        else current.once('leave-full-screen', finish);
        current.setFullScreen(wanted);
      });
      if (current.isDestroyed()) return false;
      // macOS 上 `leave-full-screen` 后 `isFullScreen()` 可能仍是 true（动画未结束）→ 以退出为准。
      return wanted ? fullscreenActive || current.isFullScreen() : false;
    }
    const alreadyFullscreen = fullscreenActive || current.isFullScreen();
    if (alreadyFullscreen === wanted) {
      // Transparent Windows windows can report false after the native leave
      // event before the saved normal bounds have been restored.
      if (wanted) current.setResizable(false);
      else {
        restoreFullscreenBounds(current);
        current.setResizable(true);
      }
      return wanted ? alreadyFullscreen : false;
    }
    if (wanted) {
      fullscreenBounds = current.isMaximized() ? current.getNormalBounds() : current.getBounds();
      if (current.isMaximized()) current.unmaximize();
      // 先锁住无边框窗口的系统边缘缩放，再进入原生全屏。
      current.setResizable(false);
    }
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (wanted) current.removeListener('enter-full-screen', finish);
        else current.removeListener('leave-full-screen', finish);
        resolve();
      };
      const timer = setTimeout(finish, 1500);
      if (wanted) current.once('enter-full-screen', finish);
      else current.once('leave-full-screen', finish);
      current.setFullScreen(wanted);
    });
    if (current.isDestroyed()) return false;
    const actual = fullscreenActive || current.isFullScreen();
    if (!wanted) {
      if (!fullscreenActive) restoreFullscreenBounds(current);
      current.setResizable(true);
      // The leave event is authoritative for transparent windows; never
      // return a stale isFullScreen() value after the transition has ended.
      return false;
    }
    if (!actual) {
      // 原生全屏请求失败时也不能把窗口永久留在不可缩放状态。
      current.setResizable(true);
      fullscreenBounds = null;
    }
    return actual;
  });
  return fullscreenRequest;
}

/** 切换小窗口模式。mini=true 进入（缩小+禁全屏），false 恢复原窗口 */
export function playerSetMini(isMini: boolean): void {
  const w = playerWin;
  if (!w || w.isDestroyed()) return;
  if (isMini === mini) return;
  if (isMini) {
    // MPV fullscreen is event-backed because transparent windows can report
    // false from isFullScreen().  Leave it first; otherwise the fullscreen
    // bounds would be mistaken for the normal bounds of the mini window.
    if (playerIsFullscreen()) {
      void playerSetFullscreen(false).then(() => playerSetMini(true));
      return;
    }
    // 先记录正常边界：最大化时用 getNormalBounds()（Electron 记忆的还原边界）
    if (w.isMaximized()) {
      normalBounds = w.getNormalBounds();
      w.unmaximize();
    } else {
      normalBounds = w.getBounds();
    }
    const b = w.getBounds();
    const disp = screen.getDisplayMatching(b);
    const { x: ax, y: ay, width: aw, height: ah } = disp.workArea;
    // 界面缩放：小窗与其最小尺寸都按当前倍率放大
    const uiScale = uiScaleState().scale;
    const mw = Math.round(MINI_W * uiScale);
    const mh = Math.round(MINI_H * uiScale);
    // 优先沿用上次小窗位置，首次则置于所在屏水平居中
    const mb = miniBounds
      ? { x: Math.max(ax, Math.min(miniBounds.x, ax + aw - mw)), y: Math.max(ay, Math.min(miniBounds.y, ay + ah - mh)) }
      : { x: Math.round(ax + (aw - mw) / 2), y: Math.round(Math.max(ay, ay + (ah - mh) / 2)) };
    mini = true; // 先置位再改边界：move/resize 追踪器在 mini 态下只记 miniBounds，避免覆盖 normalBounds
    w.setMinimumSize(Math.round(MINI_MIN_W * uiScale), Math.round(MINI_MIN_H * uiScale));
    w.setFullScreenable(false);
    w.setBounds({ ...mb, width: mw, height: mh });
    w.webContents.send('player:mini', true);
  } else {
    const nb = normalBounds;
    const restore = scaledWindowFor(PLAYER_NORMAL);
    mini = false; // 先置位：恢复边界为正常尺寸，追踪器此时只会记录 normalBounds
    w.setMinimumSize(restore.minWidth, restore.minHeight);
    w.setFullScreenable(true);
    if (nb) w.setBounds(nb);
    else w.setSize(restore.width, restore.height);
    w.webContents.send('player:mini', false);
  }
}

/** 打开独立播放器窗口（已开则聚焦并刷新为最新 initial） */
export function openPlayerWindow(init: PlayerInit): void {
  if (playerWin && !playerWin.isDestroyed()) {
    playerWin.focus();
    playerWin.webContents.send('player:init', stampInit(init));
    return;
  }
  // 先盖章缓存：窗口加载完成前可能又来了新的 init，did-finish-load 时只发最新那份
  const payload = stampInit(init);
  // （界面缩放）：窗口尺寸随屏幕分辨率放大（内容由 setZoomFactor 等比放大）
  const playerSize = scaledWindowFor(PLAYER_NORMAL);
  /**
   * 播放器窗口也有记忆（不光是主窗口）：
   *   按上次的位置/尺寸开窗（已按当前显示器工作区与最小尺寸夹好，见 ui/windowState）；
   *   没有记忆 / 脏数据 → 用按屏幕推出的大小（首启行为不变）。
   */
  const savedWin = windowStateWriter('player').load({ width: playerSize.minWidth, height: playerSize.minHeight });
  playerWin = new BrowserWindow({
    width: savedWin?.width ?? playerSize.width,
    height: savedWin?.height ?? playerSize.height,
    // 位置也记（用户把播放器摆到哪，下次就还开在哪）；没记过则由系统决定
    ...(savedWin?.x !== undefined && savedWin?.y !== undefined ? { x: savedWin.x, y: savedWin.y } : {}),
    minWidth: playerSize.minWidth,
    minHeight: playerSize.minHeight,
    title: init.title || 'Win-Box 播放',
    frame: false,
    autoHideMenuBar: true,
    show: false,
    /**
     * MPV 内核硬前提，勿改回不透明
     *
     * mpv 以 `--wid=<本窗口 HWND>` 把画面嵌成**子窗口**，而 Chromium 的渲染面在它之上 ——
     * 只有「窗口 transparent + 播放区页面透明」时，mpv 画面才能从透明处透出；
     * HTML 覆盖层（控制条/弹幕/字幕）仍绘制在 mpv 之上且点击归 HTML（PoC 实测）。
     * 普通（HTML5）内核下整页仍是不透明背景绘制 → 视觉与旧版一致；
     * 最大化副作用沿用既有对策：maximize/unmaximize 时强制 invalidate（见下方监听）。
     */
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  playerWin.on('ready-to-show', () => playerWin?.show());
  // 登记播放器窗口 + 套用界面缩放（放在 ready-to-show 旁，webContents 已可用）
  registerUiWindow(playerWin);
  applyUiScale();
  // 最大化/还原：按 Windows 圆角偏好调整避免右上角黑角；并强制重绘防止视口未铺满的"贴左+右侧补背景"
  playerWin.on('maximize', () => {
    if (playerWin) { applyWindowCorner(playerWin, false); playerWin.webContents.invalidate(); }
  });
  playerWin.on('unmaximize', () => {
    if (playerWin) { applyWindowCorner(playerWin, true); playerWin.webContents.invalidate(); }
  });
  playerWin.on('enter-full-screen', () => {
    if (playerWin && !playerWin.isDestroyed()) {
      fullscreenActive = true;
      // ★ darwin：不动 resizable（会卡住 Space 动画并留下不可缩放窗口）；win32 原样。
      if (!isMac()) playerWin.setResizable(false);
      playerWin.webContents.invalidate();
      playerWin.webContents.send('player:fullscreen', true);
    }
  });
  playerWin.on('leave-full-screen', () => {
    if (playerWin && !playerWin.isDestroyed()) {
      fullscreenActive = false;
      // Restore here, after the native leave event, rather than relying on
      // BrowserWindow.isFullScreen(), which is unreliable for transparent windows.
      // （darwin 下 restoreFullscreenBounds 是 no-op：系统自己恢复边界）
      restoreFullscreenBounds(playerWin);
      if (!isMac()) playerWin.setResizable(true);
      playerWin.webContents.invalidate();
      playerWin.webContents.send('player:fullscreen', false);
    }
  });
  // 边界追踪：正常态记 normalBounds、小窗态记 miniBounds（进/出小窗时由 playerSetMini 先置位再改界，避免误写）
  const trackBounds = () => {
    const w = playerWin;
    if (!w || w.isDestroyed()) return;
    if (mini) miniBounds = w.getBounds();
    else if (!w.isMaximized() && !playerIsFullscreen()) normalBounds = w.getBounds();
  };
  playerWin.on('move', trackBounds);
  playerWin.on('resize', trackBounds);
  /**
   * （窗口大小记忆）：把「用户真正调过的」正常态落盘（防抖 800ms，关闭时 flush）。
   *   `shouldSave` 闸门 = **非小窗、非全屏**（小窗 384×216 与全屏的整屏框都不是用户想记的那个尺寸）。
   *   防抖在这里也是护栏：进出全屏/小窗时 `mini`/`fullscreenActive` 会先置位，
   *   800ms 后的落盘正好读到新状态 ⇒ 不会把全屏框误写进记忆。
   */
  watchWindowState('player', playerWin, () => !mini && !playerIsFullscreen());
  // 上次退出时播放器是最大化 → 立刻最大化（放在上面的监听之后、加载内容之前，同主窗口口径）
  if (savedWin?.maximized) {
    try {
      playerWin.maximize();
    } catch {
      /* 个别环境最大化失败：保持还原尺寸即可 */
    }
  }
  playerWin.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  playerWin.on('closed', () => {
    fullscreenActive = false;
    fullscreenBounds = null;
    playerWin = null;
    // 关闭播放窗口 → 通知清理本次夸克落盘文件（观看进度保留在本地历史）
    for (const h of closeHooks) {
      try { h(); } catch { /* ignore */ }
    }
  });
  // 页面加载后再注入初始数据，确保渲染层订阅已就绪
  if (isDev()) {
    playerWin.loadURL('http://localhost:5173/#/player');
  } else {
    playerWin.loadFile(join(__dirname, 'renderer', 'index.html'), { hash: '/player' });
  }
  playerWin.webContents.on('did-finish-load', () => {
    playerWin?.webContents.send('player:init', pendingInit ?? payload);
  });
}

/** 主窗口换集：通知播放器窗口切换到指定集 */
export function playerSwitchEpisode(request: number | PlayerEpisodeSwitch): boolean {
  if (!playerWin || playerWin.isDestroyed()) return false;
  if (typeof request === 'number') {
    playerWin.webContents.send('player:switchEp', request);
    return true;
  }
  if (!pendingInit) return false;
  const next = applyEpisodeSwitch(pendingInit, request);
  if (!next) return false;
  playerWin.webContents.send('player:init', stampInit(next));
  return true;
}

/**
 * 渲染层订阅就绪 → 重发缓存的最新 init。
 *
 * 真根因：新窗口的 `did-finish-load` 可能**早于** React 挂载后 `ipcRenderer.on('player:init')` 的订阅，
 *   那一发 init 直接丢掉 → 播放器窗口永远停在「等待播放…」（生产产物必现，dev 因页面加载慢反而侥幸不中）。
 *   改为**对方就绪再发**：重发同一份（序号相同）会被渲染层的 `acceptInitSeq` 判重忽略，不会重复应用。
 */
export function playerResendInit(): void {
  const w = playerWin;
  if (!w || w.isDestroyed() || !pendingInit) return;
  w.webContents.send('player:init', pendingInit);
}

/** 关闭播放器窗口（窗口关闭亦可走 win:close） */
export function closePlayerWindow(): void {
  if (playerWin && !playerWin.isDestroyed()) playerWin.close();
}
