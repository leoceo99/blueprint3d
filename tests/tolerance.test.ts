// 14.4·14.5: 끼워맞춤 표(ISO 286), 공차 글자, 표면 거칠기·기하공차·데이텀 기호, 저장 정리
import { describe, expect, it } from "vitest";
import { fitDeviation, fmtDev } from "../src/core/fits";
import { dimText, renderDim, type SheetDim } from "../src/core/sheetDims";
import { normalizeDims } from "../src/core/dimsNormalize";
import { cleanEdits } from "../src/core/document";

const um = (code: string, d: number) => {
  const r = fitDeviation(d, code);
  return r && [Math.round(r.up * 1000), Math.round(r.lo * 1000)];
};

describe("끼워맞춤 (ISO 286 = KS B 0401)", () => {
  it("18~30 mm: 자주 쓰는 구멍·축 (µm)", () => {
    expect(um("H7", 20)).toEqual([21, 0]);
    expect(um("H8", 20)).toEqual([33, 0]);
    expect(um("g6", 20)).toEqual([-7, -20]);
    expect(um("h6", 20)).toEqual([0, -13]);
    expect(um("f7", 20)).toEqual([-20, -41]);
    expect(um("k6", 20)).toEqual([15, 2]);
    expect(um("m6", 20)).toEqual([21, 8]);
    expect(um("n6", 20)).toEqual([28, 15]);
    expect(um("p6", 20)).toEqual([35, 22]);
    expect(fitDeviation(20, "js6")!.up).toBeCloseTo(0.0065, 9); // ±IT6/2 = ±6.5 µm
    expect(fitDeviation(20, "js6")!.lo).toBeCloseTo(-0.0065, 9);
    expect(um("N7", 20)).toEqual([-7, -28]);
    expect(um("P7", 20)).toEqual([-14, -35]);
    expect(um("K7", 20)).toEqual([6, -15]);
    expect(um("G7", 20)).toEqual([28, 7]);
    expect(um("F8", 20)).toEqual([53, 20]);
  });

  it("다른 범위: Ø10은 6~10 칸, Ø50은 30~50 칸, Ø100 H7 = +35/0", () => {
    expect(um("H7", 10)).toEqual([15, 0]);
    expect(um("H7", 50)).toEqual([25, 0]);
    expect(um("g6", 50)).toEqual([-9, -25]);
    expect(um("H7", 100)).toEqual([35, 0]);
    expect(um("h9", 100)).toEqual([0, -87]);
    // 3D에서 잰 값의 오차: 50.000002는 30~50 칸 (IT7 25 µm)
    expect(um("h7", 50.000002)).toEqual([0, -25]);
  });

  it("못 구하는 것: 이상한 기호, 표 밖 크기, 표에 없는 조합", () => {
    expect(fitDeviation(20, "Z7")).toBeNull();
    expect(fitDeviation(20, "H")).toBeNull();
    expect(fitDeviation(600, "H7")).toBeNull();
    expect(fitDeviation(0, "H7")).toBeNull();
    expect(fitDeviation(20, "K9")).toBeNull();
    expect(fitDeviation(20, "k9")).toBeNull();
  });

  it("허용차 글자", () => {
    expect(fmtDev(0.021)).toBe("+0.021");
    expect(fmtDev(0)).toBe("0");
    expect(fmtDev(-0.007)).toBe("−0.007");
    expect(fmtDev(0.1)).toBe("+0.1");
  });
});

const fmt = (n: number) => String(Math.round(n * 1000) / 1000);
const P = (q: [number, number]): [number, number] => [100 + q[0], 100 + q[1]];

describe("공차 글자 (14.4)", () => {
  const dia: SheetDim = { id: "d", view: "front", kind: "diameter", c: [0, 0], r: 10, ang: 45, len: 8 };
  it("± · 위·아래 · 끼워맞춤", () => {
    expect(dimText({ ...dia, tol: { kind: "sym", v: 0.1 } }, fmt)).toBe("Ø20 ±0.1");
    expect(dimText({ ...dia, tol: { kind: "dev", up: 0.05, lo: -0.02 } }, fmt)).toBe("Ø20 (+0.05/−0.02)");
    expect(dimText({ ...dia, tol: { kind: "fit", code: "H7" } }, fmt)).toBe("Ø20 H7 (+0.021/0)");
    // 덧붙인 글자는 공차 뒤
    expect(dimText({ ...dia, tol: { kind: "fit", code: "g6" }, suffix: " (참고)" }, fmt)).toBe("Ø20 g6 (−0.007/−0.02) (참고)");
    // 길이 치수도
    const lin: SheetDim = { id: "l", view: "front", kind: "linear", dir: "h", a: [0, 0], b: [40, 0], off: 10, tol: { kind: "fit", code: "h9" } };
    expect(dimText(lin, fmt)).toBe("40 h9 (0/−0.062)");
    // 치수는 소수 둘째 자리(mm)여도 허용차는 셋째 자리까지, inch는 넷째 자리
    const mm2 = (n: number) => String(Math.round(n * 100) / 100);
    expect(dimText({ ...lin, tol: { kind: "fit", code: "h7" }, b: [50, 0] }, mm2)).toBe("50 h7 (0/−0.025)");
    const inch = (n: number) => String(Math.round((n / 25.4) * 1000) / 1000);
    expect(dimText({ ...lin, tol: { kind: "sym", v: 0.0254 }, b: [50.8, 0] }, inch)).toBe("2 ±0.001");
  });

  it("DXF 진짜 치수의 글자에도 공차", () => {
    const r = renderDim({ ...dia, tol: { kind: "fit", code: "H7" } }, P, 1, fmt);
    expect(r.dxf?.text).toContain("H7");
  });
});

