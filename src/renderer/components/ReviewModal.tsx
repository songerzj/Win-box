// src/renderer/components/ReviewModal.tsx
// 点详情页「豆瓣影评」某一行 → 弹**独立小窗口**看**影评全文**
//   （样式照「首次启动的使用声明」那套：`.modal-scrim` + `.card modal-in`，居中卡片、内部可滚）。
// 数据：`meta:doubanReview`（主进程按需拉 `rexxar/api/v2/review/{id}`，**不随列表预取**：单篇全文 25KB 级）。
// 正文以「段落 + 图片」块交付（主进程已剥标签，**不用 dangerouslySetInnerHTML** ⇒ 无 XSS 面）；
//   图片经本地 `/img` 中继（防图床 DNS 污染/防盗链），`loading="lazy"` 只在滚到时才拉。
import { useEffect, useState } from 'react';
import { client } from '../api/client';
import type { DoubanReviewDetail } from '../../shared/types';

/** 豆瓣影评评分（1~5）→ 豆瓣自己的说法 */
const RATING_LABEL: Record<number, string> = { 1: '很差', 2: '较差', 3: '还行', 4: '推荐', 5: '力荐' };

interface Props {
  reviewId: string;
  /** 拉不到正文时的出口（豆瓣影评页） */
  fallbackUrl?: string;
  onClose: () => void;
}

export default function ReviewModal({ reviewId, fallbackUrl, onClose }: Props) {
  const [data, setData] = useState<DoubanReviewDetail | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setData(null);
    client
      .metaDoubanReview(reviewId)
      .then((d) => { if (alive) setData(d); })
      .catch(() => { if (alive) setData(null); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [reviewId]);

  // Esc 关闭（与其它弹层同一交互口径）
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const openUrl = data?.url || fallbackUrl || '';
  const images = data ? data.blocks.filter((b) => b.type === 'image').length : 0;

  return (
    <div
      className="modal-scrim"
      style={{
        position: 'fixed', inset: 0, zIndex: 300, display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'rgba(0,0,0,.55)', backdropFilter: 'blur(4px)',
      }}
      onClick={onClose}
    >
      <div
        className="card modal-in"
        style={{
          width: 640, maxWidth: '92vw', maxHeight: '82vh', overflow: 'auto', padding: 22,
          background: 'var(--surface-2)', boxShadow: '0 18px 60px rgba(0,0,0,.5)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="row" style={{ marginBottom: 8, alignItems: 'flex-start', gap: 10 }}>
          <h3 style={{ margin: 0, fontSize: 16, lineHeight: 1.5 }}>{data?.title || '豆瓣影评'}</h3>
          <button className="linkbtn" style={{ marginLeft: 'auto', flex: '0 0 auto' }} onClick={onClose}>关闭</button>
        </div>

        {data && (
          <div className="muted" style={{ fontSize: 12, marginBottom: 12, display: 'flex', flexWrap: 'wrap', gap: 10 }}>
            {data.author ? <span>{data.author}</span> : null}
            {typeof data.rating === 'number' ? <span>{RATING_LABEL[data.rating] || `${data.rating}/5`}</span> : null}
            {data.useful > 0 ? <span>有用 {data.useful}</span> : null}
            {data.comments > 0 ? <span>回应 {data.comments}</span> : null}
            {data.date ? <span>{data.date.slice(0, 10)}</span> : null}
            {data.spoiler ? <span style={{ color: 'var(--warn)' }}>含剧透</span> : null}
            {images > 0 ? <span>{images} 张图</span> : null}
          </div>
        )}

        {loading ? (
          <div className="empty"><span className="spinner" aria-hidden="true" />正在加载影评全文…</div>
        ) : !data ? (
          <div className="muted" style={{ fontSize: 13, lineHeight: 1.8 }}>
            影评全文暂时打不开（可能被豆瓣风控或该影评已删除）。可点下方「在豆瓣打开」直接去看。
          </div>
        ) : (
          <div style={{ fontSize: 13.5, lineHeight: 1.9 }}>
            {data.blocks.map((b, i) =>
              b.type === 'image' ? (
                <figure key={`i${i}`} style={{ margin: '10px 0' }}>
                  <img
                    className="rv-img"
                    src={b.url}
                    alt={b.caption || ''}
                    loading="lazy"
                    decoding="async"
                    onError={(e) => { e.currentTarget.style.display = 'none'; }}
                  />
                  {b.caption ? <figcaption className="muted" style={{ fontSize: 11.5, marginTop: 4, textAlign: 'center' }}>{b.caption}</figcaption> : null}
                </figure>
              ) : (
                <p key={`t${i}`} style={{ margin: '0 0 10px' }}>{b.text}</p>
              ),
            )}
          </div>
        )}

        <div className="row" style={{ justifyContent: 'flex-end', gap: 10, marginTop: 18 }}>
          {openUrl ? <button style={{ flex: '0 0 auto' }} onClick={() => window.open(openUrl, '_blank', 'noopener,noreferrer')}>在豆瓣打开</button> : null}
          <button className="primary" style={{ flex: '0 0 auto' }} onClick={onClose}>关闭</button>
        </div>
      </div>
    </div>
  );
}
