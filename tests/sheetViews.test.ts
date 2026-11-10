import { beforeAll, describe, expect, it } from "vitest";
import opencascade from "replicad-opencascadejs";
import { setOC } from "replicad";
import { buildAllPart } from "../src/core/featureBuild";
import { projectView } from "../src/core/build";
import { buildSheet, sheetToDXF } from "../src/core/sheet";
import { clipToCircle, cutCamera, hatchArea, hatchLines, nextLabel, normalizeViews, viewRequest, type DrawingView } from "../src/core/sheetViews";
import type { Prim, Pt } from "../src/core/sheetDims";
import { emptyProject, type Project } from "../src/core/types";

beforeAll(async () => {
  setOC(await (opencascade as any)());
}, 60_000);

/** 속 빈 원통: 바깥 Ø40, 안 Ø20, 높이 30 (Z축) */
function tube(): Project {
  const p = emptyProject();
  p.features = [
    { id: "s", name: "s", kind: "sketch", plane: { kind: "base", base: "XZ", offset: 0 }, shapes: [{ id: "r", kind: "rect", hole: false, x: 10, y: 0, w: 10, h: 30 }] },
    { id: "r", name: "r", kind: "revolve", sketch: "s", op: "add", axis: "v", angle: 360 },
  ];
  return p;
}

describe("도면 뷰 계산 (14.1~14.3)", () => {
  it("절단선 방향: 정면도 세로선 → 오른쪽(+X)을 보고, 화면 위는 Z", () => {
    const { n, cam } = cutCamera("front", [0, -5], [0, 35]);
    expect(n).toEqual([1, 0, 0]);
    expect(cam.up).toEqual([0, 0, 1]);
    expect(cam.toward).toEqual([-1, 0, 0]);
    // 정면도 가로선 (왼→오른) → 아래를 봄(평면 단면), 위쪽은 +Y
    const h = cutCamera("front", [-30, 10], [30, 10]);
    expect(h.n).toEqual([0, 0, -1]);
    expect(h.cam.up).toEqual([0, 1, 0]);
    // 뒤집기
    expect(cutCamera("front", [0, -5], [0, 35], true).n).toEqual([-1, 0, 0]);
  });

  it("원으로 자르기: 선은 원 안쪽만, 원호는 교점에서 나눔", () => {
    const prims: Prim[] = [
      { layer: "VISIBLE", t: "line", a: [-10, 0], b: [10, 0] },
      { layer: "VISIBLE", t: "line", a: [20, 20], b: [30, 30] },
      { layer: "VISIBLE", t: "arc", c: [5, 0], r: 5, start: 0, end: 360 },
    ];
    const out = clipToCircle(prims, [0, 0], 5);
    const line = out.find((p) => p.t === "line") as Extract<Prim, { t: "line" }>;
    expect(line.a[0]).toBeCloseTo(-5, 9);
    expect(line.b[0]).toBeCloseTo(5, 9);
    expect(out.filter((p) => p.t === "line")).toHaveLength(1);
    const arcs = out.filter((p) => p.t === "arc") as Extract<Prim, { t: "arc" }>[];
    // 원 (5,0) r5와 원 (0,0) r5의 교점은 x = 2.5 → 안쪽 조각은 120°~240° (120° 길이)
    const span = arcs.reduce((a, x) => a + (x.end - x.start), 0);
    expect(span).toBeCloseTo(120, 6);
  });

  it("해칭: 정사각형 10×10에서 구멍 4×4를 빼면 넓이 84 (선 길이 × 간격)", () => {
    const sq = (x: number, y: number, w: number): [Pt, Pt][] => [
      [[x, y], [x + w, y]],
      [[x + w, y], [x + w, y + w]],
      [[x + w, y + w], [x, y + w]],
      [[x, y + w], [x, y]],
    ];
    const gap = 0.05;
    const lines = hatchLines([...sq(0, 0, 10), ...sq(3, 3, 4)], gap, 45);
    expect(hatchArea(lines, gap)).toBeCloseTo(84, 0);
  });

  it("뷰 문자: A부터, 쓴 것과 I·O는 건너뜀 · 저장 값 검사", () => {
    expect(nextLabel([])).toBe("A");
    const v: DrawingView[] = [{ id: "1", kind: "iso", label: "A" }, { id: "2", kind: "iso", label: "B" }];
    expect(nextLabel(v)).toBe("C");
    const back = normalizeViews([
      { id: "a", kind: "section", parent: "front", a: [0, 0], b: [0, 10], label: "A", flip: true },
      { id: "b", kind: "detail", parent: "a", c: [1, 1], r: 3, k: 4, label: "B", at: [100, 80] },
      { id: "c", kind: "section", parent: "nope", a: [0, 0], b: [0, 10] },
      { id: "d", kind: "section", parent: "top", a: [1, 1], b: [1, 1] },
    ])!;
    expect(back.map((x) => x.id)).toEqual(["a", "b"]);
    expect(back[1]).toMatchObject({ k: 4, at: [100, 80] });
  });

  it("속 빈 원통의 단면: 자른 면 넓이 = 2 × (20−10) × 30 = 600, 숨은선 없음", () => {
    const { shape } = buildAllPart(tube());
    const req = viewRequest({ id: "A", kind: "section", parent: "front", a: [0, -5], b: [0, 35], label: "A" })!;
    const { view, hatch } = projectView(shape, req);
    expect(view.hidden).toEqual([]);
    expect(view.visible.length).toBeGreaterThan(0);
    const segs: [Pt, Pt][] = [];
    for (const pl of hatch!) for (let i = 0; i + 1 < pl.length; i++) segs.push([pl[i], pl[i + 1]]);
    const gap = 0.05;
    expect(hatchArea(hatchLines(segs, gap), gap)).toBeCloseTo(600, -1);
  });

  it("도면에 단면도·상세도·등각: 해칭·절단선·이름, 추가 뷰 칸에 배치, DXF에 HATCH 레이어", () => {
    const p = tube();
    const { shape, result } = buildAllPart(p);
    const views: DrawingView[] = [
      { id: "A", kind: "section", parent: "front", a: [0, -5], b: [0, 35], label: "A" },
      { id: "B", kind: "detail", parent: "front", c: [15, 30], r: 6, k: 4, label: "B" },
      { id: "I", kind: "iso", label: "ISO" },
    ];
    const data: Record<string, any> = {};
    for (const v of views) {
      const r = viewRequest(v);
      if (r) data[v.id] = projectView(shape, r);
    }
    const sh = buildSheet(result, p, {}, { views, data, hide: ["top"] });
    expect(sh.prims.filter((x) => x.layer === "HATCH").length).toBeGreaterThan(20);
    const texts = sh.texts.map((t) => t.text);
    expect(texts).toContain("단면 A-A");
    expect(texts).toContain("상세 B (4:1)");
    expect(texts).toContain("등각 그림");
    expect(texts).not.toContain("평면도");
    expect(Object.keys(sh.views).sort()).toEqual(["A", "B", "I", "front", "side"]);
    expect(sh.views.B.s).toBeCloseTo(sh.scale * 4, 9);
    // 추가 뷰는 기본 뷰와 겹치지 않음
    const overlap = (a: number[], b: number[]) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
    for (const x of ["A", "B", "I"]) for (const y of ["front", "side"]) expect(overlap(sh.views[x].box, sh.views[y].box)).toBe(false);
    expect(sheetToDXF(sh)).toContain("HATCH");
  });
});
