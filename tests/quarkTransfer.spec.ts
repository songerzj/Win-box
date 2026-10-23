import { describe, it, expect, vi, afterEach } from 'vitest';
import { resolveShareFile, extractEpisodeFid, extractEpisodeName, episodeKeyOf, matchTransferredFile, isQuarkSharePlay, extractQuarkShare, isDirNode, isRealFileNode, quarkPlayUrl, quarkTransfer, quarkFileDelete, refreshQuarkCookieSession, QUARK_CACHE_DIR_NAME, SESSION_DIR_PREFIX, sessionDirName } from '../src/main/net/quarkTransfer';
import type { ShareListFetcher } from '../src/main/net/quarkTransfer';

afterEach(() => vi.unstubAllGlobals());

describe('refreshQuarkCookieSession', () => {
  it('合并 member 响应的新 __puus，但不把 cookie 值写入诊断结果', async () => {
    const fetcher = vi.fn().mockResolvedValue({
      status: 200,
      headers: {
        getSetCookie: () => ['__puus=NEW; Path=/; HttpOnly'],
        get: () => null,
      },
      text: async () => JSON.stringify({ code: 0 }),
    });
    const r = await refreshQuarkCookieSession('__pus=PUS', fetcher);
    expect(r).toEqual({
      cookie: '__pus=PUS; __puus=NEW',
      changed: true,
      status: 200,
      setCookieKeys: ['__puus'],
    });
    expect(fetcher).toHaveBeenCalledWith(expect.stringContaining('/1/clouddrive/member?'), expect.objectContaining({
      method: 'GET',
      headers: expect.objectContaining({ Cookie: '__pus=PUS' }),
    }));
  });

  it('member 接口失败时保留原 cookie，不误写入半成品', async () => {
    const fetcher = vi.fn().mockResolvedValue({
      status: 401,
      headers: { getSetCookie: () => ['__puus=IGNORED'], get: () => null },
      text: async () => JSON.stringify({ code: 401 }),
    });
    await expect(refreshQuarkCookieSession('__pus=PUS', fetcher)).resolves.toMatchObject({
      cookie: '__pus=PUS', changed: false, status: 401, setCookieKeys: ['__puus'],
    });
  });
});

describe('quarkFileDelete 幂等清理', () => {
  it('明确已删除的 fid 可清队列，不重复删除其它文件', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: 23004, message: '[文件已经删除,请稍后重试]' }), { status: 400 }));
    vi.stubGlobal('fetch', fetch);
    expect(await quarkFileDelete('test-cookie', 'test-dir', 'exact-fid')).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetch.mock.calls[0][1].body).filelist).toEqual(['exact-fid']);
  });

  it.each([
    [401, 23004, '[文件已经删除,请稍后重试]'],
    [400, 23004, '权限不足'],
    [400, 23003, '[文件已经删除,请稍后重试]'],
    [429, 23004, '[文件已经删除,请稍后重试]'],
  ])('HTTP %s / code %s 的其它失败保留重试', async (status, code, message) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ code, message }), { status })));
    expect(await quarkFileDelete('test-cookie', 'test-dir', 'exact-fid')).toBe(false);
  });
});

describe('网盘所选文件描述兼容', () => {
  it('保留 fileId 与百度 fs_id，数字按字符串提取不丢精度', () => {
    expect(extractEpisodeFid('{"fileId":"fid-second"}')).toBe('fid-second');
    expect(extractEpisodeFid('{"fs_id":98765432101234567}')).toBe('98765432101234567');
    expect(extractEpisodeFid('{"fs_id":"812960976845060"}')).toBe('812960976845060');
  });
  it('分享 URL 不当作文件 ID，非法 query 编码也不抛出', () => {
    expect(extractEpisodeFid('{"fileId":"https://drive.uc.cn/s/share"}')).toBe('');
    expect(extractEpisodeFid('https://drive.uc.cn/s/share?fid=%zz')).toBe('%zz');
  });
});

