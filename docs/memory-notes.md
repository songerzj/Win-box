# 渲染层内存专项（海报墙 / 封面解码）

> 结论与实测数据，**改这块之前先读这里**，别凭直觉优化。
> 相关代码：`src/renderer/components/VirtualGrid.tsx`、`src/renderer/lib/useCovers.ts`、
> `src/renderer/lib/imageSize.ts`。

## 0. 一句话结论

Electron 的**运行时基线约 390MB 私有内存**（空载、CPU 0.3%）是这条路线的门票，**不是缺陷**；
真正能打下来的是**列表页的封面解码量** —— 500 条收藏场景实测：总私有 1442MB → 1015MB，总工作集 1113MB → 631MB。

## 1. 基线：空载到底多少（1.22.3，Win11，1280×800）

| 进程 | 私有 | 说明 |
|---|---|---|
| GPU 进程 | 173MB | 合成 + 纹理，**不是 Mica 造成的**（见 §5） |
| 主进程 | 152MB | Node + asar 模块 |
| 渲染进程 | 53MB | V8 堆仅 10MB、DOM 94 节点 —— **最健康的一项** |
| 网络服务 | 14MB | 固定开销 |
| **合计** | **392MB**（工作集 481MB） | 空闲 CPU **0.31%**，10 秒零增长 ⇒ 无泄漏 |

⇒ **别把「Electron 占 400MB」当 bug 修**；也不要据此换框架（上游 `MisaTV` 是 `基于C#的Win-box重构版`，
仓库 0KB、建库后无提交，跟随等于从零重写）。

## 2. 真正的瓶颈：`useCovers` 全量解码

`useCovers(items)` 对**列表每一项**都入队 `resolveCover`，而它的 `validate` 是 `preloadImage(url)` ——
**会真实解码一张图**。并发只有 4 条 lane，但**没有总量上限** ⇒ 500 条就解码 500 张。

★ 关键：`useCovers` 活在 **DOM 之外**，虚拟滚动管不到它。
**只做虚拟化而不治它，内存只降一半**（DOM 少了，解码照旧）。

## 3. 已做的三件事（1.22.4）

| 改动 | 位置 | 作用 |
|---|---|---|
| `COVER_PARSE_CAP = 120` | `useCovers.ts` | 只解析前 120 条；超出由 `picOf` 回退到源封面（**不会空白**，只是少了 TMDB 换图） |
| `GRID_COVER_CSS_PX = 200` + `sizedImageUrl` 铺开 | 首页 / 收藏 / 历史 | 豆瓣海报按显示宽度降档（`s=270` / `m=540` / `l=1080`），实测 90 张从 146MB → 38MB |
| 收藏页接 `VirtualGrid` | `FavoritesPage.tsx` | 离屏卡片换等高占位块；**收藏是唯一无条数上限的列表页** |

★ **降档必须在交给 `useCovers` 之前做**（改 `coverItem` 的 `pic`），不能在 `<img src>` 处做 ——
否则校验解码的仍是大图，白降。

## 4. 实测对比（500 条收藏、5 个源 × 100 条、滚到底再回顶）

| 指标 | 1.22.3 | 1.22.4 | 变化 |
|---|---|---|---|
| DOM 卡片（顶部 / 底部） | 500 / 500 | 72 / 52 | **−86% / −90%** |
| 已加载封面 | 501 | 41~53 | **−89%** |
| 解码位图（顶部 / 回顶后） | 208.6 / 208.6 MB | 20.0 / **16.7 MB** | **−90% / −92%** |
| 渲染进程私有 | 509MB | 201MB | −60% |
| 总私有 | 1442MB | 1015MB | **−30%** |
| 总工作集 | 1113MB | 631MB | **−43%** |
| `scrollHeight` | 22472px | 22476px | +4px（占位块精度 0.02%） |

★ 1.22.3 的特征是「**滚回顶部完全不释放**」（208.6MB 一直挂着）；1.22.4 回顶后降到 16.7MB。

## 5. Mica 对照：没有显著影响，别为它去掉

同一包、同一页面（`#/about`）、各采样 6 次 GPU 进程私有内存：

| 配置 | GPU 私有（中位数） | 波动 |
|---|---|---|
| 含 Mica（默认） | **224MB** | 223–224（极稳） |
| `WINBOX_NO_MICA=1` | 232MB | 194–242（波动大） |

⇒ 差异落在噪声内，**关掉反而略高**（DWM 合成 vs 自己画实心底层）。
Mica 保留为默认，但**留了 `WINBOX_NO_MICA=1` 环境变量**（低端核显 / 远程桌面可手动关，见 `src/main/index.ts` 的 `useMica()`）。

## 6. 复现方法

1. 起一个本地图片服务（任意路径返回同一张 270×405 PNG，URL 不同 ⇒ 浏览器视为不同资源、各自独立解码）：

```python
# 关键点：每条收藏的 pic 指向 /c/<n>.png，形状 270x405（豆瓣 s 档，单张解码 270*405*4 ≈ 437KB）
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
```

2. 打包版起 CDP（`--remote-debugging-port=<port>`，必须 `env -u ELECTRON_RUN_AS_NODE`）。
3. 注入 500 条收藏后 `location.reload()`，再进 `#/favorites`：

```js
localStorage.setItem('winbox-favorites', JSON.stringify({
  favorites: [['srcA\u00000', { name: 'x', sourceKey: 'srcA', pic: 'http://127.0.0.1:8791/c/1.png', createdAt: Date.now() }]],
  deleted: [],
}));
```

4. 测 `document.querySelectorAll('.card-media').length`、`document.images` 中 `complete && naturalWidth>0`
   的像素总量（×4 字节 = 解码位图），再配合 `Get-Process` 读各进程 `PrivateMemorySize64`。
5. ★ 测完**必须删 `win-unpacked/data`**，否则下次打包会把测试配置带进去。

## 7. 已知取舍 / 后续

- **历史页不需要虚拟化**：数据源是 `recentWatch(100)`，硬上限 100 条。
- **收藏页展开行内编辑**会让实测卡高变大 ⇒ 全表高度 +125px（约 0.5%），但 **`scrollTop` 零漂移**，
  且 `editing` 状态在页面级、离屏卸载不丢输入 ⇒ 接受现状，不必特殊处理。
- **未做**：让 `VirtualGrid` 暴露可见区间、`useCovers` 只解析可见项。收益是把 120 张进一步压到 ~40 张，
  但要让 4 个页面都接区间回调，改动面大；当前 cap 方案性价比更高。
- 若将来发现封面「换图」有可感知延迟（前 120 条之外的项走源封面），再考虑上面的可见区间方案。
