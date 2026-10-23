// tests/driveCookieFiles.spec.ts — 网盘凭据 → 某壳类源系 cookie 文件（通解）
// 关键契约：落点 <tmp>/tvbox-ext/TVBox/<盘>.txt（= 外部存储桩/TVBox），内容 {"cookie":"..."}；
// 缺失/为空时 jar 的 filterCloudDiskLinks 会把对应网盘链接降级丢弃 → 详情播放列表为空。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PIZAZZ_COOKIE_FILES,
  pizazzCookieDir,
  pizazzCookiePath,
  writePizazzCookieFile,
  readPizazzCookie,
  removePizazzCookieFile,
  syncPizazzCookieFiles,
  WEX_COOKIE_FILES,
  spiderSandboxDir,
  wexCookieDir,
  wexCookiePath,
  writeWexCookieFile,
  removeWexCookieFile,
  syncWexCookieFiles,
  WEX_PREF_KEYS,
  WEX_HOST_PREFS_FILE,
  wexHostPrefsPath,
  syncWexHostPrefs,
  removeWexHostPref,
  WEX_PREFS_NAME,
  wexPrefsSeedPath,
  syncWexPrefsSeed,
  UCTV_PREF_KEYS,
} from '../src/main/spider/driveCookieFiles';

let root = '';
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'winbox-pizazz-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('driveCookieFiles — 某壳类源系 cookie 文件同步', () => {
  it('目录与路径：<tmp>/tvbox-ext/TVBox/<file>（与 jar 外部存储桩拼接一致）', () => {
    expect(pizazzCookieDir(root)).toBe(join(root, 'tvbox-ext', 'TVBox'));
    expect(pizazzCookiePath('quark', root)).toBe(join(root, 'tvbox-ext', 'TVBox', 'quark_cookie.txt'));
    expect(pizazzCookiePath('uc', root)).toBe(join(root, 'tvbox-ext', 'TVBox', 'uc_cookie.txt'));
    expect(pizazzCookiePath('baidu', root)).toBe(join(root, 'tvbox-ext', 'TVBox', 'baidu.txt'));
    expect(pizazzCookiePath('unknown', root)).toBe(''); // 无映射
  });

  it('写入内容为 JSON：quark/uc 三键（cookie/member_type/nickname——xiaosa 登录判定要求），百度单键', () => {
    const ck = '__puus=PUUS1; __pus=PUS1; ck_id=abc';
    const path = writePizazzCookieFile('quark', ck, root);
    expect(path).toBe(pizazzCookiePath('quark', root));
    expect(existsSync(path)).toBe(true);
    const obj = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, string>;
    expect(obj.cookie).toBe(ck);
    // xiaosa 族（某第三方源）登录判定 = merge.i.d 三字段均非空（Gson: cookie/member_type/nickname）
    expect(obj.nickname).toBeTruthy();
    expect(obj.member_type).toBeTruthy();
    expect(readPizazzCookie('quark', root)).toBe(ck);
    // 百度（merge.b.j 只读 cookie 键，实测）→ 保持单键
    const bp = writePizazzCookieFile('baidu', 'BDUS=1', root);
    expect(JSON.parse(readFileSync(bp, 'utf-8'))).toEqual({ cookie: 'BDUS=1' });
  });

  it('quark 重写保留旧文件里的真实 nickname/member_type（jar 回写过的真值不覆盖）', () => {
    writePizazzCookieFile('quark', 'old', root); // 先落目录
    writeFileSync(
      pizazzCookiePath('quark', root),
      JSON.stringify({ cookie: 'old', nickname: '阿宅', member_type: '2' }),
      'utf-8',
    );
    writePizazzCookieFile('quark', 'new-ck', root);
    expect(JSON.parse(readFileSync(pizazzCookiePath('quark', root), 'utf-8'))).toEqual({
      cookie: 'new-ck',
      nickname: '阿宅',
      member_type: '2',
    });
  });

  it('去掉首尾空白；空值与无映射 provider 不落盘', () => {
    const p = writePizazzCookieFile('baidu', '  BDUS=1  ', root);
    expect(readPizazzCookie('baidu', root)).toBe('BDUS=1');
    expect(p).toBeTruthy();
    expect(writePizazzCookieFile('baidu', '   ', root)).toBe('');
    expect(writePizazzCookieFile('115', 'X', root)).toBe(''); // 该族无 115 文件
  });

  it('alipan 历史双键归一映射到 aliyun.txt；大小写不敏感', () => {
    expect(pizazzCookiePath('ALIPAN', root)).toBe(join(root, 'tvbox-ext', 'TVBox', 'aliyun.txt'));
    expect(pizazzCookiePath('Quark', root)).toBe(join(root, 'tvbox-ext', 'TVBox', 'quark_cookie.txt'));
  });

  it('全量同步：只写有映射且有值的 provider；解绑删除文件', () => {
    const written = syncPizazzCookieFiles({ quark: 'Q1', uc: 'U1', baidu: 'B1', '115': 'NOPE' }, root);
    expect(written.map((p) => p.split(/[\\/]/).pop()).sort()).toEqual(['baidu.txt', 'quark_cookie.txt', 'uc_cookie.txt']);
    expect(Object.keys(PIZAZZ_COOKIE_FILES)).toContain('baidu');
    removePizazzCookieFile('quark', root);
    expect(existsSync(pizazzCookiePath('quark', root))).toBe(false);
    expect(readPizazzCookie('quark', root)).toBe(''); // 已删 → 视为未配置
    removePizazzCookieFile('quark', root); // 再删不抛（force）
  });

  it('损坏文件读回为空（不抛）', () => {
    const path = pizazzCookiePath('baidu', root);
    writePizazzCookieFile('baidu', 'B1', root);
    writeFileSync(path, 'not-json', 'utf-8');
    expect(readPizazzCookie('baidu', root)).toBe('');
  });
});

