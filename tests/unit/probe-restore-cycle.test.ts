// m1 ревью 342: офлайн-мок полного цикла restore живой пробы с отделкой.
// Проба scripts/probes/341-tails50-live.ts восстанавливает объект через
// scripts/probes/probe-restore.ts: свои разделители → отделка СВОИХ комнат по
// подсказке реестра (до удаления стен, иначе wall_delete отказывает, как в живом
// логе 341: wall_delete W23 INVALID_GEOMETRY) → свои стены по захваченным
// site_id → save. Мок повторяет правила редактора: wall_delete при отделке
// исчезающей комнаты даёт отказ; ластик complex не снимает; смена материала на
// ДРУГОЙ снимает complex. Третий тест показывает, что restore без снятия
// отделки (откат m1) в этом моке краснеет — отказ wall_delete.
import test from "node:test";
import assert from "node:assert/strict";
import { restoreByCaptured, removeRoomFinishByHint, type ProbeCall, type ProbeCreated } from "../../scripts/probes/probe-restore.ts";

type Finish = {
  ceiling?: { material: string; complex?: boolean };
  floor?: { cover: string };
  walls?: unknown[];
  floor_moldings?: unknown[];
  ceiling_moldings?: unknown[];
  niches?: unknown[];
};

type MockState = {
  walls: Array<{ id: string; site_id: string; rooms: string[] }>;
  delimiters: Array<{ id: string }>;
  finishes: Record<string, Finish>;
};

const GEOM_MSG = 'wall_delete: {"code":"INVALID_GEOMETRY","message":"отделка комнаты, которая исчезает — снимите её до операции"}';

function mkState(opts: { finish: Finish }): MockState {
  return {
    walls: [
      { id: "wu", site_id: "user-wall", rooms: ["user"] },
      { id: "w1", site_id: "t1", rooms: ["trial"] },
      { id: "w2", site_id: "t2", rooms: ["trial"] },
      { id: "w3", site_id: "t3", rooms: ["trial"] },
      { id: "w4", site_id: "t4", rooms: ["trial"] },
    ],
    delimiters: [{ id: "zd1" }],
    finishes: { user: {}, trial: structuredClone(opts.finish) },
  };
}

/** Мок «редактора»: правила отказа как в настоящем редакторе. */
function mkCall(st: MockState, calls: string[]): ProbeCall {
  const refuseFinish = (roomId: string): void => {
    const f = st.finishes[roomId] ?? {};
    const dressed = f.ceiling !== undefined || f.floor !== undefined || (f.walls ?? []).length > 0
      || (f.floor_moldings ?? []).length > 0 || (f.ceiling_moldings ?? []).length > 0 || (f.niches ?? []).length > 0;
    if (dressed) throw new Error(GEOM_MSG);
  };
  return async (name, args) => {
    calls.push(`${name} ${JSON.stringify(args)}`);
    const rid = String(args["room_id"] ?? args["delimiter_id"] ?? "");
    switch (name) {
      case "model_get":
        return { walls: st.walls.map((w) => ({ id: w.id, site_id: w.site_id })) };
      case "finish_get":
        return st.finishes[rid] ?? {};
      case "finish_ceiling_set": {
        const f = st.finishes[rid] ?? (st.finishes[rid] = {});
        const material = String(args["material"]);
        if (f.ceiling?.complex === true && f.ceiling.material !== material) {
          f.ceiling = { material };
          return { warnings: ["complex_removed: двухуровневый потолок комнаты снят"] };
        }
        f.ceiling = { material };
        return {};
      }
      case "finish_ceiling_remove": {
        const f = st.finishes[rid] ?? {};
        if ((f.niches ?? []).length > 0) throw new Error(`${name}: при нише ластик отказывает`);
        if (f.ceiling?.complex === true) throw new Error(`${name}: complex ластик не снимает`);
        delete f.ceiling;
        return { removed: "ceiling" };
      }
      case "finish_floor_remove": delete st.finishes[rid]?.floor; return {};
      case "finish_wall_remove": if (st.finishes[rid]) st.finishes[rid]!.walls = []; return {};
      case "finish_floor_molding_remove": if (st.finishes[rid]) st.finishes[rid]!.floor_moldings = []; return {};
      case "finish_ceiling_molding_remove": if (st.finishes[rid]) st.finishes[rid]!.ceiling_moldings = []; return {};
      case "finish_ceiling_niche_remove": if (st.finishes[rid]) st.finishes[rid]!.niches = []; return {};
      case "zone_ceiling_remove": {
        const i = st.delimiters.findIndex((d) => d.id === rid);
        if (i >= 0) st.delimiters.splice(i, 1);
        return {};
      }
      case "wall_delete": {
        const w = st.walls.find((x) => x.id === args["wall_id"]);
        if (!w) throw new Error("wall_delete: стена не найдена");
        for (const r of w.rooms) refuseFinish(r);
        st.walls.splice(st.walls.indexOf(w), 1);
        return { deleted: args["wall_id"] };
      }
      case "project_save":
        return { verified: true, warnings: [] };
      default:
        throw new Error(`мок не знает инструмент ${name}`);
    }
  };
}

