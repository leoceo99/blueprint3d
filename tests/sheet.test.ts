import { beforeAll, describe, expect, it } from "vitest";
import opencascade from "replicad-opencascadejs";
import { setOC } from "replicad";
import { buildAll } from "../src/core/build";
import { applyExpressions, convertProjectUnit } from "../src/core/params";
import { SAMPLES } from "../src/core/samples";
import { buildSheet, chooseLayout, parseProjection, sheetToDXF, sheetTexts } from "../src/core/sheet";
import { emptyProject } from "../src/core/types";

beforeAll(async () => {
  setOC(await (opencascade as any)());
}, 60_000);

const sample = (name: string) => {
  const p = structuredClone(SAMPLES.find((s) => s.name.includes(name))!);
  applyExpressions(p);
  return p;
};

describe("투영선 읽기", () => {
  it("SVG 원호(A)는 원호로, 방향은 뷰 좌표(y 위)로 바뀐다", () => {
    // SVG에서 (1,0) → (0,-1) 은 화면상 위쪽 = 뷰 좌표로 (1,0) → (0,1) 반시계 90°
    const [arc] = parseProjection("M 1 0 A 1 1 0 0 0 0 -1", "VISIBLE");
    expect(arc.t).toBe("arc");
    if (arc.t !== "arc") return;
    expect(arc.r).toBeCloseTo(1, 9);
    expect(arc.c[0]).toBeCloseTo(0, 9);
    expect(arc.c[1]).toBeCloseTo(0, 9);
    expect(arc.start).toBeCloseTo(0, 6);
    expect(arc.end).toBeCloseTo(90, 6);
  });
  it("직선과 닫기", () => {
    const prims = parseProjection("M 0 0 L 10 0 L 10 -5 Z", "HIDDEN");
    expect(prims.map((p) => p.t)).toEqual(["line", "line", "line"]);
  });
});

describe("용지와 척도", () => {
  const box = (w: number, h: number, d: number) => ({
    front: { min: [0, 0] as [number, number], max: [w, h] as [number, number] },
    top: { min: [0, 0] as [number, number], max: [w, d] as [number, number] },
    side: { min: [0, 0] as [number, number], max: [d, h] as [number, number] },
  });
  it("작은 부품은 A4에 확대 척도, 큰 부품은 줄이거나 큰 용지", () => {
    const small = chooseLayout(box(20, 10, 10));
    expect(small.paper).toBe("A4");
    expect(small.scale).toBeGreaterThan(1);
    expect(chooseLayout(box(80, 40, 30))).toEqual({ paper: "A4", scale: 1 });
    expect(chooseLayout(box(200, 100, 80)).paper).toBe("A3");
    expect(chooseLayout(box(1200, 600, 400)).scale).toBeLessThan(1);
  });
  it("직접 지정한 용지·척도를 따른다", () => {
    expect(chooseLayout(box(80, 40, 30), { paper: "A3", scale: "1:2" })).toEqual({ paper: "A3", scale: 0.5 });
  });
});