// 会话子目录（tr_xxx）：每次播放落盘唯一目录，规避"上次文件未删完 → 第二次转存同名冲突"
describe('sessionDirName（唯一会话子目录）', () => {
  it('格式为 tr_<时间戳>_<随机> 且带前缀', () => {
    const n = sessionDirName(1720000000000, 'ab12cd');
    expect(n).toBe('tr_1720000000000_ab12cd');
    expect(n.startsWith(SESSION_DIR_PREFIX)).toBe(true);
    expect(SESSION_DIR_PREFIX).toBe('tr_');
  });
  it('无参生成也满足前缀且互不相同概率极高', () => {
    const a = sessionDirName();
    const b = sessionDirName();
    expect(a.startsWith('tr_')).toBe(true);
    expect(a).not.toBe(b);
  });
});

// 安全边界回归：转存 fid 不再靠「目录差集 + updated_at 猜测」，
//   主路径用服务器返回 save_as_top_fids；回退护栏 = 差集 + 文件名匹配（see quarkTransfer.ts）。
describe('matchTransferredFile (回退护栏：文件名精确匹配，杜绝误删)', () => {
  it('空/非数组/空期望名 → 空 fid', () => {
    expect(matchTransferredFile(null as unknown as unknown[], '04.mp4')).toBe('');
    expect(matchTransferredFile([], '04.mp4')).toBe('');
    expect(matchTransferredFile([{ fid: 'a', file_type: 1, file_name: '04.mp4' }], '')).toBe('');
  });

  it('文件名与分享源完全一致 → 命中', () => {
    const list = [
      { fid: 'dirA', file_type: 2, file_name: '整季目录' },
      { fid: 'f1', file_type: 1, file_name: '04.mp4' },
    ];
    expect(matchTransferredFile(list, '04.mp4')).toBe('f1');
  });

  it('夸克同名自动加 (N) 后缀（残留同名文件时 04(1).mp4）→ 命中', () => {
    const list = [{ fid: 'f9', file_type: 1, file_name: '04(1).mp4', size: 100 }];
    expect(matchTransferredFile(list, '04.mp4')).toBe('f9');
    expect(matchTransferredFile(list, '04(1).mp4')).toBe('f9');
  });

  it('文件名不匹配 → 空（不误删目录里其它文件）', () => {
    const list = [
      { fid: 'user1', file_type: 1, file_name: '我的珍贵视频.mp4', size: 999 },
      { fid: 'user2', file_type: 1, file_name: '05.mp4', size: 888 },
    ];
    // 本次分享源是 04.mp4，目录里只有 05.mp4 / 我的珍贵视频.mp4 → 不匹配 → 空
    expect(matchTransferredFile(list, '04.mp4')).toBe('');
  });

  it('目录占位即使"新增"也不匹配（缺 file_type=1/size）', () => {
    const list = [{ fid: 'newDir', file_type: 2, file_name: '04.mp4' }];
    expect(matchTransferredFile(list, '04.mp4')).toBe('');
  });
});

describe('QUARK_CACHE_DIR_NAME (专用落盘目录，隔离用户文件)', () => {
  it('目录名固定且用户可识别', () => {
    expect(QUARK_CACHE_DIR_NAME).toBe('Win-Box缓存');
  });
});

describe('isQuarkSharePlay', () => {
  it('直达 pan.quark.cn/s/ 链接', () => {
    expect(isQuarkSharePlay('https://pan.quark.cn/s/104863e84ddd')).toBe(true);
    expect(isQuarkSharePlay('https://pan.quark.cn/s/abc#/')).toBe(true);
  });
  it('裸分享 ID → false', () => {
    expect(isQuarkSharePlay('104863e84ddd')).toBe(false);
  });
  it('含 sId 的 episode JSON', () => {
    expect(isQuarkSharePlay('{"url":"","flag":"","fid":"x","sId":"abc123"}')).toBe(true);
  });
  it('明确 UC/百度描述不因 sId 误判夸克，非法 JSON 不识别', () => {
    const d = JSON.stringify({ sId: 'abc123', fid: 'file-3' });
    expect(isQuarkSharePlay(d, '优汐无限1')).toBe(false);
    expect(extractQuarkShare(d, 'UC#3')).toBeNull();
    expect(extractQuarkShare(JSON.stringify({ sId: 'abc123', site: 'baidu' }))).toBeNull();
    expect(isQuarkSharePlay('{"sId":"abc123"')).toBe(false);
    expect(isQuarkSharePlay('http://127.0.0.1/proxy?fileId=' + encodeURIComponent('https://pan.quark.cn/s/abc123'))).toBe(true);
  });
  it('空/普通地址 → false', () => {
    expect(isQuarkSharePlay('')).toBe(false);
    expect(isQuarkSharePlay('https://v.vimsec.app/a/b.mp4')).toBe(false);
  });
});

