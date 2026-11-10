/**
 * 저장된 도면 치수 정리 (11단계) — 문서를 열 때 쓰므로 가볍게 따로 둔다 (치수 그리기 코드는 도면 화면에서만).
 */
import type { Pt, SheetDim } from "./sheetDims";
import type { ViewId } from "./types";

/** 저장된 치수 정리 (열 때): 모양이 맞지 않는 것은 버린다 */
export function normalizeDims(raw: unknown): SheetDim[] {
  if (!Array.isArray(raw)) return [];
  const pt = (p: unknown): p is Pt => Array.isArray(p) && p.length === 2 && p.every((x) => typeof x === "number" && Number.isFinite(x));
  const num = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
  const views = ["front", "top", "side"];
  const out: SheetDim[] = [];
  for (const d of raw as Record<string, unknown>[]) {
    if (!d || typeof d !== "object" || typeof d.id !== "string" || !views.includes(d.view as string)) continue;
    const base = { id: d.id, view: d.view as ViewId, ...(typeof d.text === "string" && d.text ? { text: d.text } : {}), ...(typeof d.suffix === "string" && d.suffix ? { suffix: d.suffix } : {}) };
    if (d.kind === "linear" && (d.dir === "h" || d.dir === "v" || d.dir === "aligned") && pt(d.a) && pt(d.b) && num(d.off)) out.push({ ...base, kind: "linear", dir: d.dir, a: d.a, b: d.b, off: d.off });
    else if (d.kind === "ordinate" && (d.axis === "u" || d.axis === "v") && pt(d.origin) && pt(d.p) && num(d.line))
      out.push({ ...base, kind: "ordinate", axis: d.axis, origin: d.origin, p: d.p, line: d.line, ...(num(d.jog) ? { jog: d.jog } : {}) });
    else if ((d.kind === "diameter" || d.kind === "radius") && pt(d.c) && num(d.r) && d.r > 0 && num(d.ang) && num(d.len))
      out.push({ ...base, kind: d.kind, c: d.c, r: d.r, ang: d.ang, len: d.len, ...(num(d.count) ? { count: d.count } : {}) });
    else if (d.kind === "angle" && pt(d.o) && pt(d.a) && pt(d.b) && num(d.rad)) out.push({ ...base, kind: "angle", o: d.o, a: d.a, b: d.b, rad: d.rad });
    else if (d.kind === "leader" && pt(d.tip) && pt(d.knee) && typeof d.text === "string") out.push({ ...base, kind: "leader", tip: d.tip, knee: d.knee, text: d.text });
  }
  return out;
}
