// Этап 394, №15 follow-up 392: офлайн-проверка формата ответов инструментов
// развёрток через вызов обработчиков (planTools + offline-фикстура): ключи
// ответа, мм (целые числа), отсутствие полей формата редактора (prs/pc/p).
// Формат — major 5 ревью 390 (prsFigurePublic): до этого был покрыт только
// живым прогоном 391-2, мутация «вернуть prs: rec.prs» оставалась зелёной.
import "./helpers/tmp-home.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { planTools } from "../../src/server/tools-plan.ts";
import { ServerContext } from "../../src/server/context.ts";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, "../fixtures/ui-ref-unfold-responses.json");

type ToolResultLike = { content: Array<{ type: string; text?: string }> };
const text = (r: unknown): Record<string, unknown> =>
  JSON.parse(((r as ToolResultLike).content as Array<{ text?: string }>).map((c) => c.text ?? "").join("")) as Record<string, unknown>;
const handler = async (name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
  const ctx = new ServerContext({ offlineFixture: FIXTURE });
  const res = await planTools(ctx)[name]!.handler(args);
  assert.equal((res as { isError?: boolean }).isError, undefined, `${name} без ошибки: ${text(res)["error"] ?? ""}`);
  return text(res);
};

test("392 №15: prs_set — ответ snake_case, ключи развёрток, без полей редактора", async () => {
  const out = text(await planTools(new ServerContext({ offlineFixture: FIXTURE }))["prs_set"]!.handler({ room: "R1", hide_walls: ["w2"] }));
  assert.deepEqual(
    Object.keys(out).sort(),
    ["disabled_edges", "first_edge", "hidden", "hint", "room"],
    `ключи ответа prs_set: ${JSON.stringify(Object.keys(out))}`,
  );
  assert.equal(out["hidden"], false);
  assert.deepEqual(out["disabled_edges"], [1]);
  assert.equal(out["first_edge"], null);
});

test("392 №15: wall_molding_add/update — мм, ключи model_get, без prs/pc/p", async () => {
  const tools = planTools(new ServerContext({ offlineFixture: FIXTURE }));
  const add = text(
    await tools["wall_molding_add"]!.handler({
      room: "R1", wall: "w1", along_mm: 1000, bottom_mm: 1200, width_mm: 600, height_mm: 30,
    }),
  );
  assert.deepEqual(
    Object.keys(add).sort(),
    ["along_mm", "edge_index", "from_floor_mm", "height_mm", "hint", "molding_id", "room", "site_id", "type", "width_line_mm", "width_mm"],
    `ключи ответа wall_molding_add: ${JSON.stringify(Object.keys(add))}`,
  );
  for (const k of ["along_mm", "from_floor_mm", "width_mm", "height_mm", "width_line_mm", "edge_index"]) {
    assert.equal(typeof add[k], "number", `${k} — число (мм)`);
    assert.ok(Number.isInteger(add[k] as number), `${k} — целое число мм: ${String(add[k])}`);
  }
  assert.equal(add["along_mm"], 1000, "along_mm — мм от начала развёртки");
  assert.equal(add["from_floor_mm"], 1200, "from_floor_mm — мм от пола");
  assert.equal(add["width_line_mm"], 40, "width_line_mm — мм (умолчание 40)");
  assert.equal(add["room"], "R1");
  for (const bad of ["prs", "pc", "pc_xd", "pc_yd", "p", "plan"]) {
    assert.equal(bad in add, false, `${bad} — формат редактора не протекает`);
  }
  const upd = text(
    await tools["wall_molding_update"]!.handler({
      molding_id: "WM1", along_mm: 2000, bottom_mm: 1000, width_mm: 500, height_mm: 200,
    }),
  );
  assert.deepEqual(
    Object.keys(upd).sort(),
    ["along_mm", "edge_index", "from_floor_mm", "height_mm", "hint", "molding_id", "room", "site_id", "type", "width_line_mm", "width_mm"],
    `ключи ответа wall_molding_update: ${JSON.stringify(Object.keys(upd))}`,
  );
  assert.equal(upd["along_mm"], 2000);
  assert.equal(upd["from_floor_mm"], 1000);
  for (const bad of ["prs", "pc", "pc_xd", "pc_yd", "p"]) {
    assert.equal(bad in upd, false, `${bad} — формат редактора не протекает`);
  }
});

test("392 №15: wall_niche_add/update — мм, depth_mm, без prs/pc/p", async () => {
  const tools = planTools(new ServerContext({ offlineFixture: FIXTURE }));
  const add = text(
    await tools["wall_niche_add"]!.handler({
      room: "R1", wall: "w3", along_mm: 2000, bottom_mm: 1000, width_mm: 800, height_mm: 1200,
    }),
  );
  assert.deepEqual(
    Object.keys(add).sort(),
    ["along_mm", "depth_mm", "edge_index", "from_floor_mm", "height_mm", "hint", "niche_id", "room", "site_id", "type", "width_mm"],
    `ключи ответа wall_niche_add: ${JSON.stringify(Object.keys(add))}`,
  );
  assert.equal(add["depth_mm"], 200, "depth_mm — мм (умолчание 200)");
  assert.equal(add["from_floor_mm"], 1000);
  for (const bad of ["prs", "pc", "pc_xd", "pc_yd", "p"]) {
    assert.equal(bad in add, false, `${bad} — формат редактора не протекает`);
  }
  const upd = text(
    await tools["wall_niche_update"]!.handler({
      niche_id: "WN1", along_mm: 2500, depth_mm: 150,
    }),
  );
  assert.deepEqual(
    Object.keys(upd).sort(),
    ["along_mm", "depth_mm", "edge_index", "from_floor_mm", "height_mm", "hint", "niche_id", "room", "site_id", "type", "width_mm"],
    `ключи ответа wall_niche_update: ${JSON.stringify(Object.keys(upd))}`,
  );
  assert.equal(upd["depth_mm"], 150);
});

test("392 №15: finish_wall_anchor_set — ответ в мм (edge/along_mm/height_mm/part/layer/angle), без anchor/p", async () => {
  const out = text(
    await planTools(new ServerContext({ offlineFixture: FIXTURE }))["finish_wall_anchor_set"]!.handler({
      room: "R1", wall: "w1", along_mm: 1000, height_mm: 800,
    }),
  );
  assert.deepEqual(
    Object.keys(out).sort(),
    ["along_mm", "angle", "edge", "height_mm", "hint", "layer", "part"],
    `ключи ответа finish_wall_anchor_set: ${JSON.stringify(Object.keys(out))}`,
  );
  assert.equal(out["along_mm"], 1000);
  assert.equal(out["height_mm"], 800);
  assert.equal(out["part"], "p1");
  assert.equal(out["layer"], 1);
  assert.equal(out["angle"], 0);
  for (const bad of ["anchor", "p", "pc", "pc_xd", "pc_yd", "prs"]) {
    assert.equal(bad in out, false, `${bad} — формат редактора не протекает`);
  }
});
