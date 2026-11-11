import { beforeAll, describe, expect, it } from "vitest";
import opencascade from "replicad-opencascadejs";
import { makeBaseBox, makeCylinder, setOC, type Shape3D } from "replicad";
import { buildAll } from "../src/core/build";
import { applyExpressions } from "../src/core/params";
import { SAMPLES } from "../src/core/samples";
import { buildSheet } from "../src/core/sheet";
import { normalizeDims, overlaps, textBox, type SheetDim } from "../src/core/sheetDims";
import { readStep, stepResult } from "../src/core/importModel";
import { emptyProject, type BuildResult, type Project } from "../src/core/types";

beforeAll(async () => {
  setOC(await (opencascade as any)());
}, 60_000);

const texts = (sh: ReturnType<typeof buildSheet>) => sh.dims.map((d) => d.text);
function textOverlaps(sh: ReturnType<typeof buildSheet>): number {
  const boxes = sh.dims.flatMap((d) => d.texts.map(textBox));
  let n = 0;
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) if (overlaps(boxes[i], boxes[j], -0.1)) n++;
  return n;
}

/** 다른 CAD에서 온 것처럼: 단차 + 보스 + 필렛 R6 + 모따기 C1.5 + 카운터싱크 관통 구멍 2개 → STEP → 읽기 */
async function stepPart(): Promise<{ res: BuildResult; p: Project }> {
  let s = makeBaseBox(80, 50, 12) as Shape3D;
  s = s.fuse(makeBaseBox(40, 50, 10).translate([-20, 0, 12]) as Shape3D) as Shape3D;
  s = s.fuse(makeCylinder(8, 10, [22, 0, 12], [0, 0, 1])) as Shape3D;
  s = s.fillet(6, (e) => e.inDirection("Z").ofLength(12)) as Shape3D;
  s = s.cut(makeCylinder(3, 40, [-30, 15, -5], [0, 0, 1])) as Shape3D;
  s = s.cut(makeCylinder(3, 40, [-30, -15, -5], [0, 0, 1])) as Shape3D;
  s = s.chamfer(1.5, (e) => e.inDirection("Y").inPlane("XY", 22)) as Shape3D;
  const shape = await readStep(await s.blobSTEP().arrayBuffer());
  const res = stepResult(shape, { name: "test.step", turns: [0, 0, 0] });
  const p = emptyProject();
  p.source = { kind: "step", key: "k", name: "test.step", turns: [0, 0, 0] } as Project["source"];
  return { res, p };
}

describe("자동 치수 2.0", () => {
  it("STEP 부품: 단차·보스·R·C·카운터싱크까지 모두, 빠짐 없음, 글자 겹침 없음", async () => {
    const { res, p } = await stepPart();
    const sh = buildSheet(res, p);
    const t = texts(sh);
    expect(t).toContain("2×Ø6 구멍 관통 · 카운터싱크 Ø9×90°");
    expect(t).toContain("Ø16"); // 보스
    expect(t).toContain("2×R6"); // 세로 모서리 필렛
    expect(t).toContain("2×C1.5"); // 윗면 모서리 모따기
    expect(t).toContain("C1.5"); // 보스 끝 모따기 (원뿔)
    expect(t).toContain("12"); // 단차 높이
    expect(t).toContain("40"); // 단차 위치
    expect(t).toContain("62"); // 보스 중심 (왼쪽에서)
    expect(sh.missing).toEqual([]);
    expect(textOverlaps(sh)).toBe(0);
  });

  it("예제 부품 모두: 빠진 치수 없음, 글자 겹침 없음", () => {
    for (const smp of SAMPLES) {
      const p = structuredClone(smp);
      applyExpressions(p);
      const sh = buildSheet(buildAll(p).result, p);
      expect(sh.missing, smp.name).toEqual([]);
      expect(textOverlaps(sh), smp.name).toBe(0);
    }
  });

  it("모서리 R(스케치)과 회전체 가운데 구멍도 치수, 포켓 바닥 높이는 참고 치수 (17)", () => {
    const motor = structuredClone(SAMPLES.find((s) => s.name.includes("모터"))!);
    applyExpressions(motor);
    expect(texts(buildSheet(buildAll(motor).result, motor))).toContain("4×R6");
    const flange = structuredClone(SAMPLES.find((s) => s.name.includes("플랜지"))!);
    applyExpressions(flange);
    expect(texts(buildSheet(buildAll(flange).result, flange))).toContain("Ø16 구멍 관통");
    const guide = structuredClone(SAMPLES.find((s) => s.name.includes("가이드"))!);
    applyExpressions(guide);
    expect(texts(buildSheet(buildAll(guide).result, guide))).toContain("(17)");
  });

  it("자동 치수를 숨기면 빠짐 검사가 알려 주고, 직접 놓은 치수는 잰 값으로", async () => {
    const { res, p } = await stepPart();
    const sh0 = buildSheet(res, p);
    const r = sh0.dims.find((d) => d.text === "2×R6")!;
    const sh = buildSheet(res, p, { hide: [r.id] });
    expect(sh.missing.some((m) => m.includes("R6"))).toBe(true);
    // 직접: 평면도에서 두 구멍 사이 세로 거리
    const manual: SheetDim = { id: "m1", view: "top", kind: "linear", dir: "v", a: [-30, -15], b: [-30, 15], off: 30 };
    const sh2 = buildSheet(res, p, { hide: [r.id], dims: [manual, { id: "m2", view: "top", kind: "radius", c: [34, 19], r: 6, ang: 45, len: 6 }] });
    expect(sh2.dims.find((d) => d.id === "m1")!.text).toBe("30");
    expect(sh2.missing.some((m) => m.includes("R6"))).toBe(false); // 직접 놓은 R6이 채움
    // 옮긴 자동 치수
    const w = sh0.dims.find((d) => d.id === "w:front")!;
    const sh3 = buildSheet(res, p, { moved: { "w:front": { off: -30 } as Partial<SheetDim> } });
    expect(sh3.dims.find((d) => d.id === "w:front")!.box[1]).toBeLessThan(w.box[1] - 10);
  });

  it("저장한 치수 정리: 맞는 것만 남김", () => {
    const ok = normalizeDims([
      { id: "a", view: "front", kind: "linear", dir: "h", a: [0, 0], b: [10, 0], off: -8 },
      { id: "b", view: "top", kind: "radius", c: [0, 0], r: 3, ang: 30, len: 5, suffix: " 참고" },
      { id: "c", view: 5, kind: "linear", dir: "h", a: [0, 0], b: [1, 0], off: 1 },
      { id: "d", view: "side", kind: "radius", c: [0, 0], r: -1, ang: 0, len: 5 },
      { id: "e", view: "side", kind: "leader", tip: [1, 2], knee: [5, 5], text: "메모" },
      null,
    ]);
    expect(ok.map((d) => d.id)).toEqual(["a", "b", "e"]);
  });
});
