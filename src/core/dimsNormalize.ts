/**
 * 저장된 도면 치수 정리 (11단계) — 문서를 열 때 쓰므로 가볍게 따로 둔다 (치수 그리기 코드는 도면 화면에서만).
 */
import type { DimTol, GdtSym, Pt, SheetDim } from "./sheetDims";

const GDT_SYMS: GdtSym[] = ["straight", "flat", "round", "cyl", "profLine", "profSurf", "perp", "angular", "parallel", "position", "concentric", "symmetry", "runout", "totalRunout"];

/** 저장된 공차 정리 — 모양이 틀리면 undefined */
export function cleanTol(t: unknown): DimTol | undefined {
  if (!t || typeof t !== "object") return undefined;
  const o = t as Record<string, unknown>;
  const num = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x) && Math.abs(x) < 1e3;
  if (o.kind === "sym" && num(o.v) && o.v > 0) return { kind: "sym", v: o.v };
  if (o.kind === "dev" && num(o.up) && num(o.lo) && o.up >= o.lo) return { kind: "dev", up: o.up, lo: o.lo };
  if (o.kind === "fit" && typeof o.code === "string" && /^(js|JS|[a-zA-Z])\d{1,2}$/.test(o.code.trim())) return { kind: "fit", code: o.code.trim() };
  return undefined;
}

/** 저장된 치수 정리 (열 때): 모양이 맞지 않는 것은 버린다 */
export function normalizeDims(raw: unknown): SheetDim[] {
  if (!Array.isArray(raw)) return [];
  const pt = (p: unknown): p is Pt => Array.isArray(p) && p.length === 2 && p.every((x) => typeof x === "number" && Number.isFinite(x));
  const num = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
  const str = (x: unknown, max = 40): x is string => typeof x === "string" && x.length > 0 && x.length <= max;
  const out: SheetDim[] = [];
  for (const d of raw as Record<string, unknown>[]) {
    // 뷰: 기본 3면 또는 추가 뷰 id (14단계) — 그 뷰가 지워졌으면 도면에서 안 그려질 뿐
    if (!d || typeof d !== "object" || typeof d.id !== "string" || !str(d.view, 64)) continue;
    const tol = cleanTol(d.tol);
    const base = {
      id: d.id,
      view: d.view,
      ...(typeof d.text === "string" && d.text ? { text: d.text } : {}),
      ...(typeof d.suffix === "string" && d.suffix ? { suffix: d.suffix } : {}),
      ...(tol ? { tol } : {}),
    };
    if (d.kind === "linear" && (d.dir === "h" || d.dir === "v" || d.dir === "aligned") && pt(d.a) && pt(d.b) && num(d.off)) out.push({ ...base, kind: "linear", dir: d.dir, a: d.a, b: d.b, off: d.off });
    else if (d.kind === "ordinate" && (d.axis === "u" || d.axis === "v") && pt(d.origin) && pt(d.p) && num(d.line))
      out.push({ ...base, kind: "ordinate", axis: d.axis, origin: d.origin, p: d.p, line: d.line, ...(num(d.jog) ? { jog: d.jog } : {}) });
    else if ((d.kind === "diameter" || d.kind === "radius") && pt(d.c) && num(d.r) && d.r > 0 && num(d.ang) && num(d.len))
      out.push({ ...base, kind: d.kind, c: d.c, r: d.r, ang: d.ang, len: d.len, ...(num(d.count) ? { count: d.count } : {}) });
    else if (d.kind === "angle" && pt(d.o) && pt(d.a) && pt(d.b) && num(d.rad)) out.push({ ...base, kind: "angle", o: d.o, a: d.a, b: d.b, rad: d.rad });
    else if (d.kind === "leader" && pt(d.tip) && pt(d.knee) && typeof d.text === "string") out.push({ ...base, kind: "leader", tip: d.tip, knee: d.knee, text: d.text });
    else if (d.kind === "rough" && pt(d.tip) && pt(d.knee) && str(d.ra, 12))
      out.push({ id: d.id, view: d.view, kind: "rough", tip: d.tip, knee: d.knee, ra: d.ra, ...(d.mode === "remove" || d.mode === "keep" ? { mode: d.mode } : {}) });
    else if (d.kind === "gdt" && pt(d.tip) && pt(d.knee) && GDT_SYMS.includes(d.sym as GdtSym) && typeof d.value === "string") {
      const datums = Array.isArray(d.datums) ? d.datums.filter((x): x is string => str(x, 4)).slice(0, 3) : [];
      out.push({ id: d.id, view: d.view, kind: "gdt", tip: d.tip, knee: d.knee, sym: d.sym as GdtSym, value: d.value.slice(0, 16), ...(d.dia === true ? { dia: true } : {}), ...(datums.length ? { datums } : {}) });
    } else if (d.kind === "datum" && pt(d.tip) && pt(d.knee) && str(d.label, 4)) out.push({ id: d.id, view: d.view, kind: "datum", tip: d.tip, knee: d.knee, label: d.label });
  }
  return out;
}