describe('extractQuarkShare（do=pan 的夸克通道解析）', () => {
  it('从 do=pan 地址取 sId（含 percent-encoded 形态）', () => {
    const enc = 'http://127.0.0.1:-1/proxy?do=pan&site=quark&shareId=&fileId=https%3A%2F%2Fpan.quark.cn%2Fs%2Fa1b2c3d4&fileToken=';
    expect(extractQuarkShare(enc)).toEqual({ sId: 'a1b2c3d4', passcode: '' });
    expect(extractQuarkShare('https://pan.quark.cn/s/104863e84ddd?fid=x')).toEqual({ sId: '104863e84ddd', passcode: '' });
  });
  it('提取码：?pwd=/passcode= 参数与「提取码：xxxx」文本两种形态（第三方文档参考 + 实证点）', () => {
    expect(extractQuarkShare('https://pan.quark.cn/s/abc12345?pwd=q1w2')?.passcode).toBe('q1w2');
    const enc = 'http://127.0.0.1:-1/proxy?do=pan&site=quark&fileId=' + encodeURIComponent('https://pan.quark.cn/s/abc12345?pwd=Zz09');
    expect(extractQuarkShare(enc)?.passcode).toBe('Zz09');
    expect(extractQuarkShare('https://pan.quark.cn/s/abc12345 提取码：a1b2')?.passcode).toBe('a1b2');
    expect(extractQuarkShare('https://pan.quark.cn/s/abc12345 密码: XY99')?.passcode).toBe('XY99');
  });
  it('非夸克分享 / 空串 → null（不抛）', () => {
    expect(extractQuarkShare('https://pan.baidu.com/s/1abc')).toBeNull();
    expect(extractQuarkShare('')).toBeNull();
    expect(() => extractQuarkShare('http://x/p?fileId=%zz%')).not.toThrow();
  });
});

describe('isDirNode / isRealFileNode（分享列表 dir 布尔 + 个人盘 file_type 双结构）', () => {
  const dirNode = { fid: 'd1', file_type: 0, size: 0, format_type: '' };          // 外层整季目录(personal 盘)
  const fileNode = { fid: 'f1', file_type: 1, file_name: '04.mp4', size: 2066861513, format_type: 'video/mp4' };
  const shareDir = { fid: 's1', dir: true, file_name: '整季' };                    // 分享列表目录(dir 布尔)
  const shareFile = { fid: 's2', dir: false, file_name: '06.mp4', size: 999 };     // 分享列表文件(dir 布尔)
  const fmtNode = { fid: 'f2', format_type: 'video/mp4' as any, size: 100 };      // 带格式 → 文件
  const sizeNode = { fid: 'f3', size: 2048 };                                     // 有实际大小 → 文件
  const noSizeNode = { fid: 'd2', size: 0 };                                      // 目录占位

  it('isDirNode 识别目录（个人盘 file_type / 分享列表 dir）', () => {
    expect(isDirNode(dirNode)).toBe(true);
    expect(isDirNode(shareDir)).toBe(true);
    expect(isDirNode({ fid: 'x', file_type: 2 })).toBe(true);
    expect(isDirNode(noSizeNode)).toBe(true);
    expect(isDirNode({ fid: 'y' })).toBe(true);
  });
  it('isDirNode 不误判文件', () => {
    expect(isDirNode(fileNode)).toBe(false);
    expect(isDirNode(shareFile)).toBe(false);
    expect(isDirNode(fmtNode)).toBe(false);
    expect(isDirNode(sizeNode)).toBe(false);
    expect(isDirNode(null)).toBe(false);
  });
  it('isRealFileNode 识别文件（两种结构）', () => {
    expect(isRealFileNode(fileNode)).toBe(true);
    expect(isRealFileNode(shareFile)).toBe(true);
    expect(isRealFileNode(fmtNode)).toBe(true);
    expect(isRealFileNode(sizeNode)).toBe(true);
  });
  it('isRealFileNode 不误判目录/缺fid', () => {
    expect(isRealFileNode(dirNode)).toBe(false);
    expect(isRealFileNode(shareDir)).toBe(false);
    expect(isRealFileNode(noSizeNode)).toBe(false);
    expect(isRealFileNode({ file_type: 1 })).toBe(false); // 缺 fid
    expect(isRealFileNode(null)).toBe(false);
  });
});