describe('driveCookieFiles — 某壳源系（壳族变体）cookie 文件同步', () => {
  it('目录与路径：<沙箱>/files/TV/.quarkcookie（反编译 Quark.checkquarkcookie 实证）', () => {
    const sandbox = spiderSandboxDir(root);
    expect(sandbox).toBe(join(root, 'sandbox'));
    expect(wexCookieDir(sandbox)).toBe(join(root, 'sandbox', 'files', 'TV'));
    expect(wexCookiePath('quark', sandbox)).toBe(join(root, 'sandbox', 'files', 'TV', '.quarkcookie'));
    expect(wexCookiePath('uc', sandbox)).toBe(join(root, 'sandbox', 'files', 'TV', '.ucpancookie'));
    expect(wexCookiePath('baidu', sandbox)).toBe(''); // 该族无映射（百度无 checkXXXcookie）
    expect(Object.keys(WEX_COOKIE_FILES)).toEqual(['quark', 'uc']);
  });

  it('沙箱口径与 JarSpiderBridge 的 converted/../sandbox 等价（勿分别手拼）', () => {
    expect(spiderSandboxDir(root)).toBe(join(root, 'sandbox'));
    expect(join(root, 'converted', '..', 'sandbox')).toBe(join(root, 'sandbox')); // path 归一后同值
  });

  it('写入内容为**裸 cookie 串**（jar 侧直接 trim 使用，非 JSON）', () => {
    const ck = '__puus=PUUS1; __pus=PUS1; ck_id=abc';
    const path = writeWexCookieFile('quark', `  ${ck}  `, spiderSandboxDir(root));
    expect(path).toBe(wexCookiePath('quark', spiderSandboxDir(root)));
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, 'utf-8')).toBe(ck);
    expect(() => JSON.parse(readFileSync(path, 'utf-8'))).toThrow(); // 裸串不是 JSON
  });

  it('空值与无映射 provider 不落盘；大小写不敏感', () => {
    const sandbox = spiderSandboxDir(root);
    expect(writeWexCookieFile('quark', '   ', sandbox)).toBe('');
    expect(writeWexCookieFile('baidu', 'X', sandbox)).toBe('');
    expect(writeWexCookieFile('Quark', 'Q1', sandbox)).toBe(wexCookiePath('quark', sandbox));
  });

  it('全量同步与解绑删除（删除后 jar 读到空 = 未配置）', () => {
    const sandbox = spiderSandboxDir(root);
    const written = syncWexCookieFiles({ quark: 'Q1', uc: 'U1', baidu: 'B1' }, sandbox);
    expect(written.map((p) => p.split(/[\\/]/).pop()).sort()).toEqual(['.quarkcookie', '.ucpancookie']);
    removeWexCookieFile('quark', sandbox);
    expect(existsSync(wexCookiePath('quark', sandbox))).toBe(false);
    removeWexCookieFile('quark', sandbox); // 再删不抛（force）
  });

  it('全量同步会清理已移除的旧 cookie', () => {
    const sandbox = spiderSandboxDir(root);
    writeWexCookieFile('uc', 'OLD', sandbox);
    expect(existsSync(wexCookiePath('uc', sandbox))).toBe(true);
    syncWexCookieFiles({}, sandbox);
    expect(existsSync(wexCookiePath('uc', sandbox))).toBe(false);
  });
});

