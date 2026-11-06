import { describe, expect, it } from "vitest";
import { fitContour, polygonArea, traceOuter } from "../src/core/vision/contour";
import { count, distTo, erode, fillHoles, label } from "../src/core/vision/morph";
import { mask, rotate, type P2 } from "../src/core/vision/raster";
import { binarize, normalize, skewAngle } from "../src/core/vision/prep";
import { Canvas, fillPoly } from "./visionDraw";

describe("이진 영상 기본 연산", () => {
  it("거리 변환과 깎기", () => {
    const m = fillPoly(40, 40, [
      [10, 10],
      [30, 10],
      [30, 30],
      [10, 30],
    ]);
    const d = distTo(m, 0);
    expect(d[20 * 40 + 20]).toBeCloseTo(10, 5);
    expect(count(erode(m, 3))).toBe(14 * 14);
  });

  it("연결 요소와 막힌 곳 채우기", () => {
    const c = new Canvas(60, 60);
    c.rect(10, 10, 40, 40, 2);
    c.circle([30, 30], 6, 2);
    const ink = binarize(c.g);
    const { comps } = label(ink, 8);
    expect(comps.length).toBe(2);
    const { enclosed } = fillHoles(ink);
    expect(count(enclosed)).toBeGreaterThan(1000);
  });
});

describe("외곽선 따기와 맞추기", () => {
  it("L자 영역의 경계 넓이 = 픽셀 수", () => {
    const pts: P2[] = [
      [5, 5],
      [45, 5],
      [45, 20],
      [20, 20],
      [20, 50],
      [5, 50],
    ];
    const m = fillPoly(60, 60, pts);
    const b = traceOuter(m);
    expect(Math.abs(polygonArea(b))).toBe(count(m));
    const f = fitContour(b);
    expect(f.kind).toBe("path");
    if (f.kind === "path") {
      expect(f.prims.length).toBe(6);
      expect(f.prims.every((p) => p.t === "line")).toBe(true);
      // 꼭짓점이 원래 다각형과 1픽셀 안
      for (const p of f.prims) expect(Math.min(...pts.map((q) => Math.hypot(q[0] - p.a[0], q[1] - p.a[1])))).toBeLessThan(1);
    }
  });

  it("원은 원으로", () => {
    const m = mask(100, 100);
    for (let y = 0; y < 100; y++) for (let x = 0; x < 100; x++) m.d[y * 100 + x] = Math.hypot(x + 0.5 - 50, y + 0.5 - 45) <= 30 ? 1 : 0;
    const f = fitContour(traceOuter(m));
    expect(f.kind).toBe("circle");
    if (f.kind === "circle") {
      expect(f.r).toBeCloseTo(30, 0);
      expect(f.c[0]).toBeCloseTo(50, 0);
    }
  });

  it("모서리가 둥근 사각형: 직선 4개 + 원호 4개", () => {
    const m = mask(140, 100);
    const [x0, y0, x1, y1, r] = [10, 10, 130, 90, 15];
    for (let y = 0; y < 100; y++)
      for (let x = 0; x < 140; x++) {
        const px = x + 0.5;
        const py = y + 0.5;
        const cx = Math.min(Math.max(px, x0 + r), x1 - r);
        const cy = Math.min(Math.max(py, y0 + r), y1 - r);
        m.d[y * 140 + x] = px >= x0 && px <= x1 && py >= y0 && py <= y1 && Math.hypot(px - cx, py - cy) <= r ? 1 : 0;
      }
    const f = fitContour(traceOuter(m));
    expect(f.kind).toBe("path");
    if (f.kind === "path") {
      const arcs = f.prims.filter((p) => p.t === "arc");
      expect(arcs.length).toBe(4);
      for (const a of arcs) if (a.t === "arc") expect(Math.abs(a.r - 15)).toBeLessThan(1);
      expect(f.prims.filter((p) => p.t === "line").length).toBe(4);
    }
  });
});

describe("전처리", () => {
  it("기울기 찾기", () => {
    const c = new Canvas(400, 300);
    c.rect(60, 60, 200, 120, 3);
    c.rect(100, 200, 150, 60, 3);
    c.line([300, 50], [300, 250], 3);
    for (const deg of [3, -2]) {
      const g = rotate(c.g, deg);
      const a = skewAngle(binarize(normalize(g)));
      expect(a).toBeCloseTo(deg, 0);
    }
  });
});

import { detect } from "../src/core/vision/detect";
import { buildProject, defaultChoice } from "../src/core/vision/toProject";

