// tests/resourcePath.spec.ts
// portable(单文件) 资源路径回归护栏。
//
// 事故背景：portable 的 NSIS 解压脚本把内容放在 $PLUGINSDIR\7z-out 下
// （见 app-builder-lib extractAppPackage.nsh → extractUsing7za），
// 而 process.resourcesPath 少一层 7z-out。原先写死单一路径 →
// existsSync(java.exe)=false → 报「JRE 缺失」，JVM 源全部不可用。
//
// 这里锁住：四种真实布局都能被候选项命中。
import { describe, it, expect } from 'vitest';
import { resourceRootCandidates, pickResourceRoot } from '../src/main/util/resolveResources';
import { platformName } from '../src/shared/platform';

const WIN = process.platform === 'win32';
/** 路径大小写/分隔符不敏感比较（Windows） */
const eq = (a: string, b: string): boolean =>
  WIN ? a.toLowerCase().replace(/\\/g, '/') === b.toLowerCase().replace(/\\/g, '/') : a === b;

describe('resourceRootCandidates — 布局覆盖', () => {
  it('开发态 → <repo>/resources（dist 与 resources 同级）', () => {
    const c = resourceRootCandidates({
      packaged: false,
      dirname: 'E:/repo/dist',
    });
    expect(c.some((p) => eq(p, 'E:/repo/resources'))).toBe(true);
  });

  it('NSIS 安装 / --dir → <root>/resources/app.asar.unpacked/resources', () => {
    const c = resourceRootCandidates({
      packaged: true,
      resourcesPath: 'C:/app/resources',
      exeDir: 'C:/app',
    });
    expect(
      c.some((p) => eq(p, 'C:/app/resources/app.asar.unpacked/resources')),
    ).toBe(true);
  });

  it('portable：resourcesPath 停在 <tmp>\\resources 时，能命中 7z-out 真实根', () => {
    const tmp = 'C:/Users/u/AppData/Local/Temp/nso8227.tmp';
    const c = resourceRootCandidates({
      packaged: true,
      // 实测 resourcesPath（外层，缺 7z-out）
      resourcesPath: `${tmp}/resources`,
      exeDir: `${tmp}/7z-out`,
    });
    const want = `${tmp}/7z-out/resources/app.asar.unpacked/resources`;
    expect(c.some((p) => eq(p, want))).toBe(true);
  });

  it('portable 变体：resourcesPath 直接是 <tmp> 时同样能命中', () => {
    const tmp = 'C:/Users/u/AppData/Local/Temp/nso8227.tmp';
    const c = resourceRootCandidates({
      packaged: true,
      resourcesPath: tmp,
      exeDir: `${tmp}/7z-out`,
    });
    const want = `${tmp}/7z-out/resources/app.asar.unpacked/resources`;
    expect(c.some((p) => eq(p, want))).toBe(true);
  });
});

describe('pickResourceRoot — 选择行为', () => {
  it('返回第一个存在的候选（模拟 portable 真实布局）', () => {
    const tmp = 'C:/tmp/nso8227.tmp';
    const want = `${tmp}/7z-out/resources/app.asar.unpacked/resources`;
    const picked = pickResourceRoot(
      {
        packaged: true,
        resourcesPath: `${tmp}/resources`,
        exeDir: `${tmp}/7z-out`,
      },
      (p) => eq(p, want), // 只有真实根"存在"
    );
    expect(eq(picked, want)).toBe(true);
  });

  it('全部不存在时回退首选路径（不抛错，保留原错误形态）', () => {
    const ctx = { packaged: true, resourcesPath: 'C:/app/resources', exeDir: 'C:/app' };
    const cands = resourceRootCandidates(ctx);
    const picked = pickResourceRoot(ctx, () => false);
    expect(picked).toBe(cands[0]);
  });

  it('候选列表无重复项', () => {
    const c = resourceRootCandidates({
      packaged: true,
      resourcesPath: 'C:/tmp/x.tmp/resources',
      exeDir: 'C:/tmp/x.tmp/7z-out',
    });
    expect(new Set(c).size).toBe(c.length);
  });
});

