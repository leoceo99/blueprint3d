import { describe, expect, it } from "vitest";
import { convertExprUnit, evalExpr, isValidName, type Val } from "../src/core/expr";
import { applyExpressions, convertProjectUnit, evaluateParams, paramLookup, setDimInput, toggleLock } from "../src/core/params";
import { emptyProject, type Project } from "../src/core/types";
import { normalizeProject } from "../src/core/project";
import { fmtLen, fmtVol } from "../src/core/units";

const none = () => {
  throw new Error("no var");
};
const len = (src: string, unit: "mm" | "inch" = "mm", look: (n: string) => Val | number = none) => evalExpr(src, look, unit, "len").value;

describe("식 안의 단위", () => {
  it("숫자 뒤 단위", () => {
    expect(len("10 mm")).toBe(10);
    expect(len("1 cm")).toBe(10);
    expect(len("0.5 in")).toBeCloseTo(12.7, 12);
    expect(len('2"')).toBeCloseTo(50.8, 12);
    expect(len("1inch + 4.6 mm")).toBeCloseTo(30, 12);
    expect(len("0.1m")).toBeCloseTo(100, 12);
  });
  it("맨 숫자는 문서 단위", () => {
    expect(len("80")).toBe(80);
    expect(len("2", "inch")).toBeCloseTo(50.8, 12);
    // 길이와 더하면 문서 단위, 곱하기에서는 그냥 수
    expect(len("1 in + 10", "mm")).toBeCloseTo(35.4, 12);
    expect(len("10 mm * 2", "inch")).toBe(20);
    expect(len("(L/2) mm", "inch", () => 40)).toBe(20);
    expect(len("L/4", "inch", () => 2)).toBeCloseTo(12.7, 12);
  });
  it("변수 m(기어 모듈)은 이름으로 쓸 수 있고, 단위 낱말은 이름이 안 됨", () => {
    expect(isValidName("m")).toBe(true);
    expect(isValidName("mm")).toBe(false);
    expect(isValidName("in")).toBe(false);
    expect(len("m*20", "mm", () => 2)).toBe(40);
  });
  it("단위가 맞지 않으면 오류", () => {
    expect(() => len("10 mm * 2 mm")).toThrow(/길이가 아니에요/);
    expect(() => evalExpr("sin(10 mm)", none, "mm", "none")).toThrow();
    expect(() => evalExpr("30 mm", none, "mm", "angle")).toThrow(/각도/);
    expect(() => len("(10 mm) in")).toThrow(/이미 단위/);
    expect(() => len("mm")).toThrow();
  });
  it("넓이의 제곱근은 길이", () => {
    expect(len("sqrt((3 mm)^2 + (4 mm)^2)")).toBeCloseTo(5, 12);
    expect(len("round(1.26 in)", "inch")).toBeCloseTo(25.4, 12);
  });
});

