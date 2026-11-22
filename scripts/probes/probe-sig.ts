// Общий семантический канон GET-модели для живых проб (310-m11-live, 310-zonec):
// производные поля (полигоны/рёбра зон, ids, edges2, служебные ключи) приводятся
// к канонической форме — сверка модели с бэкапом и контрольного проекта до/после
// идёт по пользовательским данным (ревью 285 №3, ревью 311 №5).
// Этап 382 (wall-мутация туда-обратно): редактор при каждом пересчёте комнат
// даёт шум координат ~1e-4 см (292.5 ↔ 292.4999), перегенерирует oid рёбер в
// edges_prs, меняет порядок ключей rooms1/rooms2 и число exist:false заглушек
// в контейнерах отделки (следует за перегенерированной нарезкой рёбер) —
// канон дополнил: округление чисел комнатных записей до 1e-2 см, псевдоним
// комнат по ОТСОРТИРОВАННОМУ набору канонических полигонов (устойчив к
// перестановке), состав контейнеров отделки — только записи exist:true.
// Этап 384 (фикс по ревью 383 №28): канон НЕ скрывает пользовательские данные —
// floorMoldings/ceilingMoldings исключены из USER_DATA_ARR (плинтус хранится в
// parts записи, бандл: t.floorMoldings[e].parts[o]=$FloorLining.get_new_line(i)),
// сериализация записей отделки без replacer-массива (JSON.stringify(roundDeep(e))):
// replacer фильтрует ключи на ВСЕХ уровнях вложенности и прятал exist:true-состав
// (parts/params/polygon). Стороны плинтуса без exist:true пропускаются — их число
// следует за перегенерированной нарезкой рёбер. №30: ключи prs_disabled (oid
// развёрток, бандл связывает i.edges_prs[e].oid===O для O in i.prs_disabled)
// канонизируются через oid → ed{edge_index}, а не вместе с безусловным
// обнулением oid в edges_prs — иначе при перегенерации oid ключи станут
// висячими, и sig это скрыл бы.
// Этап 386 (фикс-2 по ревью 385 №35): потолки — вся запись минус производные
// (бандл переносит angle/type_laying/anchor/complex/material2/niches/… при
// пересчёте комнат), зоны — color, ригели — height/depth; №40: eds2 без
// replacer-массива.
/**
 * Каноническая форма GET-модели для сверок (384: экспортирована для
 * поканонического диффа в пробах сверки восстановления, sig = JSON(canon)).
 */
