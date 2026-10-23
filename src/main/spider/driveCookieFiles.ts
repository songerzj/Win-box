// src/main/spider/driveCookieFiles.ts — 把用户绑定的网盘凭据同步为「jar 系期望的 cookie 文件」。
//
// 通解（对某壳类源 jar 的适配）
//   该族（sun.json；含若干壳类源）
//   在 `detailContent` 组装播放列表前调用 `merge.a.a.filterCloudDiskLinks(url)`：
//     · 链接命中 pan.quark.cn  → 要求 /quark_cookie.txt 存在且内容非空，否则降级返回类型名「quark」；
//     · drive.uc.cn            → /uc_cookie.txt；
//     · pan.baidu.com          → /baidu.txt；
//     · 其余（cloud123/cloud189/aliyun/xunlei/guangya 同理）。
// 被降级 = 该条网盘链接被**丢弃**（列表里只剩类型名或整条移除）→ 典型现象
//   「源能进、能搜，但详情里拿不到可播资源 / 播放列表为空」。
//   文件路径 = `<externalStorage>/TVBox/<file>.txt`（jar 用 `merge.m.k.b()` 拼：外部存储 + "TVBox"）。
//   桌面桩 `android.os.Environment.getExternalStorageDirectory()` = `<java.io.tmpdir>/tvbox-ext`
//   （见 resources/jvm/stubs-src 同源构建的 stubs.jar），故实际落点 =
//     `<os.tmpdir()>/tvbox-ext/TVBox/<file>.txt`
//   内容协议：`merge.b.w.r(key)` = `new JSONObject(k.a(file)).optString(key)`，
//   即 **JSON 对象、键 `cookie`**：`{"cookie":"..."}`（与安卓 TVBox 用户手放/源设置页写出的格式一致）。
//
//   与之并列的某影视壳类源（Cloud_*Guard）读的是 ext["Cloud-drive"] 指向的配置文件（quarkCookie/ucCookie…），
//   由 SpiderHost.syncCloudDriveConfig 负责——两者互补，缺一都会「详情/取流为空」。
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

/** provider（DriveStore 键，小写）→ 某壳类源 cookie 文件名（名单取自 jar 内字符串引用） */
export const PIZAZZ_COOKIE_FILES: Record<string, string> = {
  quark: 'quark_cookie.txt',
  uc: 'uc_cookie.txt',
  baidu: 'baidu.txt',
  ali: 'aliyun.txt',
  alipan: 'aliyun.txt', // 历史双键，归一化前也可能出现
};

/** 某壳类源 cookie 目录 = 外部存储桩/TVBox（与 jar 内 `merge.m.k.b()` 拼接一致） */
export function pizazzCookieDir(tmp = tmpdir()): string {
  return join(tmp, 'tvbox-ext', 'TVBox');
}

/** 单个 provider 的 cookie 文件绝对路径；无映射返回 '' */
export function pizazzCookiePath(provider: string, tmp = tmpdir()): string {
  const file = PIZAZZ_COOKIE_FILES[String(provider || '').trim().toLowerCase()];
  return file ? join(pizazzCookieDir(tmp), file) : '';
}

/**
 * 写单个 provider 的 cookie 文件。
 * （根因修复）
 *   某影视壳类源族对 **quark / uc** 的登录判定 =
 *   Gson 反序列化 `merge.i.d` 后 **三字段均非空**（`d()` = a()>0 && b()>0 && c()>0；
 *   映射：`cookie` / `member_type` / `nickname`，见 `merge.b.w.o().d()` 与 `merge.b.B.l().d()`）。
 *   桌面端此前只写 `{"cookie":…}` → member_type/nickname 为空 → **已绑定仍报
 *   「还未登录夸克账号,请前往【配置中心】登录」**（quark）与对应 UC 文案。
 *   · 三字段的值**不参与业务**（jar 内仅 d() 校验非空）→ 后两者缺省填占位；
 *   · **旧文件里已有真实值（jar 自己回写过）则保留**——不覆盖真数据。
 *   · 百度（`merge.b.j`）只读 `cookie` 键 → **不补三键**。
 */