describe("단위 바꾸기 — 값 유지", () => {
  const conv = (src: string, from: "mm" | "inch", to: "mm" | "inch", look: (n: string) => Val | number = none) =>
    convertExprUnit(src, from, to, "len", look);
  it("맨 숫자", () => {
    expect(conv("80", "mm", "inch")).toEqual({ expr: "80 mm", ok: true });
    expect(conv("25.4", "mm", "inch")).toEqual({ expr: "1", ok: true });
    expect(conv("1", "inch", "mm")).toEqual({ expr: "25.4", ok: true });
    expect(conv("80 mm", "inch", "mm")).toEqual({ expr: "80", ok: true });
  });
  it("식: 감싸기와 되돌리기", () => {
    const look = () => 60;
    const a = conv("L/4", "mm", "inch", look);
    expect(a.expr).toBe("(L/4) mm");
    expect(conv(a.expr, "inch", "mm", look).expr).toBe("L/4");
    expect(conv("L", "mm", "inch", look).expr).toBe("L mm");
    // 길이와 더한 맨 숫자에 단위 붙이기
    const b = conv("1 in + 10", "mm", "inch");
    expect(b.expr).toBe("1 in + 10 mm");
    expect(b.ok).toBe(true);
  });

  const sample = (): Project => {
    const p = emptyProject();
    p.params = [
      { name: "L", expr: "60" },
      { name: "n", expr: "4" },
      { name: "W", expr: "L + 10 mm" },
      { name: "g", expr: "L/n" },
    ];
    p.thicknessExpr = "L/10";
    p.views.top = [
      { id: "b", kind: "rect", hole: false, x: 0, y: 0, w: 1, h: 1, exprs: { w: "W", h: "40", x: "0" } },
      { id: "h", kind: "circle", hole: true, cx: 0, cy: 20, r: 2, exprs: { cx: "g", d: "6.5" } },
    ];
    p.constraints = { top: [{ id: "k1", kind: "distanceY", refs: [{ s: "@o", k: "o" }, { s: "h", k: "c" }], value: 20, expr: "L/3" }] };
    applyExpressions(p);
    return p;
  };
  const geom = (p: Project) => JSON.stringify([p.thickness, p.views.top.map((s) => ({ ...s, exprs: undefined }))]);

  it("부품 전체 mm → inch → mm: 모양 그대로, 식도 원래대로", () => {
    const p = sample();
    const g0 = geom(p);
    const t0 = JSON.stringify([p.params, p.thicknessExpr, p.views.top.map((s) => s.exprs), p.constraints]);
    expect(convertProjectUnit(p, "inch")).toBe(0);
    expect(p.units).toBe("inch");
    applyExpressions(p);
    expect(geom(p)).toBe(g0);
    expect(p.views.top[0].exprs!.h).toBe("40 mm");
    expect(p.thicknessExpr).toBe("(L/10) mm");
    expect(p.params![2].expr).toBe("L mm + 10 mm");
    // inch 문서에서 맨 숫자를 넣으면 inch
    expect(setDimInput(p.views.top[0], "h", "2", p)).toBeNull();
    expect((p.views.top[0] as { h: number }).h).toBeCloseTo(50.8, 12);
    expect(setDimInput(p.views.top[0], "h", "40 mm", p)).toBeNull();
    applyExpressions(p);
    expect(geom(p)).toBe(g0);
    // 다시 mm
    expect(convertProjectUnit(p, "mm")).toBe(0);
    expect(p.units).toBeUndefined();
    applyExpressions(p);
    expect(geom(p)).toBe(g0);
    expect(JSON.stringify([p.params, p.thicknessExpr, p.views.top.map((s) => s.exprs), p.constraints]).replace('"L mm + 10 mm"', '"L + 10 mm"')).toBe(t0);
  });

  it("inch 부품: 맨 숫자 1 → 25.4 mm, 저장 왕복", () => {
    const p = emptyProject();
    p.units = "inch";
    p.views.top = [{ id: "b", kind: "rect", hole: false, x: 0, y: 0, w: 1, h: 1, exprs: { w: "3", h: "1.5" } }];
    applyExpressions(p);
    expect((p.views.top[0] as { w: number }).w).toBeCloseTo(76.2, 12);
    const q = normalizeProject(JSON.parse(JSON.stringify(p)))!;
    expect(q.units).toBe("inch");
    toggleLock(q.views.top[0], "w", "inch");
    expect(q.views.top[0].exprs!.w).toBeUndefined();
    toggleLock(q.views.top[0], "w", "inch");
    expect(q.views.top[0].exprs!.w).toBe("3");
    expect(convertProjectUnit(q, "mm")).toBe(0);
    expect(q.views.top[0].exprs).toEqual({ w: "76.2", h: "38.1" });
    const r = evaluateParams(q);
    expect(paramLookup(r)).toBeTypeOf("function");
  });

  it("표시", () => {
    expect(fmtLen(80, "inch")).toBe("3.15");
    expect(fmtLen(80, "mm")).toBe("80");
    expect(fmtVol(16387.064, "inch")).toBe("1 in³");
    expect(fmtVol(12000, "mm")).toBe("12 cm³");
  });
});
