/**
 * AI 도면 읽기·검토 (Claude API, 사용자 본인 키).
 *
 * 손으로 그린 스케치, 태블릿 메모, 사진, CAD 도면 이미지를 1~6장 받아서
 *  - 적힌 치수·주기·뷰 이름을 읽고 (손글씨 포함)
 *  - 뷰끼리, 도면끼리(조립품) 치수가 맞는지 계산해 보고
 *  - 빠진 치수, 만들 수 없는 모양, 규격(볼트·O-링) 문제, 도면 관례 위반을 찾아
 *  - 설계자에게 확인할 질문과, 가능하면 앱에서 바로 3D로 만들 수 있는 초안을 돌려준다.
 * 영상 처리(AI 없이)로는 손글씨 숫자를 읽을 수 없어서 이 기능은 AI를 쓴다. 키가 없으면 쓰지 않는다.
 */
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import * as z from "zod/v4";
import { AI_MODEL, getApiKey } from "./aiKey";
import { emptyProject, type Project, type Shape2D, type ViewId } from "./core/types";

/** 그림 위의 영역: 그림 크기에 대한 비율 (0~1, 왼쪽 위가 0) */
const Box = z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() });

const Pt = z.object({ x: z.number(), y: z.number() });

const DraftShape = z.object({
  view: z.enum(["front", "top", "side"]),
  kind: z.enum(["rect", "circle", "poly", "slot"]),
  hole: z.boolean().describe("true면 구멍(빼기), false면 몸체"),
  x: z.number().nullable().describe("rect: 왼쪽 아래 u"),
  y: z.number().nullable().describe("rect: 왼쪽 아래 v"),
  w: z.number().nullable().describe("rect: 가로 / slot: 폭"),
  h: z.number().nullable().describe("rect: 세로"),
  cx: z.number().nullable().describe("circle: 중심 u"),
  cy: z.number().nullable().describe("circle: 중심 v"),
  d: z.number().nullable().describe("circle: 지름"),
  pts: z.array(Pt).describe("poly: 꼭짓점 (반시계). slot: 양끝 반원 중심 2개. 그 밖에는 빈 배열"),
  depth: z.number().nullable().describe("구멍 깊이(mm). 관통이면 null"),
});

const DrawingReviewSchema = z.object({
  overall: z.string().describe("전체 총평 3~5문장 (한국어). 무엇을 만드는 도면인지, 가장 중요한 문제 1~3가지"),
  drawings: z.array(
    z.object({
      image: z.number().int().describe("그림 번호 (0부터)"),
      title: z.string().describe("부품 이름 (적힌 그대로, 없으면 추정이라고 밝힘)"),
      kind: z.enum(["cad_drawing", "hand_sketch", "tablet_sketch", "photo", "screenshot", "other"]),
      projection: z.enum(["third_angle", "first_angle", "mixed_or_unclear", "single_view", "not_applicable"]),
      understanding: z.string().describe("부품 모양과 역할을 어떻게 이해했는지 2~4문장"),
      views: z.array(
        z.object({
          label: z.string().describe("그림에 적힌 뷰 이름 (없으면 추정)"),
          role: z.enum(["front", "top", "side", "section", "detail", "other"]),
          box: Box,
        }),
      ),
      dimensions: z.array(
        z.object({
          text: z.string().describe("적힌 그대로 (예: 60.5637mm, 3.1, M6×20)"),
          value: z.number().nullable().describe("mm 값. 숫자가 아니면 null"),
          meaning: z.string().describe("무엇의 치수인지 (예: 정면도 전체 폭)"),
          box: Box.nullable(),
        }),
      ),
      notes: z.array(z.string()).describe("주기, 부품표, 나사 목록 등 적힌 글 (읽은 그대로 요약)"),
      draft: z
        .object({
          mode: z.enum(["auto", "revolve"]),
          thickness: z.number().nullable().describe("뷰가 하나뿐일 때 돌출 두께"),
          shapes: z.array(DraftShape),
          caveats: z.string().describe("초안에서 추정하거나 빠뜨린 것"),
        })
        .nullable()
        .describe("앱의 3면도 규칙으로 옮길 수 있으면 3D 초안. 모양을 확정할 수 없으면 null"),
    }),
  ),
  findings: z.array(
    z.object({
      severity: z.enum(["error", "warning", "info"]),
      category: z.string().describe("예: 치수 불일치, 빠진 치수, 뷰 불일치, 도면 관례, 규격 부품, 조립, 가공성, 강도·안전"),
      title: z.string().describe("한 줄 요약"),
      detail: z.string().describe("무엇이 왜 문제인지. 계산했다면 식과 숫자를 그대로 (예: 2×117×sin15° = 60.56)"),
      suggestion: z.string().describe("구체적인 수정 방법이나 확인할 것"),
      images: z.array(z.number().int()).describe("관련 그림 번호들"),
      box: Box.nullable().describe("첫 번째 관련 그림에서 문제 위치. 모르면 null"),
    }),
  ),
  questions: z.array(z.string()).describe("설계자에게 확인해야 할 질문 (답에 따라 설계가 달라지는 것)"),
});

