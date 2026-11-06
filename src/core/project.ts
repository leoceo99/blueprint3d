/**
 * 저장된 프로젝트(자동 저장, 열기 파일)를 검사해서 쓸 수 있는 모양으로 고친다.
 * 망가진 도형은 빼고, 빠진 값은 기본값으로 채운다. 프로젝트로 볼 수 없으면 null.
 */
import { VIEW_IDS, type Corner, type Param, type Project, type Shape2D, type SheetInfo, type ViewId } from "./types";

const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const pt = (v: unknown): v is [number, number] => Array.isArray(v) && v.length === 2 && num(v[0]) && num(v[1]);
const obj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

let seq = 0;
const freshId = () => `r${Date.now().toString(36)}${(seq++).toString(36)}`;

function corners(v: unknown): (Corner | null)[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return v.map((c) =>
    obj(c) && (c.kind === "fillet" || c.kind === "chamfer") && num(c.size) && c.size > 0 ? { kind: c.kind, size: c.size } : null,
  );
}

function exprs(v: unknown): Record<string, string> | undefined {
  if (!obj(v)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, e] of Object.entries(v)) if (typeof e === "string" && e.trim()) out[k] = e;
  return Object.keys(out).length ? out : undefined;
}

export function normalizeShape(raw: unknown): Shape2D | null {
  if (!obj(raw)) return null;
  // 꼭 있어야 하는 값 검사
  const valid =
    raw.kind === "rect"
      ? [raw.x, raw.y, raw.w, raw.h].every(num)
      : raw.kind === "circle"
        ? [raw.cx, raw.cy, raw.r].every(num)
        : raw.kind === "poly"
          ? Array.isArray(raw.pts) && raw.pts.length >= 2 && raw.pts.every(pt)
          : raw.kind === "slot"
            ? pt(raw.a) && pt(raw.b) && num(raw.w)
            : false;
  if (!valid) return null;
  // 원래 값과 순서는 그대로 두고, 잘못된 선택 값만 고친다
  const out: Record<string, unknown> = { ...raw };
  if (typeof out.id !== "string" || !out.id) out.id = freshId();
  out.hole = raw.hole === true;
  if ("depth" in out && !(num(out.depth) && out.depth > 0)) delete out.depth;
  if ("exprs" in out) {
    const e = exprs(out.exprs);
    if (e) out.exprs = e;
    else delete out.exprs;
  }
  if ("corners" in out) {
    const c = corners(out.corners);
    if (c) out.corners = c;
    else delete out.corners;
  }
  if (raw.kind === "poly" && "bulges" in out) {
    const pts = raw.pts as unknown[];
    if (Array.isArray(out.bulges)) out.bulges = pts.map((_, i) => (num((out.bulges as unknown[])[i]) ? (out.bulges as number[])[i] : 0));
    else delete out.bulges;
  }
  if ("spec" in out && !obj(out.spec)) delete out.spec;
  return out as unknown as Shape2D;
}

export function normalizeProject(raw: unknown): Project | null {
  if (!obj(raw) || raw.version !== 1 || !obj(raw.views)) return null;
  const views = {} as Record<ViewId, Shape2D[]>;
  for (const v of VIEW_IDS) {
    const list = (raw.views as Record<string, unknown>)[v];
    views[v] = Array.isArray(list) ? list.map(normalizeShape).filter((s): s is Shape2D => s !== null) : [];
  }
  const params: Param[] | undefined = Array.isArray(raw.params)
    ? raw.params.filter((x): x is Param => obj(x) && typeof x.name === "string" && typeof x.expr === "string")
    : undefined;
  const sheet: SheetInfo | undefined = obj(raw.sheet)
    ? (Object.fromEntries(Object.entries(raw.sheet).filter(([, x]) => typeof x === "string")) as SheetInfo)
    : undefined;
  // 원래 순서는 그대로 두고 값만 고친다
  const out: Record<string, unknown> = { ...raw, views };
  if (!(typeof raw.name === "string" && raw.name.trim())) out.name = "새 부품";
  out.mode = raw.mode === "revolve" ? "revolve" : "auto";
  if (!(raw.process === "cnc" || raw.process === "print3d" || raw.process === "laser")) delete out.process;
  if (!(num(raw.thickness) && raw.thickness > 0)) out.thickness = 10;
  if (!(typeof raw.thicknessExpr === "string" && raw.thicknessExpr.trim())) delete out.thicknessExpr;
  if (params?.length) out.params = params;
  else delete out.params;
  if (sheet && Object.keys(sheet).length) out.sheet = sheet;
  else delete out.sheet;
  return out as unknown as Project;
}
