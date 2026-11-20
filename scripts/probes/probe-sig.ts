// Общий семантический канон GET-модели для живых проб (310-m11-live, 310-zonec):
// производные поля (полигоны/рёбра зон, ids, edges2, служебные ключи) приводятся
// к канонической форме — сверка модели с бэкапом и контрольного проекта до/после
// идёт по пользовательским данным (ревью 285 №3, ревью 311 №5).
export function sig(m: unknown): string {
  const c = structuredClone(m) as Record<string, unknown>;
  for (const k of ["errors", "logs", "log_plan", "session", "version", "drawing", "params", "final", "signals", "smeta_water_pipes", "save_id", "is_forced"]) delete c[k];
  for (const k of ["borders", "drawings"]) {
    if (Array.isArray(c[k])) c[k] = [...(c[k] as unknown[])].map((e) => JSON.stringify(e)).sort();
  }
  const walls = (c["walls"] ?? {}) as Record<string, Record<string, unknown>>;
  for (const w of Object.values(walls)) {
    const eds2 = w["eds2"] as Record<string, unknown> | undefined;
    if (eds2) {
      for (const side of Object.keys(eds2)) {
        if (Array.isArray(eds2[side])) {
          const canon = (eds2[side] as Array<Record<string, unknown>>)
            .map((e) => ({ ...e, id: null, pc: null }))
            .map((e) => JSON.stringify(e, Object.keys(e).sort()))
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
  const polyList: string[] = [];
  const polyIndex = new Map<string, number>();
  for (const r of Object.values(rooms)) {
    const k = canonPoly(r["polygon"]);
    if (!polyIndex.has(k)) {
      polyIndex.set(k, polyList.length);
      polyList.push(k);
    }
  }
  const roomAlias = new Map<string, string>();
  Object.entries(rooms).forEach(([rid, r]) => {
    const k = canonPoly(r["polygon"]);
    const idx = polyIndex.get(k);
    roomAlias.set(rid, `RR${idx === undefined ? polyList.length : idx}`);
  });
  for (const rk of ["rooms1", "rooms2"]) {
    const map = (c[rk] ?? null) as Record<string, Record<string, unknown>> | null;
    if (map && typeof map === "object") {
      for (const rec of Object.values(map)) {
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
            canon[key] = { width: r["width"], ceiling_type: r["ceiling_type"], polygon: (r["polygon"] as Array<{ x: number; y: number }> | undefined)?.map((p) => ({ x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10 })) };
          }
          rec["rigels"] = canon;
        }
        for (const kk of ["floorMoldings", "ceilingMoldings"]) {
          if (Array.isArray(rec[kk])) {
            rec[kk] = (rec[kk] as Array<Record<string, unknown>>).map((side) => {
              const s = structuredClone(side);
              if (s && typeof s === "object" && s["parts"] && typeof s["parts"] === "object") {
                const parts: Record<string, unknown> = {};
                for (const p of Object.values(s["parts"] as Record<string, Record<string, unknown>>)) {
                  parts[JSON.stringify(p, Object.keys(p).sort())] = { ...p, id: null, id_room: null, id_ceiling: null };
                }
                s["parts"] = parts;
              }
              return s;
            });
          }
        }
        if (Array.isArray(rec["ceilings"])) {
          // производные (перестраиваются редактором при каждом save: полигоны/рёбра
          // зон, precision, edges_ceiling) — в каноническую форму: exist + отделка
          rec["ceilings"] = (rec["ceilings"] as Array<Record<string, unknown>>)
            .map((ce) => ({
              exist: ce["exist"],
              material: ce["material"] ?? null,
              level: ce["level"] ?? null,
              profile: ce["profile"] ?? null,
            }))
            .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
        }
        // edges_ceiling / demolines_ceiling_moldings — производные демолайны
        // потолочного плинтуса, перестраиваются при каждом пересчёте комнат
        for (const dk of ["edges_ceiling", "demolines_ceiling_moldings"]) {
          delete rec[dk];
        }
        // moldings: состав exist:true частей (длина массива следует за рёбрами комнаты)
        for (const mk of ["floorMoldings", "ceilingMoldings"]) {
          if (Array.isArray(rec[mk])) {
            const parts: string[] = [];
            for (const side of rec[mk] as Array<Record<string, unknown>>) {
              const p = (side?.["parts"] ?? {}) as Record<string, Record<string, unknown>>;
              for (const q of Object.values(p)) parts.push(JSON.stringify(q, Object.keys(q).sort()));
            }
            rec[mk] = parts.sort();
          }
        }
        // зоны (plan c): пользовательское — имя/микро; полигоны/рёбра — производные
        if (Array.isArray(rec["zones"])) {
          rec["zones"] = (rec["zones"] as Array<Record<string, unknown>>)
            .map((z) => ({ name: z["name"] ?? null, micro: Boolean(z["is_micro_zone"]), area: typeof z["area"] === "number" ? Math.round(z["area"] * 10) / 10 : null }))
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
  return JSON.stringify(aliasAll(c));
}
