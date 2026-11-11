/**
 * 도면 → PDF (14.7): 선·원호·글자를 벡터 그대로, 실제 용지 크기(mm)로. 도면 여러 장 → 한 파일 여러 쪽.
 *
 * 글꼴은 파일에 넣지 않는다 (파일이 작고 글자 검색이 됨):
 *   - 영문·숫자·기호(Ø ± ° × ·): PDF 표준 14 글꼴 Helvetica (WinAnsi) — 모든 PDF 보기 프로그램에 들어 있음
 *   - 한글 등: Adobe-Korea1 표준 한글 글꼴 HYGoThic-Medium + UniKS-UCS2-H (아크로뱃·크롬·엣지·맥 미리보기·pdf.js가 그림)
 * 한 줄 글자를 둘로 나눠(run) 이어 쓴다. 글자 폭은 Helvetica AFM 값과 한글 전각(1em)으로 계산해 가운데·오른쪽 맞춤.
 * 레이어(외형선·숨은선·중심선·치수·해칭·테두리·글자)는 PDF 레이어(선택 내용 그룹)로 — 아크로뱃에서 켜고 끌 수 있다.
 */
import type { Layer, Prim, Pt, SheetText } from "./sheetDims";

export interface PdfPage {
  /** 용지 (mm) */
  width: number;
  height: number;
  prims: Prim[];
  texts: SheetText[];
}

/** 레이어 선 모양 (mm) — 도면 SVG와 같은 값 */
export type LayerStyle = Record<Layer, { w: number; dash?: string }>;

const MM = 72 / 25.4;

/** Helvetica 글자 폭 (1/1000 em, Adobe AFM) — 32~126 */
const HELV = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667,
  611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222,
  500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];
/** WinAnsi에서 쓰는 기호 (유니코드 → 바이트, 폭) */
const WIN: Record<number, [number, number]> = {
  0xd8: [0xd8, 778], // Ø
  0xf8: [0xf8, 611], // ø
  0x2300: [0xd8, 778], // ⌀ → Ø
  0xb0: [0xb0, 400], // °
  0xb1: [0xb1, 584], // ±
  0xd7: [0xd7, 584], // ×
  0xb7: [0xb7, 278], // ·
  0xb5: [0xb5, 556], // µ
  0xb2: [0xb2, 333], // ²
  0xb3: [0xb3, 333], // ³
  0x2212: [0x2d, 333], // − → -
  0x2013: [0x96, 556], // –
  0x2014: [0x97, 1000], // —
  0x2026: [0x85, 1000], // …
  0x2018: [0x91, 222],
  0x2019: [0x92, 222],
  0x201c: [0x93, 333],
  0x201d: [0x94, 333],
};

/** 글자 하나 → Helvetica 바이트·폭, 없으면 null (한글 글꼴로) */
function winAnsi(cp: number): [number, number] | null {
  if (cp >= 32 && cp <= 126) return [cp, HELV[cp - 32]];
  return WIN[cp] ?? null;
}

/** 한글 글꼴 안의 공백 폭 (CID 1, /W로 지정) = Helvetica 공백 */
const SPACE_EM = 0.278;

interface Run {
  font: "F1" | "F2";
  /** PDF 문자열 (괄호 또는 <16진>) */
  str: string;
  /** 폭 (em) */
  em: number;
}

/** 한 줄 글자를 Helvetica 부분과 한글 부분으로 */
export function textRuns(s: string): Run[] {
  const out: Run[] = [];
  let cur: { font: "F1" | "F2"; parts: string[]; em: number } | null = null;
  const flush = () => {
    if (!cur) return;
    out.push({ font: cur.font, str: cur.font === "F1" ? `(${cur.parts.join("")})` : `<${cur.parts.join("")}>`, em: cur.em });
    cur = null;
  };
  const chars = [...s];
  const isKor = (c: string | undefined) => !!c && c !== " " && !winAnsi(c.codePointAt(0)!);
  chars.forEach((ch, i) => {
    const cp = ch.codePointAt(0)!;
    // 한글 단어 사이 공백은 한글 글꼴로 (글자 뽑기·검색에서 “작은 판”이 한 덩어리) — 폭은 /W로 Helvetica 공백과 같게
    if (ch === " " && cur?.font === "F2" && isKor(chars.slice(i + 1).find((c) => c !== " "))) {
      cur.parts.push("0020");
      cur.em += SPACE_EM;
      return;
    }
    const w = winAnsi(cp);
    const font = w ? "F1" : "F2";
    if (!cur || cur.font !== font) {
      flush();
      cur = { font, parts: [], em: 0 };
    }
    if (w) {
      const b = w[0];
      cur.parts.push(b === 0x28 || b === 0x29 || b === 0x5c ? `\\${String.fromCharCode(b)}` : b < 128 ? String.fromCharCode(b) : `\\${b.toString(8).padStart(3, "0")}`);
      cur.em += w[1] / 1000;
    } else {
      // UCS-2 (BMP 밖 글자는 ?로)
      const u = cp > 0xffff ? 0x3f : cp;
      cur.parts.push(u.toString(16).toUpperCase().padStart(4, "0"));
      cur.em += 1;
    }
  });
  flush();
  return out;
}