export function writePizazzCookieFile(provider: string, value: string, tmp = tmpdir()): string {
  const path = pizazzCookiePath(provider, tmp);
  const v = String(value || '').trim();
  if (!path || !v) return '';
  const p = String(provider || '').trim().toLowerCase();
  const body: Record<string, string> = { cookie: v };
  if (p === 'quark' || p === 'uc') {
    let keepNick = '';
    let keepType = '';
    try {
      const old = JSON.parse(readFileSync(path, 'utf-8')) as { nickname?: unknown; member_type?: unknown } | null;
      if (old && typeof old.nickname === 'string') keepNick = old.nickname.trim();
      if (old && typeof old.member_type === 'string') keepType = old.member_type.trim();
    } catch {
      /* 无旧文件 / 损坏 → 用占位 */
    }
    body.nickname = keepNick || 'Win-Box';
    body.member_type = keepType || '1';
  }
  mkdirSync(pizazzCookieDir(tmp), { recursive: true });
  writeFileSync(path, JSON.stringify(body), 'utf-8');
  return path;
}

/**
 * 读回单个 provider 的 cookie 文件内容（用于「已有内容不重复写」判定与自检）：
 * 不存在/损坏返回 ''。
 */
export function readPizazzCookie(provider: string, tmp = tmpdir()): string {
  const path = pizazzCookiePath(provider, tmp);
  if (!path || !existsSync(path)) return '';
  try {
    const obj = JSON.parse(readFileSync(path, 'utf-8')) as { cookie?: unknown };
    return typeof obj?.cookie === 'string' ? obj.cookie : '';
  } catch {
    return '';
  }
}

/** 删除单个 provider 的 cookie 文件（解绑用；等价上游「清空该文件」语义，对 jar 侧一律视为未配置） */
export function removePizazzCookieFile(provider: string, tmp = tmpdir()): void {
  const path = pizazzCookiePath(provider, tmp);
  if (!path) return;
  rmSync(path, { force: true });
}

// ---------------------------------------------------------------------------
// 某影视壳类源族（壳通解家族）——第三通道
//
// 按协议实现（`Quark.checkquarkcookie()` / `Ucpan.checkuccookie()`）：
//   · 读文件 = `getCache("quarkcookie")` → `new File(<Context.getFilesDir()>/TV, ".quarkcookie")`
//     （文件名规则：不以 "." 开头的资源名会被加 "." 前缀）；UC = `.ucpancookie`（资源名 ucpancookie）。
//   · 内容为**裸 cookie 串**（UTF-8 读入后直接 trim 当 Cookie 用，**不是** JSON）——
//     缺失/为空即报「还没有配置夸克 Cookie，请先去配置中心登录夸克」。
//   · `Context.getFilesDir()` 落点 = SpiderRunner 的 `-Dtvbox.spiderCacheDir`（桌面桩），
//     即 `<spider 缓存根>/sandbox/files/TV/`（SpiderRunner.java 里 `Context.setBaseDir(<sandbox>)`）。
//
// 缺口回顾：此前桌面只同步了某影视壳类源的云盘配置与某壳类源的 TVBox/*.txt 两条通道，
//   读取的 `.quarkcookie` 从未写过 → 已绑定也报「还没有配置夸克 Cookie」。
// ---------------------------------------------------------------------------

/** 该族 cookie 文件名（provider 小写键 → 文件名）；资源名取自 jar 内字符串表 */
export const WEX_COOKIE_FILES: Record<string, string> = {
  quark: '.quarkcookie',
  uc: '.ucpancookie',
};

/**
 * 蜘蛛 JVM 数据沙箱根：`<spider 缓存根>/sandbox`。
 * 口径与 JarSpiderBridge 的 `join(cacheDir, '..', 'sandbox')`（cacheDir = `<缓存根>/converted`）等价，
 * 也是 JVM 侧 `-Dtvbox.spiderCacheDir` 的值 —— 两处必须一致，勿分别手拼。
 */
export function spiderSandboxDir(spiderCacheRoot: string): string {
  return join(spiderCacheRoot, 'sandbox');
}

/** 该族 cookie 目录 = 沙箱内 `files/TV`（Context.getFilesDir() + "/TV"） */
export function wexCookieDir(sandboxDir: string): string {
  return join(sandboxDir, 'files', 'TV');
}

/** 单个 provider 的该族 cookie 文件绝对路径；无映射返回 '' */
export function wexCookiePath(provider: string, sandboxDir: string): string {
  const file = WEX_COOKIE_FILES[String(provider || '').trim().toLowerCase()];
  return file ? join(wexCookieDir(sandboxDir), file) : '';
}

