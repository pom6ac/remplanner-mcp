// Сверки конструктора щитка (этап 255): до save после нормализации и после save
// по GET — семантическая проекция целиком (уроки new-entity-section: сверка по
// нормализованной проекции, а не по выбранным полям). length_rails при
// on_auto_length_rails=1 — производная (в проекцию не входит).
import type { Shield } from "../model/types.ts";
import { shieldProjection } from "../model/shield.ts";

/** Запись щитка по умолчанию (SHIELDS.restore: new Shield({shield_id})): одна
 *  пустая рейка, один ввод с портами фаза/ноль/земля (connected 0), без
 *  шин/проводов/коллекторов. */
export function isDefaultEmptyShield(shield: Shield): boolean {
  const rails = Object.values(shield.rails ?? {});
  if (rails.length !== 1 || Object.keys(rails[0]!.modules ?? {}).length !== 0) return false;
  if (shield.on_auto_length_rails !== 1) return false;
  const inputs = Object.values(shield.inputs ?? {});
  if (inputs.length !== 1) return false;
  const ports = inputs[0]!.ports ?? [];
  if (ports.length !== 3) return false;
  const types = ports.map((p) => p.type).sort();
  if (JSON.stringify(types) !== JSON.stringify(["shield_wire_earth", "shield_wire_null", "shield_wire_phase"])) return false;
  if (ports.some((p) => p.connected !== 0)) return false;
  if (Object.keys(shield.buses ?? {}).length > 0 || Object.keys(shield.collectors ?? {}).length > 0 || Object.keys(shield.wires ?? {}).length > 0) return false;
  return true;
}

/**
 * Расхождения щитков между ожидаемой и фактической моделями. allowAutoCreate —
 * редактор при restore дополняет щиток-предмет без записи записью по умолчанию
 * (SHIELDS.restore); такая авто-запись с пустым содержимым не потеря.
 */
export function shieldMismatches(
  expected: Record<string, Shield>,
  got: Record<string, Shield> | undefined,
  opts: { allowAutoCreate?: boolean } = {},
): string[] {
  const out: string[] = [];
  const gotMap = got ?? {};
  for (const [id, exp] of Object.entries(expected)) {
    const g = gotMap[id];
    if (!g) {
      out.push(`щиток ${id} (предмет ${exp.shield_id}) потерян`);
      continue;
    }
    if (JSON.stringify(shieldProjection(exp)) !== JSON.stringify(shieldProjection(g))) {
      out.push(`щиток ${id} (предмет ${exp.shield_id}): содержимое изменилось при нормализации/сохранении`);
    }
  }
  for (const [id, g] of Object.entries(gotMap)) {
    if (expected[id]) continue;
    if (opts.allowAutoCreate && isDefaultEmptyShield(g)) continue;
    out.push(`щиток ${id} (предмет ${g.shield_id}): ${opts.allowAutoCreate ? "неожиданная запись с содержимым" : "лишняя запись"}`);
  }
  return out;
}
