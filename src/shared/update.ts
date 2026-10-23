// src/shared/update.ts
// 启动更新提示的契约与纯函数 —— 主/渲染层共用（零依赖，不含 electron）。
//
// 口径：启动时比对本地版本与 GitHub 最新 Release；若本地更低，
//   展示更新说明并由用户选择是否从「代理加速的 GitHub」下载 Setup 安装包。
//
// 设计红线（务必遵守）：
//   ① **检查失败绝不锁死软件** —— 网络不通/接口异常时 updateAvailable 必须为 false，正常放行。
//   ② 只有「远端版本更高 **且** 找到可用的 Setup 安装包」才展示更新提示（updateAvailable = true）。
//   ③ 加速前缀按顺序尝试，最后回退 **直连** github.com（加速站失效不致命）。

// ★ 2026-10-12（macOS 适配 · T04）：平台事实一律取自 `src/shared/platform.ts`（唯一真源），
//   本文件不再自己读 `process.platform` / `process.arch`。
import { archTag, isMac, type ArchTag, type InstallerPlatform } from './platform';

/** 发布资产挑选的目标平台（win32 = 既有 Setup 语义；darwin = dmg / zip）—— 真源在 platform.ts，此处转出便于调用方单点引用 */
export type { InstallerPlatform };

/** 发布仓库（唯一来源） */
export const UPDATE_REPO = 'yagami-hue/Win-box';

/** 最新 Release 接口（GitHub REST API 的 latest 端点） */
export const UPDATE_RELEASES_API = `https://api.github.com/repos/${UPDATE_REPO}/releases/latest`;

/** Release 页面（兜底给用户手动下载用） */
export const UPDATE_RELEASES_PAGE = `https://github.com/${UPDATE_REPO}/releases/latest`;

/**
 *   网盘备用下载地址（123 云盘分享页，用户自己手动下载）—— 与 GitHub 直连/加速下载互为备份。
 *   这是**固定链接**（用户维护同一分享、只换里面的文件）；日后若分享地址变更，**只改这一处**。
 */
export const DISK_UPDATE_URL = 'https://1824896562.share.123pan.cn/123pan/syh2jv-vxL6h?pwd=KAMI#';

/**
 * GitHub 代理加速前缀池（用法 = 前缀直接拼接原始 GitHub 地址，如
 *   `https://gh.acmsz.top/https://github.com/o/r/releases/download/…`）。
 *
 *
 *   该站点把社区节点硬编码在自家 JS bundle 里（**没有公开 JSON 接口**），本清单是**从 `github.akams.cn`
 *   的快照提取**（`contribute` 49 条 + `测绘` 31 条 = 80 条，见 `.tmp/akams-extract.cjs`）。
 *   顺序 = **本机实测速率降序**（`.tmp/akams-speed-measure.cjs`，Range 64KB/1.5s），前 48 条实测连通、
 *   其余垫底（运行时探测会很快跳过死节点）；另把历史稳定节点 `gh-proxy.org` 放首位（实测 2077 KB/s）。
 *   实测榜首 `gh.acmsz.top` 去首字节 **5057 KB/s**，显著快于旧池最好的 `gh-proxy.com`（4730）——
 *   而旧池里的 `mirror.ghproxy.com` 已持续超时。
 *
 * 红线（勿回退）：① 池子大 ⇒ **绝不逐个串行试**，检查阶段只取前 `ACCEL_CHECK_LIMIT` 条并发抢首响；
 *   下载前先跑两段测速（见 `UpdateService.speedTest`）。② 池子换新时把「实测榜单」与快照日期写在
 *   本注释里，别只贴域名。
 */
