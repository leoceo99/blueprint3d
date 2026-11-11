/**
 * 도면 추가 뷰(14단계)의 저장 값 정리와 다음 문자 — 문서를 열 때 쓰므로 가볍게 따로 둔다
 * (단면·해칭·원 자르기 계산은 sheetViews.ts, 도면 화면에서만).
 */
import type { DrawingView } from "./sheetViews";
import type { Pt } from "./sheetDims";
import { VIEW_IDS, type ViewId } from "./types";

/** 다음 뷰 문자 (A, B, C … — 이미 쓴 것은 건너뜀, I·O 빼고) */
export function nextLabel(views: DrawingView[] = []): string {
  const used = new Set(views.map((v) => v.label));
  for (const c of "ABCDEFGHJKLMNPQRSTUVWXYZ") if (!used.has(c)) return c;
  return `Z${views.length}`;
}

const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const pt = (v: unknown): v is Pt => Array.isArray(v) && v.length === 2 && v.every(num);
const obj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isView = (v: unknown): v is ViewId => (VIEW_IDS as unknown[]).includes(v);

export function normalizeViews(raw: unknown): DrawingView[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: DrawingView[] = [];
  const ids = new Set<string>();
  for (const r of raw) {
    if (!obj(r) || typeof r.id !== "string" || !r.id || ids.has(r.id)) continue;
    const label = typeof r.label === "string" && r.label ? r.label.slice(0, 4) : nextLabel(out);
    const at = pt(r.at) ? { at: r.at } : {};
    let v: DrawingView | null = null;
    if ((r.kind === "section" || r.kind === "aux") && isView(r.parent) && pt(r.a) && pt(r.b) && Math.hypot(r.b[0] - r.a[0], r.b[1] - r.a[1]) > 1e-6)
      v = { id: r.id, kind: r.kind, parent: r.parent, a: r.a, b: r.b, label, ...(r.flip === true ? { flip: true } : {}), ...at };
    else if (r.kind === "detail" && typeof r.parent === "string" && pt(r.c) && num(r.r) && r.r > 0)
      v = { id: r.id, kind: "detail", parent: r.parent, c: r.c, r: r.r, k: num(r.k) && r.k > 0 ? r.k : 2, label, ...at };
    else if (r.kind === "iso") v = { id: r.id, kind: "iso", label, ...at };
    if (v) {
      ids.add(v.id);
      out.push(v);
    }
  }
  return out.length ? out : undefined;
}

