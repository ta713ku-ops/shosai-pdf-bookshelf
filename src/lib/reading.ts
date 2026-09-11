export type ReadingDirection = 'rtl' | 'ltr';
export function clampPage(page: number, count: number): number {
  return Math.max(1, Math.min(Math.max(1, count), Number.isFinite(page) ? Math.floor(page) : 1));
}
export function spreadPages(page: number, count: number, spread: boolean): number[] {
  const current = clampPage(page, count);
  if (!spread) return [current];
  if (current === 1) return [1];
  const first = current % 2 === 0 ? current : current - 1;
  return first + 1 <= count ? [first, first + 1] : [first];
}
export function turnPage(page: number, count: number, spread: boolean, delta: number): number {
  const pages = spreadPages(page, count, spread);
  if (!spread) return clampPage(page + (delta > 0 ? 1 : -1), count);
  if (delta > 0) return clampPage(pages[0] === 1 ? 2 : pages[0] + 2, count);
  return pages[0] <= 2 ? 1 : pages[0] - 2;
}