/** 3각법 3면도를 그린 이미지 (k px/mm): 가이드 블록과 비슷한 부품 */
function guideDrawing(k: number, opts: { thick: number; thin: number }) {
  const W = Math.round(297 * k);
  const H = Math.round(210 * k);
  const c = new Canvas(W, H);
  const X = (mm: number) => mm * k;
  const T = opts.thick * k;
  const t = opts.thin * k;
  // 테두리 + 표제란
  c.rect(X(20), X(10), X(267), X(190), T);
  c.rect(X(107), X(166), X(180), X(34), T);
  c.line([X(107), X(183)], [X(287), X(183)], t);
  c.text(X(150), X(180), X(5), 6, t);
  // 정면도: 왼쪽 아래 (x 50..130, 위 바닥 y 150, 높이 25)
  const fx = 50;
  const fy = 150;
  c.rect(X(fx), X(fy - 25), X(80), X(25), T);
  // 숨은선: 구멍 (x 62, 118 ± 3.3)
  for (const hx of [62, 118]) for (const dx of [-3.3, 3.3]) c.dashed([X(fx + hx - 50 + dx), X(fy - 25)], [X(fx + hx - 50 + dx), X(fy)], t * 1.4, [X(2.5), X(1.2)]);
  // 치수선
  c.line([X(fx), X(fy + 8)], [X(fx + 80), X(fy + 8)], t);
  c.line([X(fx), X(fy + 2)], [X(fx), X(fy + 10)], t);
  c.line([X(fx + 80), X(fy + 2)], [X(fx + 80), X(fy + 10)], t);
  c.text(X(fx + 36), X(fy + 7), X(3.5), 2, t);
  // 평면도: 정면도 위 (y 바닥 = 정면도 위 - 22), 80×40, 구멍 2개 Ø6.6, 모서리 둥근 포켓 30×20 R3
  const ty = fy - 25 - 22;
  c.rect(X(fx), X(ty - 40), X(80), X(40), T);
  for (const hx of [12, 68]) {
    c.circle([X(fx + hx), X(ty - 20)], X(3.3), T);
    c.line([X(fx + hx - 6), X(ty - 20)], [X(fx + hx + 6), X(ty - 20)], t);
    c.line([X(fx + hx), X(ty - 26)], [X(fx + hx), X(ty - 14)], t);
  }
  // 둥근 포켓
  const px0 = fx + 25;
  const py0 = ty - 30;
  const R = 3;
  c.line([X(px0 + R), X(py0)], [X(px0 + 30 - R), X(py0)], T);
  c.line([X(px0 + R), X(py0 + 20)], [X(px0 + 30 - R), X(py0 + 20)], T);
  c.line([X(px0), X(py0 + R)], [X(px0), X(py0 + 20 - R)], T);
  c.line([X(px0 + 30), X(py0 + R)], [X(px0 + 30), X(py0 + 20 - R)], T);
  c.arc([X(px0 + R), X(py0 + R)], X(R), 180, 270, T);
  c.arc([X(px0 + 30 - R), X(py0 + R)], X(R), 270, 360, T);
  c.arc([X(px0 + 30 - R), X(py0 + 20 - R)], X(R), 0, 90, T);
  c.arc([X(px0 + R), X(py0 + 20 - R)], X(R), 90, 180, T);
  // 지시선과 글자
  c.line([X(fx + 70), X(ty - 22)], [X(fx + 90), X(ty - 35)], t);
  c.text(X(fx + 92), X(ty - 34), X(3), 8, t);
  // 우측면도: 정면도 오른쪽 (x 시작 = 정면도 오른쪽 + 22), 40×25, 가로 구멍 Ø4.2 (y 20, z 12.5)
  const sx = fx + 80 + 22;
  c.rect(X(sx), X(fy - 25), X(40), X(25), T);
  c.circle([X(sx + 20), X(fy - 12.5)], X(2.1), T);
  c.line([X(sx + 15), X(fy - 12.5)], [X(sx + 25), X(fy - 12.5)], t);
  return c;
}

