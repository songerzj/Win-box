// src/renderer/components/MiniMarkdown.tsx
// 极简 Markdown 渲染器 —— 仅供更新弹窗展示 Release notes。
//
// 设计：解析交给纯函数 `lib/miniMarkdown`（可单测），本文件只做「AST → React 节点」。
//   ① 不用 `dangerouslySetInnerHTML`：Release notes 是网络内容，走 React 节点天然转义；
//   ② 链接一律 `window.open` → 主窗口 `setWindowOpenHandler` → `shell.openExternal`，
//      与应用内其它外链同款口径（不在渲染进程里直接跳转）；
//   ③ 块/行内渲染写成**普通函数**（返回节点），不拆成子组件 —— 层级只有一层，
//      也便于 `tests/updateGate.spec.ts` 这类「单层树」宿主直接断言结构。
import { useMemo, type ReactNode } from 'react';
import { parseMarkdown, type Block, type Inline } from '../lib/miniMarkdown';

function openExternal(url: string): void {
  window.open(url, '_blank', 'noopener,noreferrer');
}

/** 行内片段 → 节点数组 */
function renderInlines(items: Inline[]): ReactNode[] {
  return items.map((it, idx) => {
    if (it.kind === 'strong') return <strong key={idx}>{it.text}</strong>;
    if (it.kind === 'code') return <code key={idx} className="md-code">{it.text}</code>;
    if (it.kind === 'link') {
      return (
        <a
          key={idx}
          href={it.href}
          className="md-link"
          title={it.href}
          onClick={(e) => {
            e.preventDefault();
            openExternal(it.href);
          }}
        >
          {it.text}
        </a>
      );
    }
    return <span key={idx}>{it.text}</span>;
  });
}

/** 块级片段 → 单个节点 */
function renderBlock(block: Block, key: number): ReactNode {
  switch (block.kind) {
    case 'heading': {
      // 弹窗空间有限，标题层级只保留两档视觉（h1/h2 大一档，其余同小档）
      const Tag = (block.level <= 2 ? 'h4' : 'h5') as 'h4' | 'h5';
      return <Tag key={key} className={`md-h md-h${block.level}`}>{renderInlines(block.inlines)}</Tag>;
    }
    case 'paragraph':
      return <p key={key} className="md-p">{renderInlines(block.inlines)}</p>;
    case 'quote':
      return <blockquote key={key} className="md-quote">{renderInlines(block.inlines)}</blockquote>;
    case 'list': {
      const Tag = block.ordered ? 'ol' : 'ul';
      return (
        <Tag key={key} className="md-list">
          {block.items.map((it, idx) => <li key={idx}>{renderInlines(it)}</li>)}
        </Tag>
      );
    }
    case 'code':
      return <pre key={key} className="md-pre"><code>{block.text}</code></pre>;
    case 'hr':
      return <hr key={key} className="md-hr" />;
    case 'table':
      return (
        <div key={key} className="md-table-wrap">
          <table className="md-table">
            <thead>
              <tr>{block.header.map((c, idx) => <th key={idx}>{renderInlines(c)}</th>)}</tr>
            </thead>
            <tbody>
              {block.rows.map((row, r) => (
                <tr key={r}>{row.map((c, idx) => <td key={idx}>{renderInlines(c)}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    default:
      return null;
  }
}

export default function MiniMarkdown({ source, fallback }: { source: string; fallback?: string }) {
  const blocks = useMemo(() => parseMarkdown(source || ''), [source]);
  // 解析不出任何块（空说明）→ 回退文案；仍走同一套渲染，保证版式一致
  const list = blocks.length ? blocks : parseMarkdown(fallback || '');
  return <div className="md-body">{list.map((b, i) => renderBlock(b, i))}</div>;
}
