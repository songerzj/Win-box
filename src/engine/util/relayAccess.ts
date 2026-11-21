// src/engine/util/relayAccess.ts
// 纯函数：从播放请求头里剥离「浏览器专属」头，避免本机中继把它们带给上游。
//
// 成因：蜘蛛常把源站请求头（Origin / Sec-Fetch-Mode / Sec-Fetch-Site …）一并塞进播放头；
// 播放器再原样转发到本机 127.0.0.1:9978 中继，中继若照单全收回源，上游 CDN 会把它
// 判定成「浏览器跨域请求」而返回 403（明明同一个 UA/Referer/Cookie 直连是能播的）。
// 这些头只描述「浏览器页面上下文」，对中继/播放器毫无意义，必须在回源前删掉。
//
// 红线：只删浏览器专属头。User-Agent / Referer / Cookie / Authorization 是源站鉴权与
// 防盗链真正依赖的头，必须原样保留 —— 删了它们才是「修一个 403 造十个 403」。
// 刻意不做 SSRF 私网校验与令牌机制（那是第二批范围），本文件保持零副作用、零 electron 依赖。

/**
 * 判断一个头名是否属于「浏览器专属」：大小写不敏感的 `origin` 与所有 `sec-fetch-*`。
 *
 * @param name 头名（大小写任意）。
 * @returns 需要剥离时返回 true。
 */
function isBrowserOnlyHeader(name: string): boolean {
  const key = name.toLowerCase();
  return key === 'origin' || key.startsWith('sec-fetch-');
}

/**
 * 剥离 Origin / Sec-Fetch-*，保留 UA / Referer / Cookie / Authorization 等全部其它头。
 * 大小写不敏感；不修改入参，返回新对象，键名与插入顺序保持不变。
 *
 * 入参形态：本仓播放头在中继里统一是 `Record<string, string>` 普通对象
 * （见 LocalProxyServer 的 safeProxyRequestHeaders / decodeProxyHeaders），故只支持该形态；
 * Headers 实例或数组值在到达这里之前已被规范化，无需额外分支。
 *
 * @param headers 请求头对象；null / undefined 视为空对象。
 * @returns 剥离后的新对象。
 */
export function withoutBrowserHeaders<T>(
  headers: Readonly<Record<string, T>> | null | undefined,
): Record<string, T> {
  const out: Record<string, T> = {};
  if (!headers) return out;
  for (const name of Object.keys(headers)) {
    if (isBrowserOnlyHeader(name)) continue;
    out[name] = headers[name];
  }
  return out;
}
