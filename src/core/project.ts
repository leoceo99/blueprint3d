/**
 * 저장된 프로젝트(자동 저장, 열기 파일)를 검사해서 쓸 수 있는 모양으로 고친다.
 * 망가진 도형은 빼고, 빠진 값은 기본값으로 채운다. 프로젝트로 볼 수 없으면 null.
 */
import { VIEW_IDS, type Constraint, type ConsKind, type Corner, type Param, type Project, type Shape2D, type SheetInfo, type ViewId } from "./types";

import { pruneConstraints } from "./constraints";

const KINDS: ConsKind[] = ["coincident", "horizontal", "vertical", "parallel", "perpendicular", "equal", "concentric", "tangent", "symmetric", "onLine", "midpoint", "fix", "distance", "distanceX", "distanceY", "angle"];

/** 저장된 구속 검사 (모양만 — 대상이 실제로 있는지는 constraints.pruneConstraints가) */
function normalizeConstraints(raw: unknown): Project["constraints"] | undefined {
  if (!obj(raw)) return undefined;
  const out: Partial<Record<ViewId, Constraint[]>> = {};
  for (const v of VIEW_IDS) {
    const list = raw[v];
    if (!Array.isArray(list)) continue;
    const ok = list
      .filter((c): c is Record<string, unknown> => obj(c) && typeof c.id === "string" && KINDS.includes(c.kind as ConsKind) && Array.isArray(c.refs))
      .filter((c) => (c.refs as unknown[]).every((r) => obj(r) && typeof r.s === "string" && typeof r.k === "string"))
      .map((c) => {
        const k: Constraint = { id: c.id as string, kind: c.kind as ConsKind, refs: (c.refs as { s: string; k: string }[]).map((r) => ({ s: r.s, k: r.k })) };
        if (num(c.value)) k.value = c.value;
        if (typeof c.expr === "string" && c.expr.trim()) k.expr = c.expr;
        if (c.side === 1 || c.side === -1) k.side = c.side;
        if (pt(c.at)) k.at = c.at;
        return k;
      });
    if (ok.length) out[v] = ok;
  }
  return Object.keys(out).length ? out : undefined;
}

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
  const src = raw.source;
  if (
    !(
      obj(src) &&
      (src.kind === "step" || src.kind === "stl") &&
      typeof src.name === "string" &&
      typeof src.key === "string" &&
      Array.isArray(src.turns) &&
      src.turns.length === 3 &&
      src.turns.every((t) => Number.isInteger(t))
    )
  )
    delete out.source;
  const cons = normalizeConstraints(raw.constraints);
  if (cons) out.constraints = cons;
  else delete out.constraints;
  if (raw.units === "inch") out.units = "inch";
  else delete out.units;
  const u = raw.underlay;
  if (!(obj(u) && typeof u.key === "string" && num(u.w) && num(u.h) && num(u.mmPerPx) && u.mmPerPx > 0 && obj(u.views))) delete out.underlay;
  // 지운 도형을 가리키는 구속 등은 뺀다
  pruneConstraints(out as unknown as Project);
  return out as unknown as Project;
}
