import { describe, expect, it } from 'vitest';
import { clampPage, spreadPages, turnPage } from './reading';
describe('reading pagination', () => {
  it('shows the cover alone, then pairs body pages in landscape', () => {
    expect(spreadPages(1, 6, true)).toEqual([1]);
    expect(spreadPages(2, 6, true)).toEqual([2, 3]);
    expect(spreadPages(3, 6, true)).toEqual([2, 3]);
    expect(spreadPages(6, 6, true)).toEqual([6]);
    expect(spreadPages(3, 6, false)).toEqual([3]);
  });
  it('moves through spreads without skipping a page', () => {
    expect(turnPage(1, 6, true, 1)).toBe(2);
    expect(turnPage(2, 6, true, 1)).toBe(4);
    expect(turnPage(3, 6, true, 1)).toBe(4);
    expect(turnPage(4, 6, true, -1)).toBe(2);
    expect(turnPage(2, 6, true, -1)).toBe(1);
    expect(turnPage(6, 6, true, -1)).toBe(4);
    expect(turnPage(1, 6, true, -1)).toBe(1);
    expect(turnPage(6, 6, true, 1)).toBe(6);
  });
  it('clamps invalid restored positions', () => {
    expect(clampPage(NaN, 10)).toBe(1);
    expect(clampPage(12, 10)).toBe(10);
    expect(clampPage(-1, 10)).toBe(1);
  });
});