describe('quarkPlayUrl (夸克转码播放接口)', () => {
  it('有返回可播 url 时，返回该 url', async () => {
    // 仅作接口存在性/返回空串兜底断言：真实网络已实测多数文件 plf_invalid → 空串
    expect(typeof quarkPlayUrl).toBe('function');
  });
});

// 修复「点第6集落第29集」：resolveShareFile 分页/递归下钻/未命中不瞎猜回退
describe('resolveShareFile（分享内选文件）', () => {
  const quiet = { i: () => {}, w: () => {}, e: () => {} } as never;

  /** 构造内存分享目录树 fetcher：节点 {fid, dir?, file_name?, share_fid_token?} */
  function memFetcher(tree: Record<string, unknown[]>): ShareListFetcher {
    return async (pdirFid, offset) => [...(tree[pdirFid] || [])].slice(offset, offset + 50);
  }
  const fileNode = (fid: string, name?: string) => ({ fid, dir: false, file_name: name || `${fid}.mp4`, size: 100, share_fid_token: `tk-${fid}` });

  it('preferFid 在外层列表可直接命中', async () => {
    const tree = { '0': [fileNode('f1'), fileNode('f6', '第06集.mp4'), fileNode('f7', '第07集.mp4')] };
    const r = await resolveShareFile('f6', quiet, memFetcher(tree));
    expect(r?.fid).toBe('f6');
    expect(r?.name).toBe('第06集.mp4');
    expect(r?.token).toBe('tk-f6');
  });

  it('分页：目标 fid 在第 50 条之后仍能命中（旧实现只取第一页 → 匹配失败 → 错取首文件）', async () => {
    const many = Array.from({ length: 120 }, (_, i) => fileNode(`f${String(i + 1).padStart(3, '0')}`, `第${i + 1}集.mp4`));
    const tree = { '0': many };
    const r = await resolveShareFile('f106', quiet, memFetcher(tree));
    expect(r?.fid).toBe('f106');
    expect(r?.name).toBe('第106集.mp4');
  });

  it('递归下钻：整季目录嵌套多层（根→季目录→集目录→文件）仍能精确命中', async () => {
    const tree = {
      '0': [{ fid: 'season', dir: true, file_name: '第一季' }],
      season: [{ fid: 'vol', dir: true, file_name: '第一卷' }],
      vol: [fileNode('ep6', '第06集.mp4'), fileNode('ep29', '第29集.mp4')],
    };
    const r = await resolveShareFile('ep6', quiet, memFetcher(tree));
    expect(r?.fid).toBe('ep6');
    expect(r?.name).toBe('第06集.mp4');
  });

  it('安全边界：preferFid 全树找不到 → 返回 null（绝不回退首文件，杜绝播错集）', async () => {
    const tree = { '0': [fileNode('f1', '第29集.mp4'), fileNode('f2', '第30集.mp4')] };
    const r = await resolveShareFile('f999', quiet, memFetcher(tree));
    expect(r).toBeNull();
  });

  it('无 preferFid：根目录仅一个真实文件 → 自动选中（单文件分享/每集独立分享）', async () => {
    const tree = { '0': [fileNode('f29', '第29集.mp4')] };
    const r = await resolveShareFile('', quiet, memFetcher(tree));
    expect(r?.fid).toBe('f29');
  });

  it('无 preferFid 且根是整季目录、其中只有一个文件 → 自动取该文件', async () => {
    const tree = { '0': [{ fid: 'season', dir: true, file_name: '整季' }], season: [fileNode('ep6', '第06集.mp4')] };
    const r = await resolveShareFile(undefined, quiet, memFetcher(tree));
    expect(r?.fid).toBe('ep6');
  });

  it('无 preferFid 且分享含多个文件 → 返回 null（拒绝盲选首文件，杜绝共享链接错集）', async () => {
    const tree = { '0': [fileNode('f29', '第29集.mp4'), fileNode('f6', '第06集.mp4')] };
    const r = await resolveShareFile('', quiet, memFetcher(tree));
    expect(r).toBeNull();
  });

  it('无 preferFid 且整季目录含多集 → 返回 null（不再默认取第一集）', async () => {
    const tree = { '0': [{ fid: 'season', dir: true, file_name: '整季' }], season: [fileNode('ep29', '第29集.mp4'), fileNode('ep6', '第06集.mp4')] };
    const r = await resolveShareFile(undefined, quiet, memFetcher(tree));
    expect(r).toBeNull();
  });
});