describe("기호 (14.5)", () => {
  it("표면 거칠기: √ 두 다리 + 위 가로선 + Ra 글자, 제거 가공이면 막대 하나 더", () => {
    const any = renderDim({ id: "r", view: "front", kind: "rough", tip: [0, 0], knee: [0, 0], ra: "3.2" }, P, 1, fmt);
    const rem = renderDim({ id: "r", view: "front", kind: "rough", tip: [0, 0], knee: [0, 0], ra: "3.2", mode: "remove" }, P, 1, fmt);
    expect(any.texts.map((t) => t.text)).toEqual(["Ra 3.2"]);
    expect(any.prims.filter((p) => p.t === "line")).toHaveLength(3);
    expect(rem.prims.filter((p) => p.t === "line")).toHaveLength(4);
    // 꼭짓점이 면 위 (tip)
    const v = any.prims[0] as Extract<(typeof any.prims)[number], { t: "line" }>;
    expect(v.a).toEqual([100, 100]);
    // 누르기 상자는 기호 전체
    expect(any.box[1]).toBeLessThanOrEqual(100);
    expect(any.box[3]).toBeGreaterThan(106);
    expect(any.dxf).toBeUndefined();
  });

  it("기하공차 틀: 칸 = 기호 + 공차 + 데이텀 수, 화살표는 형상 쪽", () => {
    const r = renderDim({ id: "g", view: "front", kind: "gdt", tip: [0, 0], knee: [10, 10], sym: "perp", value: "0.02", datums: ["A", "B"] }, P, 1, fmt);
    expect(r.texts.map((t) => t.text)).toEqual(["0.02", "A", "B"]);
    expect(r.prims.some((p) => p.t === "fill")).toBe(true);
    // 틀 높이 6
    expect(r.box[3] - r.box[1]).toBeGreaterThanOrEqual(6);
    const pos = renderDim({ id: "g", view: "front", kind: "gdt", tip: [0, 0], knee: [-10, 5], sym: "position", value: "0.1", dia: true }, P, 1, fmt);
    expect(pos.texts[0].text).toBe("Ø0.1");
    // 왼쪽으로 놓으면 틀이 지시선 왼쪽에
    expect(pos.box[0]).toBeLessThan(90);
    expect(dimText({ id: "g", view: "front", kind: "gdt", tip: [0, 0], knee: [10, 10], sym: "flat", value: "0.05" }, fmt)).toBe("평면도 0.05");
  });

  it("데이텀: 채운 삼각형 + 네모 + 문자", () => {
    const r = renderDim({ id: "a", view: "front", kind: "datum", tip: [0, 0], knee: [0, -8], label: "A" }, P, 1, fmt);
    expect(r.texts.map((t) => t.text)).toEqual(["A"]);
    expect(r.prims.filter((p) => p.t === "fill")).toHaveLength(1);
    expect(r.prims.filter((p) => p.t === "line").length).toBeGreaterThanOrEqual(5);
  });

  it("저장 정리: 공차·기호를 남기고 틀린 것은 버림, 추가 뷰 id도 받음", () => {
    const ok = normalizeDims([
      { id: "a", view: "front", kind: "diameter", c: [0, 0], r: 5, ang: 0, len: 5, tol: { kind: "fit", code: "H7" } },
      { id: "b", view: "front", kind: "diameter", c: [0, 0], r: 5, ang: 0, len: 5, tol: { kind: "dev", up: -1, lo: 1 } },
      { id: "c", view: "vabc1", kind: "rough", tip: [1, 1], knee: [0, 0], ra: "1.6", mode: "keep" },
      { id: "d", view: "front", kind: "gdt", tip: [1, 1], knee: [5, 5], sym: "flat", value: "0.05", datums: ["A", 3, "B"] },
      { id: "e", view: "front", kind: "gdt", tip: [1, 1], knee: [5, 5], sym: "wobble", value: "0.05" },
      { id: "f", view: "top", kind: "datum", tip: [1, 1], knee: [0, -8], label: "A" },
      { id: "g", view: "top", kind: "datum", tip: [1, 1], knee: [0, -8], label: "" },
    ]);
    expect(ok.map((d) => d.id)).toEqual(["a", "b", "c", "d", "f"]);
    expect(ok[0].tol).toEqual({ kind: "fit", code: "H7" });
    expect(ok[1].tol).toBeUndefined(); // 위 < 아래 → 버림
    expect(ok[3]).toMatchObject({ datums: ["A", "B"] });
    // 자동 치수 고침에도 공차
    const e = cleanEdits({ moved: { "w:front": { off: 3, tol: { kind: "sym", v: 0.2 } }, x: { tol: { kind: "sym", v: -1 } } } });
    expect(e?.moved).toEqual({ "w:front": { off: 3, tol: { kind: "sym", v: 0.2 } } });
  });
});