export const GH_ACCEL_PREFIXES: string[] = [
  'https://gh-proxy.org/',
  'https://gh.acmsz.top/',
  'https://xsadwsd.kdns.fr/',
  'https://ghpxy.hwinzniej.top/',
  'https://js.jiangss.shop/',
  'https://cfgh.ikgy.top/',
  'https://gh.meali.top/',
  'https://gg.z321.cc.cd/',
  'https://fastgit.cc/',
  'https://777.z321.cc.cd/',
  'https://github.mxw.qzz.io/',
  'https://gh.ddlc.top/',
  'https://gh.chjina.com/',
  'https://ghf.无名氏.top/',
  'https://ghproxy.cxkpro.top/',
  'https://gh.idayer.com/',
  'https://githubdog.com/',
  'https://git.yylx.win/',
  'https://ghproxy.imciel.com/',
  'https://ghm.078465.xyz/',
  'https://gitproxy.mrhjx.cn/',
  'https://gh.monlor.com/',
  'https://github.geekery.cn/',
  'https://github.ednovas.xyz/',
  'https://ghproxy.felicity.land/',
  'https://down.mxw.xx.kg/',
  'https://gh.qfmc0721.cc.cd/',
  'https://github.xxlab.tech/',
  'https://gh.jjj.gv.uy/',
  'https://gh.felicity.ac.cn/',
  'https://jiashu.1win.eu.org/',
  'https://github.tbap.top/',
  'https://gh.my-website.ccwu.cc/',
  'https://cdn.akaere.online/',
  'https://gh-proxy.com/',
  'https://tvv.tw/',
  'https://gh.07150721.xyz/',
  'https://github.dpik.top/',
  'https://g.blfrp.cn/',
  'https://gh.dpik.top/',
  'https://gh.sixyin.com/',
  'https://ghproxy.net/',
  'https://gh.noki.icu/',
  'https://ghfast.top/',
  'https://gh.catmak.name/',
  'https://github.ikgy.top/',
  'https://gh.inkchills.cn/',
  'https://git.669966.xyz/',
  'https://ghproxy.monkeyray.net/',
  // ---- 以下为同批快照中本机未测通者（运行时探测自动跳过，保留以便网络变化后自动复活）----
  'https://ghfile.geekertao.top/',
  'https://cdn.gh-proxy.com/',
  'https://j.1lin.dpdns.org/',
  'https://github.starrlzy.cn/',
  'https://github-proxy.memory-echoes.cn/',
  'https://gh.927223.xyz/',
  'https://gh.bugdey.us.kg/',
  'https://j.1win.ggff.net/',
  'https://gitproxy.127731.xyz/',
  'https://gh.b52m.cn/',
  'https://down.mxw.qzz.io/',
  'https://slink.ltd/',
  'https://github.tmby.shop/',
  'https://ghpr.cc/',
  'https://gh.tryxd.cn/',
  'https://gitproxy.click/',
  'https://github.chenc.dev/',
  'https://gh.jasonzeng.dev/',
  'https://gp.zkitefly.eu.org/',
  'https://ghproxy.1888866.xyz/',
  'https://ghp.arslantu.xyz/',
  'https://free.cn.eu.org/',
  'https://ghp.keleyaa.com/',
  'https://proxy.yaoyaoling.net/',
  'https://g.z321.cc.cd/',
  'https://gap.andyjin.website/',
  'https://gh.ruan.dpdns.org/',
  'https://github.nswrz.cn/',
  'https://gh.zhai.edu.pl/',
  'https://github-cf.947563.xyz/',
  'https://github.gohj99.site/',
  'https://githubproxy.gohj99.site/',
];

/** 检查最新 Release 阶段参与并发抢首响的加速条数（池子大，不能全放：每条都是真实请求） */
export const ACCEL_CHECK_LIMIT = 12;
/** 下载前小样本测速：最多探测多少条候选 / 并发多少 / 每条的窗口（字节、毫秒） */
export const ACCEL_PROBE_LIMIT = 56;
export const ACCEL_PROBE_CONCURRENCY = 10;
export const ACCEL_PROBE_BYTES = 96 * 1024;
export const ACCEL_PROBE_MS = 2200;
/** 小样本前列进入「大样本复测」的条数（复测才决定真正下载的那条） */
export const ACCEL_FINALISTS = 3;

/** GitHub Release 资产（原始字段，仅取需要的） */
export interface ReleaseAssetInput {
  name: string;
  browser_download_url: string;
  size: number;
}

/** GitHub Release 接口返回（仅取需要的字段） */
export interface ReleaseJson {
  tag_name?: string;
  name?: string;
  body?: string;
  published_at?: string;
  prerelease?: boolean;
  draft?: boolean;
  assets?: ReleaseAssetInput[];
}

/** 解析后的 Release */
export interface ParsedRelease {
  tag: string;
  version: string;
  name: string;
  notes: string;
  publishedAt: string;
  assets: ReleaseAssetInput[];
}

/** 选中待下载的安装包（含加速地址列表，末项为直连原始地址） */
export interface UpdateAsset {
  name: string;
  /** 原始 GitHub 下载地址 */
  url: string;
  size: number;
  /** 依次尝试的下载地址（加速前缀 + 直连） */
  accelUrls: string[];
}