/**
 * 写单个 provider 的该族 cookie 文件（内容 = 裸 cookie 串，jar 侧直接 trim 使用）。
 * provider 无映射或凭据为空 → 不写，返回 ''；成功返回写入路径。
 */
export function writeWexCookieFile(provider: string, value: string, sandboxDir: string): string {
  const path = wexCookiePath(provider, sandboxDir);
  const v = String(value || '').trim();
  if (!path || !v) return '';
  mkdirSync(wexCookieDir(sandboxDir), { recursive: true });
  writeFileSync(path, v, 'utf-8');
  return path;
}

/** 删除单个 provider 的该族 cookie 文件（解绑用；jar 侧读到空 = 未配置） */
export function removeWexCookieFile(provider: string, sandboxDir: string): void {
  const path = wexCookiePath(provider, sandboxDir);
  if (!path) return;
  rmSync(path, { force: true });
}

// ---------------------------------------------------------------------------
// ★ 2026-10-13 AiWex 系（新光影 AiNewGuanYing / AiPan1Me / 玩偶 / 木偶 / AiNewWoNiu4K …）
//   ——**这一版壳真正的凭据通道**
//
// 反编译实证（本会话取证，jar = converted/runtime-dex/*.r2.jar）：
//   · 这版壳**根本不读** `files/TV/.quarkcookie`（那是旧版家族的通道，
//     全库 grep `quarkcookie` 零命中）——继续只写那份文件等于白写。
//   · 它把全部账号/网盘凭据放在 Android SharedPreferences：
//       Context.getSharedPreferences("NewWexFnw_preferences", 0)   ← 见 merge/x0/e.H()
//     键名：`Wex_quark_cookie` / `Wex_ucpan_cookie` / `Wex_baidu_cookie` /
//           `Wex_pan115_cookie` / `Wex_bili_cookie` / `Wex_guanying_cookie` /
//           `Wex_pan1me_cookie` / `Wex_WoNiu4K_Cookie` / `Wex_guangya_zhenying_cookie` …
//   · 用户看到的「还没有配置夸克 Cookie」出自读 `Wex_quark_cookie` 的类（merge/d0/i、merge/h0/k）。
//
// 根因有两层，缺一不可：
//   ① 桩 `android.content.SharedPreferences$Mem` 此前是**纯内存** → 宿主每次回收/重启
//      蜘蛛 JVM，`Wex_*` 全空，网页配置中心登录一次也留不住。已改为真持久化
//      （`<沙箱>/shared_prefs/<name>.xml`，与壳自己的备份同路径同格式）。
//   ② 用户在 Win-box「网盘」页扫码绑定的 cookie 只进 DriveStore，壳那条路永远不会被写。
//      → 落成下面这份「宿主默认值」文件，由桩在**载入时**兜底并入。
//
// ⚠ 语义是「缺省」而非「覆盖」：壳会自己刷新 cookie（auth/pc/flush 回写 Wex_quark_cookie）。
//   若宿主值恒优先，壳刷新完又被旧值盖回 → 反而把有效凭据改坏。
//   桩的实现保证：宿主默认值只读兜底、**绝不落盘** → 用户在 Win-box 解绑即失效。
// ---------------------------------------------------------------------------

/** DriveStore provider（小写）→ AiWex 系 SharedPreferences 键名 */
export const WEX_PREF_KEYS: Record<string, string> = {
  quark: 'Wex_quark_cookie',
  uc: 'Wex_ucpan_cookie',
  baidu: 'Wex_baidu_cookie',
};

/** 宿主默认值文件名（桩侧常量 HOST_PREFS_FILE 必须与此一致） */
export const WEX_HOST_PREFS_FILE = 'winbox-host-prefs.properties';

/** 宿主默认值文件：`<沙箱>/shared_prefs/winbox-host-prefs.properties` */
export function wexHostPrefsPath(sandboxDir: string): string {
  return join(sandboxDir, 'shared_prefs', WEX_HOST_PREFS_FILE);
}

