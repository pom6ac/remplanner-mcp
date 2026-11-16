// 57-communications, проба 8: gas_line с изломом (последовательные клики) и правка вершины —
// структура matrix/vertexes/length. КЛИКИ ТОЛЬКО ЛОКАЛЬНО: save не вызывается.
// node scripts/probes/57-comm-ui8.ts
import { mkdirSync, writeFileSync } from "node:fs";
import { openEditor } from "../../src/editor/adapter.ts";
import { closeBrowser } from "../../src/browser.ts";
import { STATE_PATH } from "../../src/config.ts";
import { loadSession } from "../../src/session.ts";
import { clickAt, escape, pickTool, switchSheet, copyServer, diffModels, dragAt } from "./phase2-lib.ts";
import type { P } from "./phase2-lib.ts";

const OUT = ".orca-reports/57-comm-ui";
const OBJECT_ID = process.env.REMPLANNER_PROBE_OBJECT_ID;
const PLAN_ID = process.env.REMPLANNER_PROBE_PLAN_ID;
if (!OBJECT_ID || !PLAN_ID) { console.error("env?"); process.exit(1); }

const session = { ...loadSession(STATE_PATH), account: true } as const;
const editor = await openEditor(session, OBJECT_ID, PLAN_ID, 60_000, { anonymous: false });
mkdirSync(OUT, { recursive: true });
try {
  const page = editor.page;
  await switchSheet(page, "init");

  const geo = await page.evaluate(() => {
    const m = (window as any).project.copy("server");
    const rooms = Object.values<any>((m as any).rooms2 ?? {}).map((r: any) => ({ polygon: r.polygon, area: r.area }));
    return { rooms };
  });
  const r = [...geo.rooms].sort((a, b) => b.area - a.area)[0]!;
  const xs = r.polygon.map((q: P) => q.x), ys = r.polygon.map((q: P) => q.y);
  const c = { x: Math.round((Math.min(...xs) + Math.max(...xs)) / 2), y: Math.round((Math.min(...ys) + Math.max(...ys)) / 2) };

  // вариант A: три последовательных клика (полилиния с изломом), затем Escape
  await pickTool(page, "gas_line");
  const b = await copyServer(page);
  await clickAt(page, c);
  await clickAt(page, { x: c.x + 150, y: c.y });
  await clickAt(page, { x: c.x + 150, y: c.y + 120 });
  let a = await copyServer(page);
  const diff = diffModels(b, a);
  console.log("полилиния: diff_keys", JSON.stringify(Object.keys(diff)));
  const gas = Object.values<any>(diff.pipes_gas?.added ?? {});
  console.log("gas_line:", JSON.stringify(gas, null, 1));
  await escape(page);
  writeFileSync(`${OUT}/gas_line-polyline.json`, JSON.stringify({ diff: diff.pipes_gas ?? null }, null, 1) + "\n");

  // вариант B: одиночный drag (уже известен) — правка вершины перетаскиванием
  await pickTool(page, "gas_line");
  const b2 = await copyServer(page);
  await dragAt(page, { x: c.x - 60, y: c.y + 60 }, { x: c.x + 40, y: c.y + 90 });
  const a2 = await copyServer(page);
  const diff2 = diffModels(b2, a2);
  const gas2 = Object.values<any>(diff2.pipes_gas?.added ?? {})[0];
  console.log("drag gas_line:", JSON.stringify(gas2, null, 1));
  if (gas2?.vertexes?.length === 2) {
    const p1 = gas2.vertexes[0].point as P;
    // перетащить первую вершину на +30,+20 (клик-драг по ней)
    await dragAt(page, p1, { x: p1.x + 30, y: p1.y + 20 });
    const a3 = await copyServer(page);
    const changed = Object.values<any>(a3.pipes_gas ?? {}).find((p) => p.id === gas2.id);
    console.log("после перетаскивания вершины:", JSON.stringify(changed, null, 1));
  }
  console.log("done");
} finally {
  await editor.close().catch(() => {});
  await closeBrowser().catch(() => {});
}
