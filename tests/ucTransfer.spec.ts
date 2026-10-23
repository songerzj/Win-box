// tests/ucTransfer.spec.ts — UC 解链的纯函数（新增）
import { describe, it, expect, vi, afterEach } from 'vitest';
import { isUcSharePlay, extractUcShare, ucResolveShare, validateUcMediaUrl } from '../src/main/net/ucTransfer';

afterEach(() => vi.unstubAllGlobals());

describe('isUcSharePlay', () => {
  it('识别 UC 分享链接', () => {
    expect(isUcSharePlay('https://drive.uc.cn/s/2c66665853b34?public=1')).toBe(true);
    expect(isUcSharePlay('https://drive.uc.cn/s/7c11fbdfacd74')).toBe(true);
    expect(isUcSharePlay('DRIVE.UC.CN/s/AbC-123_x')).toBe(true);
  });
  it('非 UC 分享不误判', () => {
    expect(isUcSharePlay('https://pan.quark.cn/s/abc123')).toBe(false);
    expect(isUcSharePlay('https://pan.baidu.com/s/1UpGhlvKjxz18uGbCigq')).toBe(false);
    expect(isUcSharePlay('https://drive.uc.cn/account/info')).toBe(false);
    expect(isUcSharePlay('')).toBe(false);
  });
});

describe('extractUcShare', () => {
  it('按明确 UC 线路解析某壳源复合选集，不误识别其他提供商', () => {
    const id = '03~4K.mp4[1.01GB]__' + 'a'.repeat(32) + '+11adf8105c314+' + 'b'.repeat(32);
    expect(extractUcShare(id, 'UC无限#5')).toEqual({ pwdId: '11adf8105c314', passcode: '' });
    expect(extractUcShare(id, '优汐无限1')).toEqual({ pwdId: '11adf8105c314', passcode: '' });
    expect(extractUcShare(id, '夸克无限#4')).toBeNull();
    expect(extractUcShare(id)).toBeNull();
  });
  it('明确 UC 线路的 sId/fid 描述不再误判成夸克，但无线路上下文不猜', () => {
    const d = JSON.stringify({ sId: 'uc-share-1', fid: 'file-2', file_name: '02.mkv' });
    expect(extractUcShare(d, '优汐无限1')).toEqual({ pwdId: 'uc-share-1', passcode: '' });
    expect(extractUcShare(d, 'UC网盘')).toEqual({ pwdId: 'uc-share-1', passcode: '' });
    expect(extractUcShare(d, '夸父原1')).toBeNull();
    expect(extractUcShare(d)).toBeNull();
    expect(extractUcShare('{"sId":"share"}', '优汐无限')).toBeNull();
    expect(extractUcShare('{"sId":123,"fid":"file"}', '优汐无限')).toBeNull();
    expect(extractUcShare('{"sId":"share","fid":"https://drive.uc.cn/s/other"}', '夸父原1')).toEqual({ pwdId: 'other', passcode: '' });
  });
  it('取 pwd_id（public 分享无提取码）', () => {
    expect(extractUcShare('https://drive.uc.cn/s/2c66665853b34?public=1')).toEqual({
      pwdId: '2c66665853b34',
      passcode: '',
    });
  });
  it('带提取码 ?pwd=xxxx', () => {
    expect(extractUcShare('https://drive.uc.cn/s/b37622addbf04?pwd=a1b2')).toEqual({
      pwdId: 'b37622addbf04',
      passcode: 'a1b2',
    });
  });
  it('兼容 passcode=/password= 写法', () => {
    expect(extractUcShare('https://drive.uc.cn/s/abc123?passcode=Zz09')?.passcode).toBe('Zz09');
    expect(extractUcShare('https://drive.uc.cn/s/abc123?password=1234')?.passcode).toBe('1234');
  });
  it('fast.uc.cn 短域名形态', () => {
    expect(extractUcShare('https://fast.uc.cn/s/abc9x9?pwd=q1w2')).toEqual({ pwdId: 'abc9x9', passcode: 'q1w2' });
    expect(isUcSharePlay('https://fast.uc.cn/s/abc9x9')).toBe(true);
  });

  it('非分享链接返回 null', () => {
    expect(extractUcShare('https://pan.baidu.com/s/1abcdef')).toBeNull();
    expect(extractUcShare('')).toBeNull();
  });
});

