/**
 * 제도판 도형 유틸 (sketch.ts에서 나눔 — 10단계 다듬기): 손잡이·꼭짓점·스냅 점, 꼭짓점 옮기기, 도형 이름표.
 * 화면(캔버스)과 무관한 계산만.
 */
import { arcInfo, boundsOf, flatten, normRect, outline, pointInShape, rectPoints, translated } from "../core/geometry2d";
import { holeLabel } from "../core/standards";
import type { Shape2D } from "../core/types";
import { fmtLen } from "../core/units";

export type Pt = [number, number];

/** 선택한 도형의 손잡이: 꼭짓점(크기 조절) 또는 변 가운데(휘기) */
export interface Handle {
  pt: Pt;
  kind: "vertex" | "mid";
  index: number;
}

export function isTyping() {
  const a = document.activeElement;
  return !!a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA" || a.tagName === "SELECT");
}

export function clampScale(s: number) {
  return Math.min(Math.max(s, 0.05), 400);
}

/** 스냅 기준이 되는 점들 */
export function keyPoints(s: Shape2D): Pt[] {
  if (s.kind === "circle")
    return [
      [s.cx, s.cy],
      [s.cx - s.r, s.cy - s.r],
      [s.cx + s.r, s.cy + s.r],
    ];
  if (s.kind === "slot") {
    const b = boundsOf([{ ...s, hole: false }])!;
    return [s.a, s.b, [b[0], b[1]], [b[2], b[3]]];
  }
  // 꼭짓점 + 원호 중심
  const pts: Pt[] = [...vertices(s)];
  for (const seg of outline(s)) {
    const arc = arcInfo(seg);
    if (arc) pts.push(arc.center);
  }
  return pts;
}

/** 선택한 도형의 손잡이 */
export function handles(s: Shape2D): Handle[] {
  const out: Handle[] = vertices(s).map((pt, index) => ({ pt, kind: "vertex" as const, index }));
  if (s.kind === "rect" || s.kind === "poly") {
    const pts = s.kind === "rect" ? rectPoints(s) : s.pts;
    const n = pts.length;
    for (let i = 0; i < n; i++) {
      const bulge = s.kind === "poly" ? (s.bulges?.[i] ?? 0) : 0;
      const arc = arcInfo({ a: pts[i], b: pts[(i + 1) % n], bulge });
      const mid: Pt = arc ? arc.mid : [(pts[i][0] + pts[(i + 1) % n][0]) / 2, (pts[i][1] + pts[(i + 1) % n][1]) / 2];
      out.push({ pt: mid, kind: "mid", index: i });
    }
  }
  return out;
}

export function vertices(s: Shape2D): Pt[] {
  if (s.kind === "rect") {
    const r = normRect(s);
    return [
      [r.x, r.y],
      [r.x + r.w, r.y],
      [r.x + r.w, r.y + r.h],
      [r.x, r.y + r.h],
    ];
  }
  if (s.kind === "circle") return [[s.cx + s.r, s.cy]];
  if (s.kind === "slot") {
    // 두 중심점 + 폭 손잡이 (a 쪽 옆면)
    const L = Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1]) || 1;
    const n: Pt = [-(s.b[1] - s.a[1]) / L, (s.b[0] - s.a[0]) / L];
    const m: Pt = [(s.a[0] + s.b[0]) / 2, (s.a[1] + s.b[1]) / 2];
    return [s.a, s.b, [m[0] + n[0] * (s.w / 2), m[1] + n[1] * (s.w / 2)]];
  }
  return s.pts;
}

export function setVertex(s: Shape2D, i: number, p: Pt) {
  if (s.kind === "poly") s.pts[i] = p;
  else if (s.kind === "circle") s.r = Math.max(Math.hypot(p[0] - s.cx, p[1] - s.cy), 0.05);
  else if (s.kind === "slot") {
    if (i === 0) s.a = p;
    else if (i === 1) s.b = p;
    else {
      // 중심선에서 떨어진 거리 × 2 = 폭
      const L = Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1]);
      const d = L > 1e-9 ? Math.abs((s.b[0] - s.a[0]) * (p[1] - s.a[1]) - (s.b[1] - s.a[1]) * (p[0] - s.a[0])) / L : Math.hypot(p[0] - s.a[0], p[1] - s.a[1]);
      s.w = Math.max(Math.round(d * 2 * 1e4) / 1e4, 0.1);
    }
  } else {
    const opp = vertices(s)[(i + 2) % 4];
    const r = normRect(s);
    Object.assign(s, {
      x: Math.min(opp[0], p[0]),
      y: Math.min(opp[1], p[1]),
      w: Math.abs(p[0] - opp[0]) || r.w,
      h: Math.abs(p[1] - opp[1]) || r.h,
    });
  }
}

export function translateShape(s: Shape2D, orig: Shape2D, du: number, dv: number) {
  Object.assign(s, translated(orig, du, dv));
}

export function contains(outer: Shape2D, inner: Shape2D): boolean {
  return flatten(inner, Math.PI / 6).every(([u, v]) => pointInShape(u, v, outer));
}

/** 길이 표시 (문서 단위: mm 또는 inch) */
export function fmt(n: number): string {
  return fmtLen(n);
}

export function shapeLabel(s: Shape2D, short = false): string {
  const base = baseLabel(s);
  if (s.kind === "circle" && s.hole && (s.spec || s.depth !== undefined)) return holeLabel(s.r * 2, s.spec, s.depth, short);
  if (s.hole && s.depth !== undefined) return `${base} · 포켓 깊이 ${fmt(s.depth)}`;
  return base;
}

export function baseLabel(s: Shape2D): string {
  if (s.kind === "rect") {
    const r = normRect(s);
    const c = s.corners?.find(Boolean);
    return `사각형 ${fmt(r.w)}×${fmt(r.h)}${c ? ` · ${c.kind === "fillet" ? "R" : "C"}${fmt(c.size)}` : ""}`;
  }
  if (s.kind === "circle") return `원 Ø${fmt(s.r * 2)}`;
  if (s.kind === "slot") return `장공 ${fmt(Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1]))}×${fmt(s.w)}`;
  const arcs = s.bulges?.filter((b) => b).length ?? 0;
  return `다각형 ${s.pts.length}점${arcs ? ` · 호 ${arcs}` : ""}`;
}
