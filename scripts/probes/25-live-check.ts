// 25-windows: живая проверка раздела «Окна» через MCP-инструменты в dev-проекте 7887657.
// 7 типов с нестандартными параметрами → model_validate → project_save → переоткрытие → сверка → render_plan.
// node scripts/probes/25-live-check.ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { writeFileSync } from "node:fs";
import { ServerContext } from "../../src/server/context.ts";
import { buildServer } from "../../src/server.ts";

type Res = { isError?: boolean; content?: { type: string; text?: string }[] };
const text = (r: unknown): string => ((r as Res).content as { text: string }[])[0]!.text;
const json = (r: unknown): any => JSON.parse(text(r));

const ctx = new ServerContext();
const server = buildServer(ctx);
const client = new Client({ name: "25-windows-live", version: "0.0.0" });
const [a, b] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(b), client.connect(a)]);

await client.callTool({ name: "project_open", arguments: { object_id: "7887657", plan_id: "1001798" } });
const before = json(await client.callTool({ name: "model_get", arguments: {} }));

// стены для окон: без проёмов, с запасом длины
const WALLS = ["mum46g7h3k", "e83g72t0rs", "7kmwa9hpxx", "ndikcxe1sj"];
const wallInfo = before.walls.filter((w: any) => WALLS.includes(w.site_id));
console.log("стены:", wallInfo.map((w: any) => `${w.site_id} len=${w.len_mm} openings=${w.openings.length}`));

const JOBS = [
  { type: "windowway", args: { width_mm: 1200, height_mm: 1600, sill_height_mm: 900, casements: 2, slope_angle_deg: 10, sill_thickness_mm: 60 } },
  { type: "window", args: { width_mm: 1300, height_mm: 1600, casements: 2, sill_overhang_mm: 50 } },
  { type: "window_balcony", args: { window_width_mm: 1000, door_width_mm: 800, door_position: "right", window_height_mm: 1600, door_height_mm: 2200 } },
  { type: "window_door", args: { width_mm: 900, height_mm: 2300, impost_height_mm: 1400 } },
  { type: "french_window", args: { width_mm: 1200, height_mm: 2400, slope_angle_deg: 15, sill_thickness_mm: 60 } },
  { type: "french_window_coupe", args: { width_mm: 1200, height_mm: 2400 } },
  { type: "french_window_double", args: { width_mm: 1800, height_mm: 2400, sill_overmeasure_mm: 30 } },
];

/** Свободный центр (мм от начала оси) под проём заданной ширины: зазор 300, край 300. */
function freeCenter(wall: any, widthMm: number): number | null {
  const ranges: [number, number][] = wall.openings.map((o: any) => [o.offset_mm, o.offset_mm + o.width_mm]);
  ranges.sort((x, y) => x[0] - y[0]);
  let cursor = 300;
  for (const [s, e] of ranges) {
    if (cursor + widthMm + 300 <= s - 300) return cursor + widthMm / 2;
    cursor = Math.max(cursor, e + 300);
  }
  if (cursor + widthMm <= wall.len_mm - 300) return cursor + widthMm / 2;
  return null;
}

const render = await client.callTool({ name: "render_plan", arguments: { sheet: "init" } });
const rtext = text(render);
const rjson = (() => { try { return JSON.parse(rtext); } catch { return null; } })();
const save = rjson?.save_path ?? rjson?.path ?? null;
console.log("render:", render.isError ? rtext.slice(0, 300) : JSON.stringify({ save_path: rjson?.save_path ?? rjson?.path, revision: rjson?.revision ?? null }).slice(0, 300));
if (rjson?.save_path) {
  const { copyFileSync } = await import("node:fs");
  copyFileSync(rjson.save_path, ".orca-reports/25-live-render.png");
  console.log("copied to .orca-reports/25-live-render.png");
}
process.exit(0);
