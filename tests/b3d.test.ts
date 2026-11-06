// 9단계: .b3d 문서 파일 (zip) 왕복, 예전 .json 읽기, 크기
import { describe, expect, it } from "vitest";
import { unzipSync } from "fflate";
import { SAMPLES } from "../src/core/samples";
import { toBase64, toDataUrl } from "../src/core/bytes";
import { addPart, docFromProject } from "../src/core/document";
import { isZip, readB3d, readDocFile, readLegacyJson, writeB3d } from "../src/core/b3d";

// 작은 PNG (1×1)
const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196, 137, 0, 0, 0, 13, 73, 68, 65, 84, 120, 156, 99, 248, 15, 4, 0, 9, 251, 3, 253, 227, 85, 242, 156, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130]);
// STEP 파일처럼 반복이 많은 글자
const STEP = new TextEncoder().encode(Array.from({ length: 4000 }, (_, i) => `#${i}=CARTESIAN_POINT('',(${i * 0.5},0.,${i % 7}.));`).join("\n"));

function sampleDoc() {
  const doc = docFromProject(structuredClone(SAMPLES[0]));
  doc.drawings[0].sheet = { paper: "A3", material: "AL6061" };
  const p2 = addPart(doc, { ...structuredClone(SAMPLES[1]), name: "플랜지" });
  p2.source = { kind: "step", name: "f.step", key: "m1", turns: [1, 0, 0] };
  doc.parts[0].underlay = { key: "u1", w: 1, h: 1, mmPerPx: 0.5, views: { front: { ox: 0, oy: 0, crop: [0, 0, 1, 1] } } };
  return doc;
}

describe(".b3d 문서 파일", () => {
  it("저장 → 열기: 문서·화면 상태·파일·썸네일 그대로", () => {
    const doc = sampleDoc();
    const files = { m1: STEP.slice().buffer, u1: toDataUrl("image/png", PNG), unused: "data:image/png;base64,AAAA" };
    const bytes = writeB3d({ doc, files, thumbnail: PNG });
    expect(isZip(bytes)).toBe(true);
    const z = unzipSync(bytes);
    expect(Object.keys(z).sort()).toEqual(["document.json", "files.json", "files/m1", "files/u1", "thumbnail.jpg", "view.json"]);
    const back = readB3d(bytes);
    expect(back.doc).toEqual(doc);
    expect(new Uint8Array(back.files.m1 as ArrayBuffer)).toEqual(STEP);
    expect(back.files.u1).toBe(files.u1);
    expect(back.files.unused).toBeUndefined();
    expect(back.thumbnail).toEqual(PNG);
    expect(readDocFile(bytes).doc).toEqual(doc);
  });

  it("예전 .json 프로젝트(3D 파일·밑그림 포함)도 열림, .b3d가 더 작음", () => {
    const p: any = structuredClone(SAMPLES[0]);
    p.sheet = { scale: "1:2" };
    p.source = { kind: "step", name: "a.step", key: "mk", turns: [0, 0, 0], data: toBase64(STEP) };
    p.underlay = { key: "uk", w: 1, h: 1, mmPerPx: 1, views: {}, data: toDataUrl("image/png", PNG) };
    const text = JSON.stringify(p, null, 2);
    const r = readLegacyJson(text);
    expect(r.doc.parts).toHaveLength(1);
    expect(r.doc.drawings[0].sheet).toEqual({ scale: "1:2" });
    expect((r.doc.parts[0].source as any).data).toBeUndefined();
    expect(new Uint8Array(r.files.mk as ArrayBuffer)).toEqual(STEP);
    expect(r.files.uk).toBe(p.underlay.data);
    const b3d = writeB3d(r);
    expect(b3d.length).toBeLessThan(text.length / 4);
    // 내용으로 형식 알아보기
    expect(readDocFile(new TextEncoder().encode(text)).doc.parts[0].name).toBe(p.name);
  });

  it("깨진 파일·다른 파일은 알기 쉬운 오류", () => {
    expect(() => readB3d(new Uint8Array([0x50, 0x4b, 3, 4, 9, 9, 9]))).toThrow(/열 수 없습니다/);
    expect(() => readLegacyJson("{oops")).toThrow(/읽을 수 없습니다/);
    expect(() => readLegacyJson(JSON.stringify({ hello: 1 }))).toThrow(/읽을 수 없습니다/);
  });
});
