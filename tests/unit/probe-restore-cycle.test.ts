// m1 ревью 342 + M1 ревью 344: офлайн-мок полного цикла restore живой пробы.
// Проба scripts/probes/341-tails50-live.ts восстанавливает объект через
// scripts/probes/probe-restore.ts: свои разделители → отделка СВОИХ комнат по
// подсказке реестра (до удаления стен, иначе wall_delete отказывает, как в живом
// логе 341: wall_delete W23 INVALID_GEOMETRY) → свои стены по захваченным
// site_id → save. M1 ревью 344: инструмент finish_get возвращает МАССИВ записей
// комнат (ok(finishList(...))), поэтому ответ мока строит настоящий finishList
// на модели, а снятие отделки выполняют настоящие модельные функции
// src/model/finish.ts (set*/remove* — их отказы повторяют правила редактора:
// ластик complex и при нише отказывают). Мок имитирует только правила редактора
// при wall_delete (отказ, если у исчезающей комнаты есть отделка) и удаление
// стен. Третий тест — иллюстрация: копия наивной логики (стены без снятия
// отделки) в этом моке получает отказ wall_delete; тестом отката он не является.
import test from "node:test";
import assert from "node:assert/strict";
import type { Model } from "../../src/model/types.ts";
import {
  addCeilingNiche, finishList, removeCeilingFinish, removeCeilingMolding,
  removeCeilingNiche, removeFloorFinish, removeFloorMolding, removeWallFinish,
  setCeilingFinish, setFloorFinish, setFloorMolding, setCeilingMolding, setWallFinish,
  type RoomRec,
} from "../../src/model/finish.ts";
import { setCeilingComplex } from "../../src/model/ceiling-complex.ts";
import { restoreByCaptured, removeRoomFinishByHint, type ProbeCall, type ProbeCreated } from "../../scripts/probes/probe-restore.ts";

type Pt = { x: number; y: number };

type MockState = {
  model: Model;
  trial: string;
  user: string;
  trialWalls: string[];
  bottomWall: string;
  delims: string[];
};

/** Прямоугольная комната w×h с 4 стенами (wall0 — нижняя, y = y0). */
function mkRect(id: string, x0: number, y0: number, w: number, h: number): {
  walls: Record<string, unknown>;
  room: RoomRec;
  wallIds: string[];
} {
  const corners: Pt[] = [
    { x: x0, y: y0 }, { x: x0 + w, y: y0 }, { x: x0 + w, y: y0 + h }, { x: x0, y: y0 + h },
  ];
  const wallIds = [`w-${id}-0`, `w-${id}-1`, `w-${id}-2`, `w-${id}-3`];
  const edges = wallIds.map((pid, i) => {
    const p1 = corners[i]!, p2 = corners[(i + 1) % 4]!;
    return { p1, p2, pid, side: "r", length: Math.hypot(p2.x - p1.x, p2.y - p1.y), id: `ed-${id}-${i}` };
  });
  return {
    walls: Object.fromEntries(wallIds.map((wid, i) => [wid, { id: wid, p1: { ...corners[i]! }, p2: { ...corners[(i + 1) % 4]! } }])),
    room: {
      id, plan: "a", polygon: corners.map((p) => ({ ...p })), points: corners.map((p) => ({ ...p })),
      edges, decors: [], floors: [], ceilings: [], floorMoldings: [], ceilingMoldings: [],
    } as unknown as RoomRec,
    wallIds,
  };
}

function mkState(dressTrial: (st: MockState) => void): MockState {
  const a = mkRect("trial", 0, 0, 340, 280);
  const b = mkRect("user", 800, 0, 300, 280);
  const st: MockState = {
    model: {
      walls: { ...a.walls, ...b.walls },
      rooms2: { trial: a.room, user: b.room },
    } as unknown as Model,
    trial: "trial",
    user: "user",
    trialWalls: a.wallIds,
    bottomWall: "w-trial-0",
    delims: ["zd1"],
  };
  dressTrial(st);
  return st;
}