/** 글자 폭 (mm) */
export const pdfTextWidth = (s: string, size: number) => textRuns(s).reduce((a, r) => a + r.em, 0) * size;

const f = (x: number) => {
  const v = Math.round(x * 1000) / 1000;
  return Object.is(v, -0) ? "0" : String(v);
};

/** 원호 → 3차 베지어 (90° 이하 조각) */
function arcPath(c: Pt, r: number, startDeg: number, endDeg: number): string {
  let sweep = endDeg - startDeg;
  while (sweep <= 0) sweep += 360;
  if (sweep > 360) sweep = 360;
  const n = Math.max(1, Math.ceil(sweep / 90 - 1e-9));
  const da = ((sweep / n) * Math.PI) / 180;
  const k = (4 / 3) * Math.tan(da / 4);
  let a = (startDeg * Math.PI) / 180;
  let out = `${f(c[0] + r * Math.cos(a))} ${f(c[1] + r * Math.sin(a))} m `;
  for (let i = 0; i < n; i++) {
    const b = a + da;
    const p0: Pt = [c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)];
    const p3: Pt = [c[0] + r * Math.cos(b), c[1] + r * Math.sin(b)];
    const p1: Pt = [p0[0] - k * r * Math.sin(a), p0[1] + k * r * Math.cos(a)];
    const p2: Pt = [p3[0] + k * r * Math.sin(b), p3[1] - k * r * Math.cos(b)];
    out += `${f(p1[0])} ${f(p1[1])} ${f(p2[0])} ${f(p2[1])} ${f(p3[0])} ${f(p3[1])} c `;
    a = b;
  }
  return out;
}

const LAYER_ORDER: Layer[] = ["FRAME", "HATCH", "DIM", "CENTER", "HIDDEN", "VISIBLE"];
const LAYER_NAME: Record<Layer | "TEXT", string> = { VISIBLE: "외형선", HIDDEN: "숨은선", CENTER: "중심선", DIM: "치수", FRAME: "테두리", HATCH: "해칭", TEXT: "글자" };

/** 한 쪽의 그리기 명령 (단위 mm, y 위쪽) */
export function pageContent(pg: PdfPage, style: LayerStyle): string {
  const out: string[] = [`q ${f(MM)} 0 0 ${f(MM)} 0 0 cm 1 J 1 j 0 G 0 g`];
  const by: Record<Layer, string[]> = { VISIBLE: [], HIDDEN: [], CENTER: [], DIM: [], FRAME: [], HATCH: [] };
  const fills: Record<Layer, string[]> = { VISIBLE: [], HIDDEN: [], CENTER: [], DIM: [], FRAME: [], HATCH: [] };
  for (const p of pg.prims) {
    if (p.t === "line") by[p.layer].push(`${f(p.a[0])} ${f(p.a[1])} m ${f(p.b[0])} ${f(p.b[1])} l`);
    else if (p.t === "arc") by[p.layer].push(arcPath(p.c, p.r, p.start, p.end));
    else fills[p.layer].push(p.pts.map((q, i) => `${f(q[0])} ${f(q[1])} ${i ? "l" : "m"}`).join(" ") + " h");
  }
  for (const layer of LAYER_ORDER) {
    if (!by[layer].length && !fills[layer].length) continue;
    const st = style[layer];
    out.push(`/OC /${layer} BDC`);
    if (by[layer].length) {
      out.push(`${f(st.w)} w [${st.dash ? st.dash.split(/[\s,]+/).map(Number).map(f).join(" ") : ""}] 0 d`);
      out.push(by[layer].join(" ") + " S");
    }
    if (fills[layer].length) out.push(fills[layer].join(" ") + " f");
    out.push("EMC");
  }
  if (pg.texts.length) {
    out.push("/OC /TEXT BDC BT");
    for (const t of pg.texts) {
      const runs = textRuns(t.text);
      const w = runs.reduce((a, r) => a + r.em, 0) * t.size;
      const dx = t.anchor === "middle" ? -w / 2 : t.anchor === "end" ? -w : 0;
      const a = ((t.rotate ?? 0) * Math.PI) / 180;
      const [c, s] = [Math.cos(a), Math.sin(a)];
      // 맞춤만큼 글자 방향으로 당김
      const x = t.at[0] + dx * c;
      const y = t.at[1] + dx * s;
      out.push(`${f(c)} ${f(s)} ${f(-s)} ${f(c)} ${f(x)} ${f(y)} Tm`);
      // 굵은 글자: 채우고 테두리도 (글꼴을 하나 더 쓰지 않음)
      out.push(t.bold ? `2 Tr ${f(t.size * 0.035)} w` : "0 Tr");
      for (const r of runs) out.push(`/${r.font} ${f(t.size)} Tf ${r.str} Tj`);
    }
    out.push("ET EMC");
  }
  out.push("Q");
  return out.join("\n");
}

const enc = new TextEncoder();

