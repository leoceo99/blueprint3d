// 9단계: 문서 모델 (여러 부품·도면), 예전 프로젝트 변환, 정리
import { describe, expect, it } from "vitest";
import { SAMPLES } from "../src/core/samples";
import { emptyProject } from "../src/core/types";
import {
  activeDrawing,
  activePart,
  addDrawing,
  addPart,
  docDiff,
  docFileKeys,
  docFromProject,
  docSummary,
  drawingsOf,
  duplicatePart,
  normalizeDoc,
  removeDrawing,
  removePart,
  renamePart,
  setActivePart,
} from "../src/core/document";

const rect = (id: string) => ({ id, kind: "rect" as const, hole: false, x: 0, y: 0, w: 10, h: 10 });

describe("문서 모델", () => {
  it("예전 프로젝트 → 부품 1개 + 도면 1장 (도면 설정은 도면으로)", () => {
    const p = structuredClone(SAMPLES[0]);
    p.sheet = { paper: "A3", material: "SM45C" };
    const d = normalizeDoc(JSON.parse(JSON.stringify(p)))!;
    expect(d.version).toBe(2);
    expect(d.parts).toHaveLength(1);
    expect(d.parts[0].sheet).toBeUndefined();
    expect(d.drawings[0].sheet).toEqual({ paper: "A3", material: "SM45C" });
    expect(d.drawings[0].partId).toBe(d.parts[0].id);
    expect(activePart(d).name).toBe(p.name);
    expect(activeDrawing(d)?.id).toBe(d.drawings[0].id);
    expect(d.name).toBe(p.name);
    // 같은 프로젝트는 같은 문서로 (id가 정해져 있음)
    expect(docFromProject(p)).toEqual(docFromProject(p));
  });

  it("깨진 문서 정리: 겹친 id, 없는 부품을 참조하는 도면, 열린 부품이 없음", () => {
    const raw = {
      format: "blueprint3d",
      version: 2,
      name: "",
      parts: [
        { ...emptyProject(), id: "a", name: "A" },
        { ...emptyProject(), id: "a", name: "B" },
        { nonsense: true },
      ],
      drawings: [
        { id: "d1", name: "도면", partId: "a" },
        { id: "d2", name: "고아", partId: "zzz" },
        "x",
      ],
      view: { part: "nope", drawing: "d2" },
    };
    const d = normalizeDoc(raw)!;
    expect(d.parts.map((p) => p.name)).toEqual(["A", "B"]);
    expect(new Set(d.parts.map((p) => p.id)).size).toBe(2);
    expect(d.drawings.map((x) => x.id)).toEqual(["d1"]);
    expect(d.view.part).toBe("a");
    expect(d.view.drawing).toBe("d1");
    expect(d.name).toBe("A");
    expect(d.scenes).toEqual([]);
    expect(normalizeDoc({ parts: [] })).toBeNull();
    expect(normalizeDoc(null)).toBeNull();
  });

  it("부품 추가·복제·이름·삭제, 열린 부품과 도면이 따라감", () => {
    const d = docFromProject(SAMPLES[0]);
    const b = addPart(d);
    expect(b.name).toBe("부품 2");
    expect(d.view.part).toBe(b.id);
    expect(drawingsOf(d, b.id)).toHaveLength(1);
    expect(activeDrawing(d)!.partId).toBe(b.id);
    const c = addPart(d);
    expect(c.name).toBe("부품 3");
    renamePart(d, c.id, "  덮개 ");
    expect(c.name).toBe("덮개");
    const copy = duplicatePart(d, d.parts[0].id)!;
    expect(copy.name).toBe(`${SAMPLES[0].name} 복사본`);
    expect(copy.views).toEqual(SAMPLES[0].views);
    expect(copy.id).not.toBe(d.parts[0].id);
    expect(d.parts).toHaveLength(4);
    setActivePart(d, b.id);
    expect(removePart(d, b.id)).toBe(true);
    expect(d.view.part).not.toBe(b.id);
    expect(d.drawings.some((x) => x.partId === b.id)).toBe(false);
    // 마지막 부품은 지울 수 없음
    for (const p of [...d.parts].slice(1)) removePart(d, p.id);
    expect(removePart(d, d.parts[0].id)).toBe(false);
    expect(d.parts).toHaveLength(1);
  });

  it("도면 추가·삭제, 열린 도면 바로잡기", () => {
    const d = docFromProject(SAMPLES[0]);
    const pid = d.parts[0].id;
    const d2 = addDrawing(d, pid, { scale: "1:2" });
    expect(d.view.drawing).toBe(d2.id);
    expect(d.drawings).toHaveLength(2);
    expect(removeDrawing(d, d2.id)).toBe(true);
    expect(d.view.drawing).toBe(d.drawings[0].id);
    removeDrawing(d, d.drawings[0].id);
    expect(d.view.drawing).toBeUndefined();
    expect(activeDrawing(d)).toBeUndefined();
  });

  it("요약·비교·파일 키", () => {
    const d = docFromProject(SAMPLES[0]);
    expect(docSummary(d)).toMatch(/^도형 \d+/);
    const before = structuredClone(d);
    const p2 = addPart(d, { ...emptyProject(), name: "덮개", views: { front: [rect("x")], top: [], side: [] } });
    p2.source = { kind: "stl", name: "m.stl", key: "k1", turns: [0, 0, 0] };
    d.parts[0].underlay = { key: "u1", w: 10, h: 10, mmPerPx: 1, views: {} };
    expect(docSummary(d)).toMatch(/^부품 2 · 도면 2 · 도형 \d+$/);
    expect(docFileKeys(d).sort()).toEqual(["k1", "u1"]);
    const diff = docDiff(before, d);
    expect(diff).toContain("부품 추가: 덮개");
    expect(diff).toContain("도면 1장 바뀜");
    expect(docDiff(d, structuredClone(d))).toBe("바뀐 것 없음");
    const after = structuredClone(d);
    after.parts[0].views.front.push(rect("new"));
    expect(docDiff(d, after)).toContain(`${d.parts[0].name}: 도형 1개 추가`);
  });
});
