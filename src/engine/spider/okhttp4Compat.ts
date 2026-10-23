// src/engine/spider/okhttp4Compat.ts
//   现象：某第三方源里的嵌套源（`com.github.catvod.spider.SoAiPanSoo`，壳 jar `983a5ad5…` 运行时解出的
//     载荷）播放必失败：
//     java.lang.NoSuchMethodError:
//       'okhttp3.RequestBody okhttp3.RequestBody.create(java.lang.String, okhttp3.MediaType)'
//
//   根因（经调用链分析确认）：
//     · 该蜘蛛按 **okhttp 4.x** 的参数序调用（内容在前、MediaType 在后）——4.x 起
//       `RequestBody.create` 的 Kotlin companion 方法是 `create(content, contentType)`；
//     · 桌面端父类加载器里只有 **okhttp 3.14.9**（`resources/jvm/libs/okhttp-3.14.9.jar`），
//       其 `RequestBody` 只有 **3.x 参数序** `create(MediaType, 内容)`（探针实测 5 个重载：
//       String / ByteString / [B / [BII / File），**没有** 4.x 参数序的那个 ⇒ 解析不到 ⇒ NoSuchMethodError；
//     · 安卓端自带 okhttp 4.x ⇒ 真机正常，桌面端必崩。
//
//   关键：报错**不在** Node 端转换产物里，而在**运行时**产物里 ——
//     壳 jar 在 JVM 内解密出嵌入式 dex 载荷，由 `resources/jvm/stubs-src/dalvik/system/BaseDexClassLoader.java`
//     做**运行时 dex2jar**，落到 `<cacheDir>/runtime-dex/<md5>.<rev>.jar`（全量扫描 39 个缓存 jar，
//     唯一命中 = `runtime-dex/9bf5537a788b88a867898a1da7884288.r2.jar` 的 `SoAiPanSoo.class`）。
//     该路径在 Java 侧、且本机无 JDK 无法重编 stubs ⇒ **改调用者（改写 jar 字节）够不到它**。
//
//   故采用「**给宿主类补方法**」这一条更普适的路线：
//     把 3.14.9 的 `okhttp3/RequestBody.class` 原样复制、**追加** 4 个 4.x 参数序的 static 重载，
//     每个重载**换序委托**到同类里已有的 3.x 参数序方法，打成一个小 jar，
//     由 JarSpiderBridge 把它**排在 `-cp` 最前**（父 classloader 先命中者生效）。
//     ⇒ 任何来源的调用者（Node 转换产物 / runtime-dex 产物 / 未来新增路径）、任何加载器，
//       都从父 cp 命中这个「3.14.9 超集」⇒ 一次性、无遗漏。
//
//   为什么**不**直接改 `resources/jvm/libs/okhttp-3.14.9.jar`：仓库约定是不改上游 vendored jar
//     （见 scripts/sanitize-sqlite-jar.mjs 的注释）—— 保持原 jar 可校验、可随时重下。
//   为什么**不**把 3.x 换成 4.x：4.x 需 kotlin-stdlib 且与 3.x API 差异大（一换动一片源）。
//
//   ⚠ 只补 `RequestBody.create` 这一个已知缺口（全量扫描里唯一的 okhttp 4.x 缺口）。
import { buildZip, readZipEntries, type ZipEntryData } from '../util/syncZip';
import { parseClassBytes } from './classFix';

/** 宿主类 FQN（class 文件里的斜杠写法） */
export const OKHTTP_REQUEST_BODY = 'okhttp3/RequestBody';
/** 上游 vendored jar 名（复制源；绝不就地修改它） */
export const OKHTTP_UPSTREAM_JAR = 'okhttp-3.14.9.jar';
/** 兼容 jar 名（由 scripts/gen-okhttp-compat.mjs 生成并入库） */
export const OKHTTP4_COMPAT_JAR = 'winbox-okhttp4-compat.jar';

const D = (s: string): Buffer => Buffer.from(s, 'utf8');

/**
 * 4.x 参数序描述符 → 3.x 参数序描述符（委托目标）。
 * 固定表：生成补丁方法与单测断言共用**同一份真相**，避免两处硬编码漂移。
 */
