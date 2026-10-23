// tests/appProxyStub.spec.ts — 补全蜘蛛 jar 自带的极简 `com.github.catvod.spider.Proxy`（补 getProxyUrlDo）。
// 实测来源：`运行日志` 的
//   `NoSuchMethodError: 'java.lang.String com.github.catvod.spider.Proxy.getProxyUrlDo(java.lang.String)'`
//   （jar 自带极简 Proxy 只有 proxy(Map)→Init.proxyInvoke；安卓端由 App dex 同名完整类兜住）。
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { parseClassBytes } from '../src/engine/spider/classFix';
import { buildSpiderProxyClass, patchSpiderProxyInJar, SPIDER_PROXY_CLASS } from '../src/engine/spider/appProxyStub';
import { buildZip, readZipEntries } from '../src/engine/util/syncZip';

const PROXY = `${SPIDER_PROXY_CLASS}.class`;
const minimalJar = (): Buffer =>
  buildZip(
    [
      { name: 'com/github/catvod/spider/Dummy.class', bytes: Buffer.from('x') },
      { name: PROXY, bytes: buildSpiderProxyClass(false) },
    ],
    { deflate: true },
  );

describe('appProxyStub — 补全极简 spider/Proxy', () => {
  it('生成的类结构正确（proxy + getProxyUrlDo，Java5 无 StackMapTable）', () => {
    const info = parseClassBytes(buildSpiderProxyClass(true));
    expect(info.name).toBe(SPIDER_PROXY_CLASS);
    expect(info.superName).toBe('java/lang/Object');
    const sigs = info.methods.map((m) => `${m.name}${m.desc}`);
    expect(sigs).toContain('proxy(Ljava/util/Map;)[Ljava/lang/Object;');
    expect(sigs).toContain('getProxyUrlDo(Ljava/lang/String;)Ljava/lang/String;');
  });

  it('极简形态 → 就地替换为补全版（其它条目原样保留）', () => {
    const r = patchSpiderProxyInJar(minimalJar());
    expect(r.patched).toBe(true);
    const entries = readZipEntries(r.bytes as Buffer);
    const cls = entries.find((e) => e.name === PROXY);
    expect(!!cls).toBe(true);
    const names = parseClassBytes(cls!.bytes).methods.map((m) => m.name);
    expect(names).toContain('proxy');
    expect(names).toContain('getProxyUrlDo');
    expect(entries.some((e) => e.name === 'com/github/catvod/spider/Dummy.class')).toBe(true);
  });

  it('已含 getProxyUrlDo → 不动（幂等）', () => {
    const jar = buildZip([{ name: PROXY, bytes: buildSpiderProxyClass(true) }], { deflate: true });
    expect(patchSpiderProxyInJar(jar).patched).toBe(false);
  });

  it('无该类的 jar → 不动', () => {
    const jar = buildZip([{ name: 'a/b.class', bytes: Buffer.from('x') }], { deflate: true });
    expect(patchSpiderProxyInJar(jar).patched).toBe(false);
  });

  it('真实异形变体（某壳源-spider.jar 的 21KB Proxy）→ 不动（绝不误伤其它壳）', () => {
    const p = 'resources/jvm/shell-shim/real/foni-spider.jar';
    if (!existsSync(p)) return; // 产物缺失则跳过（CI 里该 jar 随包存在）
    const r = patchSpiderProxyInJar(readFileSync(p));
    expect(r.patched).toBe(false);
  });
});
