import { beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { execFileSync } from "child_process";
import opencascade from "replicad-opencascadejs";
import { setOC } from "replicad";
import { buildAll } from "../src/core/build";
import { applyExpressions, convertProjectUnit } from "../src/core/params";
import { SAMPLES } from "../src/core/samples";
import { buildSheet, sheetToDXF } from "../src/core/sheet";

/** ezdxf(파이썬)가 있으면 그것으로 DXF를 검사한다 — AutoCAD처럼 엄격하게 읽는 도구 */
function ezdxfAvailable(): boolean {
  try {
    execFileSync("python3", ["-c", "import ezdxf"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
const HAS = ezdxfAvailable();
const dir = mkdtempSync(join(tmpdir(), "b3d-dxf-"));

function check(dxf: string, name: string) {
  const f = join(dir, name);
  writeFileSync(f, dxf);
  return JSON.parse(execFileSync("python3", ["scripts/check_dxf.py", f]).toString());
}

beforeAll(async () => {
  setOC(await (opencascade as any)());
}, 60_000);

describe("DXF 진짜 치수", () => {
  it.skipIf(!HAS)("가이드 블록: 치수가 DIMENSION + 그림 블록, 검사 오류 없음", () => {
    const p = structuredClone(SAMPLES.find((s) => s.name.includes("가이드"))!);
    applyExpressions(p);
    const sh = buildSheet(buildAll(p).result, p, {
      dims: [
        { id: "m1", view: "front", kind: "angle", o: [0, 0], a: [80, 0], b: [0, 25], rad: 12 },
        { id: "m2", view: "top", kind: "linear", dir: "aligned", a: [12, 20], b: [68, 30], off: 8, suffix: " ±0.1" },
        { id: "m3", view: "top", kind: "diameter", c: [12, 20], r: 5.5, ang: 135, len: 6 },
      ],
    });
    const r = check(sheetToDXF(sh), "guide.dxf");
    expect(r.version).toBe("AC1009");
    expect(r.errors).toEqual([]);
    expect(r.fixes).toBe(0);
    expect(r.insunits).toBe(4);
    expect(r.dims.length).toBe(sh.dims.filter((d) => d.dxf).length);
    const types = new Set(r.dims.map((d: { type: number }) => d.type));
    for (const t of [0, 1, 3, 4, 5, 6]) expect(types.has(t), `종류 ${t}`).toBe(true);
    expect(r.dims.every((d: { blockEntities: number }) => d.blockEntities > 0)).toBe(true);
    expect(r.dims.map((d: { text: string }) => d.text)).toContain("(17)");
    expect(r.dims.some((d: { text: string }) => d.text.endsWith("±0.1") || d.text.endsWith("%%p0.1"))).toBe(true);
    // 지시선(구멍 지시)은 글자로
    expect(r.texts.some((t: string) => t.includes("탭 깊이 12"))).toBe(true);
  });

  it.skipIf(!HAS)("inch 부품: $INSUNITS = 1, 치수도 inch 글자", () => {
    const p = structuredClone(SAMPLES.find((s) => s.name.includes("가이드"))!);
    applyExpressions(p);
    convertProjectUnit(p, "inch");
    applyExpressions(p);
    const r = check(sheetToDXF(buildSheet(buildAll(p).result, p)), "guide-inch.dxf");
    expect(r.errors).toEqual([]);
    expect(r.insunits).toBe(1);
    expect(r.dims.map((d: { text: string }) => d.text)).toContain("3.15");
  });
});
