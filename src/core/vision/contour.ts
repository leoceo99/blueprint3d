/**
 * 영역의 외곽선 따기와 맞추기: 픽셀 경계 → 직선·원호 → 원/장공/사각형/다각형.
 */
import type { Mask, P2 } from "./raster";

/**
 * 마스크에서 가장 큰(또는 start가 속한) 4-연결 영역의 바깥 경계를 픽셀 모서리 좌표로 따라간다.
 * 영역을 오른쪽에 두고 돈다 (y가 아래쪽인 화면에서 시계 방향).
 */
export function traceOuter(m: Mask, start?: number): P2[] {
  const { w, h } = m;
  const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && m.d[y * w + x] === 1;
  let s = start ?? -1;
  if (s < 0) {
    for (let i = 0; i < w * h; i++)
      if (m.d[i]) {
        s = i;
        break;
      }
    if (s < 0) return [];
  } else {
    // start가 속한 영역의 맨 위 왼쪽 경계부터: 위쪽이 비어 있는 점까지 올라간다
    let x = s % w;
    let y = (s - x) / w;
    while (inside(x, y - 1)) y--;
    s = y * w + x;
  }
  const sx = s % w;
  const sy = (s - sx) / w;
  // 시작: 픽셀 (sx,sy)의 왼쪽 위 모서리에서 +x 방향 (위가 비어 있으니 이 변은 경계)
  const dirs: P2[] = [
    [1, 0],
    [0, 1],
    [-1, 0],
    [0, -1],
  ];
  let cx = sx;
  let cy = sy;
  let d = 0;
  const pts: P2[] = [];
  const maxSteps = 4 * (w + 2) * (h + 2);
  for (let step = 0; step < maxSteps; step++) {
    pts.push([cx, cy]);
    cx += dirs[d][0];
    cy += dirs[d][1];
    // 새 모서리에서 다음 방향: 앞 변의 왼쪽 픽셀이 영역이면 왼쪽으로, 오른쪽 픽셀만 영역이면 직진, 둘 다 아니면 오른쪽으로
    const [dx, dy] = dirs[d];
    const mx = cx + dx / 2;
    const my = cy + dy / 2;
    const L = inside(Math.floor(mx + dy / 2), Math.floor(my - dx / 2));
    const R = inside(Math.floor(mx - dy / 2), Math.floor(my + dx / 2));
    if (L) d = (d + 3) % 4;
    else if (!R) d = (d + 1) % 4;
    if (cx === sx && cy === sy && d === 0) break;
  }
  return pts;
}

export function polygonArea(p: P2[]): number {
  let a = 0;
  for (let i = 0; i < p.length; i++) {
    const q = p[(i + 1) % p.length];
    a += p[i][0] * q[1] - q[0] * p[i][1];
  }
  return a / 2;
}

// ---------------- 맞추기 ----------------

export interface CircleFit {
  c: P2;
  r: number;
  rms: number;
  max: number;
}

