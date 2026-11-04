import { beforeAll, describe, expect, it } from "vitest";
import opencascade from "replicad-opencascadejs";
import { setOC } from "replicad";
import { buildAll } from "../src/core/build";
import { emptyProject, type Project } from "../src/core/types";
import { SAMPLES } from "../src/core/samples";

beforeAll(async () => {
  setOC(await (opencascade as any)());
}, 60_000);

const bb = (p: Project) => buildAll(p).result.bbox.map((a) => a.map((v) => Math.round(v * 100) / 100));

describe("2D → 3D", () => {
  it("단일 정면도는 두께만큼 돌출", () => {
    const p = emptyProject();
    p.thickness = 5;
    p.views.front.push({ id: "a", kind: "rect", x: 0, y: 0, w: 40, h: 20, hole: false });
    expect(bb(p)).toEqual([[0, 0, 0], [40, 5, 20]]);
  });

  it("단일 평면도 + 구멍: 부피에서 구멍이 빠진다", () => {
    const p = emptyProject();
    p.thickness = 10;
    p.views.top.push({ id: "a", kind: "rect", x: 0, y: 0, w: 50, h: 50, hole: false });
    p.views.top.push({ id: "b", kind: "circle", cx: 25, cy: 25, r: 10, hole: true });
    const r = buildAll(p).result;
    expect(r.bbox.map((a) => a.map((v) => Math.round(v)))).toEqual([[0, 0, 0], [50, 50, 10]]);
    expect(r.volume).toBeGreaterThan(50 * 50 * 10 - Math.PI * 100 * 10 - 30);
    expect(r.volume).toBeLessThan(50 * 50 * 10 - Math.PI * 100 * 10 + 30);
  });

  it("정면도 + 평면도 + 측면도 교집합 (L 브래킷)", () => {
    const p = emptyProject();
    // 정면도: L자 (X 0..60, Z 0..40, 두께 10)
    p.views.front.push({ id: "f", kind: "poly", hole: false, pts: [[0, 0], [60, 0], [60, 10], [10, 10], [10, 40], [0, 40]] });
    // 평면도: X 0..60, Y 0..30
    p.views.top.push({ id: "t", kind: "rect", x: 0, y: 0, w: 60, h: 30, hole: false });
    const r = buildAll(p).result;
    expect(r.bbox.map((a) => a.map((v) => Math.round(v)))).toEqual([[0, 0, 0], [60, 30, 40]]);
    expect(Math.round(r.volume)).toBe((60 * 10 + 10 * 30) * 30);
  });

  it("회전 모드: 원통", () => {
    const p = emptyProject();
    p.mode = "revolve";
    p.views.front.push({ id: "f", kind: "rect", x: -5, y: 0, w: 15, h: 30, hole: false });
    const r = buildAll(p).result;
    expect(r.bbox.map((a) => a.map((v) => Math.round(v)))).toEqual([[-10, -10, 0], [10, 10, 30]]);
    expect(Math.abs(r.volume - Math.PI * 100 * 30)).toBeLessThan(Math.PI * 100 * 30 * 0.01);
  });
});

describe("3D → 2D 투영", () => {
  it("뷰마다 3각법 좌표로 투영된다", () => {
    const p = emptyProject();
    p.thickness = 8;
    p.views.top.push({ id: "a", kind: "rect", x: 0, y: 0, w: 40, h: 25, hole: false });
    p.views.top.push({ id: "b", kind: "circle", cx: 20, cy: 12, r: 4, hole: true });
    const { projections } = buildAll(p).result;
    const round = (b: any) => b.map((a: number[]) => a.map((v) => Math.round(v) + 0));
    // 정면도: (x, z), 평면도: (x, y), 우측면도: (y, z)
    expect(round(projections.front.bounds)).toEqual([[0, 0], [40, 8]]);
    expect(round(projections.top.bounds)).toEqual([[0, 0], [40, 25]]);
    expect(round(projections.side.bounds)).toEqual([[0, 0], [25, 8]]);
    // 관통 구멍은 정면도에서 숨은선으로 나와야 한다
    expect(projections.front.hidden.length).toBeGreaterThan(0);
  });
});

describe("예제", () => {
  for (const s of SAMPLES) {
    it(`${s.name} 생성`, () => {
      const r = buildAll(s).result;
      expect(r.volume).toBeGreaterThan(0);
    });
  }
});