// ★ 2026-10-13：AiWex 系（新光影 / AiPan1Me / 玩偶 / 木偶 / AiNewWoNiu4K …）
//   这版壳**不读** `files/TV/.quarkcookie`（全库 grep `quarkcookie` 零命中），
//   它读的是 SharedPreferences `NewWexFnw_preferences` 里的 `Wex_*_cookie`。
//   用户侧症状：明明绑过夸克，源却报「还没有配置夸克 Cookie」。
describe('driveCookieFiles — AiWex 系 SharedPreferences 默认值同步（2026-10-13）', () => {
  const CK = '__pus=a859a0db7e4db42+9/792f0ea27c350cd6AAQXs+TbjYfy1bwajUwawR; __uid=AAQzt2PXGWDJGkk/g/4pC0iS; __puus=831fa3b6==';

  it('落点：<沙箱>/shared_prefs/winbox-host-prefs.properties（桩侧按同名常量读）', () => {
    const sandbox = spiderSandboxDir(root);
    expect(wexHostPrefsPath(sandbox)).toBe(join(root, 'sandbox', 'shared_prefs', WEX_HOST_PREFS_FILE));
    // 键名是壳里反编译出来的常量，改了这族源就全认不到
    expect(WEX_PREF_KEYS).toEqual({
      quark: 'Wex_quark_cookie',
      uc: 'Wex_ucpan_cookie',
      baidu: 'Wex_baidu_cookie',
    });
  });

  it('按 `key=value` 逐行写；cookie 里的 = ; + / 原样保留（桩侧只按第一个 = 切一刀）', () => {
    const sandbox = spiderSandboxDir(root);
    const keys = syncWexHostPrefs({ quark: CK, uc: 'U1', baidu: 'B1' }, sandbox);
    expect(keys.sort()).toEqual(['Wex_baidu_cookie', 'Wex_quark_cookie', 'Wex_ucpan_cookie']);
    const text = readFileSync(wexHostPrefsPath(sandbox), 'utf-8');
    const line = text.split('\n').find((l) => l.startsWith('Wex_quark_cookie='))!;
    expect(line).toBe(`Wex_quark_cookie=${CK}`);
  });

  it('空值/无映射 provider 跳过；大小写不敏感', () => {
    const sandbox = spiderSandboxDir(root);
    expect(syncWexHostPrefs({ quark: '  ', alipan: 'A1', UC: 'U2' }, sandbox)).toEqual(['Wex_ucpan_cookie']);
    expect(existsSync(wexCookiePath('quark', sandbox))).toBe(false); // 不该顺手写 wex 旧通道
  });

  it('值里的换行必须压平 —— 否则 properties 行解析会把一行拆成两行', () => {
    const sandbox = spiderSandboxDir(root);
    syncWexHostPrefs({ quark: 'A\r\nB' }, sandbox);
    const text = readFileSync(wexHostPrefsPath(sandbox), 'utf-8');
    // ⚠ 2026-10-14 合并裁定：桌面环境键（pan.thread_proxy_mode）恒写入 → 这里只看凭据行
    const cookieLines = text.trim().split('\n').filter((l) => l.startsWith('Wex_'));
    expect(cookieLines).toHaveLength(1);
    expect(cookieLines[0]).toBe('Wex_quark_cookie=A B');
  });

  it('解绑只摘掉那一个键，其它绑定不受影响', () => {
    const sandbox = spiderSandboxDir(root);
    syncWexHostPrefs({ quark: 'Q1', uc: 'U1', baidu: 'B1' }, sandbox);
    removeWexHostPref('quark', sandbox);
    const text = readFileSync(wexHostPrefsPath(sandbox), 'utf-8');
    expect(text).not.toContain('Wex_quark_cookie');
    expect(text).toContain('Wex_ucpan_cookie=U1');
    expect(text).toContain('Wex_baidu_cookie=B1');
    removeWexHostPref('quark', sandbox); // 幂等
  });

  it('★ 全部解绑后不再留任何凭据键 —— 否则桩侧继续兜底，解绑不生效', () => {
    const sandbox = spiderSandboxDir(root);
    syncWexHostPrefs({ quark: 'Q1', uc: 'U1' }, sandbox);
    removeWexHostPref('quark', sandbox);
    removeWexHostPref('uc', sandbox);
    // ⚠ 2026-10-14 合并裁定：桌面环境键恒写入 → 文件不再为空，但**不能**再含任何 `Wex_*` 凭据键
    expect(readFileSync(wexHostPrefsPath(sandbox), 'utf-8')).not.toContain('Wex_');
    // 再同步一次（tokens 为空）也必须清掉旧凭据，而不是留着旧内容
    expect(syncWexHostPrefs({}, sandbox)).toEqual([]);
    expect(readFileSync(wexHostPrefsPath(sandbox), 'utf-8')).not.toContain('Wex_');
  });

  it('★ 内容没变就不重写 —— 桩侧按 mtime 裁定谁更新，每次启动都刷 mtime 会让宿主恒赢', () => {
    const sandbox = spiderSandboxDir(root);
    const path = wexHostPrefsPath(sandbox);
    const old = new Date('2020-01-01');
    syncWexHostPrefs({ quark: 'Q1' }, sandbox);
    utimesSync(path, old, old);
    syncWexHostPrefs({ quark: 'Q1' }, sandbox); // 同内容 → 不动文件
    expect(statSync(path).mtimeMs).toBe(old.getTime());
    syncWexHostPrefs({ quark: 'Q2' }, sandbox); // 内容变了 → 才刷新 mtime
    expect(statSync(path).mtimeMs).toBeGreaterThan(old.getTime());
    expect(readFileSync(path, 'utf-8')).toContain('Wex_quark_cookie=Q2');
  });

  it('解绑未绑定的 provider / 文件不存在：不抛也不创建', () => {
    const sandbox = spiderSandboxDir(root);
    expect(() => removeWexHostPref('quark', sandbox)).not.toThrow();
    expect(() => removeWexHostPref('alipan', sandbox)).not.toThrow();
    expect(existsSync(wexHostPrefsPath(sandbox))).toBe(false);
  });

  // ★ 2026-10-14 合并裁定（上游 1.21.4）：本段（properties 通道）与下方上游的 seed 通道**并存**。
  //   本仓以 properties 为准（本仓的桩是真实实现，会读它，见 JarSpiderBridge.classpathJars 注释），
  //   seed.txt 仍照写、以备将来切换到上游的 prefs 影子 jar。
});