describe("출력 도면", () => {
  it("가이드 블록: 원호·중심선·구멍 지시·표제란, DXF는 ARC/CIRCLE과 실제 크기", () => {
    const p = sample("가이드 블록");
    const res = buildAll(p).result;
    const sh = buildSheet(res, p);
    expect(sh.paper).toBe("A4");
    expect(sh.prims.some((x) => x.t === "arc")).toBe(true);
    expect(sh.prims.filter((x) => x.layer === "CENTER").length).toBeGreaterThan(6);
    const texts = sheetTexts(sh).map((t) => t.text);
    expect(texts).toContain("2×M6 관통구멍 Ø6.6 관통 · 카운터보어 Ø11 깊이 6.5");
    expect(texts).toContain("M5 탭 깊이 12");
    expect(texts.some((t) => t.includes("포켓 깊이 8"))).toBe(true);
    expect(texts).toContain("80"); // 전체 폭
    expect(texts).toContain(p.name);
    expect(sh.svg).toContain(`width="${sh.width}mm"`);

    const dxf = sheetToDXF(sh);
    expect(dxf).toMatch(/\nARC\n|\nCIRCLE\n/);
    expect(dxf).toContain("\nCENTER\n");
    // 실제 크기: 1:1 도면이면 전체 폭 80인 외형선이 있어야 한다
    const lines = [...dxf.matchAll(/\nLINE\n8\nVISIBLE\n10\n([-\d.]+)\n20\n([-\d.]+)\n30\n0\n11\n([-\d.]+)\n21\n([-\d.]+)/g)].map((m) => m.slice(1).map(Number));
    expect(lines.some(([x1, y1, x2, y2]) => Math.abs(Math.hypot(x2 - x1, y2 - y1) - 80) < 0.01)).toBe(true);
  });

  it("변수 판: 같은 구멍 4개는 '4×'로 묶이고 위치는 모서리 기준 좌표 치수", () => {
    const p = sample("변수로");
    const sh = buildSheet(buildAll(p).result, p);
    const texts = sheetTexts(sh).map((t) => t.text);
    expect(texts).toContain("4×M5 관통구멍 Ø5.5 관통");
    for (const v of ["8", "92", "52"]) expect(texts).toContain(v);
  });

  it("플랜지: 원 위에 같은 간격의 볼트 구멍은 PCD 지시 + 볼트 원 중심선", () => {
    const p = sample("플랜지");
    const sh = buildSheet(buildAll(p).result, p);
    const texts = sheetTexts(sh).map((t) => t.text);
    expect(texts).toContain("6×M6 관통구멍 Ø6.6 관통, PCD Ø60 등배치");
    // 개별 구멍 좌표(예: 14.02) 대신 볼트 원 중심만
    expect(texts).not.toContain("14.02");
    expect(sh.prims.some((x) => x.t === "arc" && x.layer === "CENTER" && Math.abs(x.r - 30 * sh.scale) < 1e-3)).toBe(true);
  });

  it("inch 부품: 치수 글자·표제란·DXF가 inch (모양은 같음)", () => {
    const p = sample("가이드 블록");
    const mmSheet = buildSheet(buildAll(p).result, p);
    const q = structuredClone(p);
    expect(convertProjectUnit(q, "inch")).toBe(0);
    applyExpressions(q);
    const res = buildAll(q).result;
    const sh = buildSheet(res, q);
    expect(sh.units).toBe("inch");
    const texts = sheetTexts(sh).map((t) => t.text);
    expect(texts).toContain("3.15"); // 전체 폭 80 mm
    expect(texts).toContain("3각법 · inch");
    expect(texts.some((t) => t.includes("M5 탭 깊이 0.472"))).toBe(true);
    expect(sh.prims.length).toBe(mmSheet.prims.length);
    const dxf = sheetToDXF(sh);
    expect(dxf).toContain("$INSUNITS\n70\n1\n");
    const lines = [...dxf.matchAll(/\nLINE\n8\nVISIBLE\n10\n([-\d.]+)\n20\n([-\d.]+)\n30\n0\n11\n([-\d.]+)\n21\n([-\d.]+)/g)].map((m) => m.slice(1).map(Number));
    expect(lines.some(([x1, y1, x2, y2]) => Math.abs(Math.hypot(x2 - x1, y2 - y1) - 80 / 25.4) < 0.002)).toBe(true);
    expect(sheetToDXF(mmSheet)).toContain("$INSUNITS\n70\n4\n");
  });

  it("척도를 바꾸면 DXF 좌표는 그대로(실제 크기)", () => {
    const p = emptyProject();
    p.views.top.push({ id: "a", kind: "rect", x: 0, y: 0, w: 50, h: 30, hole: false });
    const res = buildAll(p).result;
    const d1 = sheetToDXF(buildSheet(res, { ...p, sheet: { scale: "1:1" } }));
    const d2 = sheetToDXF(buildSheet(res, { ...p, sheet: { scale: "1:2" } }));
    const len = (dxf: string) =>
      [...dxf.matchAll(/\nLINE\n8\nVISIBLE\n10\n([-\d.]+)\n20\n([-\d.]+)\n30\n0\n11\n([-\d.]+)\n21\n([-\d.]+)/g)]
        .map((m) => m.slice(1).map(Number))
        .map(([a, b, c, d]) => Math.round(Math.hypot(c - a, d - b) * 100) / 100)
        .sort((a, b) => b - a)[0];
    expect(len(d1)).toBe(50);
    expect(len(d2)).toBe(50);
  });
});

describe("DXF 글자", () => {
  it("한글은 \\U+XXXX, 지름 기호는 %%c로", async () => {
    const { dxfText } = await import("../src/core/sheet");
    expect(dxfText("4×Ø6.6 관통")).toBe("4\\U+00D7%%c6.6 \\U+AD00\\U+D1B5");
    expect(dxfText("45° ±0.1")).toBe("45%%d %%p0.1");
  });
});