/** 원 맞추기 (대수적 Kasa → 기하 오차로 몇 번 다듬기) */
export function fitCircle(p: P2[]): CircleFit {
  const n = p.length;
  let mx = 0;
  let my = 0;
  for (const q of p) (mx += q[0]), (my += q[1]);
  mx /= n;
  my /= n;
  let suu = 0;
  let svv = 0;
  let suv = 0;
  let suuu = 0;
  let svvv = 0;
  let suvv = 0;
  let svuu = 0;
  for (const q of p) {
    const u = q[0] - mx;
    const v = q[1] - my;
    suu += u * u;
    svv += v * v;
    suv += u * v;
    suuu += u * u * u;
    svvv += v * v * v;
    suvv += u * v * v;
    svuu += v * u * u;
  }
  const det = suu * svv - suv * suv;
  let cx = mx;
  let cy = my;
  if (Math.abs(det) > 1e-12) {
    const b1 = (suuu + suvv) / 2;
    const b2 = (svvv + svuu) / 2;
    cx = mx + (b1 * svv - b2 * suv) / det;
    cy = my + (b2 * suu - b1 * suv) / det;
  }
  let r = 0;
  for (const q of p) r += Math.hypot(q[0] - cx, q[1] - cy);
  r /= n;
  // 가우스-뉴턴 몇 번
  for (let it = 0; it < 8; it++) {
    let JtJ = [
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
    ];
    const Jtr = [0, 0, 0];
    for (const q of p) {
      const dx = q[0] - cx;
      const dy = q[1] - cy;
      const d = Math.hypot(dx, dy) || 1e-9;
      const res = d - r;
      const J = [-dx / d, -dy / d, -1];
      for (let i = 0; i < 3; i++) {
        Jtr[i] += J[i] * res;
        for (let j = 0; j < 3; j++) JtJ[i][j] += J[i] * J[j];
      }
    }
    JtJ = JtJ.map((row, i) => row.map((v, j) => (i === j ? v * 1.0001 + 1e-9 : v)));
    const step = solve3(JtJ, Jtr);
    if (!step) break;
    cx -= step[0];
    cy -= step[1];
    r -= step[2];
    if (Math.abs(step[0]) + Math.abs(step[1]) + Math.abs(step[2]) < 1e-6) break;
  }
  let s2 = 0;
  let mxe = 0;
  for (const q of p) {
    const e = Math.abs(Math.hypot(q[0] - cx, q[1] - cy) - r);
    s2 += e * e;
    mxe = Math.max(mxe, e);
  }
  return { c: [cx, cy], r: Math.abs(r), rms: Math.sqrt(s2 / n), max: mxe };
}

function solve3(A: number[][], b: number[]): number[] | null {
  const det = (m: number[][]) =>
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  const D = det(A);
  if (Math.abs(D) < 1e-15) return null;
  return [0, 1, 2].map((k) => det(A.map((row, i) => row.map((v, j) => (j === k ? b[i] : v)))) / D);
}

/**
 * 지시선 화살표·치수 보조선이 닿아 일부가 찌그러진 원: 벗어난 점을 빼고 다시 맞춘다.
 * 남은 점이 70% 이상이고 둘레의 대부분(빈 각도 70° 미만)을 덮으면 원으로 본다.
 */
export function robustCircle(p: P2[], start: CircleFit): CircleFit | null {
  let f = start;
  let inl = p;
  for (let it = 0; it < 5; it++) {
    const tol = Math.max(1.2, 0.03 * f.r) * (it === 0 ? 3 : it === 1 ? 2 : 1.2);
    const next = p.filter((q) => Math.abs(Math.hypot(q[0] - f.c[0], q[1] - f.c[1]) - f.r) < tol);
    if (next.length < 12) return null;
    inl = next;
    f = fitCircle(inl);
  }
  if (inl.length < 0.7 * p.length || f.r < 3) return null;
  // 맞춘 원이 점들의 범위보다 훨씬 크면 원이 아니다
  if (!fitsExtent(p, f.r)) return null;
  if (f.rms > Math.max(0.6, 0.015 * f.r)) return null;
  const ang = inl.map((q) => Math.atan2(q[1] - f.c[1], q[0] - f.c[0])).sort((a, b) => a - b);
  let gap = ang[0] + 2 * Math.PI - ang[ang.length - 1];
  for (let i = 1; i < ang.length; i++) gap = Math.max(gap, ang[i] - ang[i - 1]);
  return gap < (70 * Math.PI) / 180 ? f : null;
}

/**
 * 장공(양끝 반원) 맞추기: 긴 축 방향으로 펴서 폭 = 지름, 양끝 반원 중심 a, b.
 * 지시선 화살표로 조금 찌그러져도 되게, 벗어난 점은 빼고 판단한다. 양끝이 실제로 둥글어야 한다.
 */
