/**
 * AI 설계 검토 (Claude API).
 *
 * 규칙 검사(checks.ts)는 정해진 기준만 본다. AI는 도면 전체(3면도 이미지 + 3D 렌더 + 좌표 데이터)를
 * 보고 설계 의도와 어긋나는 점, 뷰 사이의 모순, 제조·조립 관점의 문제를 찾는다.
 *
 * 브라우저에서 사용자 본인의 API 키로 직접 호출한다. (키는 이 기기의 localStorage에만 저장)
 * 여러 사람이 쓰는 서비스로 배포할 때는 키를 서버에 두고 서버가 대신 호출하도록 바꿔야 한다.
 */
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import * as z from "zod/v4";
import { PROCESS_RULES } from "./core/checks";
import type { BuildResult, Finding, Project, ViewId } from "./core/types";
import { PROCESS_LABEL, VIEW_IDS } from "./core/types";

const KEY_STORAGE = "blueprint3d.anthropicKey";
export const AI_MODEL = "claude-opus-5-5";

export function getApiKey(): string {
  try {
    return localStorage.getItem(KEY_STORAGE) ?? "";
  } catch {
    return "";
  }
}

export function setApiKey(k: string) {
  try {
    if (k) localStorage.setItem(KEY_STORAGE, k);
    else localStorage.removeItem(KEY_STORAGE);
  } catch {
    /* 저장할 수 없는 환경 */
  }
}

const ReviewSchema = z.object({
  summary: z.string().describe("부품에 대한 2~3문장 총평 (한국어)"),
  findings: z.array(
    z.object({
      severity: z.enum(["error", "warning", "info"]),
      category: z.string().describe("예: 도면 일관성, 구멍, 가공성, 강도, 조립, 치수 기입"),
      title: z.string().describe("한 줄 요약 (한국어)"),
      detail: z.string().describe("무엇이 왜 문제인지 (한국어, 숫자 근거 포함)"),
      suggestion: z.string().describe("구체적인 수정 방법 (한국어, 가능하면 수치 제시)"),
      view: z.enum(["front", "top", "side", "none"]).describe("문제가 보이는 뷰"),
      shape_ids: z.array(z.string()).describe("관련 도형 id (입력 JSON의 id). 없으면 빈 배열"),
      u: z.number().nullable().describe("그 뷰에서 문제 위치의 가로 좌표(mm). 모르면 null"),
      v: z.number().nullable().describe("그 뷰에서 문제 위치의 세로 좌표(mm). 모르면 null"),
    }),
  ),
});

export type Review = { summary: string; findings: Finding[]; model: string };

// 매 요청에 똑같이 들어가는 부분 (프롬프트 캐시 대상)
const SYSTEM = `당신은 기계 부품 설계 검토 전문가입니다. 사용자가 2D CAD 앱에서 그린 부품을 검토해 설계 오류를 찾아 주세요.

앱의 규칙:
- 단위는 mm. 3각법(Third angle) 3면도: 정면도(front)는 가로 X·세로 Z, 평면도(top)는 가로 X·세로 Y, 우측면도(side)는 가로 Y·세로 Z. 각 뷰 좌표는 (u, v) = (가로, 세로)이며 v는 위쪽이 +.
- 도형은 rect(x, y=왼쪽 아래, w, h, corners), circle(cx, cy, r), poly(pts, bulges, corners), slot(a, b 두 중심점, w 폭)이며 hole=true면 빼기(구멍), false면 몸체. corners는 꼭짓점별 모서리 처리(fillet=R, chamfer=모따기, size mm), bulges는 변별 휨(0=직선, 1=반원).
- 3D 생성 방식(mode):
  - auto: 뷰를 1개만 그리면 그 뷰를 thickness만큼 시선 방향으로 돌출. 2~3개면 각 뷰를 시선 방향으로 끝까지 관통 돌출한 뒤 교집합. 따라서 어느 뷰의 구멍은 그 시선 방향으로 끝까지 관통한다(막힌 구멍·깊이 지정 불가).
  - revolve: 정면도 단면(u ≥ 0)을 Z축 중심으로 360° 회전.
- 앱의 규칙 기반 검사가 이미 찾은 항목(rule_findings)이 함께 주어집니다. 같은 내용을 반복하지 말고, 그것이 놓친 문제에 집중하세요.

검토 관점 (중요한 것부터):
1. 뷰 사이의 모순: 한 뷰의 구멍·단차가 다른 뷰에서 숨은선/외형선으로 맞게 나타나는지, 교집합 결과가 사용자가 의도했을 법한 형상과 다른지 (예: 측면도에만 구멍을 그려 다른 뷰와 안 맞음, 교집합 때문에 생긴 의도치 않은 형상).
2. 제조 가능성: 지정된 제조 방식(process) 기준으로 가공 불가·어려운 형상, 공구 접근성, 얇은 벽, 날카로운 내부 모서리, 깊은 포켓.
3. 강도·기능: 응력 집중(모서리 R 없음), 체결 구멍 위치/간격(볼트 머리·와셔·공구 간섭), 구멍과 굽힘/모서리 거리.
4. 표준·관례: 표준 볼트 관통 구멍·탭 지름(M3 Ø3.4/탭 Ø2.5, M4 Ø4.5/Ø3.3, M5 Ø5.5/Ø4.2, M6 Ø6.6/Ø5.0, M8 Ø9/Ø6.8), 대칭이어야 할 것 같은데 어긋난 치수, 애매한 소수점 치수.
5. 도면 품질: 기준면이 애매함, 치수가 너무 촘촘함, 사용되지 않는 도형.

규칙:
- 이미지와 좌표 데이터 둘 다 근거로 쓰되, 숫자는 좌표 데이터를 기준으로 계산하세요.
- 확실하지 않은 의심은 severity "info"로, 실제로 만들 수 없거나 기능을 해치는 것은 "error", 고치는 게 좋은 것은 "warning".
- 정말 문제가 없으면 findings를 비워도 됩니다. 억지로 만들지 마세요.
- 모든 문장은 한국어로, 기계 설계를 막 배우는 사람도 이해할 수 있게 쓰세요.`;

