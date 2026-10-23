// tests/virtualWindow.spec.ts — DOM 真虚拟化的「可见区间」纯计算（新增）
import { describe, it, expect } from 'vitest';
import { computeVirtualWindow, parseColumnCount, type VirtualWindowInput } from '../src/renderer/lib/virtualWindow';

const base: VirtualWindowInput = { count: 100, cols: 5, rowPitch: 240, gridTop: 0, scrollTop: 0, viewport: 800, overscan: 0 };

describe('parseColumnCount — 从 grid-template-columns 解析列数', () => {
  it('浏览器解析后的像素轨道列表 → 按空白切分计数', () => {
    expect(parseColumnCount('192.5px 192.5px 192.5px')).toBe(3);
    expect(parseColumnCount('148px')).toBe(1);
  });
  it('未参与布局（none / 空串）→ 0（调用方据此退化为整表渲染）', () => {
    expect(parseColumnCount('none')).toBe(0);
    expect(parseColumnCount('')).toBe(0);
    expect(parseColumnCount(undefined as unknown as string)).toBe(0);
  });
});

describe('computeVirtualWindow — 可见区间', () => {
  it('空列表 → 空区间', () => {
    expect(computeVirtualWindow({ ...base, count: 0 })).toEqual({ start: 0, end: 0 });
  });

  it('尺寸未知（行节距/可视高为 0）→ 退化为整表渲染，绝不出现空洞', () => {
    expect(computeVirtualWindow({ ...base, rowPitch: 0 })).toEqual({ start: 0, end: 100 });
    expect(computeVirtualWindow({ ...base, viewport: 0 })).toEqual({ start: 0, end: 100 });
  });

  it('停在顶部：只渲染前几行（行数 = ceil(可视高 / 节距)）', () => {
    // 可视 800px / 节距 240px ⇒ 覆盖 0..3.33 → 4 行 → 20 条
    expect(computeVirtualWindow(base)).toEqual({ start: 0, end: 20 });
  });

  it('滚到中部：按 scrollTop 折算行号，且区间按整行对齐', () => {
    // scrollTop 2400 / 240 = 第 10 行起；2400+800 = 3200 → ceil(13.33)=14 行止
    const w = computeVirtualWindow({ ...base, scrollTop: 2400 });
    expect(w).toEqual({ start: 50, end: 70 });
    expect(w.end - w.start).toBe(base.cols * 4);
  });

  it('网格不在容器顶部（前面还有 banner/分类条）→ gridTop 参与折算', () => {
    // 视窗在内容坐标 [1000, 1800]；网格从 400 开始 ⇒ 网格内 [600, 1400] → 第 2..5.83 行
    expect(computeVirtualWindow({ ...base, gridTop: 400, scrollTop: 1000 })).toEqual({ start: 10, end: 30 });
  });

  it('网格整体在视窗下方（还没滚到）→ 仍渲染第一行，不留空洞', () => {
    expect(computeVirtualWindow({ ...base, gridTop: 5000, scrollTop: 0 })).toEqual({ start: 0, end: 5 });
  });

  it('滚过末尾：钳到最后一屏，不越界', () => {
    const w = computeVirtualWindow({ ...base, scrollTop: 999_999 });
    expect(w.end).toBe(100);
    expect(w.start).toBe(95); // 100 条 / 5 列 = 20 行 → 最后一行
  });

  it('末行不满列数：end 钳到总条数', () => {
    expect(computeVirtualWindow({ ...base, count: 22, scrollTop: 999_999 })).toEqual({ start: 20, end: 22 });
  });

  it('预取边距（overscan）上下各放宽对应像素', () => {
    // 上下各 240px = 各一行 ⇒ 顶部多一行、底部多一行
    expect(computeVirtualWindow({ ...base, overscan: 240 })).toEqual({ start: 0, end: 25 });
  });

  it('可视高度恰好压在行边界 → 该行仍整行渲染（ceil 口径）', () => {
    expect(computeVirtualWindow({ ...base, viewport: 480 })).toEqual({ start: 0, end: 10 });
  });
});
