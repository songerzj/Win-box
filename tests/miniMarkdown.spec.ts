// tests/miniMarkdown.spec.ts — 更新弹窗的极简 Markdown 解析（纯函数）
import { describe, it, expect } from 'vitest';
import { parseMarkdown, parseInline, isSafeHref, MARKDOWN_MAX_CHARS } from '../src/renderer/lib/miniMarkdown';

describe('parseInline — 行内标记', () => {
  it('粗体 / 行内代码 / 链接 都能切出来，纯文本保持原样', () => {
    expect(parseInline('普通 **加粗** 与 `代码`')).toEqual([
      { kind: 'text', text: '普通 ' },
      { kind: 'strong', text: '加粗' },
      { kind: 'text', text: ' 与 ' },
      { kind: 'code', text: '代码' },
    ]);
    expect(parseInline('见 [发布页](https://github.com/a/b) 。')).toEqual([
      { kind: 'text', text: '见 ' },
      { kind: 'link', text: '发布页', href: 'https://github.com/a/b' },
      { kind: 'text', text: ' 。' },
    ]);
  });

  it('未闭合的标记按原文保留（不吞字符）', () => {
    expect(parseInline('**没闭合')).toEqual([{ kind: 'text', text: '**没闭合' }]);
    expect(parseInline('半个 `code')).toEqual([{ kind: 'text', text: '半个 `code' }]);
    expect(parseInline('[文字](没闭合')).toEqual([{ kind: 'text', text: '[文字](没闭合' }]);
  });

  it('危险协议降级成纯文本（不允许 javascript:）', () => {
    const r = parseInline('[点我](javascript:alert(1))');
    expect(r.some((x) => x.kind === 'link')).toBe(false);
    expect(r.map((x) => (x.kind === 'link' ? x.href : x.text)).join('')).toContain('javascript:');
  });

  it('isSafeHref 只放行 http(s) / mailto', () => {
    expect(isSafeHref('https://example.com/a')).toBe(true);
    expect(isSafeHref('http://example.com')).toBe(true);
    expect(isSafeHref('mailto:a@b.c')).toBe(true);
    expect(isSafeHref('javascript:alert(1)')).toBe(false);
    expect(isSafeHref('data:text/html,<script>')).toBe(false);
    expect(isSafeHref('')).toBe(false);
  });
});

describe('parseMarkdown — 块级结构', () => {
  it('标题分级 + 段落', () => {
    const b = parseMarkdown('# 一级\n\n正文一句。');
    expect(b[0]).toMatchObject({ kind: 'heading', level: 1 });
    expect(b[1]).toMatchObject({ kind: 'paragraph' });
  });

  it('`---` 是分隔线，不会被当成列表项', () => {
    const b = parseMarkdown('上文\n\n---\n\n下文');
    expect(b.map((x) => x.kind)).toEqual(['paragraph', 'hr', 'paragraph']);
  });

  it('无序 / 有序列表分开解析', () => {
    expect(parseMarkdown('- 甲\n- 乙')).toEqual([
      { kind: 'list', ordered: false, items: [[{ kind: 'text', text: '甲' }], [{ kind: 'text', text: '乙' }]] },
    ]);
    const ol = parseMarkdown('1. 第一步\n2. 第二步');
    expect(ol[0]).toMatchObject({ kind: 'list', ordered: true });
    expect((ol[0] as { items: unknown[] }).items).toHaveLength(2);
  });

  it('列表类型切换时拆成两个块', () => {
    expect(parseMarkdown('- 甲\n1. 乙').map((x) => (x.kind === 'list' ? x.ordered : x.kind))).toEqual([false, true]);
  });

  it('表格：表头 + 数据行，分隔行被吃掉，列数与表头对齐', () => {
    const b = parseMarkdown('| 指标 | 旧 | 新 |\n|---|---|---|\n| 内存 | 1442 | 1015 |\n| 单列 |');
    expect(b[0].kind).toBe('table');
    const t = b[0] as { header: unknown[]; rows: unknown[][] };
    expect(t.header).toHaveLength(3);
    expect(t.rows).toHaveLength(2);
    expect(t.rows[1]).toHaveLength(3); // 少给的一列补空
  });

  it('围栏代码块原样保留，内部 `#` `-` 不被解析', () => {
    const b = parseMarkdown('```\n# 不是标题\n- 不是列表\n```');
    expect(b).toEqual([{ kind: 'code', text: '# 不是标题\n- 不是列表' }]);
  });

  it('引用合并连续行', () => {
    const b = parseMarkdown('> 第一行\n> 第二行');
    expect(b[0]).toEqual({ kind: 'quote', inlines: [{ kind: 'text', text: '第一行 第二行' }] });
  });

  it('CRLF 归一化 + 空输入返回空数组', () => {
    expect(parseMarkdown('# 标题\r\n\r\n正文')[0]).toMatchObject({ kind: 'heading' });
    expect(parseMarkdown('')).toEqual([]);
    expect(parseMarkdown('   \n\n  ')).toEqual([]);
  });

  it('超长输入被截断（网络内容防御）', () => {
    const b = parseMarkdown('x'.repeat(MARKDOWN_MAX_CHARS + 5000));
    const total = b.reduce((n, x) => n + ('inlines' in x ? JSON.stringify(x.inlines).length : 0), 0);
    expect(total).toBeLessThan(MARKDOWN_MAX_CHARS + 100);
  });

  it('HTML 标签按纯文本保留（不生成 HTML，天然无注入）', () => {
    const b = parseMarkdown('<script>alert(1)</script>');
    expect(b[0]).toEqual({ kind: 'paragraph', inlines: [{ kind: 'text', text: '<script>alert(1)</script>' }] });
  });
});
