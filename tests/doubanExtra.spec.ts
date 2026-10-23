// tests/doubanExtra.spec.ts — 详情页「相关推荐 / 豆瓣影评」的**纯函数**解析口径
// （样本取自实测的豆瓣 rexxar / subject_suggest 真实返回，见 src/main/meta/doubanExtra.ts 头注释）
import { describe, expect, it } from 'vitest';
import {
  MAX_REVIEWS,
  OVERVIEW_MAX,
  oneLine,
  parseDoubanIntro,
  parseDoubanRecommendations,
  parseDoubanReviewDetail,
  parseDoubanReviews,
  parseReviewBlocks,
  pickDoubanSubject,
  relayImg,
} from '../src/main/meta/doubanExtra';

const IMG = 'http://127.0.0.1:9978/img';

describe('pickDoubanSubject — 从 subject_suggest 挑当前片', () => {
  const rows = [
    { id: '35267208', title: '流浪地球2', year: '2023', type: 'movie', img: 'https://img9.doubanio.com/a.jpg' },
    { id: '99999999', title: '流浪地球2：再次冒险', year: '2024', type: 'movie', img: 'https://img9.doubanio.com/b.jpg' },
  ];

  it('同名 + 同年 → 命中（含媒体类型）', () => {
    expect(pickDoubanSubject(rows, '流浪地球2', '2023')).toEqual({ id: '35267208', mediaType: 'movie', title: '流浪地球2' });
  });

  it('年份不一致也接受（豆瓣年份常与源标注差一年）—— 退回「仅同名」层', () => {
    expect(pickDoubanSubject(rows, '流浪地球2', '2022')?.id).toBe('35267208');
  });

  it('带后缀的源片名 → 走「互含」层（「流浪地球2（3D版）」）', () => {
    expect(pickDoubanSubject(rows, '流浪地球2（3D版）')?.id).toBe('35267208');
  });

  it('tv 条目 → mediaType=tv', () => {
    const tv = [{ id: '12345678', title: '某某剧', year: '2021', type: 'tv' }];
    expect(pickDoubanSubject(tv, '某某剧', '2021')?.mediaType).toBe('tv');
  });

  it('非影视条目（celebrity）与非纯数字 id 一律跳过', () => {
    const bad = [
      { id: '35267208', title: '流浪地球2', year: '2023', type: 'celebrity' },
      { id: 'abc', title: '流浪地球2', year: '2023', type: 'movie' },
    ];
    expect(pickDoubanSubject(bad, '流浪地球2')).toBeNull();
  });

  it('空输入 / 非数组 → null（不抛）', () => {
    expect(pickDoubanSubject(null, '流浪地球2')).toBeNull();
    expect(pickDoubanSubject(rows, '')).toBeNull();
    expect(pickDoubanSubject(rows, '完全不相干的片名')).toBeNull();
  });
});

describe('parseDoubanRecommendations', () => {
  // 实测：端点返回**裸数组**，条目里没有 intro
  const bare = [
    {
      id: '4811774', title: '阿凡达：水之道', type: 'movie',
      card_subtitle: '2022 / 美国 / 动作 科幻 冒险 / 詹姆斯·卡梅隆 / 萨姆·沃辛顿 佐伊·索尔达娜',
      pic: { large: 'https://img9.doubanio.com/large.jpg', normal: 'https://img9.doubanio.com/normal.jpg' },
      rating: { value: 7.8 }, url: 'https://movie.douban.com/subject/4811774/',
    },
    { id: '26816104', title: '从21世纪安全撤离', type: 'movie', card_subtitle: '2024 / 中国大陆 / 喜剧 科幻', pic: { normal: 'https://img3.doubanio.com/n2.jpg' }, rating: { value: 0 } },
    { id: '', title: '无 id 条目' },
    { id: '55555', title: '' },
  ];

  it('裸数组形态：字段映射（年份从 card_subtitle 取）+ 封面优先 large', () => {
    const out = parseDoubanRecommendations(bare);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      id: '4811774', title: '阿凡达：水之道', year: 2022, mediaType: 'movie', rating: 7.8,
      subtitle: '2022 / 美国 / 动作 科幻 冒险 / 詹姆斯·卡梅隆 / 萨姆·沃辛顿 佐伊·索尔达娜',
      overview: '', url: 'https://movie.douban.com/subject/4811774/',
    });
    expect(out[0].poster).toBe(`${IMG}?u=${encodeURIComponent('https://img9.doubanio.com/large.jpg')}`);
  });

  it('缺 large 时回退 normal；评分 0 视为「无评分」不写入', () => {
    const out = parseDoubanRecommendations(bare);
    expect(out[1].poster).toContain(encodeURIComponent('https://img3.doubanio.com/n2.jpg'));
    expect(out[1].rating).toBeUndefined();
  });

  it('兼容 `{recommendations:[…]}` 形态；非数组 → 空数组', () => {
    expect(parseDoubanRecommendations({ recommendations: bare })).toHaveLength(2);
    expect(parseDoubanRecommendations(null)).toEqual([]);
    expect(parseDoubanRecommendations({ foo: 1 })).toEqual([]);
  });

  it('同 id 去重', () => {
    const dup = [bare[0], { ...bare[0], title: '重复' }];
    expect(parseDoubanRecommendations(dup)).toHaveLength(1);
  });
});

