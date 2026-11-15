// Проба рендера: видимость #canvas_v2_wrapper и кандидатов, действия для видимости.
import { createAnonProject, loadModel } from "../src/api.ts";
import { openEditor } from "../src/editor/adapter.ts";
import { closeBrowser } from "../src/browser.ts";
import { addRoomRect, prepareForRestore } from "../src/model/walls.ts";
import type { Model } from "../src/model/types.ts";
import type { SessionState } from "../src/session.ts";

const session: SessionState = { cookies: [] };
const created = await createAnonProject(session);
const model: Model = { v: 3, id: "x", plan_id: "1", walls: {}, items: {}, pillars: {}, rulers: {}, comments: {}, total_height: 270, final: false };
addRoomRect(model, { origin: { x: 0, y: 0 }, widthMm: 4000, depthMm: 3000, thicknessMm: 200 });
prepareForRestore(model);
const editor = await openEditor(session, created.object_id, created.plan_id);
try {
  await editor.normalize(model as unknown as Record<string, unknown>, 1200);
  const info = await editor.page.evaluate(() => {
    const box = (el: Element | null) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return { x: r.x, y: r.y, w: r.width, h: r.height, display: cs.display, visibility: cs.visibility, opacity: cs.opacity, hidden: (el as HTMLElement).hidden };
    };
    const out: Record<string, unknown> = {};
    out.canvas_v2_wrapper = box(document.querySelector("#canvas_v2_wrapper"));
    out.canvas = box(document.querySelector("#canvas_v2_wrapper canvas"));
    out.canvases = [...document.querySelectorAll("canvas")].slice(0, 8).map((c) => ({ id: c.id, cls: c.className, ...box(c) }));
    out.svg = box(document.querySelector("#canvas_v2_wrapper svg"));
    out.bodyClass = document.body.className;
    out.viewport = { w: innerWidth, h: innerHeight };
    out.navItems = [...document.querySelectorAll(".groups_navi_item")].map((n) => n.className);
    out.$Project_focus = typeof (window as unknown as { $Project?: { focus?: unknown } }).$Project?.focus;
    out.scroll = { sx: scrollX, sy: scrollY };
    return out;
  });
  console.log(JSON.stringify(info, null, 1));
  // проба: скриншот страницы целиком и видимого canvas
  await editor.page.screenshot({ path: "screenshots/probe-render-page.png" });
  const visibleCanvas = await editor.page.evaluate(() => {
    const list = [...document.querySelectorAll("canvas")];
    return list.findIndex((c) => { const r = c.getBoundingClientRect(); return r.width > 100 && r.height > 100; });
  });
  console.log("visible canvas index:", visibleCanvas);
} finally {
  await editor.close();
  await closeBrowser().catch(() => {});
}
