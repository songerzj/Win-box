// src/main/net/driveDescriptor.ts — 「盘搜/免转存」家族（部分壳类源）的 episode id 描述符解码。
//
//   部分订阅里的壳类蜘蛛，其详情 `vod_play_url` 的集地址写成
//   **`<provider>@<base64url(JSON)>`**，例如：
//     · `quark@eyJmaWxlSWQiOi…` = `{fileId(32hex), fileToken(32), shareId(12 = pwd_id), stoken(44), format}`
//     · `uc@eyJmaWxlSWQiOi…`    = 与 quark 同构（UC 的 pwd_id 长度不同）
//     · `baidu@eyJzaGFyZUlkIjo…`= `{shareId(数字 share_id), fileId(数字 fs_id), uk(数字), randsk(=BDCLND/seKey), format}`
//   这些字段**就是原生免转存所需的全部凭据**（夸克/UC 的 stoken+fileToken、百度的 randsk）。
//   此前应用不认这个形态 → 原样交给蜘蛛，蜘蛛走自己的鉴权链失败（「未登录，请先设置 cookie」）。
//
//   本模块只做「解码」，路由到既有原生通道由各 net 模块负责：
//     quark → quarkTransfer（免转存优先）/ uc → ucResolveShare / baidu → baiduResolveSharedFile。
//
// （实测解码确认）：另有**嵌套信封**形态 ——
//   `base64(JSON)`，外层 `{a:<网盘商>, b:<内层 JSON 字符串>, c,d}`，真实凭据在内层：
//     {
//       "a": "quark",                                  // 网盘商（quark / thunder / uc / baidu …）
//       "b": "{\"a\":\"<32hex fileId>\",\"b\":\"<32hex fileToken>\",\"c\":\"<12hex shareId/pwd_id>\",
//              \"d\":\"<stoken base64>\",\"e\":\"<文件名>\"}",
//       "c": "original", "d": "[1.1GB]kiDnap…"          // c=档位标记、d=显示名（界面用）
//     }
//   内层短键与既有长键一一对应（实测夸克线，长度/形态与既有描述符同构）。
//   解出后**归一到长键** ⇒ 既有 `extractQuarkShare/extractEpisodeFid/extractUcShare` 无需改动即可命中。
export interface DriveDescriptor {
  /** 归一后的 provider 键（quark / uc / baidu / 115 / ali / thunder） */
  provider: string;
  /** 反序列化后的描述对象（字段名以蜘蛛原样为准；嵌套信封已把短键补为长键） */
  data: Record<string, unknown>;
}

/** 描述符前缀允许的 provider 键（与 episode id 的 `<key>@` 一致）；base64 允许 +/ / = 三种字符 */
const DESCRIPTOR_KEY_RE = /^(quark|uc|baidu|115|ali|alipan)@([A-Za-z0-9_\-+/=]+)$/;

/** 嵌套信封外层 `a` 允许的网盘商（含桌面端暂不支持的 thunder，供上层给出明确提示） */
const NESTED_PROVIDERS = new Set(['quark', 'uc', 'baidu', '115', 'ali', 'alipan', 'thunder']);

/** 嵌套信封内层短键 → 既有长键（实测：quark/uc 同构）。仅对已确认的商做映射，其余保留原样。 */
const NESTED_SHORT_KEY_MAP: Record<string, Record<string, string>> = {
  quark: { a: 'fileId', b: 'fileToken', c: 'shareId', d: 'stoken', e: 'name' },
  uc: { a: 'fileId', b: 'fileToken', c: 'shareId', d: 'stoken', e: 'name' },
};

/** 纯 base64（兼容标准 +/ 与 URL-safe -_，含 `=` 填充）；非该形态直接不试嵌套解码 */
const BARE_B64_RE = /^[A-Za-z0-9_\-+/=]+$/;

/**
 * 解码**嵌套信封** `base64(JSON{a:<商>, b:<内层 JSON 字符串>})`；非该形态返回 null（绝不抛）。
 * 内层按商把短键归一到长键；外层 `d`（显示名）在内层无 `e` 时兜底为 `name`。
 */
function decodeNestedEnvelope(raw: string): DriveDescriptor | null {
  const s = raw.trim();
  if (!s || s.includes('@') || !BARE_B64_RE.test(s)) return null;
  let outer: unknown;
  try {
    const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
    outer = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
  } catch {
    return null;
  }
  if (!outer || typeof outer !== 'object' || Array.isArray(outer)) return null;
  const o = outer as Record<string, unknown>;
  const prov = typeof o.a === 'string' ? o.a.trim().toLowerCase() : '';
  const innerRaw = o.b;
  if (!prov || !NESTED_PROVIDERS.has(prov)) return null;
  if (typeof innerRaw !== 'string' || !innerRaw.trim()) return null;
  let inner: Record<string, unknown> | null = null;
  try {
    const v = JSON.parse(innerRaw) as unknown;
    if (v && typeof v === 'object' && !Array.isArray(v)) inner = v as Record<string, unknown>;
  } catch {
    inner = null;
  }
  if (!inner) return null;
  const key = prov === 'alipan' ? 'ali' : prov;
  const data: Record<string, unknown> = { ...inner }; // 保留短键（不影响长键检索，便于排障）
  const map = NESTED_SHORT_KEY_MAP[key];
  if (map) {
    for (const [short, long] of Object.entries(map)) {
      if (data[long] === undefined && inner[short] !== undefined) data[long] = inner[short];
    }
  }
  if (data.name === undefined && typeof o.d === 'string' && o.d.trim()) data.name = o.d.trim();
  return { provider: key, data };
}

/**
 * 解析 episode id 里的网盘描述符；非描述符返回 null。
 * ① `<provider>@<base64(JSON)>`（盘搜/免转存家族）；
 * ② **嵌套信封** `base64(JSON{a,b})`（实测夸克线）。
 * base64 同时兼容 `-_` 与 `+/`；解码/JSON 失败一律返回 null（绝不抛）。
 */
export function parseDriveDescriptor(id: string): DriveDescriptor | null {
  const s = String(id || '').trim();
  const m = DESCRIPTOR_KEY_RE.exec(s);
  if (m) {
    try {
      const b64 = m[2].replace(/-/g, '+').replace(/_/g, '/');
      const o = JSON.parse(Buffer.from(b64, 'base64').toString('utf8')) as unknown;
      if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
      const key = m[1] === 'alipan' ? 'ali' : m[1];
      return { provider: key, data: o as Record<string, unknown> };
    } catch {
      return null;
    }
  }
  return decodeNestedEnvelope(s);
}

/**
 * 该 id 是否为**嵌套信封**且网盘商桌面端**暂不支持**（如 thunder / 115 / ali）。
 * 返回 provider 键（无则空串）—— playInner 据此直接给出明确提示，不再原样丢给蜘蛛。
 */
export function unsupportedNestedProvider(id: string): string {
  const d = decodeNestedEnvelope(String(id || ''));
  if (!d) return '';
  return /^(quark|uc|baidu)$/.test(d.provider) ? '' : d.provider;
}

/** 从描述对象里取第一个非空字符串字段（多字段名兼容：fileId / fid / fs_id …） */
export function descriptorField(data: Record<string, unknown>, ...names: string[]): string {
  for (const n of names) {
    const v = data[n];
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  }
  return '';
}
