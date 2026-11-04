import type { Shape2D } from "./types";

export function normRect(s: { x: number; y: number; w: number; h: number }) {
  const x0 = Math.min(s.x, s.x + s.w);
  const y0 = Math.min(s.y, s.y + s.h);
  return { x: x0, y: y0, w: Math.abs(s.w), h: Math.abs(s.h) };
}

export function shapeBounds(s: Shape2D): [number, number, number, number] {
  if (s.kind === "rect") {
    const r = normRect(s);
    return [r.x, r.y, r.x + r.w, r.y + r.h];
  }
  if (s.kind === "circle") return [s.cx - s.r, s.cy - s.r, s.cx + s.r, s.cy + s.r];
  const xs = s.pts.map((p) => p[0]);
  const ys = s.pts.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

export function boundsOf(shapes: Shape2D[]): [number, number, number, number] | null {
  const solids = shapes.filter((s) => !s.hole);
  if (!solids.length) return null;
  const b = solids.map(shapeBounds);
  return [
    Math.min(...b.map((v) => v[0])),
    Math.min(...b.map((v) => v[1])),
    Math.max(...b.map((v) => v[2])),
    Math.max(...b.map((v) => v[3])),
  ];
}

export function pointInPoly(x: number, y: number, pts: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function pointInShape(x: number, y: number, s: Shape2D): boolean {
  if (s.kind === "rect") {
    const r = normRect(s);
    return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
  }
  if (s.kind === "circle") return (x - s.cx) ** 2 + (y - s.cy) ** 2 <= s.r * s.r;
  return pointInPoly(x, y, s.pts);
}

export function shapeCenter(s: Shape2D): [number, number] {
  if (s.kind === "circle") return [s.cx, s.cy];
  const b = shapeBounds(s);
  return [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
}

/** 넓이가 0에 가깝거나 점이 부족한 도형은 무시 */
export function isDegenerate(s: Shape2D): boolean {
  if (s.kind === "rect") return Math.abs(s.w) < 1e-6 || Math.abs(s.h) < 1e-6;
  if (s.kind === "circle") return s.r < 1e-6;
  if (s.pts.length < 3) return true;
  let a = 0;
  for (let i = 0; i < s.pts.length; i++) {
    const [x1, y1] = s.pts[i];
    const [x2, y2] = s.pts[(i + 1) % s.pts.length];
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a) < 1e-9;
}