describe('driveCookieFiles — 某壳源 SharedPreferences 种子（第四通道 + UC TV Token）', () => {
  const readSeed = (sandbox: string): Record<string, string> => {
    const path = wexPrefsSeedPath(sandbox);
    const kv: Record<string, string> = {};
    for (const line of readFileSync(path, 'utf-8').trim().split('\n')) {
      const [name, key, value] = line.split('\t');
      expect(name).toBe(WEX_PREFS_NAME); // 每行都是「表名 \t 键 \t 值」
      kv[key] = value;
    }
    return kv;
  };

  it('写入 cookie 三键 + 环境键；ucTv 非空时追加 Wex_ucpan_token / Wex_ucpan_device_id', () => {
    const sandbox = spiderSandboxDir(root);
    const tvJson = '{"code":200,"data":{"access_token":"AT","refresh_token":"RT"}}';
    const p = syncWexPrefsSeed({ uc: 'UC_CK', quark: 'Q_CK', baidu: 'B_CK' }, sandbox, { deviceId: 'dev1', token: tvJson });
    expect(p).toBe(wexPrefsSeedPath(sandbox));
    const kv = readSeed(sandbox);
    expect(kv['Wex_ucpan_cookie']).toBe('UC_CK');
    expect(kv['Wex_quark_cookie']).toBe('Q_CK');
    expect(kv['Wex_baidu_cookie']).toBe('B_CK');
    expect(kv[UCTV_PREF_KEYS.token]).toBe(tvJson);
    expect(kv[UCTV_PREF_KEYS.deviceId]).toBe('dev1');
    expect(kv['pan.thread_proxy_mode']).toBe('java');
  });

  it('ucTv 为空/无值时这两键消失（重写种子即生效，避免残留旧 token）', () => {
    const sandbox = spiderSandboxDir(root);
    syncWexPrefsSeed({ uc: 'UC_CK' }, sandbox, { deviceId: 'dev1', token: 'TOK' });
    expect(readSeed(sandbox)['Wex_ucpan_token']).toBe('TOK');
    syncWexPrefsSeed({ uc: 'UC_CK' }, sandbox);
    expect(readSeed(sandbox)['Wex_ucpan_token']).toBeUndefined();
  });

  it('值里的 \\r\\n\\t 会被剔除（种子是按行/制表符切分的纯文本）', () => {
    const sandbox = spiderSandboxDir(root);
    syncWexPrefsSeed({ uc: 'U\nC' }, sandbox, { deviceId: 'd\te', token: '{"a":\n1}' });
    const kv = readSeed(sandbox);
    expect(kv['Wex_ucpan_cookie']).toBe('UC');
    expect(kv['Wex_ucpan_token']).toBe('{"a":1}');
    expect(kv['Wex_ucpan_device_id']).toBe('de');
  });
});