describe('UC 精确选集取链（不触网）', () => {
  const files = ['file-1', 'file-2'].map((fid, i) => ({
    fid, dir: false, size: 1024, file_name: `0${i + 1}.mkv`, share_fid_token: `token-${fid}`,
  }));
  const quiet = { i: () => {}, w: () => {}, e: () => {} } as never;

  function network() {
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      if (url.hostname === 'media.test') {
        return new Response(new Uint8Array([0x1a]), {
          status: 206,
          headers: { 'content-type': 'video/x-matroska', 'content-range': 'bytes 0-0/1024', 'content-length': '1' },
        });
      }
      if (url.pathname.endsWith('/share/sharepage/token')) {
        return new Response(JSON.stringify({ code: 0, data: { stoken: 'share-session' } }));
      }
      if (url.pathname.endsWith('/share/sharepage/detail')) {
        expect(url.searchParams.get('pr')).toBe('UCBrowser');
        expect(url.searchParams.get('fr')).toBe('pc');
        expect(url.searchParams.get('_fetch_total')).toBe('1');
        expect(url.searchParams.get('pwd_id')).toBe('ucshare123');
        expect(url.searchParams.get('stoken')).toBe('share-session');
        return new Response(JSON.stringify({ code: 0, data: { list: files } }));
      }
      if (url.pathname.endsWith('/file/download')) {
        return new Response(JSON.stringify({ code: 0, data: [{ download_url: `https://media.test/${body.fids[0]}` }] }));
      }
      throw new Error('Unexpected write or request');
    });
    vi.stubGlobal('fetch', fetch);
    return fetch;
  }

  it('1→2→1 保留精确 fid/token/分享会话，免转存不返回清理目标', async () => {
    const fetch = network();
    for (const fid of ['file-1', 'file-2', 'file-1']) {
      const r = await ucResolveShare('ucshare123', '', 'test-cookie', { innerFid: fid, logger: quiet });
      expect(r).toMatchObject({ ok: true, url: `https://media.test/${fid}` });
      expect(r.fid).toBeUndefined();
      expect(r.pdirFid).toBeUndefined();
    }
    const downloads = fetch.mock.calls.filter(([url]) => new URL(String(url)).pathname.endsWith('/file/download'));
    expect(downloads.map(([, init]) => JSON.parse(String(init?.body)))).toEqual(
      ['file-1', 'file-2', 'file-1'].map(fid => ({
        fids: [fid], fid_token_list: [`token-${fid}`], pwd_id: 'ucshare123', stoken: 'share-session',
      })),
    );
    expect(fetch.mock.calls.some(([url]) => /\/(save|delete|task)$/.test(new URL(String(url)).pathname))).toBe(false);
  });

  it('免转存 download 的 Set-Cookie 会并入媒体请求 Cookie', async () => {
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      if (url.pathname.endsWith('/share/sharepage/token')) {
        return new Response(JSON.stringify({ code: 0, data: { stoken: 'share-session' } }));
      }
      if (url.pathname.endsWith('/share/sharepage/detail')) {
        return new Response(JSON.stringify({ code: 0, data: { list: [files[0]] } }));
      }
      if (url.pathname.endsWith('/file/download')) {
        return new Response(JSON.stringify({ code: 0, data: [{ download_url: 'https://media.test/file-1' }] }), {
          headers: [['set-cookie', '__puus=refreshed; Path=/'], ['set-cookie', 'session=new; Path=/']],
        });
      }
      if (url.hostname === 'media.test') {
        return new Response(new Uint8Array([0x1a]), {
          status: 206,
          headers: { 'content-type': 'video/x-matroska', 'content-range': 'bytes 0-0/1024', 'content-length': '1' },
        });
      }
      throw new Error(`Unexpected request ${url.pathname} ${JSON.stringify(body)}`);
    });
    vi.stubGlobal('fetch', fetch);

    const r = await ucResolveShare('ucshare123', '', 'account=one', { innerFid: 'file-1', logger: quiet });
    expect(r).toMatchObject({ ok: true, url: 'https://media.test/file-1' });
    expect(r.header.Cookie).toBe('account=one; __puus=refreshed; session=new');
  });

  it('已选 fid 不存在或多文件未选集时拒绝默认首集，不请求下载或转存', async () => {
    const fetch = network();
    expect((await ucResolveShare('ucshare123', '', 'test-cookie', { innerFid: 'missing', logger: quiet })).ok).toBe(false);
    expect((await ucResolveShare('ucshare123', '', 'test-cookie', { logger: quiet })).ok).toBe(false);
    expect(fetch.mock.calls.some(([url]) => /\/(download|save)$/.test(new URL(String(url)).pathname))).toBe(false);
  });

  it('免转存拒绝后 task 查询参数完整，下载使用服务端落盘 fid', async () => {
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      const reply = (data: unknown) => new Response(JSON.stringify(data));
      if (url.pathname.endsWith('/share/sharepage/token')) return reply({ code: 0, data: { stoken: 'share-session' } });
      if (url.pathname.endsWith('/share/sharepage/detail')) return reply({ code: 0, data: { list: files } });
      if (url.pathname.endsWith('/share/sharepage/save')) return reply({ code: 0, data: { task_id: 'task-id' } });
      if (url.pathname.endsWith('/task')) return reply({ code: 0, data: { status: 2, save_as: { save_as_top_fids: ['own-file-2'] } } });
      if (url.pathname.endsWith('/file/download')) return reply(body.pwd_id
        ? { code: 403 } : { code: 0, data: [{ download_url: `https://media.test/${body.fids[0]}` }] });
      if (url.hostname === 'media.test') {
        return new Response(new Uint8Array([0x1a]), {
          status: 206,
          headers: { 'content-type': 'video/x-matroska', 'content-range': 'bytes 0-0/1024', 'content-length': '1' },
        });
      }
      throw new Error(`Unexpected ${url.pathname}`);
    });
    vi.stubGlobal('fetch', fetch);
    expect(await ucResolveShare('ucshare123', '', 'cookie', { innerFid: 'file-2' })).toMatchObject({
      ok: true, fid: 'own-file-2', url: 'https://media.test/own-file-2',
    });
    const taskCall = fetch.mock.calls.find(([input]) => new URL(String(input)).pathname.endsWith('/task'));
    const taskUrl = new URL(String(taskCall?.[0]));
    expect(taskUrl.searchParams.get('task_id')).toBe('task-id');
    expect(taskUrl.searchParams.get('retry_index')).toBe('0');
    expect(taskUrl.searchParams.get('pr')).toBe('UCBrowser');
    expect(taskUrl.searchParams.get('fr')).toBe('pc');
  });

  it('分享列表接口报错时不伪装成目标失效，也不请求下载或转存', async () => {
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/share/sharepage/token')) return new Response(JSON.stringify({ code: 0, data: { stoken: 'session' } }));
      return new Response(JSON.stringify({ code: 403 }), { status: 403 });
    });
    vi.stubGlobal('fetch', fetch);
    await expect(ucResolveShare('share', '', 'cookie', { innerFid: 'file-2' })).rejects.toThrow('UC 分享列表失败 HTTP 403');
    expect(fetch.mock.calls).toHaveLength(2);
  });
});

