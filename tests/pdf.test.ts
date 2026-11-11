// 14.7: 도면 → PDF (벡터) — pdf.js로 다시 읽어 쪽 수·용지 크기·글자(한글·영문·기호) 확인
import { beforeAll, describe, expect, it } from "vitest";
import opencascade from "replicad-opencascadejs";
import { setOC } from "replicad";
import { fileURLToPath } from "node:url";
import { buildAllPart } from "../src/core/featureBuild";
import { buildSheet, sheetsToPDF } from "../src/core/sheet";
import { makePDF, pdfTextWidth, textRuns } from "../src/core/pdf";
import { emptyProject, type Project } from "../src/core/types";

beforeAll(async () => {
  setOC(await (opencascade as any)());
}, 60_000);

const CMAPS = fileURLToPath(new URL("../node_modules/pdfjs-dist/cmaps/", import.meta.url));
const FONTS = fileURLToPath(new URL("../node_modules/pdfjs-dist/standard_fonts/", import.meta.url));

async function readPDF(bytes: Uint8Array) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data: bytes.slice(), cMapUrl: CMAPS, cMapPacked: true, standardFontDataUrl: FONTS, useSystemFonts: false }).promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const pg = await doc.getPage(i);
    const tc = await pg.getTextContent();
    const vp = pg.getViewport({ scale: 1 });
    const ops = await pg.getOperatorList();
    pages.push({ w: vp.width, h: vp.height, text: tc.items.map((x: any) => x.str).join(""), ops: ops.fnArray.length });
  }
  return { n: doc.numPages, pages };
}

function plate(name: string, w: number): Project {
  const p = emptyProject();
  p.name = name;
  p.features = [
    { id: "s1", name: "s1", kind: "sketch", plane: { kind: "base", base: "XY", offset: 0 }, shapes: [{ id: "r", kind: "rect", hole: false, x: 0, y: 0, w, h: 40 }, { id: "c", kind: "circle", hole: true, cx: 20, cy: 20, r: 5 }] },
    { id: "e1", name: "e", kind: "extrude", sketch: "s1", op: "add", extent: "dist", dist: 10 },
  ];
  return p;
}

describe("PDF 글자 (14.7)", () => {
  it("영문·기호는 Helvetica, 한글은 한글 글꼴로 나눔", () => {
    const r = textRuns("Ø20 H7 구멍 ±0.1");
    expect(r.map((x) => x.font)).toEqual(["F1", "F2", "F1"]);
    expect(r[0].str).toBe("(\\33020 H7 )");
    expect(r[1].str).toBe("<AD6CBA4D>");
    // 한글 단어 사이 공백은 한글 글꼴 안에 (폭 0.278em)
    const k = textRuns("작은 판 Ø6");
    expect(k.map((x) => x.font)).toEqual(["F2", "F1"]);
    expect(k[0].str).toBe("<C791C7400020D310>");
    expect(k[0].em).toBeCloseTo(3.278, 9);
    // 폭: Ø(0.778) 2·0(0.556×2) 공백(0.278) H(0.722) 7(0.556) 공백(0.278) = 3.724em
    expect(r[0].em).toBeCloseTo(3.724, 6);
    expect(pdfTextWidth("가나", 3.5)).toBeCloseTo(7, 9);
    // 괄호·역슬래시는 이스케이프, 빼기(−)는 하이픈으로
    expect(textRuns("(a\\b)−1")[0].str).toBe("(\\(a\\\\b\\)-1)");
  });
});

describe("도면 → PDF (14.7)", () => {
  it("한 쪽: 용지 크기 그대로(mm → pt), 글자 다시 읽힘", async () => {
    const p = plate("받침판", 80);
    const { result } = buildAllPart(p);
    const sh = buildSheet(result, { ...p, sheet: { dwgNo: "B3D-001" } }, { dims: [{ id: "t", view: "front", kind: "linear", dir: "h", a: [0, 0], b: [80, 0], off: -12, tol: { kind: "fit", code: "h7" } }] });
    const bytes = await sheetsToPDF([sh], "받침판 도면");
    expect(new TextDecoder().decode(bytes.slice(0, 8))).toBe("%PDF-1.7");
    const r = await readPDF(bytes);
    expect(r.n).toBe(1);
    expect(r.pages[0].w).toBeCloseTo((sh.width * 72) / 25.4, 1);
    expect(r.pages[0].h).toBeCloseTo((sh.height * 72) / 25.4, 1);
    const t = r.pages[0].text;
    for (const s of ["정면도", "받침판", "B3D-001", "부품명", "KS B ISO 2768-m"]) expect(t).toContain(s);
    expect(t).toMatch(/80 h7 \(0\/-0\.03\)/);
    expect(r.pages[0].ops).toBeGreaterThan(50);
  });

  it("도면 여러 장 → 한 PDF 여러 쪽 (쪽마다 그 용지)", async () => {
    const a = plate("작은 판", 60);
    const b = plate("긴 판", 380);
    const sa = buildSheet(buildAllPart(a).result, a, {}, { sheetNo: { n: 1, of: 2 } });
    const sb = buildSheet(buildAllPart(b).result, b, {}, { sheetNo: { n: 2, of: 2 } });
    const r = await readPDF(await sheetsToPDF([sa, sb], "모든 도면"));
    expect(r.n).toBe(2);
    expect(r.pages[0].text).toContain("작은 판");
    expect(r.pages[1].text).toContain("긴 판");
    expect(r.pages[1].text).toContain("2 / 2");
    expect(r.pages[0].w).toBeCloseTo((sa.width * 72) / 25.4, 1);
    expect(r.pages[1].w).toBeCloseTo((sb.width * 72) / 25.4, 1);
  });

  it("압축하면 더 작음 (같은 내용)", async () => {
    const page = { width: 210, height: 297, prims: Array.from({ length: 400 }, (_, i) => ({ layer: "VISIBLE" as const, t: "line" as const, a: [i * 0.5, 0] as [number, number], b: [i * 0.5, 100] as [number, number] })), texts: [] };
    const style = { VISIBLE: { w: 0.5 }, HIDDEN: { w: 0.3, dash: "2.5 1.2" }, CENTER: { w: 0.2 }, DIM: { w: 0.18 }, FRAME: { w: 0.5 }, HATCH: { w: 0.15 } };
    const z = await makePDF([page], style);
    const raw = await makePDF([page], style, { compress: false });
    expect(z.length).toBeLessThan(raw.length / 2);
    expect((await readPDF(z)).n).toBe(1);
  });
});