/** 一次启动检查的结果 */
export interface UpdateCheckResult {
  /** 本地版本（app.getVersion()） */
  localVersion: string;
  /** 远端最新版本（由 tag 解析，如 release1.13.0 → 1.13.0） */
  remoteVersion: string;
  /** 远端 tag 原文 */
  tag: string;
  /** 有可用更新（远端更高且拿到 Setup 安装包）；是否安装由用户决定 */
  updateAvailable: boolean;
  /** 检查失败原因（此时 updateAvailable 必为 false，绝不锁死软件） */
  error?: string;
  releaseName?: string;
  releaseNotes?: string;
  publishedAt?: string;
  /** 选中的 Setup 安装包 */
  asset?: UpdateAsset;
}

/** 更新进度（主进程 → 渲染层推送） */
export interface UpdateProgress {
  phase: 'checking' | 'speedtest' | 'downloading' | 'done' | 'launching' | 'error';
  received: number;
  total: number;
  percent: number;
  /** 字节/秒 */
  speed: number;
  message?: string;
  error?: string;
}

/**
 * 单条线路的测速样本。
 *   `bytes`/`ms` 是「限时窗口内实际收到的字节数与耗时」；`ttfb` 是首字节耗时（可选）。
 *   速率口径：**优先用「去掉首字节」的 [ms - ttfb] 段**算 sustained 速率 —— 小样本窗口下
 *   TTFB 会占掉大半时间（实测同一节点 64KB 样本 217KB/s、2MB 样本 5057KB/s，差 20 倍），
 *   不扣掉握手/首字节就会把「慢节点先回包」误判成最快。
 */
export interface SpeedSample {
  url: string;
  bytes: number;
  ms: number;
  ok: boolean;
  /** 首字节耗时（ms）；0/缺省 = 未知（退回整段耗时口径） */
  ttfb?: number;
}

/**
 * 单条线路实测速率（字节/秒）：ok=false / 数据不足 → 0。
 * 有 ttfb 时按「去掉首字节」的段算；但该窗口 **<100ms 就不足以代表持续速率**（典型是样本几乎
 * 在首字节那一刻一次性到达）→ 退回整段耗时口径，避免把「只收到一小撮」误算成天文速率。
 */
export function sampleBps(s: SpeedSample): number {
  if (!s.ok || s.ms <= 0 || s.bytes <= 0) return 0;
  const ttfb = Math.max(0, Number(s.ttfb) || 0);
  const steadyMs = s.ms - ttfb;
  const useMs = steadyMs >= 100 ? steadyMs : s.ms;
  return Math.round((s.bytes * 1000) / useMs);
}

/**
 * 测速结果排序 → 下载候选顺序：
 *   ① 测速成功且够快的，按速率从高到低；② 其余保持原始顺序垫底（仍作为失败回退）。
 *   纯函数（便于单测）：不改变不可用线路的语义，只是把它们挪到后面。
 */
export function rankBySpeed(samples: SpeedSample[], minBytes = 0): string[] {
  const good = samples
    .filter((s) => s.ok && s.bytes >= minBytes)
    .sort((a, b) => sampleBps(b) - sampleBps(a))
    .map((s) => s.url);
  const rest = samples.filter((s) => !(s.ok && s.bytes >= minBytes)).map((s) => s.url);
  return [...good, ...rest];
}


/** 去掉 tag 的 `release` / `v` 前后缀，只留版本主体（`release1.13.0` → `1.13.0`） */
export function normalizeVersion(input: string): string {
  let s = (input || '').trim();
  s = s.replace(/^release[-_\s]*/i, '');
  s = s.replace(/^v/i, '');
  return s.trim();
}

/** 版本 → 数字段（`1.13.0` → [1,13,0]；`release97` → [97]）；无数字 → [] */
export function parseVersion(input: string): number[] {
  const m = normalizeVersion(input).match(/\d+/g);
  return m ? m.map((n) => parseInt(n, 10)) : [];
}

