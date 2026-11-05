// Execute the real TSX component with a minimal hook host (no Electron/DOM or added dependencies).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { transformSync } from 'esbuild';
import { formatBytes, type UpdateCheckResult, type UpdateProgress } from '../src/shared/update';
import { isDetailWinHash } from '../src/shared/detailWin';
import { parseMarkdown } from '../src/renderer/lib/miniMarkdown';

interface Node {
  type: unknown;
  props: Record<string, any>;
  children: any[];
}
const source = readFileSync(new URL('../src/renderer/components/UpdateGate.tsx', import.meta.url), 'utf8')
  .replace(/^import .*;\r?$/gm, '')
  .replace('export default function UpdateGate', 'function UpdateGate');
const compiled = transformSync(source + '\nglobalThis.component = UpdateGate;', {
  loader: 'tsx', jsxFactory: 'h', jsxFragment: 'Fragment', target: 'es2022',
}).code;

/** 更新说明已改由 MiniMarkdown 渲染 —— 同样剥 import 后在同一个 VM 里跑真实组件 */
const mdSource = readFileSync(new URL('../src/renderer/components/MiniMarkdown.tsx', import.meta.url), 'utf8')
  .replace(/^import .*;\r?$/gm, '')
  .replace('export default function MiniMarkdown', 'function MiniMarkdown');
const mdCompiled = transformSync(mdSource + '\nglobalThis.MiniMarkdown = MiniMarkdown;', {
  loader: 'tsx', jsxFactory: 'h', jsxFragment: 'Fragment', target: 'es2022',
}).code;
const available: UpdateCheckResult = {
  localVersion: '1.21.1', remoteVersion: '1.21.2', tag: 'release1.21.2', updateAvailable: true,
  releaseNotes: '详细更新说明\n- 支持纯 Python 包', publishedAt: '2026-10-13T08:00:00Z',
  asset: { name: 'Win-Box Setup 1.21.2.exe', size: 1000, url: 'https://example.test/setup.exe', accelUrls: [] },
};

function host(hash = '#/', search = false) {
  const slots: any[] = [];
  const effects = new Map<number, { deps: unknown[]; cleanup?: () => void }>();
  let cursor = 0;
  let pending: Array<() => void> = [];
  let onProgress: (p: UpdateProgress) => void = () => {};
  const client = {
    updateCheck: vi.fn().mockResolvedValue(available),
    updateDownload: vi.fn().mockResolvedValue({ ok: true }),
    updateInstall: vi.fn().mockResolvedValue({ ok: true }),
    onUpdateProgress: vi.fn((cb: typeof onProgress) => { onProgress = cb; return vi.fn(); }),
  };
  const context: any = {
    client, formatBytes, isDetailWinHash, isSearchWindow: () => search,
    window: { location: { hash } }, Fragment: 'fragment',
    parseMarkdown,
    // MiniMarkdown 只用 useMemo 做解析缓存；这里直接求值即可（组件本身无状态）
    useMemo: (fn: () => unknown) => fn(),
    h: (type: unknown, props: Record<string, any> | null, ...children: any[]): Node => ({ type, props: props || {}, children }),
    useState: (initial: unknown) => {
      const i = cursor++;
      if (!(i in slots)) slots[i] = initial;
      return [slots[i], (value: unknown) => { slots[i] = value; }];
    },
    useRef: (initial: unknown) => {
      const i = cursor++;
      if (!(i in slots)) slots[i] = { current: initial };
      return slots[i];
    },
    useEffect: (fn: () => void | (() => void), deps: unknown[]) => {
      const i = cursor++;
      const old = effects.get(i);
      if (old && deps.every((v, j) => Object.is(v, old.deps[j]))) return;
      pending.push(() => {
        old?.cleanup?.();
        effects.set(i, { deps, cleanup: fn() || undefined });
      });
    },
  };
  runInNewContext(mdCompiled, context);
  runInNewContext(compiled, context);
  const child = { type: 'page', props: {}, children: ['正常页面'] };
  return {
    client, child,
    render: (): Node => {
      cursor = 0;
      pending = [];
      const tree = context.component({ children: child });
      pending.forEach(fn => fn());
      return tree;
    },
    progress: (p: UpdateProgress) => onProgress(p),
  };
}
/**
 * 遍历宿主树 → 扁平节点表（对象节点 + 叶子文本）。
 * ★ 遇到 `type` 是函数的节点（如 `<MiniMarkdown/>`）就**按 props 调用并展开**其返回值 ——
 *   这个宿主只有一层 `h()`，不会自己渲染函数组件；不展开就会把组件当成空节点。
 */
function collect(tree: any, acc: any[] = []): any[] {
  if (tree == null || tree === false) return acc;
  if (Array.isArray(tree)) {
    tree.forEach(t => collect(t, acc));
    return acc;
  }
  if (typeof tree !== 'object') {
    acc.push(tree);
    return acc;
  }
  if (typeof tree.type === 'function') {
    return collect(tree.type({ ...tree.props, children: tree.children }), acc);
  }
  acc.push(tree);
  tree.children.forEach((c: any) => collect(c, acc));
  return acc;
}
function nodes(tree: any): Node[] {
  return collect(tree).filter(n => n && typeof n === 'object');
}
function text(tree: any): string {
  return collect(tree)
    .map(n => (n && typeof n === 'object' ? '' : n === false || n == null ? '' : String(n)))
    .join('');
}
function button(tree: Node, label: string): Node {
  const found = nodes(tree).find(node => node.type === 'button' && text(node) === label);
  expect(found, `button ${label}`).toBeDefined();
  return found!;
}
const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

