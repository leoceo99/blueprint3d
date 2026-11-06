// 7단계: 버전 기록 로직(순수)과 프로젝트 보관함(IndexedDB — 테스트에서는 메모리용 가짜 IndexedDB)
import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { emptyProject, type Project } from "../src/core/types";
import { SAMPLES } from "../src/core/samples";
import { AUTO_KEEP, diffSummary, fileKeys, pruneAuto, relativeTime, shouldAutoSnapshot, summarize, trashExpired } from "../src/core/versions";
import {
  addVersion,
  cleanup,
  deleteVersion,
  duplicateProject,
  exportAll,
  fromBase64,
  getProject,
  importAll,
  exportAllZip,
  importBackupBytes,
  listProjects,
  listVersions,
  parseProject,
  purgeProject,
  renameProject,
  restoreProject,
  saveProject,
  setThumb,
  toBase64,
  trashProject,
} from "../src/library";
import { getFile, getText, putFile } from "../src/fileStore";

const rect = (id: string, w = 40, h = 30, hole = false) => ({ id, kind: "rect" as const, hole, x: 0, y: 0, w, h });

function part(name = "부품"): Project {
  const p = emptyProject();
  p.name = name;
  p.views.front = [rect("a"), rect("b", 5, 5, true)];
  return p;
}

describe("버전 로직", () => {
  it("요약: 도형·구멍·변수", () => {
    const p = part();
    p.params = [{ name: "L", expr: "40" }];
    expect(summarize(p)).toBe("도형 2 · 구멍 1 · 변수 1");
    const s = emptyProject();
    s.source = { kind: "stl", name: "a.stl", key: "m1", turns: [0, 0, 0] };
    expect(summarize(s)).toBe("가져온 3D 파일 · a.stl");
  });

  it("바뀐 내용: 추가·삭제·바뀜·이름·변수", () => {
    const a = part("A");
    const b = structuredClone(a);
    b.name = "B";
    b.views.front[0] = { ...b.views.front[0], w: 50 } as any;
    b.views.front.splice(1, 1);
    b.views.top.push(rect("c"));
    b.params = [{ name: "T", expr: "5" }];
    const d = diffSummary(a, b);
    expect(d).toContain("이름 ‘A’ → ‘B’");
    expect(d).toContain("도형 1개 추가");
    expect(d).toContain("도형 1개 삭제");
    expect(d).toContain("도형 1개 바뀜");
    expect(d).toContain("변수 1개 바뀜");
    expect(diffSummary(a, structuredClone(a))).toBe("바뀐 것 없음");
  });

  it("자동 버전 간격과 정리", () => {
    const now = 1_000_000_000;
    expect(shouldAutoSnapshot(undefined, now)).toBe(true);
    expect(shouldAutoSnapshot(now - 9 * 60_000, now)).toBe(false);
    expect(shouldAutoSnapshot(now - 10 * 60_000, now)).toBe(true);
    const vs = Array.from({ length: AUTO_KEEP + 5 }, (_, i) => ({ id: `v${i}`, time: i, auto: true }));
    vs.push({ id: "m", time: -1, auto: false });
    const drop = pruneAuto(vs);
    expect(drop).toHaveLength(5);
    expect(drop).toEqual(["v4", "v3", "v2", "v1", "v0"]);
    expect(drop).not.toContain("m");
  });

  it("시간 표시", () => {
    const now = new Date(2026, 10, 6, 15, 0).getTime();
    expect(relativeTime(now - 10_000, now)).toBe("방금");
    expect(relativeTime(now - 5 * 60_000, now)).toBe("5분 전");
    expect(relativeTime(new Date(2026, 10, 6, 9, 5).getTime(), now)).toBe("오늘 09:05");
    expect(relativeTime(new Date(2026, 10, 5, 22, 0).getTime(), now)).toBe("어제 22:00");
    expect(relativeTime(new Date(2026, 9, 1, 8, 0).getTime(), now)).toBe("10월 1일 08:00");
    expect(relativeTime(new Date(2025, 9, 1, 8, 0).getTime(), now)).toBe("2025년 10월 1일");
  });

  it("휴지통 30일, 파일 참조", () => {
    const day = 86_400_000;
    expect(trashExpired(0, 29 * day)).toBe(false);
    expect(trashExpired(0, 31 * day)).toBe(true);
    const p = emptyProject();
    p.source = { kind: "step", name: "x.step", key: "m9", turns: [0, 0, 0] };
    expect(fileKeys(p)).toEqual(["m9"]);
  });
});

