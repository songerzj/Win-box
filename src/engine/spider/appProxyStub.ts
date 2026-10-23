// src/engine/spider/appProxyStub.ts
//   现象：某第三方源播放必失败：
//     java.lang.NoSuchMethodError:
//       'java.lang.String com.github.catvod.spider.Proxy.getProxyUrlDo(java.lang.String)'
//
//   根因（经调用链分析确认）：
//     · 蜘蛛 jar 里**自带**一个极简的 `com/github/catvod/spider/Proxy`（292B，只有
//       `public static Object[] proxy(Map) → Init.proxyInvoke(params)` + `<init>`）；
//     · 安卓端 App dex 里另有一个**同名 FQN 的完整版本**（含 `getProxyUrlDo` 等），
//       ClassLoader **父优先** ⇒ 运行时解析到 App 的完整版 → 蜘蛛调用正常；
//     · 桌面端我们的 stubs.jar 没有这个类 ⇒ 解析落到 jar 里那个极简版 ⇒ 缺方法 ⇒ NoSuchMethodError。
//
//   为什么**不**把类加进 stubs.jar：stubs.jar 是**全局父类加载器**，会一并盖掉我们的
//   `shell-shim/real/` 下的完整构建 jar（它的 Proxy 有 `decode_S` / `drivePort` 等**别的方法**）
//   —— 那是「修一个源、废一片源」。故本模块只做**就地产物修补**（与 classFix 同路线）：
//   仅当某个转换产物里的 `spider/Proxy.class` 是**极简形态**（只有 `proxy(Map)` + `<init>`，
//   且**缺** `getProxyUrlDo`）时，才把它替换成「等价 `proxy(Map)` 委托 + 补 `getProxyUrlDo`」的类。
//   凡是形态不符（多方法变体）一律**不动**。
//
//   类文件由本模块**确定性生成**（Node 端，无需 javac/JDK；运行环境无 JDK 也能修）：
//   目标 JVM 版本 49（Java 5）⇒ **不需要 StackMapTable**，方法体为直线代码。
//
//   ⚠ `getProxyUrlDo(String)` 的语义按「返回桌面端的 /proxy?do= 地址」实现（与 LocalProxyServer
//     的 do=pan 路由、SpiderHost 的 /proxy 改写链一致）；真实语义待真机复验后微调。
import { readFileSync, writeFileSync } from 'node:fs';
import { buildZip, readZipEntries, type ZipEntryData } from '../util/syncZip';
import { parseClassBytes } from './classFix';

/** 桌面端本机代理基地址（与 shared/constants 的 LOCAL_PROXY_BASE 同值；类文件里是 Java 字符串常量） */
const PROXY_BASE = 'http://127.0.0.1:9978';

/** 修补目标类的 FQN（class 文件里的斜杠写法） */
export const SPIDER_PROXY_CLASS = 'com/github/catvod/spider/Proxy';

const D = (s: string): Buffer => Buffer.from(s, 'utf8');

/**
 * 生成 `com.github.catvod.spider.Proxy` 的类字节。
 * @param withGetProxyUrlDo false = 只生成 jar 里那种**极简形态**（无 `getProxyUrlDo`，仅用于单测造夹具）
 */
export function buildSpiderProxyClass(withGetProxyUrlDo = true): Buffer {
  // ---- 常量池（顺序固定，下标见注释；cp_count = 最后一个下标 + 1）----
  type Cp = Buffer;
  const utf8 = (s: string): Cp => {
    const b = D(s);
    return Buffer.concat([Buffer.from([1]), u2(b.length), b]);
  };
  const klass = (nameIdx: number): Cp => Buffer.concat([Buffer.from([7]), u2(nameIdx)]);
  const str = (utf8Idx: number): Cp => Buffer.concat([Buffer.from([8]), u2(utf8Idx)]);
  const nat = (n: number, d: number): Cp => Buffer.concat([Buffer.from([12]), u2(n), u2(d)]);
  const ref = (cls: number, nt: number): Cp =>
    Buffer.concat([Buffer.from([10]), u2(cls), u2(nt)]);

  const cp: Cp[] = []; // cp[i] 对应常量池下标 i+1
  const push = (e: Cp): number => { cp.push(e); return cp.length; };

  const i_thisName = push(utf8(SPIDER_PROXY_CLASS));            // 1
  const i_thisCls = push(klass(i_thisName));                    // 2
  const i_objName = push(utf8('java/lang/Object'));             // 3
  const i_objCls = push(klass(i_objName));                      // 4
  const i_code = push(utf8('Code'));                            // 5
  const i_proxy = push(utf8('proxy'));                          // 6
  const i_proxyDesc = push(utf8('(Ljava/util/Map;)[Ljava/lang/Object;')); // 7
  const i_initName = push(utf8('com/github/catvod/spider/Init')); // 8
  const i_initCls = push(klass(i_initName));                    // 9
  const i_proxyInvoke = push(utf8('proxyInvoke'));              // 10
  const i_natProxyInvoke = push(nat(i_proxyInvoke, i_proxyDesc)); // 11
  const i_refProxyInvoke = push(ref(i_initCls, i_natProxyInvoke)); // 12
  const i_getName = push(utf8('getProxyUrlDo'));                // 13
  const i_getDesc = push(utf8('(Ljava/lang/String;)Ljava/lang/String;')); // 14
  const i_base = push(utf8(`${PROXY_BASE}/proxy?do=`));         // 15
  const i_baseStr = push(str(i_base));                          // 16
  const i_stringName = push(utf8('java/lang/String'));          // 17
  const i_stringCls = push(klass(i_stringName));                // 18
  const i_concat = push(utf8('concat'));                        // 19
  const i_natConcat = push(nat(i_concat, i_getDesc));           // 20
  const i_refConcat = push(ref(i_stringCls, i_natConcat));      // 21
  const cpCount = cp.length + 1;

  // ---- 方法体（直线代码；v49 → 无需 StackMapTable）----
  const codeProxy = Buffer.concat([
    Buffer.from([0x2a]),                 // aload_0  (params)
    Buffer.from([0xb8]), u2(i_refProxyInvoke), // invokestatic Init.proxyInvoke(Map)
    Buffer.from([0xb0]),                 // areturn
  ]);
  const codeGetDo = Buffer.concat([
    Buffer.from([0x12, i_baseStr]),      // ldc "…/proxy?do="
    Buffer.from([0x2a]),                 // aload_0
    Buffer.from([0xb6]), u2(i_refConcat),// invokevirtual String.concat(String)
    Buffer.from([0xb0]),                 // areturn
  ]);

  const codeAttr = (code: Buffer, maxStack: number, maxLocals: number): Cp => {
    const body = Buffer.concat([
      u2(maxStack), u2(maxLocals), u4(code.length), code, u2(0), u2(0),
    ]);
    return Buffer.concat([u2(i_code), u4(body.length), body]);
  };
  const method = (nameIdx: number, descIdx: number, attr: Cp): Cp =>
    Buffer.concat([u2(0x0009), u2(nameIdx), u2(descIdx), u2(1), attr]); // public static

  const methods: Cp[] = [method(i_proxy, i_proxyDesc, codeAttr(codeProxy, 1, 1))];
  if (withGetProxyUrlDo) methods.push(method(i_getName, i_getDesc, codeAttr(codeGetDo, 2, 1)));

  return Buffer.concat([
    Buffer.from([0xca, 0xfe, 0xba, 0xbe]), // magic
    u2(0),                                 // minor
    u2(49),                                // major = Java 5（免 StackMapTable）
    u2(cpCount),
    ...cp,
    u2(0x0031),                            // public final super
    u2(i_thisCls), u2(i_objCls),
    u2(0),                                 // interfaces
    u2(0),                                 // fields
    u2(methods.length),
    ...methods,
    u2(0),                                 // class attributes
  ]);
}

