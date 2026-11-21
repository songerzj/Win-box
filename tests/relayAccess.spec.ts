// tests/relayAccess.spec.ts — 播放头去浏览器专属头（中继回源 403 根因）
import { describe, it, expect } from 'vitest';
import { withoutBrowserHeaders } from '../src/engine/util/relayAccess';

describe('withoutBrowserHeaders', () => {
  it('大小写不敏感删除 Origin 与全部 Sec-Fetch-*', () => {
    const input = {
      Origin: 'https://source.example',
      'sec-fetch-mode': 'cors',
      'Sec-Fetch-Site': 'cross-site',
      'SEC-FETCH-DEST': 'empty',
      'User-Agent': 'CatVod/1.0',
    };
    expect(withoutBrowserHeaders(input)).toEqual({ 'User-Agent': 'CatVod/1.0' });
  });

  it('小写 origin 同样被删除', () => {
    expect(withoutBrowserHeaders({ origin: 'https://source.example', accept: '*/*' }))
      .toEqual({ accept: '*/*' });
  });

  it('保留鉴权/防盗链头：UA / Referer / Cookie / Authorization', () => {
    const input = {
      'User-Agent': 'Mozilla/5.0',
      Referer: 'https://source.example/play',
      Cookie: 'sid=abc; sig=xyz',
      Authorization: 'Bearer token',
    };
    expect(withoutBrowserHeaders(input)).toEqual(input);
  });

  it('空对象返回空对象', () => {
    expect(withoutBrowserHeaders({})).toEqual({});
  });

  it('无头输入（null / undefined）返回空对象且不抛错', () => {
    expect(withoutBrowserHeaders(null)).toEqual({});
    expect(withoutBrowserHeaders(undefined)).toEqual({});
  });

  it('不改入参，返回值是新对象', () => {
    const input = { Origin: 'https://source.example', Referer: 'https://source.example/' };
    const out = withoutBrowserHeaders(input);
    expect(out).not.toBe(input);
    expect(input).toEqual({ Origin: 'https://source.example', Referer: 'https://source.example/' });
    expect(out).toEqual({ Referer: 'https://source.example/' });
  });
});
