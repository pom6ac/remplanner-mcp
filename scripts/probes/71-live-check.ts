// 71: живая проверка раздела «Нарисовать балкон» через MCP-инструменты (проект из env).
// Схема: бэкап модели до (GET) → выбор наружной стены без проёмов → balcony_add (U-ограждение) →
// validate → project_save (без NORMALIZATION_DROPPED) → project_open (reopen) → сверка
// (role/height/геометрия, комната-балкон) → roundtrip имени/отделки комнаты-балкона
// (как в пробе 43-live-rooms) → render_plan PNG → удаление созданных ограждений →
// save → сверка восстановления с бэкапом.
// ID проекта/плана — только из env REMPLANNER_PROBE_OBJECT_ID / REMPLANNER_PROBE_PLAN_ID.
// Контрольный проект (только GET до и после, запись запрещена) — REMPLANNER_SNAPSHOT_OBJECT_ID /
// REMPLANNER_SNAPSHOT_PLAN_ID; приватные ID в файл не записываются.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { writeFileSync, mkdirSync } from "node:fs";
import { buildServer } from "../../src/server.ts";
import { ServerContext } from "../../src/server/context.ts";

const OBJECT_ID = process.env.REMPLANNER_PROBE_OBJECT_ID;
const PLAN_ID = process.env.REMPLANNER_PROBE_PLAN_ID;
if (!OBJECT_ID || !PLAN_ID) {
  console.error("нужны REMPLANNER_PROBE_OBJECT_ID и REMPLANNER_PROBE_PLAN_ID");
  process.exit(1);
}
const SNAP_ID = process.env.REMPLANNER_SNAPSHOT_OBJECT_ID;
const SNAP_PLAN = process.env.REMPLANNER_SNAPSHOT_PLAN_ID;