describe('启动更新提示（真实 TSX 组件行为）', () => {
  beforeEach(() => vi.clearAllMocks());

  it('发现新版本只展示说明与两个选项，不自动下载或安装', async () => {
    const h = host();
    const initial = h.render();
    await settle();
    const tree = h.render();
    expect(text(tree)).toContain('1.21.1 → 1.21.2');
    // 说明是 Markdown（`详细更新说明\n- 支持纯 Python 包`）→ 现在渲染成段落 + 列表，
    // 断言从「原文一字不差」改为「内容都在、且 `- ` 标记没漏出来」。
    expect(text(tree)).toContain('详细更新说明');
    expect(text(tree)).toContain('支持纯 Python 包');
    expect(text(tree)).not.toContain('- 支持');
    button(tree, '立即更新');
    button(tree, '暂不更新');
    expect(h.client.updateDownload).not.toHaveBeenCalled();
    expect(h.client.updateInstall).not.toHaveBeenCalled();
    expect(tree.children[0].type).toBe(initial.children[0].type);
    expect(tree.children[0].children[0]).toBe(h.child);
  });

  it('暂不更新解除遮罩且不重挂载页面；本次挂载不再检查', async () => {
    const h = host(); h.render(); await settle();
    button(h.render(), '暂不更新').props.onClick();
    const tree = h.render();
    expect(nodes(tree).some(n => n.props.role === 'dialog')).toBe(false);
    expect(tree.children[0].props.inert).toBeUndefined();
    expect(tree.children[0].children[0]).toBe(h.child);
    expect(h.client.updateCheck).toHaveBeenCalledTimes(1);
    expect(h.client.updateDownload).not.toHaveBeenCalled();
    expect(h.client.updateInstall).not.toHaveBeenCalled();
  });

  it('立即更新才开始下载，防止连点，下载成功后才安装', async () => {
    const h = host(); h.render(); await settle();
    let finish!: (value: any) => void;
    h.client.updateDownload.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const start = button(h.render(), '立即更新').props.onClick;
    start(); start();
    expect(h.client.updateDownload).toHaveBeenCalledTimes(1);
    expect(h.client.updateInstall).not.toHaveBeenCalled();
    expect(text(h.render())).toContain('测速');
    finish({ ok: true }); await settle();
    expect(h.client.updateInstall).toHaveBeenCalledTimes(1);
  });

  it('下载失败仍可暂不更新；重试会重新进入测速，成功后安装', async () => {
    const h = host(); h.client.updateDownload.mockResolvedValueOnce({ ok: false, error: '网络不可达' });
    h.render(); await settle(); button(h.render(), '立即更新').props.onClick(); await settle();
    const failure = h.render();
    expect(text(failure)).toContain('网络不可达');
    button(failure, '暂不更新');
    expect(h.client.updateInstall).not.toHaveBeenCalled();
    button(failure, '重试').props.onClick();
    expect(text(h.render())).toContain('测速');
    await settle(); expect(h.client.updateInstall).toHaveBeenCalledTimes(1);
  });

  it('安装启动失败也允许跳过', async () => {
    const h = host(); h.client.updateInstall.mockRejectedValueOnce(new Error('无法启动安装程序'));
    h.render(); await settle(); button(h.render(), '立即更新').props.onClick(); await settle();
    expect(text(h.render())).toContain('无法启动安装程序');
    button(h.render(), '暂不更新').props.onClick();
    expect(nodes(h.render()).some(n => n.props.role === 'dialog')).toBe(false);
  });

  it.each(['reject', 'current', 'no-asset'])('检查异常/无更新/无安装包正常放行：%s', async mode => {
    const h = host();
    if (mode === 'reject') h.client.updateCheck.mockRejectedValueOnce(new Error('offline'));
    else h.client.updateCheck.mockResolvedValueOnce({ ...available, updateAvailable: mode !== 'current', asset: undefined });
    h.render(); await settle();
    expect(nodes(h.render()).some(n => n.props.role === 'dialog')).toBe(false);
    expect(h.client.updateDownload).not.toHaveBeenCalled();
  });

  it.each([['#/player', false], ['#/detail/a/b?dw=1', false], ['#/search?q=a&sw=1', true]])('独立窗口不检查、不下载：%s', (hash, search) => {
    const h = host(hash, search); h.render();
    expect(h.client.updateCheck).not.toHaveBeenCalled();
    expect(h.client.onUpdateProgress).not.toHaveBeenCalled();
  });

  it('更新说明按 Markdown 渲染：标题/加粗/表格不漏出标记符号', async () => {
    const md = '## 修了什么\n\n这是**重点**。\n\n| 指标 | 旧 | 新 |\n|---|---|---|\n| 内存 | 1442 | 1015 |';
    const h = host();
    h.client.updateCheck.mockResolvedValueOnce({ ...available, releaseNotes: md });
    h.render(); await settle();
    const tree = h.render();
    const t = text(tree);
    expect(t).toContain('修了什么');
    expect(t).toContain('重点');
    expect(t).toContain('1015');
    expect(t).not.toContain('##');
    expect(t).not.toContain('**');
    expect(t).not.toContain('|');
    // 表格真的成了 table 节点（不是把竖线当文本吐出来）
    expect(nodes(tree).some(n => n.type === 'table')).toBe(true);
    // 依然不拼 HTML 字符串
    expect(nodes(tree).some(n => n.props.dangerouslySetInnerHTML)).toBe(false);
  });

  it('无说明/非法发布日期容错，不注入 HTML', async () => {
    const h = host(); h.client.updateCheck.mockResolvedValueOnce({ ...available, releaseNotes: '', publishedAt: 'bad date' });
    h.render(); await settle();
    expect(text(h.render())).toContain('暂无详细更新说明');
    expect(text(h.render())).not.toContain('Invalid Date');
    expect(nodes(h.render()).some(n => n.props.dangerouslySetInnerHTML)).toBe(false);
  });
});
