// Восстановление после записывающих живых проб — только по захваченным ID
// (m1 ревью 342; класс инцидента 240/M1: выбор целей по геометрии запрещён —
// разовых скриптов зачистки вне закоммиченных проб с гардами не существует).
// Порядок снятия отделки своих комнат — FINISH_LOSS_REGISTRY: ниша → потолочный
// плинтус → плинтус пола → (complex: смена материала) → ластик потолка →
// ластик пола → стороны стен; захваченные site_id логируются в файл (343-captured).
// Модуль без сети: зависимость — функция вызова MCP-инструментов, поэтому полный
// цикл restore проверяется офлайн-моком (tests/unit/probe-restore-cycle.test.ts).
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type ProbeCreated = { kind: string; siteId?: string };
export type ProbeCall = (name: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>;

export type RestoreDeps = {
  call: ProbeCall;
  /** Захваченные сущности пробы; мутируется — удалённые записи убираются. */
  created: ProbeCreated[];
  /** rooms2-ключи СВОИХ комнат (захвачены при создании комнаты, не по геометрии). */
  ownRoomIds: string[];
  save: () => Promise<unknown>;
  log: (line: string) => void;
};

/** Снимок захваченных ID для журнала (файл вне git). */
export function capturedSnapshot(created: readonly ProbeCreated[], ownRoomIds: readonly string[]): Record<string, unknown> {
  return {
    rooms: [...ownRoomIds],
    walls: created.filter((c) => c.kind === "wall" && c.siteId).map((c) => c.siteId),
    delimiters: created.filter((c) => c.kind === "delimiter" && c.siteId).map((c) => c.siteId),
  };
}

/** Журнал захваченных ID: доочистка возможна только по ним, не по геометрии. */
export function logCaptured(path: string, created: readonly ProbeCreated[], ownRoomIds: readonly string[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(capturedSnapshot(created, ownRoomIds), null, 1) + "\n");
}

type FinishGet = {
  ceiling?: { complex?: unknown; material?: string };
  ceiling_zones?: Array<{ complex?: unknown; material?: string }>;
  floor?: unknown;
  walls?: unknown[];
  floor_moldings?: unknown[];
  ceiling_moldings?: unknown[];
  niches?: unknown[];
};

/** Снятие отделки СВОЕЙ комнаты по подсказке реестра (порядок FINISH_LOSS_REGISTRY).
 *  Complex сначала снимается сменой материала на ДРУГОЙ (warning complex_removed),
 *  затем ластик; отказы отдельного вида логируются, но не останавливают restore. */
export async function removeRoomFinishByHint(call: ProbeCall, roomId: string, log: (line: string) => void): Promise<void> {
  const fg = (await call("finish_get", { room_id: roomId })) as unknown as FinishGet;
  const complexNow = [fg.ceiling, ...(fg.ceiling_zones ?? [])].some((c) => c?.complex === true);
  const tryStep = async (name: string, args: Record<string, unknown>): Promise<void> => {
    try { await call(name, args); }
    catch (e) { log(`${name} ${roomId}: ${String((e as Error).message).slice(0, 150)}`); }
  };
  // 1–3: ниша и плинтусы раньше ластиков (ластик при нише отказывает)
  if ((fg.niches ?? []).length > 0) await tryStep("finish_ceiling_niche_remove", { room_id: roomId });
  if ((fg.ceiling_moldings ?? []).length > 0) await tryStep("finish_ceiling_molding_remove", { room_id: roomId });
  if ((fg.floor_moldings ?? []).length > 0) await tryStep("finish_floor_molding_remove", { room_id: roomId });
  // 4–5: complex — смена материала (другого!), затем ластик покрытия потолка
  if (fg.ceiling || (fg.ceiling_zones ?? []).length > 0) {
    if (complexNow) {
      const current = fg.ceiling?.material ?? fg.ceiling_zones?.[0]?.material ?? "";
      const other = current === "stretch_ceiling" ? "gypsum_ceiling" : "stretch_ceiling";
      await tryStep("finish_ceiling_set", { room_id: roomId, material: other });
    }
    await tryStep("finish_ceiling_remove", { room_id: roomId });
  }
  // 6–7: пол и стороны стен
  if (fg.floor !== undefined) await tryStep("finish_floor_remove", { room_id: roomId });
  if ((fg.walls ?? []).length > 0) await tryStep("finish_wall_remove", { room_id: roomId });
}

/** Удаление своих стен по захваченным site_id. Холостой список не крутится:
 *  нет стены — выход; удалённая стена убирается из created (на месте). */
export async function deleteWallsBySiteIds(deps: RestoreDeps): Promise<void> {
  const ids = new Set(deps.created.filter((c) => c.kind === "wall" && c.siteId).map((c) => c.siteId!));
  for (let guard = 0; guard < 40 && ids.size > 0; guard++) {
    const mg = await deps.call("model_get", {});
    const walls = (mg["walls"] ?? []) as Array<{ id: string; site_id: string }>;
    const hit = walls.find((w) => ids.has(w.site_id));
    if (!hit) break;
    ids.delete(hit.site_id);
    try {
      await deps.call("wall_delete", { wall_id: hit.id });
      deps.created.splice(deps.created.findIndex((c) => c.kind === "wall" && c.siteId === hit.site_id), 1);
    }
    catch (e) { deps.log(`wall_delete ${hit.id}: ${String((e as Error).message).slice(0, 200)}`); break; }
    await new Promise((r) => setTimeout(r, 1200));
  }
}

/** Полный цикл восстановления пробы: свои разделители → отделка своих комнат →
 *  свои стены (по захваченным site_id) → save. Ничего не выбирает по геометрии;
 *  created мутируется на месте (удалённые записи убираются). */
export async function restoreByCaptured(deps: RestoreDeps): Promise<void> {
  // свои разделители зон потолка — до стен (при удалении комнаты не остаются висеть)
  for (const c of deps.created.filter((c) => c.kind === "delimiter" && c.siteId).reverse()) {
    try { await deps.call("zone_ceiling_remove", { delimiter_id: c.siteId }); }
    catch (e) { deps.log(`zone_ceiling_remove: ${String((e as Error).message).slice(0, 150)}`); }
  }
  for (let i = deps.created.length - 1; i >= 0; i--) {
    if (deps.created[i]!.kind === "delimiter") deps.created.splice(i, 1);
  }
  // отделка СВОИХ комнат — до удаления стен (иначе wall_delete отказывает)
  for (const rid of [...deps.ownRoomIds].reverse()) {
    await removeRoomFinishByHint(deps.call, rid, deps.log);
  }
  await deleteWallsBySiteIds(deps);
  await deps.save();
}
