// src/renderer/components/DriveBindModal.tsx
// 播放时自动弹出的网盘绑定窗口（解析到网盘专用链接但未绑定时）—— 主体复用 DriveBindPanel；
//   软件内的常驻配置入口在「配置 → 凭据 → 网盘绑定」（同一个面板）。
import { driveProviderLabel } from '../../shared/driveProvider';
import DriveBindPanel from './DriveBindPanel';

interface Props {
  /** 当前源名（文案用） */
  siteName: string;
  /**
   * **预选网盘**（解析到某网盘专用链接、但未绑定时自动弹窗时传入）——
   *   直接把用户要绑的那家选中，省掉"自己找是哪一家"。
   */
  initialProvider?: string;
  /** 自动弹窗场景的一句上下文（如「该资源来自」），显示在标题下方 */
  reason?: string;
  onClose: () => void;
  /** 保存成功后通知外层（刷新源主页 / 重新解析当前集） */
  onSaved: () => void;
}

export default function DriveBindModal({ siteName, initialProvider, reason, onClose, onSaved }: Props) {
  const initProv = (initialProvider || '').trim().toLowerCase();

  return (
    <div
      className="modal-scrim"
      style={{
        position: 'fixed', inset: 0, zIndex: 200, background: 'rgba(0,0,0,.55)', backdropFilter: 'blur(3px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
      onClick={onClose}
    >
      <div
        className="card modal-in"
        style={{ width: 520, maxWidth: '92vw', padding: 18, background: 'var(--surface-2)', boxShadow: '0 18px 60px rgba(0,0,0,.5)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="row" style={{ marginBottom: 10 }}>
          <span style={{ fontWeight: 700 }}>网盘绑定 · {siteName}</span>
          <button className="linkbtn" style={{ marginLeft: 'auto' }} onClick={onClose}>关闭</button>
        </div>

        <div className="muted" style={{ fontSize: 12, lineHeight: 1.7, marginBottom: 10 }}>
          {initProv
            ? `检测到该资源来自「${driveProviderLabel(initProv)}」网盘的专用链接，未绑定对应 Cookie 时无法取流。绑定后回到播放页会自动重新解析。`
            : '该源需要网盘 Cookie 才能取流。'}
          {reason ? <div style={{ marginTop: 4 }}>{reason}</div> : null}
        </div>

        <DriveBindPanel initialProvider={initialProvider} onSaved={onSaved} />
      </div>
    </div>
  );
}
