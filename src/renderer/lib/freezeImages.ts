// src/renderer/lib/freezeImages.ts
// （播放 1080P 吃数百 MB、太臃肿 专项 **B3：冻结 / 解冻**）。
//
// 依据（实测确认，见 docs/design/内存优化_专项立项.md §2.9）：主窗口图片墙的**已解码位图 ≈130~200MB**
//   记在 **GPU 进程**里。播放器窗口打开期间用户并不看主窗口，把这批位图释放掉不影响观感。
//
// 口径（「零重载」方案，**刻意不做释放后重建**）：
//   · **只清 `img.src`**（原值备份到 `data-wb-frozen-src` 属性），**React 树与全部数据原地保留**；
//   · 解冻时把 `src` 挂回 —— 走浏览器 HTTP 缓存**重新解码**，不回源、不重建页面、不丢滚动/搜索/分类态；
//   · 只处理**当前不可见**的图：① 整窗被遮挡（`document.visibilityState === 'hidden'`，即被播放器窗盖住/最小化）；
//     ② 落在隐藏页里（无任何布局盒 = `display:none` 的伪墓碑缓存页）。
//   · 可见的图**永不冻结**，且可见化会被立刻挂回（防「返回缓存页看到空图」）。
//
// 追加实测（把「离屏冻结」这条候选**证伪**，勿再走一遍）：
//   · 对**页面内离屏**的图（海报墙滚过去那批）做同样的 `src` 置空，**GPU 占用不降反升**
//     （同场景 未冻结 231MB → 冻结后 300MB；`loaded` 1、`frozen` 90 —— 位图确实没在渲染，但工作集没退回）；
//   · 真正带来 GPU 大幅回落的是「**整窗被遮挡**」：合成器丢掉该窗口的 tile
//     （这就是 B3 打开播放器窗时能实测 −133MB 的原因），而不是 `img.src` 变化本身。
//   · 结论：**别再靠 `img.src` 去回收海报墙的显存**；要降「海报墙在屏时的峰值」，只能**少挂图（卸 DOM）**或**少解码（要小图）**。

/** 冻结期间记录原地址的属性名（用属性而非 dataset，规避 camelCase ↔ data-* 的命名换算） */
const FROZEN_ATTR = 'data-wb-frozen-src';
/** 占位用的 1×1 透明 GIF：不触发破图图标，也不触发 `onError` 逻辑 */
const BLANK_PIXEL = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
/** 冻结期间的巡检间隔：兜住「播放中在主窗口里切页」这类可见性变化 */
const SWEEP_MS = 1500;

let active = false;
let timer: ReturnType<typeof setInterval> | null = null;
let onVisibility: (() => void) | null = null;

/** 元素是否真的不可见：没有任何布局盒 = 落在 `display:none` 的隐藏页子树里 */
function isInvisible(el: Element): boolean {
  return el.getClientRects().length === 0;
}

/** 按当前可见性把每张图对齐到「该冻结 / 该挂回」 */
function reconcile(): void {
  const allHidden = document.visibilityState === 'hidden';
  for (const el of Array.from(document.querySelectorAll('img'))) {
    const img = el as HTMLImageElement;
    const frozen = img.getAttribute(FROZEN_ATTR);
    if (!allHidden && !isInvisible(img)) {
      // 可见 → 必须挂回（否则用户会看到空图）
      if (frozen !== null) {
        img.src = frozen;
        img.removeAttribute(FROZEN_ATTR);
      }
      continue;
    }
    // 不可见 → 冻结（已冻结的跳过）
    if (frozen !== null) continue;
    const src = img.getAttribute('src') || '';
    // data: 图（图标/占位）本身就是内联的，释放无收益，且可能被上层逻辑依赖
    if (!src || src.startsWith('data:')) continue;
    img.setAttribute(FROZEN_ATTR, src);
    img.src = BLANK_PIXEL;
  }
}

/** 无条件把全部已冻结的 `src` 挂回 */
function thawAll(): void {
  for (const el of Array.from(document.querySelectorAll('img'))) {
    const img = el as HTMLImageElement;
    const frozen = img.getAttribute(FROZEN_ATTR);
    if (frozen === null) continue;
    img.src = frozen;
    img.removeAttribute(FROZEN_ATTR);
  }
}

/**
 * 播放器窗口开 / 关 → 冻结 / 解冻主窗口里**不可见**的已解码图片。
 * 幂等：同态重复调用直接返回；关窗时无条件全部挂回。
 */
export function setImageFreezeActive(on: boolean): void {
  const next = !!on;
  if (next === active) return;
  active = next;
  if (active) {
    reconcile();
    if (!timer) timer = setInterval(reconcile, SWEEP_MS);
    if (!onVisibility) {
      onVisibility = (): void => reconcile();
      document.addEventListener('visibilitychange', onVisibility);
    }
    return;
  }
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  if (onVisibility) {
    document.removeEventListener('visibilitychange', onVisibility);
    onVisibility = null;
  }
  thawAll();
}
