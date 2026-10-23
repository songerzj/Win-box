// tests/pythonRuntime.spec.ts — 嵌入式 CPython 运行时（JarSpiderBridge.callPython）适配层单测
// 不触网、不跑真 python.exe：http 用桩返回 embed zip / wheel zip 字节，spawn 用 mock。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { JarSpiderBridge } from '../src/engine/spider/JarSpiderBridge';
import { buildZip } from '../src/engine/util/syncZip';

type SpawnCall = { exe: string; argv: string[]; opts: { env?: Record<string, string> } };

// spawn 桩：捕获 (exe, argv, opts)，返回 EventEmitter 子进程（close(0) 收尾）
const spawnMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ spawn: spawnMock, execFileSync: vi.fn() }));

function fakeChild(): EventEmitter {
  const c = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
  c.stdout = new EventEmitter();
  c.stderr = new EventEmitter();
  setTimeout(() => c.emit('close', 0, null), 0);
  return c;
}

function makeJvmDir(): string {
  const dir = join(tmpdir(), `tvm-py-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  // runner 随包资源（bridge.placeRunnerFiles 从 jvmDir/python-runner 拷贝）
  mkdirSync(join(dir, 'python-runner', 'base'), { recursive: true });
  writeFileSync(join(dir, 'python-runner', 'runner.py'), 'print("runner")');
  writeFileSync(join(dir, 'python-runner', 'base', 'spider.py'), 'class Spider: pass');
  return dir;
}

/** 构造假 embed zip：python.exe + python311._pth（填充到 >1MB 穿过"内容过小"防护） */
function fakeEmbedZip(): Buffer {
  return buildZip([
    { name: 'python.exe', bytes: Buffer.concat([Buffer.from('MZ-stub-python'), Buffer.alloc(1_200_000)]) },
    { name: 'python311._pth', bytes: Buffer.from('python311.zip\n.\nLib\n') },
  ]);
}

/** 构造假 wheel zip（顶层目录 = 包名，>1024B 穿过"内容过小"防护） */
function fakeWheel(pkg: string): Buffer {
  return buildZip([
    { name: `${pkg}/__init__.py`, bytes: Buffer.concat([Buffer.from(`# ${pkg}`), Buffer.alloc(4096)]) },
  ]);
}

