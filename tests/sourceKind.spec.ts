// tests/sourceKind.spec.ts
// 源形态归类：确保设置页「按形态显示字段」的判定稳定。
// 这是 Task「整理 ext 配置界面」的回归护栏 —— 分类错了会把 ext 框藏起来或误留给 CMS 源。
import { describe, it, expect } from 'vitest';
import { sourceKindOf, sourceKindInfo, sourceKindLabel, extRelevant, isDoubanLikeSource, detailIsEmpty, configCenterHintOf } from '../src/engine/config/sourceKind';

describe('sourceKindOf — type/api 归类', () => {
  it('type=0 → cms-xml，type=1 → cms-json（不走蜘蛛）', () => {
    expect(sourceKindOf({ type: 0, api: 'https://a.com/api.php/provide/vod/' })).toBe('cms-xml');
    expect(sourceKindOf({ type: 1, api: 'https://a.com/api.php/provide/vod/' })).toBe('cms-json');
  });

  it('type=3 按 api 后缀分 js / py / jar', () => {
    expect(sourceKindOf({ type: 3, api: './spider.js' })).toBe('spider-js');
    expect(sourceKindOf({ type: 3, api: 'https://x.com/a.PY' })).toBe('spider-py');
    expect(sourceKindOf({ type: 3, api: 'csp_Doll' })).toBe('spider-jar');
  });

  it('api 带 ;md5; 后缀时仍按主 URL 段判后缀', () => {
    expect(sourceKindOf({ type: 3, api: './x.js;md5;abc' })).toBe('spider-js');
    expect(sourceKindOf({ type: 3, api: 'csp_Fty;md5;abc' })).toBe('spider-jar');
  });

  it('type 2/4/-1 → unsupported（推送类）', () => {
    for (const t of [2, 4, -1]) expect(sourceKindOf({ type: t, api: 'anything' })).toBe('unsupported');
  });
});

describe('sourceKindInfo — 字段需求判定', () => {
  it('CMS 类不需要 ext / jar / playUrl', () => {
    for (const t of [0, 1]) {
      const info = sourceKindInfo({ type: t, api: 'http://x/api' });
      expect(info.usesExt).toBe(false);
      expect(info.usesJar).toBe(false);
      expect(info.usesPlayUrl).toBe(false);
    }
  });

  it('蜘蛛类都需要 ext；只有 jar 蜘蛛需要 jar 字段', () => {
    const js = sourceKindInfo({ type: 3, api: './a.js' });
    const jar = sourceKindInfo({ type: 3, api: 'csp_X' });
    expect(js.usesExt).toBe(true);
    expect(js.usesJar).toBe(false);
    expect(jar.usesExt).toBe(true);
    expect(jar.usesJar).toBe(true);
  });

  it('每个形态都有非空中文说明（设置页会直接展示给用户）', () => {
    for (const t of [0, 1, 3, 2]) {
      const info = sourceKindInfo({ type: t, api: 'csp_X' });
      expect(info.label.length).toBeGreaterThan(0);
      expect(info.how.length).toBeGreaterThan(0);
    }
  });
});

describe('sourceKindLabel / extRelevant 便捷函数', () => {
  it('label 是短标签（表格列用）', () => {
    expect(sourceKindLabel({ type: 0, api: 'x' })).toBe('CMS·XML');
    expect(sourceKindLabel({ type: 3, api: 'csp_X' })).toBe('蜘蛛·JAR');
  });

  it('extRelevant 只在蜘蛛类为真', () => {
    expect(extRelevant({ type: 0, api: 'x' })).toBe(false);
    expect(extRelevant({ type: 1, api: 'x' })).toBe(false);
    expect(extRelevant({ type: 3, api: 'csp_X' })).toBe(true);
    expect(extRelevant({ type: 3, api: './a.js' })).toBe(true);
    expect(extRelevant({ type: 4, api: 'x' })).toBe(false);
  });
});

