// src/main/net/ucTvToken.ts — UC TV Token（非会员 UC 原画）扫码授权协议（桌面端复刻）。
//
// 背景：某影视壳类源族 jar 的 UC 取流在
//   `MyPan$UcMineProvider.player()` 里按 `member_type` 分流：
//     · NORMAL（非高会）→ 读 SharedPreferences `NewWexFnw_preferences` 的
//       **`Wex_ucpan_token`**（+ `Wex_ucpan_device_id`），空则抛
//       「非高会需要配置 UC TV Token，请到配置中心扫码获取」；
//     · 该 token = **UC 电视端开放平台 OAuth 的 token 对 JSON**（含 `access_token`/`refresh_token`），
//       不是 cookie 派生值（实测把 `__puus` 塞进去仍报同一条错）。
//   桌面端 App 没有 jar 的「配置中心」扫码页，故这里**复刻 jar 的扫码流**产出该 token。
//
// 协议（对照 `com.github.catvod.spider.merge.t0.h` 实现）：
//   1) 取码： GET  https://open-api-drive.uc.cn/oauth/authorize?req_id=…&…&qrcode=1&qr_width=460&qr_height=460
//             → { status:0, req_id, query_token, qr_data(base64 PNG) }
//      请求头必须带 jar 的「公参」签名（见 ucTvHeaders）：
//        x-pan-tm    = 毫秒时间戳字符串
//        x-pan-token = sha256hex(`${method}&${path}&${ts}${UCTV_SECRET}`)
//        x-pan-client-id = 5acf882d27b74502b7040b0c65519aa7
//      （`g()` 里还算了 md5(device_id+ts) 作为返回值第 3 项，仅用作后续 /file 请求的 `req_id` 参数）
//   2) 轮询： GET  .../oauth/code?req_id=…&…&query_token=…
//             → status!=0 & errno=11003「用户未确认授权」= 继续等；status=0 → { code }
//   3) 兑换： POST http://api.extscreen.com/ucdrive/token
//            body = {req_id, app_ver:"1.6.8", device_id, device_brand:"Xiaomi", platform:"tv", …,
//                    channel:"UCTVOFFICIALWEB", code}
//             → { code:200, message:"OK", data:{ status, errno, access_token, refresh_token, expires_in, scope } }
//       **整段响应体原样**即 `Wex_ucpan_token` 的值（jar 侧 `new JSONObject(v).optJSONObject("data")`
//       再取 access_token/refresh_token；也让 jar 在 access_token 过期时用 refresh_token 自动续期）。
import { createHash, randomUUID } from 'node:crypto';

/** jar 内置的签名盐（对应 `merge.t0.h.g`） */
export const UCTV_SECRET = '&l3srvtd7p42l0d0x1u8d7yc8ye9kki4d';
/** UC 电视端开放平台 client_id（对应 `merge.t0.h`） */
export const UCTV_CLIENT_ID = '5acf882d27b74502b7040b0c65519aa7';
/** 取码/轮询请求头固定 User-Agent（jar 内置） */
export const UCTV_UA =
  'Mozilla/5.0 (Linux; U; Android 12; zh-cn; V2238A Build/V417IR) AppleWebKit/533.1 (KHTML, like Gecko) Mobile Safari/533.1';

const AUTHORIZE_URL = 'https://open-api-drive.uc.cn/oauth/authorize';
const CODE_URL = 'https://open-api-drive.uc.cn/oauth/code';
const EXCHANGE_URL = 'http://api.extscreen.com/ucdrive/token';

/** 设备指纹尾巴（jar 写死的 Xiaomi 电视端参数；取码与轮询必须一致） */
const DEVICE_TAIL =
  '&device_brand=Xiaomi&platform=tv&device_name=22081212C&device_model=22081212C' +
  '&build_device=star2qltechn&build_product=22081212C&device_gpu=Adreno (TM) 640' +
  '&activity_rect=%7B%7D&channel=UCTVOFFICIALWEB';

/** 兑换请求体的设备指纹字段（与 DEVICE_TAIL 同源，拆成 JSON 键） */
const DEVICE_BODY: Record<string, string> = {
  device_brand: 'Xiaomi',
  platform: 'tv',
  device_name: '22081212C',
  device_model: '22081212C',
  build_device: 'star2qltechn',
  build_product: '22081212C',
  device_gpu: 'Adreno (TM) 640',
  activity_rect: '%7B%7D',
  channel: 'UCTVOFFICIALWEB',
};

/** 可注入的 fetch（单测用；默认 globalThis.fetch，与 main/net 其它模块一致） */
export type Fetcher = typeof globalThis.fetch;

/** 设备 ID：jar 侧缺省生成 `md5(String.valueOf(currentTimeMillis()))`（`UcMineProvider.d()`），此处同口径 */
export function ucTvDeviceId(nowMs: number = Date.now()): string {
  return createHash('md5').update(String(nowMs), 'utf8').digest('hex');
}

/** `x-pan-token`：sha256hex(`${method}&${path}&${ts}${UCTV_SECRET}`)（对应 `merge.t0.h.g`） */
export function ucTvSign(method: string, path: string, tsMs: number | string): string {
  const ts = String(tsMs);
  return createHash('sha256').update(`${method}&${path}&${ts}${UCTV_SECRET}`, 'utf8').digest('hex');
}

/** 取码/轮询的完整请求头（公参签名） */
export function ucTvHeaders(method: string, path: string, tsMs: number = Date.now()): Record<string, string> {
  return {
    'User-Agent': UCTV_UA,
    'x-pan-tm': String(tsMs),
    'x-pan-token': ucTvSign(method, path, tsMs),
    'content-type': 'text/plain;charset=UTF-8',
    'x-pan-client-id': UCTV_CLIENT_ID,
  };
}

