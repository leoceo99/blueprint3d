import { describe, expect, it } from "vitest";
import { evaluate, ExprError, referencedNames, renameInExpr } from "../src/core/expr";
import { applyExpressions, evaluateParams, paramUsage, renameParam, setDimInput, toggleLock } from "../src/core/params";
import { runChecks } from "../src/core/checks";
import { emptyProject } from "../src/core/types";
import { SAMPLES } from "../src/core/samples";

const none = (n: string): number => {
  throw new ExprError(`없는 변수: ${n}`);
};

describe("식 계산", () => {
  it("사칙연산, 우선순위, 거듭제곱, 함수", () => {
    expect(evaluate("1 + 2 * 3", none)).toBe(7);
    expect(evaluate("(1 + 2) * 3", none)).toBe(9);
    expect(evaluate("2^3^2", none)).toBe(512);
    expect(evaluate("-2^2", none)).toBe(-4);
    expect(evaluate("sqrt(9) + max(1, 4, 2) + abs(-1)", none)).toBe(8);
    expect(evaluate("cos(60)", none)).toBeCloseTo(0.5, 12);
    expect(evaluate("2 × 3 ÷ 4", none)).toBe(1.5);
  });

  it("변수와 오류", () => {
    const vars: Record<string, number> = { L: 80, 두께: 5 };
    const look = (n: string) => (n in vars ? vars[n] : none(n));
    expect(evaluate("L/2 - 두께", look)).toBe(35);
    expect(() => evaluate("L/0", look)).toThrow("0으로");
    expect(() => evaluate("W", look)).toThrow("없는 변수");
    expect(() => evaluate("(L", look)).toThrow();
    expect(() => evaluate("L $ 2", look)).toThrow("쓸 수 없는");
  });

  it("쓰인 변수 찾기, 이름 바꾸기 (다른 이름의 일부는 그대로)", () => {
    expect(referencedNames("L/2 + max(t, LL)")).toEqual(["L", "t", "LL"]);
    expect(renameInExpr("L/2 + LL - L1 + L", "L", "길이")).toBe("길이/2 + LL - L1 + 길이");
  });
});

describe("변수와 치수 묶기", () => {
  it("변수끼리 순서 상관없이 참조, 순환은 오류", () => {
    const p = emptyProject();
    p.params = [
      { name: "e", expr: "L / 10" },
      { name: "L", expr: "80" },
      { name: "a", expr: "b + 1" },
      { name: "b", expr: "a + 1" },
    ];
    const r = evaluateParams(p);
    expect(r.values.get("e")).toBe(8);
    expect(r.errors.get("a")).toContain("서로를 참조");
  });

  it("변수를 바꾸면 묶인 치수가 따라 바뀐다", () => {
    const p = emptyProject();
    p.params = [{ name: "L", expr: "80" }, { name: "t", expr: "6" }];
    p.thicknessExpr = "t";
    p.views.top = [
      { id: "b", kind: "rect", hole: false, x: 0, y: 0, w: 10, h: 40, exprs: { w: "L" } },
      { id: "h", kind: "circle", hole: true, cx: 0, cy: 20, r: 2, exprs: { cx: "L/2", d: "t" } },
    ];
    applyExpressions(p);
    expect(p.thickness).toBe(6);
    expect((p.views.top[0] as any).w).toBe(80);
    expect((p.views.top[1] as any).cx).toBe(40);
    expect((p.views.top[1] as any).r).toBe(3);
    p.params[0].expr = "100";
    applyExpressions(p);
    expect((p.views.top[0] as any).w).toBe(100);
    expect((p.views.top[1] as any).cx).toBe(50);
  });

  it("치수 칸 입력: 숫자면 값, 식이면 묶기, 잠금은 끌어도 유지", () => {
    const p = emptyProject();
    p.params = [{ name: "L", expr: "60" }];
    const r: any = { id: "b", kind: "rect", hole: false, x: 0, y: 0, w: 10, h: 10 };
    p.views.top = [r];
    expect(setDimInput(r, "w", "L - 10", p)).toBeNull();
    expect(r.w).toBe(50);
    expect(r.exprs).toEqual({ w: "L - 10" });
    expect(setDimInput(r, "h", "25", p)).toBeNull();
    expect(r.h).toBe(25);
    expect(r.exprs.h).toBeUndefined();
    expect(setDimInput(r, "h", "W*2", p)).toContain("없는 변수");
    // 잠금: 지금 값으로 묶임 → 다른 값으로 바뀌어도 applyExpressions가 되돌린다
    toggleLock(r, "h");
    expect(r.exprs.h).toBe("25");
    r.h = 99; // 끌어서 바뀐 상황
    applyExpressions(p);
    expect(r.h).toBe(25);
    toggleLock(r, "h");
    expect(r.exprs.h).toBeUndefined();
  });

  it("변수 이름 바꾸기는 쓰는 곳까지 같이, 사용처 세기", () => {
    const p = emptyProject();
    p.params = [{ name: "L", expr: "80" }, { name: "e", expr: "L/10" }];
    p.thicknessExpr = "L/8";
    p.views.top = [{ id: "b", kind: "rect", hole: false, x: 0, y: 0, w: 1, h: 1, exprs: { w: "L" } }];
    expect(paramUsage(p, "L")).toBe(3);
    renameParam(p, "L", "길이");
    expect(p.params[0].name).toBe("길이");
    expect(p.params[1].expr).toBe("길이/10");
    expect(p.thicknessExpr).toBe("길이/8");
    expect(p.views.top[0].exprs!.w).toBe("길이");
  });

  it("변수 예제: 식을 계산하면 구멍이 가장자리에서 e만큼 떨어진다", () => {
    const p = structuredClone(SAMPLES.find((x) => x.params)!);
    applyExpressions(p);
    const holes = p.views.top.filter((s) => s.kind === "circle") as any[];
    expect(holes.map((h) => [h.cx, h.cy])).toEqual([[8, 8], [92, 8], [92, 52], [8, 52]]);
    p.params!.find((x) => x.name === "L")!.expr = "150";
    applyExpressions(p);
    expect((p.views.top[0] as any).w).toBe(150);
    expect((p.views.top[2] as any).cx).toBe(142);
    expect(runChecks(p).filter((f) => f.severity !== "info")).toEqual([]);
  });

  it("식 오류는 설계 검사에 오류로 나온다", () => {
    const p = emptyProject();
    p.params = [{ name: "a", expr: "b+1" }];
    p.views.top = [{ id: "b", kind: "rect", hole: false, x: 0, y: 0, w: 10, h: 10, exprs: { w: "zz" } }];
    const ids = runChecks(p).map((f) => f.id);
    expect(ids.some((i) => i.startsWith("expr::") && i.endsWith("param:a"))).toBe(true);
    expect(ids).toContain("expr:top:b:w");
  });
});
