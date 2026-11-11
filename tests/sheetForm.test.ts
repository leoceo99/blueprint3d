// 14.6: 표제란 양식·장 번호, 부품표, 구멍 피처 규격 → 도면 구멍 지시
import { beforeAll, describe, expect, it } from "vitest";
import opencascade from "replicad-opencascadejs";
import { setOC } from "replicad";
import { buildAllPart } from "../src/core/featureBuild";
import { bomRows, buildSheet, titleRows } from "../src/core/sheet";
import { docFromProject } from "../src/core/document";
import type { Feature } from "../src/core/featureModel";
import { emptyProject, type Project } from "../src/core/types";

beforeAll(async () => {
  setOC(await (opencascade as any)());
}, 60_000);

/** 40×40×20 블록 + 윗면에 구멍 피처 */
function block(holes: (top: any) => Feature[]): Project {
  const p = emptyProject();
  p.name = "블록";
  p.features = [
    { id: "s1", name: "s1", kind: "sketch", plane: { kind: "base", base: "XY", offset: 0 }, shapes: [{ id: "r", kind: "rect", hole: false, x: 0, y: 0, w: 40, h: 40 }] },
    { id: "e1", name: "e", kind: "extrude", sketch: "s1", op: "add", extent: "dist", dist: 20 },
  ];
  const top = buildAllPart(p).result.topo!.faces.find((f) => f.n?.[2] === 1)!;
  p.features.push(...holes(top));
  return p;
}
const circle = (id: string, cx: number, cy: number) => ({ id, kind: "circle" as const, hole: false, cx, cy, r: 1 });

describe("구멍 피처 규격을 구멍 지시에 (14.6)", () => {
  it("카운터보어 관통 2개 + 탭 1개 → 규격 지시 두 줄 (원통을 따로 지시하지 않음)", () => {
    const p = block((top) => [
      { id: "s2", name: "s2", kind: "sketch", plane: { kind: "face", face: top, offset: 0 }, shapes: [circle("a", 10, 10), circle("b", 30, 30)] },
      { id: "h1", name: "구멍", kind: "hole", sketch: "s2", spec: { size: "M6", purpose: "clearance-normal", head: "counterbore", cbDiameter: 11, cbDepth: 6.5 }, d: 6.6, depth: null },
      { id: "s3", name: "s3", kind: "sketch", plane: { kind: "face", face: top, offset: 0 }, shapes: [circle("c", 30, 10)] },
      { id: "h2", name: "탭", kind: "hole", sketch: "s3", spec: { size: "M5", purpose: "tap", head: "none" }, d: 4.2, depth: 12 },
    ]);
    const { result } = buildAllPart(p);
    expect(result.specHoles).toHaveLength(3);
    const texts = buildSheet(result, p).dims.filter((d) => d.def.kind === "leader").map((d) => d.text);
    expect(texts).toContain("2×M6 관통구멍 Ø6.6 관통 · 카운터보어 Ø11 깊이 6.5");
    expect(texts).toContain("M5 탭 깊이 12");
    expect(texts.some((t) => /^(2×)?Ø11 구멍/.test(t) || /Ø4\.2 구멍/.test(t))).toBe(false);
  });

  it("패턴으로 늘린 구멍도 규격으로 (4×)", () => {
    const p = block((top) => [
      { id: "s2", name: "s2", kind: "sketch", plane: { kind: "face", face: top, offset: 0 }, shapes: [circle("a", 8, 8)] },
      { id: "h1", name: "구멍", kind: "hole", sketch: "s2", spec: { size: "M4", purpose: "tap", head: "none" }, d: 3.3, depth: 8 },
      { id: "pt", name: "패턴", kind: "pattern", mode: "linear", of: ["h1"], axis: "X", count: 4, spacing: 8, angle: 360 },
    ]);
    const { result } = buildAllPart(p);
    expect(result.specHoles).toHaveLength(4);
    const texts = buildSheet(result, p).dims.map((d) => d.text);
    expect(texts).toContain("4×M4 탭 깊이 8");
  });
});

describe("표제란·장 번호·부품표 (14.6)", () => {
  const p = emptyProject();
  p.name = "축";
  it("기본 양식 3줄: 부품명·도면 번호·척도·장", () => {
    const rows = titleRows(p, { dwgNo: "B3D-001" }, "1:1", "A4", { sheetNo: { n: 2, of: 3 } });
    expect(rows).toHaveLength(3);
    expect(rows[0].map((c) => c.value)).toEqual(["축", "B3D-001", "1:1 · A4", "2 / 3"]);
    for (const r of rows) expect(r.reduce((a, c) => a + c.w, 0)).toBe(180);
  });

  it("상세 양식 4줄: 회사·개정·검도·승인·무게", () => {
    const rows = titleRows(p, { template: "full", company: "도면3D", rev: "A", checkedBy: "김", approvedBy: "이", date: "2026-11-11" }, "1:2", "A3", { sheetNo: { n: 1, of: 1 }, mass: "12.3 g" });
    expect(rows).toHaveLength(4);
    const all = rows.flat();
    const val = (l: string) => all.find((c) => c.label === l)?.value;
    expect([val("회사"), val("개정"), val("검도"), val("승인"), val("날짜"), val("무게"), val("장")]).toEqual(["도면3D", "A", "김", "이", "2026-11-11", "12.3 g", "1 / 1"]);
    for (const r of rows) expect(r.reduce((a, c) => a + c.w, 0)).toBe(180);
  });

  it("부품표 줄: 부품 차례, 재질(도면 → 부품), 수량, 무게(부피 × 밀도)", () => {
    const a = emptyProject();
    a.name = "판";
    a.material = "al6061";
    const doc = docFromProject(a);
    const b = { ...emptyProject(), id: "p2", name: "볼트", material: "steel" as const };
    doc.parts.push(b as any);
    doc.drawings.push({ id: "d2", name: "도면 2", partId: "p2", sheet: { qty: "4", material: "SCM435" } });
    const rows = bomRows(doc, (id) => (id === "part1" ? 10000 : undefined));
    expect(rows).toEqual([
      { name: "판", material: "A6061-T6", qty: "1", mass: "27.00 g" },
      { name: "볼트", material: "SCM435", qty: "4", mass: "—" },
    ]);
  });

  it("도면에 부품표를 넣으면 표제란 위에 표, 그림 영역은 그만큼 위로", () => {
    const q = block(() => []);
    const { result } = buildAllPart(q);
    const plain = buildSheet(result, q, {}, { sheetNo: { n: 1, of: 2 } });
    const withBom = buildSheet(result, { ...q, sheet: { bom: "on" } }, {}, { sheetNo: { n: 1, of: 2 }, bom: [{ name: "블록", material: "—", qty: "1", mass: "—" }, { name: "덮개", material: "ABS", qty: "2", mass: "3.00 g" }] });
    const tx = withBom.texts.map((t) => t.text);
    expect(tx).toContain("부품명");
    expect(tx).toContain("덮개");
    expect(tx).toContain("1 / 2");
    expect(plain.texts.map((t) => t.text)).not.toContain("덮개");
    // 3각법 기호 (원 두 개)
    expect(plain.prims.filter((x) => x.layer === "FRAME" && x.t === "arc")).toHaveLength(2);
    // 정면도는 부품표 띠(34 + 3×7 = 55) 위에
    expect(withBom.views.front.box[1]).toBeGreaterThanOrEqual(10 + 55 - 1e-6);
  });
});