test("342 m1: restore снимает отделку своей комнаты до wall_delete — полный цикл без отказов", async () => {
  const st = mkState({ finish: { ceiling: { material: "gypsum_ceiling" }, floor: { cover: "laminate" } } });
  const calls: string[] = [];
  const created: ProbeCreated[] = [
    ...st.walls.filter((w) => w.site_id.startsWith("t")).map((w) => ({ kind: "wall", siteId: w.site_id })),
    { kind: "delimiter", siteId: "zd1" },
  ];
  const ownRoomIds = ["trial"];
  let saves = 0;
  await restoreByCaptured({ call: mkCall(st, calls), created, ownRoomIds, save: async () => { saves++; }, log: (l) => calls.push(`LOG ${l}`) });
  // отказов не было
  assert.equal(calls.filter((c) => c.startsWith("LOG ")).length, 0, `без отказов: ${calls.join(" | ")}`);
  // отделка снята раньше первой попытки wall_delete своей стены
  const iFinish = calls.findIndex((c) => c.startsWith("finish_ceiling_remove"));
  const iWall = calls.findIndex((c) => c.startsWith("wall_delete"));
  assert.ok(iFinish >= 0 && iWall > iFinish, `порядок: ластик до стен: ${calls.join(" | ")}`);
  // свои стены удалены, стена пользователя не тронута
  assert.deepEqual(st.walls.map((w) => w.site_id), ["user-wall"]);
  assert.deepEqual(st.delimiters, []);
  // created очищен от удалённых (m1: удалённые стены убираются из created)
  assert.deepEqual(created, []);
  assert.equal(saves, 1, "save один в конце цикла");
});

test("342 m1: restore снимает complex сменой материала и нишу — wall_delete проходит", async () => {
  const st = mkState({
    finish: {
      ceiling: { material: "gypsum_ceiling", complex: true },
      niches: [{ wall: "w1" }],
      ceiling_moldings: [{ wall: "w1" }],
      floor_moldings: [{ wall: "w1", type: "floor_molding_mdf" }],
    },
  });
  const calls: string[] = [];
  const created: ProbeCreated[] = st.walls.filter((w) => w.site_id.startsWith("t")).map((w) => ({ kind: "wall", siteId: w.site_id }));
  const log: string[] = [];
  await restoreByCaptured({ call: mkCall(st, calls), created, ownRoomIds: ["trial"], save: async () => {}, log: (l) => log.push(l) });
  assert.equal(calls.filter((c) => c.startsWith("LOG ")).length, 0, `без отказов: ${log.join(" | ")}`);
  // complex снят сменой материала на ДРУГОЙ
  const iSet = calls.findIndex((c) => c.includes("finish_ceiling_set") && c.includes("stretch_ceiling"));
  assert.ok(iSet >= 0, `complex снят сменой материала: ${calls.join(" | ")}`);
  assert.deepEqual(st.walls.map((w) => w.site_id), ["user-wall"]);
  assert.equal(st.finishes["trial"]!.ceiling, undefined);
  assert.deepEqual(created, []);
});

test("342 m1: restore без снятия отделки (откат) краснеет — wall_delete отказывает", async () => {
  const st = mkState({ finish: { ceiling: { material: "gypsum_ceiling" } } });
  const calls: string[] = [];
  const call = mkCall(st, calls);
  // наивный restore: стены по захваченным ID без снятия отделки
  const created: ProbeCreated[] = st.walls.filter((w) => w.site_id.startsWith("t")).map((w) => ({ kind: "wall", siteId: w.site_id }));
  let refused = "";
  for (const w of created.map((c) => c.siteId)) {
    const mg = await call("model_get", {});
    const hit = (mg["walls"] as Array<{ id: string; site_id: string }>).find((x) => x.site_id === w)!;
    try { await call("wall_delete", { wall_id: hit.id }); }
    catch (e) { refused = String((e as Error).message); break; }
  }
  assert.match(refused, /INVALID_GEOMETRY/, "отделка комнаты блокирует wall_delete (как в живом логе 341)");
  // снятие отделки тем же моком устраняет причину отказа
  await removeRoomFinishByHint(call, "trial", () => {});
  await call("wall_delete", { wall_id: "w1" });
  assert.equal(st.walls.some((w) => w.site_id === "t1"), false, "после снятия отделки wall_delete проходит");
});
