/** 시험용: 도면 이미지를 직접 그리는 아주 작은 래스터라이저 (흰 바탕 = 1, 검은 선 = 0) */
import { gray, type Gray, type Mask, type P2 } from "../src/core/vision/raster";

export class Canvas {
  g: Gray;
  constructor(
    public w: number,
    public h: number,
  ) {
    this.g = gray(w, h, 1);
  }
  private ink(x: number, y: number, a = 1) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const i = y * this.w + x;
    this.g.d[i] = Math.min(this.g.d[i], 1 - a);
  }
  /** 거리 함수 dist(x,y) ≤ half 인 곳을 칠한다 (가장자리는 부드럽게) */
  private paint(box: [number, number, number, number], dist: (x: number, y: number) => number, half: number) {
    const [x0, y0, x1, y1] = box.map(Math.floor) as [number, number, number, number];
    for (let y = Math.max(0, y0 - 2); y <= Math.min(this.h - 1, y1 + 2); y++)
      for (let x = Math.max(0, x0 - 2); x <= Math.min(this.w - 1, x1 + 2); x++) {
        const d = dist(x + 0.5, y + 0.5);
        const a = Math.max(0, Math.min(1, half + 0.5 - d));
        if (a > 0) this.ink(x, y, a);
      }
  }
  line(a: P2, b: P2, width: number) {
    const half = width / 2;
    this.paint(
      [Math.min(a[0], b[0]) - half, Math.min(a[1], b[1]) - half, Math.max(a[0], b[0]) + half, Math.max(a[1], b[1]) + half],
      (x, y) => segDist([x, y], a, b),
      half,
    );
  }
  dashed(a: P2, b: P2, width: number, pattern: number[]) {
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const d: P2 = [(b[0] - a[0]) / L, (b[1] - a[1]) / L];
    let t = 0;
    let k = 0;
    while (t < L) {
      const len = pattern[k % pattern.length];
      if (k % 2 === 0) {
        const t1 = Math.min(L, t + len);
        this.line([a[0] + d[0] * t, a[1] + d[1] * t], [a[0] + d[0] * t1, a[1] + d[1] * t1], width);
      }
      t += len;
      k++;
    }
  }
  circle(c: P2, r: number, width: number) {
    const half = width / 2;
    this.paint([c[0] - r - half, c[1] - r - half, c[0] + r + half, c[1] + r + half], (x, y) => Math.abs(Math.hypot(x - c[0], y - c[1]) - r), half);
  }
  /** 화면 기준 각도(도, y 아래라 시계 방향으로 증가) a0→a1 */
  arc(c: P2, r: number, a0: number, a1: number, width: number) {
    const half = width / 2;
    const pts = 64;
    let prev: P2 | null = null;
    for (let i = 0; i <= pts; i++) {
      const a = ((a0 + ((a1 - a0) * i) / pts) * Math.PI) / 180;
      const q: P2 = [c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)];
      if (prev) this.line(prev, q, width);
      prev = q;
    }
    void half;
  }
  poly(pts: P2[], width: number) {
    pts.forEach((p, i) => this.line(p, pts[(i + 1) % pts.length], width));
  }
  rect(x: number, y: number, w: number, h: number, width: number) {
    this.poly(
      [
        [x, y],
        [x + w, y],
        [x + w, y + h],
        [x, y + h],
      ],
      width,
    );
  }
  /** 글자 흉내: 작은 획 몇 개 */
  text(x: number, y: number, size: number, n: number, width: number) {
    for (let i = 0; i < n; i++) {
      const ox = x + i * size * 0.7;
      this.line([ox, y], [ox + size * 0.5, y - size], width);
      this.line([ox + size * 0.5, y - size], [ox + size * 0.5, y], width);
      this.circle([ox + size * 0.25, y - size * 0.3], size * 0.22, width);
    }
  }
}

export function segDist(p: P2, a: P2, b: P2): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const L2 = dx * dx + dy * dy;
  const t = L2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2)) : 0;
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/** 채운 다각형 마스크 */
export function fillPoly(w: number, h: number, pts: P2[]): Mask {
  const m = { w, h, d: new Uint8Array(w * h) };
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      let inside = false;
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const [xi, yi] = pts[i];
        const [xj, yj] = pts[j];
        if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
      }
      m.d[y * w + x] = inside ? 1 : 0;
    }
  return m;
}

