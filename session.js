/**
 * session.js
 * ---------------------------------------------------------------------------
 * Lightweight in-memory session store exposed as a global `SessionManager`.
 * Manages per-user session lifecycle: create, read, update, destroy, and
 * optional TTL-based expiry.
 *
 * Consumed by bot.js — do NOT import bot.js from here (one-directional graph).
 */
(function (global) {
  "use strict";

  /** @type {Object.<string, {data: Object, createdAt: number, updatedAt: number}>} */
  var _store = {};

  /**
   * Create a new session for userId.  Throws if a session already exists.
   * @param {string} userId
   * @param {Object} [initialData]
   * @returns {Object} The session data object.
   */
  function create(userId, initialData) {
    if (typeof userId !== "string" || userId.trim() === "") {
      throw new TypeError("[SessionManager] create: userId must be a non-empty string.");
    }
    if (_store[userId]) {
      console.warn("[SessionManager] Session already exists for userId:", userId, "— returning existing.");
      return _store[userId].data;
    }
    var now = Date.now();
    _store[userId] = {
      data: Object.assign({ userId: userId }, initialData || {}),
      createdAt: now,
      updatedAt: now,
    };
    return _store[userId].data;
  }

  /**
   * Retrieve the session data for userId, or null if not found.
   * @param {string} userId
   * @returns {Object|null}
   */
  function get(userId) {
    var entry = _store[userId];
    if (!entry) return null;
    return entry.data;
  }

  /**
   * Shallow-merge updates into an existing session.
   * @param {string} userId
   * @param {Object} updates
   * @returns {Object|null} Updated session data, or null if session not found.
   */
  function update(userId, updates) {
    if (!_store[userId]) {
      console.warn("[SessionManager] update: No session found for userId:", userId);
      return null;
    }
    Object.assign(_store[userId].data, updates);
    _store[userId].updatedAt = Date.now();
    return _store[userId].data;
  }

  /**
   * Destroy a session, removing all stored data.
   * @param {string} userId
   * @returns {boolean} True if a session was removed, false if not found.
   */
  function destroy(userId) {
    if (!_store[userId]) {
      console.warn("[SessionManager] destroy: No session found for userId:", userId);
      return false;
    }
    delete _store[userId];
    return true;
  }

  /**
   * Check whether a session exists for userId.
   * @param {string} userId
   * @returns {boolean}
   */
  function has(userId) {
    return Object.prototype.hasOwnProperty.call(_store, userId);
  }

  /**
   * Destroy all sessions whose updatedAt is older than maxAgeMs.
   * @param {number} maxAgeMs
   * @returns {number} Number of sessions removed.
   */
  function purgeExpired(maxAgeMs) {
    if (typeof maxAgeMs !== "number" || maxAgeMs <= 0) {
      throw new TypeError("[SessionManager] purgeExpired: maxAgeMs must be a positive number.");
    }
    var now = Date.now();
    var removed = 0;
    Object.keys(_store).forEach(function (userId) {
      if (now - _store[userId].updatedAt > maxAgeMs) {
        delete _store[userId];
        removed++;
      }
    });
    return removed;
  }

  /**
   * Return a snapshot of all active session data objects.
   * @returns {Object.<string, Object>}
   */
  function all() {
    var snapshot = {};
    Object.keys(_store).forEach(function (userId) {
      snapshot[userId] = Object.assign({}, _store[userId].data);
    });
    return snapshot;
  }

  /**
   * Return the number of active sessions.
   * @returns {number}
   */
  function count() {
    return Object.keys(_store).length;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------
  global.SessionManager = {
    create: create,
    get: get,
    update: update,
    destroy: destroy,
    has: has,
    purgeExpired: purgeExpired,
    all: all,
    count: count,
  };
})(typeof globalThis !== "undefined" ? globalThis : global);
