export type ReadingDirection = 'rtl' | 'ltr';
export function clampPage(page: number, count: number): number {
  return Math.max(1, Math.min(Math.max(1, count), Number.isFinite(page) ? Math.floor(page) : 1));
}
export function spreadPages(page: number, count: number, spread: boolean): number[] {
  const current = clampPage(page, count);
  if (!spread || current === 1) return [current];
  const first = current % 2 === 0 ? current : current - 1;
  return first + 1 <= count ? [first, first + 1] : [first];
}
export function turnPage(page: number, count: number, spread: boolean, delta: number): number {
  const pages = spreadPages(page, count, spread);
  return clampPage(delta > 0 ? pages[pages.length - 1] + 1 : pages[0] - 1, count);
}