/**
 * 把 DriveStore 凭据写成「宿主默认值」文件（本文件由宿主独占 → 全量重写）。
 *
 * 格式：每行 `key=value`，UTF-8，**不做任何转义**（桩侧按第一个 `=` 切一刀）。
 * cookie 里含 `=` / `;` / `+` / `/` 都没问题；但绝不能含换行，故先压平。
 *
 * ★★ **内容没变就不要重写这个文件**（哪怕只是启动时的例行同步）★★
 * 桩侧按 mtime 裁定「宿主值和壳的 XML 值谁更新」——
 * 若每次启动都把它刷新成「现在」，宿主就恒赢，壳自己刷新的 cookie 反而永远被盖掉。
 *
 * @returns 写入的 SharedPreferences 键名列表（无映射/空值跳过；全部解绑时为空数组）
 *   ⚠ 返回值只含**凭据键**（不含恒写入的桌面环境键 / UC TV Token 键）—— 调用方用它打日志。
 */
export function syncWexHostPrefs(
  tokens: Record<string, string>,
  sandboxDir: string,
  ucTv?: UcTvSeedInput | null,
): string[] {
  const dir = join(sandboxDir, 'shared_prefs');
  /** 凭据行 —— 函数返回值就是它们的键（调用方用它打日志 / 判定「有没有绑定」） */
  const lines: string[] = [];
  /** 与凭据无关的恒写入行（桌面环境键 / UC TV Token）—— 不计入返回值 */
  const extra: string[] = [];
  for (const [p, v] of Object.entries(tokens || {})) {
    const key = WEX_PREF_KEYS[String(p || '').trim().toLowerCase()];
    if (!key || typeof v !== 'string') continue;
    const value = v.trim();
    if (!value) continue;
    lines.push(`${key}=${value.replace(/[\r\n]+/g, ' ')}`);
  }
  // ★ 2026-10-14（合并上游 1.21.4「第四通道」）：桌面环境键恒写入 —— 该族的默认多线程方式是
  //   Go 代理（GoProxy.startServer），桌面端没有 Go 代理（初始化阶段被跳过）⇒ 走 Go 的原画线路
  //   必报 `[baidu](threadProxy) Go多线程启动失败`。这里强制切到 Java 多线程（= 配置中心里
  //   「多线程代理 = Java多线程」的等价物），是桌面端唯一能走通的模式。
  //   ⚠ 与上游不同：上游写的是 `shared_prefs/seed.txt`（只有 prefs 影子类能读，见 prefsShim.ts）；
  //   本仓的桩（resources/jvm/stubs-src/.../SharedPreferences.java）已是**真实实现**，
  //   直接读本文件，故这里把同一批键写进 properties 通道（详见 JarSpiderBridge.classpathJars 注释）。
  for (const [k, v] of Object.entries(WEX_PREF_ENV)) extra.push(`${k}=${v}`);
  // ★ 2026-10-14 UC TV Token（非会员 UC 原画）：wex 族的 UC 取流按 `member_type` 分流 ——
  //   非高会读的是 `Wex_ucpan_token`（OAuth token 对 JSON）而不是 cookie，缺它即报
  //   「非高会需要配置 UC TV Token，请到配置中心扫码获取」。device_id 为配套设备指纹。
  const tvToken = typeof ucTv?.token === 'string' ? ucTv.token.replace(/[\r\n]+/g, ' ').trim() : '';
  const tvDevice = typeof ucTv?.deviceId === 'string' ? ucTv.deviceId.replace(/[\r\n]+/g, ' ').trim() : '';
  if (tvToken) {
    extra.push(`${UCTV_PREF_KEYS.token}=${tvToken}`);
    if (tvDevice) extra.push(`${UCTV_PREF_KEYS.deviceId}=${tvDevice}`);
  }
  mkdirSync(dir, { recursive: true });
  const path = join(dir, WEX_HOST_PREFS_FILE);
  // ★ 没有任何绑定时也要写：否则解绑最后一个后，旧文件仍在 → 解绑不生效
  //   （⚠ 2026-10-14 起文件里恒有桌面环境键，不再是「空文件」—— 关键是**凭据键必须消失**）
  const all = lines.concat(extra);
  const next = all.length ? `${all.join('\n')}\n` : '';
  let prev: string | null = null;
  try {
    prev = existsSync(path) ? readFileSync(path, 'utf-8') : null;
  } catch {
    prev = null;
  }
  if (prev !== next) writeFileSync(path, next, 'utf-8');
  return lines.map((l) => l.slice(0, l.indexOf('=')));
}