function u2(n: number): Buffer { const b = Buffer.alloc(2); b.writeUInt16BE(n & 0xffff, 0); return b; }
function u4(n: number): Buffer { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0, 0); return b; }

export interface AppProxyPatchResult {
  /** 改写后的 jar 字节；未命中返回 null */
  bytes: Buffer | null;
  patched: boolean;
  /** 未改写时的原因（命中但形态不符） */
  reason?: string;
}

/**
 * 在**转换产物**里就地修补 `com/github/catvod/spider/Proxy`：
 * 仅当它是「极简形态」（只有 `proxy(Ljava/util/Map;)[Ljava/lang/Object;` 与 `<init>`）
 * 且**缺** `getProxyUrlDo(Ljava/lang/String;)Ljava/lang/String;` 时，整类替换为补全版。
 */
export function patchSpiderProxyInJar(jarBytes: Buffer): AppProxyPatchResult {
  let entries: ZipEntryData[];
  try {
    entries = readZipEntries(jarBytes);
  } catch {
    return { bytes: null, patched: false };
  }
  const target = `${SPIDER_PROXY_CLASS}.class`;
  const idx = entries.findIndex((e) => e.name === target);
  if (idx < 0) return { bytes: null, patched: false };

  let info;
  try {
    info = parseClassBytes(entries[idx].bytes);
  } catch {
    return { bytes: null, patched: false, reason: '类文件解析失败' };
  }
  const names = info.methods.map((m) => `${m.name}${m.desc}`);
  if (names.some((n) => n.startsWith('getProxyUrlDo'))) {
    return { bytes: null, patched: false, reason: '已含 getProxyUrlDo（无需修补）' };
  }
  // 极简形态护栏：除 `proxy(Map)` 与 `<init>` 外不允许有别的成员 —— 否则是别的壳的变体，不碰
  const onlyMinimal = info.methods.every(
    (m) => (m.name === 'proxy' && m.desc === '(Ljava/util/Map;)[Ljava/lang/Object;') || m.name === '<init>',
  );
  if (!info.methods.some((m) => m.name === 'proxy' && m.desc === '(Ljava/util/Map;)[Ljava/lang/Object;') || !onlyMinimal) {
    return { bytes: null, patched: false, reason: `非极简 Proxy（成员：${names.join(', ')}）` };
  }

  const out = entries.slice();
  out[idx] = { name: target, bytes: buildSpiderProxyClass(true) };
  return { bytes: buildZip(out, { deflate: true }), patched: true };
}

/** 文件级：就地修补转换产物（增强步骤 —— 失败只记日志，绝不让「能用的产物」变成失败） */
export function patchSpiderProxyInJarFile(
  jarPath: string,
  log?: { i: (m: string) => void; w: (m: string) => void },
): void {
  try {
    const r = patchSpiderProxyInJar(readFileSync(jarPath));
    if (!r.patched || !r.bytes) return;
    writeFileSync(jarPath, r.bytes);
    log?.i('jvm-bridge 已补全 com.github.catvod.spider.Proxy（补 getProxyUrlDo）——否则该类调用必 NoSuchMethodError');
  } catch (e) {
    log?.w(`jvm-bridge Proxy 补全失败（不影响普通 jar）: ${(e as Error).message}`);
  }
}