export type DrawingReview = z.infer<typeof DrawingReviewSchema> & { model: string };

const SYSTEM = `당신은 기계 설계 도면을 검토하는 선임 엔지니어입니다. 사용자가 올린 도면 이미지(정식 CAD 도면일 수도, 손이나 태블릿으로 그린 스케치일 수도 있음)를 읽고, 설계를 배우는 사람에게 도움이 되도록 검토합니다.

할 일:
1. 읽기: 각 그림의 뷰와 뷰 이름, 적힌 치수(손글씨 포함), 주기·부품표·나사 목록을 빠짐없이 읽습니다. 흐리거나 애매한 글자는 추측임을 밝힙니다. 그림의 크기는 축척대로가 아닐 수 있으니 치수는 적힌 숫자를 기준으로 합니다.
2. 이해: 부품의 모양과 역할, 여러 장이면 서로 어떻게 조립되는지 파악합니다.
3. 검토 — 숫자로 확인할 수 있는 것은 직접 계산해서 근거를 적습니다:
   - 치수끼리의 합·차가 맞는지, 같은 길이가 뷰마다 같은지(3각법이면 정면도-평면도 가로, 정면도-우측면도 높이, 평면도 세로-우측면도 가로), 각도·반지름에서 나온 치수(현 길이 등)가 맞는지, 고친 버전이 여러 장이면 바뀐 치수에 맞춰 다른 치수도 바뀌었는지.
   - 모양을 정하는 데 빠진 치수(위치, 각도, 깊이, 두께, 공차), 같은 것을 두 번 다르게 적은 치수, 의미가 애매한 치수.
   - 조립품이면 맞물리는 치수(축-구멍 지름, 끼움 길이, 나사 길이와 체결 두께의 합, 구멍 개수와 배치)가 도면끼리 맞는지.
   - 규격 부품: 볼트 관통 구멍·탭 기초 구멍 지름(M3 Ø3.4/Ø2.5, M4 Ø4.5/Ø3.3, M5 Ø5.5/Ø4.2, M6 Ø6.6/Ø5.0, M8 Ø9/Ø6.8), 나사 물림 길이(얇은 벽에 탭), O-링 홈의 폭·깊이와 O-링 굵기, 끼워맞춤 틈새.
   - 도면 관례: 투상법(한국 KS는 3각법: 평면도는 정면도 위, 우측면도는 정면도 오른쪽), 빗금(해칭)은 단면에만, 실제로 만들 수 없는 과도한 소수점 자리, 재질·공차·표면 표시 누락.
   - 만들기·강도·안전: 가공·3D 프린팅이 어려운 형상, 얇은 벽, 응력 집중, 압력을 받는 부품이라면 밀봉과 관통 구멍.
4. 질문: 답에 따라 설계가 달라지는 것은 단정하지 말고 질문으로 남깁니다.
5. 3D 초안(draft): 모양이 충분히 정해진 그림은 아래 앱 규칙으로 옮깁니다. 확정할 수 없으면 null.

앱의 3면도 규칙 (draft 좌표):
- 단위 mm. 정면도(front)는 가로 u = X, 세로 v = Z. 평면도(top)는 u = X, v = Y. 우측면도(side)는 u = Y, v = Z. v는 위쪽이 +.
- 각 뷰는 부품의 왼쪽 아래 모서리를 원점(0,0)으로 둡니다. 정면도와 평면도의 X, 정면도와 우측면도의 Z, 평면도의 Y와 우측면도의 Y가 같은 3D 좌표가 되게 맞춥니다.
- mode "auto": 그린 뷰가 1개면 thickness만큼 돌출, 2~3개면 각 뷰를 시선 방향으로 끝까지 돌출한 뒤 겹치는 부분(교집합). 구멍은 그 뷰의 시선 방향으로 판다(depth가 null이면 관통).
- mode "revolve": 정면도에서 u ≥ 0인 단면을 세로축(Z, u = 0) 둘레로 360° 회전. 이때 정면도 u = 0이 회전축이고, 평면도·우측면도는 구멍만 씁니다(평면도 원점 = 회전축).
- 도형: rect(x, y = 왼쪽 아래, w, h), circle(cx, cy, d = 지름), poly(pts: 꼭짓점들, 반시계), slot(pts: 양끝 반원의 중심 2개, w = 폭).

규칙:
- severity: 만들 수 없거나 기능·안전을 해치는 것 "error", 고치는 게 좋은 것 "warning", 확인하면 좋은 것 "info".
- box는 그림 크기에 대한 비율(0~1)로, 위치를 알 때만 적습니다.
- 억지로 문제를 만들지 말고, 맞는 것은 맞다고 총평에 적어도 됩니다.
- 모든 문장은 한국어로, 기계 설계를 막 배우는 사람도 이해할 수 있게 씁니다.`;

