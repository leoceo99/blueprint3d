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

describe("모서리 R · 장공 · 휜 변", () => {
  it("모서리 R 판재 부피", () => {
    const p = emptyProject();
    p.thickness = 5;
    p.views.top.push({ id: "a", kind: "rect", x: 0, y: 0, w: 40, h: 20, hole: false, corners: [0, 1, 2, 3].map(() => ({ kind: "fillet" as const, size: 4 })) });
    const r = buildAll(p).result;
    const expected = (40 * 20 - (4 - Math.PI) * 16) * 5;
    expect(Math.abs(r.volume - expected) / expected).toBeLessThan(0.005);
  });

  it("장공 구멍이 뚫린다", () => {
    const p = emptyProject();
    p.thickness = 4;
    p.views.top.push({ id: "a", kind: "rect", x: 0, y: 0, w: 60, h: 30, hole: false });
    p.views.top.push({ id: "s", kind: "slot", a: [20, 15], b: [40, 15], w: 6, hole: true });
    const r = buildAll(p).result;
    const expected = (60 * 30 - (20 * 6 + Math.PI * 9)) * 4;
    expect(Math.abs(r.volume - expected) / expected).toBeLessThan(0.005);
  });

  it("휜 변(원호)과 모따기가 섞인 다각형", () => {
    const p = emptyProject();
    p.thickness = 2;
    p.views.top.push({
      id: "p",
      kind: "poly",
      hole: false,
      pts: [[0, 0], [20, 0], [20, 10], [0, 10]],
      bulges: [0, 1, 0, 0],
      corners: [{ kind: "chamfer", size: 2 }, null, null, { kind: "chamfer", size: 2 }],
    });
    const r = buildAll(p).result;
    const expected = (200 + (Math.PI * 25) / 2 - 2 * 2) * 2;
    expect(Math.abs(r.volume - expected) / expected).toBeLessThan(0.005);
    expect(r.bbox[1][0]).toBeCloseTo(25, 3);
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

describe("관통 구멍 빠른 경로", () => {
  const plate = () => {
    const p = emptyProject();
    p.thickness = 5;
    p.views.top.push({ id: "b", kind: "rect", hole: false, x: 0, y: 0, w: 100, h: 60 });
    return p;
  };
  const vol = (p: Project) => buildAll(p).result.volume;

  it("구멍이 많아도 부피가 맞다 (몸체 안 원·장공은 면의 안쪽 경계로)", () => {
    const p = plate();
    let n = 0;
    for (let i = 0; i < 9; i++) for (let j = 0; j < 5; j++) p.views.top.push({ id: `h${n++}`, kind: "circle", hole: true, cx: 10 + i * 10, cy: 10 + j * 10, r: 2 });
    p.views.top.push({ id: "s", kind: "slot", hole: true, a: [20, 55], b: [80, 55], w: 3 });
    const expected = (100 * 60 - 45 * Math.PI * 4 - (60 * 3 + Math.PI * 1.5 * 1.5)) * 5;
    expect(Math.abs(vol(p) - expected) / expected).toBeLessThan(0.003);
  });

  it("가장자리에 걸친 구멍과 서로 겹친 구멍도 그대로 빠진다", () => {
    const p = plate();
    // 가장자리에 걸친 원 (반만 빠짐) + 서로 겹친 두 원
    p.views.top.push({ id: "e", kind: "circle", hole: true, cx: 0, cy: 30, r: 5 });
    p.views.top.push({ id: "o1", kind: "circle", hole: true, cx: 50, cy: 30, r: 5 });
    p.views.top.push({ id: "o2", kind: "circle", hole: true, cx: 55, cy: 30, r: 5 });
    // 겹친 두 원의 합집합 넓이 = 2πr² − 렌즈 넓이 (d = 5, r = 5)
    const r = 5;
    const d = 5;
    const lens = 2 * r * r * Math.acos(d / (2 * r)) - (d / 2) * Math.sqrt(4 * r * r - d * d);
    const expected = (100 * 60 - (Math.PI * r * r) / 2 - (2 * Math.PI * r * r - lens)) * 5;
    expect(Math.abs(vol(p) - expected) / expected).toBeLessThan(0.003);
  });

  it("두 몸체를 합친 단면의 구멍, 그리고 두 뷰 교집합에서도 같다", () => {
    const p = plate();
    p.views.top.push({ id: "b2", kind: "rect", hole: false, x: 90, y: 0, w: 30, h: 60 });
    p.views.top.push({ id: "h", kind: "circle", hole: true, cx: 95, cy: 30, r: 3 });
    const one = vol(p);
    expect(Math.abs(one - (120 * 60 - Math.PI * 9) * 5) / one).toBeLessThan(0.003);
    // 정면도를 더해 두 뷰 교집합: 높이 5짜리 판이면 결과가 같아야 한다
    p.views.front.push({ id: "f", kind: "rect", hole: false, x: 0, y: 0, w: 120, h: 5 });
    expect(Math.abs(vol(p) - one) / one).toBeLessThan(0.003);
  });
});

describe("저장 파일 읽기", () => {
  it("망가진 프로젝트는 고치거나 거부한다", async () => {
    const { normalizeProject } = await import("../src/core/project");
    expect(normalizeProject({ version: 1, name: "x" })).toBeNull();
    expect(normalizeProject("hello")).toBeNull();
    const p = normalizeProject({
      version: 1,
      views: {
        front: [{ kind: "rect", x: 0, y: 0, w: 10, h: "a" }, { kind: "circle", cx: 1, cy: 2, r: 3, hole: true }],
        top: "nope",
      },
      thickness: -1,
    })!;
    expect(p.views.front).toHaveLength(1);
    expect(p.views.front[0]).toMatchObject({ kind: "circle", hole: true, r: 3 });
    expect(p.views.front[0].id).toBeTruthy();
    expect(p.views.top).toEqual([]);
    expect(p.views.side).toEqual([]);
    expect(p.thickness).toBe(10);
    expect(p.name).toBe("새 부품");
    // 예제는 그대로 통과해야 한다
    for (const s of SAMPLES) expect(normalizeProject(JSON.parse(JSON.stringify(s)))).toEqual(JSON.parse(JSON.stringify(s)));
  });
});