/** 一轮取码的结果 */
export interface UcTvQrSession {
  /** 本次会话的 req_id（轮询/兑换复用） */
  reqId: string;
  /** 服务端返回的 query_token（轮询必须回传） */
  queryToken: string;
  /** 二维码图片 data URL（服务端直接出 PNG） */
  imageDataUrl: string;
}

/** 轮询状态：wait=未确认 / ok=已授权（含 code） / expired=二维码失效 / error=其它错误 */
export interface UcTvPollResult {
  state: 'wait' | 'ok' | 'expired' | 'error';
  /** state==='ok' 时的授权码 */
  code?: string;
  /** 给用户看的提示 */
  hint?: string;
}

/** 兑换结果 */
export interface UcTvExchangeResult {
  ok: boolean;
  /** ok 时 = extScreen 响应体原文（即 `Wex_ucpan_token` 应存的值） */
  token?: string;
  hint?: string;
}

async function readJson(res: Response): Promise<Record<string, unknown> | null> {
  try {
    const text = await res.text();
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** 第 1 步：生成二维码（req_id + query_token + PNG data URL） */
export async function ucTvAuthorize(
  deviceId: string,
  fetcher: Fetcher = globalThis.fetch,
  tsMs: number = Date.now(),
): Promise<UcTvQrSession> {
  const reqId = randomUUID();
  const url =
    `${AUTHORIZE_URL}?req_id=${encodeURIComponent(reqId)}` +
    `&access_token=&app_ver=1.6.8&device_id=${encodeURIComponent(deviceId)}` +
    DEVICE_TAIL +
    `&auth_type=code&client_id=${UCTV_CLIENT_ID}&scope=netdisk&qrcode=1&qr_width=460&qr_height=460`;
  const res = await fetcher(url, { headers: ucTvHeaders('GET', '/oauth/authorize', tsMs) });
  const json = await readJson(res);
  const status = Number(json?.status ?? -1);
  const qrData = typeof json?.qr_data === 'string' ? json.qr_data.replace(/[\r\n]/g, '') : '';
  const queryToken = typeof json?.query_token === 'string' ? json.query_token : '';
  if (status !== 0 || !qrData || !queryToken) {
    const info = typeof json?.error_info === 'string' ? json.error_info : `HTTP ${res.status}`;
    throw new Error(`UC TV Token 取码失败：${info}`);
  }
  return { reqId, queryToken, imageDataUrl: `data:image/png;base64,${qrData}` };
}

/** 第 2 步：轮询扫码确认（拿授权码 code） */
export async function ucTvPollCode(
  reqId: string,
  queryToken: string,
  deviceId: string,
  fetcher: Fetcher = globalThis.fetch,
  tsMs: number = Date.now(),
): Promise<UcTvPollResult> {
  const url =
    `${CODE_URL}?req_id=${encodeURIComponent(reqId)}` +
    `&access_token=&app_ver=1.6.8&device_id=${encodeURIComponent(deviceId)}` +
    DEVICE_TAIL +
    `&client_id=${UCTV_CLIENT_ID}&scope=netdisk&query_token=${encodeURIComponent(queryToken)}`;
  const res = await fetcher(url, { headers: ucTvHeaders('GET', '/oauth/code', tsMs) });
  const json = await readJson(res);
  if (!json) return { state: 'error', hint: `UC TV Token 轮询失败（HTTP ${res.status}）` };
  const status = Number(json.status ?? -1);
  const code = typeof json.code === 'string' ? json.code : '';
  if (status === 0 && code) return { state: 'ok', code };
  const errno = Number(json.errno ?? 0);
  const info = typeof json.error_info === 'string' ? json.error_info : '';
  // 11003 = 用户尚未在手机上确认授权 → 继续等待
  if (errno === 11003 || /未确认/.test(info)) return { state: 'wait' };
  if (/过期|失效/.test(info)) return { state: 'expired', hint: info || '二维码已过期，请重新获取' };
  return { state: 'error', hint: info || `UC TV Token 轮询异常（status=${status}）` };
}

/** 第 3 步：用授权码兑换 token 对（返回值 = 应写入 `Wex_ucpan_token` 的原文） */
export async function ucTvExchange(
  reqId: string,
  code: string,
  deviceId: string,
  fetcher: Fetcher = globalThis.fetch,
): Promise<UcTvExchangeResult> {
  const body = JSON.stringify({ req_id: reqId, app_ver: '1.6.8', device_id: deviceId, ...DEVICE_BODY, code });
  let text = '';
  let httpStatus = 0;
  try {
    const res = await fetcher(EXCHANGE_URL, {
      method: 'POST',
      headers: {
        'User-Agent': UCTV_UA,
        'Content-Type': 'application/json; charset=utf-8',
        Host: 'api.extscreen.com',
      },
      body,
    });
    httpStatus = res.status;
    text = await res.text();
  } catch (e) {
    return { ok: false, hint: `UC TV Token 兑换请求失败：${(e as Error).message}` };
  }
  let json: Record<string, unknown> | null = null;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    /* 非 JSON */
  }
  const data = (json?.data ?? null) as Record<string, unknown> | null;
  const access = typeof data?.access_token === 'string' ? data.access_token : '';
  const refresh = typeof data?.refresh_token === 'string' ? data.refresh_token : '';
  if (access && refresh) return { ok: true, token: text };
  const info =
    (typeof data?.error_info === 'string' && data.error_info) ||
    (typeof json?.message === 'string' && json.message) ||
    `HTTP ${httpStatus}`;
  return { ok: false, hint: `UC TV Token 兑换失败：${info}` };
}