/** Есть ли у комнаты отделка — по НАСТОЯЩЕМУ ответу finishList. */
function dressedOf(st: MockState, rid: string): boolean {
  const entry = finishList(st.model, rid)[0];
  if (!entry) return false;
  return entry["floor"] !== undefined || entry["ceiling"] !== undefined || Array.isArray(entry["ceiling_zones"])
    || (Array.isArray(entry["walls"]) && entry["walls"].length > 0)
    || (Array.isArray(entry["floor_moldings"]) && entry["floor_moldings"].length > 0)
    || (Array.isArray(entry["ceiling_moldings"]) && entry["ceiling_moldings"].length > 0)
    || (Array.isArray(entry["niches"]) && entry["niches"].length > 0);
}

/** Мок «редактора»: форма finish_get — настоящий finishList; снятие отделки —
 *  настоящие модельные функции; правила отказа wall_delete — как в редакторе. */
function mkCall(st: MockState, calls: string[]): ProbeCall {
  return async (name, args) => {
    calls.push(`${name} ${JSON.stringify(args)}`);
    const rid = String(args["room_id"] ?? "");
    switch (name) {
      case "model_get":
        return {
          walls: Object.entries(st.model.walls as Record<string, { p1: Pt; p2: Pt }>).map(([id, w]) => ({
            id, site_id: id, from: [w.p1.x, w.p1.y], to: [w.p2.x, w.p2.y],
          })),
        };
      case "finish_get":
        return finishList(st.model, rid === "" ? undefined : rid) as unknown as Record<string, unknown>;
      case "finish_ceiling_set": {
        const res = setCeilingFinish(st.model, rid, args["material"] as "gypsum_ceiling", { level: args["level"] as number | undefined });
        return res.complexRemoved ? { warnings: ["complex_removed: двухуровневый потолок комнаты снят"] } : {};
      }
      case "finish_ceiling_remove": removeCeilingFinish(st.model, rid); return { removed: "ceiling" };
      case "finish_floor_remove": removeFloorFinish(st.model, rid); return {};
      case "finish_wall_remove": removeWallFinish(st.model, rid); return {};
      case "finish_floor_molding_remove": removeFloorMolding(st.model, rid); return {};
      case "finish_ceiling_molding_remove": removeCeilingMolding(st.model, rid); return {};
      case "finish_ceiling_niche_remove": removeCeilingNiche(st.model, rid); return {};
      case "zone_ceiling_remove": {
        const i = st.delims.indexOf(String(args["delimiter_id"]));
        if (i < 0) throw new Error(`zone_ceiling_remove: разделитель ${String(args["delimiter_id"])} не найден`);
        st.delims.splice(i, 1);
        return {};
      }
      case "wall_delete": {
        const wid = String(args["wall_id"]);
        const w = (st.model.walls as Record<string, unknown>)[wid];
        if (!w) throw new Error("wall_delete: стена не найдена");
        for (const r of Object.keys(st.model.rooms2 as Record<string, unknown>)) {
          const edges = ((st.model.rooms2 as Record<string, RoomRec>)[r]!.edges ?? []) as Array<{ pid?: string }>;
          if (edges.some((e) => e.pid === wid) && dressedOf(st, r)) {
            throw new Error(`wall_delete: {"code":"INVALID_GEOMETRY","message":"отделка комнаты, которая исчезает — снимите её до операции (${r})"}`);
          }
        }
        delete (st.model.walls as Record<string, unknown>)[wid];
        for (const r of Object.keys(st.model.rooms2 as Record<string, RoomRec>)) {
          const edges = ((st.model.rooms2 as Record<string, RoomRec>)[r]!.edges ?? []) as Array<{ pid?: string }>;
          if (edges.some((e) => e.pid === wid)) delete (st.model.rooms2 as Record<string, RoomRec>)[r];
        }
        return { deleted: wid };
      }
      case "project_save":
        return { verified: true, warnings: [] };
      default:
        throw new Error(`мок не знает инструмент ${name}`);
    }
  };
}

function trialWallsOf(st: MockState): ProbeCreated[] {
  return st.trialWalls.map((s) => ({ kind: "wall", siteId: s }));
}