/**
 * 解绑：从宿主默认值文件里摘掉该 provider 的键。
 * 桩侧不再兜底 → 该源回到「未配置」状态（除非用户另外在网页配置中心登录过）。
 */
export function removeWexHostPref(provider: string, sandboxDir: string): void {
  const key = WEX_PREF_KEYS[String(provider || '').trim().toLowerCase()];
  const path = wexHostPrefsPath(sandboxDir);
  if (!key || !existsSync(path)) return;
  try {
    const kept = readFileSync(path, 'utf-8')
      .split('\n')
      .filter((l) => {
        const t = l.trim();
        if (!t) return false;
        const eq = t.indexOf('=');
        return eq > 0 && t.slice(0, eq).trim() !== key;
      });
    writeFileSync(path, kept.length ? `${kept.join('\n')}\n` : '', 'utf-8');
  } catch {
    // 读不了就整份重写为空：解绑语义下宁可全清，也不能留下已解绑的凭据
    try {
      writeFileSync(path, '', 'utf-8');
    } catch {
      /* ignore */
    }
  }
}

/**
 * 全量同步：把 tokens 里所有有映射的 provider 落盘（该族）。
 * 返回实际写入的文件绝对路径列表（无变化/无映射的跳过）。
 */
export function syncWexCookieFiles(tokens: Record<string, string>, sandboxDir: string): string[] {
  const written: string[] = [];
  for (const provider of Object.keys(WEX_COOKIE_FILES)) {
    const value = tokens?.[provider];
    if (typeof value === 'string' && value.trim()) {
      const path = writeWexCookieFile(provider, value, sandboxDir);
      if (path) written.push(path);
    } else {
      // Full sync semantics: a removed/empty credential must not leave a stale
      // cookie that makes a later JVM appear authenticated with old data.
      removeWexCookieFile(provider, sandboxDir);
    }
  }
  return written;
}

// ---------------------------------------------------------------------------
// 该族「SharedPreferences 通道」——第四通道（根因修复）
//
// 按协议实现：该族（若干壳类源）的 `Wex_*` 键存在 **Android SharedPreferences
//   `NewWexFnw_preferences`** 里（`merge/x0/e.H()` = `InitOrigin.context().getSharedPreferences(...)`，
//   `x0/e.I(k, d)` = `H().getString(k, d)`）。
// 而桌面桩的 SharedPreferences 是**纯内存**实现（从不落盘）⇒ Node 写任何文件都到不了它。
// 修法 = `prefs-shim` 影子类（见 src/engine/spider/prefsShim.ts）：它排在 -cp 最前盖住原桩，
//   并从 `<Context.getBaseDir()>/shared_prefs/seed.txt` 读种子，每行 `表名 \t 键 \t 值`。
// 因此本文件是第四通道：既写文件通道（前三通道），也写这份 SharedPreferences 种子。
// ---------------------------------------------------------------------------

/** 该族 SharedPreferences 表名（与 prefsShim.WEX_PREFS_NAME 同值，勿各自手拼） */
export const WEX_PREFS_NAME = 'NewWexFnw_preferences';

// ⚠ 2026-10-14 合并裁定：`WEX_PREF_KEYS` 只保留上面那一份（本仓的 properties 通道与上游的
//   seed 通道**共用同一张映射**）。自动合并时上游在下方又新增了一份同名导出 → 重复标识符，
//   已删除；两边内容完全一致（quark/uc/baidu 三键），改键名务必只改一处。

/**
 * 与凭据无关的**桌面环境键**（恒写入）：该族的默认多线程方式是 Go（`GoProxy.startServer`），
 * 而桌面端**没有 Go 代理**（初始化阶段被跳过）⇒ 走 Go 的原画线路必报
 * `[baidu](threadProxy) Go多线程启动失败`。这里强制切到 Java 多线程（配置中心里的
 * 「多线程代理 = Java多线程」等价物），是桌面端唯一能走通的模式。
 */
export const WEX_PREF_ENV: Record<string, string> = {
  'pan.thread_proxy_mode': 'java',
};

