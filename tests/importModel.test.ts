import { beforeAll, describe, expect, it } from "vitest";
import opencascade from "replicad-opencascadejs";
import { setOC } from "replicad";
import { buildAll } from "../src/core/build";
import { SAMPLES } from "../src/core/samples";
import { orientShape, readStep, readStl, stepResult, stlResult } from "../src/core/importModel";
import { rotateQuarter } from "../src/core/mesh";
import { buildSheet, sheetTexts } from "../src/core/sheet";
import { emptyProject } from "../src/core/types";

beforeAll(async () => {
  setOC(await (opencascade as any)());
}, 60_000);

const sample = (name: string) => structuredClone(SAMPLES.find((s) => s.name.startsWith(name))!);
const src = { name: "test", turns: [0, 0, 0] as [number, number, number] };

describe("STEP 가져오기", () => {
  it("크기·부피가 같고 구멍(카운터보어, 막힌 구멍)을 찾는다", async () => {
    const { shape, result } = buildAll(sample("가이드"));
    const step = await (shape as any).blobSTEP().arrayBuffer();
    const imported = await readStep(step);
    const r = stepResult(imported, src);
    expect(r.bbox.flat().map((v) => Math.round(v * 100) / 100)).toEqual(result.bbox.flat().map((v) => Math.round(v * 100) / 100));
    expect(Math.abs(r.volume - result.volume) / result.volume).toBeLessThan(0.002);
    const top = r.holes!.top;
    expect(top).toHaveLength(2);
    for (const h of top) {
      expect(h).toMatchObject({ kind: "circle", r: 3.3 });
      expect(h.kind === "circle" && h.spec).toMatchObject({ head: "counterbore", cbDiameter: 11, cbDepth: 6.5 });
      expect(h.depth).toBeUndefined(); // 관통
    }
    expect(r.holes!.side).toHaveLength(1);
    // 이 예제의 가로 탭은 세로 구멍(x=68)에 뚫고 들어가서 남은 원통 길이가 12보다 짧다
    expect(r.holes!.side[0]).toMatchObject({ kind: "circle", cx: 20, cy: 12.5, r: 2.1 });
    expect(r.holes!.side[0].depth).toBeGreaterThan(9);
    // 도면에 구멍 지시가 붙는다
    const p = emptyProject();
    p.source = { kind: "step", name: "가이드.step", key: "k", turns: [0, 0, 0] };
    const sh = buildSheet(r, p);
    const labels = sheetTexts(sh).map((t) => t.text).join(" | ");
    expect(labels).toContain("2×Ø6.6 구멍 관통 · 카운터보어 Ø11 깊이 6.5");
    expect(labels).toMatch(/Ø4\.2 구멍 깊이 9\.\d+/);
  });

  it("돌리기: Z축으로 90° 돌리면 가로·세로가 바뀐다", async () => {
    const { shape } = buildAll(sample("가이드"));
    const imported = await readStep(await (shape as any).blobSTEP().arrayBuffer());
    const r = stepResult(orientShape(imported, [0, 0, 1]), src);
    const [lo, hi] = r.bbox;
    expect(Math.round(hi[0] - lo[0])).toBe(40);
    expect(Math.round(hi[1] - lo[1])).toBe(80);
  });

  it("STEP이 아니면 오류", async () => {
    await expect(readStep(new TextEncoder().encode("hello").buffer)).rejects.toThrow();
  });
});

describe("STL 가져오기", () => {
  it("메쉬 결과", async () => {
    const { shape, result } = buildAll(sample("모터"));
    const m = readStl(await (shape as any).blobSTL({ binary: true }).arrayBuffer());
    const r = stlResult(rotateQuarter(m, [0, 0, 0]), src);
    expect(Math.abs(r.volume - result.volume) / result.volume).toBeLessThan(0.01);
    expect(r.projections.top.visible.length).toBeGreaterThan(20);
    expect(r.mesh.triangles.length).toBeGreaterThan(100);
  });
});