// 豆瓣类源「无详情」→ 点封面直接走全源聚合搜索
describe('isDoubanLikeSource / detailIsEmpty（无详情源判据）', () => {
  const site = (o: Partial<{ key: string; name: string; api: string; ext: string }>) => ({
    key: o.key ?? 'k',
    name: o.name ?? '',
    api: o.api ?? 'csp_Douban',
    ext: o.ext ?? '',
  });

  it('key/name/api/ext 任一带「豆瓣 / douban」即判是（大小写不敏感）', () => {
    expect(isDoubanLikeSource(site({ name: '豆瓣' }))).toBe(true);
    expect(isDoubanLikeSource(site({ key: 'douban' }))).toBe(true);
    expect(isDoubanLikeSource(site({ api: 'csp_DouBan' }))).toBe(true);
    expect(isDoubanLikeSource(site({ ext: '{"site":"豆瓣电影"}' }))).toBe(true);
    expect(isDoubanLikeSource(site({ name: '玩偶哥哥', api: 'csp_Wogg' }))).toBe(false);
    expect(isDoubanLikeSource(null)).toBe(false);
  });

  it('某壳源 的豆瓣片单源（豆豆 / DouDou）同样判是', () => {
    // 实测配置原样：key=点我切源 / name=豆豆┃片单 / api=csp_DouDouGuard（三字段都无「豆瓣/douban」）
    const fty = { key: '点我切源', name: '豆豆┃片单', api: 'csp_DouDouGuard', ext: '' };
    expect(isDoubanLikeSource(fty)).toBe(true);
    expect(isDoubanLikeSource({ key: 'k', name: '豆豆┃片单', api: 'csp_X', ext: '' })).toBe(true);
    expect(isDoubanLikeSource({ key: 'k', name: 'x', api: 'csp_DouDou', ext: '' })).toBe(true);
    // 反向：不含豆瓣族字样的普通源仍判否（宁窄勿宽）
    expect(isDoubanLikeSource({ key: 'k', name: '多多┃回放', api: 'csp_DoubaoGuard', ext: '' })).toBe(false);
  });

  it('detailIsEmpty：无 flags / 各线路全空 → true；任一线路有集 → false', () => {
    expect(detailIsEmpty(null)).toBe(true);
    expect(detailIsEmpty({})).toBe(true);
    expect(detailIsEmpty({ episodes: {} })).toBe(true);
    expect(detailIsEmpty({ episodes: { q: [], y: [] } })).toBe(true);
    expect(detailIsEmpty({ episodes: { q: [{ url: 'u' }] } })).toBe(false);
  });
});

// ★ 2026-10-12（用户报「配置中心里的内容点不进去、配置不了」）：
//   加固壳源把配置项做成安卓原生对话框；桌面端弹不出来 → 靠详情正文里的「网页版配置中心」提示识别。
//   这是点击分流的护栏：判错会把用户刚点进去的配置页弹去全源搜索（正是原 bug 的表现）。
describe('configCenterHintOf（配置项识别）', () => {
  it('★ wex 壳配置项实测原文 → 命中，并取出地址', () => {
    // 反编译 PanConfig.F(id) 得到的固定文案（URL 由 U() 拼出）
    const des = '如果弹窗没有显示，请打开网页版配置中心：http://192.168.31.222:19989/config';
    const h = configCenterHintOf({ des });
    expect(h).not.toBeNull();
    expect(h!.url).toBe('http://192.168.31.222:19989/config');
    expect(h!.text).toBe(des);
  });

  it('只有「配置中心」+「弹窗」而没有地址 → 仍命中断言（别的壳可能不给链接）', () => {
    const h = configCenterHintOf({ des: '请前往【配置中心】设置；若弹窗未显示请稍后重试' });
    expect(h).not.toBeNull();
    expect(h!.url).toBe('');
  });

  it('普通影片简介（含 URL 但不提配置中心）→ 不命中', () => {
    expect(configCenterHintOf({ des: '本片由 https://example.com 独家播出' })).toBeNull();
    expect(configCenterHintOf({ des: '一个关于程序员的故事' })).toBeNull();
    // 只提「配置中心」但没有地址也没有「弹窗」→ 宁窄勿宽，不判是
    expect(configCenterHintOf({ des: '请到配置中心看看' })).toBeNull();
  });

  it('空 / 缺 des → null', () => {
    expect(configCenterHintOf(null)).toBeNull();
    expect(configCenterHintOf({})).toBeNull();
    expect(configCenterHintOf({ des: '   ' })).toBeNull();
  });

  it('地址会被中文标点截断（不会把后续说明一并吃进 URL）', () => {
    const h = configCenterHintOf({ des: '请打开网页版配置中心：http://127.0.0.1:9978/proxy/19970?do=pan&action=config。设置后刷新' });
    expect(h!.url).toBe('http://127.0.0.1:9978/proxy/19970?do=pan&action=config');
  });
});
