/**
 * 도면 이미지 검토 (AI 없이): 인식 결과와 크기(척도)로 알 수 있는 것만.
 * 손글씨 치수를 읽어야 하는 검토는 AI 검토가 맡는다.
 */
import type { ViewId } from "../types";
import { VIEW_LABEL } from "../types";
import type { Analysis } from "./detect";
import type { ImportChoice } from "./toProject";

export interface DrawingCheck {
  severity: "error" | "warning" | "info";
  title: string;
  detail: string;
}

export interface ImageInfo {
  inverted: boolean;
  angle: number;
  quad: boolean;
}

export function drawingChecks(an: Analysis, ch: ImportChoice, info: ImageInfo): DrawingCheck[] {
  const out: DrawingCheck[] = [];
  const s = ch.mmPerPx;
  const byRole = (r: ViewId) => an.views.find((v) => ch.roles[v.id] === r);
  const real = an.views.filter((v) => !v.frame);
  const used = an.views.filter((v) => ch.roles[v.id]);

  if (info.inverted) out.push({ severity: "info", title: "어두운 바탕을 뒤집어서 읽었어요", detail: "검은 바탕에 흰 선으로 그린 그림(태블릿 메모 등)은 밝기를 뒤집어 흰 종이처럼 처리했습니다." });
  if (Math.abs(info.angle) >= 2) out.push({ severity: "info", title: `기울어진 그림 (${info.angle.toFixed(1)}°)`, detail: "기울기를 바로잡았습니다. 사진이면 종이와 나란하게 찍으면 더 정확합니다." });
  if (an.stroke.thick < 2)
    out.push({ severity: "warning", title: "해상도가 낮아요", detail: `선 굵기가 ${an.stroke.thick.toFixed(1)}픽셀뿐입니다. 더 큰 이미지(스캔 300dpi 정도)를 쓰면 작은 구멍과 모서리를 더 잘 읽습니다.` });
  if (!real.length) {
    out.push({ severity: "error", title: "뷰를 찾지 못했어요", detail: "외형선이 끊기지 않고 닫혀 있어야 뷰로 읽을 수 있습니다. 끊긴 곳을 이어 그리거나 더 선명한 이미지를 쓰세요." });
    return out;
  }
  // 손으로 그린 선: 직선이 수평·수직에서 조금씩 벗어나 있거나 꺾인 조각이 많다
  const segs = real.flatMap((v) => (v.outline.kind === "path" ? v.outline.prims : []));
  const crooked = segs.filter((p) => {
    if (p.t !== "line") return false;
    const a = (Math.atan2(p.b[1] - p.a[1], p.b[0] - p.a[0]) * 180) / Math.PI;
    const off = Math.abs(((a % 90) + 90) % 90);
    return off > 1.5 && off < 88.5 && Math.hypot(p.b[0] - p.a[0], p.b[1] - p.a[1]) > 40;
  }).length;
  if (segs.length && crooked / segs.length > 0.25)
    out.push({
      severity: "info",
      title: "손으로 그린 도면 같아요",
      detail: "선이 조금씩 기울어 있어 그림 크기가 실제 치수와 다를 수 있습니다. 가져온 뒤 치수는 그림에 적힌 숫자로 고치세요. ‘AI로 읽고 검토’는 손글씨 치수를 읽어 줍니다.",
    });
  // 3각법 배치가 아니면
  if (real.length >= 2 && used.length <= 1)
    out.push({
      severity: "warning",
      title: "3각법 배치가 아니에요",
      detail: "뷰가 여러 개인데 평면도는 정면도 위, 우측면도는 정면도 오른쪽(3각법, KS 기본)에 있지 않아 이름을 정하지 못했습니다. 뷰마다 이름을 직접 고르세요.",
    });
  // 뷰끼리 크기 비교 (3각법이면 같아야 하는 길이)
  const F = byRole("front");
  const T = byRole("top");
  const S = byRole("side");
  const W = (v: typeof F) => (v!.box[2] - v!.box[0]) * s;
  const H = (v: typeof F) => (v!.box[3] - v!.box[1]) * s;
  const cmp = (a: number, b: number, what: string, an: string, bn: string) => {
    const diff = Math.abs(a - b);
    if (diff > Math.max(1, 0.03 * Math.max(a, b)))
      out.push({
        severity: "warning",
        title: `${what}가 뷰마다 달라요`,
        detail: `${an} ${a.toFixed(1)} mm, ${bn} ${b.toFixed(1)} mm (차이 ${diff.toFixed(1)} mm). 같은 부품의 같은 길이라면 같아야 합니다. 그림이 축척대로가 아니면 적힌 치수를 확인하세요.`,
      });
  };
  if (F && T && !ch.revolve) cmp(W(F), W(T), "가로(X) 길이", `${VIEW_LABEL.front} 가로`, `${VIEW_LABEL.top} 가로`);
  if (F && S) cmp(H(F), H(S), "높이(Z)", `${VIEW_LABEL.front} 높이`, `${VIEW_LABEL.side} 높이`);
  if (T && S && !ch.revolve) cmp(H(T), W(S), "깊이(Y)", `${VIEW_LABEL.top} 세로`, `${VIEW_LABEL.side} 가로`);
  // 빗금(해칭): 외형선 안이 빗금으로 잘게 나뉘어 "안쪽 면" 후보가 많이 생긴다
  const hatched = used.filter((v) => v.holes.filter((h) => h.note?.startsWith("안쪽 면")).length >= 5);
  if (hatched.length)
    out.push({
      severity: "info",
      title: "빗금(해칭)이 많은 뷰가 있어요",
      detail: "도면에서 빗금은 부품을 잘랐을 때의 잘린 면(단면도)에만 씁니다. 겉모습을 그린 뷰라면 빗금을 빼고, 단면도라면 어디를 잘랐는지(절단선 A-A)를 표시하세요. 빗금 칸은 구멍 후보에서 뺐습니다.",
    });
  // 꺼 둔 구멍 후보
  const offHoles = used.flatMap((v) => v.holes.filter((h) => !ch.holes[h.id] && h.note));
  if (offHoles.length)
    out.push({ severity: "info", title: `확실하지 않은 구멍 ${offHoles.length}개는 꺼 두었어요`, detail: offHoles.map((h) => h.note).filter((x, i, a) => a.indexOf(x) === i).join(", ") + ". 구멍이 맞으면 그림에서 눌러 켜세요." });
  return out;
}