export const OKHTTP4_CREATE_DELEGATES: ReadonlyArray<readonly [string, string]> = [
  ['(Ljava/lang/String;Lokhttp3/MediaType;)Lokhttp3/RequestBody;', '(Lokhttp3/MediaType;Ljava/lang/String;)Lokhttp3/RequestBody;'],
  ['(Lokio/ByteString;Lokhttp3/MediaType;)Lokhttp3/RequestBody;', '(Lokhttp3/MediaType;Lokio/ByteString;)Lokhttp3/RequestBody;'],
  ['([BLokhttp3/MediaType;)Lokhttp3/RequestBody;', '(Lokhttp3/MediaType;[B)Lokhttp3/RequestBody;'],
  ['(Ljava/io/File;Lokhttp3/MediaType;)Lokhttp3/RequestBody;', '(Lokhttp3/MediaType;Ljava/io/File;)Lokhttp3/RequestBody;'],
];

function u2(n: number): Buffer { const b = Buffer.alloc(2); b.writeUInt16BE(n & 0xffff, 0); return b; }
function u4(n: number): Buffer { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0, 0); return b; }
const utf8Entry = (s: string): Buffer => { const b = D(s); return Buffer.concat([Buffer.from([1]), u2(b.length), b]); };

/** 常量池结束偏移（即 access_flags 起始处） */
function cpEndOffset(b: Buffer): number {
  const cpCount = b.readUInt16BE(8);
  let p = 10;
  for (let i = 1; i < cpCount; i++) {
    const tag = b[p];
    p += 1;
    if (tag === 1) { const l = b.readUInt16BE(p); p += 2 + l; }
    else if (tag === 3 || tag === 4) p += 4;
    else if (tag === 5 || tag === 6) { p += 8; i++; }
    else if (tag === 7 || tag === 8 || tag === 16 || tag === 19 || tag === 20) p += 2;
    else if (tag === 9 || tag === 10 || tag === 11 || tag === 12 || tag === 17 || tag === 18) p += 4;
    else if (tag === 15) p += 3;
    else throw new Error(`未知常量池 tag ${tag}`);
  }
  return p;
}

/** 跳过 count 个成员（field/method：access+name+desc+attrCount + 属性表） */
function skipMembers(b: Buffer, p: number, count: number): number {
  for (let i = 0; i < count; i++) {
    const attrCount = b.readUInt16BE(p + 6);
    p += 8;
    for (let a = 0; a < attrCount; a++) { const len = b.readUInt32BE(p + 2); p += 6 + len; }
  }
  return p;
}

/** 定位「方法数」字段与「方法表结束」（= 类属性表起始）的偏移 */
function methodsLayout(b: Buffer): { methodsCountOff: number; methodCount: number; methodsEndOff: number } {
  let p = cpEndOffset(b);
  p += 6; // access_flags / this_class / super_class
  const ifaceCount = b.readUInt16BE(p); p += 2 + ifaceCount * 2;
  const fieldCount = b.readUInt16BE(p); p += 2;
  p = skipMembers(b, p, fieldCount);
  const methodsCountOff = p;
  const methodCount = b.readUInt16BE(p);
  p += 2;
  p = skipMembers(b, p, methodCount);
  return { methodsCountOff, methodCount, methodsEndOff: p };
}

/**
 * 给 `okhttp3/RequestBody.class` **追加** 4.x 参数序的 static `create` 重载（换序委托到同类 3.x 方法）。
 * 返回新类字节；null = 不是该类 / 解析失败 / 已全部存在（幂等）。
 *
 * 只做**常量池追加 + 方法表追加**：既有 CP 下标不变（只增不改），既有方法体一字未动。
 * 目标类版本 ≥ 50 ⇒ 新方法体是**无分支直线代码**，按 JVM 规范缺 StackMapTable 即视为空表，合法。
 */
