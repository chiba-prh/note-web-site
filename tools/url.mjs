// 追跡パラメータ（決め打ち）を URL から削る。publish.mjs と thumbs.mjs の両方で使う。
const TRACK = /^(utm_.+|yclid|gclid|gbraid|wbraid|dclid|fbclid|msclkid|twclid|ttclid|igshid|mc_cid|mc_eid|_hsenc|_hsmi|_ga|_gl|_ly_.+)$/i;
// 「&amp;amp;utm_medium」のように壊れて貼られたキーも拾う
const paramKey = k => k.replace(/^(amp;)+/i, '');

export function stripTracking(url) {
  let u;
  try { u = new URL(url); } catch { return url; }
  const keep = [...u.searchParams].filter(([k]) => !TRACK.test(paramKey(k)));
  if (keep.length === [...u.searchParams].length) return url;
  u.search = keep.length ? '?' + new URLSearchParams(keep) : '';
  return u.toString();
}
