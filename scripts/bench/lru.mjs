// 字节预算 LRU，键为页码。Map 的插入顺序即 LRU 顺序：读命中后重新插入到尾部。
export class ByteBudgetLRU {
  constructor(budgetBytes, label = "lru") {
    this.label = label;
    this.budgetBytes = budgetBytes;
    this.bytes = 0;
    this.map = new Map();
    this.hits = 0;
    this.misses = 0;
    this.evictions = 0;
    this.peakBytes = 0;
  }

  get(key) {
    const entry = this.map.get(key);
    if (entry === undefined) {
      this.misses += 1;
      return undefined;
    }
    this.map.delete(key);
    this.map.set(key, entry);
    this.hits += 1;
    return entry.value;
  }

  set(key, value, costBytes) {
    const cost = Math.max(1, Math.ceil(costBytes));
    const prev = this.map.get(key);
    if (prev !== undefined) {
      this.map.delete(key);
      this.bytes -= prev.cost;
    }
    while (this.bytes + cost > this.budgetBytes && this.map.size > 0) {
      const oldestKey = this.map.keys().next().value;
      const oldest = this.map.get(oldestKey);
      this.map.delete(oldestKey);
      this.bytes -= oldest.cost;
      this.evictions += 1;
    }
    if (cost > this.budgetBytes) return false; // 单页超预算：不缓存
    this.map.set(key, { value, cost });
    this.bytes += cost;
    if (this.bytes > this.peakBytes) this.peakBytes = this.bytes;
    return true;
  }

  stats() {
    return {
      label: this.label,
      budgetBytes: this.budgetBytes,
      entries: this.map.size,
      bytes: this.bytes,
      peakBytes: this.peakBytes,
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
    };
  }
}

// 每页近似内存成本：字符串按 UTF-16 计 2 字节，item 结构按 64 字节估，另加固定开销。
export function pageCostBytes(textContent) {
  let chars = 0;
  for (const item of textContent.items) chars += item.str.length;
  return chars * 2 + textContent.items.length * 64 + 256;
}