/** zlib 압축 (브라우저·Node의 CompressionStream). 없으면 압축 안 함 */
async function deflate(data: Uint8Array): Promise<Uint8Array | null> {
  const CS = (globalThis as { CompressionStream?: new (f: string) => TransformStream<Uint8Array, Uint8Array> }).CompressionStream;
  if (!CS) return null;
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new CS("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** UTF-16BE 16진 문자열 (문서 정보의 한글 제목) */
const utf16 = (s: string) => {
  let h = "FEFF";
  for (let i = 0; i < s.length; i++) h += s.charCodeAt(i).toString(16).toUpperCase().padStart(4, "0");
  return `<${h}>`;
};

/** 여러 쪽 PDF 만들기 */
export async function makePDF(pages: PdfPage[], style: LayerStyle, meta: { title?: string; compress?: boolean } = {}): Promise<Uint8Array> {
  const objs: (Uint8Array | string)[] = [];
  /** 객체 번호 미리 잡기 (1부터) */
  const alloc = () => objs.push("") as number;
  const set = (n: number, body: string | Uint8Array) => (objs[n - 1] = body);
  const stream = async (dict: string, text: string): Promise<Uint8Array> => {
    const raw = enc.encode(text);
    const z = meta.compress === false ? null : await deflate(raw);
    const data = z ?? raw;
    const head = enc.encode(`<< ${dict}${z ? " /Filter /FlateDecode" : ""} /Length ${data.length} >>\nstream\n`);
    const tail = enc.encode("\nendstream");
    const out = new Uint8Array(head.length + data.length + tail.length);
    out.set(head, 0);
    out.set(data, head.length);
    out.set(tail, head.length + data.length);
    return out;
  };

  const catalog = alloc();
  const pagesObj = alloc();
  const info = alloc();
  const helv = alloc();
  const kor = alloc();
  const korCid = alloc();
  const korDesc = alloc();
  set(helv, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  set(kor, `<< /Type /Font /Subtype /Type0 /BaseFont /HYGoThic-Medium-UniKS-UCS2-H /Encoding /UniKS-UCS2-H /DescendantFonts [${korCid} 0 R] >>`);
  set(korCid, `<< /Type /Font /Subtype /CIDFontType0 /BaseFont /HYGoThic-Medium /CIDSystemInfo << /Registry (Adobe) /Ordering (Korea1) /Supplement 1 >> /FontDescriptor ${korDesc} 0 R /DW 1000 /W [1 [${SPACE_EM * 1000}]] >>`);
  set(korDesc, "<< /Type /FontDescriptor /FontName /HYGoThic-Medium /Flags 4 /FontBBox [-6 -145 1003 880] /ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 880 /StemV 93 >>");
  // 레이어 (선택 내용 그룹)
  const layers = [...LAYER_ORDER, "TEXT"] as (Layer | "TEXT")[];
  const ocg: Record<string, number> = {};
  for (const l of layers) {
    ocg[l] = alloc();
    set(ocg[l], `<< /Type /OCG /Name ${utf16(LAYER_NAME[l])} >>`);
  }
  const ocRefs = layers.map((l) => `${ocg[l]} 0 R`).join(" ");
  const props = `<< ${layers.map((l) => `/${l} ${ocg[l]} 0 R`).join(" ")} >>`;
  const kids: number[] = [];
  for (const pg of pages) {
    const page = alloc();
    const content = alloc();
    kids.push(page);
    set(
      page,
      `<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${f(pg.width * MM)} ${f(pg.height * MM)}] /Resources << /Font << /F1 ${helv} 0 R /F2 ${kor} 0 R >> /Properties ${props} >> /Contents ${content} 0 R >>`,
    );
    set(content, await stream("", pageContent(pg, style)));
  }
  set(pagesObj, `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`);
  set(catalog, `<< /Type /Catalog /Pages ${pagesObj} 0 R /OCProperties << /OCGs [${ocRefs}] /D << /Order [${ocRefs}] /ON [${ocRefs}] >> >> >>`);
  const d = new Date();
  const p2 = (n: number) => String(n).padStart(2, "0");
  const date = `D:${d.getUTCFullYear()}${p2(d.getUTCMonth() + 1)}${p2(d.getUTCDate())}${p2(d.getUTCHours())}${p2(d.getUTCMinutes())}${p2(d.getUTCSeconds())}Z`;
  set(info, `<< /Title ${utf16(meta.title ?? "도면")} /Producer ${utf16("도면3D")} /CreationDate (${date}) >>`);

  // 이어 붙이고 xref
  const chunks: Uint8Array[] = [];
  let pos = 0;
  const push = (b: Uint8Array | string) => {
    const u = typeof b === "string" ? enc.encode(b) : b;
    chunks.push(u);
    pos += u.length;
  };
  push("%PDF-1.7\n");
  push(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(pos);
    push(`${i + 1} 0 obj\n`);
    push(o);
    push("\nendobj\n");
  });
  const xref = pos;
  push(`xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`);
  push(`trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  const out = new Uint8Array(pos);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}
