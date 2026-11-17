// 103: эталон линии зонирования (zone_delimiters) и чистый ГКЛ-короб.
// Запуск: node scripts/probes/103-replan-zone.ts
import { launch, newAnonProject, buildBase, copyServer, switchSheet, pickTool, clickAt, dragAt, writeOut, diffModels, escape } from "./phase2-lib.ts";

const browser = await launch();
const page = await newAnonProject(browser);
await buildBase(page);
await switchSheet(page, "create_walls");
const base = await copyServer(page);

// зона: вертикальная линия в коридоре (300,12)→(300,108)
await pickTool(page, "zone");
const before = await copyServer(page);
await dragAt(page, { x: 300, y: 12 }, { x: 300, y: 108 });
await escape(page);
const after = await copyServer(page);
const d1 = diffModels(before, after);
writeOut("103-zone-diff", { wallsChanged: Object.keys(d1.walls?.changed ?? {}), rooms2: d1.rooms2, zone_delimiters: after.zone_delimiters });

// короб: два клика в середине комнаты B (не у стен)
await pickTool(page, "gypsum_box");
const before2 = await copyServer(page);
await clickAt(page, { x: 360, y: -250 });
await clickAt(page, { x: 440, y: -180 });
await escape(page);
const after2 = await copyServer(page);
writeOut("103-box-clean", { pillars: after2.pillars, diff: diffModels(before2, after2).pillars });
console.log("pillars:", JSON.stringify(Object.keys(after2.pillars ?? {})));
console.log("zone_delimiters:", JSON.stringify(Object.keys(after.zone_delimiters ?? {})));
await browser.close();
process.exit(0);