/**
 * UC TV Token（非会员 UC 原画）：该族的 UC 取流在 `MyPan$UcMineProvider.player()`
 *   按 `member_type` 分流——NORMAL（非高会）时读的是 **`Wex_ucpan_token`**（OAuth token 对 JSON），
 *   不是 cookie；缺它即报「非高会需要配置 UC TV Token，请到配置中心扫码获取」。
 *   `Wex_ucpan_device_id` 是配套的设备指纹（jar 缺省会自造 `md5(当前毫秒)`，我们写入保持一致）。
 *   键名取自 jar 字符串表（见 `ucTvToken.ts` 头注释）。
 */
export const UCTV_PREF_KEYS = {
  token: 'Wex_ucpan_token',
  deviceId: 'Wex_ucpan_device_id',
} as const;

/** UC TV Token 种子输入（来自 UcTvStore 的明文记录） */
export interface UcTvSeedInput {
  deviceId: string;
  token: string;
}

/** 种子文件路径 = `<沙箱>/shared_prefs/seed.txt`（与 prefsShim.PREFS_SEED_REL 同源） */
export function wexPrefsSeedPath(sandboxDir: string): string {
  return join(sandboxDir, 'shared_prefs', 'seed.txt');
}

/**
 * 全量同步该族 SharedPreferences 种子（第四通道）。
 * 无任何有效凭据时删除该文件（jar 侧读到空 = 未配置）。返回写入路径或 ''。
 * `ucTv` 非空时额外写入 UC TV Token 两键（非会员原画必需）。
 */
export function syncWexPrefsSeed(
  tokens: Record<string, string>,
  sandboxDir: string,
  ucTv?: UcTvSeedInput | null,
): string {
  const lines: string[] = [];
  // 种子是按行/按制表符切分的纯文本 ⇒ 值里不能出现 \r\n\t（cookie/JSON 实际不会，但仍防御一次）
  const clean = (v: unknown): string => (typeof v === 'string' ? v.replace(/[\r\n\t]/g, '').trim() : '');
  for (const [provider, key] of Object.entries(WEX_PREF_KEYS)) {
    const v = clean(tokens?.[provider]);
    if (v) lines.push(`${WEX_PREFS_NAME}\t${key}\t${v}`);
  }
  const tvToken = clean(ucTv?.token);
  const tvDevice = clean(ucTv?.deviceId);
  if (tvToken) {
    lines.push(`${WEX_PREFS_NAME}\t${UCTV_PREF_KEYS.token}\t${tvToken}`);
    if (tvDevice) lines.push(`${WEX_PREFS_NAME}\t${UCTV_PREF_KEYS.deviceId}\t${tvDevice}`);
  }
  for (const [key, v] of Object.entries(WEX_PREF_ENV)) lines.push(`${WEX_PREFS_NAME}\t${key}\t${v}`);
  const path = wexPrefsSeedPath(sandboxDir);
  if (!lines.length) {
    rmSync(path, { force: true });
    return '';
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, lines.join('\n') + '\n', 'utf-8');
  return path;
}

/**
 * 全量同步：把 tokens（DriveStore 明文列表）里所有有映射的 provider 落盘。
 * 返回实际写入的文件名列表（无变化/无映射的跳过）。
 */
export function syncPizazzCookieFiles(tokens: Record<string, string>, tmp = tmpdir()): string[] {
  const written: string[] = [];
  const normalized: Record<string, string> = {};
  for (const [rawProvider, rawValue] of Object.entries(tokens || {})) {
    const provider = rawProvider.trim().toLowerCase() === 'alipan' ? 'ali' : rawProvider.trim().toLowerCase();
    if (provider === 'ali') {
      // A present canonical `ali` key wins even when it is empty. This lets
      // an explicit unbind remove a legacy `alipan` file deterministically.
      if (rawProvider.trim().toLowerCase() === 'ali' || normalized[provider] === undefined) {
        normalized[provider] = typeof rawValue === 'string' ? rawValue : '';
      }
    } else if (typeof rawValue === 'string') {
      normalized[provider] = rawValue;
    }
  }
  // Iterate the known file set rather than the input object so removed or empty
  // credentials cannot leave a stale cookie that a jar treats as authenticated.
  for (const provider of [...new Set(Object.keys(PIZAZZ_COOKIE_FILES).map((p) => p === 'alipan' ? 'ali' : p))]) {
    const value = normalized[provider] || '';
    const path = value ? writePizazzCookieFile(provider, value, tmp) : '';
    if (path) written.push(path);
    if (!value) removePizazzCookieFile(provider, tmp);
  }
  return written;
}