/** 语义化比较：a<b → -1；a>b → 1；相等 → 0（缺位补 0） */
export function compareVersions(a: string, b: string): number {
  const A = parseVersion(a);
  const B = parseVersion(b);
  const n = Math.max(A.length, B.length);
  for (let i = 0; i < n; i++) {
    const x = A[i] ?? 0;
    const y = B[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** 远端是否比本地新（本地更低 → 需要更新） */
export function isUpdateAvailable(local: string, remote: string): boolean {
  if (!parseVersion(remote).length) return false; // 远端版本解析不出来 → 不判定为有更新
  return compareVersions(remote, local) > 0;
}

/** 逃生舱环境变量名（存在且为真值时，开发模式也照常检查更新，便于调试更新流程） */
export const FORCE_UPDATE_CHECK_ENV = 'WINBOX_FORCE_UPDATE_CHECK';

/**
 * ★ 2026-10-12（用户要求「开发模式跳过启动强制更新」）：是否跳过启动强制更新检查的判定入参。
 *   - `isPackaged`：是否为打包后的正式安装包（= 主进程 `app.isPackaged`）；开发模式（`electron .`）为 false。
 *   - `forceCheck`：逃生舱是否开启（= `envForcesUpdateCheck(process.env)`）。
 */
export interface SkipUpdateCheckOptions {
  isPackaged: boolean;
  forceCheck: boolean;
}

/**
 * ★ 2026-10-12：是否需要**跳过**启动强制更新检查（纯函数，零 electron / 零 fs，便于单测）。
 *
 * 动机：开发模式（`app.isPackaged === false`，即 `electron .` / `npm run dev`）不应在启动时
 *   被全屏遮罩锁死、自动下载并拉起安装程序 —— 那会打断调试、且极易误触发（实测一次 dev 就
 *   自动下载安装了官方包）。故：
 *   ① **正式安装包（isPackaged === true）恒不跳过** —— 硬约束：已发布版本的更新行为零变更。
 *   ② 开发模式默认**跳过**（返回 true，放行界面）。
 *   ③ 逃生舱：`forceCheck === true` 时开发模式也**不跳过**（便于开发者验证更新流程）。
 */
export function shouldSkipUpdateCheck(o: SkipUpdateCheckOptions): boolean {
  // ① 正式安装包恒不跳过（已发布版本行为零变更）
  if (o.isPackaged) return false;
  // ② 开发模式：默认跳过；③ 逃生舱开启则不跳过
  return !o.forceCheck;
}

/**
 * ★ 2026-10-12：从环境变量记录里判断逃生舱 `WINBOX_FORCE_UPDATE_CHECK` 是否开启
 *   （纯函数，便于单测；把 `process.env` 当普通记录传入即可）。接受 `1/true/yes/on`（大小写不敏感）。
 */
export function envForcesUpdateCheck(env: Record<string, string | undefined>): boolean {
  const v = String(env?.[FORCE_UPDATE_CHECK_ENV] ?? '')
    .trim()
    .toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

/** 原始 GitHub 地址 → 加速地址列表（前缀顺序 + 直连兜底，去重） */
export function buildAccelUrls(url: string, prefixes: string[] = GH_ACCEL_PREFIXES): string[] {
  const raw = (url || '').trim();
  if (!raw) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (u: string) => {
    if (!u || seen.has(u)) return;
    seen.add(u);
    out.push(u);
  };
  for (const p of prefixes) {
    const pre = p.endsWith('/') ? p : p + '/';
    push(pre + raw);
  }
  push(raw);
  return out;
}

/** 安装包挑选参数（平台缺省 win32 → 既有 Windows 行为逐项不变） */
export interface PickInstallerOptions {
  /** 目标平台；缺省 `'win32'`（既有语义），darwin 走 dmg / zip */
  platform?: InstallerPlatform;
  /**
   * dmg / zip 资产名里的架构标签（`'arm64'` / `'x64'`）；缺省取当前架构 `archTag()`。
   * 传 `''` 表示「不挑架构」（未知架构时 `archTag()` 也会返回 `''`）。
   */
  arch?: ArchTag;
  /** 优先挑名字里含该版本的资产（会先做 `normalizeVersion`） */
  version?: string;
}

/** 资产名匹配：只看扩展名，大小写不敏感 */
function hasExt(name: string, ext: string): boolean {
  return new RegExp(`\\.${ext}$`, 'i').test(name);
}

/** 只保留「有合法 name 字符串」的资产（GitHub 接口偶发字段缺失，防御性过滤） */
function validAssets(assets: ReleaseAssetInput[]): ReleaseAssetInput[] {
  return (Array.isArray(assets) ? assets : []).filter((a) => !!a && typeof a.name === 'string');
}

/** 名字里是否带 `-<arch>` 段（`Win-Box-1.20.10-arm64.dmg` / `-x64.dmg`） */
function hasArchTag(name: string, arch: string): boolean {
  const tag = String(arch || '').trim();
  if (!tag) return false;
  // arch 取值只会是 'arm64' / 'x64'，不含正则元字符，可直接拼进 pattern
  return new RegExp(`-${tag}(?:[^A-Za-z0-9]|$)`, 'i').test(name);
}

/**
 * win32 安装包挑选（**与改动前 `pickSetupAsset` 的实现逐个分支一致**，勿改顺序）：
 *   名字含 setup 的 .exe → 名字含目标版本者优先 → 其余 .exe 兜底 → 无 .exe 返回 null。
 */
function pickWindowsInstaller(list: ReleaseAssetInput[], version?: string): ReleaseAssetInput | null {
  const exes = list.filter((a) => hasExt(a.name, 'exe'));
  if (!exes.length) return null;
  const setups = exes.filter((a) => /setup/i.test(a.name));
  const pool = setups.length ? setups : exes;
  const v = version ? normalizeVersion(version) : '';
  if (v) {
    const exact = pool.find((a) => a.name.includes(v));
    if (exact) return exact;
  }
  return pool[0];
}

/**
 * darwin 安装包挑选（严格按架构文档的四级顺序，可单测）：
 *   ① `.dmg` 且名字带 `-<arch>` → ② `.dmg` 且名字含目标版本 → ③ 任意 `.dmg` → ④ 任意 `.zip` → null。
 *   `.zip` 是 darwin 便携包兜底（解压后直接拖进 Applications）。
 */
function pickMacInstaller(list: ReleaseAssetInput[], arch: ArchTag, version?: string): ReleaseAssetInput | null {
  const dmg = list.filter((a) => hasExt(a.name, 'dmg'));
  if (dmg.length) {
    const tagged = dmg.find((a) => hasArchTag(a.name, arch));
    if (tagged) return tagged;
    const v = version ? normalizeVersion(version) : '';
    if (v) {
      const byVersion = dmg.find((a) => a.name.includes(v));
      if (byVersion) return byVersion;
    }
    return dmg[0];
  }
  const zip = list.filter((a) => hasExt(a.name, 'zip'));
  if (zip.length) return zip[0];
  return null;
}

/**
 * ★ 2026-10-12（macOS 适配）：**平台化的安装包挑选**。
 *   - win32：逐分支等价于原 `pickSetupAsset`（Setup .exe → 版本匹配 → 任意 .exe）。
 *   - darwin：`-<arch>.dmg` → 含版本 `.dmg` → 任意 `.dmg` → 任意 `.zip` → null。
 *     原实现只认 `/\.exe$/i`，darwin 上恒返回 null（= 有新版也不更新），这是本次要修的根因。
 * 纯函数（零 electron / 零 fs），平台与架构一律来自 `src/shared/platform.ts`。
 */
export function pickInstallerAsset(
  assets: ReleaseAssetInput[],
  o: PickInstallerOptions = {},
): ReleaseAssetInput | null {
  const list = validAssets(assets);
  const platform: InstallerPlatform = o.platform === 'darwin' ? 'darwin' : 'win32';
  if (!isMac(platform)) return pickWindowsInstaller(list, o.version);
  return pickMacInstaller(list, o.arch ?? archTag(), o.version);
}

/**
 * 从 Release 资产里挑出 **Setup 安装包**（`Win-Box.Setup.x.y.z.exe`）。
 * 兼容旧签名：= `pickInstallerAsset(assets, { platform: 'win32', version })` —— **既有断言全部保持**。
 */
export function pickSetupAsset(assets: ReleaseAssetInput[], version?: string): ReleaseAssetInput | null {
  return pickInstallerAsset(assets, { platform: 'win32', version });
}

/** GitHub Release JSON → 解析结果（容错：字段缺失一律给默认值） */
export function parseLatestRelease(json: ReleaseJson): ParsedRelease {
  const tag = String(json?.tag_name || '').trim();
  return {
    tag,
    version: normalizeVersion(tag),
    name: String(json?.name || tag || '').trim(),
    notes: String(json?.body || ''),
    publishedAt: String(json?.published_at || ''),
    assets: Array.isArray(json?.assets) ? json.assets : [],
  };
}

/** 字节数 → 人类可读（下载进度展示用；纯函数便于单测） */
export function formatBytes(n: number): string {
  const v = Math.max(0, Number(n) || 0);
  if (v < 1024) return `${Math.round(v)} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  if (v < 1024 * 1024 * 1024) return `${(v / 1024 / 1024).toFixed(1)} MB`;
  return `${(v / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