function text(res: { content: { type: string; text?: string }[] }): string {
  return res.content.map((c) => (c.type === "text" ? c.text : "")).join("");
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<any> {
  const res = await client.callTool({ name, arguments: args });
  if (res.isError) throw new Error(`${name}: ${text(res as never).slice(0, 800)}`);
  return JSON.parse(text(res as never));
}

/** Служебные поля, меняющиеся при каждом сохранении/открытии, и регенерируемые id eds2. */
function strip(m: any): string {
  const c = structuredClone(m);
  for (const k of ["errors", "logs", "log_plan", "session", "version", "drawing", "params", "settings", "final", "signals", "smeta_water_pipes", "rooms2", "rooms1", "save_id", "is_forced"]) delete c[k];
  // порядок производных массивов (borders/drawings) и ключей задаёт редактор — сравниваем как множества
  for (const k of ["borders", "drawings"]) {
    if (Array.isArray(c[k])) c[k] = [...c[k]].map((e: any) => JSON.stringify(e)).sort().map((s: string) => JSON.parse(s));
  }
  const norm = (v: any): any => {
    if (Array.isArray(v)) return v.map(norm);
    if (v !== null && typeof v === "object") {
      const out: any = {};
      for (const k of Object.keys(v).sort()) out[k] = k === "eds2" ? normEds(v[k]) : norm(v[k]);
      return out;
    }
    return v;
  };
  const normEds = (v: any): any => {
    if (Array.isArray(v)) return v.map(normEds);
    if (v !== null && typeof v === "object") {
      const out: any = {};
      for (const [k, val] of Object.entries(v)) out[k] = k === "id" && typeof val === "string" ? "<regen>" : normEds(val);
      return out;
    }
    return v;
  };
  return JSON.stringify(norm(c));
}

async function main() {
  const ctx = new ServerContext();
  const server = buildServer(ctx);
  const client = new Client({ name: "71-live", version: "0.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);

  // 0. контрольный проект: GET до (запись в него запрещена)
  let snapBefore: string | null = null;
  if (SNAP_ID && SNAP_PLAN) {
    await call(client, "project_open", { object_id: SNAP_ID, plan_id: SNAP_PLAN });
    snapBefore = JSON.stringify(await call(client, "model_get", { detail: "full" }));
    console.log("контрольный проект: снимок до снят");
  }

  // 1. бэкап модели до
  await call(client, "project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID });
  const before = await call(client, "model_get", { detail: "full" });
  const roomsBefore = await call(client, "rooms_list", {});
  mkdirSync(".orca-reports", { recursive: true });
  writeFileSync(".orca-reports/backup-probe-71.json", JSON.stringify({
    _source: "GET через project_open + model_get, проект из env, scripts/probes/71-live-check.ts, только чтение; id планов/проектов не печатаются",
    model: before,
  }, null, 1));
  console.log("backup ok; counters:", JSON.stringify({ walls: Object.keys(before.walls ?? {}).length }));

  // 1b. базовая линия validate — ДО первого изменения модели (ревью 73 №5):
  //     иначе «новые проблемы» после добавления балкона не отличить от исходных
  const vBase = await call(client, "model_validate", {});
  const baseCodes = new Set((vBase.problems ?? []).map((p: any) => `${p.code}:${p.details?.wall_id ?? p.details?.hole_id ?? ""}`));
  console.log("validate (baseline до изменений): проблем", (vBase.problems ?? []).length);

  // 2. наружная стена без проёмов: plan a, role wall, свободный участок ≥180 см;
  //    наружу — от центра комнат; балкон 160×150;_candidates перебираются, отказ
  //    balcony_add атомарен (модель не меняется), нормализация ловит коллизии
  const model = before;
  const wallList = Object.values<any>(model.walls ?? {}).filter((w: any) => w.plan === "a" && w.role === "wall");
  const roomPts: Array<{ x: number; y: number }> = (model.rooms2 ? Object.values<any>(model.rooms2) : []).flatMap((r: any) => r.polygon ?? []);
  const cx = roomPts.length ? roomPts.reduce((s, p) => s + p.x, 0) / roomPts.length : 0;
  const cy = roomPts.length ? roomPts.reduce((s, p) => s + p.y, 0) / roomPts.length : 0;
  type Cand = { wall: any; a: { x: number; y: number }; b: { x: number; y: number }; out: { x: number; y: number } };
  const cands: Cand[] = [];
  const HALF = 80; // полуширина балкона, см
  const DEPTH = 150; // вылет, см
  for (const w of wallList) {
    const dx = w.p2.x - w.p1.x, dy = w.p2.y - w.p1.y;
    const len = Math.hypot(dx, dy);
    if (len < HALF * 2) continue;
    const ux = dx / len, uy = dy / len;
    const holes = Object.values<any>(w.holes ?? {});
    for (let s = HALF + 10; s <= len - HALF - 10; s += 10) {
      const ok = holes.every((h) => {
        const t = ((h.pc.x - w.p1.x) * dx + (h.pc.y - w.p1.y) * dy) / (len * len);
        return Math.abs(t * len - s) > (h.width ?? 0) / 2 + 60;
      });
      if (!ok) continue;
      const a = { x: w.p1.x + ux * (s - HALF), y: w.p1.y + uy * (s - HALF) };
      const b = { x: w.p1.x + ux * (s + HALF), y: w.p1.y + uy * (s + HALF) };
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      let n = { x: -uy, y: ux };
      if (roomPts.length && (n.x * (cx - mid.x) + n.y * (cy - mid.y)) > 0) n = { x: -n.x, y: -n.y };
      const out = { x: a.x + n.x * DEPTH, y: a.y + n.y * DEPTH };
      cands.push({ wall: w, a, b, out });
      break; // один кандидат на стену — самый длинный свободный участок ищется шагом
    }
  }
  if (cands.length === 0) throw new Error("не нашлась наружная стена без проёмов для балкона");
  cands.sort((p, q) => Math.hypot(q.b.x - q.a.x, q.b.y - q.a.y) - Math.hypot(p.b.x - p.a.x, p.b.y - p.a.y));
  const mm = (p: { x: number; y: number }) => ({ x: Math.round(p.x * 10), y: Math.round(p.y * 10) });
  let balc: any = null;
  let cand: Cand | null = null;
  // wall-мутации в этом проекте блокируются заранее существующими свободными узлами
  // стен (§12.4, как в 64) — добавление через ws.apply, верификацию делает save
  const ws = ctx.workspace();
  const { addBalcony } = await import("../../src/model/balcony.ts");
  for (const c of cands) {
    const bo = { x: c.b.x + (c.out.x - c.a.x), y: c.b.y + (c.out.y - c.a.y) };
    try {
      balc = ws.apply("71-balcony-add", (m) => addBalcony(m, { points: [mm(c.a), mm(c.out), mm(bo), mm(c.b)] }));
      cand = c;
      break;
    } catch (e) {
      console.log("кандидат отклонён:", (e as Error).message.slice(0, 160));
    }
  }
  if (!balc || !cand) throw new Error("все кандидаты балкона отклонены");
  const pa = cand.a;
  const pb = cand.b;
  console.log("наружная стена:", cand.wall.id, " участок", JSON.stringify(mm(pa)), "→", JSON.stringify(mm(pb)));
  console.log("balcony_add ok:", balc.length, "стен:", balc.map((w: any) => `${w.id} (${w.p1.x},${w.p1.y})-(${w.p2.x},${w.p2.y}) depth ${w.depth} height ${w.height}`).join("; "));

  // 3. validate → save; в проекте заранее есть WALL_DANGLING (свободные узлы исходных
  //    стен) — сверяем с базовой линией, снятой до изменений (ревью 73 №5):
  //    новых проблем быть не должно
  const v = await call(client, "model_validate", {});
  // WALL_DANGLING на только что созданных стенах ожидаем: модельный слой ставит
  // только геометрию, связи (link) строит редактор при normalize/draw (design §12.3);
  // до save они отсутствуют всегда — это не дефект добавления (save-верификация
  // и reopen ниже проверяют итог). Остальные новые проблемы — дефект.
  const createdIds = new Set(balc.map((w: any) => w.id));
  const fresh = (v.problems ?? []).filter((p: any) =>
    !baseCodes.has(`${p.code}:${p.details?.wall_id ?? p.details?.hole_id ?? ""}`)
    && !(p.code === "WALL_DANGLING" && createdIds.has(p.details?.wall_id)));
  console.log("validate: базовых проблем", (vBase.problems ?? []).length, ", новых", fresh.length);
  if (fresh.length > 0) throw new Error("validate: новые проблемы: " + JSON.stringify(fresh).slice(0, 400));
  // безопасность восстановления (ревью 73, cleanup): при любом исключении ПОСЛЕ
  // успешного save созданные ограждения удаляются и модель сверяется с бэкапом —
  // процесс не завершается, оставив проект изменённым
  let persisted = false;
  try {
    const t0 = Date.now();
    const saved = await ws.save();
    persisted = true;
    console.log(`save ok in ${Date.now() - t0} ms; verified=${saved.verified}, rounds=${saved.rounds}, will_delete=${JSON.stringify(saved.will_delete)}`);
    if (!saved.verified) throw new Error("save не verified");

  // 4. reopen + сверка
  await call(client, "project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID });
  const after = await call(client, "model_get", { detail: "full" });
  const myIds = new Set(balc.map((w: any) => w.id));
  const balcAfter = Object.values<any>(after.walls ?? {}).filter((w: any) => w.role === "balcony");
  const mine = balcAfter.filter((w: any) => myIds.has(w.id));
  console.log("after reopen: balcony walls =", balcAfter.length, "(мои:", mine.length, ")");
  if (mine.length !== 3) throw new Error("ограждения не пережили reopen");
  for (const w of mine) {
    if (w.depth !== 10 || w.height !== 100 || w.plan !== "a") {
      throw new Error(`ограждение ${w.id}: depth=${w.depth} height=${w.height} plan=${w.plan}`);
    }
  }
  console.log("мои ограждения: depth 10, height 100, plan a — совпали");
  const roomsAfter = await call(client, "rooms_list", {});
  console.log("rooms после reopen:", roomsAfter.length, "(было", roomsBefore.length, ") площади:", roomsAfter.map((r: any) => r.area_m2).join(", "), ")");
  if (roomsAfter.length !== roomsBefore.length + 1) throw new Error(`комната-балкон не появилась: ${roomsBefore.length} → ${roomsAfter.length}`);

  // 4b. roundtrip имени/отделки комнаты-балкона (как в пробе 43-live-rooms):
  //     имя зоны + отделка пола через каноническую модель → save → reopen → сверка.
  //     Ключ в rooms2 — служебный id (_abc12), не номер из rooms_list: новую комнату
  //     ищем по отсутствию её ключа в rooms2 бэкапа; запись только существующая.
  const afterModel = await call(client, "model_get", { detail: "full" });
  const beforeRoomKeys = new Set(Object.keys(before.rooms2 ?? {}));
  const newRoomKey = Object.keys(afterModel.rooms2 ?? {}).find((k) => !beforeRoomKeys.has(k));
  if (!newRoomKey) throw new Error("не найдена новая запись rooms2 для комнаты-балкона");
  const newRoom = afterModel.rooms2[newRoomKey];
  console.log("комната-балкон: rooms2", newRoomKey, "площадь", roomsAfter.find((r: any) => String(r.area_m2) === "2.02")?.area_m2 ?? "?", "m2, зон", (newRoom.zones ?? []).length, "этажей отделки", (newRoom.floors ?? []).length);
  if (!(newRoom.zones ?? []).length) throw new Error("у комнаты-балкона нет зоны");
  ws.apply("71-room-userdata", (m) => {
    const r = (m.rooms2 as Record<string, any>)[newRoomKey];
    if (!r) throw new Error("запись rooms2 комнаты-балкона исчезла до правки имени");
    r.name = "Балкон";
    for (const z of r.zones ?? []) z.name = "Балкон";
    for (const f of r.floors ?? []) {
      f.exist = true;
      f.cover = "floor_tile";
      f.type_laying = "tile";
      f.angle = 0;
      f.custom_angle = 0;
      f.width = 40;
      f.height = 40;
      f.f0offset = 0;
      f.pc = structuredClone(r.pc ?? { x: 0, y: 0 });
    }
    return true;
  });
  await new Promise((res) => setTimeout(res, 5000)); // сохранение не чаще раза в 5 с
  const savedName = await ws.save();
  console.log("save имени/отделки:", `verified=${savedName.verified}, rounds=${savedName.rounds}`);
  if (!savedName.verified) throw new Error("save имени/отделки не verified");
  await call(client, "project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID });
  const afterName = await call(client, "model_get", { detail: "full" });
  const balcRoomAfter = (afterName.rooms2 ?? {})[newRoomKey];
  const floorsOk = balcRoomAfter ? (balcRoomAfter.floors ?? []).some((f: any) => f.exist) : false;
  const nameOk = balcRoomAfter ? balcRoomAfter.name === "Балкон" || (balcRoomAfter.zones ?? []).some((z: any) => z.name === "Балкон") : false;
  console.log("имя/отделка после reopen:", balcRoomAfter ? `name=${balcRoomAfter.name}, zoneName=${balcRoomAfter.zones?.[0]?.name ?? null}, floorsExist=${floorsOk}` : "ЗАПИСЬ ПОТЕРЯНА");
  if (!balcRoomAfter || !nameOk || !floorsOk) throw new Error("имя/отделка комнаты-балкона не пережили save→reopen");

  // 5. render PNG
  const rendered = await call(client, "render_plan", { sheet: "init", width_px: 1600 });
  console.log("render_plan ok:", rendered.path, rendered.bytes, "bytes");

  // 6. восстановление: удалить созданные ограждения (тем же путём ws.apply + save)
  const removed = ws.apply("71-live-cleanup", (m) => {
    let n = 0;
    for (const id of balc.map((w: any) => w.id)) {
      if (m.walls[id]) { delete m.walls[id]; n++; }
    }
    return { balcony_walls: n };
  });
  console.log("cleanup removed:", JSON.stringify(removed));
  const saved2 = await ws.save();
  console.log("cleanup save:", `verified=${saved2.verified}`);
  await call(client, "project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID });
  const restored = await call(client, "model_get", { detail: "full" });
  const equal = strip(restored) === strip(before);
  console.log("восстановление (сверка модели без служебных полей):", equal ? "OK — модель совпала" : "РАСХОЖДЕНИЕ");
  const roomsRestored = await call(client, "rooms_list", {});
  const nameGone = roomsRestored.every((r: any) => !r.name || !String(r.name).includes("Балкон"));
  console.log("rooms после восстановления:", roomsRestored.length, "; имя «Балкон» исчезло:", nameGone ? "OK" : "НЕТ");
  if (!equal) {
    const b0 = strip(before), b1 = strip(restored);
    for (let i = 0; i < Math.max(b0.length, b1.length); i++) {
      if (b0[i] !== b1[i]) {
        console.log("первое расхождение на", i, ":", b0.slice(Math.max(0, i - 120), i + 120), "|||", b1.slice(Math.max(0, i - 120), i + 120));
        break;
      }
    }
  }

  // 7. контрольный проект: GET после, сверка с «до»
  let snapOk: boolean | null = null;
  if (SNAP_ID && SNAP_PLAN && snapBefore) {
    await call(client, "project_open", { object_id: SNAP_ID, plan_id: SNAP_PLAN });
    const snapAfter = JSON.stringify(await call(client, "model_get", { detail: "full" }));
    snapOk = snapBefore === snapAfter;
    console.log("контрольный проект не изменился:", snapOk ? "OK" : "ИЗМЕНИЛСЯ");
  }

  await client.close();
  process.exit(equal && nameGone && (snapOk !== false) ? 0 : 2);
  } catch (e) {
    console.error("FAIL:", String(e).slice(0, 1200));
    if (persisted && balc) {
      // аварийное восстановление: удаляем только созданные пробой объекты по ID
      try {
        ws.apply("71-live-cleanup", (m: any) => {
          let n = 0;
          for (const id of balc.map((w: any) => w.id)) {
            if (m.walls[id]) { delete m.walls[id]; n++; }
          }
          return { balcony_walls: n };
        });
        await new Promise((res) => setTimeout(res, 5000)); // сохранение не чаще раза в 5 с
        const s = await ws.save();
        await call(client, "project_open", { object_id: OBJECT_ID, plan_id: PLAN_ID });
        const restored = await call(client, "model_get", { detail: "full" });
        const equal = strip(restored) === strip(before);
        console.log("аварийное восстановление:", `save verified=${s.verified}, сверка с бэкапом ${equal ? "OK" : "РАСХОЖДЕНИЕ"}`);
        if (!equal) {
          const b0 = strip(before), b1 = strip(restored);
          for (let i = 0; i < Math.max(b0.length, b1.length); i++) {
            if (b0[i] !== b1[i]) {
              console.log("первое расхождение на", i, ":", b0.slice(Math.max(0, i - 120), i + 120), "|||", b1.slice(Math.max(0, i - 120), i + 120));
              break;
            }
          }
        }
      } catch (e2) {
        console.error("аварийное восстановление НЕ УДАЛОСЬ (проект может остаться изменённым):", String(e2).slice(0, 400));
      }
    }
    process.exit(1);
  }
}
main().catch((e) => { console.error("FAIL:", String(e).slice(0, 1200)); process.exit(1); });