// ★ 2026-10-12（macOS 适配 T01）：平台化候选 —— darwin 只出 darwin 候选（不含 7z-out），
//   win32 与改动前**逐项相同**（7z-out 三档全在）。
describe('resourceRootCandidates — 平台化（Windows 零回归 + darwin 布局）', () => {
  const WIN_CTX = {
    packaged: true as const,
    platform: 'win32' as const,
    resourcesPath: 'C:/tmp/x.tmp/resources',
    exeDir: 'C:/tmp/x.tmp/7z-out',
  };

  it('★ win32：候选与改动前逐项相同（7z-out 三档全在，顺序不变）', () => {
    // 与改动前 `resourceRootCandidates` 的输出**逐项、顺序**一致（去重后共 5 条）：
    //   1) join(rp, rel)
    //   2) join(rp,'..','7z-out','resources',rel)      ← portable 实测命中的那一条
    //   3) join(rp,'..','7z-out',rel)
    //   4) join(rp,'7z-out','resources',rel)
    //   5) join(rp,'7z-out',rel)
    //   （exeDir 反推的 5 条在本样例下全部与上面重复 → 被去重吞掉，符合原实现）
    const want: string[] = [
      'c:/tmp/x.tmp/resources/app.asar.unpacked/resources',
      'c:/tmp/x.tmp/7z-out/resources/app.asar.unpacked/resources',
      'c:/tmp/x.tmp/7z-out/app.asar.unpacked/resources',
      'c:/tmp/x.tmp/resources/7z-out/resources/app.asar.unpacked/resources',
      'c:/tmp/x.tmp/resources/7z-out/app.asar.unpacked/resources',
    ];
    const got = resourceRootCandidates(WIN_CTX).map((p) => p.replace(/\\/g, '/').toLowerCase());
    expect(got).toEqual(want);
  });

  it('★ win32：候选里必须含 7z-out（portable 布局的命脉）', () => {
    const c = resourceRootCandidates(WIN_CTX);
    expect(c.filter((p) => p.includes('7z-out')).length).toBeGreaterThanOrEqual(3);
  });

  /** Windows 主机上 `node:path.join` 会输出 `\`，统一成正斜杠再断言 */
  const norm = (p: string): string => p.replace(/\\/g, '/');

  const DARWIN_CTX = {
    packaged: true as const,
    platform: 'darwin' as const,
    resourcesPath: '/Applications/Win-Box.app/Contents/Resources',
    exeDir: '/Applications/Win-Box.app/Contents/MacOS',
  };

  it('★ darwin：首选 <App>/Contents/Resources/app.asar.unpacked/resources', () => {
    const c = resourceRootCandidates(DARWIN_CTX).map(norm);
    expect(c[0]).toBe('/Applications/Win-Box.app/Contents/Resources/app.asar.unpacked/resources');
    expect(c).toContain('/Applications/Win-Box.app/Contents/Resources/resources');
    // exeDir（Contents/MacOS）反推 → Contents/Resources
    expect(
      c.some((p) => p === '/Applications/Win-Box.app/Contents/Resources/app.asar.unpacked/resources'),
    ).toBe(true);
    expect(new Set(c).size).toBe(c.length); // 无重复
  });

  it('★ darwin：候选里绝不含 7z-out（NSIS portable 专有，macOS 上纯噪声）', () => {
    const c = resourceRootCandidates(DARWIN_CTX).map(norm);
    expect(c.filter((p) => p.includes('7z-out'))).toEqual([]);
  });

  it('缺省 platform 与显式传「当前生效平台」逐项一致（与主机、与并行注入都无关）', () => {
    const ctx = {
      packaged: true as const,
      resourcesPath: 'C:/tmp/x.tmp/resources',
      exeDir: 'C:/tmp/x.tmp/7z-out',
    };
    // ★ 两侧都用同一个「当前生效平台」，故断言在任何主机、任何 env 注入下都成立；
    //   真正的 Windows 零回归保证在下面两条**显式 platform:'win32'** 的用例里。
    expect(resourceRootCandidates(ctx)).toEqual(
      resourceRootCandidates({ ...ctx, platform: platformName() }),
    );
  });

  it('darwin 打包态 pickResourceRoot 命中真实布局', () => {
    const picked = pickResourceRoot(DARWIN_CTX, (p) => norm(p).includes('/Contents/Resources/'));
    expect(norm(picked)).toBe(
      '/Applications/Win-Box.app/Contents/Resources/app.asar.unpacked/resources',
    );
  });
});