test("344 M1: finish_get в моке отвечает массивом (форма настоящего finishList)", async () => {
  const st = mkState((s) => {
    setFloorFinish(s.model, s.trial, "laminate", {});
    setCeilingFinish(s.model, s.trial, "gypsum_ceiling", { level: 0 });
  });
  const calls: string[] = [];
  const res = await mkCall(st, calls)("finish_get", { room_id: st.trial });
  assert.ok(Array.isArray(res), "finish_get — массив записей комнат (M1 ревью 344), не объект");
  const list = res as Array<Record<string, unknown>>;
  assert.equal(list.length, 1, "room_id фильтрует до одной записи");
  assert.equal(list[0]!["site_id"], st.trial);
  assert.equal(list[0]!["id"], "R1");
  assert.ok(list[0]!["floor"] !== undefined, "пол в записи");
  assert.ok(list[0]!["ceiling"] !== undefined, "потолок в записи");
  // старая форма (объект с полями комнаты) ломала restore: у массива нет полей отделки
  assert.equal((res as unknown as Record<string, unknown>)["ceiling"], undefined);
});

test("344 M1: removeRoomFinishByHint берёт запись комнаты из массива по site_id — своя комната зачищена, чужая не тронута", async () => {
  const st = mkState((s) => {
    setFloorFinish(s.model, s.trial, "laminate", {});
    setCeilingFinish(s.model, s.trial, "gypsum_ceiling", { level: 0 });
    setWallFinish(s.model, s.trial, s.bottomWall, "wallpaper", {});
    setFloorMolding(s.model, s.trial, s.bottomWall, "floor_molding_mdf", {});
    setCeilingMolding(s.model, s.trial, s.bottomWall, {});
    addCeilingNiche(s.model, s.trial, s.bottomWall);
  });
  const calls: string[] = [];
  const log: string[] = [];
  await removeRoomFinishByHint(mkCall(st, calls), st.trial, (l) => log.push(l));
  assert.equal(log.length, 0, `без отказов: ${log.join(" | ")}`);
  // отделка своей комнаты снята (проверка по настоящему finishList)
  const entry = finishList(st.model, st.trial)[0]!;
  assert.equal(entry["floor"], undefined);
  assert.equal(entry["ceiling"], undefined);
  assert.equal(Array.isArray(entry["walls"]) && (entry["walls"] as unknown[]).length > 0, false);
  assert.equal(Array.isArray(entry["floor_moldings"]) && (entry["floor_moldings"] as unknown[]).length > 0, false);
  assert.equal(Array.isArray(entry["ceiling_moldings"]) && (entry["ceiling_moldings"] as unknown[]).length > 0, false);
  assert.equal(Array.isArray(entry["niches"]) && (entry["niches"] as unknown[]).length > 0, false);
  // чужая комната не тронута
  assert.equal(dressedOf(st, st.user), false, "чужая комната без отделки и без вызовов");
  assert.deepEqual(Object.keys(st.model.rooms2 as Record<string, unknown>).sort(), ["trial", "user"]);
  // порядок снятия — по реестру: ниша → потолочный плинтус → плинтус пола → ластик потолка → пол → стены
  const idx = (t: string): number => calls.findIndex((c) => c.startsWith(t));
  const seq = ["finish_ceiling_niche_remove", "finish_ceiling_molding_remove", "finish_floor_molding_remove", "finish_ceiling_remove", "finish_floor_remove", "finish_wall_remove"].map(idx);
  assert.ok(seq.every((i) => i >= 0), `все шаги выполнены: ${calls.join(" | ")}`);
  assert.deepEqual([...seq].sort((a, b) => a - b), seq, `порядок по реестру: ${calls.join(" | ")}`);
});

