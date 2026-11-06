/**
 * 명령 찾기용 검색: 한글 초성("ㅅㄱㅎ" → 사각형), 영어 별칭, 띄어쓰기 무시, 앞부분·중간·건너뛰기 일치.
 */
const INITIALS = "ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ";

/** 한글 글자를 초성으로 ("사각형" → "ㅅㄱㅎ"). 한글이 아니면 그대로 */
export function choseong(s: string): string {
  let out = "";
  for (const ch of s) {
    const c = ch.charCodeAt(0);
    out += c >= 0xac00 && c <= 0xd7a3 ? INITIALS[Math.floor((c - 0xac00) / 588)] : ch;
  }
  return out;
}

const isInitial = (ch: string) => INITIALS.includes(ch);
const norm = (s: string) => s.toLowerCase().replace(/[\s·_\-()/,.…]+/g, "");

/** 한 글자열에 대한 점수 (0이면 맞지 않음) */
export function matchScore(query: string, target: string): number {
  const q = norm(query);
  const t = norm(target);
  if (!q) return 1;
  if (!t) return 0;
  if (t === q) return 100;
  if (t.startsWith(q)) return 85 - Math.min(10, t.length - q.length) * 0.5;
  const i = t.indexOf(q);
  if (i >= 0) return 70 - Math.min(20, i);
  // 초성으로 찾기 (질의에 초성이 하나라도 있으면)
  if ([...q].some(isInitial)) {
    const tc = choseong(t);
    const qc = choseong(q);
    if (tc.startsWith(qc)) return 60;
    const j = tc.indexOf(qc);
    if (j >= 0) return 50 - Math.min(20, j);
  }
  // 글자를 건너뛰며 순서대로 (예: "cbr" → "counterbore")
  let k = 0;
  let gaps = 0;
  let last = -1;
  for (let x = 0; x < t.length && k < q.length; x++) {
    if (t[x] === q[k]) {
      if (last >= 0) gaps += x - last - 1;
      last = x;
      k++;
    }
  }
  if (k === q.length && q.length >= 2) return Math.max(5, 30 - gaps);
  return 0;
}

/** 여러 칸(제목·별칭·분류) 중 가장 잘 맞는 점수 + 추가 점수로 정렬 */
export function search<T>(items: T[], query: string, fields: (t: T) => string[], bonus: (t: T) => number = () => 0): T[] {
  const scored: { t: T; s: number; i: number }[] = [];
  items.forEach((t, i) => {
    const fs = fields(t);
    let s = 0;
    fs.forEach((f, fi) => {
      // 첫 칸(제목)이 맞는 것을 조금 더 앞으로
      const v = matchScore(query, f) * (fi === 0 ? 1 : 0.9);
      if (v > s) s = v;
    });
    if (s > 0) scored.push({ t, s: s + bonus(t), i });
  });
  return scored.sort((a, b) => b.s - a.s || a.i - b.i).map((x) => x.t);
}
