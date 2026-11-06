/**
 * 이진 영상 연산: 거리 변환(EDT), 원판으로 깎기·불리기, 연결 요소, 막힌 영역 채우기.
 */
import { mask, type Mask } from "./raster";

const INF = 1e20;

/** 1차원 제곱 거리 변환 (Felzenszwalb & Huttenlocher) */
function edt1d(f: Float64Array, n: number, d: Float64Array, v: Int32Array, z: Float64Array) {
  let k = 0;
  v[0] = 0;
  z[0] = -INF;
  z[1] = INF;
  for (let q = 1; q < n; q++) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
  }
}

/** 각 픽셀에서 seed(1)인 가장 가까운 픽셀까지의 거리. seed가 없으면 아주 큰 값 */
export function distTo(m: Mask, seedValue = 1): Float32Array {
  const { w, h } = m;
  const n = Math.max(w, h);
  const f = new Float64Array(n);
  const d = new Float64Array(n);
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);
  const g = new Float64Array(w * h);
  for (let i = 0; i < w * h; i++) g[i] = m.d[i] === seedValue ? 0 : INF;
  // 세로
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = g[y * w + x];
    edt1d(f, h, d, v, z);
    for (let y = 0; y < h; y++) g[y * w + x] = d[y];
  }
  // 가로
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) f[x] = g[y * w + x];
    edt1d(f, w, d, v, z);
    for (let x = 0; x < w; x++) out[y * w + x] = Math.sqrt(d[x]);
  }
  return out;
}

/** 원판(반지름 r)으로 깎기: 바깥(0)까지 거리가 r보다 큰 픽셀만 남는다 */
export function erode(m: Mask, r: number): Mask {
  if (r <= 0) return { ...m, d: m.d.slice() };
  const dist = distTo(m, 0);
  const out = mask(m.w, m.h);
  for (let i = 0; i < out.d.length; i++) out.d[i] = m.d[i] && dist[i] > r ? 1 : 0;
  return out;
}

/** 원판(반지름 r)으로 불리기: 켜진 픽셀에서 거리 r 안이면 켠다 */
export function dilate(m: Mask, r: number): Mask {
  if (r <= 0) return { ...m, d: m.d.slice() };
  const dist = distTo(m, 1);
  const out = mask(m.w, m.h);
  for (let i = 0; i < out.d.length; i++) out.d[i] = dist[i] <= r ? 1 : 0;
  return out;
}

export const open = (m: Mask, r: number) => dilate(erode(m, r), r);
export const close = (m: Mask, r: number) => erode(dilate(m, r), r);

export function and(a: Mask, b: Mask): Mask {
  const out = mask(a.w, a.h);
  for (let i = 0; i < out.d.length; i++) out.d[i] = a.d[i] & b.d[i];
  return out;
}
export function or(a: Mask, b: Mask): Mask {
  const out = mask(a.w, a.h);
  for (let i = 0; i < out.d.length; i++) out.d[i] = a.d[i] | b.d[i];
  return out;
}
export function count(m: Mask): number {
  let n = 0;
  for (let i = 0; i < m.d.length; i++) n += m.d[i];
  return n;
}

export interface Comp {
  id: number;
  area: number;
  /** [x0, y0, x1, y1] (x1, y1 포함) */
  box: [number, number, number, number];
}

/** 연결 요소 번호 매기기 (labels: 0 = 없음, 1부터) */
export function label(m: Mask, conn: 4 | 8 = 8): { labels: Int32Array; comps: Comp[] } {
  const { w, h } = m;
  const labels = new Int32Array(w * h);
  const comps: Comp[] = [];
  const stack = new Int32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    if (!m.d[i] || labels[i]) continue;
    const id = comps.length + 1;
    const c: Comp = { id, area: 0, box: [w, h, -1, -1] };
    let sp = 0;
    stack[sp++] = i;
    labels[i] = id;
    while (sp) {
      const p = stack[--sp];
      const x = p % w;
      const y = (p - x) / w;
      c.area++;
      if (x < c.box[0]) c.box[0] = x;
      if (y < c.box[1]) c.box[1] = y;
      if (x > c.box[2]) c.box[2] = x;
      if (y > c.box[3]) c.box[3] = y;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          if (conn === 4 && dx && dy) continue;
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const q = yy * w + xx;
          if (m.d[q] && !labels[q]) {
            labels[q] = id;
            stack[sp++] = q;
          }
        }
      }
    }
    comps.push(c);
  }
  return { labels, comps };
}