const dirs: string[] = [];
function tmpCache(): { jvmDir: string; pyDir: string } {
  const jvmDir = makeJvmDir();
  dirs.push(jvmDir);
  const pyDir = join(jvmDir, 'py');
  dirs.push(pyDir);
  return { jvmDir, pyDir };
}
afterEach(() => {
  for (const d of dirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  dirs.length = 0;
  spawnMock.mockReset();
});

const WHEEL_DB: Array<[string, string]> = [
  ['lxml', 'lxml-4.9.2-cp311-cp311-win_amd64.whl'],
  ['requests', 'requests-2.31.0-py3-none-any.whl'],
  ['urllib3', 'urllib3-1.26.18-py2.py3-none-any.whl'],
  ['certifi', 'certifi-2026.7.22-py3-none-any.whl'],
  ['charset_normalizer', 'charset_normalizer-3.2.0-py3-none-any.whl'],
  ['idna', 'idna-3.4-py3-none-any.whl'],
];

function makeHost(embed: Buffer) {
  return {
    http: {
      request: vi.fn(async (_req: { url: string }) => {
        const u = String((_req as { url: string }).url || '');
        // 宿主 HttpClient buffer:2 返回 base64 字符串（与 jarBridgeCacheDir.spec 同款约定）
        const b64 = (b: Buffer) => b.toString('base64');
        if (u.includes('embed-amd64')) return { status: 200, headers: {}, content: b64(embed), finalUrl: '' };
        if (u.includes('/simple/')) {
          // PEP 503 索引页：模拟 `../../packages/<pkg>/<file>` 相对 href（对齐真实镜像结构）
          const pkg = u.split('/simple/')[1]?.replace(/\/$/, '');
          const hit = WHEEL_DB.find(([n]) => n === pkg);
          const href = hit
            ? `../../packages/web/${hit[1]}`
            : '';
          return { status: 200, headers: {}, content: b64(Buffer.from(`<html><a href="${href}">${hit ? hit[1] : ''}</a></html>`)), finalUrl: '' };
        }
        // wheel 真实地址：URL 含 /packages/web/<file>
        const file = u.split('/web/')[1] || '';
        const hit = WHEEL_DB.find(([, f]) => f === file);
        const pkg = hit ? hit[0] : 'unknown';
        return { status: 200, headers: {}, content: b64(fakeWheel(pkg)), finalUrl: '' };
      }),
    },
    kv: {},
    logger: { i: () => undefined, w: () => undefined, e: () => undefined, d: () => undefined },
  } as never;
}

describe('JarSpiderBridge.ensurePythonRuntime — 下载/解压嵌入式 CPython', () => {
  // ensurePythonRuntime 为 private，经类型断言访问（与既有的 `as never as {…}` 风格一致）
  const runtime = (b: JarSpiderBridge) => (b as never as { ensurePythonRuntime(): Promise<string> }).ensurePythonRuntime();

  it('embed zip 解压出 python.exe，第三方 wheel 解压进 site-packages，runner 落盘', async () => {
    const { jvmDir, pyDir } = tmpCache();
    const bridge = new JarSpiderBridge({ jvmDir, cacheDir: join(jvmDir, 'converted'), pyRuntimeDir: pyDir }, makeHost(fakeEmbedZip()));

    const dir = await runtime(bridge);
    const pyExe = join(pyDir, '3.11.6', 'python.exe');
    expect(existsSync(pyExe)).toBe(true);
    // wheel 解压：libs 族 + lxml
    expect(existsSync(join(pyDir, '3.11.6', 'Lib', 'site-packages', 'requests', '__init__.py'))).toBe(true);
    expect(existsSync(join(pyDir, '3.11.6', 'Lib', 'site-packages', 'lxml', '__init__.py'))).toBe(true);
    // runner 落盘（随包资源拷贝）
    expect(existsSync(join(pyDir, '3.11.6', 'runner.py'))).toBe(true);
    expect(existsSync(join(pyDir, '3.11.6', 'base', 'spider.py'))).toBe(true);
    expect(dir).toBe(join(pyDir, '3.11.6'));
  });

  it('embed 下载失败 → 抛错含手动放置提示', async () => {
    const { jvmDir, pyDir } = tmpCache();
    const host = makeHost(fakeEmbedZip());
    (host as never as { http: { request: unknown } }).http.request = vi.fn(async () => {
      throw new Error('connect timeout');
    });
    const bridge = new JarSpiderBridge({ jvmDir, cacheDir: join(jvmDir, 'converted'), pyRuntimeDir: pyDir }, host);
    await expect(runtime(bridge)).rejects.toThrow(/自动下载失败.*手动下载 python-3\.11\.6/);
  });

  it('已就绪（python.exe 存在）→ 不再下载，直接返回目录', async () => {
    const { jvmDir, pyDir } = tmpCache();
    const dir = join(pyDir, '3.11.6');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'python.exe'), 'stub');
    mkdirSync(join(dir, 'Lib', 'site-packages', 'requests'), { recursive: true });
    writeFileSync(join(dir, 'Lib', 'site-packages', 'requests', '__init__.py'), '# x');
    const host = makeHost(fakeEmbedZip());
    const bridge = new JarSpiderBridge({ jvmDir, cacheDir: join(jvmDir, 'converted'), pyRuntimeDir: pyDir }, host);
    const got = await runtime(bridge);
    expect(got).toBe(dir);
    const reqs = (host as never as { http: { request: { mock: { calls: unknown[][] } } } }).http.request.mock.calls;
    expect(reqs.filter((c) => String((c[0] as { url: string }).url).includes('embed-amd64')).length).toBe(0);
  });
});

