/**
 * PTY 所有权注册表 — 统一管理 PTY 与 session 间的映射关系。
 *
 * 职责：
 * - 1:1 PTY 所有权映射（ptyId → ownerKey，如 live-<uuid> → live-<uuid>）
 * - 1:N 数据路由（PTY ID → Set<routeId>，子 session 也需接收 PTY 数据）
 * - 虚拟 session 映射（virtualKey → ptyId，如 pi-<uuid> → live-<uuid>）
 *
 * 替换 main/index.ts 中的 dataRoutes Map 和 terminalHandlers.ts 中的 ptyOwners Map。
 */
export class PtyOwnershipRegistry {
  /** 1:1 PTY 所有权映射：ptyId → ownerKey */
  private owners = new Map<string, string>();

  /** 1:N 数据路由：PTY ID → Set<子 session key> */
  private routes = new Map<string, Set<string>>();

  /** 虚拟 session 映射：virtualKey (pi-<uuid>) → ptyId (live-<uuid>) */
  private virtualToPty = new Map<string, string>();

  // ── 1:1 所有权 ──

  /** 设置 PTY 的 owner key。 */
  setOwner(ptyId: string, ownerKey: string): void {
    this.owners.set(ptyId, ownerKey);
  }

  /** 获取 PTY 的 owner key。 */
  getOwner(ptyId: string): string | undefined {
    return this.owners.get(ptyId);
  }

  /** 删除 PTY 的 owner 记录。 */
  deleteOwner(ptyId: string): void {
    this.owners.delete(ptyId);
  }

  // ── 1:N 数据路由 ──

  /** 添加路由：将 routeId 加入 PTY 的数据目标集合。 */
  addRoute(ptyId: string, routeId: string): void {
    const set = this.routes.get(ptyId) ?? new Set();
    set.add(routeId);
    this.routes.set(ptyId, set);
  }

  /** 获取 PTY 的所有路由目标。 */
  getRoutes(ptyId: string): Set<string> | undefined {
    return this.routes.get(ptyId);
  }

  /** 删除 PTY 的所有路由记录。 */
  deleteRoutes(ptyId: string): void {
    this.routes.delete(ptyId);
  }

  // ── 虚拟 session 映射 ──

  /** 设置虚拟 session 到 PTY 的映射。 */
  setVirtual(virtualKey: string, ptyId: string): void {
    this.virtualToPty.set(virtualKey, ptyId);
  }

  /** 根据虚拟 session key 反向查找 PTY ID。 */
  getVirtual(virtualKey: string): string | undefined {
    return this.virtualToPty.get(virtualKey);
  }

  /** 删除虚拟 session 映射。 */
  deleteVirtual(virtualKey: string): void {
    this.virtualToPty.delete(virtualKey);
  }

  /** 根据 owner key 反向查找 PTY ID（遍历 owners map，非 virtual key 映射）。 */
  findPtyByOwnerKey(ownerKey: string): string | undefined {
    for (const [ptyId, key] of this.owners) {
      if (key === ownerKey) return ptyId;
    }
    return undefined;
  }

  /** 遍历所有虚拟 session 的 PTY ID。 */
  *virtualPtyIds(): IterableIterator<string> {
    yield* this.virtualToPty.values();
  }

  // ── 批量操作 ──

  /** 移除 PTY 相关的所有记录（owner + routes + 虚拟映射清理）。 */
  remove(ptyId: string): {
    routes: string[];
    virtualKeys: string[];
  } {
    this.owners.delete(ptyId);
    const routes = [...(this.routes.get(ptyId) ?? [])];
    this.routes.delete(ptyId);

    // 清理关联的虚拟 session 映射
    const virtualKeys: string[] = [];
    for (const [vk, vp] of this.virtualToPty) {
      if (vp === ptyId) {
        virtualKeys.push(vk);
        this.virtualToPty.delete(vk);
      }
    }

    return { routes, virtualKeys };
  }
}