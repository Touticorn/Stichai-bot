"use strict";

/**
 * LRUMap — Least-Recently-Used cache backed by insertion-order Map.
 * get() promotes the key; set() evicts the oldest when full.
 */
class LRUMap {
  constructor(limit) {
    this.limit = limit;
    this.map   = new Map();
  }

  get(key) {
    const val = this.map.get(key);
    if (val !== undefined) {
      this.map.delete(key);
      this.map.set(key, val);
    }
    return val;
  }

  set(key, val) {
    if (this.map.has(key)) this.map.delete(key);
    else if (this.map.size >= this.limit) {
      this.map.delete(this.map.keys().next().value);
    }
    this.map.set(key, val);
  }

  delete(key) { this.map.delete(key); }
  has(key)    { return this.map.has(key); }
  clear()     { this.map.clear(); }
  get size()  { return this.map.size; }
}

module.exports = { LRUMap };