describe('parseDoubanReviews', () => {
  const json = {
    start: 0, count: 6, total: 10524,
    reviews: [
      {
        id: '14944568', title: '薅刘慈欣专业户：面壁者马兆、执剑人周喆直',
        abstract: '作为科幻电影，流浪地球2是一座冰山。\r\n《流浪地球2》是《流浪地球》的前传，讲述的是2044年太空电梯危机和2058月球坠落危机。',
        rating: { value: 5 }, useful_count: 6262, comments_count: 600,
        create_time: '2023-01-29 13:21:07', url: 'https://movie.douban.com/review/14944568/',
        user: { name: '某作者' },
      },
      { id: '14909932', title: '另一篇', abstract: '摘要', rating: { value: 4 }, useful_count: 4159, comments_count: 569, create_time: '2023-01-23 03:59:38', url: 'u2', author: { name: '别名作者' } },
      { id: '', title: '无 id' },
      { id: 'x', title: '' },
    ],
  };

  it('字段映射：摘要压成一行、作者取 user.name', () => {
    const out = parseDoubanReviews(json);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ id: '14944568', useful: 6262, comments: 600, author: '某作者', rating: 5, date: '2023-01-29 13:21:07' });
    expect(out[0].abstract).not.toContain('\n');
    expect(out[0].abstract).toContain('作为科幻电影');
    expect(out[0].abstract.length).toBeLessThanOrEqual(221);
  });

  it('兼容 author.name 兜底；无 id / 无标题跳过', () => {
    expect(parseDoubanReviews(json)[1].author).toBe('别名作者');
  });

  it('非 `{reviews:[…]}` → 空数组', () => {
    expect(parseDoubanReviews(null)).toEqual([]);
    expect(parseDoubanReviews({ reviews: 'x' })).toEqual([]);
  });

  it('MAX_REVIEWS 常量 = 6（与请求 count 一致）', () => {
    expect(MAX_REVIEWS).toBe(6);
  });
});

