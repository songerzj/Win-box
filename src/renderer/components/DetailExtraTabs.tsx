// src/renderer/components/DetailExtraTabs.tsx
// 详情页下方「相关推荐 / 豆瓣影评」**共用一块区域 + 顶部文字 tab 切换**。
//   · 竖版列表：推荐 = 左封面（固定尺寸）+ 右「标题 / 豆瓣副标题行 / 梗概」；
//     影评 = 标题 + 摘要 + 作者·评分·有用数（点击 → 弹独立小窗口看**全文**，见 ReviewModal）。
//   · 选中项的**下划线取当前皮肤主色**（`var(--accent)` ⇒ 四皮肤/插件皮肤自动跟随，无需按皮肤分支）。
//   · 数据来自主进程 `meta:doubanExtra`（豆瓣 rexxar；无需 TMDB 凭据）。**无数据时整块不渲染**（不留空壳）。
import { useEffect, useRef, useState } from 'react';
import { client } from '../api/client';
import type { DoubanDetailExtra } from '../../shared/types';
// （内存专项续 (b)：少解码）：推荐条目封面框 56×84 ⇒ 豆瓣图降到够用的一档
import { sizedImageUrl } from '../lib/imageSize';
// 点影评行 → 独立小窗口看**全文**（样式同首启的使用声明窗口）
import ReviewModal from './ReviewModal';

/** 豆瓣影评评分（1~5）→ 豆瓣自己的说法 */
const REVIEW_RATING_LABEL: Record<number, string> = { 1: '很差', 2: '较差', 3: '还行', 4: '推荐', 5: '力荐' };

interface Props {
  /** 豆瓣检索用的片名（外层传 `detailName`，已去掉「 - 集名」后缀） */
  name: string;
  year?: string;
  /** 点击「相关推荐」条目 → 外层全源搜索该片（与「演员」区块同一交互口径） */
  onSearch: (kw: string) => void;
}

export default function DetailExtraTabs({ name, year, onSearch }: Props) {
  const [tab, setTab] = useState<'rec' | 'review'>('rec');
  const [data, setData] = useState<DoubanDetailExtra | null>(null);
  const [loading, setLoading] = useState(false);
  /** 代数守卫：快速切换详情（相关推荐跳片）时丢弃过期响应 */
  const genRef = useRef(0);
  /** 当前打开的影评（全文窗口；null = 未打开） */
  const [openReview, setOpenReview] = useState<{ id: string; url: string } | null>(null);

  useEffect(() => {
    const n = (name || '').trim();
    const gen = ++genRef.current;
    if (!n) {
      setData(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setData(null);
    client
      .metaDoubanExtra(n, year || undefined)
      .then((d) => { if (genRef.current === gen) setData(d); })
      .catch(() => { if (genRef.current === gen) setData(null); })
      .finally(() => { if (genRef.current === gen) setLoading(false); });
  }, [name, year]);

  const recs = data?.recommendations ?? [];
  const reviews = data?.reviews ?? [];

  if (loading) return <div className="dx-wrap"><div className="muted dx-loading">豆瓣加载中…</div></div>;
  if (!data || (!recs.length && !reviews.length)) return null;

  return (
    <div className="dx-wrap">
      <div className="dx-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          className={`dx-tab${tab === 'rec' ? ' active' : ''}`}
          aria-selected={tab === 'rec'}
          onClick={() => setTab('rec')}
        >
          相关推荐{recs.length ? ` (${recs.length})` : ''}
        </button>
        <button
          type="button"
          role="tab"
          className={`dx-tab${tab === 'review' ? ' active' : ''}`}
          aria-selected={tab === 'review'}
          onClick={() => setTab('review')}
        >
          豆瓣影评{reviews.length ? ` (${reviews.length})` : ''}
        </button>
      </div>

      {tab === 'rec' ? (
        recs.length ? (
          <div className="dx-list">
            {recs.map((r) => (
              <div
                key={r.id}
                className="dx-rec"
                title="点击全源搜索该片"
                onClick={() => onSearch(r.title)}
              >
                {r.poster ? (
                  <img
                    className="dx-poster"
                    src={sizedImageUrl(r.poster, 84)}
                    alt=""
                    loading="lazy"
                    decoding="async"
                    onError={(e) => { e.currentTarget.style.visibility = 'hidden'; }}
                  />
                ) : (
                  <div className="dx-poster dx-poster-none">暂无封面</div>
                )}
                <div className="dx-body">
                  <div className="dx-title">
                    <span className="dx-title-text">{r.title}</span>
                    {r.year ? <span className="dx-year">（{r.year}）</span> : null}
                    {typeof r.rating === 'number' ? <span className="dx-rating">{r.rating.toFixed(1)}</span> : null}
                  </div>
                  {r.subtitle ? <div className="dx-sub">{r.subtitle}</div> : null}
                  {r.overview ? <div className="dx-overview">{r.overview}</div> : null}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="muted dx-empty">豆瓣暂无相关推荐</div>
        )
      ) : reviews.length ? (
        <div className="dx-list">
          {reviews.map((v) => (
            <div
              key={v.id}
              className="dx-review"
              title="点击查看影评全文"
              onClick={() => setOpenReview({ id: v.id, url: v.url })}
            >
              <div className="dx-title"><span className="dx-title-text">{v.title}</span></div>
              {v.abstract ? <div className="dx-abstract">{v.abstract}</div> : null}
              <div className="dx-meta">
                {v.author ? <span>{v.author}</span> : null}
                {typeof v.rating === 'number' ? <span>{REVIEW_RATING_LABEL[v.rating] || `${v.rating}/5`}</span> : null}
                {v.useful > 0 ? <span>有用 {v.useful}</span> : null}
                {v.date ? <span>{v.date.slice(0, 10)}</span> : null}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="muted dx-empty">豆瓣暂无影评</div>
      )}

      {/* 影评全文窗口（样式同首启「使用声明」；`.page-anim` 动画结束后无 transform ⇒ 视口定位正常） */}
      {openReview && (
        <ReviewModal reviewId={openReview.id} fallbackUrl={openReview.url} onClose={() => setOpenReview(null)} />
      )}
    </div>
  );
}
