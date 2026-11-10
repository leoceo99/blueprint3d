import { beforeAll, describe, expect, it } from "vitest";
import opencascade from "replicad-opencascadejs";
import { setOC } from "replicad";
import { buildAllPart, buildPart } from "../src/core/featureBuild";
import { frameOf, normalizeFeatures, toPlane, toWorld, type Feature, type FaceSig } from "../src/core/featureModel";
import { applyExpressions } from "../src/core/params";
import { normalizeProject } from "../src/core/project";
import { emptyProject, type Project, type Shape2D } from "../src/core/types";

beforeAll(async () => {
  setOC(await (opencascade as any)());
}, 60_000);

const rect = (x: number, y: number, w: number, h: number, extra: Partial<Shape2D> = {}): Shape2D => ({ id: `r${x}${y}${w}${h}`, kind: "rect", hole: false, x, y, w, h, ...extra }) as Shape2D;
const circle = (cx: number, cy: number, r: number, extra: Partial<Shape2D> = {}): Shape2D => ({ id: `c${cx}_${cy}_${r}`, kind: "circle", hole: false, cx, cy, r, ...extra }) as Shape2D;

function part(features: Feature[], init: (p: Project) => void = () => {}): Project {
  const p = emptyProject();
  p.features = features;
  init(p);
  return p;
}

const sketchXY = (id: string, shapes: Shape2D[], offset = 0): Feature => ({ id, name: id, kind: "sketch", plane: { kind: "base", base: "XY", offset }, shapes });
const vol = (p: Project) => buildAllPart(p).result.volume;
/** 부피는 메쉬로 재므로 곡면이 있으면 조금 다름 — 상대 오차로 비교 */
const near = (got: number, want: number, rel = 0.003) => expect(Math.abs(got - want) / want).toBeLessThan(rel);

describe("평면 계산", () => {
  it("기본 평면은 3면도와 같은 방향, 면 위 스케치는 세계 원점을 면에 내린 점이 원점", () => {
    const xz = frameOf({ kind: "base", base: "XZ", offset: 0 });
    expect(toWorld(xz, 10, 5)).toEqual([10, 0, 5]);
    const top = frameOf({ kind: "face", face: { t: "plane", c: [30, 20, 15], n: [0, 0, 1], a: 100 }, offset: 0 });
    expect(top.origin).toEqual([0, 0, 15]);
    expect(top.x).toEqual([1, 0, 0]);
    expect(toPlane(top, [3, 4, 15])).toEqual([3, 4]);
    // 오른쪽 면: 가로 = Y, 세로 = Z (우측면도와 같게)
    const right = frameOf({ kind: "face", face: { t: "plane", c: [30, 0, 0], n: [1, 0, 0], a: 100 }, offset: 0 });
    expect(right.x).toEqual([0, 1, 0]);
    expect(right.y).toEqual([0, 0, 1]);
  });
});

