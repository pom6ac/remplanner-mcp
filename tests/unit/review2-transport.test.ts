// Раунд 2 (09-review-round2.md): R2-1 блокер — утечка сырого тела ответа и внешних
// exception-сообщений в публичные ошибки. Тесты через РЕАЛЬНЫЕ границы (mock Page
// для адаптера, mock fetch для HTTP) с sentinel: в сериализованной ошибке его нет.
import test from "node:test";
import assert from "node:assert/strict";
import { buildHandle, type EditorHandle } from "../../src/editor/adapter.ts";
import { httpRequestJson } from "../../src/http.ts";
import type { SessionState } from "../../src/session.ts";

const SENTINEL = "authk" + "ey=SENTINEL-ROUND2-VALUE";

/** Mock страницы: evaluate для savePlan; waitForResponse отдаёт заданный ответ. */
function mockPageSaveResponse(opts: { body: string; status?: number; delayMs?: number }) {
  const listeners: Record<string, unknown> = {};
  return {
    listeners,
    async evaluate(fn: string | ((arg: unknown) => unknown)): Promise<unknown> {
      if (typeof fn === "string" && fn.includes("project.save")) return { started: true };
      if (typeof fn === "string" && fn.includes("planner_ui_message_fog")) return true;
      return {};
    },
    async waitForResponse(_pred: unknown): Promise<unknown> {
      return {
        status: () => opts.status ?? 200,
        url: () => "https://remplanner.ru/setup/api/planner/save/?authk" + "ey=SENTINEL-IN-URL",
        text: async () => opts.body,
      };
    },
  };
}

function serializeError(e: unknown): string {
  if (e instanceof Error) {
    // как MCP-слой сериализует McpError
    const anyE = e as { toJSON?: () => Record<string, unknown> };
    if (anyE.toJSON) return JSON.stringify(anyE.toJSON());
    return JSON.stringify({ code: "INTERNAL", message: e.message });
  }
  return String(e);
}

test("R2-1: adapter.save на не-JSON ответ с sentinel не раскрывает тело в ошибке", { timeout: 30_000 }, async () => {
  const page = mockPageSaveResponse({ body: `<html>error ${SENTINEL}</html>` });
  const handle: EditorHandle = buildHandle(
    page as never,
    { close: async () => {} } as never,
    "123", "1",
    { global_version: "1", planner_version: "3", bundles: [], object_id: "123", plan_id: "1",
      present: { WALLS: true, ROOMS2: true, restore: true, draw: true, copy: true, save: true, canvas: true, wall_link1: true, wall_link2: true, wall_calc: true } },
    { acquire: async () => {} },
  );
  await assert.rejects(handle.save(), (e: unknown) => {
    const serialized = serializeError(e);
    assert.ok(!serialized.includes("SENTINEL"), `sentinel утёк в ошибку: ${serialized}`);
    assert.ok(!serialized.includes("<html>"), `сырое тело в ошибке: ${serialized}`);
    return true;
  });
});

test("R2-1/№17: сетевая ошибка fetch с sentinel в сообщении не попадает в публичную ошибку", { timeout: 30_000 }, async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error(`fetch failed for https://remplanner.ru/x?${SENTINEL}&z=1`);
  }) as typeof fetch;
  try {
    const session: SessionState = { cookies: [] };
    await assert.rejects(
      httpRequestJson({ path: "/setup/api/planner/?authk" + "ey=SENTINEL-ROUND2-VALUE", session }),
      (e: unknown) => {
        const serialized = serializeError(e);
        assert.ok(!serialized.includes("SENTINEL"), `sentinel утёк: ${serialized}`);
        return true;
      },
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("R2-15: неудачный автоматический вход занимает cooldown — немедленный повтор даёт SESSION_TAKEN_OVER", async () => {
  const { ReloginManager } = await import("../../src/http.ts");
  const mgr = new ReloginManager();
  let attempts = 0;
  await assert.rejects(mgr.relogin(async () => {
    attempts++;
    throw new Error("нет сети");
  }), /нет сети/);
  assert.equal(attempts, 1);
  // повтор внутри cooldown блокируется: сессия могла быть выбита фактом попытки входа
  const { McpError } = await import("../../src/errors.ts");
  await assert.rejects(mgr.relogin(async () => {}), (e: unknown) => {
    assert.ok(e instanceof McpError);
    assert.equal(e.code, "SESSION_TAKEN_OVER");
    return true;
  });
  assert.equal(attempts, 1, "второй auto() не вызывался");
});
