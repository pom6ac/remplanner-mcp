// 53-stairs: сборка эталонов ui-ref-stair-<name>.json из дампов пробы 53-stairs-ui (офлайн, без сети).
// Обезличивание: id предмета → "0", id_room/id_room_zone/id_wall/id_wall_old → "0".
// node scripts/probes/53-stairs-fixtures.ts
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const SRC = ".orca-reports/53-stairs-ui";
const GT = "../../.orca-reports/53-stairs-ui/scout.json";
const OUT = "tests/fixtures";
mkdirSync(OUT, { recursive: true });

const gt = JSON.parse(readFileSync(GT, "utf8")).global_tools_stairs as Record<string, any>;

type Spec = { key: string; dump: string; menu: string; note: string };
const SPECS: Spec[] = [
  { key: "ladder_march", dump: "ladder_march", menu: "Прямая маршевая лестница", note: "свободная постановка кликом в комнате; план {furniture:6, a:1}" },
  { key: "ladder_2march", dump: "ladder_2march", menu: "Лестница с площадкой", note: "свободная постановка; второй базовый вид 260×160" },
  { key: "spiral_staircase", dump: "spiral_staircase", menu: "Спиральная лестница", note: "магнит к стене: id_wall, wall_direction, wall_line" },
  { key: "upper_march", dump: "upper_march-click", menu: "Спуск лестницы", note: "план {a:1} (ключ каталога init отображён в a); угол -90 у точки клика" },
  { key: "porch", dump: "porch-wall-click", menu: "Лестница для крыльца", note: "anchor:wall, can_be_outside:1; projection и wall_line; угол 180" },
  { key: "stair_spot", dump: "stair_spot-wall-click", menu: "Светильник для подсветки пола", note: "группа lights, over_floor {value:20, display:true}, магнит к стене" },
];

const ZERO_ID = new Set(["id", "id_room", "id_room_zone", "id_wall", "id_wall_old"]);

for (const s of SPECS) {
  const rec = JSON.parse(readFileSync(`${SRC}/${s.dump}.json`, "utf8"));
  const added = Object.entries<any>(rec.added ?? {}).filter(([k]) => k.startsWith("items/"));
  if (!added.length) { console.error(`${s.key}: в дампе ${s.dump} нет предмета`); continue; }
  const [, rawItem] = added[0]!;
  const item: Record<string, unknown> = {};
  for (const [f, v] of Object.entries<any>(rawItem)) item[f] = ZERO_ID.has(f) ? "0" : v;
  const entry = gt[s.key] ?? gt[s.key.replace("-fan", "-fan")] ?? {};
  const fixture = {
    _source: "клик по UI dev-проекта (headless Chromium, ID проекта/плана обезличены), scripts/probes/53-stairs-ui.ts, "
      + "model project.copy(\"server\"), без сохранения; id предмета и id_room/id_room_zone/id_wall обезличены (\"0\"); "
      + "координаты — реальные точки листа init (не идентифицируют); " + s.note,
    menu_title: s.menu,
    tool_id: `plannertool_${s.key}`,
    catalog_defaults_cm: {
      id: entry.id, width: entry.width, height: entry.height, self_height: entry.self_height,
      plan: entry.plan, anchor: entry.anchor ?? null,
      is_magnetized: !!entry.is_magnetized, can_be_outside: !!entry.can_be_outside,
    },
    model_object: item,
  };
  writeFileSync(`${OUT}/ui-ref-stair-${s.key}.json`, JSON.stringify(fixture, null, 1) + "\n");
  console.log(`ui-ref-stair-${s.key}.json`);
}