describe("피처 계산", () => {
  it("스케치 → 돌출: 상자 부피·크기", () => {
    const p = part([sketchXY("s1", [rect(0, 0, 60, 40)]), { id: "e1", name: "돌출 1", kind: "extrude", sketch: "s1", op: "add", extent: "dist", dist: 20 }]);
    const { result } = buildAllPart(p);
    expect(result.volume).toBeCloseTo(48000, 0);
    expect(result.bbox).toEqual([[0, 0, 0], [60, 40, 20]]);
    expect(result.featureLog?.map((x) => x.state)).toEqual(["ok", "ok"]);
    expect(result.topo?.faces).toHaveLength(6);
    expect(result.mesh.faceGroups).toHaveLength(6);
  });

  it("윗면에 스케치 → 빼기 끝까지: 관통 구멍", () => {
    const base = part([sketchXY("s1", [rect(0, 0, 60, 40)]), { id: "e1", name: "e", kind: "extrude", sketch: "s1", op: "add", extent: "dist", dist: 20 }]);
    const top = buildAllPart(base).result.topo!.faces.find((f) => f.n?.[2] === 1)!;
    base.features!.push(
      { id: "s2", name: "s2", kind: "sketch", plane: { kind: "face", face: top, offset: 0 }, shapes: [circle(30, 20, 5)] },
      { id: "e2", name: "e2", kind: "extrude", sketch: "s2", op: "cut", extent: "through", dist: 10, flip: true },
    );
    near(vol(base), 48000 - Math.PI * 25 * 20);
  });

  it("양쪽 같게 돌출 · 거리 반대쪽", () => {
    const sym = part([sketchXY("s1", [rect(0, 0, 10, 10)]), { id: "e1", name: "e", kind: "extrude", sketch: "s1", op: "add", extent: "sym", dist: 8 }]);
    expect(buildAllPart(sym).result.bbox[0][2]).toBeCloseTo(-4, 6);
    const flip = part([sketchXY("s1", [rect(0, 0, 10, 10)]), { id: "e1", name: "e", kind: "extrude", sketch: "s1", op: "add", extent: "dist", dist: 8, flip: true }]);
    expect(buildAllPart(flip).result.bbox[1][2]).toBeCloseTo(0, 6);
  });

  it("회전: 속이 빈 원통", () => {
    const p = part([
      { id: "s1", name: "s", kind: "sketch", plane: { kind: "base", base: "XZ", offset: 0 }, shapes: [rect(10, 0, 10, 30)] },
      { id: "r1", name: "r", kind: "revolve", sketch: "s1", op: "add", axis: "v", angle: 360 },
    ]);
    near(vol(p), Math.PI * (400 - 100) * 30);
  });

  it("3면도 몸체 + 필렛: 위쪽 치수를 바꿔도 같은 모서리를 다시 찾음", () => {
    const p = emptyProject();
    p.views.top = [rect(0, 0, 60, 40)];
    p.thickness = 20;
    const first = buildAllPart(p).result;
    const vertical = first.topo!.edges.filter((e) => e.t === "line" && Math.abs(e.d![2]) > 0.99);
    expect(vertical).toHaveLength(4);
    p.features = [{ id: "f1", name: "필렛 1", kind: "fillet", edges: vertical, r: 5 }];
    const cornerLoss = (25 - (Math.PI * 25) / 4) * 20;
    near(vol(p), 48000 - 4 * cornerLoss);
    // 가로를 60 → 80으로: 모서리 위치가 바뀌어도 다시 찾음
    (p.views.top[0] as any).w = 80;
    const r = buildAllPart(p).result;
    expect(r.featureLog![0].state).toBe("ok");
    near(r.volume, 64000 - 4 * cornerLoss);
  });

  it("못 찾는 모서리는 그 피처만 오류, 뒤 피처는 계속 계산", () => {
    const p = part([
      sketchXY("s1", [rect(0, 0, 60, 40)]),
      { id: "e1", name: "e", kind: "extrude", sketch: "s1", op: "add", extent: "dist", dist: 20 },
      { id: "f1", name: "f", kind: "fillet", edges: [{ t: "circle", c: [500, 500, 500], d: [0, 0, 1], r: 3, l: 18 }], r: 2 },
      { id: "x1", name: "x", kind: "extrude", sketch: "nope", op: "add", extent: "dist", dist: 5 },
      sketchXY("s2", [rect(0, 0, 10, 10)], 20),
      { id: "e2", name: "e2", kind: "extrude", sketch: "s2", op: "add", extent: "dist", dist: 5 },
    ]);
    const r = buildAllPart(p).result;
    expect(r.featureLog!.map((x) => x.state)).toEqual(["ok", "ok", "error", "error", "ok", "ok"]);
    expect(r.volume).toBeCloseTo(48000 + 500, 0);
  });

  it("끄기 · 되감기", () => {
    const feats: Feature[] = [
      sketchXY("s1", [rect(0, 0, 60, 40)]),
      { id: "e1", name: "e", kind: "extrude", sketch: "s1", op: "add", extent: "dist", dist: 20 },
      sketchXY("s2", [rect(0, 0, 10, 10)], 20),
      { id: "e2", name: "e2", kind: "extrude", sketch: "s2", op: "add", extent: "dist", dist: 5 },
    ];
    const off = part(structuredClone(feats));
    (off.features![3] as any).suppressed = true;
    expect(vol(off)).toBeCloseTo(48000, 0);
    const rolled = part(structuredClone(feats), (p) => (p.rollback = 2));
    const r = buildAllPart(rolled).result;
    expect(r.volume).toBeCloseTo(48000, 0);
    expect(r.featureLog!.map((x) => x.state)).toEqual(["ok", "ok", "rolled", "rolled"]);
  });

  it("몸체가 없으면 피처 결과와 함께 오류", () => {
    const p = part([sketchXY("s1", [rect(0, 0, 10, 10)])]);
    try {
      buildPart(p);
      expect.unreachable();
    } catch (e: any) {
      expect(e.message).toContain("아직 몸체가 없어요");
      expect(e.log).toEqual([{ id: "s1", state: "ok" }]);
    }
  });

  it("쉘 · 구배", () => {
    const base = (): Project => part([sketchXY("s1", [rect(0, 0, 60, 40)]), { id: "e1", name: "e", kind: "extrude", sketch: "s1", op: "add", extent: "dist", dist: 20 }]);
    const p = base();
    const top = buildAllPart(p).result.topo!.faces.find((f) => f.n?.[2] === 1)! as FaceSig;
    p.features!.push({ id: "sh", name: "쉘", kind: "shell", faces: [top], t: 2 });
    near(vol(p), 48000 - 56 * 36 * 18);
    const d = base();
    const sides = buildAllPart(d).result.topo!.faces.filter((f) => f.t === "plane" && Math.abs(f.n![2]) < 0.1);
    d.features!.push({ id: "dr", name: "구배", kind: "draft", faces: sides, angle: 3, neutral: "XY" });
    const r = buildAllPart(d).result;
    expect(r.featureLog!.at(-1)!.state).toBe("ok");
    expect(r.volume).toBeLessThan(48000);
  });

  it("직선 패턴 · 원형 패턴 · 대칭", () => {
    const p = part([
      sketchXY("s1", [rect(0, 0, 100, 20)]),
      { id: "e1", name: "e", kind: "extrude", sketch: "s1", op: "add", extent: "dist", dist: 10 },
      sketchXY("s2", [circle(10, 10, 3)], 10),
      { id: "c1", name: "c", kind: "extrude", sketch: "s2", op: "cut", extent: "dist", dist: 10, flip: true },
      { id: "p1", name: "p", kind: "pattern", mode: "linear", of: ["c1"], axis: "X", count: 4, spacing: 20, angle: 360 },
    ]);
    near(vol(p), 20000 - 4 * Math.PI * 9 * 10);
    const c = part([
      { id: "s1", name: "s", kind: "sketch", plane: { kind: "base", base: "XY", offset: 0 }, shapes: [circle(0, 0, 40)] },
      { id: "e1", name: "e", kind: "extrude", sketch: "s1", op: "add", extent: "dist", dist: 10 },
      sketchXY("s2", [circle(30, 0, 4)], 10),
      { id: "c1", name: "c", kind: "extrude", sketch: "s2", op: "cut", extent: "dist", dist: 10, flip: true },
      { id: "p1", name: "p", kind: "pattern", mode: "circular", of: ["c1"], axis: "Z", count: 6, spacing: 0, angle: 360 },
    ]);
    near(vol(c), Math.PI * 1600 * 10 - 6 * Math.PI * 16 * 10);
    const m = part([
      sketchXY("s1", [rect(0, 0, 30, 20)]),
      { id: "e1", name: "e", kind: "extrude", sketch: "s1", op: "add", extent: "dist", dist: 10 },
      { id: "m1", name: "m", kind: "mirror", of: [], plane: "YZ" },
    ]);
    const mr = buildAllPart(m).result;
    expect(mr.volume).toBeCloseTo(12000, 0);
    expect(mr.bbox[0][0]).toBeCloseTo(-30, 6);
  });

  it("구멍 피처: 카운터보어 M6을 윗면에", () => {
    const p = part([sketchXY("s1", [rect(0, 0, 40, 40)]), { id: "e1", name: "e", kind: "extrude", sketch: "s1", op: "add", extent: "dist", dist: 20 }]);
    const top = buildAllPart(p).result.topo!.faces.find((f) => f.n?.[2] === 1)!;
    p.features!.push(
      { id: "s2", name: "s2", kind: "sketch", plane: { kind: "face", face: top, offset: 0 }, shapes: [circle(20, 20, 1)] },
      { id: "h1", name: "구멍", kind: "hole", sketch: "s2", spec: { size: "M6", purpose: "clearance-normal", head: "counterbore", cbDiameter: 11, cbDepth: 6.5 }, d: 6.6, depth: null },
    );
    const want = 32000 - Math.PI * 3.3 ** 2 * 20 - Math.PI * (5.5 ** 2 - 3.3 ** 2) * 6.5;
    near(vol(p), want);
  });

  it("스윕: 관(속 지름) 부피 ≈ π(R²−r²)·길이", () => {
    const p = part([
      { id: "path", name: "경로", kind: "sketch", plane: { kind: "base", base: "XZ", offset: 0 }, shapes: [{ id: "l", kind: "poly", hole: false, open: true, pts: [[0, 0], [0, 50], [40, 50]] } as Shape2D] },
      { id: "sw", name: "관", kind: "sweep", path: "path", profile: { kind: "circle", d: 10, inner: 8 }, op: "add" },
    ]);
    const r = buildAllPart(p).result;
    expect(r.featureLog!.map((x) => x.state)).toEqual(["ok", "ok"]);
    near(r.volume, Math.PI * (25 - 16) * 90, 0.02);
  });

  it("로프트: 사각형 → 원", () => {
    const p = part([
      sketchXY("a", [rect(-10, -10, 20, 20)]),
      sketchXY("b", [circle(0, 0, 5)], 30),
      { id: "lo", name: "로프트", kind: "loft", sketches: ["a", "b"], op: "add" },
    ]);
    const r = buildAllPart(p).result;
    expect(r.featureLog!.at(-1)!.state).toBe("ok");
    expect(r.volume).toBeGreaterThan(Math.PI * 25 * 30);
    expect(r.volume).toBeLessThan(400 * 30);
  });

  it("피처 값을 변수 식으로: 거리 = L/2", () => {
    const p = part([sketchXY("s1", [rect(0, 0, 10, 10)]), { id: "e1", name: "e", kind: "extrude", sketch: "s1", op: "add", extent: "dist", dist: 1, exprs: { dist: "L/2" } }], (q) => (q.params = [{ name: "L", expr: "40" }]));
    expect(applyExpressions(p).problems).toEqual([]);
    expect((p.features![1] as any).dist).toBe(20);
    expect(vol(p)).toBeCloseTo(2000, 0);
  });

  it("저장 → 열기: 피처 목록 그대로, 망가진 피처는 뺌", () => {
    const p = part([
      sketchXY("s1", [rect(0, 0, 10, 10)]),
      { id: "e1", name: "e", kind: "extrude", sketch: "s1", op: "add", extent: "dist", dist: 5 },
    ]);
    p.rollback = 1;
    const back = normalizeProject(JSON.parse(JSON.stringify(p)))!;
    expect(back.features).toEqual(p.features);
    expect(back.rollback).toBe(1);
    const bad = normalizeFeatures([{ id: "x", kind: "extrude" }, { id: "y", kind: "nope" }, null], () => null, () => undefined);
    expect(bad).toBeUndefined();
  });
});
