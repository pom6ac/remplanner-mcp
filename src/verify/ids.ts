import type { Model } from "../model/types.ts";
import type { VerificationMismatches } from "./types.ts";

/** id проёмов модели: id holes по всем стенам (ревью v0.1.1 №4/№5 — сравнение по id). */
export function openingIds(model: Model): Set<string> {
  const out = new Set<string>();
  for (const [wid, w] of Object.entries(model.walls ?? {})) {
    for (const [hid, h] of Object.entries(w.holes ?? {})) {
      out.add((h as { id?: string }).id ?? `${wid}/${hid}`);
    }
  }
  return out;
}

/** Список id серверных объектов, которых нет в локальной модели (ревью v0.1.1 №5):
 *  разность идентичностей, а не разность общих счётчиков — удаление одного объекта
 *  с добавлением другого не маскируется. */
export function missingIds(server: Set<string>, local: Set<string>): VerificationMismatches {
  return [...server].filter((id) => !local.has(id)).sort();
}