describe('JarSpiderBridge.prewarmPythonRuntime — 后台预热（治「py 源首次特别慢」）', () => {
  it('未就绪 → 预热完成下载/解压/装依赖/放 runner，且不 spawn 任何进程', async () => {
    const { jvmDir, pyDir } = tmpCache();
    const bridge = new JarSpiderBridge({ jvmDir, cacheDir: join(jvmDir, 'converted'), pyRuntimeDir: pyDir }, makeHost(fakeEmbedZip()));
    await bridge.prewarmPythonRuntime();
    expect(existsSync(join(pyDir, '3.11.6', 'python.exe'))).toBe(true);
    expect(existsSync(join(pyDir, '3.11.6', 'Lib', 'site-packages', 'requests', '__init__.py'))).toBe(true);
    expect(existsSync(join(pyDir, '3.11.6', 'runner.py'))).toBe(true);
    expect(bridge.pyRuntimeReady()).toBe(true);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('预热与调用并发 → 共享同一份工作，embed 只下载一次', async () => {
    const { jvmDir, pyDir } = tmpCache();
    const host = makeHost(fakeEmbedZip());
    const bridge = new JarSpiderBridge({ jvmDir, cacheDir: join(jvmDir, 'converted'), pyRuntimeDir: pyDir }, host);
    const runtime = (b: JarSpiderBridge) => (b as never as { ensurePythonRuntime(): Promise<string> }).ensurePythonRuntime();
    await Promise.all([bridge.prewarmPythonRuntime(), runtime(bridge), bridge.prewarmPythonRuntime()]);
    const reqs = (host as never as { http: { request: { mock: { calls: unknown[][] } } } }).http.request.mock.calls;
    expect(reqs.filter((c) => String((c[0] as { url: string }).url).includes('embed-amd64')).length).toBe(1);
  });

  it('预热失败 → 静默返回空串（不抛错），首次正常调用会再试', async () => {
    const { jvmDir, pyDir } = tmpCache();
    const host = makeHost(fakeEmbedZip());
    (host as never as { http: { request: unknown } }).http.request = vi.fn(async () => {
      throw new Error('connect timeout');
    });
    const bridge = new JarSpiderBridge({ jvmDir, cacheDir: join(jvmDir, 'converted'), pyRuntimeDir: pyDir }, host);
    await expect(bridge.prewarmPythonRuntime()).resolves.toBe('');
    expect(bridge.pyRuntimeReady()).toBe(false);
  });

  it('已就绪再预热 → 不重拷 runner（避免每次调用递归复制 base/）', async () => {
    const { jvmDir, pyDir } = tmpCache();
    const bridge = new JarSpiderBridge({ jvmDir, cacheDir: join(jvmDir, 'converted'), pyRuntimeDir: pyDir }, makeHost(fakeEmbedZip()));
    await bridge.prewarmPythonRuntime();
    const dst = join(pyDir, '3.11.6', 'runner.py');
    writeFileSync(dst, '# 本地已是最新'); // 模拟已落盘且随包文件未更新
    await bridge.prewarmPythonRuntime();
    expect(readFileSync(dst, 'utf8')).toBe('# 本地已是最新'); // 未被覆盖
  });

  it('runner 被删 → 预热补齐（自愈）', async () => {
    const { jvmDir, pyDir } = tmpCache();
    const bridge = new JarSpiderBridge({ jvmDir, cacheDir: join(jvmDir, 'converted'), pyRuntimeDir: pyDir }, makeHost(fakeEmbedZip()));
    await bridge.prewarmPythonRuntime();
    rmSync(join(pyDir, '3.11.6', 'runner.py'), { force: true });
    await bridge.prewarmPythonRuntime();
    expect(existsSync(join(pyDir, '3.11.6', 'runner.py'))).toBe(true);
  });

  it('existing runtime refreshes the old CA bundle before it becomes ready', async () => {
    const { jvmDir, pyDir } = tmpCache();
    const host = makeHost(fakeEmbedZip());
    const bridge = new JarSpiderBridge({ jvmDir, cacheDir: join(jvmDir, 'converted'), pyRuntimeDir: pyDir }, host);
    await bridge.prewarmPythonRuntime();
    const marker = join(pyDir, '3.11.6', 'Lib', 'site-packages', '.certifi-2026.7.22');
    rmSync(marker);
    expect(bridge.pyRuntimeReady()).toBe(false);
    await bridge.prewarmPythonRuntime();
    expect(bridge.pyRuntimeReady()).toBe(true);
    expect(existsSync(marker)).toBe(true);
  });
});

describe('JarSpiderBridge.callPython — spawn python.exe runner.py', () => {
  it('把调用转成 python.exe <runner> <pyPath> <cls> <method>，env 含 PYTHONIOENCODING', async () => {
    const { jvmDir, pyDir } = tmpCache();
    const calls: SpawnCall[] = [];
    spawnMock.mockImplementation((exe: string, argv: string[], opts: SpawnCall['opts']) => {
      calls.push({ exe, argv, opts });
      return fakeChild();
    });
    const bridge = new JarSpiderBridge({ jvmDir, cacheDir: join(jvmDir, 'converted'), pyRuntimeDir: pyDir }, makeHost(fakeEmbedZip()));

    const out = await bridge.callPython('C:/cache/spider/py/abc.py', 'Spider', 'homeContent', ['{"siteUrl":"https://s"}'], undefined, 'live 源');
    expect(calls.length).toBe(1);
    expect(calls[0].exe).toBe(join(pyDir, '3.11.6', 'python.exe'));
    expect(calls[0].argv[0]).toBe(join(pyDir, '3.11.6', 'runner.py'));
    expect(calls[0].argv.slice(1)).toEqual(['C:/cache/spider/py/abc.py', 'Spider', 'homeContent', '{"siteUrl":"https://s"}']);
    expect(calls[0].opts.env?.PYTHONIOENCODING).toBe('utf-8');
    expect(calls[0].opts.env?.WINBOX_PY_PROXY).toBe('http://127.0.0.1:9978/proxy?do=py&key=live%20%E6%BA%90');
    expect(out).toBe('');
  });

  it('运行时未配置 → 直接抛错（不 spawn）', async () => {
    const { jvmDir } = tmpCache();
    const bridge = new JarSpiderBridge({ jvmDir, cacheDir: join(jvmDir, 'converted') }, makeHost(fakeEmbedZip()));
    await expect(bridge.callPython('x.py', 'Spider', 'homeContent', [])).rejects.toThrow(/未配置下载目录/);
    expect(spawnMock).not.toHaveBeenCalled();
  });
});

// ============================================================================
// ★ macOS 适配（T05）：python 运行时平台化。
//   darwin：解释器用系统 python3（**不下载 Windows embeddable 包**）、site-packages 走
//           `lib/python3.x/site-packages`、二进制 wheel 用 macosx 标签（按架构二选一）；
//   win32 ：行为逐字节不变（Lib/site-packages + python.exe + win_amd64）。
//   平台/架构注入统一走 process.env（vitest vmThreads 下 globalThis 不共享）。
// ============================================================================
describe('python 运行时平台化（darwin vs win32）', () => {
  afterEach(() => {
    for (const d of dirs) {
      try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    dirs.length = 0;
    spawnMock.mockReset();
    delete process.env.WINBOX_TEST_PLATFORM;
    delete process.env.WINBOX_TEST_ARCH;
  });

  type Priv = {
    pyExeCandidates(d: string): string[];
    pyExePath(d: string): string;
    pyExeReady(d: string): boolean;
    pySitePackages(d: string): string;
    pyEnvExtra(d: string): Record<string, string>;
    wheelVariant(w: unknown): { name: string; file: string; platform?: string };
  };
  const priv = (b: JarSpiderBridge): Priv => b as never as Priv;
  const pyWheels = (): Array<Record<string, unknown>> =>
    (JarSpiderBridge as never as { PY_WHEELS: Array<Record<string, unknown>> }).PY_WHEELS;

  it('darwin：site-packages 走 lib/python3.11/site-packages；解释器是系统 python3（无 .exe）', () => {
    process.env.WINBOX_TEST_PLATFORM = 'darwin';
    const { jvmDir, pyDir } = tmpCache();
    const bridge = new JarSpiderBridge({ jvmDir, cacheDir: join(jvmDir, 'converted'), pyRuntimeDir: pyDir }, makeHost(fakeEmbedZip()));
    const dir = join(pyDir, '3.11.6');

    expect(priv(bridge).pySitePackages(dir)).toBe(join(dir, 'lib', 'python3.11', 'site-packages'));
    // 解释器候选来自系统 python3 探测（Homebrew → /usr/local/bin → /usr/bin），绝不是随包 python.exe
    const cands = priv(bridge).pyExeCandidates(dir);
    expect(cands.length).toBeGreaterThan(0);
    expect(cands.every((c) => c.endsWith('python3'))).toBe(true);
    expect(cands).toContain('/usr/bin/python3');
    expect(priv(bridge).pyExePath(dir).endsWith('python.exe')).toBe(false);
    // PYTHONPATH 注入自建 site-packages（darwin 必备；win32 由 embed 的 _pth 负责 → 空对象）
    expect(priv(bridge).pyEnvExtra(dir)).toEqual({ PYTHONPATH: join(dir, 'lib', 'python3.11', 'site-packages') });
  });

  it('darwin：python3 探测覆盖 PATH（pyenv / conda / asdf）；win32 不受 PATH 影响（断言证据）', () => {
    const { jvmDir, pyDir } = tmpCache();
    const bridge = new JarSpiderBridge({ jvmDir, cacheDir: join(jvmDir, 'converted'), pyRuntimeDir: pyDir }, makeHost(fakeEmbedZip()));
    const dir = join(pyDir, '3.11.6');
    const savedPath = process.env.PATH;
    try {
      // 只放一条 POSIX 风格目录（无 ':' 分隔符，避免被 pathBinDirs 按 ':' 拆碎）→ darwin 下成为一条 PATH 目录
      process.env.PATH = '/opt/pyenv/shims';

      // darwin：PATH 里的 python3 必须进入候选（否则 pyenv 用户被误判成「未安装 python3」）
      process.env.WINBOX_TEST_PLATFORM = 'darwin';
      const macCands = priv(bridge).pyExeCandidates(dir);
      expect(macCands).toContain('/opt/pyenv/shims/python3');
      expect(macCands).toContain('/usr/bin/python3'); // 固定 bin 目录仍在
      expect(macCands.every((c) => c.endsWith('python3'))).toBe(true); // 仍全是 python3，绝不是 python.exe

      // win32：候选恒为随包 python.exe，与 PATH 完全无关（不受本次改动影响）
      delete process.env.WINBOX_TEST_PLATFORM;
      expect(priv(bridge).pyExeCandidates(dir)).toEqual([join(dir, 'python.exe')]);
      expect(priv(bridge).pyExePath(dir)).toBe(join(dir, 'python.exe'));
    } finally {
      if (savedPath === undefined) delete process.env.PATH;
      else process.env.PATH = savedPath;
      delete process.env.WINBOX_TEST_PLATFORM;
    }
  });

  it('win32（缺省，零回归）：site-packages 走 Lib/site-packages；解释器 python.exe；PYTHONPATH 不注入', () => {
    const { jvmDir, pyDir } = tmpCache();
    const bridge = new JarSpiderBridge({ jvmDir, cacheDir: join(jvmDir, 'converted'), pyRuntimeDir: pyDir }, makeHost(fakeEmbedZip()));
    const dir = join(pyDir, '3.11.6');

    expect(priv(bridge).pySitePackages(dir)).toBe(join(dir, 'Lib', 'site-packages'));
    expect(priv(bridge).pyExeCandidates(dir)).toEqual([join(dir, 'python.exe')]);
    expect(priv(bridge).pyExePath(dir)).toBe(join(dir, 'python.exe'));
    expect(priv(bridge).pyEnvExtra(dir)).toEqual({});
  });

  it('darwin：二进制 wheel 选 macosx 标签（arm64 ↔ x64 按架构二选一；universal2 通用）', () => {
    process.env.WINBOX_TEST_PLATFORM = 'darwin';
    const { jvmDir, pyDir } = tmpCache();
    const bridge = new JarSpiderBridge({ jvmDir, cacheDir: join(jvmDir, 'converted'), pyRuntimeDir: pyDir }, makeHost(fakeEmbedZip()));

    const lxml = pyWheels().find((w) => w.name === 'lxml')!;
    const pillow = pyWheels().find((w) => w.name === 'PIL')!;

    process.env.WINBOX_TEST_ARCH = 'arm64';
    expect(priv(bridge).wheelVariant(lxml).file).toBe('lxml-5.2.1-cp311-cp311-macosx_10_9_universal2.whl');
    expect(String(priv(bridge).wheelVariant(lxml).platform)).toContain('macosx_10_9_universal2');
    expect(priv(bridge).wheelVariant(pillow).file).toBe('pillow-10.2.0-cp311-cp311-macosx_11_0_arm64.whl');

    process.env.WINBOX_TEST_ARCH = 'x64';
    expect(priv(bridge).wheelVariant(pillow).file).toBe('pillow-10.2.0-cp311-cp311-macosx_10_10_x86_64.whl');
    expect(String(priv(bridge).wheelVariant(pillow).platform)).toContain('x86_64');
  });

  it('win32（缺省，零回归）：二进制 wheel 仍是 win_amd64', () => {
    const { jvmDir, pyDir } = tmpCache();
    const bridge = new JarSpiderBridge({ jvmDir, cacheDir: join(jvmDir, 'converted'), pyRuntimeDir: pyDir }, makeHost(fakeEmbedZip()));
    const lxml = pyWheels().find((w) => w.name === 'lxml')!;
    expect(priv(bridge).wheelVariant(lxml).file).toBe('lxml-4.9.2-cp311-cp311-win_amd64.whl');
    expect(priv(bridge).wheelVariant(lxml).platform).toBe('cp311-cp311-win_amd64');
  });

  it('darwin：**绝不**下载 Windows embeddable 包；探测不到 python3 时给出中文 brew 指引', async () => {
    process.env.WINBOX_TEST_PLATFORM = 'darwin';
    const { jvmDir, pyDir } = tmpCache();
    const host = makeHost(fakeEmbedZip());
    const bridge = new JarSpiderBridge({ jvmDir, cacheDir: join(jvmDir, 'converted'), pyRuntimeDir: pyDir }, host);
    const runtime = (b: JarSpiderBridge) => (b as never as { ensurePythonRuntime(): Promise<string> }).ensurePythonRuntime();

    let err: Error | null = null;
    try { await runtime(bridge); } catch (e) { err = e as Error; }

    const reqs = (host as never as { http: { request: { mock: { calls: unknown[][] } } } }).http.request.mock.calls;
    // 核心锁：darwin 不发起 embed-amd64 下载（那是 Windows 专用 .exe 包）
    expect(reqs.filter((c) => String((c[0] as { url: string }).url).includes('embed-amd64')).length).toBe(0);
    expect(spawnMock).not.toHaveBeenCalled();
    // 探测不到系统 python3 时（本机 CI 常态）→ 抛中文人话指引，供 PySpider 转 PY_UNSUPPORTED 上屏
    if (err) expect(err.message).toMatch(/brew install python@3\.11/);
  });
});

