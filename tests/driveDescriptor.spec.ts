// tests/driveDescriptor.spec.ts — 「盘搜/免转存」家族 `<provider>@<base64(JSON)>` episode id 映射
// 实测来源：.tmp/netdisk-probe.cjs 跑 8 订阅（嗷呜 csp_某壳源Amns 等）时发现——id 形如
//   quark@eyJmaWxlSWQiOi… {fileId,fileToken,shareId,stoken,format}
//   uc@…（同构）· baidu@eyJzaGFyZUlkIjo… {shareId,fileId,uk,randsk,format}
// 此前应用不认 → 原样交给蜘蛛 → 蜘蛛鉴权链失败（「未登录」）。本 spec 守住解码与三条映射。
import { describe, it, expect } from 'vitest';
import { parseDriveDescriptor, unsupportedNestedProvider } from '../src/main/net/driveDescriptor';
import { extractQuarkShare, extractEpisodeFid, extractEpisodeName, isQuarkSharePlay } from '../src/main/net/quarkTransfer';
import { extractUcShare, isUcSharePlay } from '../src/main/net/ucTransfer';
import { extractBaiduSharedFile } from '../src/main/net/baiduTransfer';

const enc = (o: unknown, urlSafe = false): string => {
  const b = Buffer.from(JSON.stringify(o)).toString('base64');
  return urlSafe ? b.replace(/\+/g, '-').replace(/\//g, '_') : b;
};
const QUARK = { fileId: 'a'.repeat(32), fileToken: 'b'.repeat(32), shareId: '44762cabcdef', stoken: 's'.repeat(44), format: 'mp4' };
const UC = { fileId: 'c'.repeat(32), fileToken: 'd'.repeat(32), shareId: '99416cabcdefg', stoken: 't'.repeat(44), format: 'mp4' };
const BAIDU = { shareId: '41170612345', fileId: '1110220000000000', uk: '1101351234567', randsk: 'e9BN'.repeat(12), format: 'mp4' };

describe('parseDriveDescriptor — <provider>@<base64(JSON)>', () => {
  it('三种 provider 前缀 + 字段可解', () => {
    const q = parseDriveDescriptor('quark@' + enc(QUARK));
    expect(q?.provider).toBe('quark');
    expect(String(q?.data.fileId)).toHaveLength(32);
    const u = parseDriveDescriptor('uc@' + enc(UC));
    expect(u?.provider).toBe('uc');
    const b = parseDriveDescriptor('baidu@' + enc(BAIDU));
    expect(b?.provider).toBe('baidu');
    expect(String(b?.data.randsk)).toBe(BAIDU.randsk);
  });

  it('URL-safe base64（-_）同样可解', () => {
    expect(parseDriveDescriptor('quark@' + enc(QUARK, true))?.provider).toBe('quark');
  });

  it('非描述符 / 坏 base64 / 坏 JSON → null（不抛）', () => {
    expect(parseDriveDescriptor('')).toBeNull();
    expect(parseDriveDescriptor('pan.quark.cn/s/abc')).toBeNull();
    expect(parseDriveDescriptor('https://x/y.m3u8')).toBeNull();
    expect(parseDriveDescriptor('quark@@@@')).toBeNull();
    expect(parseDriveDescriptor('magnet@' + enc({ a: 1 }))).toBeNull();
    expect(parseDriveDescriptor('quark@' + enc('not-an-object'))).toBeNull();
  });
});

describe('三条原生通道的映射（免转存凭据来自描述符）', () => {
  it('quark 描述符 → extractQuarkShare(sId=shareId) / fid=fileId', () => {
    const id = 'quark@' + enc(QUARK);
    expect(isQuarkSharePlay(id, '夸克')).toBe(true);
    expect(extractQuarkShare(id, '夸克')).toEqual({ sId: QUARK.shareId, passcode: '' });
    expect(extractEpisodeFid(id)).toBe(QUARK.fileId);
  });

  it('uc 描述符 → isUcSharePlay / extractUcShare(pwdId=shareId)', () => {
    const id = 'uc@' + enc(UC);
    expect(isUcSharePlay(id)).toBe(true);
    expect(extractUcShare(id, '优汐')).toEqual({ pwdId: UC.shareId, passcode: '' });
    expect(extractEpisodeFid(id)).toBe(UC.fileId);
  });

  it('baidu 描述符 → extractBaiduSharedFile（含 sekey=randsk）', () => {
    const f = extractBaiduSharedFile('baidu@' + enc(BAIDU));
    expect(f).toMatchObject({ shareId: BAIDU.shareId, uk: BAIDU.uk, fsid: BAIDU.fileId, sekey: BAIDU.randsk });
  });

  it('原有 URL / JSON 形态不回归', () => {
    expect(isQuarkSharePlay('https://pan.quark.cn/s/abcdef123456')).toBe(true);
    expect(isUcSharePlay('https://drive.uc.cn/s/abc123')).toBe(true);
    expect(extractBaiduSharedFile('{"share_id":"41170612345","uk":"1101351234567","fs_id":"1110220000000000","seKey":"e9BN"}'))
      .toMatchObject({ shareId: '41170612345', uk: '1101351234567', fsid: '1110220000000000', sekey: 'e9BN' });
    expect(extractQuarkShare('夸克原画', '夸克')).toBeNull(); // 非分享文本
  });
});

// （某第三方源「夸克原画」播不了）：**嵌套信封** ——
//   `base64(JSON{a:<网盘商>, b:<内层 JSON 字符串>, c,d})`，真实凭据在内层短键（实测解码确认）。
const NESTED_QUARK = {
  a: 'quark',
  b: JSON.stringify({ a: QUARK.fileId, b: QUARK.fileToken, c: QUARK.shareId, d: QUARK.stoken, e: 'EP01.mp4' }),
  c: 'original',
  d: '[1.1GB]EP01.mp4【show】',
};

describe('嵌套信封 base64(JSON{a:<商>,b:<内层>})', () => {
  it('quark 内层短键归一到长键（a→fileId, b→fileToken, c→shareId, d→stoken, e→name）', () => {
    const d = parseDriveDescriptor(enc(NESTED_QUARK));
    expect(d?.provider).toBe('quark');
    expect(String(d?.data.fileId)).toBe(QUARK.fileId);
    expect(String(d?.data.fileToken)).toBe(QUARK.fileToken);
    expect(String(d?.data.shareId)).toBe(QUARK.shareId);
    expect(String(d?.data.stoken)).toBe(QUARK.stoken);
    expect(String(d?.data.name)).toBe('EP01.mp4');
  });

  it('quark 嵌套信封 → 零改动复用原生夸克三条映射', () => {
    const id = enc(NESTED_QUARK);
    expect(isQuarkSharePlay(id, '夸克原画')).toBe(true);
    expect(extractQuarkShare(id, '夸克原画')).toEqual({ sId: QUARK.shareId, passcode: '' });
    expect(extractEpisodeFid(id)).toBe(QUARK.fileId);
    expect(extractEpisodeName(id)).toBe('EP01.mp4');
  });

  it('thunder 信封：解出 provider 但不误入夸克；unsupportedNestedProvider 命中', () => {
    const id = enc({
      a: 'thunder',
      b: JSON.stringify({ a: 'X'.repeat(26), b: 'Y'.repeat(26), c: 'Z'.repeat(60), d: 'file.mp4', e: 'Q'.repeat(26) }),
      c: 'original',
      d: 'name',
    });
    expect(parseDriveDescriptor(id)?.provider).toBe('thunder');
    expect(isQuarkSharePlay(id, '迅雷原画')).toBe(false);
    expect(unsupportedNestedProvider(id)).toBe('thunder');
    expect(unsupportedNestedProvider(enc(NESTED_QUARK))).toBe('');
  });

  it('非信封 base64 / 缺内层 / 未知商 → null（不误判、不回归）', () => {
    expect(parseDriveDescriptor(enc(['a', 'b']))).toBeNull(); // 外层不是对象
    expect(parseDriveDescriptor(enc({ a: 'quark' }))).toBeNull(); // 缺内层 b
    expect(parseDriveDescriptor(enc({ a: 'magnet', b: '{}' }))).toBeNull(); // 未知商
    expect(parseDriveDescriptor('pan.quark.cn/s/abcdef123456')).toBeNull(); // 含 : 非纯 base64
    expect(unsupportedNestedProvider('pan.quark.cn/s/abcdef123456')).toBe('');
  });
});
