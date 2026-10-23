// tests/nativeBridge.spec.ts — ARM 原生桥（unidbg）在 JarSpiderBridge 侧的行为
//   ① 未配置 nativeRuntimeDir → 不注入任何原生桥参数（普通源 argv 与历史完全一致）；
//   ② 配置了目录 + jar 内含 .so + 运行时齐备 → classpath 拼上 [native-bridge.jar, ...运行时 jar]
//      并透传 -Dtvbox.native.work / -Dtvbox.native.patch；
//   ③ 配置了目录但 jar 内无 .so → 不启用（不做任何下载/注入）；
// ④ 守卫壳「内层蜘蛛为空」NPE → 自动改走 shell-shim 真实实现重试（第二次 argv 不带原生桥）。
// 只 mock child_process.spawn（不触网、不跑真 JVM），断言 argv/classpath 形状。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { JarSpiderBridge, extractBridgeNotes, isGuardInnerSpiderNull } from '../src/engine/spider/JarSpiderBridge';
import { NullLogger } from '../src/engine/util/logger';
import { buildZip } from '../src/engine/util/syncZip';
import { nativeFixture } from './fixtures/nativeClass';

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ spawn: spawnMock }));

function fakeChild(): EventEmitter & { stdout: EventEmitter; stderr: EventEmitter } {
  const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

function classpathOf(argv: string[]): string {
  const i = argv.indexOf('-cp');
  expect(i).toBeGreaterThanOrEqual(0);
  return argv[i + 1];
}

/** 造临时 jvmDir（含 java.exe / libs / stubs / native-bridge.jar 桩）与原生运行时目录 */
function makeBridge(opts: { nativeRuntimeDir?: string; omitBridgeJar?: boolean; logs?: string[] }): { bridge: JarSpiderBridge; dir: string } {
  const dir = join(tmpdir(), `tvm-native-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  mkdirSync(join(dir, 'jre', 'bin'), { recursive: true });
  writeFileSync(join(dir, 'jre', 'bin', 'java.exe'), 'stub');
  mkdirSync(join(dir, 'libs'), { recursive: true });
  mkdirSync(join(dir, 'stubs'), { recursive: true });
  mkdirSync(join(dir, 'native-bridge'), { recursive: true });
  if (!opts.omitBridgeJar) writeFileSync(join(dir, 'native-bridge', 'native-bridge.jar'), 'stub-bridge');
  const bridge = new JarSpiderBridge(
    { jvmDir: dir, cacheDir: join(dir, 'cache'), nativeRuntimeDir: opts.nativeRuntimeDir },
    {
      http: {},
      kv: {},
      logger: opts.logs
        ? {
          i: (m: string) => opts.logs!.push(m),
          w: (m: string) => opts.logs!.push(m),
          e: () => undefined,
          d: () => undefined,
        }
        : NullLogger,
    } as never,
  );
  return { bridge, dir };
}

/** 预置「运行时已就绪」的桩（体积必须 > 4096B，否则会被判为下载残骸） */
function seedNativeRuntime(root: string): void {
  const ver = join(root, 'unidbg-0.9.9');
  mkdirSync(ver, { recursive: true });
  const names = [
    'unidbg-android-0.9.9.jar', 'unidbg-api-0.9.9.jar', 'unidbg-unicorn2-0.9.9.jar', 'unidbg-dynarmic-0.9.9.jar',
    'unicorn-1.0.15.jar',
    'capstone-3.1.8.jar', 'keystone-0.9.7.jar', 'demumble-1.0.4.jar', 'commons-codec-1.21.0.jar',
    'commons-collections4-4.5.0.jar', 'commons-io-2.21.0.jar', 'fastjson-1.2.83.jar', 'apk-parser-2.6.10.jar',
    'jna-5.10.0.jar', 'native-lib-loader-2.3.5.jar', 'slf4j-api-2.0.16.jar', 'slf4j-simple-2.0.16.jar',
    'asm-9.7.jar',
  ];
  for (const n of names) writeFileSync(join(ver, n), Buffer.alloc(5000));
}

describe('JarSpiderBridge.call — ARM 原生桥接入', () => {
  let dirs: string[] = [];

  beforeEach(() => {
    spawnMock.mockReset();
    spawnMock.mockImplementation(() => fakeChild());
  });
  afterEach(() => {
    for (const d of dirs) {
      try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    dirs = [];
  });

  it('未配置 nativeRuntimeDir → 不注入原生桥参数', async () => {
    const { bridge, dir } = makeBridge({});
    dirs.push(dir);
    const jar = join(dir, 'a.jar');
    writeFileSync(jar, buildZip([{ name: 'assets/FishGuard-v8.so', bytes: Buffer.from([0x7f, 0x45, 0x4c, 0x46]) }]));

    const p = bridge.call([jar], 'X', 'm', []);
    const child = spawnMock.mock.results[0].value as ReturnType<typeof fakeChild>;
    child.emit('close', 0);
    await p;

    const argv = spawnMock.mock.calls[0][1] as string[];
    expect(argv.some((a) => a.startsWith('-Dtvbox.native.work='))).toBe(false);
    expect(argv.some((a) => a.startsWith('-Dtvbox.native.patch='))).toBe(false);
    expect(classpathOf(argv)).not.toContain('native-bridge.jar');
  });

  it('目录已配置 + jar 含 .so + 运行时齐备 → cp 含桥与运行时，argv 透传工作目录', async () => {
    const rt = join(tmpdir(), `tvm-native-rt-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
    mkdirSync(rt, { recursive: true });
    dirs.push(rt);
    seedNativeRuntime(rt);
    const { bridge, dir } = makeBridge({ nativeRuntimeDir: rt });
    dirs.push(dir);
    const jar = join(dir, 'b.jar');
    writeFileSync(jar, buildZip([{ name: 'assets/FishGuard-v8.so', bytes: Buffer.from([0x7f, 0x45, 0x4c, 0x46]) }]));

    const p = bridge.call([jar], 'X', 'm', []);
    // 走原生桥时会先 await 运行时准备（异步），断言前需等 spawn 真正发生
    for (let i = 0; i < 100 && spawnMock.mock.results.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    const child = spawnMock.mock.results[0].value as ReturnType<typeof fakeChild>;
    child.emit('close', 0);
    await p;

    const argv = spawnMock.mock.calls[0][1] as string[];
    expect(argv).toContain(`-Dtvbox.native.work=${join(rt, 'work')}`);
    expect(argv).toContain(`-Dtvbox.native.patch=${join(rt, 'patched')}`);
    const cp = classpathOf(argv);
    expect(cp).toContain(join(dir, 'native-bridge', 'native-bridge.jar'));
    expect(cp).toContain(join(rt, 'unidbg-0.9.9', 'unidbg-android-0.9.9.jar'));
    // 某加固壳性能专项：dynarmic 是桥的默认后端，运行时必须带上它（否则回退 Unicorn2 → 慢 15~20 倍）
    expect(cp).toContain(join(rt, 'unidbg-0.9.9', 'unidbg-dynarmic-0.9.9.jar'));
    expect(cp).toContain(join(rt, 'unidbg-0.9.9', 'asm-9.7.jar'));
  });

  it('目录已配置但 jar 无 .so → 不注入（保持普通源行为）', async () => {
    const rt = join(tmpdir(), `tvm-native-rt2-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
    mkdirSync(rt, { recursive: true });
    dirs.push(rt);
    seedNativeRuntime(rt);
    const { bridge, dir } = makeBridge({ nativeRuntimeDir: rt });
    dirs.push(dir);
    const jar = join(dir, 'c.jar');
    writeFileSync(jar, buildZip([{ name: 'classes.dex', bytes: Buffer.from('x') }]));

    const p = bridge.call([jar], 'X', 'm', []);
    const child = spawnMock.mock.results[0].value as ReturnType<typeof fakeChild>;
    child.emit('close', 0);
    await p;

    const argv = spawnMock.mock.calls[0][1] as string[];
    expect(argv.some((a) => a.startsWith('-Dtvbox.native.'))).toBe(false);
    expect(classpathOf(argv)).not.toContain('native-bridge.jar');
  });

  it('嗷呜同款：外层无 .so，但含 native 方法 → 启用动态库桥接', async () => {
    const rt = join(tmpdir(), `tvm-native-dynamic-${Date.now()}`);
    dirs.push(rt); seedNativeRuntime(rt);
    const { bridge, dir } = makeBridge({ nativeRuntimeDir: rt }); dirs.push(dir);
    const jar = join(dir, 'dynamic.jar');
    writeFileSync(jar, buildZip([{ name: 'fixture/Probe.class', bytes: nativeFixture() }]));
    const p = bridge.call([jar], 'fixture.Probe', 'method', []);
    for (let i = 0; i < 100 && !spawnMock.mock.results.length; i++) await new Promise(r => setTimeout(r, 5));
    expect(spawnMock.mock.results.length).toBe(1);
    (spawnMock.mock.results[0].value as ReturnType<typeof fakeChild>).emit('close', 0);
    await p;
    const argv = spawnMock.mock.calls[0][1] as string[];
    expect(argv).toContain(`-Dtvbox.native.work=${join(rt, 'work')}`);
    expect(classpathOf(argv)).toContain('native-bridge.jar');
  });
});

// ── ★ 2026-10-14：缺原生桥 jar 时不再「静默退化」 ──
//   背景：`nativeNeeded()` 原先见不到 native-bridge.jar 就静默 return false，一行日志都不打。
//   mac 上从零 clone 的仓库正是这个状态（jar 不入库 + 唯一构建脚本是 PowerShell 的 build.ps1），
//   用户看到的是 translateSpiderLog 把 UnsatisfiedLinkError 翻成的
//   「该源依赖安卓原生库（.so），桌面版无法加载（架构限制，非移植缺陷）」—— 误导为「AI/架构问题」。
describe('JarSpiderBridge.call — 原生桥 jar 缺失必须可见', () => {
  let dirs: string[] = [];

  beforeEach(() => {
    spawnMock.mockReset();
    spawnMock.mockImplementation(() => fakeChild());
  });
  afterEach(() => {
    for (const d of dirs) {
      try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    dirs = [];
  });

  it('jar 含 .so 但缺 native-bridge.jar → 不注入参数，并给出可定位的 warn（只打一次）', async () => {
    const rt = join(tmpdir(), `tvm-native-rt-missing-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
    mkdirSync(rt, { recursive: true });
    dirs.push(rt);
    seedNativeRuntime(rt);
    const logs: string[] = [];
    const { bridge, dir } = makeBridge({ nativeRuntimeDir: rt, omitBridgeJar: true, logs });
    dirs.push(dir);
    const jar = join(dir, 'guard.jar');
    writeFileSync(jar, buildZip([{ name: 'assets/FishGuard-v8.so', bytes: Buffer.from([0x7f, 0x45, 0x4c, 0x46]) }]));

    const p1 = bridge.call([jar], 'X', 'm', []);
    const c1 = spawnMock.mock.results[0].value as ReturnType<typeof fakeChild>;
    c1.emit('close', 0);
    await p1;

    // 行为不变：无桥就不注入任何原生参数（与「配置了目录但缺 jar」历史行为一致）
    const argv = spawnMock.mock.calls[0][1] as string[];
    expect(argv.some((a) => a.startsWith('-Dtvbox.native.'))).toBe(false);
    expect(classpathOf(argv)).not.toContain('native-bridge.jar');

    // 但必须留下可行动的线索
    const warns = logs.filter((m) => m.includes('原生桥实现缺失'));
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('build-native-bridge.mjs');       // 给出重建命令
    expect(warns[0]).toContain('不是源的问题，也不是架构限制');   // 与 translateSpiderLog 的误导文案明确切割

    // 第二个同类源不重复刷屏
    const p2 = bridge.call([jar], 'X', 'm', []);
    const c2 = spawnMock.mock.results[1].value as ReturnType<typeof fakeChild>;
    c2.emit('close', 0);
    await p2;
    expect(logs.filter((m) => m.includes('原生桥实现缺失'))).toHaveLength(1);
  });

  it('普通源（无 .so / 无 native 方法）缺桥 → 不告警（不误报）', async () => {
    const rt = join(tmpdir(), `tvm-native-rt-missing2-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
    mkdirSync(rt, { recursive: true });
    dirs.push(rt);
    seedNativeRuntime(rt);
    const logs: string[] = [];
    const { bridge, dir } = makeBridge({ nativeRuntimeDir: rt, omitBridgeJar: true, logs });
    dirs.push(dir);
    const jar = join(dir, 'plain.jar');
    writeFileSync(jar, buildZip([{ name: 'classes.dex', bytes: Buffer.from('x') }]));

    const p = bridge.call([jar], 'X', 'm', []);
    const c = spawnMock.mock.results[0].value as ReturnType<typeof fakeChild>;
    c.emit('close', 0);
    await p;

    expect(logs.filter((m) => m.includes('原生桥实现缺失'))).toHaveLength(0);
  });
});

// ── 守卫空 NPE 兜底：原生路线失败 → 自动改走 shell-shim 真实实现 ──
describe('JarSpiderBridge.call — 守卫内层蜘蛛为空 → shell-shim 兜底', () => {
  let dirs: string[] = [];

  beforeEach(() => {
    spawnMock.mockReset();
    spawnMock.mockImplementation(() => fakeChild());
  });
  afterEach(() => {
    for (const d of dirs) {
      try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    dirs = [];
  });

  /** 轮询等第 n 次 spawn 发生（原生桥/重试路径含 await，spawn 不在同一微任务里） */
  async function waitSpawn(n: number): Promise<void> {
    for (let i = 0; i < 200 && spawnMock.mock.results.length < n; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(spawnMock.mock.results.length).toBeGreaterThanOrEqual(n);
  }

  it('原生路线报「Spider.init(…, String) … is null」→ 用 shell-shim 路线重试一次（argv 不再带原生桥）', async () => {
    const rt = join(tmpdir(), `tvm-native-rt3-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
    mkdirSync(rt, { recursive: true });
    dirs.push(rt);
    seedNativeRuntime(rt);
    const { bridge, dir } = makeBridge({ nativeRuntimeDir: rt });
    dirs.push(dir);
    writeFileSync(join(dir, 'stubs', 'shell-shim.jar'), 'stub-shim');
    // 壳 jar：含 .so（触发原生桥）+ assets/某壳产物.guard（触发 shell-shim 自动适配）
    const jar = join(dir, 'guard.jar');
    writeFileSync(jar, buildZip([
      { name: 'assets/FishGuard-v8.so', bytes: Buffer.from([0x7f, 0x45, 0x4c, 0x46]) },
      { name: 'assets/ftyshinidie.guard', bytes: Buffer.from('x') },
    ]));
    const realJar = join(dir, 'shell-shim', 'real', 'ftyshinidie.jar');
    mkdirSync(join(dir, 'shell-shim', 'real'), { recursive: true });
    writeFileSync(realJar, 'stub-real');

    const p = bridge.call([jar], 'com.github.catvod.spider.DouDouGuard', 'homeContent', ['']);
    await waitSpawn(1);
    const argv1 = spawnMock.mock.calls[0][1] as string[];
    // 第一次：原生路线（带 native props）+ 已透传 shell-shim 真实实现
    expect(argv1.some((a) => a.startsWith('-Dtvbox.native.work='))).toBe(true);
    expect(argv1).toContain(`-Dtvbox.shellShimClasses=${realJar}`);

    // 设备同款失败：守卫字段为 null（真实报错会截断，这里给完整形态）
    const c1 = spawnMock.mock.results[0].value as ReturnType<typeof fakeChild>;
    c1.stderr.emit('data', Buffer.from(
      '[android.Log.D] SpiderLog: java.lang.NullPointerException: Cannot invoke "com.github.catvod.crawler.Spider.init(android.content.Context, String)" because "this.oOoOoOoOoOoOoO0o" is null\n',
    ));
    c1.emit('close', 0);

    // 第二次：shell-shim 路线 —— 不带 -Dtvbox.native.*（改写产物目录不再抢在 shell-shim.jar 之前）
    await waitSpawn(2);
    const argv2 = spawnMock.mock.calls[1][1] as string[];
    expect(argv2.some((a) => a.startsWith('-Dtvbox.native.'))).toBe(false);
    expect(argv2).toContain(`-Dtvbox.shellShimClasses=${realJar}`);
    const i = argv2.indexOf('SpiderRunner');
    expect(argv2[i + 1].split(';')[0]).toBe(join(dir, 'stubs', 'shell-shim.jar'));

    const c2 = spawnMock.mock.results[1].value as ReturnType<typeof fakeChild>;
    c2.stdout.emit('data', Buffer.from('{"list":[1]}'));
    c2.emit('close', 0);
    expect(await p).toContain('{"list":[1]}');
  });

  it('该 jar 无内置真实实现 → 不做兜底重试（只 spawn 一次）', async () => {
    const { bridge, dir } = makeBridge({});
    dirs.push(dir);
    const jar = join(dir, 'noshell.jar');
    writeFileSync(jar, buildZip([{ name: 'classes.dex', bytes: Buffer.from('x') }]));

    const p = bridge.call([jar], 'com.github.catvod.spider.DouDouGuard', 'homeContent', ['']);
    await waitSpawn(1);
    const c1 = spawnMock.mock.results[0].value as ReturnType<typeof fakeChild>;
    c1.stderr.emit('data', Buffer.from(
      '[android.Log.D] SpiderLog: java.lang.NullPointerException: Cannot invoke "com.github.catvod.crawler.Spider.init(android.content.Context, String)" because "this.oOoOoOoOoOoOoO0o" is null\n',
    ));
    c1.emit('close', 0);
    await p;
    await new Promise((r) => setTimeout(r, 30));
    expect(spawnMock.mock.results.length).toBe(1);
    expect(isGuardInnerSpiderNull(bridge.lastReason)).toBe(true);
  });
});

// ── 桥消息可见化（extractBridgeNotes）：桥的成败只在子进程 stderr 上，需上屏才能排障 ──
describe('extractBridgeNotes — 原生桥消息抽取', () => {
  it('抽出桥自身与运行器转发的桥行（其余噪声丢弃）', () => {
    const stderr = [
      'OpenJDK 64-Bit Server VM warning: Options -Xverify:none ...',
      '[native-bridge] 准备失败，按无原生桥降级: java.lang.reflect.InvocationTargetException',
      '[SpiderRunner] 原生桥就绪：ftyguard_v8.so (102440B, 64 位)，注册 native 8 个',
      '[SpiderRunner]   - com/github/catvod/spider/DexNative — 改写 8 个方法',
      '[android.Log.E] SpiderLog: Connect timed out :: java.net.SocketTimeoutException',
    ].join('\n');
    const notes = extractBridgeNotes(stderr);
    expect(notes).toHaveLength(3);
    expect(notes[0]).toContain('准备失败');
    expect(notes[1]).toContain('原生桥就绪');
  });

  it('无关内容 / 空串 → 空数组（不误报）', () => {
    expect(extractBridgeNotes('')).toEqual([]);
    expect(extractBridgeNotes('[SpiderRunner.ERROR] java.lang.ClassNotFoundException: android.database.Cursor')).toEqual([]);
  });

  it('真正的桥失败行会被判定为 warn 级（文案含「失败/降级」）', () => {
    const notes = extractBridgeNotes('[native-bridge] 原 .so 被其它进程映射，改用内容寻址副本: x.so');
    expect(notes).toHaveLength(1);
    expect(/失败|降级|不可用/.test(notes[0])).toBe(false);
    expect(/失败|降级|不可用/.test(extractBridgeNotes('[native-bridge] 准备失败，按无原生桥降级: x')[0])).toBe(true);
  });

  // shell-shim 影子类的说话行要能上屏（此前只在 debug 开关下打印，设备侧「守卫空 NPE」零线索）
  it('抽出 shell-shim 影子行（getSpider 无真实实现可加载 → 返回 null）', () => {
    const notes = extractBridgeNotes('[ShellShim] getSpider(com.github.catvod.spider.DouDouGuard) 无真实实现可加载 → 返回 null');
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('无真实实现可加载');
  });

  // （孤儿端口排查）：.8 的 [baidu-state] 探针与 [host-proxy] 说话行必须能上屏 ——
  //   此前不在白名单，serve 进程 stderr 里被静默丢弃（真机「无探针输出」的真因，
  //   本地直跑 stubs.jar 看得到、经桥看不到，日志因此误判为孤儿 JVM）。
  it('抽出 baidu-state 探针与 host-proxy 行（探针可见性）', () => {
    const notes = extractBridgeNotes(
      '[baidu-state] shareFsIdMap=n=16 {1a6ELVSV…→3个fsid} bdclndMap=keys=[] ukMap=keys=[] cookie=len:1239',
    );
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('shareFsIdMap');
    const hp = extractBridgeNotes('[host-proxy] 预启动失败: java.net.BindException: Address already in use');
    expect(hp).toHaveLength(1);
    expect(hp[0]).toContain('预启动失败');
  });
});

// ── 守卫空 NPE 判据（原因上屏会截断到 120 字符，判据只取方法签名） ──
describe('isGuardInnerSpiderNull — 失败原因判据', () => {
  it('命中：原始 NPE 与截断后的 120 字符文本、以及翻译后的中文原因', () => {
    const raw = 'java.lang.NullPointerException: Cannot invoke "com.github.catvod.crawler.Spider.init(android.content.Context, String)" because "this.oOoOoOoOoOoOoO0o" is null';
    expect(isGuardInnerSpiderNull(raw)).toBe(true);
    expect(isGuardInnerSpiderNull(raw.slice(0, 120))).toBe(true);
    expect(isGuardInnerSpiderNull('蜘蛛运行器异常：' + raw.slice(0, 120))).toBe(true);
    expect(isGuardInnerSpiderNull('加固壳内部蜘蛛未就绪（原生解密未产出加载器）—— 已自动改用内置真实实现')).toBe(true);
  });

  it('不命中：其它 NPE / 普通失败原因（不误触发兜底重试）', () => {
    expect(isGuardInnerSpiderNull('')).toBe(false);
    expect(isGuardInnerSpiderNull('java.lang.NullPointerException: Cannot invoke "String.length()" because "<parameter1>" is null')).toBe(false);
    expect(isGuardInnerSpiderNull('蜘蛛调用超时（>10s），源站可能无响应')).toBe(false);
    expect(isGuardInnerSpiderNull('ClassNotFoundException: com.github.catvod.spider.Xxx')).toBe(false);
  });
});