export interface DrawingImage {
  name: string;
  /** JPEG/PNG base64 (data: 접두어 없이) */
  data: string;
  mediaType: "image/jpeg" | "image/png";
}

export async function requestDrawingReview(images: DrawingImage[], note: string, signal?: AbortSignal): Promise<DrawingReview> {
  const apiKey = getApiKey();
  if (!apiKey) throw new Error("API 키가 없습니다. 오른쪽 위 ⚙ 설정에서 Anthropic API 키를 입력하세요.");
  if (!images.length) throw new Error("검토할 그림을 하나 이상 넣어 주세요.");
  if (images.length > 6) throw new Error("한 번에 6장까지 검토할 수 있어요.");
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });

  const content: Anthropic.Beta.BetaContentBlockParam[] = [];
  images.forEach((im, i) => {
    content.push({ type: "text", text: `그림 ${i} — 파일 이름: ${im.name}` });
    content.push({ type: "image", source: { type: "base64", media_type: im.mediaType, data: im.data } });
  });
  content.push({
    type: "text",
    text:
      (note.trim() ? `설계자의 설명·질문:\n${note.trim()}\n\n` : "") +
      (images.length > 1 ? "여러 장이 한 조립품(또는 같은 부품의 여러 버전)일 수 있으니 도면끼리도 비교해 주세요.\n" : "") +
      "이 도면을 읽고 검토해 주세요.",
  });

  const stream = client.beta.messages.stream(
    {
      model: AI_MODEL,
      max_tokens: 64000,
      betas: ["server-side-fallback-2026-07-01"],
      // 안전 분류기가 잘못 거절해도 서버가 다른 모델로 다시 시도
      fallbacks: "default",
      system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
      // 도면 글씨·치수 읽기는 생각을 깊게 할수록 정확하다
      output_config: { effort: "high", format: betaZodOutputFormat(DrawingReviewSchema) },
      messages: [{ role: "user", content }],
    },
    { signal },
  );
  let msg;
  try {
    msg = await stream.finalMessage();
  } catch (e) {
    throw new Error(explain(e));
  }
  if (msg.stop_reason === "refusal") throw new Error("AI가 이 요청을 처리하지 않았습니다. 잠시 후 다시 시도하세요.");
  if (msg.stop_reason === "max_tokens") throw new Error("AI 응답이 너무 길어 잘렸습니다. 그림 수를 줄여 다시 시도하세요.");
  const out = msg.parsed_output;
  if (!out) throw new Error("AI 응답을 해석할 수 없습니다. 다시 시도하세요.");
  return { ...clean(out, images.length), model: msg.model };
}