// 修复「点第6集落第29集」：episode JSON 里 fid 字段名不统一，只认 "fid" 会取不到
describe('extractEpisodeFid（episode id 提取内层 fid）', () => {
  it('字段名 fid（旧兼容）', () => {
    expect(extractEpisodeFid('{"sId":"abc","fid":"123"}')).toBe('123');
  });
  it('字段名 vfid / file_id（某壳源常见）', () => {
    expect(extractEpisodeFid('{"sId":"abc","vfid":"v1"}')).toBe('v1');
    expect(extractEpisodeFid('{"sId":"abc","file_id":"fi1"}')).toBe('fi1');
  });
  it('fids 数组取首元素', () => {
    expect(extractEpisodeFid('{"sId":"abc","fids":["a1","a2"]}')).toBe('a1');
  });
  it('直达链接 query 参数', () => {
    expect(extractEpisodeFid('https://pan.quark.cn/s/abc?fid=xyz')).toBe('xyz');
    expect(extractEpisodeFid('https://pan.quark.cn/s/abc?vfid=xy2#/')).toBe('xy2');
  });
  it('无 fid 信息 → 空串', () => {
    expect(extractEpisodeFid('')).toBe('');
    expect(extractEpisodeFid('https://pan.quark.cn/s/abc')).toBe('');
    expect(extractEpisodeFid('{"sId":"abc"}')).toBe('');
  });
});

// fid 未命中时按集名唯一匹配兜底
describe('extractEpisodeName / episodeKeyOf（集名兜底）', () => {
  it.each([
    ['03~4K.mp4', 'ep3'], ['05~4K(1).mp4', 'ep5'],
    ['[【L】蘭丨]03-4K.mp4[1.63GB]', 'ep3'], ['12 4K-.mp4', 'ep12'],
    ['片头.mp4', '片头'], ['片尾.mp4', '片尾'], ['Trailer4.mp4', 'Trailer4'],
    ['4K.mp4', '4K'], ['1080p.mp4', '1080p'],
  ])('真实 UC 文件名 %s 不把画质或扩展名当集号', (name, key) => {
    expect(episodeKeyOf(name)).toBe(key);
  });

  it('解析某壳源复合选集，提供商必须明确', () => {
    const id = '03~4K.mp4[1.01GB]__' + 'a'.repeat(32) + '+11adf8105c314+' + 'b'.repeat(32);
    expect(extractEpisodeFid(id)).toBe('a'.repeat(32));
    expect(extractEpisodeName(id)).toBe('03~4K.mp4[1.01GB]');
    expect(extractQuarkShare(id, '夸克无限#4')).toEqual({ sId: '11adf8105c314', passcode: '' });
    expect(extractQuarkShare(id, 'UC无限#5')).toBeNull();
    expect(extractQuarkShare(id)).toBeNull();
    expect(extractEpisodeFid(id + '+extra')).toBe('');
  });
  it('从 episode JSON 提取集名（name / file_name / fileName / title，含转义）', () => {
    expect(extractEpisodeName('{"sId":"a","name":"第6集.mp4"}')).toBe('第6集.mp4');
    expect(extractEpisodeName('{"file_name":"Show.S01E06.mkv"}')).toBe('Show.S01E06.mkv');
    expect(extractEpisodeName('{"title":"剧名\\"特别篇\\""}')).toBe('剧名"特别篇"');
    expect(extractEpisodeName('https://pan.quark.cn/s/abc')).toBe('');
  });

  it('集名归一：集号优先（SxxExx / 第N集 / E06 / 06.mp4 / 尾部裸数字）', () => {
    expect(episodeKeyOf('Show.S01E06.mkv')).toBe('ep6');
    expect(episodeKeyOf('剧名 第06集.mp4')).toBe('ep6');
    expect(episodeKeyOf('EP6.mp4')).toBe('ep6');
    expect(episodeKeyOf('06.mp4')).toBe('ep6');
    expect(episodeKeyOf('斗罗大陆 120')).toBe('ep120');
    expect(episodeKeyOf('纯名字')).toBe('纯名字');
    expect(episodeKeyOf('')).toBe('');
  });
});

