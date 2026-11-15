import { createAnonProject } from "../src/api.ts";
import { openEditor } from "../src/editor/adapter.ts";
import { closeBrowser } from "../src/browser.ts";
import { addRoomRect, prepareForRestore } from "../src/model/walls.ts";
import type { Model } from "../src/model/types.ts";
import type { SessionState } from "../src/session.ts";
import { writeFileSync } from "node:fs";

const session: SessionState = { cookies: [] };
const created = await createAnonProject(session);
const model: Model = { v: 3, id: "x", plan_id: "1", walls: {}, items: {}, pillars: {}, rulers: {}, comments: {}, total_height: 270, final: false };
addRoomRect(model, { origin: { x: 0, y: 0 }, widthMm: 4000, depthMm: 3000, thicknessMm: 200 });
prepareForRestore(model);
const editor = await openEditor(session, created.object_id, created.plan_id);
try {
  await editor.normalize(model as unknown as Record<string, unknown>, 1200);
  const png = await editor.renderPng({ sheet: "init", widthPx: 1600 });
  writeFileSync("screenshots/probe-render-tool.png", png);
  console.log("PNG bytes:", png.length);
} finally {
  await editor.close();
  await closeBrowser().catch(() => {});
}
