// tests/imageSize.spec.ts — 「豆瓣图按显示框降到够用档位」纯函数（新增，内存专项 (b)）
import { describe, it, expect } from 'vitest';
import { sizedImageUrl } from '../src/renderer/lib/imageSize';

const M = 'https://img3.doubanio.com/view/photo/m_ratio_poster/public/p2932103692.jpg';
const L = 'https://img9.doubanio.com/view/photo/l/public/p2934583425.jpg';
const S = 'https://img1.doubanio.com/view/photo/s_ratio_poster/public/p2916835424.jpg';
const RELAY = (inner: string) => `http://127.0.0.1:9978/img?u=${encodeURIComponent(inner)}&ref=${encodeURIComponent('https://m.douban.com/')}`;

describe('sizedImageUrl — 只降不升，按「盒宽 × DPR」选够用的最小档', () => {
  it('m(540) + 200 盒 @1.5 ⇒ 需 270 ⇒ 降到 s_ratio_poster', () => {
    expect(sizedImageUrl(M, 200, 1.5)).toBe('https://img3.doubanio.com/view/photo/s_ratio_poster/public/p2932103692.jpg');
  });

  it('m(540) + 300 盒 @1.5 ⇒ 需 405 ⇒ 保持 m（不动）', () => {
    expect(sizedImageUrl(M, 300, 1.5)).toBe(M);
  });

  it('l(1080) + 200 盒 @1.5 ⇒ 降到 s；l(1080) + 300 盒 @1.5 ⇒ 降到 m', () => {
    expect(sizedImageUrl(L, 200, 1.5)).toBe('https://img9.doubanio.com/view/photo/s/public/p2934583425.jpg');
    expect(sizedImageUrl(L, 300, 1.5)).toBe('https://img9.doubanio.com/view/photo/m/public/p2934583425.jpg');
  });

  it('只降不升：s(270) + 大框 @2 ⇒ 仍是 s（绝不升成 m/l）', () => {
    expect(sizedImageUrl(S, 600, 2)).toBe(S);
  });

  it('raw 视同 1080 档 ⇒ 小框降到 s（且不保留 _ratio_ 后缀）', () => {
    expect(sizedImageUrl('https://img2.doubanio.com/view/photo/raw/public/p1.jpg', 200, 1.5))
      .toBe('https://img2.doubanio.com/view/photo/s/public/p1.jpg');
  });

  it('DPR 2 的小框不降过头：m(540) + 200 盒 @2 ⇒ 需 360 ⇒ 保持 m', () => {
    expect(sizedImageUrl(M, 200, 2)).toBe(M);
  });
});

describe('sizedImageUrl — 不该动的原样返回', () => {
  it('签名主机（-sign-）不动：路径被签名覆盖，改路径必 403', () => {
    const signed = 'https://qnmob3-sign.doubanio.com/view/photo/m_ratio_poster/public/p1.jpg?x=1';
    expect(sizedImageUrl(signed, 200, 1.5)).toBe(signed);
  });

  it('带查询串的地址一律不动（可能是签名/追踪参数，不猜）', () => {
    const withSign = 'https://img1.doubanio.com/view/photo/m_ratio_poster/public/p1.jpg?sign=abcdef';
    expect(sizedImageUrl(withSign, 200, 1.5)).toBe(withSign);
    const withAny = 'https://img1.doubanio.com/view/photo/m_ratio_poster/public/p1.jpg?spm=a1z';
    expect(sizedImageUrl(withAny, 200, 1.5)).toBe(withAny);
  });

  it('非豆瓣图床（TMDB / 源站）不动', () => {
    expect(sizedImageUrl('https://image.tmdb.org/t/p/w500/abc.jpg', 200, 1.5)).toBe('https://image.tmdb.org/t/p/w500/abc.jpg');
    expect(sizedImageUrl('https://cdn.example.com/poster.jpg', 200, 1.5)).toBe('https://cdn.example.com/poster.jpg');
  });

  it('豆瓣但不在 /view/<kind>/<size>/ 路径下（如老式直链）不动', () => {
    expect(sizedImageUrl('https://img9.doubanio.com/a.jpg', 200, 1.5)).toBe('https://img9.doubanio.com/a.jpg');
  });

  it('空串 / 非法地址不动', () => {
    expect(sizedImageUrl('', 200, 1.5)).toBe('');
    expect(sizedImageUrl('not-a-url', 200, 1.5)).toBe('not-a-url');
  });
});

describe('sizedImageUrl — 本地 /img 中继形式（主进程产出的都是这种）', () => {
  it('只换内层 u，其余参数（ref 等）原样保留', () => {
    const out = sizedImageUrl(RELAY(M), 200, 1.5);
    const u = new URL(out);
    expect(u.pathname).toBe('/img');
    expect(u.searchParams.get('ref')).toBe('https://m.douban.com/');
    expect(u.searchParams.get('u')).toBe('https://img3.doubanio.com/view/photo/s_ratio_poster/public/p2932103692.jpg');
  });

  it('内层不是豆瓣图（或不需要降）⇒ 整串原样返回（引用相同）', () => {
    const relayTmdb = RELAY('https://image.tmdb.org/t/p/w500/abc.jpg');
    expect(sizedImageUrl(relayTmdb, 200, 1.5)).toBe(relayTmdb);
    const relayBig = RELAY(M);
    expect(sizedImageUrl(relayBig, 300, 1.5)).toBe(relayBig);
  });
});