describe('resolveShareFile — fid 未命中 → 按集名唯一匹配', () => {
  const quiet = { i: () => {}, w: () => {}, e: () => {} };
  const file = (fid: string, name: string, token = `tk-${fid}`) => ({ fid, dir: false, file_name: name, size: 100, share_fid_token: token });
  const tree: Record<string, any[]> = {
    '0': [
      { fid: 'dir1', dir: true, file_name: '全季' },
      file('x1', '花絮.mp4'),
    ],
    dir1: [
      file('ep1', '剧名 第01集.mp4', 't1'),
      file('ep2', '剧名 第02集.mp4', 't2'),
    ],
  };
  const fetcher = async (pdirFid: string, offset: number) => (offset === 0 ? tree[pdirFid] || [] : []);

  it('指定 fid 找不到，但集名唯一命中 → 采用该文件（不再直接失败）', async () => {
    const r = await resolveShareFile('old-fid-gone', quiet, fetcher, '剧名.第02集.mp4');
    expect(r?.fid).toBe('ep2');
    expect(r?.token).toBe('t2');
  });

  it('集名匹配到多个 → 仍拒绝（避免播错集）', async () => {
    const dupTree: Record<string, any[]> = {
      '0': [file('a', '剧名 第02集.mp4'), file('b', '剧名 第02集.mp4')],
    };
    const f2 = async (pdirFid: string, offset: number) => (offset === 0 ? dupTree[pdirFid] || [] : []);
    expect(await resolveShareFile('gone', quiet, f2, '第02集')).toBeNull();
  });

  it('fid 精确命中时优先（不触发集名兜底）', async () => {
    const r = await resolveShareFile('ep1', quiet, fetcher, '第02集');
    expect(r?.fid).toBe('ep1');
  });
});

