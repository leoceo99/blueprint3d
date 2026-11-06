/**
 * AI(실험 기능) 설정: 모델 이름과 API 키. AI SDK(약 0.6MB)를 불러오지 않고도 쓸 수 있게 따로 둔다.
 * 실제 요청 코드(ai.ts, aiDrawing.ts)는 AI 기능을 처음 쓸 때 내려받는다.
 */
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