/** 한 요소(labels == id)만 잘라 낸 마스크 (box에 pad를 둔 좌표계) */
export function cropComp(labels: Int32Array, w: number, c: Comp, pad: number): { m: Mask; ox: number; oy: number } {
  const ox = c.box[0] - pad;
  const oy = c.box[1] - pad;
  const cw = c.box[2] - c.box[0] + 1 + 2 * pad;
  const ch = c.box[3] - c.box[1] + 1 + 2 * pad;
  const m = mask(cw, ch);
  for (let y = c.box[1]; y <= c.box[3]; y++)
    for (let x = c.box[0]; x <= c.box[2]; x++) if (labels[y * w + x] === c.id) m.d[(y - oy) * cw + (x - ox)] = 1;
  return { m, ox, oy };
}

/**
 * 막힌 영역 채우기: 가장자리에서 4방향으로 이어진 빈 곳만 바깥이고, 나머지 빈 곳은 안쪽(둘러싸인 곳).
 * 반환: filled = 선 + 둘러싸인 곳, enclosed = 둘러싸인 곳만
 */
export function fillHoles(m: Mask): { filled: Mask; enclosed: Mask } {
  const { w, h } = m;
  const outside = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  let sp = 0;
  const push = (i: number) => {
    if (!m.d[i] && !outside[i]) {
      outside[i] = 1;
      stack[sp++] = i;
    }
  };
  for (let x = 0; x < w; x++) {
    push(x);
    push((h - 1) * w + x);
  }
  for (let y = 0; y < h; y++) {
    push(y * w);
    push(y * w + w - 1);
  }
  while (sp) {
    const p = stack[--sp];
    const x = p % w;
    if (x > 0) push(p - 1);
    if (x < w - 1) push(p + 1);
    if (p >= w) push(p - w);
    if (p < w * (h - 1)) push(p + w);
  }
  const filled = mask(w, h);
  const enclosed = mask(w, h);
  for (let i = 0; i < w * h; i++) {
    filled.d[i] = outside[i] ? 0 : 1;
    enclosed.d[i] = !outside[i] && !m.d[i] ? 1 : 0;
  }
  return { filled, enclosed };
}

/** 마스크 일부를 잘라 내기 */
export function crop(m: Mask, x0: number, y0: number, w: number, h: number): Mask {
  const out = mask(w, h);
  for (let y = 0; y < h; y++) {
    const sy = y + y0;
    if (sy < 0 || sy >= m.h) continue;
    for (let x = 0; x < w; x++) {
      const sx = x + x0;
      if (sx >= 0 && sx < m.w) out.d[y * w + x] = m.d[sy * m.w + sx];
    }
  }
  return out;
}

/** 정사각형(한 변 2k+1)으로 깎기·불리기: 가로·세로로 나눠서 (축에 나란한 모서리가 둥글어지지 않는다) */
function squareFilter(m: Mask, k: number, erodeMode: boolean): Mask {
  const { w, h } = m;
  const tmp = new Uint8Array(w * h);
  const out = mask(w, h);
  const want = erodeMode ? 1 : 0;
  // 가로: 창 안에 want가 아닌 값이 하나라도 있으면 뒤집는다 (누적 합으로)
  const row = new Int32Array(w + 1);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) row[x + 1] = row[x] + (m.d[y * w + x] === want ? 0 : 1);
    for (let x = 0; x < w; x++) {
      const a = Math.max(0, x - k);
      const b = Math.min(w, x + k + 1);
      // 가장자리 밖은 침식이면 0(비어 있음)으로 본다
      const outside = erodeMode && (x - k < 0 || x + k + 1 > w) ? 1 : 0;
      const bad = row[b] - row[a] + outside;
      tmp[y * w + x] = bad ? 1 - want : want;
    }
  }
  const col = new Int32Array(h + 1);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) col[y + 1] = col[y] + (tmp[y * w + x] === want ? 0 : 1);
    for (let y = 0; y < h; y++) {
      const a = Math.max(0, y - k);
      const b = Math.min(h, y + k + 1);
      const outside = erodeMode && (y - k < 0 || y + k + 1 > h) ? 1 : 0;
      const bad = col[b] - col[a] + outside;
      out.d[y * w + x] = bad ? 1 - want : want;
    }
  }
  return out;
}
export const openSquare = (m: Mask, k: number) => squareFilter(squareFilter(m, k, true), k, false);
