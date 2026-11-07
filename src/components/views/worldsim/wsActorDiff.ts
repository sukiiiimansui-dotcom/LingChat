/* wsActorDiff.ts —— 立绘集合的**纯函数 diff**（task-16）。
 *
 * ## 为什么有它
 * 行程活跃时上游每 200ms 推一份**新数组**（`useWorldTrips` 的插值时钟 → `WsCityEntry.mapPins`
 * → `stageActors` → `contractActors`），旧的后端实现把"值更新"当成"集合重建"：
 * 每次 `setActors` 都把全部立绘 `dispose()` 再 `createCharacter()` 一遍（5 Hz × 最多 24 个）。
 * 这里只做**按 id 比较两份名单**（纯函数、可脱浏览器单测），后端据此复用对象、只移动位置。
 *
 * ## 口径
 * · id 是身份：`added` = next 有、prev 没有；`removed` = prev 有、next 没有；
 * · `kept` = 两边都有（顺序按 next），`renamed = name 变了`（立绘 index 由 name 决定 ⇒ 调用方重建这一个）；
 * · 不做位置比较：位置是否变化由调用方读 `obj.position`/经纬度后决定（这里不碰坐标）。
 */
export interface ActorIdentity {
  id: string;
  name: string;
}

export interface ActorDiff<A extends ActorIdentity, B extends ActorIdentity> {
  added: B[];
  removed: A[];
  kept: Array<{ prev: A; next: B; renamed: boolean }>;
}

/** 按 id 比较两份立绘名单（prev 先、next 后；id 视为唯一）。 */
export function diffActors<A extends ActorIdentity, B extends ActorIdentity>(
  prev: readonly A[],
  next: readonly B[],
): ActorDiff<A, B> {
  const prevById = new Map<string, A>();
  for (const p of prev) prevById.set(p.id, p);
  const nextIds = new Set<string>();
  const added: B[] = [];
  const kept: Array<{ prev: A; next: B; renamed: boolean }> = [];
  for (const n of next) {
    nextIds.add(n.id);
    const p = prevById.get(n.id);
    if (!p) added.push(n);
    else kept.push({ prev: p, next: n, renamed: p.name !== n.name });
  }
  const removed = prev.filter((p) => !nextIds.has(p.id));
  return { added, removed, kept };
}
