import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { draftToProject, requestDrawingReview } from "../src/aiDrawing";

function fakeFetch(responseJson: unknown, captured: { body?: any; headers?: Headers }) {
  return vi.fn(async (_url: any, init: any) => {
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

const reply = {
  overall: "핀 도면 두 장입니다.",
  drawings: [
    {
      image: 0,
      title: "핀",
      kind: "tablet_sketch",
      projection: "mixed_or_unclear",
      understanding: "로켓 핀",
      views: [{ label: "정면도", role: "front", box: { x: 0.4, y: 0.1, w: 0.2, h: 0.7 } }],
      dimensions: [{ text: "60.5637mm", value: 60.5637, meaning: "정면도 폭", box: { x: 0.5, y: 0.05, w: 1.4, h: 0.05 } }],
      notes: [],
      draft: {
        mode: "auto",
        thickness: null,
        shapes: [
          { view: "front", kind: "rect", hole: false, x: 0, y: 0, w: 60.6, h: 100, cx: null, cy: null, d: null, pts: [], depth: null },
          { view: "side", kind: "rect", hole: false, x: 0, y: 0, w: 53, h: 100, cx: null, cy: null, d: null, pts: [], depth: null },
          { view: "front", kind: "circle", hole: true, x: null, y: null, w: null, h: null, cx: 10, cy: 10, d: -3, pts: [], depth: null },
        ],
        caveats: "윗면도의 원호는 단순화",
      },
    },
    { image: 7, title: "범위 밖", kind: "other", projection: "not_applicable", understanding: "", views: [], dimensions: [], notes: [], draft: null },
  ],
  findings: [
    {
      severity: "error",
      category: "치수 불일치",
      title: "정면도 폭이 반지름 57에 맞지 않음",
      detail: "2×60×sin15° = 31.06",
      suggestion: "폭을 다시 계산",
      images: [1, 0, 9],
      box: null,
    },
  ],
  questions: ["114는 지름인가요?"],
};

describe("AI 도면 검토 요청", () => {
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
    await expect(requestDrawingReview([{ name: "a.jpg", data: "AAAA", mediaType: "image/jpeg" }], "")).rejects.toThrow("API 키");
  });

  it("그림 여러 장 + 설명을 보내고, 결과를 정리한다", async () => {
    const captured: { body?: any; headers?: Headers } = {};
    vi.stubGlobal("fetch", fakeFetch(reply, captured));
    const r = await requestDrawingReview(
      [
        { name: "핀1.jpg", data: "AAAA", mediaType: "image/jpeg" },
        { name: "핀2.jpg", data: "BBBB", mediaType: "image/jpeg" },
      ],
      "로켓 핀입니다",
    );
    const b = captured.body;
    expect(b.model).toBe("claude-opus-5-5");
    expect(b.fallbacks).toBe("default");
    expect(b.output_config.effort).toBe("high");
    expect(b.output_config.format.type).toBe("json_schema");
    expect(captured.headers!.get("anthropic-beta")).toContain("server-side-fallback-2026-07-01");
    const content = b.messages[0].content;
    expect(content.filter((c: any) => c.type === "image")).toHaveLength(2);
    expect(content.at(-1).text).toContain("로켓 핀입니다");
    expect(content.at(-1).text).toContain("도면끼리도 비교");
    // 범위 밖 그림 번호와 영역은 정리
    expect(r.drawings).toHaveLength(1);
    expect(r.findings[0].images).toEqual([1, 0]);
    expect(r.drawings[0].dimensions[0].box!.w).toBe(1);
    // 3D 초안: 지름이 음수인 구멍은 버린다
    const p = draftToProject(r.drawings[0])!;
    expect(p.views.front).toHaveLength(1);
    expect(p.views.side[0]).toMatchObject({ kind: "rect", w: 53, h: 100 });
  });

  it("7장 이상은 거절", async () => {
    const im = { name: "a", data: "A", mediaType: "image/jpeg" as const };
    await expect(requestDrawingReview(Array(7).fill(im), "")).rejects.toThrow("6장");
  });
});
