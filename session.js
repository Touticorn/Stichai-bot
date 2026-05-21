/**
 * session.js — Single source of truth for conversation state.
 * Exposes a global `Session` object for non-ESM consumption.
 */

(function (global) {
  'use strict';

  // ─── Private State ────────────────────────────────────────────────────────

  const STORAGE_KEY = 'bot_session_state';

  const DEFAULT_STATE = {
    sessionId: null,
    userId: null,
    turnCount: 0,
    currentIntent: null,
    slots: {},
    history: [],
    lastActivityAt: null,
    createdAt: null,
    meta: {}
  };

  let _state = {};
  let _persistEnabled = false;
  let _initialized = false;

  // ─── Private Helpers ──────────────────────────────────────────────────────

  function _deepClone(obj) {
    try {
      return JSON.parse(JSON.stringify(obj));
    } catch (e) {
      console.error('[Session] _deepClone failed:', e);
      return obj;
    }
  }

  function _generateId() {
    return 'sess_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 9);
  }

  function _persist() {
    if (!_persistEnabled) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(_state));
    } catch (e) {
      console.warn('[Session] Persistence write failed:', e);
    }
  }

  function _hydrate() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          return parsed;
        }
      }
    } catch (e) {
      console.warn('[Session] Hydration failed, starting fresh:', e);
    }
    return null;
  }

  function _assertInitialized(method) {
    if (!_initialized) {
      throw new Error('[Session] ' + method + '() called before init(). Call Session.init() first.');
    }
  }

  // ─── Public API ───────────────────────────────────────────────────────────

  /**
   * init(options)
   * Bootstraps the session. Must be called before any other method.
   *
   * @param {object} [options]
   * @param {boolean} [options.persist=false]   Enable localStorage persistence.
   * @param {string}  [options.userId]           Optional user identifier.
   * @param {object}  [options.initialState]     Merge extra keys into state.
   * @returns {object} The current state snapshot.
   */
  function init(options) {
    const opts = options || {};
    _persistEnabled = opts.persist === true;

    // Attempt to hydrate from storage when persistence is on
    const hydrated = _persistEnabled ? _hydrate() : null;

    _state = Object.assign({}, _deepClone(DEFAULT_STATE), hydrated || {});

    // Always ensure a sessionId
    if (!_state.sessionId) {
      _state.sessionId = _generateId();
      _state.createdAt = new Date().toISOString();
    }

    if (opts.userId) {
      _state.userId = opts.userId;
    }

    if (opts.initialState && typeof opts.initialState === 'object') {
      Object.assign(_state, _deepClone(opts.initialState));
    }

    _state.lastActivityAt = new Date().toISOString();

    _initialized = true;
    _persist();

    console.log('[Session] Initialized. Session ID:', _state.sessionId);
    return _deepClone(_state);
  }

  /**
   * get(key)
   * Retrieve a single top-level key from state.
   *
   * @param {string} key
   * @returns {*} Deep-cloned value, or undefined if key does not exist.
   */
  function get(key) {
    _assertInitialized('get');

    if (typeof key !== 'string' || key.trim() === '') {
      throw new TypeError('[Session] get() requires a non-empty string key.');
    }

    const value = _state[key];
    return value !== undefined ? _deepClone(value) : undefined;
  }

  /**
   * set(key, value)
   * Write a single top-level key into state.
   *
   * @param {string} key
   * @param {*}      value  Must not be undefined.
   * @returns {object} Updated state snapshot.
   */
  function set(key, value) {
    _assertInitialized('set');

    if (typeof key !== 'string' || key.trim() === '') {
      throw new TypeError('[Session] set() requires a non-empty string key.');
    }

    if (value === undefined) {
      throw new TypeError('[Session] set() value must not be undefined. Use clear() to reset state.');
    }

    // Type-guard known fields
    const numberFields = ['turnCount'];
    const stringFields = ['sessionId', 'userId', 'currentIntent', 'lastActivityAt', 'createdAt'];
    const objectFields = ['slots', 'meta'];
    const arrayFields  = ['history'];

    if (numberFields.includes(key) && typeof value !== 'number') {
      throw new TypeError('[Session] set(): "' + key + '" must be a number.');
    }
    if (stringFields.includes(key) && typeof value !== 'string') {
      throw new TypeError('[Session] set(): "' + key + '" must be a string.');
    }
    if (objectFields.includes(key) && (typeof value !== 'object' || Array.isArray(value) || value === null)) {
      throw new TypeError('[Session] set(): "' + key + '" must be a plain object.');
    }
    if (arrayFields.includes(key) && !Array.isArray(value)) {
      throw new TypeError('[Session] set(): "' + key + '" must be an array.');
    }

    _state[key] = _deepClone(value);
    _state.lastActivityAt = new Date().toISOString();
    _persist();

    return _deepClone(_state);
  }

  /**
   * getState()
   * Return a full deep-cloned snapshot of current state.
   *
   * @returns {object}
   */
  function getState() {
    _assertInitialized('getState');
    return _deepClone(_state);
  }

  /**
   * addTurn(turn)
   * Append a conversation turn to history. Increments turnCount and updates lastActivityAt.
   *
   * @param {object} turn
   * @param {string} turn.role     Required. 'user' | 'bot' | 'system'
   * @param {string} turn.content  Required. Non-empty string.
   * @param {object} [turn.meta]   Optional metadata.
   * @returns {object} Updated state snapshot.
   */
  function addTurn(turn) {
    _assertInitialized('addTurn');

    if (!turn || typeof turn !== 'object') {
      throw new TypeError('[Session] addTurn() requires a turn object.');
    }
    if (typeof turn.role !== 'string' || turn.role.trim() === '') {
      throw new TypeError('[Session] addTurn() requires turn.role to be a non-empty string.');
    }
    if (typeof turn.content !== 'string' || turn.content.trim() === '') {
      throw new TypeError('[Session] addTurn() requires turn.content to be a non-empty string.');
    }

    const validRoles = ['user', 'bot', 'system'];
    if (!validRoles.includes(turn.role)) {
      console.warn('[Session] addTurn(): unrecognized role "' + turn.role + '". Expected one of: ' + validRoles.join(', '));
    }

    const entry = {
      role: turn.role,
      content: turn.content,
      timestamp: new Date().toISOString(),
      meta: turn.meta ? _deepClone(turn.meta) : {}
    };

    _state.history.push(entry);
    _state.turnCount = _state.history.length;
    _state.lastActivityAt = new Date().toISOString();
    _persist();

    return _deepClone(_state);
  }

  /**
   * setSlots(slots)
   * Merge a slots object into state.slots (shallow merge — individual slot keys).
   *
   * @param {object} slots  Key/value pairs to merge.
   * @returns {object} Updated state snapshot.
   */
  function setSlots(slots) {
    _assertInitialized('setSlots');

    if (!slots || typeof slots !== 'object' || Array.isArray(slots)) {
      throw new TypeError('[Session] setSlots() requires a plain object.');
    }

    Object.assign(_state.slots, _deepClone(slots));
    _state.lastActivityAt = new Date().toISOString();
    _persist();

    return _deepClone(_state);
  }

  /**
   * setIntent(intent)
   * Record the current detected intent.
   *
   * @param {string} intent  Non-empty intent string.
   * @returns {object} Updated state snapshot.
   */
  function setIntent(intent) {
    _assertInitialized('setIntent');

    if (typeof intent !== 'string' || intent.trim() === '') {
      throw new TypeError('[Session] setIntent() requires a non-empty string.');
    }

    _state.currentIntent = intent;
    _state.lastActivityAt = new Date().toISOString();
    _persist();

    return _deepClone(_state);
  }

  /**
   * clear()
   * Reset state to defaults while preserving the sessionId and createdAt.
   *
   * @returns {object} Fresh state snapshot.
   */
  function clear() {
    _assertInitialized('clear');

    const preserved = {
      sessionId: _state.sessionId,
      createdAt: _state.createdAt,
      userId: _state.userId
    };

    _state = Object.assign({}, _deepClone(DEFAULT_STATE), preserved);
    _state.lastActivityAt = new Date().toISOString();
    _persist();

    console.log('[Session] State cleared.');
    return _deepClone(_state);
  }

  /**
   * destroy()
   * Fully tear down the session: clear state, remove from storage, reset flags.
   */
  function destroy() {
    _state = {};
    _initialized = false;
    _persistEnabled = false;

    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch (e) {
      console.warn('[Session] destroy(): failed to remove storage key:', e);
    }

    console.log('[Session] Destroyed.');
  }

  // ─── Export ───────────────────────────────────────────────────────────────

  const Session = {
    init,
    get,
    set,
    getState,
    addTurn,
    setSlots,
    setIntent,
    clear,
    destroy
  };

  // Support both CommonJS (Node test harness) and browser global
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = Session;
  } else {
    global.Session = Session;
  }

}(typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : this));
