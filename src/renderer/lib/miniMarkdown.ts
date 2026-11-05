// src/renderer/lib/miniMarkdown.ts
// 发布说明 / 更新日志的**极简 Markdown** 解析器 —— 纯函数，零依赖，不产出 HTML 字符串。
//
// 为什么自己写：
//   ① 更新弹窗只有一个用途（展示 Release notes），引入 marked/markdown-it 会为几十行需求
//      带上几十 KB 运行时，与「渲染层内存专项」的取舍相悖；
//   ② 产出**结构化 AST 而非 HTML 字符串**，渲染层用 React 节点落地 —— 天然转义，
//      不存在 `dangerouslySetInnerHTML` 带来的注入面（Release notes 是网络内容）。
//
// 支持子集（够发布说明用，别扩成通用解析器）：
//   `#`~`######` 标题 · `---` 分隔线 · ``` 围栏代码 · `>` 引用 · `-`/`*`/`1.` 列表 ·
//   表格（`| a | b |` + 分隔行）· 段落；行内 `**粗体**`、`` `代码` ``、`[文字](https://…)`。
// 不支持（刻意）：HTML 内嵌、图片、脚注、嵌套列表、嵌套强调 —— 遇到就按纯文本原样呈现。

/** 行内片段 */
export type Inline =
  | { kind: 'text'; text: string }
  | { kind: 'strong'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'link'; text: string; href: string };

/** 块级片段 */
export type Block =
  | { kind: 'heading'; level: number; inlines: Inline[] }
  | { kind: 'paragraph'; inlines: Inline[] }
  | { kind: 'quote'; inlines: Inline[] }
  | { kind: 'list'; ordered: boolean; items: Inline[][] }
  | { kind: 'code'; text: string }
  | { kind: 'table'; header: Inline[][]; rows: Inline[][][] }
  | { kind: 'hr' };

/** 解析上限：Release notes 是网络输入，防御性地截断，避免异常长文本拖住弹窗渲染 */
export const MARKDOWN_MAX_CHARS = 20000;

/** 只放行真正能打开的协议 —— `javascript:` / `data:` 一律降级成普通文字 */
export function isSafeHref(href: string): boolean {
  const s = String(href || '').trim();
  if (!s) return false;
  return /^(https?:\/\/|mailto:)/i.test(s);
}

/**
 * 行内解析：`**粗**` / `` `码` `` / `[文字](https://…)`。
 * 未闭合的标记按原文保留（宁可显示星号，也不要吞字符）。
 */
