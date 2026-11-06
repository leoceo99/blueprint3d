/**
 * 버전 기록에 필요한 순수 로직: 요약, 두 버전 사이 바뀐 내용, 자동 버전 정리, 시간 표시.
 */
import type { Project } from "./types";
import { VIEW_IDS } from "./types";

/** 한 줄 요약: "도형 12 · 구멍 4 · 변수 3" */
export function summarize(p: Project): string {
  if (p.source) return `가져온 3D 파일 · ${p.source.name}`;
  const shapes = VIEW_IDS.reduce((n, v) => n + p.views[v].length, 0);
  const holes = VIEW_IDS.reduce((n, v) => n + p.views[v].filter((s) => s.hole).length, 0);
  const parts = [`도형 ${shapes}`];
  if (holes) parts.push(`구멍 ${holes}`);
  if (p.params?.length) parts.push(`변수 ${p.params.length}`);
  if (p.mode === "revolve") parts.push("회전체");
  return parts.join(" · ");
}

/** 예전(a) → 지금(b) 사이에 바뀐 것 */
export function diffSummary(a: Project, b: Project): string {
  const out: string[] = [];
  if (a.name !== b.name) out.push(`이름 ‘${a.name}’ → ‘${b.name}’`);
  if (a.mode !== b.mode) out.push(b.mode === "revolve" ? "회전체로 바뀜" : "돌출 방식으로 바뀜");
  if ((a.source?.key ?? "") !== (b.source?.key ?? "")) out.push(b.source ? "가져온 3D 파일 바뀜" : "가져온 3D 파일 없어짐");
  else if (a.source && b.source && a.source.turns.join() !== b.source.turns.join()) out.push("3D 파일 방향 바뀜");
  let added = 0;
  let removed = 0;
  let changed = 0;
  for (const v of VIEW_IDS) {
    const before = new Map(a.views[v].map((s) => [s.id, JSON.stringify(s)]));
    const after = new Map(b.views[v].map((s) => [s.id, JSON.stringify(s)]));
    for (const [id, s] of after) {
      if (!before.has(id)) added++;
      else if (before.get(id) !== s) changed++;
    }
    for (const id of before.keys()) if (!after.has(id)) removed++;
  }
  if (added) out.push(`도형 ${added}개 추가`);
  if (removed) out.push(`도형 ${removed}개 삭제`);
  if (changed) out.push(`도형 ${changed}개 바뀜`);
  const pa = new Map((a.params ?? []).map((x) => [x.name, x.expr]));
  const pb = new Map((b.params ?? []).map((x) => [x.name, x.expr]));
  let pc = 0;
  for (const [k, e] of pb) if (pa.get(k) !== e) pc++;
  for (const k of pa.keys()) if (!pb.has(k)) pc++;
  if (pc) out.push(`변수 ${pc}개 바뀜`);
  if (a.thickness !== b.thickness || a.thicknessExpr !== b.thicknessExpr) out.push("두께 바뀜");
  if (JSON.stringify(a.sheet ?? {}) !== JSON.stringify(b.sheet ?? {})) out.push("도면 설정 바뀜");
  return out.length ? out.join(", ") : "바뀐 것 없음";
}

export const AUTO_INTERVAL = 10 * 60 * 1000;
export const AUTO_KEEP = 50;

/** 마지막 버전에서 충분히 지났으면 자동 버전을 남긴다 */
export function shouldAutoSnapshot(lastTime: number | undefined, now: number, interval = AUTO_INTERVAL): boolean {
  return lastTime === undefined || now - lastTime >= interval;
}

/** 자동 버전은 최근 keep개만 (직접 저장한 버전은 그대로). 지울 id 목록 */
export function pruneAuto(versions: { id: string; time: number; auto: boolean }[], keep = AUTO_KEEP): string[] {
  return versions
    .filter((v) => v.auto)
    .sort((a, b) => b.time - a.time)
    .slice(keep)
    .map((v) => v.id);
}

/** "방금", "5분 전", "오늘 14:32", "어제 09:10", "11월 3일 14:00", "2025년 11월 3일" */
export function relativeTime(t: number, now: number): string {
  const d = new Date(t);
  const n = new Date(now);
  const diff = now - t;
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  if (diff < 60_000) return "방금";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}분 전`;
  const sameDay = (x: Date, y: Date) => x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
  if (sameDay(d, n)) return `오늘 ${hm}`;
  const y = new Date(n);
  y.setDate(n.getDate() - 1);
  if (sameDay(d, y)) return `어제 ${hm}`;
  if (d.getFullYear() === n.getFullYear()) return `${d.getMonth() + 1}월 ${d.getDate()}일 ${hm}`;
  return `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일`;
}

/** 휴지통에서 이만큼 지나면 영구 삭제 */
export const TRASH_DAYS = 30;
export const trashExpired = (deletedAt: number, now: number) => now - deletedAt > TRASH_DAYS * 86_400_000;

/** 프로젝트가 참조하는 큰 파일(가져온 3D, 밑그림) 키 */
export function fileKeys(p: Project): string[] {
  return [p.source?.key, p.underlay?.key].filter((k): k is string => !!k);
}