export function canon(m: unknown): unknown {
  const c = structuredClone(m) as Record<string, unknown>;
  for (const k of ["errors", "logs", "log_plan", "session", "version", "drawing", "params", "final", "signals", "smeta_water_pipes", "save_id", "is_forced"]) delete c[k];
  for (const k of ["borders", "drawings"]) {
    if (Array.isArray(c[k])) c[k] = [...(c[k] as unknown[])].map((e) => JSON.stringify(e)).sort();
  }
  // шум координат от пересчёта комнат (382): округление чисел до 1e-2 вглубь
  const roundDeep = (v: unknown): unknown => {
    if (typeof v === "number") return Math.round(v * 100) / 100;
    if (Array.isArray(v)) return v.map(roundDeep);
    if (v !== null && typeof v === "object") {
      const o: Record<string, unknown> = {};
      for (const kk of Object.keys(v as Record<string, unknown>).sort()) o[kk] = roundDeep((v as Record<string, unknown>)[kk]);
      return o;
    }
    return v;
  };
  // контейнеры отделки комнат: число exist:false заглушек следует за
  // перегенерированной нарезкой рёбер — состав пользовательской отделки это
  // только записи exist:true (382)
  const USER_DATA_ARR = [
    "warms_walls",
    "floors", "hydroisolations", "hydroisolations_walls",
    "plasters", "plasters_ceilings", "plasters_slopes",
    "isolations", "isolations_slopes", "decors", "decors_slopes",
  ];
  const walls = (c["walls"] ?? {}) as Record<string, Record<string, unknown>>;
  for (const w of Object.values(walls)) {
    const eds2 = w["eds2"] as Record<string, unknown> | undefined;
    if (eds2) {
      for (const side of Object.keys(eds2)) {
        if (Array.isArray(eds2[side])) {
          const canon = (eds2[side] as Array<Record<string, unknown>>)
            .map((e) => ({ ...e, id: null, pc: null }))
            // без replacer-массива (386 №40): он фильтрует ключи на всех уровнях
            // вложенности и срезал вложенные p1/p2/c/pc; ключи сортирует roundDeep
            .map((e) => JSON.stringify(roundDeep(e)))
            .sort();
          eds2[side] = canon;
        }
      }
    }
  }
  const rooms = {
    ...((c["rooms1"] ?? {}) as Record<string, Record<string, unknown>>),
    ...((c["rooms2"] ?? {}) as Record<string, Record<string, unknown>>),
  } as Record<string, Record<string, unknown>>;
  const canonPoly = (poly: unknown): string => {
    if (!Array.isArray(poly)) return "";
    const pts = (poly as Array<{ x: number; y: number }>)
      .map((p) => ({ x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10 }));
    let min = 0;
    for (let i = 1; i < pts.length; i++) {
      if (pts[i]!.x < pts[min]!.x || (pts[i]!.x === pts[min]!.x && pts[i]!.y < pts[min]!.y)) min = i;
    }
    return pts.map((p) => `${p.x},${p.y}`).join(";") + `#${min}`;
  };
  // псевдоним по каноническому полигону: ОТСОРТИРОВАННЫЙ набор уникальных
  // ключей — индекс не зависит от порядка ключей rooms1/rooms2, который
  // редактор перегенерирует при каждом restore (382)
  const uniq = [...new Set(Object.values(rooms).map((r) => canonPoly(r["polygon"])))].sort();
  const polyIndex = new Map<string, number>(uniq.map((k, i) => [k, i]));
  const roomAlias = new Map<string, string>();
  Object.entries(rooms).forEach(([rid, r]) => {
    const k = canonPoly(r["polygon"]);
    const idx = polyIndex.get(k);
    roomAlias.set(rid, `RR${idx === undefined ? uniq.length : idx}`);
  });
  for (const rk of ["rooms1", "rooms2"]) {
    const map = (c[rk] ?? null) as Record<string, Record<string, unknown>> | null;
    if (map && typeof map === "object") {
      for (const rec of Object.values(map)) {
        // контейнеры отделки: только exist:true (382 — см. шапку)
        for (const uk of USER_DATA_ARR) {
          if (Array.isArray(rec[uk])) {
            rec[uk] = (rec[uk] as Array<Record<string, unknown>>)
              .filter((e) => e && e["exist"] === true)
              // без replacer-массива (384 №28): он фильтрует ключи на всех
              // уровнях вложенности; ключи сортирует roundDeep
              .map((e) => JSON.stringify(roundDeep(e)))
              .sort();
          }
        }
        // округление шума координат (382): до канонов, читающих числа
        for (const kk of Object.keys(rec)) rec[kk] = roundDeep(rec[kk]);
        if (Array.isArray(rec["edges_prs"])) {
          const ep = rec["edges_prs"] as Array<Record<string, unknown>>;
          // №30 (ревью 383): oid перегенерируется, но он СВЯЗЫВАЕТ пользовательский
          // prs_disabled (бандл: i.edges_prs[e].oid===O для O in i.prs_disabled) —
          // ключи prs_disabled канонизируются через oid → ed{edge_index}; висячий
          // ключ (oid нет в edges_prs) остаётся как есть — не скрываем
          const oidToEdges = new Map<string, string[]>();
          ep.forEach((e, i) => {
            const oid = e["oid"];
            if (typeof oid === "string" && oid !== "") {
              const list = oidToEdges.get(oid) ?? [];
              list.push(`ed${i}`);
              oidToEdges.set(oid, list);
            }
          });
          rec["edges_prs"] = ep.map((e) => ({ ...e, oid: null }));
          if (rec["prs_disabled"] !== null && typeof rec["prs_disabled"] === "object" && !Array.isArray(rec["prs_disabled"])) {
            const canon: Record<string, unknown> = {};
            for (const oid of Object.keys(rec["prs_disabled"] as Record<string, unknown>).sort()) {
              const edges = oidToEdges.get(oid);
              canon[edges && edges.length > 0 ? [...new Set(edges)].sort().join("|") : oid] = "";
            }
            rec["prs_disabled"] = canon;
          }
        }
        if (Array.isArray(rec["edges"])) {
          rec["edges"] = (rec["edges"] as Array<Record<string, unknown>>).map((e, i) => ({ ...e, id: `ed${i}` }));
        }
        if (Array.isArray(rec["id_of_edges"])) {
          rec["id_of_edges"] = (rec["id_of_edges"] as unknown[]).map((_, i) => `ed${i}`);
        }
        if (rec["delimiters"] && typeof rec["delimiters"] === "object") {
          const canon: Record<string, unknown> = {};
          for (const d of Object.values(rec["delimiters"] as Record<string, Record<string, unknown>>)) {
            const v = (d["vertexes"] ?? []) as Array<{ point?: { x: number; y: number } }>;
            const pts = v.map((x) => x.point ? `${Math.round(x.point.x * 10) / 10},${Math.round(x.point.y * 10) / 10}` : "?").sort();
            canon[`${d["type"]}|${d["plan"]}|${pts.join(";")}`] = { type: d["type"], plan: d["plan"], length: d["length"], on_size: d["on_size"], items: Object.values(d["items"] ?? {}).sort() };
          }
          rec["delimiters"] = canon;
        }
        if (rec["rigels"] && typeof rec["rigels"] === "object") {
          const canon: Record<string, unknown> = {};
          for (const r of Object.values(rec["rigels"] as Record<string, Record<string, unknown>>)) {
            const p1 = r["p1"] as { x: number; y: number } | undefined;
            const p2 = r["p2"] as { x: number; y: number } | undefined;
            const key = p1 && p2
              ? `${Math.round(p1.x * 10) / 10},${Math.round(p1.y * 10) / 10};${Math.round(p2.x * 10) / 10},${Math.round(p2.y * 10) / 10}|${r["width"]}|${r["ceiling_type"]}`
              : String(r["id"] ?? "?");
            // height/depth — пользовательские (бандл class Rigel: this.height=e.height,
            // this.depth=e.depth), не выбрасываем (386 №35)
            canon[key] = { width: r["width"], height: r["height"], depth: r["depth"], ceiling_type: r["ceiling_type"], polygon: (r["polygon"] as Array<{ x: number; y: number }> | undefined)?.map((p) => ({ x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10 })) };
          }
          rec["rigels"] = canon;
        }
        if (Array.isArray(rec["ceilings"])) {
          // производные (перестраиваются редактором при каждом save: полигоны/рёбра
          // зон, precision, edges_ceiling) — в каноническую форму. №35 (ревью 385):
          // берём ВСЮ запись и удаляем только производные — бандл при пересчёте
          // комнат ПЕРЕНОСИТ пользовательские поля (this.room.ceilings[e].anchor=
          // s.ceilings[t].anchor, …type_laying, …angle, …custom_angle, …height_rail,
          // …radius, …offset, …interval, …on_interval, …complex/material2/level2/
          // type, …width/height), ниши — restoreCeilingNiches; конструктор class
          // Ceiling читает их из записи. Белый список {exist,material,level,profile}
          // их выбрасывал
          rec["ceilings"] = (rec["ceilings"] as Array<Record<string, unknown>>)
            .map((ce) => {
              const o: Record<string, unknown> = { ...ce };
              // №41 (ревью 387): бандл сериализует при exist:true ещё polygon2/
              // polygons_layout_points/area_childs/index_parent/index_childs —
              // все пересчитываются при пересчёте комнат: this.polygon2=e после
              // get_inner_polygon+fixPolygon (бандл: "this.polygon2=e,this.edges2=
              // LIB.polygonEdges(this.polygon2)"), this.area_childs={} затем
              // gelCalcArea(…,this.area_childs), polygons_layout_points — точки
              // раскладки (LayingPattern, this.polygons_layout_points=e.polygons_
              // layout_points||[]), index_parent/index_childs — индексы зон
              // потолка за закладными/делителями (пересчитываются вместе с
              // polygons_layout). layout_points при смене материала/раскладки
              // редактор перестраивает, а preserve-поле переносит только как
              // стартовые данные.
              for (const d of ["polygon", "edges", "polygon_new", "edges_new", "polygon2", "edges2", "polygons_layout", "polygons_layout_points", "area_childs", "index_parent", "index_childs", "pc", "id", "id_room", "is_class", "area_niches", "settings"]) delete o[d];
              return roundDeep(o) as Record<string, unknown>;
            })
            .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
        }
        // edges_ceiling / demolines_ceiling_moldings — производные демолайны
        // потолочного плинтуса, перестраиваются при каждом пересчёте комнат
        for (const dk of ["edges_ceiling", "demolines_ceiling_moldings"]) {
          delete rec[dk];
        }
        // moldings: состав частей сторон exist:true (длина массива следует за
        // рёбрами комнаты, стороны-заглушки без exist:true — шум нарезки рёбер,
        // 384 №28; parts записи плинтуса — пользовательские данные, сериализуем
        // полностью через roundDeep, без replacer)
        for (const mk of ["floorMoldings", "ceilingMoldings"]) {
          if (Array.isArray(rec[mk])) {
            const parts: string[] = [];
            for (const side of rec[mk] as Array<Record<string, unknown>>) {
              if (!side || side["exist"] !== true) continue;
              const p = (side?.["parts"] ?? {}) as Record<string, Record<string, unknown>>;
              for (const q of Object.values(p)) parts.push(JSON.stringify(roundDeep(q)));
            }
            rec[mk] = parts.sort();
          }
        }
        // зоны (plan c): пользовательское — имя/цвет/микро/площадь (№35, ревью 385:
        // бандл zones[e].color=t.zones[i].color — color переносится, не вычисляется);
        // полигоны/рёбра — производные
        if (Array.isArray(rec["zones"])) {
          rec["zones"] = (rec["zones"] as Array<Record<string, unknown>>)
            .map((z) => ({ name: z["name"] ?? null, color: z["color"] ?? null, micro: Boolean(z["is_micro_zone"]), area: typeof z["area"] === "number" ? Math.round(z["area"] * 10) / 10 : null }))
            .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
        }
      }
    }
  }
  for (const rk of ["rooms1", "rooms2"]) {
    const map = (c[rk] ?? null) as Record<string, Record<string, unknown>> | null;
    if (map && typeof map === "object") {
      const renamed: Record<string, Record<string, unknown>> = {};
      for (const [rid, rec] of Object.entries(map)) {
        renamed[roomAlias.get(rid) ?? rid] = rec;
      }
      c[rk] = renamed;
    }
  }
  const aliasAll = (v: unknown, parentKey?: string): unknown => {
    if (Array.isArray(v)) return v.map((x) => aliasAll(x));
    if (v !== null && typeof v === "object") {
      const o: Record<string, unknown> = {};
      for (const kk of Object.keys(v as Record<string, unknown>).sort()) o[kk] = aliasAll((v as Record<string, unknown>)[kk], kk);
      return o;
    }
    if (typeof v === "string" && (parentKey === "id_room" || parentKey === "id")) {
      return roomAlias.get(v) ?? (parentKey === "id_room" ? "DANGLING" : v);
    }
    return v;
  };
  return aliasAll(c);
}

/** Канон в строку (JSON). Ключи объектов отсортированы внутри canon. */
export function sig(m: unknown): string {
  return JSON.stringify(canon(m));
}
