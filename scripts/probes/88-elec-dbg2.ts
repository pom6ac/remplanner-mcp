// 88: диагностика размещения выключателя: сообщения редактора, точки по стене.
import {
  launch, newAnonProject, buildBase, copyServer, switchSheet, pickTool, clickAt,
  writeOut, escape,
} from "./phase2-lib.ts";

const browser = await launch();
const page = await newAnonProject(browser);
await buildBase(page);
await switchSheet(page, "light_connections");

const messages = () => page.evaluate(() => {
  const w: any = window as any;
  const msgs = Array.from(document.querySelectorAll(".planner_ui_message"))
    .filter((e: any) => e.classList.contains("active") && e.textContent?.trim())
    .map((e: any) => e.textContent!.trim().slice(0, 120));
  return { msgs, items: Object.keys(w.ITEMS ?? {}).length, tool: w.tool ?? w.current_tool ?? null,
    toolName: (w.tool && (w.tool.name ?? w.tool.constructor?.name)) ?? null };
});

const pick = await pickTool(page, "light_switch");
console.log("pick:", pick, JSON.stringify(await messages()));
const spots = [[380, -287], [420, -287], [460, -287], [340, -287]];
for (const [x, y] of spots) {
  await clickAt(page, { x, y });
  await escape(page);
  const st = await messages();
  console.log(`click ${x},${y}:`, JSON.stringify(st));
  if (st.items > 0) break;
}
const a = await copyServer(page);
writeOut("88-dbg2-items", a.items ?? {});
console.log("model:", Object.values<any>(a.items ?? {}).map((i: any) => `${i.name}@${i.pc.x},${i.pc.y}`).join(","));
await browser.close();
process.exit(0);