/** 그림 번호·영역을 범위 안으로 */
function clean(out: z.infer<typeof DrawingReviewSchema>, n: number): z.infer<typeof DrawingReviewSchema> {
  const okBox = (b: z.infer<typeof Box> | null) =>
    b && [b.x, b.y, b.w, b.h].every((v) => Number.isFinite(v)) && b.w > 0 && b.h > 0
      ? { x: clamp01(b.x), y: clamp01(b.y), w: Math.min(b.w, 1), h: Math.min(b.h, 1) }
      : null;
  return {
    ...out,
    drawings: out.drawings
      .filter((d) => d.image >= 0 && d.image < n)
      .map((d) => ({
        ...d,
        views: d.views.map((v) => ({ ...v, box: okBox(v.box) ?? { x: 0, y: 0, w: 0, h: 0 } })),
        dimensions: d.dimensions.map((x) => ({ ...x, box: okBox(x.box) })),
      })),
    findings: out.findings.map((f) => ({ ...f, images: f.images.filter((i) => i >= 0 && i < n), box: okBox(f.box) })),
  };
}
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

let seq = 0;
const nid = () => `a${Date.now().toString(36)}${(seq++).toString(36)}`;

/** AI가 만든 3D 초안 → 프로젝트 (잘못된 도형은 버린다) */
export function draftToProject(d: DrawingReview["drawings"][number]): Project | null {
  if (!d.draft) return null;
  const p = emptyProject();
  p.name = d.title || "AI 초안";
  p.mode = d.draft.mode;
  if (d.draft.thickness && d.draft.thickness > 0) p.thickness = d.draft.thickness;
  const ok = (...v: (number | null)[]) => v.every((x) => x !== null && Number.isFinite(x));
  for (const s of d.draft.shapes) {
    let shape: Shape2D | null = null;
    const base = { id: nid(), hole: s.hole, ...(s.hole && s.depth && s.depth > 0 ? { depth: s.depth } : {}) };
    if (s.kind === "rect" && ok(s.x, s.y, s.w, s.h) && s.w! > 0 && s.h! > 0) shape = { ...base, kind: "rect", x: s.x!, y: s.y!, w: s.w!, h: s.h! };
    else if (s.kind === "circle" && ok(s.cx, s.cy, s.d) && s.d! > 0) shape = { ...base, kind: "circle", cx: s.cx!, cy: s.cy!, r: s.d! / 2 };
    else if (s.kind === "poly" && s.pts.length >= 3) shape = { ...base, kind: "poly", pts: s.pts.map((q) => [q.x, q.y]) };
    else if (s.kind === "slot" && s.pts.length === 2 && ok(s.w) && s.w! > 0)
      shape = { ...base, kind: "slot", a: [s.pts[0].x, s.pts[0].y], b: [s.pts[1].x, s.pts[1].y], w: s.w! };
    if (shape) p.views[s.view as ViewId].push(shape);
  }
  return (["front", "top", "side"] as const).some((v) => p.views[v].some((s) => !s.hole)) ? p : null;
}

function explain(e: unknown): string {
  if (e instanceof Anthropic.AuthenticationError) return "API 키가 올바르지 않습니다. 설정에서 다시 입력하세요.";
  if (e instanceof Anthropic.PermissionDeniedError) return "이 API 키로는 해당 모델을 쓸 권한이 없습니다.";
  if (e instanceof Anthropic.RateLimitError) return "요청이 너무 많습니다. 잠시 후 다시 시도하세요.";
  if (e instanceof Anthropic.BadRequestError) return `요청 오류: ${e.message}`;
  if (e instanceof Anthropic.APIUserAbortError) return "취소했습니다.";
  if (e instanceof Anthropic.APIConnectionError) return "네트워크에 연결할 수 없습니다.";
  if (e instanceof Anthropic.APIError) return `AI 서버 오류 (${e.status}). 잠시 후 다시 시도하세요.`;
  return String((e as Error)?.message ?? e);
}
