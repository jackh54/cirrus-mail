/**
 * Small fuzzy matcher for the command palette. Returns null when `query` is not a subsequence of
 * `text`; otherwise a score where prefixes beat word starts, which beat substrings, which beat
 * scattered subsequences.
 */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const t = text.toLowerCase();
  // Equal scores keep the commands' natural order (the sort is stable).
  if (t.startsWith(q)) return 1000;
  const at = t.indexOf(q);
  if (at >= 0) return (t[at - 1] === ' ' ? 800 : 600) - at;

  let score = 0;
  let ti = 0;
  let prev = -2;
  for (const ch of q) {
    if (ch === ' ') continue;
    const found = t.indexOf(ch, ti);
    if (found < 0) return null;
    score += found === prev + 1 ? 12 : 2;
    if (found === 0 || t[found - 1] === ' ') score += 10;
    score -= Math.min(found - ti, 6);
    prev = found;
    ti = found + 1;
  }
  return Math.max(1, score);
}

/** Best score of a query against a label and its keywords. */
export function bestScore(query: string, label: string, keywords: string[] = []): number | null {
  let best: number | null = null;
  for (const s of [label, ...keywords]) {
    const v = fuzzyScore(query, s);
    // Keywords count a little less than the visible label, and scattered keyword matches are dropped.
    const weighted = v === null ? null : s === label ? v : v - 50;
    if (weighted !== null && (s === label || weighted > 0) && (best === null || weighted > best)) best = weighted;
  }
  return best;
}