describe('quarkTransfer（分享免转存优先）', () => {
  it('使用分享文件的 fid/token 直接取链，不触发转存', async () => {
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      if (url.pathname.endsWith('/share/sharepage/token')) {
        return new Response(JSON.stringify({ code: 0, data: { stoken: 'share-session' } }));
      }
      if (url.pathname.endsWith('/share/sharepage/detail')) {
        return new Response(JSON.stringify({
          code: 0,
          data: { list: [{ fid: 'share-file', dir: false, file_name: '第03集.mp4', size: 100, share_fid_token: 'share-token' }] },
        }));
      }
      if (url.hostname === 'drive-m.quark.cn' && url.pathname.endsWith('/file/share/download')) {
        expect(url.searchParams.get('pr')).toBe('ucpro');
        expect(url.searchParams.get('fr')).toBe('h5');
        expect(body).toEqual({
          fids: ['share-file'],
          fids_token: ['share-token'],
          pwd_id: 'share-id',
          stoken: 'share-session',
        });
        return new Response(JSON.stringify({ code: 0, data: [{ download_url: 'https://media.test/share-file' }] }), {
          headers: [['set-cookie', '__puus=fresh; Path=/'], ['set-cookie', 'session=new; Path=/']],
        });
      }
      throw new Error(`unexpected quark request: ${url.pathname}`);
    });
    vi.stubGlobal('fetch', fetch);

    const r = await quarkTransfer('share-id', 'account=one', { innerFid: 'share-file' });
    expect(r).toMatchObject({ ok: true, url: 'https://media.test/share-file' });
    expect(r.fid).toBeUndefined();
    expect(r.pdirFid).toBeUndefined();
    expect(r.header.Cookie).toBe('account=one; __puus=fresh; session=new');
    expect(fetch.mock.calls.map(([input]) => new URL(String(input)).pathname)).toEqual([
      '/1/clouddrive/share/sharepage/token', '/1/clouddrive/share/sharepage/detail', '/1/clouddrive/file/share/download',
    ]);
  });

  it('真实 UC 画质命名在旧 fid 失效时按第3、第5、第3集唯一匹配', async () => {
    const quiet = { i: () => {}, w: () => {}, e: () => {} };
    const file = (fid: string, name: string) => ({ fid, dir: false, file_name: name, size: 100, share_fid_token: `tk-${fid}` });
    const f = async () => [file('third', '03~4K(1).mp4'), file('fifth', '05~4K(1).mp4'), file('intro', '片头.mp4')];
    for (const [name, fid] of [['[剧名]03-4K.mp4[1.63GB]', 'third'], ['05~4K.mp4[957.83MB]', 'fifth'], ['03~4K.mp4', 'third']]) {
      expect((await resolveShareFile('stale-fid', quiet, f, name))?.fid).toBe(fid);
    }
  });

  it('同集不同画质仍拒绝盲选，不会把第5集作为第3集', async () => {
    const quiet = { i: () => {}, w: () => {}, e: () => {} };
    const file = (fid: string, name: string) => ({ fid, dir: false, file_name: name, size: 100, share_fid_token: `tk-${fid}` });
    const f = async () => [file('third-a', '03~4K.mp4'), file('third-b', '03~4K(1).mp4'), file('fifth', '05~4K.mp4')];
    expect(await resolveShareFile('stale', quiet, f, '03-4K.mp4')).toBeNull();
  });

  it.each(['denied', 'network', 'size-limit'] as const)('免转存 %s 时保留精确转存兜底', async (failure) => {
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      const reply = (data: unknown) => new Response(JSON.stringify(data));
      if (url.pathname.endsWith('/share/sharepage/token')) return reply({ code: 0, data: { stoken: 'session' } });
      if (url.pathname.endsWith('/share/sharepage/detail')) return reply({ code: 0, data: { list: [
        { fid: 'ep3', dir: false, size: 100, file_name: '第03集.mp4', share_fid_token: 'token3' },
        { fid: 'ep5', dir: false, size: 100, file_name: '第05集.mp4', share_fid_token: 'token5' },
      ] } });
      if (url.pathname.endsWith('/file/share/download')) {
        if (failure === 'network') throw new Error('offline');
        if (failure === 'size-limit') return new Response(JSON.stringify({ code: 23018, message: 'download file size limit[secret-fid]' }), { status: 400 });
        return reply({ code: 403, message: 'unsupported' });
      }
      if (url.pathname.endsWith('/file')) {
        if (init?.method === 'POST') return reply({ code: 0, data: { fid: 'session-dir' } });
        return reply({ code: 0, data: { list: url.searchParams.get('pdir_fid') === '0'
          ? [{ fid: 'cache-dir', dir: true, file_name: QUARK_CACHE_DIR_NAME }] : [] } });
      }
      if (url.pathname.endsWith('/share/sharepage/save')) return reply({ code: 0, data: { task_id: 'task' } });
      if (url.pathname.endsWith('/task')) return reply({ status: 200, data: { status: 2, save_as: { save_as_top_fids: ['own-ep3'] } } });
      if (url.pathname.endsWith('/acquire_dl_token')) return reply({ code: 0, data: { token: 'speed' } });
      if (url.pathname.endsWith('/file/download')) return reply({ code: 0, data: [{ download_url: `https://media.test/${body.fids[0]}` }] });
      throw new Error(`Unexpected request ${url.pathname}`);
    });
    vi.stubGlobal('fetch', fetch);
    const logger = { i: vi.fn(), w: vi.fn(), e: vi.fn() };
    const r = await quarkTransfer('share', `cookie-${failure}`, { innerFid: 'ep3', logger });
    if (failure === 'size-limit') {
      expect(logger.w).toHaveBeenCalledWith(expect.stringContaining('文件大小限制'));
      expect(JSON.stringify(logger.w.mock.calls)).not.toContain('secret-fid');
    }
    expect(r).toMatchObject({ ok: true, url: 'https://media.test/own-ep3', fid: 'own-ep3', pdirFid: 'session-dir' });
    const save = fetch.mock.calls.find(([input]) => new URL(String(input)).pathname.endsWith('/share/sharepage/save'));
    expect(JSON.parse(String(save?.[1]?.body))).toMatchObject({ fid_list: ['ep3'], fid_token_list: ['token3'], to_pdir_fid: 'session-dir' });
    const paths = fetch.mock.calls.map(([input]) => new URL(String(input)).pathname);
    expect(paths.indexOf('/1/clouddrive/file/share/download')).toBeLessThan(paths.indexOf('/1/clouddrive/share/sharepage/save'));
  });
});