describe('validateUcMediaUrl', () => {
  it('拒绝 CDN 返回的短错误对象或错误总大小', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('short-error', {
      status: 206,
      headers: { 'content-type': 'application/json', 'content-range': 'bytes 0-0/15' },
    })));
    const r = await validateUcMediaUrl('https://media.test/wrong', 1024, { Cookie: 'uc=1' });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('非媒体');
  });

  it('接受目标大小匹配且带媒体类型的 Range 响应', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([0x1a]), {
      status: 206,
      headers: { 'content-type': 'video/x-matroska', 'content-range': 'bytes 0-0/1024' },
    })));
    await expect(validateUcMediaUrl('https://media.test/episode', 1024)).resolves.toEqual({ ok: true });
  });
});

// jar 把 UC 分享链接塞进 do=pan 的 query
//   参数值时会 percent-encode，旧实现裸正则匹配不到；且桌面端当时只有百度兜底、没有 UC 通道。
describe('do=pan 的 percent-encoded 形态', () => {
  const encPan =
    'http://127.0.0.1:-1/proxy?do=pan&type=2&site=uc&shareId=&fileId=https%3A%2F%2Fdrive.uc.cn%2Fs%2F2c66665853b34%3Fpwd%3Da1b2&fileToken=';

  it('isUcSharePlay 识别 encoded 分享', () => {
    expect(isUcSharePlay(encPan)).toBe(true);
  });

  it('extractUcShare 解出 encoded pwd_id 与提取码', () => {
    expect(extractUcShare(encPan)).toEqual({ pwdId: '2c66665853b34', passcode: 'a1b2' });
  });

  it('二次编码同样能解（≤2 轮解码）', () => {
    const twice = 'http://x/proxy?do=pan&fileId=' + encodeURIComponent(encodeURIComponent('https://drive.uc.cn/s/b37622addbf04?public=1'));
    expect(extractUcShare(twice)).toEqual({ pwdId: 'b37622addbf04', passcode: '' });
    expect(isUcSharePlay(twice)).toBe(true);
  });

  it('非法百分号序列不抛异常（原文兜底 → null）', () => {
    expect(() => extractUcShare('http://x/proxy?do=pan&fileId=%e0%')).not.toThrow();
    expect(extractUcShare('http://x/proxy?do=pan&fileId=%e0%')).toBeNull();
  });
});