export function addOkHttp4OverloadsToRequestBody(input: Buffer): Buffer | null {
  let info;
  try {
    info = parseClassBytes(input);
  } catch {
    return null;
  }
  if (info.name !== OKHTTP_REQUEST_BODY) return null;

  const existing = new Set(info.methods.map((m) => `${m.name}${m.desc}`));
  const toAdd = OKHTTP4_CREATE_DELEGATES.filter(([d]) => !existing.has(`create${d}`));
  if (toAdd.length === 0) return null; // 幂等

  // 复用既有常量池项：宿主类的 Class、'create'、'Code'
  let classIdx = 0;
  let createIdx = 0;
  let codeIdx = 0;
  for (let i = 1; i < info.cp.length; i++) {
    const e = info.cp[i];
    if (!e) continue;
    if (e.tag === 7) {
      const n = info.cp[e.a as number] as { s?: string } | undefined;
      if (!classIdx && n?.s === OKHTTP_REQUEST_BODY) classIdx = i;
    } else if (e.tag === 1) {
      if (!createIdx && e.s === 'create') createIdx = i;
      if (!codeIdx && e.s === 'Code') codeIdx = i;
    }
  }
  if (!classIdx || !createIdx || !codeIdx) return null; // 形态异常 ⇒ 保守不动

  // ---- 追加常量池：每个新方法 4 项（4.x 描述符 / 3.x 描述符 / NameAndType / Methodref）----
  const oldCpCount = info.cp.length;
  let nextIdx = oldCpCount;
  const newCp: Buffer[] = [];
  const push = (e: Buffer): number => { newCp.push(e); return nextIdx++; };
  const callerDescIdx: number[] = [];
  const targetRefIdx: number[] = [];
  for (const [callerDesc, targetDesc] of toAdd) {
    const iCaller = push(utf8Entry(callerDesc));
    const iTarget = push(utf8Entry(targetDesc));
    const iNat = push(Buffer.concat([Buffer.from([12]), u2(createIdx), u2(iTarget)]));
    const iRef = push(Buffer.concat([Buffer.from([10]), u2(classIdx), u2(iNat)]));
    callerDescIdx.push(iCaller);
    targetRefIdx.push(iRef);
  }

  // ---- 追加方法表：`aload_1; aload_0; invokestatic <3.x 目标>; areturn` ----
  const newMethods = toAdd.map((_p, k) => {
    const code = Buffer.concat([Buffer.from([0x2b, 0x2a, 0xb8]), u2(targetRefIdx[k]), Buffer.from([0xb0])]);
    const body = Buffer.concat([u2(2), u2(2), u4(code.length), code, u2(0), u2(0)]);
    return Buffer.concat([u2(0x0009), u2(createIdx), u2(callerDescIdx[k]), u2(1), u2(codeIdx), u4(body.length), body]);
  });

  const cpEnd = cpEndOffset(info.buf);
  const { methodsCountOff, methodCount, methodsEndOff } = methodsLayout(info.buf);
  return Buffer.concat([
    info.buf.subarray(0, 8),
    u2(oldCpCount + newCp.length),
    info.buf.subarray(10, cpEnd),
    ...newCp,
    info.buf.subarray(cpEnd, methodsCountOff),
    u2(methodCount + newMethods.length),
    info.buf.subarray(methodsCountOff + 2, methodsEndOff),
    ...newMethods,
    info.buf.subarray(methodsEndOff),
  ]);
}

export interface OkHttp4CompatJarResult {
  /** 兼容 jar 字节；上游 jar 里找不到目标类时为 null */
  bytes: Buffer | null;
  /** 追加的方法数（0 = 上游已含 4.x 重载，无需补） */
  added: number;
}

/**
 * 由上游 okhttp jar 生成「兼容 jar」：只含**打过补丁**的 `okhttp3/RequestBody.class`。
 * 独立成一个小 jar ⇒ 排到 `-cp` 最前时只影子这一个类，其余 okhttp3 类仍由原 jar 提供。
 */
export function buildOkHttp4CompatJar(okHttpJarBytes: Buffer): OkHttp4CompatJarResult {
  let entries: ZipEntryData[];
  try {
    entries = readZipEntries(okHttpJarBytes);
  } catch {
    return { bytes: null, added: 0 };
  }
  const target = entries.find((e) => e.name === `${OKHTTP_REQUEST_BODY}.class`);
  if (!target) return { bytes: null, added: 0 };
  const patched = addOkHttp4OverloadsToRequestBody(target.bytes);
  if (!patched) return { bytes: null, added: 0 };
  const before = parseClassBytes(target.bytes).methods.length;
  const added = parseClassBytes(patched).methods.length - before;
  return { bytes: buildZip([{ name: `${OKHTTP_REQUEST_BODY}.class`, bytes: patched }], { deflate: true }), added };
}
