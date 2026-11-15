import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  searchTools, extractGlobalTools, extractToolsBundleName, normalizeQuery, toToolEntry, toolSizeMm,
  type ToolsBundle,
} from "../../src/catalog.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(join(here, "../fixtures/catalog-sample.json"), "utf8"));
const tools = fixture.tools as ToolsBundle;

test("normalizeQuery: регистр и ё/е", () => {
  assert.equal(normalizeQuery("Ёлка  ЁЖИК"), "елка ежик");
  assert.equal(normalizeQuery("  диван "), "диван");
});

test("поиск «диван» находит диваны", () => {
  const res = searchTools(tools, "диван");
  assert.ok(res.length > 0);
  assert.ok(res.some((t) => t.name === "sofa_double"));
  assert.ok(res.every((t) => normalizeQuery(`${t.title} ${t.name} ${t.group} ${t.subgroup ?? ""}`).includes("диван")));
});

test("поиск «унитаз» находит toilet", () => {
  const res = searchTools(tools, "унитаз");
  assert.ok(res.some((t) => t.name === "toilet"));
});

test("размеры отдаются в мм", () => {
  const sofa = searchTools(tools, "sofa", { limit: 1 })[0]!;
  const { widthMm, depthMm, heightMm } = toolSizeMm(sofa);
  assert.equal(widthMm, sofa.width * 10);
  assert.equal(depthMm, sofa.height * 10);
  assert.equal(heightMm, sofa.self_height * 10);
  assert.ok(widthMm >= 500 && widthMm <= 1200, `ширина дивана ${widthMm} мм в разумных пределах`);
});

test("фильтр по группе", () => {
  const res = searchTools(tools, "", { group: "santeh_furniture", limit: 100 });
  assert.ok(res.length > 0);
  assert.ok(res.every((t) => t.group === "santeh_furniture"));
});

test("фильтр по листу (sheet)", () => {
  const res = searchTools(tools, "", { sheet: "furniture", limit: 100 });
  assert.ok(res.length > 0);
  assert.ok(res.every((t) => t.plan["furniture"] !== undefined));
});

test("limit ограничивает выдачу", () => {
  assert.equal(searchTools(tools, "", { limit: 5 }).length, 5);
});

test("поиск без совпадений — пусто", () => {
  assert.deepEqual(searchTools(tools, "космическийкорабль"), []);
});

test("toToolEntry устойчив к отсутствию полей", () => {
  const e = toToolEntry("x", {} as Record<string, unknown>);
  assert.equal(e.title, "x");
  assert.equal(e.width, 0);
  assert.deepEqual(e.plan, {});
});

test("extractGlobalTools парсит бандл (мини-фрагмент)", () => {
  const bundle = 'window.global_tools = {"sofa":{"id":1,"title":"Диван","group":"furniture"}};window.x=1;';
  const tools = extractGlobalTools(bundle);
  assert.deepEqual(tools, { sofa: { id: 1, title: "Диван", group: "furniture" } });
});

test("extractGlobalTools: строки с фигурными скобками и кавычками", () => {
  const bundle = `window.global_tools = {"a":{"path":"M0,0 {x:1} 'q'"},"b":{"t":"}"}};`;
  const tools = extractGlobalTools(bundle);
  assert.ok(tools["a"]);
  assert.equal((tools["b"] as { t: string }).t, "}");
});

test("extractGlobalTools: нет global_tools → EDITOR_INCOMPATIBLE", () => {
  assert.throws(() => extractGlobalTools("var x = 1;"), /global_tools/);
});

test("extractToolsBundleName: имя бандла со страницы редактора", () => {
  const html = `<script src="/files/js/v2/app/planner.tools___94___1794473554.js?123"></script>`;
  assert.equal(extractToolsBundleName(html), "/files/js/v2/app/planner.tools___94___1794473554.js");
  assert.throws(() => extractToolsBundleName("<html></html>"), /planner\.tools/);
});
