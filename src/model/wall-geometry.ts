import type { Model, Point, Wall } from "./types.ts";
import { add, dist, leftNormal, lineIntersection, scale, sub, type Segment } from "./geometry.ts";
import { McpError } from "../errors.ts";

// ---------- грани l1/l2/r1/r2 (обязательны перед $Project.restore) ----------

/**
 * Грани стены: сторона l — слева по ходу p1→p2 при Y вниз, смещение depth/2.
 * Вариант G (design §12.2): Node отдаёт простые грани (ось ± depth/2) — draw всё равно
 * пересчитает их с учётом соседей. Если в модели есть связи редактора (нормализованная
 * модель), грань на node-стыке пересекается с гранью соседа по правилу внутренних/внешних
 * углов (находка №7 ревью); на коллинеарном стыке грань завершается на общем срезе.
 */
export function wallFaces(wall: Wall, walls: Record<string, Wall>): { l1: Point; l2: Point; r1: Point; r2: Point } {
  const dir = sub(wall.p2, wall.p1);
  const len = Math.hypot(dir.x, dir.y);
  if (len < 1e-9) throw new McpError("GEOMETRY_CONFLICT", `стена ${wall.id} нулевой длины`);
  const u = scale(dir, 1 / len);
  const n = leftNormal(u.x, u.y); // единичная нормаль к стороне l
  const halfOwn = wall.depth / 2;

  const faceLine = (a: Point, b: Point): Segment => ({ p1: a, p2: b });
  const ourL = faceLine(add(wall.p1, scale(n, halfOwn)), add(wall.p2, scale(n, halfOwn)));
  const ourR = faceLine(sub(wall.p1, scale(n, halfOwn)), sub(wall.p2, scale(n, halfOwn)));

  function endpoint(node: Point, own: "p1" | "p2", forward: 1 | -1, side: "l" | "r"): Point {
    const sideSign = side === "l" ? 1 : -1;
    const sideN = scale(n, sideSign * halfOwn);
    const link = wall[own].link;
    if (!link || link.ct !== "node") {
      // свободный узел или T-конец — грань заканчивается на срезе стены
      return add(node, sideN);
    }
    const neighbor = walls[link.id];
    if (!neighbor || Math.hypot(neighbor.p2.x - neighbor.p1.x, neighbor.p2.y - neighbor.p1.y) < 1e-9) {
      return add(node, sideN);
    }
    const nbrLen = Math.hypot(neighbor.p2.x - neighbor.p1.x, neighbor.p2.y - neighbor.p1.y);
    const dN = scale(sub(neighbor.p2, neighbor.p1), 1 / nbrLen);
    // лучи из узла внутрь каждой стены
    const nodeIsOurP1 = own === "p1";
    const rOwn = nodeIsOurP1 ? u : scale(u, -1);
    const nodeIsNbrP1 = dist(neighbor.p1, node) <= dist(neighbor.p2, node);
    const rNbr = nodeIsNbrP1 ? dN : scale(dN, -1);
    // коллинеарный стык: прямое продолжение — грань до общего среза, без удлинения (№7)
    if (Math.abs(rOwn.x * rNbr.y - rOwn.y * rNbr.x) < 1e-6) {
      return add(node, sideN);
    }
    // направление «угла помещения»: биссектриса квадранта между лучами наших тел (№7);
    const D = { x: rOwn.x + rNbr.x, y: rOwn.y + rNbr.y };
    const ourRoomSideIsL = n.x * D.x + n.y * D.y > 0;
    const nn = leftNormal(dN.x, dN.y); // нормаль к стороне l соседа
    const nbrRoomSideSign = nn.x * D.x + nn.y * D.y > 0 ? 1 : -1; // +1 — l, −1 — r
    const nbrHalf = neighbor.depth / 2;
    const nbrFaceLine = (sign: number): Segment =>
      faceLine(add(neighbor.p1, scale(nn, sign * nbrHalf)), add(neighbor.p2, scale(nn, sign * nbrHalf)));
    const ourLine = side === "l" ? ourL : ourR;
    const isRoomSide = side === "l" ? ourRoomSideIsL : !ourRoomSideIsL;
    const nbrSign = isRoomSide ? nbrRoomSideSign : -nbrRoomSideSign;
    const isect = lineIntersection(ourLine, nbrFaceLine(nbrSign));
    if (isect) return isect;
    // прямые не пересекаются (численный край) — удлинение на свою полутолщину
    return add(add(node, sideN), scale(u, (forward * wall.depth) / 2));
  }

  return {
    l1: endpoint(wall.p1, "p1", -1, "l"),
    l2: endpoint(wall.p2, "p2", 1, "l"),
    r1: endpoint(wall.p1, "p1", -1, "r"),
    r2: endpoint(wall.p2, "p2", 1, "r"),
  };
}

/** Проставляет l1/l2/r1/r2 всем стенам модели. */
export function prepareWallFaces(model: Model): void {
  for (const wall of Object.values(model.walls)) {
    try {
      const f = wallFaces(wall, model.walls);
      wall.l1 = f.l1;
      wall.l2 = f.l2;
      wall.r1 = f.r1;
      wall.r2 = f.r2;
    } catch {
      // вырожденная стена (нулевой длины): граней нет — валидатор сообщит MISSING_WALL_FACES
    }
  }
}