describe('parseReviewBlocks / parseDoubanReviewDetail — 影评全文', () => {
  // 实测：正文 HTML 里的 <img> **只有 id="img_XXX"**，真实地址在 photos[].image.large.url
  const content =
    "<div id='content'><div class=\"introduction\"><p>带着你我的眼睛，它将是中国电影工业的万里长城第一关</p></div>" +
    '<blockquote data-align="">作为科幻电影，流浪地球2是一座冰山。</blockquote>' +
    '<p data-align="">《流浪地球2》是《流浪地球》的前传。</p>' +
    '<p><img height="auto" id="img_8415584" width="1080"/></p>' +
    '<p>结尾 &amp; 彩蛋：<strong>注意</strong>细节。</p><p><img width="10"/></p><hr></div>';
  const photos = [{ id: '8415584', description: '剧照', image: { large: { url: 'https://img9.doubanio.com/view/thing_review/l/public/p8415584.jpg' } } }];

  it('块切分：段落 / 引用 → 文本块，<img id> 按 photos 还原为图片块（地址经 /img 中继 + 说明）', () => {
    const blocks = parseReviewBlocks(content, photos);
    const texts = blocks.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text);
    expect(texts).toContain('带着你我的眼睛，它将是中国电影工业的万里长城第一关');
    expect(texts).toContain('作为科幻电影，流浪地球2是一座冰山。');
    expect(texts).toContain('结尾 & 彩蛋：注意细节。'); // 实体解码 + 行内标签剥掉
    const imgs = blocks.filter((b) => b.type === 'image');
    expect(imgs).toHaveLength(1);
    expect(imgs[0].url).toBe(`${IMG}?u=${encodeURIComponent('https://img9.doubanio.com/view/thing_review/l/public/p8415584.jpg')}`);
    expect((imgs[0] as { caption?: string }).caption).toBe('剧照');
    // 图片块出现在对应位置（引用之后的第 3 块附近，而不是被并到文本里）
    expect(blocks.findIndex((b) => b.type === 'image')).toBeGreaterThan(blocks.findIndex((b) => b.type === 'text'));
  });

  it('无 id 的 <img> 直接丢弃（样式图/表情，不出块）；<hr> 只作分段', () => {
    const blocks = parseReviewBlocks('<p>a</p><p><img width="10"/></p><hr><p>b</p>', []);
    expect(blocks.map((b) => b.type)).toEqual(['text', 'text']);
  });

  it('photos 缺失 / 非数组 → 图片占位不出块（不留空图）', () => {
    expect(parseReviewBlocks('<p><img id="img_1"/></p><p>x</p>', null).map((b) => b.type)).toEqual(['text']);
    expect(parseReviewBlocks('<p><img id="img_9"/></p>', photos)).toEqual([]); // photos 里没有 img_9
  });

  it('空正文 → 空数组（→ detail 为 null）', () => {
    expect(parseReviewBlocks('', photos)).toEqual([]);
    expect(parseDoubanReviewDetail({ id: '1', content: '' })).toBeNull();
    expect(parseDoubanReviewDetail({ content: 'x' })).toBeNull(); // 无 id
    expect(parseDoubanReviewDetail(null)).toBeNull();
  });

  it('detail：头部字段映射（author=user.name / rating 1~5 / spoiler / 计数）', () => {
    const d = parseDoubanReviewDetail({
      id: '14944568', title: '薅刘慈欣专业户', content, photos,
      rating: { value: 5, max: 5 }, useful_count: 6262, comments_count: 600,
      create_time: '2023-01-29 13:21:07', url: 'https://movie.douban.com/review/14944568/',
      spoiler: true, user: { name: '涣' },
    });
    expect(d).toMatchObject({ id: '14944568', title: '薅刘慈欣专业户', author: '涣', rating: 5, useful: 6262, comments: 600, spoiler: true, url: 'https://movie.douban.com/review/14944568/' });
    expect(d!.blocks.length).toBeGreaterThan(0);
  });

  it('detail：无评分（value=0）不带 rating 字段', () => {
    const d = parseDoubanReviewDetail({ id: '14909932', title: 't', content: '<p>x</p>', rating: { value: 0 }, user: {} });
    expect(d!.rating).toBeUndefined();
  });
});

describe('parseDoubanIntro / oneLine / relayImg', () => {
  it('intro → 一行式梗概（去换行、超长截断加省略号）', () => {
    const j = { intro: '影片设定在《阿凡达》的剧情落幕十余年后，\n讲述了萨利一家（杰克、奈蒂莉和孩子们）的故事。  危机未曾消散。' };
    const s = parseDoubanIntro(j);
    expect(s).not.toContain('\n');
    expect(s).toContain('十余年后， 讲述了');
    expect(parseDoubanIntro({ intro: 'x'.repeat(500) })).toHaveLength(OVERVIEW_MAX + 1); // 截断 + '…'
    expect(parseDoubanIntro(null)).toBe('');
    expect(parseDoubanIntro({})).toBe('');
  });

  it('oneLine：空白归一 + 边界（恰好等于上限不截断）', () => {
    expect(oneLine('  a\t\nb  ', 10)).toBe('a b');
    expect(oneLine('abcd', 4)).toBe('abcd');
    expect(oneLine('abcde', 4)).toBe('abcd…');
  });

  it('relayImg：包装为本地 /img 中继；已是中继则不套两层；空值原样返回空串', () => {
    expect(relayImg('https://img9.doubanio.com/a.jpg')).toBe(`${IMG}?u=${encodeURIComponent('https://img9.doubanio.com/a.jpg')}`);
    const already = `${IMG}?u=https%3A%2F%2Fa.jpg`;
    expect(relayImg(already)).toBe(already);
    expect(relayImg('')).toBe('');
  });
});