test("342 m1: restore снимает отделку своей комнаты до wall_delete — полный цикл без отказов", async () => {
  const st = mkState((s) => {
    setFloorFinish(s.model, s.trial, "laminate", {});
    setCeilingFinish(s.model, s.trial, "gypsum_ceiling", { level: 0 });
  });
  const calls: string[] = [];
  const log: string[] = [];
  const created: ProbeCreated[] = [...trialWallsOf(st), { kind: "delimiter", siteId: "zd1" }];
  let saves = 0;
  await restoreByCaptured({ call: mkCall(st, calls), created, ownRoomIds: [st.trial], save: async () => { saves++; }, log: (l) => log.push(l) });
  // m2 ревью 344: проверяется именно лог отказов, а не фильтр по префиксу
  assert.equal(log.length, 0, `без отказов: ${log.join(" | ")}`);
  // отделка снята раньше первой попытки wall_delete своей стены
  const iFinish = calls.findIndex((c) => c.startsWith("finish_ceiling_remove"));
  const iWall = calls.findIndex((c) => c.startsWith("wall_delete"));
  assert.ok(iFinish >= 0 && iWall > iFinish, `порядок: ластик до стен: ${calls.join(" | ")}`);
  // свои стены удалены, стена пользователя не тронута
  assert.deepEqual(Object.keys(st.model.walls as Record<string, unknown>).sort(), ["w-user-0", "w-user-1", "w-user-2", "w-user-3"]);
  assert.deepEqual(Object.keys(st.model.rooms2 as Record<string, unknown>), ["user"]);
  assert.deepEqual(st.delims, []);
  // created очищен от удалённых (m1: удалённые стены убираются из created)
  assert.deepEqual(created, []);
  assert.equal(saves, 1, "save один в конце цикла");
});

test("342 m1: restore снимает complex сменой материала, нишу и плинтусы — wall_delete проходит", async () => {
  const st = mkState((s) => {
    setCeilingFinish(s.model, s.trial, "gypsum_ceiling", { level: 0 });
    setCeilingComplex(s.model, s.trial);
    addCeilingNiche(s.model, s.trial, s.bottomWall);
    setCeilingMolding(s.model, s.trial, s.bottomWall, {});
    setFloorMolding(s.model, s.trial, s.bottomWall, "floor_molding_mdf", {});
    setFloorFinish(s.model, s.trial, "laminate", {});
    setWallFinish(s.model, s.trial, s.bottomWall, "wallpaper", {});
  });
  const calls: string[] = [];
  const log: string[] = [];
  const created = trialWallsOf(st);
  await restoreByCaptured({ call: mkCall(st, calls), created, ownRoomIds: [st.trial], save: async () => {}, log: (l) => log.push(l) });
  assert.equal(log.length, 0, `без отказов: ${log.join(" | ")}`);
  // complex снят сменой материала на ДРУГОЙ
  const iSet = calls.findIndex((c) => c.includes("finish_ceiling_set") && c.includes("stretch_ceiling"));
  assert.ok(iSet >= 0, `complex снят сменой материала: ${calls.join(" | ")}`);
  // все виды отделки сняты до стен — настоящими модельными функциями через finish_get
  const iLastFinish = calls.findIndex((c) => c.startsWith("finish_wall_remove"));
  const iWall = calls.findIndex((c) => c.startsWith("wall_delete"));
  assert.ok(iWall > iLastFinish, `снятие отделки до wall_delete: ${calls.join(" | ")}`);
  assert.deepEqual(Object.keys(st.model.walls as Record<string, unknown>).sort(), ["w-user-0", "w-user-1", "w-user-2", "w-user-3"]);
  assert.deepEqual(created, []);
});

test("342 m1: иллюстрация — наивный restore (копия логики без снятия отделки) получает отказ wall_delete", async () => {
  const st = mkState((s) => {
    setCeilingFinish(s.model, s.trial, "gypsum_ceiling", { level: 0 });
  });
  const calls: string[] = [];
  const call = mkCall(st, calls);
  const created = trialWallsOf(st);
  let refused = "";
  for (const w of created.map((c) => c.siteId)) {
    const mg = await call("model_get", {});
    const hit = (mg["walls"] as Array<{ id: string; site_id: string }>).find((x) => x.site_id === w)!;
    try { await call("wall_delete", { wall_id: hit.id }); }
    catch (e) { refused = String((e as Error).message); break; }
  }
  assert.match(refused, /INVALID_GEOMETRY/, "отделка комнаты блокирует wall_delete (как в живом логе 341)");
  // снятие отделки настоящей логикой подсказки устраняет причину отказа
  await removeRoomFinishByHint(call, st.trial, () => {});
  await call("wall_delete", { wall_id: "w-trial-0" });
  assert.equal(Object.keys(st.model.rooms2 as Record<string, unknown>).includes(st.trial), false, "после снятия отделки wall_delete проходит, комната исчезает");
});
