// 字节预算 LRU（docs/08 §5）。可见页与预取页受保护，绝不逐出。

export interface LruEntry<V> {
  value: V;
  bytes: number;
}

export class BoundedLru<V, K = number> {
  private readonly map = new Map<K, LruEntry<V>>();
  private usedBytes = 0;

  constructor(public budgetBytes: number) {}

  get size(): number {
    return this.map.size;
  }

  get used(): number {
    return this.usedBytes;
  }

  get(key: K): V | undefined {
    const entry = this.map.get(key);
    if (entry === undefined) return undefined;
    // 触碰即刷新顺序（Map 保持插入顺序）。
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  peek(key: K): V | undefined {
    return this.map.get(key)?.value;
  }

  set(key: K, value: V, bytes: number): void {
    const existing = this.map.get(key);
    if (existing !== undefined) {
      this.usedBytes -= existing.bytes;
      this.map.delete(key);
    }
    this.map.set(key, { value, bytes });
    this.usedBytes += bytes;
  }

  /// 逐出直到满足预算；受保护的 key 不逐出（返回被逐出的 key 列表）。
  evict(protectedKeys: ReadonlySet<K> = new Set()): K[] {
    const evicted: K[] = [];
    if (this.usedBytes <= this.budgetBytes) return evicted;
    for (const [key, entry] of this.map) {
      if (this.usedBytes <= this.budgetBytes) break;
      if (protectedKeys.has(key)) continue;
      this.map.delete(key);
      this.usedBytes -= entry.bytes;
      evicted.push(key);
    }
    return evicted;
  }

  delete(key: K): boolean {
    const entry = this.map.get(key);
    if (entry === undefined) return false;
    this.map.delete(key);
    this.usedBytes -= entry.bytes;
    return true;
  }

  clear(): void {
    this.map.clear();
    this.usedBytes = 0;
  }

  keys(): K[] {
    return [...this.map.keys()];
  }
}
