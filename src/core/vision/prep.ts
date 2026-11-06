/**
 * 전처리: 조명 고르게 하기, 흑백 나누기(이진화), 사진 속 종이 찾기, 기울기 바로잡기.
 */
import { gray, mask, resize, rotate, type Gray, type Mask, type P2 } from "./raster";
import { label } from "./morph";
import { fitLine, traceOuter } from "./contour";

/** 작은 영상에서 최댓값 거르기 (밝은 종이를 남기고 선을 지운다) */
function maxFilter(g: Gray, r: number): Gray {
  const tmp = gray(g.w, g.h);
  const out = gray(g.w, g.h);
  for (let y = 0; y < g.h; y++)
    for (let x = 0; x < g.w; x++) {
      let m = 0;
      for (let k = Math.max(0, x - r); k <= Math.min(g.w - 1, x + r); k++) m = Math.max(m, g.d[y * g.w + k]);
      tmp.d[y * g.w + x] = m;
    }
  for (let y = 0; y < g.h; y++)
    for (let x = 0; x < g.w; x++) {
      let m = 0;
      for (let k = Math.max(0, y - r); k <= Math.min(g.h - 1, y + r); k++) m = Math.max(m, tmp.d[k * g.w + x]);
      out.d[y * g.w + x] = m;
    }
  return out;
}

function boxBlur(g: Gray, r: number): Gray {
  const tmp = gray(g.w, g.h);
  const out = gray(g.w, g.h);
  for (let y = 0; y < g.h; y++)
    for (let x = 0; x < g.w; x++) {
      let s = 0;
      let n = 0;
      for (let k = Math.max(0, x - r); k <= Math.min(g.w - 1, x + r); k++, n++) s += g.d[y * g.w + k];
      tmp.d[y * g.w + x] = s / n;
    }
  for (let y = 0; y < g.h; y++)
    for (let x = 0; x < g.w; x++) {
      let s = 0;
      let n = 0;
      for (let k = Math.max(0, y - r); k <= Math.min(g.h - 1, y + r); k++, n++) s += tmp.d[k * g.w + x];
      out.d[y * g.w + x] = s / n;
    }
  return out;
}

/**
 * 조명 고르게: 종이 밝기(배경)를 추정해서 나눈다. 사진의 그림자·밝기 차이를 없앤다.
 * 결과는 배경이 1에 가깝고 선은 어둡다.
 */
export function normalize(g: Gray): Gray {
  const k = Math.max(1, Math.round(Math.max(g.w, g.h) / 160));
  const sw = Math.max(2, Math.round(g.w / k));
  const sh = Math.max(2, Math.round(g.h / k));
  const small = resize(g, sw, sh);
  const bgSmall = boxBlur(maxFilter(small, 3), 3);
  const bg = resize(bgSmall, g.w, g.h);
  const out = gray(g.w, g.h);
  for (let i = 0; i < out.d.length; i++) out.d[i] = Math.min(1, g.d[i] / Math.max(0.08, bg.d[i]));
  return out;
}

/** 오츠 문턱값 (0~1) */
export function otsu(values: Float32Array): number {
  const bins = 256;
  const hist = new Float64Array(bins);
  for (const v of values) hist[Math.min(bins - 1, Math.max(0, Math.floor(v * (bins - 1))))]++;
  const total = values.length;
  let sum = 0;
  for (let i = 0; i < bins; i++) sum += i * hist[i];
  let sumB = 0;
  let wB = 0;
  let best = 0;
  let t = bins / 2;
  for (let i = 0; i < bins; i++) {
    wB += hist[i];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += i * hist[i];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    if (between > best) {
      best = between;
      t = i;
    }
  }
  return (t + 0.5) / (bins - 1);
}

/** 선(잉크) = 1. 고르게 한 영상에서 배경보다 충분히 어두운 픽셀 */
export function binarize(n: Gray): Mask {
  const t = Math.min(0.78, Math.max(0.45, otsu(n.d)));
  const m = mask(n.w, n.h);
  for (let i = 0; i < n.d.length; i++) m.d[i] = n.d[i] < t ? 1 : 0;
  return m;
}

/**
 * 사진 속 종이(가장 큰 밝은 사각형)의 네 모서리 (왼위, 오위, 오아래, 왼아래).
 * 스캔·화면 캡처처럼 종이가 이미지 전체면 null.
 */