import type { Sheet } from "../src/core/sheet";

const LAYER_STYLE: Record<string, { w: number; dash?: number[] }> = {
  VISIBLE: { w: 0.5 },
  HIDDEN: { w: 0.3, dash: [2.5, 1.2] },
  CENTER: { w: 0.2, dash: [8, 1.5, 1, 1.5] },
  DIM: { w: 0.18 },
  FRAME: { w: 0.5 },
};

/** 도면(용지 mm, y 위) → 이미지 (k px/mm). 글자는 작은 획 몇 개로 흉내 낸다 */
export function rasterizeSheet(sh: Sheet, k: number): Canvas {
  const c = new Canvas(Math.round(sh.width * k), Math.round(sh.height * k));
  const P = (p: [number, number]): P2 => [p[0] * k, (sh.height - p[1]) * k];
  for (const pr of sh.prims) {
    const st = LAYER_STYLE[pr.layer];
    const w = st.w * k;
    const dash = st.dash?.map((d) => d * k);
    if (pr.t === "line") {
      if (dash) c.dashed(P(pr.a), P(pr.b), w, dash);
      else c.line(P(pr.a), P(pr.b), w);
    } else if (pr.t === "arc") {
      let a0 = pr.start;
      let a1 = pr.end;
      if (a1 <= a0) a1 += 360;
      const n = Math.max(8, Math.ceil(((a1 - a0) / 360) * 2 * Math.PI * pr.r * k / 3));
      const pts: P2[] = [];
      for (let i = 0; i <= n; i++) {
        const a = ((a0 + ((a1 - a0) * i) / n) * Math.PI) / 180;
        pts.push(P([pr.c[0] + pr.r * Math.cos(a), pr.c[1] + pr.r * Math.sin(a)]));
      }
      if (dash) {
        // 호 길이를 따라 점선
        let t = 0;
        let kk = 0;
        let on = true;
        let left = dash[0];
        for (let i = 0; i < pts.length - 1; i++) {
          let a = pts[i];
          const b = pts[i + 1];
          let seg = Math.hypot(b[0] - a[0], b[1] - a[1]);
          while (seg > 1e-9) {
            const step = Math.min(seg, left);
            const f = step / seg;
            const m: P2 = [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
            if (on) c.line(a, m, w);
            a = m;
            seg -= step;
            left -= step;
            t += step;
            if (left <= 1e-9) {
              kk++;
              on = kk % 2 === 0;
              left = dash[kk % dash.length];
            }
          }
        }
      } else for (let i = 0; i < pts.length - 1; i++) c.line(pts[i], pts[i + 1], w);
    } else if (pr.t === "fill") {
      const poly = pr.pts.map(P);
      const xs = poly.map((q) => q[0]);
      const ys = poly.map((q) => q[1]);
      for (let y = Math.max(0, Math.floor(Math.min(...ys))); y <= Math.min(c.h - 1, Math.ceil(Math.max(...ys))); y++)
        for (let x = Math.max(0, Math.floor(Math.min(...xs))); x <= Math.min(c.w - 1, Math.ceil(Math.max(...xs))); x++) {
          let inside = false;
          for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
            const [xi, yi] = poly[i];
            const [xj, yj] = poly[j];
            if (yi > y + 0.5 !== yj > y + 0.5 && x + 0.5 < ((xj - xi) * (y + 0.5 - yi)) / (yj - yi) + xi) inside = !inside;
          }
          if (inside) c.g.d[y * c.w + x] = 0;
        }
    }
  }
  for (const t of sh.texts) {
    const [x, y] = P(t.at);
    const size = t.size * k;
    const n = Math.min(12, Math.max(1, Math.round(t.text.length * 0.8)));
    const width = n * size * 0.7;
    const x0 = t.anchor === "middle" ? x - width / 2 : t.anchor === "end" ? x - width : x;
    if (t.rotate) continue; // 세로 글자는 생략
    c.text(x0, y, size, n, 0.18 * k);
  }
  return c;
}
