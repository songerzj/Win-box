// tests/prefsShim.spec.ts
// 某第三方源族 SharedPreferences 影子类（`android/content/SharedPreferences$Mem`）的回归：
//   ① 纯 Node 逻辑：`syncWexPrefsSeed` 写出/删除 `<沙箱>/shared_prefs/seed.txt`；
//   ② 真 JVM（随包 JRE，**免 javac** —— 类由 Node 现场生成）：
//      带影子 jar 时能读出种子值；不带时退回 stubs.jar 里的纯内存实现（读到默认值）。
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { buildPrefsProbeClass, buildPrefsShimJar, PREFS_PROBE_CLASS, WEX_PREFS_NAME } from '../src/engine/spider/prefsShim';
import { buildZip } from '../src/engine/util/syncZip';
import { syncWexPrefsSeed, wexPrefsSeedPath, WEX_PREF_ENV, WEX_PREF_KEYS } from '../src/main/spider/driveCookieFiles';

describe('某壳源 SharedPreferences 种子（Node 侧）', () => {
  it('写入有凭据的键 + 桌面环境键；每行都是三段式', () => {
    const dir = mkdtempSync(join(tmpdir(), 'winbox-prefs-'));
    try {
      const path = syncWexPrefsSeed({ uc: '__uid=U;', baidu: 'BDUSS=B;', quark: 'QK=Q;' }, dir);
      expect(path).toBe(wexPrefsSeedPath(dir));
      const text = readFileSync(path, 'utf-8');
      for (const key of [...Object.values(WEX_PREF_KEYS), ...Object.keys(WEX_PREF_ENV)]) {
        expect(text).toContain(`${WEX_PREFS_NAME}\t${key}\t`);
      }
      // 每行 = 表名 \t 键 \t 值（影子类的 loadSeed 按此切分）
      for (const line of text.trim().split('\n')) expect(line.split('\t')).toHaveLength(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('无凭据时不写入任何 Wex_* 键（只留桌面环境键）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'winbox-prefs-none-'));
    try {
      const path = syncWexPrefsSeed({}, dir);
      const text = readFileSync(path, 'utf-8');
      expect(text).not.toContain('Wex_');
      for (const key of Object.keys(WEX_PREF_ENV)) expect(text).toContain(`${WEX_PREFS_NAME}\t${key}\t`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('值里的制表符/换行不会打穿行格式', () => {
    const dir = mkdtempSync(join(tmpdir(), 'winbox-prefs-esc-'));
    try {
      const path = syncWexPrefsSeed({ baidu: 'A=1;\nB=2;\tC=3;' }, dir);
      const scoped = readFileSync(path, 'utf-8').split('\n').filter((l) => l.includes('Wex_baidu_cookie'));
      expect(scoped).toHaveLength(1);
      expect(scoped[0].split('\t')).toHaveLength(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

const java = resolve('resources/jvm/jre/bin/java' + (process.platform === 'win32' ? '.exe' : ''));
const stubs = resolve('resources/jvm/stubs/stubs.jar');

describe.skipIf(!existsSync(java) || !existsSync(stubs))('真实 JVM：prefs 影子类', () => {
  it('带影子 jar 时从 seed.txt 读出 Wex_baidu_cookie；不带时读到默认值', () => {
    const dir = mkdtempSync(join(tmpdir(), 'winbox-prefs-jvm-'));
    try {
      const sandbox = join(dir, 'sandbox');
      mkdirSync(join(sandbox, 'shared_prefs'), { recursive: true });
      writeFileSync(join(sandbox, 'shared_prefs', 'seed.txt'), `${WEX_PREFS_NAME}\tWex_baidu_cookie\tBAIDUID=SPEC_OK\n`, 'utf-8');

      const shimJar = join(dir, 'shim.jar');
      writeFileSync(shimJar, buildPrefsShimJar());
      const probeJar = join(dir, 'probe.jar');
      writeFileSync(probeJar, buildZip([{ name: PREFS_PROBE_CLASS + '.class', bytes: buildPrefsProbeClass() }], { deflate: true }));

      const run = (cp: string): string => {
        const r = spawnSync(
          java,
          ['-Dfile.encoding=UTF-8', '-Dstdout.encoding=UTF-8', `-Dtvbox.spiderCacheDir=${sandbox}`, '-cp', cp, 'com.winbox.PrefsProbe'],
          { encoding: 'utf8', timeout: 30000 },
        );
        expect(r.status, r.stderr).toBe(0);
        return (r.stdout || '').trim();
      };

      // 影子 jar 必须排在 stubs.jar 之前（父 cp 先命中者生效）
      expect(run([probeJar, shimJar, stubs].join(delimiter))).toBe('PROBE=BAIDUID=SPEC_OK');
      // 对照：不带影子 jar → stubs.jar 里的纯内存实现
      expect(run([probeJar, stubs].join(delimiter))).toBe('PROBE=(none)');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60000);
});
