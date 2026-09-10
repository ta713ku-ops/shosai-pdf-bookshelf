import { describe, expect, it } from 'vitest';
import { clampPage, spreadPages, turnPage } from './reading';
describe('reading pagination', () => {
  it('shows two-page spreads in landscape whenever two pages are available', () => {
    expect(spreadPages(1, 6, true)).toEqual([1, 2]);
    expect(spreadPages(3, 6, true)).toEqual([3, 4]);
    expect(spreadPages(6, 6, true)).toEqual([5, 6]);
    expect(spreadPages(3, 6, false)).toEqual([3]);
  });
  it('moves through spreads without skipping a page', () => {
    expect(turnPage(1, 6, true, 1)).toBe(3);
    expect(turnPage(2, 6, true, 1)).toBe(3);
    expect(turnPage(4, 6, true, -1)).toBe(1);
    expect(turnPage(1, 6, true, -1)).toBe(1);
    expect(turnPage(6, 6, true, 1)).toBe(6);
  });
  it('clamps invalid restored positions', () => {
    expect(clampPage(NaN, 10)).toBe(1);
    expect(clampPage(12, 10)).toBe(10);
    expect(clampPage(-1, 10)).toBe(1);
  });
});