export function fitCapsule(p: P2[]): { a: P2; b: P2; r: number } | null {
  const n = p.length;
  if (n < 24) return null;
  const f = fitLine(p);
  const d = f.d;
  const nn: P2 = [-d[1], d[0]];
  const ts = p.map((q) => (q[0] - f.p[0]) * d[0] + (q[1] - f.p[1]) * d[1]);
  const ss = p.map((q) => (q[0] - f.p[0]) * nn[0] + (q[1] - f.p[1]) * nn[1]);
  const pct = (arr: number[], k: number) => [...arr].sort((x, y) => x - y)[Math.min(arr.length - 1, Math.max(0, Math.round(k * (arr.length - 1))))];
  const s0 = pct(ss, 0.02);
  const s1 = pct(ss, 0.98);
  const t0 = pct(ts, 0.01);
  const t1 = pct(ts, 0.99);
  let r = (s1 - s0) / 2;
  const half = (t1 - t0) / 2 - r;
  if (r < 2 || half < 0.15 * r) return null;
  const mid = (t0 + t1) / 2;
  const off = (s0 + s1) / 2;
  const base: P2 = [f.p[0] + nn[0] * off, f.p[1] + nn[1] * off];
  const a: P2 = [base[0] + d[0] * (mid - half), base[1] + d[1] * (mid - half)];
  const b: P2 = [base[0] + d[0] * (mid + half), base[1] + d[1] * (mid + half)];
  const segD = (q: P2) => {
    const L2 = (b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2;
    const t = Math.max(0, Math.min(1, ((q[0] - a[0]) * (b[0] - a[0]) + (q[1] - a[1]) * (b[1] - a[1])) / L2));
    return Math.hypot(q[0] - (a[0] + t * (b[0] - a[0])), q[1] - (a[1] + t * (b[1] - a[1])));
  };
  const tol = Math.max(1.2, 0.05 * r);
  let inl = p.filter((q) => Math.abs(segD(q) - r) < tol);
  if (inl.length < 0.8 * n) return null;
  r = inl.reduce((acc, q) => acc + segD(q), 0) / inl.length;
  inl = p.filter((q) => Math.abs(segD(q) - r) < tol);
  const rms = Math.sqrt(inl.reduce((acc, q) => acc + (segD(q) - r) ** 2, 0) / inl.length);
  if (inl.length < 0.85 * n || rms > Math.max(0.7, 0.03 * r)) return null;
  // 양끝 반원 부분의 점들도 대부분 맞아야 한다 (긴 사각형을 장공으로 잘못 읽지 않게)
  for (const end of [-1, 1]) {
    const cap = p.filter((_, i) => end * (ts[i] - mid) > half + 0.3 * r);
    if (cap.length < 0.5 * Math.PI * r * 0.5) return null;
    const good = cap.filter((q) => Math.abs(segD(q) - r) < tol).length;
    if (good < 0.6 * cap.length) return null;
  }
  return { a, b, r };
}

/** 지름이 점들의 범위와 비슷한지 (0.8~1.2배) */
function fitsExtent(p: P2[], r: number): boolean {
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  for (const q of p) {
    x0 = Math.min(x0, q[0]);
    x1 = Math.max(x1, q[0]);
    y0 = Math.min(y0, q[1]);
    y1 = Math.max(y1, q[1]);
  }
  const ext = Math.max(x1 - x0, y1 - y0);
  return 2 * r <= 1.2 * ext && 2 * r >= 0.8 * ext;
}

export interface LineFit {
  /** 지나는 점 */
  p: P2;
  /** 단위 방향 */
  d: P2;
  rms: number;
}

export function fitLine(p: P2[]): LineFit {
  const n = p.length;
  let mx = 0;
  let my = 0;
  for (const q of p) (mx += q[0]), (my += q[1]);
  mx /= n;
  my /= n;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (const q of p) {
    const u = q[0] - mx;
    const v = q[1] - my;
    sxx += u * u;
    syy += v * v;
    sxy += u * v;
  }
  const a = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const d: P2 = [Math.cos(a), Math.sin(a)];
  let s2 = 0;
  for (const q of p) {
    const e = -(q[0] - mx) * d[1] + (q[1] - my) * d[0];
    s2 += e * e;
  }
  return { p: [mx, my], d, rms: Math.sqrt(s2 / n) };
}

/** 열린 점열의 Ramer–Douglas–Peucker: 남길 점의 번호 */
function rdp(p: P2[], i0: number, i1: number, eps: number, out: number[]) {
  const [ax, ay] = p[i0];
  const [bx, by] = p[i1];
  const L = Math.hypot(bx - ax, by - ay) || 1e-9;
  let best = -1;
  let bi = -1;
  for (let i = i0 + 1; i < i1; i++) {
    const d = Math.abs((p[i][0] - ax) * (by - ay) - (p[i][1] - ay) * (bx - ax)) / L;
    if (d > best) (best = d), (bi = i);
  }
  if (best > eps) {
    rdp(p, i0, bi, eps, out);
    out.push(bi);
    rdp(p, bi, i1, eps, out);
  }
}

export type Prim =
  | { t: "line"; a: P2; b: P2; i0: number; i1: number }
  | { t: "arc"; a: P2; b: P2; c: P2; r: number; /** 호 위의 가운데 점 */ m: P2; i0: number; i1: number };

export type Fitted =
  | { kind: "circle"; c: P2; r: number }
  | { kind: "slot"; a: P2; b: P2; r: number }
  | { kind: "path"; prims: Prim[] };

/** 외곽선 위의 점열 i0..i1 (닫힌 순환) */
function span(p: P2[], i0: number, i1: number): P2[] {
  const n = p.length;
  const out: P2[] = [];
  for (let i = i0; ; i = (i + 1) % n) {
    out.push(p[i]);
    if (i === i1 % n) break;
    if (out.length > n) break;
  }
  return out;
}

const turn = (a: P2, b: P2, c: P2) => {
  const v1 = [b[0] - a[0], b[1] - a[1]];
  const v2 = [c[0] - b[0], c[1] - b[1]];
  return Math.atan2(v1[0] * v2[1] - v1[1] * v2[0], v1[0] * v2[0] + v1[1] * v2[1]);
};

/**
 * 닫힌 외곽선을 원 하나, 또는 직선·원호의 연속으로 맞춘다.
 * px: 점 간격이 1픽셀쯤인 경계 (traceOuter 결과).
 */
export function fitContour(raw: P2[], opts: { eps?: number; minSeg?: number } = {}): Fitted {
  // 계단 모양을 조금 고르게 (이웃 평균)
  const n0 = raw.length;
  if (n0 < 8) return { kind: "path", prims: [] };
  const p: P2[] = raw.map((q, i) => {
    const a = raw[(i - 1 + n0) % n0];
    const b = raw[(i + 1) % n0];
    return [(a[0] + 2 * q[0] + b[0]) / 4, (a[1] + 2 * q[1] + b[1]) / 4];
  });
  const n = p.length;
  const circ = fitCircle(p);
  // 원은 점들의 범위와 크기가 비슷해야 한다 (거의 곧은 선을 아주 큰 원으로 맞추지 않게)
  if (circ.r > 2 && fitsExtent(p, circ.r) && circ.rms <= Math.max(0.6, 0.015 * circ.r) && circ.max <= Math.max(1.6, 0.05 * circ.r))
    return { kind: "circle", c: circ.c, r: circ.r };
  const robust = robustCircle(p, circ);
  if (robust) return { kind: "circle", c: robust.c, r: robust.r };
  const cap = fitCapsule(p);
  if (cap) return { kind: "slot", ...cap };

  // 시작점: 무게중심에서 가장 먼 점 (대개 꼭짓점)
  let cx = 0;
  let cy = 0;
  for (const q of p) (cx += q[0]), (cy += q[1]);
  cx /= n;
  cy /= n;
  let s0 = 0;
  let far = -1;
  p.forEach((q, i) => {
    const d = Math.hypot(q[0] - cx, q[1] - cy);
    if (d > far) (far = d), (s0 = i);
  });
  const eps = opts.eps ?? 1.4;
  const simplify = (start: number) => {
    const q: P2[] = [...p.slice(start), ...p.slice(0, start), p[start]];
    // 닫힌 곡선은 처음에서 가장 먼 점으로 둘로 나눠서 각각 단순화
    let s1 = 1;
    q.forEach((pt, i) => {
      if (Math.hypot(pt[0] - q[0][0], pt[1] - q[0][1]) > Math.hypot(q[s1][0] - q[0][0], q[s1][1] - q[0][1])) s1 = i;
    });
    const idx: number[] = [0];
    rdp(q, 0, s1, eps, idx);
    idx.push(s1);
    rdp(q, s1, q.length - 1, eps, idx);
    idx.push(q.length - 1);
    idx.sort((a, b) => a - b);
    return { q, idx };
  };
  // 한 번 단순화한 뒤, 가장 긴 변의 가운데에서 다시 시작한다 (원호 가운데서 시작하면 원호가 둘로 쪼개진다)
  let { q, idx } = simplify(s0);
  let longest = 0;
  for (let i = 1; i < idx.length; i++) if (idx[i] - idx[i - 1] > idx[longest + 1] - idx[longest]) longest = i - 1;
  const midStart = (s0 + Math.floor((idx[longest] + idx[longest + 1]) / 2)) % n;
  ({ q, idx } = simplify(midStart));
  const V = idx.slice(0, -1); // 마지막 = 처음
  const m = V.length;
  if (m < 2) return { kind: "path", prims: [] };
  const pts = q.slice(0, -1);
  const N = pts.length;
  const edgePts = (k0: number, k1: number) => span(pts, V[k0 % m], V[k1 % m]);
  const vtx = (k: number) => pts[V[k % m]];

  // 원호 묶기: 같은 쪽으로 조금씩 꺾이는 짧은 변들
  const prims: Prim[] = [];
  let k = 0;
  while (k < m) {
    let best = 0;
    let bestFit: CircleFit | null = null;
    for (let len = 2; k + len <= m; len++) {
      // 안쪽 꼭짓점들이 같은 방향으로, 45° 미만씩 꺾이는지
      let sign = 0;
      let ok = true;
      for (let j = k + 1; j < k + len; j++) {
        const t = turn(vtx(j - 1), vtx(j), vtx(j + 1));
        if (Math.abs(t) > (50 * Math.PI) / 180 || Math.abs(t) < 0.02) {
          ok = false;
          break;
        }
        const sg = Math.sign(t);
        if (sign && sg !== sign) {
          ok = false;
          break;
        }
        sign = sg;
      }
      if (!ok) break;
      // 원호를 이루는 변들은 길이가 비슷하다 (긴 직선 + 짧은 모서리 R을 원호 하나로 묶지 않게)
      const lens = Array.from({ length: len }, (_, j) => Math.hypot(vtx(k + j + 1)[0] - vtx(k + j)[0], vtx(k + j + 1)[1] - vtx(k + j)[1]));
      if (Math.max(...lens) > 3 * Math.min(...lens)) break;
      const sp = edgePts(k, k + len);
      const f = fitCircle(sp);
      const chord = Math.hypot(vtx(k + len)[0] - vtx(k)[0], vtx(k + len)[1] - vtx(k)[1]);
      const sag = f.r - Math.sqrt(Math.max(0, f.r * f.r - (chord / 2) ** 2));
      // 허용 오차는 픽셀 단위로 고정 (반지름에 비례하면 큰 원이 직선까지 삼킨다)
      // 변마다 실제로 휘어 있어야 한다 (직선 변은 현에서 벗어나지 않는다)
      const bent = lens.every((L, j) => {
        const a = vtx(k + j);
        const b = vtx(k + j + 1);
        const expect = f.r - Math.sqrt(Math.max(0, f.r * f.r - (L / 2) ** 2));
        if (expect < 0.8) return true;
        let dev = 0;
        for (const q of edgePts(k + j, k + j + 1)) dev = Math.max(dev, Math.abs((q[0] - a[0]) * (b[1] - a[1]) - (q[1] - a[1]) * (b[0] - a[0])) / (L || 1));
        return dev > 0.45 * expect;
      });
      if (bent && f.rms <= 0.65 && f.max <= 1.8 && sag > 1.2) {
        best = len;
        bestFit = f;
      } else if (len > 2) break;
    }
    if (best && bestFit) {
      const sp = edgePts(k, k + best);
      const mid = sp[Math.floor(sp.length / 2)];
      const ang = Math.atan2(mid[1] - bestFit.c[1], mid[0] - bestFit.c[0]);
      prims.push({
        t: "arc",
        a: vtx(k),
        b: vtx(k + best),
        c: bestFit.c,
        r: bestFit.r,
        m: [bestFit.c[0] + bestFit.r * Math.cos(ang), bestFit.c[1] + bestFit.r * Math.sin(ang)],
        i0: V[k],
        i1: V[(k + best) % m] || N,
      });
      k += best;
    } else {
      prims.push({ t: "line", a: vtx(k), b: vtx(k + 1), i0: V[k], i1: V[(k + 1) % m] || N });
      k++;
    }
  }
  // 거의 일직선으로 이어진 직선끼리 합치기
  const merged: Prim[] = [];
  for (const pr of prims) {
    const last = merged[merged.length - 1];
    if (last && last.t === "line" && pr.t === "line") {
      const t = turn(last.a, last.b, pr.b);
      if (Math.abs(t) < (3 * Math.PI) / 180) {
        last.b = pr.b;
        last.i1 = pr.i1;
        continue;
      }
    }
    merged.push({ ...pr });
  }
  // 처음과 마지막도
  if (merged.length > 2) {
    const f = merged[0];
    const l = merged[merged.length - 1];
    if (f.t === "line" && l.t === "line" && Math.abs(turn(l.a, l.b, f.b)) < (3 * Math.PI) / 180) {
      f.a = l.a;
      f.i0 = l.i0;
      merged.pop();
    }
  }
  // 두 직선 사이의 아주 짧은 직선·작은 원호(모서리를 깎은 자국, 돌기 뿌리)는 빼서 두 직선이 바로 만나게
  const minSeg = opts.minSeg ?? 3;
  let changed = true;
  while (changed && merged.length > 3) {
    changed = false;
    for (let i = 0; i < merged.length; i++) {
      const pr = merged[i];
      const len = Math.hypot(pr.b[0] - pr.a[0], pr.b[1] - pr.a[1]);
      const small = pr.t === "line" ? len < minSeg : pr.r < minSeg * 0.8 && len < minSeg * 1.6;
      if (!small) continue;
      const A = merged[(i - 1 + merged.length) % merged.length];
      const B = merged[(i + 1) % merged.length];
      if (A.t !== "line" || B.t !== "line") continue;
      A.b = pr.a;
      B.a = pr.a;
      // 뒤쪽 직선이 이 조각의 점들도 맡는다
      B.i0 = pr.i0;
      merged.splice(i, 1);
      changed = true;
      break;
    }
    // 다시 일직선인 이웃 합치기
    for (let i = 0; merged.length > 3 && i < merged.length; i++) {
      const A = merged[i];
      const B = merged[(i + 1) % merged.length];
      if (A.t === "line" && B.t === "line" && Math.abs(turn(A.a, A.b, B.b)) < (4 * Math.PI) / 180) {
        A.b = B.b;
        A.i1 = B.i1;
        merged.splice((i + 1) % merged.length, 1);
        changed = true;
        break;
      }
    }
  }
  return { kind: "path", prims: refine(merged, pts) };
}

/** 직선은 최소제곱으로 다시 맞추고 (거의 수평·수직이면 정확히), 이웃과 만나는 점을 꼭짓점으로 */
function refine(prims: Prim[], pts: P2[]): Prim[] {
  const N = pts.length;
  type L = { p: P2; d: P2 };
  const lines: (L | null)[] = prims.map((pr) => {
    if (pr.t !== "line") return null;
    const sp = span(pts, pr.i0, pr.i1 % N);
    const trim = Math.min(3, Math.floor(sp.length / 5));
    const core = sp.length > 2 * trim + 2 ? sp.slice(trim, sp.length - trim) : sp;
    const f = fitLine(core);
    let ang = Math.atan2(f.d[1], f.d[0]);
    // 수평·수직·45°에 붙이기
    for (const target of [0, Math.PI / 2, Math.PI, -Math.PI / 2, -Math.PI, Math.PI / 4, (3 * Math.PI) / 4, -Math.PI / 4, (-3 * Math.PI) / 4]) {
      const tol = Math.abs(target) % (Math.PI / 2) < 1e-9 ? (2 * Math.PI) / 180 : (1 * Math.PI) / 180;
      if (Math.abs(ang - target) < tol) ang = target;
    }
    return { p: f.p, d: [Math.cos(ang), Math.sin(ang)] };
  });
  const n = prims.length;
  const out = prims.map((p) => ({ ...p })) as Prim[];
  // 두 직선 사이의 원호는 두 직선에 접하도록 다시 맞춘다 (짧은 원호는 그냥 맞추면 반지름이 부정확하다)
  for (let i = 0; i < n; i++) {
    const A = out[i];
    if (A.t !== "arc" || n < 3) continue;
    const la = lines[(i - 1 + n) % n];
    const lb = lines[(i + 1) % n];
    if (!la || !lb) continue;
    const arcPts = span(pts, A.i0, A.i1 % N);
    const pa = prims[(i - 1 + n) % n];
    const pb = prims[(i + 1) % n];
    const cross = la.d[0] * lb.d[1] - la.d[1] * lb.d[0];
    if (Math.abs(cross) > Math.sin((10 * Math.PI) / 180)) {
      const V = intersect(la, lb);
      if (!V) continue;
      const unit = (q: P2): P2 => {
        const L = Math.hypot(q[0] - V[0], q[1] - V[1]) || 1;
        return [(q[0] - V[0]) / L, (q[1] - V[1]) / L];
      };
      // 꼭짓점에서 각 직선의 먼 끝 쪽 방향
      const u1 = unit(pa.a);
      const u2 = unit(pb.b);
      const bis: P2 = [u1[0] + u2[0], u1[1] + u2[1]];
      const bl = Math.hypot(bis[0], bis[1]);
      if (bl < 1e-6) continue;
      const bu: P2 = [bis[0] / bl, bis[1] / bl];
      const phi = Math.acos(Math.max(-1, Math.min(1, u1[0] * u2[0] + u1[1] * u2[1]))) / 2;
      const center = (r: number): P2 => [V[0] + (bu[0] * r) / Math.sin(phi), V[1] + (bu[1] * r) / Math.sin(phi)];
      // 두 접점 사이(부채꼴 안)에 있는 점만 원호로 본다. 그 밖의 점은 직선 위에 있다.
      const cost = (r: number) => {
        const c = center(r);
        const tl = r / Math.tan(phi);
        const t1: P2 = [V[0] + u1[0] * tl - c[0], V[1] + u1[1] * tl - c[1]];
        const t2: P2 = [V[0] + u2[0] * tl - c[0], V[1] + u2[1] * tl - c[1]];
        const side = Math.sign(t1[0] * t2[1] - t1[1] * t2[0]);
        let e = 0;
        let k = 0;
        for (const q of arcPts) {
          const v: P2 = [q[0] - c[0], q[1] - c[1]];
          if (Math.sign(t1[0] * v[1] - t1[1] * v[0]) !== side || Math.sign(v[0] * t2[1] - v[1] * t2[0]) !== side) continue;
          e += (Math.hypot(v[0], v[1]) - r) ** 2;
          k++;
        }
        return k >= 4 ? e / k : 1e9;
      };
      const r = golden(cost, A.r * 0.3, A.r * 2);
      const c = center(r);
      const ang = Math.atan2(A.m[1] - c[1], A.m[0] - c[0]);
      out[i] = { ...A, c, r, m: [c[0] + r * Math.cos(ang), c[1] + r * Math.sin(ang)] };
    } else {
      // 평행한 두 직선 사이 (장공 끝): 반지름 = 두 직선 거리의 절반, 중심은 가운데 선 위
      const dist = Math.abs(-(lb.p[0] - la.p[0]) * la.d[1] + (lb.p[1] - la.p[1]) * la.d[0]);
      const r = dist / 2;
      const mid: P2 = [(la.p[0] + lb.p[0]) / 2, (la.p[1] + lb.p[1]) / 2];
      // 원호 점들이 가장 멀리 나간 쪽
      let tFar = -Infinity;
      let tNear = Infinity;
      for (const q of arcPts) {
        const t = (q[0] - mid[0]) * la.d[0] + (q[1] - mid[1]) * la.d[1];
        tFar = Math.max(tFar, t);
        tNear = Math.min(tNear, t);
      }
      const tm = (A.m[0] - mid[0]) * la.d[0] + (A.m[1] - mid[1]) * la.d[1];
      const outward = Math.abs(tm - tFar) < Math.abs(tm - tNear) ? 1 : -1;
      const t = outward > 0 ? tFar - r : tNear + r;
      const c: P2 = [mid[0] + la.d[0] * t, mid[1] + la.d[1] * t];
      const ang = Math.atan2(A.m[1] - c[1], A.m[0] - c[0]);
      out[i] = { ...A, c, r, m: [c[0] + r * Math.cos(ang), c[1] + r * Math.sin(ang)] };
    }
  }
  const fitted = out.map((p) => ({ ...p })) as Prim[];
  for (let i = 0; i < n; i++) {
    const A = fitted[i];
    const B = fitted[(i + 1) % n];
    const la = lines[i];
    const lb = lines[(i + 1) % n];
    const junction = A.b;
    let v: P2 = junction;
    if (la && lb) {
      const x = intersect(la, lb);
      if (x && Math.hypot(x[0] - junction[0], x[1] - junction[1]) < 25) v = x;
      else v = project(la, junction);
    } else if (la && B.t === "arc") v = lineArcJoint(la, B.c, B.r, junction);
    else if (lb && A.t === "arc") v = lineArcJoint(lb, A.c, A.r, junction);
    else if (A.t === "arc") {
      const ang = Math.atan2(junction[1] - A.c[1], junction[0] - A.c[0]);
      v = [A.c[0] + A.r * Math.cos(ang), A.c[1] + A.r * Math.sin(ang)];
    }
    out[i].b = v;
    out[(i + 1) % n].a = v;
  }
  return out.map((pr, i) => {
    if (pr.t !== "arc") return pr;
    const orig = prims[i] as Extract<Prim, { t: "arc" }>;
    // 원래 원호가 a→b로 돌던 방향 (화면 각도로 + 또는 -)
    const ang = (q: P2) => Math.atan2(q[1] - pr.c[1], q[0] - pr.c[0]);
    const norm = (x: number) => ((x % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    const dirPlus = norm(ang(orig.m) - ang(orig.a)) < norm(ang(orig.b) - ang(orig.a));
    const a0 = ang(pr.a);
    let sweep = norm(ang(pr.b) - a0);
    if (!dirPlus) sweep = sweep - 2 * Math.PI;
    if (Math.abs(sweep) > (300 * Math.PI) / 180 || Math.abs(sweep) < 1e-3) return { t: "line", a: pr.a, b: pr.b, i0: pr.i0, i1: pr.i1 } as Prim;
    const am = a0 + sweep / 2;
    return { ...pr, m: [pr.c[0] + pr.r * Math.cos(am), pr.c[1] + pr.r * Math.sin(am)] as P2 };
  });
}

/** 1차원 황금 분할 탐색 (최솟값 위치) */
function golden(f: (x: number) => number, a: number, b: number): number {
  const g = (Math.sqrt(5) - 1) / 2;
  let c = b - g * (b - a);
  let d = a + g * (b - a);
  for (let i = 0; i < 60; i++) {
    if (f(c) < f(d)) b = d;
    else a = c;
    c = b - g * (b - a);
    d = a + g * (b - a);
  }
  return (a + b) / 2;
}

function intersect(a: { p: P2; d: P2 }, b: { p: P2; d: P2 }): P2 | null {
  const den = a.d[0] * b.d[1] - a.d[1] * b.d[0];
  if (Math.abs(den) < Math.sin((4 * Math.PI) / 180)) return null;
  const t = ((b.p[0] - a.p[0]) * b.d[1] - (b.p[1] - a.p[1]) * b.d[0]) / den;
  return [a.p[0] + t * a.d[0], a.p[1] + t * a.d[1]];
}
function project(l: { p: P2; d: P2 }, q: P2): P2 {
  const t = (q[0] - l.p[0]) * l.d[0] + (q[1] - l.p[1]) * l.d[1];
  return [l.p[0] + t * l.d[0], l.p[1] + t * l.d[1]];
}
/** 직선과 원이 만나는 곳 (접하면 접점) */
function lineArcJoint(l: { p: P2; d: P2 }, c: P2, r: number, near: P2): P2 {
  const foot = project(l, c);
  const dist = Math.hypot(foot[0] - c[0], foot[1] - c[1]);
  if (Math.abs(dist - r) < Math.max(1.5, 0.12 * r) || dist > r) return foot;
  const half = Math.sqrt(r * r - dist * dist);
  const p1: P2 = [foot[0] + half * l.d[0], foot[1] + half * l.d[1]];
  const p2: P2 = [foot[0] - half * l.d[0], foot[1] - half * l.d[1]];
  return Math.hypot(p1[0] - near[0], p1[1] - near[1]) < Math.hypot(p2[0] - near[0], p2[1] - near[1]) ? p1 : p2;
}
