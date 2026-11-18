import { describe, expect, it } from "vitest";

import { BoundedLru } from "./lru";

describe("BoundedLru", () => {
  it("超出预算时逐出最旧的非保护项", () => {
    const lru = new BoundedLru<string>(300);
    lru.set(1, "a", 100);
    lru.set(2, "b", 100);
    lru.set(3, "c", 100);
    expect(lru.used).toBe(300);
    lru.set(4, "d", 100);
    const evicted = lru.evict(new Set([4]));
    expect(evicted).toEqual([1]);
    expect(lru.get(1)).toBeUndefined();
    expect(lru.get(4)).toBe("d");
  });

  it("受保护页绝不逐出", () => {
    const lru = new BoundedLru<string>(200);
    lru.set(1, "a", 100);
    lru.set(2, "b", 100);
    lru.set(3, "c", 100);
    const evicted = lru.evict(new Set([1, 2, 3]));
    expect(evicted).toEqual([]);
    expect(lru.used).toBe(300); // 超预算但全部受保护：宁可超也不逐出
  });

  it("get 会刷新顺序", () => {
    const lru = new BoundedLru<string>(300);
    lru.set(1, "a", 100);
    lru.set(2, "b", 100);
    lru.set(3, "c", 100);
    lru.get(1);
    lru.set(4, "d", 100);
    expect(lru.evict(new Set([4]))).toEqual([2]);
  });

  it("delete 与 clear 正确维护字节数", () => {
    const lru = new BoundedLru<string>(300);
    lru.set(1, "a", 120);
    lru.delete(1);
    expect(lru.used).toBe(0);
    lru.set(2, "b", 50);
    lru.clear();
    expect(lru.used).toBe(0);
    expect(lru.size).toBe(0);
  });
});