export function findPaper(g: Gray): P2[] | null {
  const k = Math.max(1, Math.max(g.w, g.h) / 800);
  const sw = Math.max(4, Math.round(g.w / k));
  const sh = Math.max(4, Math.round(g.h / k));
  const s = resize(g, sw, sh);
  // 선을 지운 밝기로 종이/바탕 나누기
  const bright = maxFilter(s, 2);
  const t = otsu(bright.d);
  const m = mask(sw, sh);
  let lo = 1;
  let hi = 0;
  for (const v of bright.d) {
    lo = Math.min(lo, v);
    hi = Math.max(hi, v);
  }
  if (hi - lo < 0.15) return null; // 밝기 차이가 없으면 바탕이 없는 것
  for (let i = 0; i < m.d.length; i++) m.d[i] = bright.d[i] > t ? 1 : 0;
  const { labels, comps } = label(m, 4);
  if (!comps.length) return null;
  const big = comps.reduce((a, b) => (b.area > a.area ? b : a));
  const frac = big.area / (sw * sh);
  if (frac < 0.15 || frac > 0.97) return null;
  // 종이가 이미지 가장자리에 거의 다 붙어 있으면 이미 잘린 이미지
  const [bx0, by0, bx1, by1] = big.box;
  if (bx0 <= 1 && by0 <= 1 && bx1 >= sw - 2 && by1 >= sh - 2 && frac > 0.85) return null;
  // 네 모서리: x+y, x-y가 가장 크고 작은 점
  let tl: P2 = [0, 0];
  let tr: P2 = [0, 0];
  let br: P2 = [0, 0];
  let bl: P2 = [0, 0];
  let mTL = Infinity;
  let mTR = -Infinity;
  let mBR = -Infinity;
  let mBL = Infinity;
  for (let y = by0; y <= by1; y++)
    for (let x = bx0; x <= bx1; x++) {
      if (labels[y * sw + x] !== big.id) continue;
      const a = x + y;
      const b = x - y;
      if (a < mTL) (mTL = a), (tl = [x, y]);
      if (a > mBR) (mBR = a), (br = [x, y]);
      if (b > mTR) (mTR = b), (tr = [x, y]);
      if (b < mBL) (mBL = b), (bl = [x, y]);
    }
  // 경계를 따라 네 변을 직선으로 맞추고 서로 만나는 점을 모서리로 (픽셀보다 정확하게)
  const only = { w: sw, h: sh, d: new Uint8Array(sw * sh) };
  for (let i = 0; i < only.d.length; i++) only.d[i] = labels[i] === big.id ? 1 : 0;
  const rough = [tl, tr, br, bl];
  const edge = traceOuter(only);
  const nearestIdx = rough.map((c) => {
    let bi = 0;
    let bd = Infinity;
    edge.forEach((q, i) => {
      const d = Math.hypot(q[0] - c[0], q[1] - c[1]);
      if (d < bd) (bd = d), (bi = i);
    });
    return bi;
  });
  const lines = rough.map((_, k) => {
    const i0 = nearestIdx[k];
    const i1 = nearestIdx[(k + 1) % 4];
    const pts: P2[] = [];
    const n = edge.length;
    const len = (i1 - i0 + n) % n;
    for (let j = Math.floor(len * 0.12); j < len * 0.88; j++) pts.push(edge[(i0 + j) % n]);
    return pts.length >= 4 ? fitLine(pts) : null;
  });
  const corners: P2[] = rough.map((c, k) => {
    const a = lines[(k + 3) % 4];
    const b = lines[k];
    if (!a || !b) return c;
    const den = a.d[0] * b.d[1] - a.d[1] * b.d[0];
    if (Math.abs(den) < 0.2) return c;
    const t = ((b.p[0] - a.p[0]) * b.d[1] - (b.p[1] - a.p[1]) * b.d[0]) / den;
    const x: P2 = [a.p[0] + t * a.d[0], a.p[1] + t * a.d[1]];
    return Math.hypot(x[0] - c[0], x[1] - c[1]) < 0.05 * Math.max(sw, sh) ? x : c;
  });
  // 픽셀 모서리 좌표 → 원래 이미지 좌표
  const scale = (p: P2): P2 => [(p[0] * g.w) / sw, (p[1] * g.h) / sh];
  const quad = corners.map(scale);
  // 너무 찌그러진 사각형은 버린다
  const area = Math.abs(
    quad.reduce((acc, p, i) => {
      const q = quad[(i + 1) % 4];
      return acc + p[0] * q[1] - q[0] * p[1];
    }, 0) / 2,
  );
  if (area < 0.12 * g.w * g.h) return null;
  return quad;
}

/**
 * 기울기 찾기: 선 픽셀을 여러 각도로 투영해서 가로줄이 가장 또렷해지는 각도 (도, 시계 반대가 +).
 * 도면은 수평·수직선이 많아서 잘 맞는다. 범위 ±maxDeg.
 */
export function skewAngle(ink: Mask, maxDeg = 8): number {
  // 점 고르기 (많으면 솎기)
  const pts: number[] = [];
  const total = ink.d.reduce((a, v) => a + v, 0);
  const step = Math.max(1, Math.floor(total / 60000));
  let n = 0;
  for (let y = 0; y < ink.h; y++)
    for (let x = 0; x < ink.w; x++)
      if (ink.d[y * ink.w + x] && n++ % step === 0) pts.push(x - ink.w / 2, y - ink.h / 2);
  if (pts.length < 200) return 0;
  const score = (deg: number) => {
    const a = (deg * Math.PI) / 180;
    const c = Math.cos(a);
    const s = Math.sin(a);
    const size = Math.ceil(Math.hypot(ink.w, ink.h)) + 2;
    let sc = 0;
    // 가로줄(행)과 세로줄(열) 투영을 둘 다 본다
    for (const which of [0, 1]) {
      const hist = new Float64Array(size);
      for (let i = 0; i < pts.length; i += 2) {
        const x = pts[i];
        const y = pts[i + 1];
        // 내용이 deg만큼 시계 반대로 돌아가 있다면, 되돌린 좌표
        const v = which === 0 ? -s * x + c * y : c * x + s * y;
        hist[Math.round(v + size / 2)]++;
      }
      for (const h of hist) sc += h * h;
    }
    return sc;
  };
  let best = 0;
  let bestS = -1;
  for (let d = -maxDeg; d <= maxDeg + 1e-9; d += 0.5) {
    const sc = score(d);
    if (sc > bestS) (bestS = sc), (best = d);
  }
  const center = best;
  for (let d = center - 0.5; d <= center + 0.5 + 1e-9; d += 0.05) {
    const sc = score(d);
    if (sc > bestS) (bestS = sc), (best = d);
  }
  return Math.abs(best) < 0.08 ? 0 : -best;
}

export { rotate };
