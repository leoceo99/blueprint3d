import { beforeAll, describe, expect, it } from "vitest";
import opencascade from "replicad-opencascadejs";
import { setOC } from "replicad";
import { buildAllPart } from "../src/core/featureBuild";
import { densityOf, fmtMass, massOf, materialSheet } from "../src/core/materials";
import { normalizeProject } from "../src/core/project";
import { emptyProject } from "../src/core/types";

beforeAll(async () => {
  setOC(await (opencascade as any)());
}, 60_000);

describe("재질 · 무게 · 무게 중심 (13.7)", () => {
  it("철판 100×100×10 = 785 g, 무게 중심은 가운데", () => {
    const p = emptyProject();
    p.views.top = [{ id: "r", kind: "rect", hole: false, x: 0, y: 0, w: 100, h: 100 }];
    p.thickness = 10;
    p.material = "steel";
    const r = buildAllPart(p).result;
    expect(r.volume).toBeCloseTo(100000, 3);
    expect(massOf(r.volume, densityOf(p)!)).toBeCloseTo(785, 6);
    expect(r.com).toEqual([50, 50, 5]);
    expect(fmtMass(785)).toBe("785.0 g");
    expect(fmtMass(12345)).toBe("12.345 kg");
    expect(materialSheet(p)).toBe("S45C");
  });

  it("L자 모양은 무게 중심이 두꺼운 쪽으로", () => {
    const p = emptyProject();
    p.views.front = [{ id: "l", kind: "poly", hole: false, pts: [[0, 0], [60, 0], [60, 10], [10, 10], [10, 50], [0, 50]] }];
    p.thickness = 20;
    const r = buildAllPart(p).result;
    // 가로 판 60×10 (중심 x30 z5) + 세로 판 10×40 (중심 x5 z30), 넓이 600 : 400
    expect(r.com![0]).toBeCloseTo((600 * 30 + 400 * 5) / 1000, 6);
    expect(r.com![2]).toBeCloseTo((600 * 5 + 400 * 30) / 1000, 6);
  });

  it("직접 밀도 · 잘못된 값은 버림", () => {
    const p = emptyProject() as any;
    p.material = "custom";
    p.density = 2.5;
    expect(densityOf(normalizeProject(JSON.parse(JSON.stringify(p)))!)).toBe(2.5);
    p.material = "unobtainium";
    const q = normalizeProject(JSON.parse(JSON.stringify(p)))!;
    expect(q.material).toBeUndefined();
    expect(q.density).toBeUndefined();
  });
});