describe("도면 이미지 → 프로젝트", () => {
  for (const [label, thick, thin] of [
    ["굵기 두 가지", 0.5, 0.18],
    ["굵기 한 가지", 0.35, 0.35],
  ] as const) {
    it(`3면도 인식 (${label})`, () => {
      const k = 6;
      const c = guideDrawing(k, { thick, thin });
      const ink = binarize(normalize(c.g));
      const an = detect(ink);
      const roles = an.views.filter((v) => v.role).map((v) => v.role).sort();
      expect(roles).toEqual(["front", "side", "top"]);
      const { project: p } = buildProject(an, defaultChoice(an, 1 / k));
      const body = (v: "front" | "top" | "side") => p.views[v].find((s) => !s.hole)!;
      expect(body("front")).toMatchObject({ kind: "rect", x: 0, y: 0, w: 80, h: 25 });
      expect(body("top")).toMatchObject({ kind: "rect", x: 0, y: 0, w: 80, h: 40 });
      expect(body("side")).toMatchObject({ kind: "rect", x: 0, y: 0, w: 40, h: 25 });
      const holes = p.views.top.filter((s) => s.hole);
      const circles = holes.filter((s) => s.kind === "circle");
      expect(circles.map((s) => s.kind === "circle" && [s.cx, s.cy, s.r * 2])).toEqual(
        expect.arrayContaining([
          [12, 20, 6.6],
          [68, 20, 6.6],
        ]),
      );
      const pocket = holes.find((s) => s.kind === "rect");
      expect(pocket).toMatchObject({ x: 25, y: 10, w: 30, h: 20 });
      if (pocket?.kind === "rect") expect(pocket.corners?.every((q) => q?.kind === "fillet" && Math.abs(q.size - 3) <= 0.5)).toBe(true);
      const side = p.views.side.find((s) => s.hole);
      expect(side).toMatchObject({ kind: "circle", cx: 20, cy: 12.5, r: 2.1 });
    });
  }
});

import { runPipeline } from "../src/core/vision/pipeline";
import { applyH, gray as mkGray, homography, sample } from "../src/core/vision/raster";

describe("사진·스캔", () => {
  it("2° 기운 스캔", () => {
    const k = 5;
    const c = guideDrawing(k, { thick: 0.5, thin: 0.18 });
    const r = runPipeline(rotate(c.g, 2), { quad: null });
    expect(r.angle).toBeCloseTo(2, 0);
    const { project: p } = buildProject(r.analysis, defaultChoice(r.analysis, 1 / k));
    expect(p.views.front.find((s) => !s.hole)).toMatchObject({ kind: "rect", w: 80, h: 25 });
    expect(p.views.top.filter((s) => s.hole && s.kind === "circle")).toHaveLength(2);
  });

  it("비스듬히 찍은 사진: 종이를 찾아 편다", () => {
    const k = 5;
    const c = guideDrawing(k, { thick: 0.5, thin: 0.18 });
    // 어두운 책상 위에 원근으로 놓인 종이 (출력 1800×1300)
    const W = 1800;
    const H = 1300;
    const paper: P2[] = [
      [230, 140],
      [1610, 210],
      [1700, 1180],
      [120, 1120],
    ];
    const Hm = homography(paper, [
      [0, 0],
      [c.w - 1, 0],
      [c.w - 1, c.h - 1],
      [0, c.h - 1],
    ]);
    const photo = mkGray(W, H, 0.25);
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const [u, v] = applyH(Hm, [x, y]);
        if (u >= 0 && v >= 0 && u <= c.w - 1 && v <= c.h - 1) photo.d[y * W + x] = 0.92 * sample(c.g, u, v) * (0.85 + 0.15 * (x / W));
      }
    const r = runPipeline(photo, { quad: "auto" });
    expect(r.quad).not.toBeNull();
    for (let i = 0; i < 4; i++) expect(Math.hypot(r.quad![i][0] - paper[i][0], r.quad![i][1] - paper[i][1])).toBeLessThan(15);
    // 편 종이 = A4 전체 → 척도는 종이 폭으로
    const s = 297 / r.gray.w;
    const roles = r.analysis.views.filter((v) => v.role).map((v) => v.role).sort();
    expect(roles).toEqual(["front", "side", "top"]);
    const { project: p } = buildProject(r.analysis, { ...defaultChoice(r.analysis, s), snap: 1 });
    const fb = p.views.front.find((s) => !s.hole)!;
    expect(fb.kind === "rect" && [fb.w, fb.h]).toEqual([80, 25]);
  });
});

describe("어두운 바탕", () => {
  it("검은 바탕에 흰 선(태블릿 메모)도 읽는다", () => {
    const k = 5;
    const c = guideDrawing(k, { thick: 0.5, thin: 0.18 });
    const dark = { ...c.g, d: c.g.d.map((v) => 1 - v * 0.95) };
    const r = runPipeline(dark, { quad: "auto" });
    expect(r.inverted).toBe(true);
    expect(r.analysis.views.filter((v) => v.role).length).toBe(3);
  });
});