export interface ReviewInput {
  project: Project;
  build: BuildResult | null;
  ruleFindings: Finding[];
  /** PNG base64 (data: 접두어 없이) */
  image3d?: string;
  imageSheet?: string;
}

export async function requestReview(input: ReviewInput, signal?: AbortSignal): Promise<Review> {
  const apiKey = getApiKey();
  if (!apiKey) throw new Error("API 키가 없습니다. 설정에서 Anthropic API 키를 입력하세요.");
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });

  const { project, build, ruleFindings } = input;
  const process = project.process ?? "cnc";
  const data = {
    name: project.name,
    mode: project.mode,
    thickness_if_single_view: project.thickness,
    process: { id: process, label: PROCESS_LABEL[process], rules: PROCESS_RULES[process] },
    views: project.views,
    result_3d: build
      ? {
          bbox_mm: build.bbox,
          volume_mm3: Math.round(build.volume),
          solid_count: build.solidCount,
        }
      : "3D 생성 실패",
    rule_findings: ruleFindings.map((f) => ({ severity: f.severity, title: f.title, detail: f.detail })),
  };

  const content: Anthropic.Beta.BetaContentBlockParam[] = [];
  if (input.imageSheet) {
    content.push({ type: "text", text: "앱이 3D에서 자동으로 만든 3면도 (외형선 실선, 숨은선 점선):" });
    content.push({ type: "image", source: { type: "base64", media_type: "image/png", data: input.imageSheet } });
  }
  if (input.image3d) {
    content.push({ type: "text", text: "3D 모델 렌더 (등각 시점, Z가 위):" });
    content.push({ type: "image", source: { type: "base64", media_type: "image/png", data: input.image3d } });
  }
  content.push({
    type: "text",
    text: `부품 데이터(JSON):\n${JSON.stringify(data)}\n\n이 부품의 설계 오류와 개선점을 검토해 주세요.`,
  });

  const stream = client.beta.messages.stream(
    {
      model: AI_MODEL,
      max_tokens: 32000,
      betas: ["server-side-fallback-2026-07-01"],
      // 안전 분류기가 잘못 거절해도 서버가 다른 모델로 다시 시도
      fallbacks: "default",
      system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
      output_config: { effort: "high", format: betaZodOutputFormat(ReviewSchema) },
      messages: [{ role: "user", content }],
    },
    { signal },
  );

  let msg;
  try {
    msg = await stream.finalMessage();
  } catch (e) {
    throw new Error(explainError(e));
  }
  if (msg.stop_reason === "refusal") throw new Error("AI가 이 요청을 처리하지 않았습니다. 잠시 후 다시 시도하세요.");
  if (msg.stop_reason === "max_tokens") throw new Error("AI 응답이 너무 길어 잘렸습니다. 다시 시도하세요.");
  const out = msg.parsed_output;
  if (!out) throw new Error("AI 응답을 해석할 수 없습니다. 다시 시도하세요.");

  return { summary: out.summary, findings: toFindings(out, project), model: msg.model };
}

/** AI 응답을 앱의 검사 결과 형식으로 바꾼다 (없는 도형 id는 버림) */
export function toFindings(out: z.infer<typeof ReviewSchema>, project: Project): Finding[] {
  const validIds = new Map<string, ViewId>();
  for (const v of VIEW_IDS) for (const s of project.views[v]) validIds.set(s.id, v);

  return out.findings.map((f, i) => {
    const refs: Finding["refs"] = [];
    const ids = f.shape_ids.filter((id) => validIds.has(id));
    if (f.view !== "none") {
      refs.push({ view: f.view, shapeId: ids.find((id) => validIds.get(id) === f.view), u: f.u ?? undefined, v: f.v ?? undefined });
    }
    for (const id of ids) if (!refs.some((r) => r.shapeId === id)) refs.push({ view: validIds.get(id)!, shapeId: id });
    return {
      id: `ai:${i}`,
      source: "ai",
      severity: f.severity,
      category: f.category,
      title: f.title,
      detail: f.detail,
      suggestion: f.suggestion,
      refs,
    };
  });
}

function explainError(e: unknown): string {
  if (e instanceof Anthropic.AuthenticationError) return "API 키가 올바르지 않습니다. 설정에서 다시 입력하세요.";
  if (e instanceof Anthropic.PermissionDeniedError) return "이 API 키로는 해당 모델을 쓸 권한이 없습니다.";
  if (e instanceof Anthropic.RateLimitError) return "요청이 너무 많습니다. 잠시 후 다시 시도하세요.";
  if (e instanceof Anthropic.BadRequestError) return `요청 오류: ${e.message}`;
  if (e instanceof Anthropic.APIUserAbortError) return "취소했습니다.";
  if (e instanceof Anthropic.APIConnectionError) return "네트워크에 연결할 수 없습니다.";
  if (e instanceof Anthropic.APIError) return `AI 서버 오류 (${e.status}). 잠시 후 다시 시도하세요.`;
  return String((e as Error)?.message ?? e);
}
