import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requestReview } from "../src/ai";
import { SAMPLES } from "../src/core/samples";

/** Claude API 대신 응답하는 가짜 fetch: 요청 본문을 저장하고 SSE 스트림으로 답한다 */
function fakeFetch(responseJson: unknown, captured: { url?: string; headers?: Headers; body?: any }) {
  return vi.fn(async (url: any, init: any) => {
    captured.url = String(url);
    captured.headers = new Headers(init.headers);
    captured.body = JSON.parse(init.body);
    const text = JSON.stringify(responseJson);
    const ev = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    const sse =
      ev("message_start", {
        type: "message_start",
        message: { id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } },
      }) +
      ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }) +
      ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }) +
      ev("content_block_stop", { type: "content_block_stop", index: 0 }) +
      ev("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 50 } }) +
      ev("message_stop", { type: "message_stop" });
    return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
  });
}

describe("AI 설계 검토 요청", () => {
  const store = new Map<string, string>();
  beforeEach(() => {
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, v),
      removeItem: (k: string) => store.delete(k),
    });
    store.set("blueprint3d.anthropicKey", "sk-ant-test");
  });
  afterEach(() => vi.unstubAllGlobals());

  it("키가 없으면 친절한 오류", async () => {
    store.clear();
    await expect(requestReview({ project: SAMPLES[0], build: null, ruleFindings: [] })).rejects.toThrow("API 키");
  });

  it("요청 형식과 응답 변환", async () => {
    const project = structuredClone(SAMPLES[0]);
    const captured: { url?: string; headers?: Headers; body?: any } = {};
    vi.stubGlobal(
      "fetch",
      fakeFetch(
        {
          summary: "전체적으로 무난합니다.",
          findings: [
            {
              severity: "warning",
              category: "구멍",
              title: "측면도 구멍이 평면도 구멍과 너무 가까움",
              detail: "…",
              suggestion: "…",
              view: "side",
              shape_ids: ["s2", "없는-id"],
              u: 20,
              v: 30,
            },
            { severity: "info", category: "도면 품질", title: "총평", detail: "…", suggestion: "…", view: "none", shape_ids: [], u: null, v: null },
          ],
        },
        captured,
      ),
    );
    const res = await requestReview({
      project,
      build: { bbox: [[0, 0, 0], [60, 40, 45]], volume: 29510, solidCount: 1, notes: [], projections: {} as any, mesh: {} as any },
      ruleFindings: [],
      imageSheet: "iVBORw0KGgo=",
      image3d: "iVBORw0KGgo=",
    });

    // 요청
    expect(captured.url).toContain("/v1/messages");
    expect(captured.body.model).toBe("claude-opus-5-5");
    expect(captured.body.stream).toBe(true);
    expect(captured.body.fallbacks).toBe("default");
    expect(captured.headers!.get("anthropic-beta")).toContain("server-side-fallback-2026-07-01");
    expect(captured.headers!.get("anthropic-dangerous-direct-browser-access")).toBe("true");
    expect(captured.body.output_config.effort).toBe("high");
    expect(captured.body.output_config.format.type).toBe("json_schema");
    expect(captured.body.system[0].cache_control).toEqual({ type: "ephemeral" });
    const blocks = captured.body.messages[0].content;
    expect(blocks.filter((b: any) => b.type === "image")).toHaveLength(2);
    expect(blocks.at(-1).text).toContain('"id":"s2"');

    // 응답 → 검사 결과
    expect(res.summary).toBe("전체적으로 무난합니다.");
    expect(res.findings).toHaveLength(2);
    expect(res.findings[0]).toMatchObject({ source: "ai", severity: "warning", refs: [{ view: "side", shapeId: "s2", u: 20, v: 30 }] });
    expect(res.findings[1].refs).toEqual([]);
  });
});
