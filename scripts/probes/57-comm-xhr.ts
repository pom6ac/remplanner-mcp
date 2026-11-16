// 57-communications: XHR/ответы при открытии редактора — откуда берутся определения инструментов.
// node scripts/probes/57-comm-xhr.ts (ID из env)
import { openEditor } from "../../src/editor/adapter.ts";
import { closeBrowser } from "../../src/browser.ts";
import { STATE_PATH } from "../../src/config.ts";
import { loadSession } from "../../src/session.ts";

const OBJECT_ID = process.env.REMPLANNER_PROBE_OBJECT_ID;
const PLAN_ID = process.env.REMPLANNER_PROBE_PLAN_ID;
if (!OBJECT_ID || !PLAN_ID) { console.error("env?"); process.exit(1); }

const session = { ...loadSession(STATE_PATH), account: true } as const;
const editor = await openEditor(session, OBJECT_ID, PLAN_ID, 60_000, { anonymous: false });
const seen = new Set<string>();
try {
  editor.page.on("response", (r) => {
    const url = r.url();
    if (/tool|global|param/i.test(url) && !seen.has(url)) {
      seen.add(url);
      console.log(r.status(), url.slice(0, 160));
    }
  });
  await editor.page.waitForTimeout(4000);
  // источник переопределения: ищем в бандлах в памяти страницы
  const src = await editor.page.evaluate(async () => {
    const w: any = window as any;
    // кто писал group 'furniture' в global_tools.water? проверяем глобалы-кандидаты
    const res: Record<string, unknown> = {};
    for (const k of ["tools", "tools_old", "old_tools", "plan_tools", "init_tools"]) {
      if (w[k]) res[k] = typeof w[k] === "object" ? Object.keys(w[k]).length : typeof w[k];
    }
    // скрипты на странице
    res.scripts = Array.from(document.querySelectorAll("script[src]")).map((s) => (s as HTMLScriptElement).src);
    return res;
  });
  console.log(JSON.stringify(src, null, 1));
} finally {
  await editor.close().catch(() => {});
  await closeBrowser().catch(() => {});
}