describe("프로젝트 보관함 (IndexedDB)", () => {
  it("저장·목록·이름·복제·썸네일", async () => {
    await saveProject("p1", part("첫째"), { now: 1000 });
    await saveProject("p2", part("둘째"), { now: 2000 });
    let list = await listProjects();
    expect(list.map((p) => p.id).slice(0, 2)).toEqual(["p2", "p1"]);
    expect(list.find((p) => p.id === "p1")!.summary).toBe("도형 2 · 구멍 1");

    await setThumb("p1", "data:image/jpeg;base64,AAA");
    // 다시 저장해도 썸네일·만든 시각은 남는다
    await saveProject("p1", part("첫째 고침"), { now: 3000 });
    const r1 = (await getProject("p1"))!;
    expect(r1.thumb).toBe("data:image/jpeg;base64,AAA");
    expect(r1.createdAt).toBe(1000);
    expect(r1.updatedAt).toBe(3000);
    expect(r1.name).toBe("첫째 고침");

    await renameProject("p1", "새 이름");
    const r1b = (await getProject("p1"))!;
    expect(r1b.name).toBe("새 이름");
    expect(parseProject(r1b.data)!.name).toBe("새 이름");

    const nid = (await duplicateProject("p1"))!;
    const dup = (await getProject(nid))!;
    expect(dup.name).toBe("새 이름 (복사본)");
    expect(dup.thumb).toBe(r1.thumb);
    list = await listProjects();
    expect(list.length).toBe(3);
  });

  it("휴지통: 넣기·되살리기·30일 뒤 영구 삭제(버전도)", async () => {
    await saveProject("t1", part("버릴 것"));
    await addVersion("t1", part("버릴 것"), { auto: false, label: "v" });
    await trashProject("t1");
    expect((await getProject("t1"))!.deletedAt).toBeTypeOf("number");
    await restoreProject("t1");
    expect((await getProject("t1"))!.deletedAt).toBeUndefined();
    await trashProject("t1");
    await cleanup(Date.now() + 31 * 86_400_000);
    expect(await getProject("t1")).toBeUndefined();
    expect(await listVersions("t1")).toEqual([]);
  });

  it("버전: 자동은 최근 50개만, 직접 저장은 남는다", async () => {
    const id = "v-proj";
    await saveProject(id, part());
    await addVersion(id, part(), { auto: false, label: "중요" }, 1);
    for (let i = 0; i < AUTO_KEEP + 3; i++) await addVersion(id, part(), { auto: true }, 100 + i);
    const vs = await listVersions(id);
    expect(vs.filter((v) => v.auto)).toHaveLength(AUTO_KEEP);
    expect(vs.filter((v) => !v.auto).map((v) => v.label)).toEqual(["중요"]);
    // 가장 오래된 자동 버전 3개가 지워짐
    expect(Math.min(...vs.filter((v) => v.auto).map((v) => v.time))).toBe(103);
    expect(vs[0].time).toBeGreaterThan(vs[vs.length - 1].time);
    await deleteVersion(vs[0].id);
    expect(await listVersions(id)).toHaveLength(AUTO_KEEP);
  });

  it("아무도 안 쓰는 파일만 정리", async () => {
    const p = emptyProject();
    p.source = { kind: "stl", name: "a.stl", key: "keepme", turns: [0, 0, 0] };
    await saveProject("f1", p);
    await putFile("keepme", new Uint8Array([1, 2, 3]).buffer);
    await putFile("orphan", "data:image/png;base64,xx");
    // 버전만 가리키는 파일도 남긴다
    const q = emptyProject();
    q.source = { kind: "stl", name: "b.stl", key: "inversion", turns: [0, 0, 0] };
    await addVersion("f1", q, { auto: false });
    await putFile("inversion", new Uint8Array([9]).buffer);
    await cleanup();
    expect(await getFile("keepme")).not.toBeNull();
    expect(await getFile("inversion")).not.toBeNull();
    expect(await getText("orphan")).toBeNull();
  });

  it("전체 백업 → 지우기 → 가져오기", async () => {
    const p = structuredClone(SAMPLES[0]);
    p.source = { kind: "stl", name: "m.stl", key: "bk-file", turns: [1, 0, 0] };
    await putFile("bk-file", new Uint8Array([7, 8, 9, 250]).buffer);
    await saveProject("bk", p);
    await addVersion("bk", p, { auto: false, label: "백업 전" });
    const backup = JSON.parse(JSON.stringify(await exportAll()));
    expect(backup.format).toBe("blueprint3d-backup");
    expect(backup.files["bk-file"].base64).toBe(toBase64(new Uint8Array([7, 8, 9, 250]).buffer));

    // 모두 지운 뒤 가져오기
    for (const r of await listProjects()) await purgeProject(r.id);
    await cleanup();
    expect(await listProjects()).toEqual([]);
    const res = await importAll(backup);
    expect(res.projects).toBe(backup.projects.length);
    expect(res.versions).toBe(backup.versions.length);
    const back = (await getProject("bk"))!;
    expect(parseProject(back.data)!.parts[0].source!.key).toBe("bk-file");
    expect(new Uint8Array((await getFile("bk-file"))!)).toEqual(new Uint8Array([7, 8, 9, 250]));
    expect((await listVersions("bk")).map((v) => v.label)).toContain("백업 전");

    // 같은 백업을 또 가져오면 그대로(중복 없음)
    const again = await importAll(backup);
    expect(again.projects).toBe(0);
    expect(again.versions).toBe(0);

    // 지금 것을 고친 뒤 가져오면 덮지 않고 ‘(백업)’으로 따로
    await saveProject("bk", { ...p, name: "고친 것" });
    await importAll(backup);
    const names = (await listProjects()).map((r) => r.name);
    expect(names).toContain("고친 것");
    expect(names.some((n) => n.endsWith("(백업)"))).toBe(true);

    await expect(importAll({ hello: 1 })).rejects.toThrow("백업 파일이 아닙니다");
  });

  it("전체 백업 zip (9단계): 왕복, 예전 JSON보다 작음, 예전 JSON 백업도 가져옴", async () => {
    for (const r of await listProjects()) await purgeProject(r.id);
    const big = new TextEncoder().encode(Array.from({ length: 3000 }, (_, i) => `#${i}=CARTESIAN_POINT('',(${i},0.,0.));`).join("\n"));
    const p = structuredClone(SAMPLES[0]);
    p.source = { kind: "step", name: "z.step", key: "zip-file", turns: [0, 0, 0] };
    await putFile("zip-file", big.slice().buffer);
    await saveProject("zp", p);
    await addVersion("zp", p, { auto: false, label: "zip 버전" });
    const json = JSON.stringify(await exportAll());
    const z = await exportAllZip();
    expect(z.projects).toBe(1);
    expect(z.bytes.length).toBeLessThan(json.length / 3);
    for (const r of await listProjects()) await purgeProject(r.id);
    await cleanup();
    const r = await importBackupBytes(z.bytes);
    expect(r).toEqual({ projects: 1, versions: 1 });
    expect(new Uint8Array((await getFile("zip-file"))!)).toEqual(big);
    expect((await listVersions("zp")).map((v) => v.label)).toEqual(["zip 버전"]);
    // 예전 JSON 백업
    for (const x of await listProjects()) await purgeProject(x.id);
    const r2 = await importBackupBytes(new TextEncoder().encode(json));
    expect(r2.projects).toBe(1);
    await expect(importBackupBytes(new TextEncoder().encode("nope"))).rejects.toThrow("백업 파일이 아닙니다");
  });

  it("base64 왕복", () => {
    const b = new Uint8Array(100_000).map((_, i) => (i * 37) & 255);
    expect(new Uint8Array(fromBase64(toBase64(b.buffer)))).toEqual(b);
  });
});