export function parseInline(text: string): Inline[] {
  const s = String(text ?? '');
  const out: Inline[] = [];
  let buf = '';
  let i = 0;

  const flush = (): void => {
    if (buf) {
      out.push({ kind: 'text', text: buf });
      buf = '';
    }
  };

  while (i < s.length) {
    // **粗体**
    if (s.startsWith('**', i)) {
      const end = s.indexOf('**', i + 2);
      if (end > i + 2) {
        flush();
        out.push({ kind: 'strong', text: s.slice(i + 2, end) });
        i = end + 2;
        continue;
      }
    }
    // `行内代码`
    if (s[i] === '`') {
      const end = s.indexOf('`', i + 1);
      if (end > i + 1) {
        flush();
        out.push({ kind: 'code', text: s.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }
    // [文字](链接)
    if (s[i] === '[') {
      const close = s.indexOf(']', i + 1);
      if (close > i && s[close + 1] === '(') {
        const paren = s.indexOf(')', close + 2);
        if (paren > close + 2) {
          const href = s.slice(close + 2, paren).trim();
          if (isSafeHref(href)) {
            flush();
            out.push({ kind: 'link', text: s.slice(i + 1, close), href });
            i = paren + 1;
            continue;
          }
        }
      }
    }
    buf += s[i];
    i += 1;
  }

  flush();
  return out;
}

const RE_HEADING = /^(#{1,6})\s+(.*)$/;
const RE_HR = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const RE_QUOTE = /^\s*>\s?(.*)$/;
const RE_LIST = /^\s*(?:([-*+])|(\d+)[.)])\s+(.*)$/;
const RE_FENCE = /^\s*```/;
/** 表格分隔行：只含 `|`、`-`、`:`、空白，且至少有一个 `-` */
const RE_TABLE_SEP = /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/;

/** 按 `|` 切单元格（去首尾空串，保留中间空串以对齐列） */
function splitRow(line: string): string[] {
  let s = String(line ?? '').trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map((c) => c.trim());
}

/** 主解析入口：Markdown 文本 → 块级 AST */
export function parseMarkdown(src: string): Block[] {
  const text = String(src ?? '').replace(/\r\n?/g, '\n').slice(0, MARKDOWN_MAX_CHARS);
  if (!text.trim()) return [];
  const lines = text.split('\n');
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // 空行
    if (!line.trim()) {
      i += 1;
      continue;
    }

    // 围栏代码块（未闭合 → 吃到文末，不报错）
    if (RE_FENCE.test(line)) {
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !RE_FENCE.test(lines[i])) {
        body.push(lines[i]);
        i += 1;
      }
      i += 1; // 跳过收尾围栏
      blocks.push({ kind: 'code', text: body.join('\n') });
      continue;
    }

    // 分隔线（必须在列表之前判断，否则 `---` 会被当成列表项）
    if (RE_HR.test(line)) {
      blocks.push({ kind: 'hr' });
      i += 1;
      continue;
    }

    // 标题
    const h = RE_HEADING.exec(line);
    if (h) {
      blocks.push({ kind: 'heading', level: h[1].length, inlines: parseInline(h[2].trim()) });
      i += 1;
      continue;
    }

    // 引用（连续多行合并成一段）
    if (RE_QUOTE.test(line)) {
      const parts: string[] = [];
      while (i < lines.length) {
        const q = RE_QUOTE.exec(lines[i]);
        if (!q) break;
        if (q[1].trim()) parts.push(q[1].trim());
        i += 1;
      }
      blocks.push({ kind: 'quote', inlines: parseInline(parts.join(' ')) });
      continue;
    }

    // 表格：当前行含 `|` 且下一行是分隔行
    if (line.includes('|') && i + 1 < lines.length && lines[i + 1].includes('-') && RE_TABLE_SEP.test(lines[i + 1])) {
      const header = splitRow(line).map(parseInline);
      const rows: Inline[][][] = [];
      i += 2;
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        const cells = splitRow(lines[i]);
        // 与表头列数对齐：多的截断、少的补空，避免渲染期错列
        const norm: Inline[][] = [];
        for (let c = 0; c < header.length; c += 1) norm.push(parseInline(cells[c] ?? ''));
        rows.push(norm);
        i += 1;
      }
      blocks.push({ kind: 'table', header, rows });
      continue;
    }

    // 列表（有序 / 无序，同一块内按首个标记决定类型）
    const first = RE_LIST.exec(line);
    if (first) {
      const ordered = !first[1];
      const items: Inline[][] = [];
      while (i < lines.length) {
        const m = RE_LIST.exec(lines[i]);
        if (!m) break;
        // 类型切换（`-` ↔ `1.`）视为新列表，留到外层下一轮处理
        if (!m[1] !== !first[1]) break;
        items.push(parseInline(m[3].trim()));
        i += 1;
      }
      blocks.push({ kind: 'list', ordered, items });
      continue;
    }

    // 段落：连续非空且不是其它块起始的行，合并为一段
    const para: string[] = [];
    while (i < lines.length) {
      const l = lines[i];
      if (!l.trim()) break;
      if (RE_FENCE.test(l) || RE_HEADING.test(l) || RE_LIST.test(l) || RE_QUOTE.test(l) || RE_HR.test(l)) break;
      para.push(l.trim());
      i += 1;
    }
    if (para.length) blocks.push({ kind: 'paragraph', inlines: parseInline(para.join(' ')) });
  }

  return blocks;
}
