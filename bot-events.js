/**
 * bot-events.js — Lightweight event bus for bot lifecycle events.
 * Exposes a global `BotEvents` object for non-ESM consumption.
 */

(function (global) {
  'use strict';

  // ─── Event Name Constants ─────────────────────────────────────────────────

  const EVENTS = Object.freeze({
    USER_INPUT_RECEIVED:  'USER_INPUT_RECEIVED',
    INTENT_CLASSIFIED:    'INTENT_CLASSIFIED',
    BOT_RESPONSE_READY:   'BOT_RESPONSE_READY',
    ERROR_OCCURRED:       'ERROR_OCCURRED',
    SESSION_UPDATED:      'SESSION_UPDATED',
    SESSION_CLEARED:      'SESSION_CLEARED',
    BOT_INITIALIZED:      'BOT_INITIALIZED',
    BOT_DESTROYED:        'BOT_DESTROYED'
  });

  // ─── Private State ────────────────────────────────────────────────────────

  let _listeners = {};   // { eventName: [ { handler: fn, once: bool } ] }
  let _initialized = false;

  // ─── Private Helpers ──────────────────────────────────────────────────────

  function _assertInitialized(method) {
    if (!_initialized) {
      throw new Error('[BotEvents] ' + method + '() called before init(). Call BotEvents.init() first.');
    }
  }

  function _validateEventName(name) {
    if (typeof name !== 'string' || name.trim() === '') {
      throw new TypeError('[BotEvents] Event name must be a non-empty string.');
    }
  }

  function _validateHandler(handler) {
    if (typeof handler !== 'function') {
      throw new TypeError('[BotEvents] Event handler must be a function.');
    }
  }

  // ─── Public API ───────────────────────────────────────────────────────────

  /**
   * init()
   * Bootstrap the event bus. Clears any stale listeners.
   */
  function init() {
    _listeners = {};
    _initialized = true;
    console.log('[BotEvents] Initialized.');
  }

  /**
   * on(event, handler)
   * Subscribe to an event. Handler is called every time the event is emitted.
   *
   * @param {string}   event    Event name (use BotEvents.EVENTS.* constants).
   * @param {Function} handler  Callback receiving the event payload.
   * @returns {{ unsubscribe: Function }} Unsubscribe handle.
   */
  function on(event, handler) {
    _assertInitialized('on');
    _validateEventName(event);
    _validateHandler(handler);

    if (!_listeners[event]) {
      _listeners[event] = [];
    }

    // Guard against duplicate handler registration for the same event
    const isDuplicate = _listeners[event].some(entry => entry.handler === handler);
    if (isDuplicate) {
      console.warn('[BotEvents] Duplicate handler registration ignored for event:', event);
      return {
        unsubscribe: () => off(event, handler)
      };
    }

    _listeners[event].push({ handler, once: false });

    return {
      unsubscribe: () => off(event, handler)
    };
  }

  /**
   * once(event, handler)
   * Subscribe to an event for a single invocation. Auto-unsubscribes after firing.
   *
   * @param {string}   event
   * @param {Function} handler
   * @returns {{ unsubscribe: Function }}
   */
  function once(event, handler) {
    _assertInitialized('once');
    _validateEventName(event);
    _validateHandler(handler);

    if (!_listeners[event]) {
      _listeners[event] = [];
    }

    _listeners[event].push({ handler, once: true });

    return {
      unsubscribe: () => off(event, handler)
    };
  }

  /**
   * off(event, handler)
   * Remove a specific handler from an event.
   *
   * @param {string}   event
   * @param {Function} handler
   */
  function off(event, handler) {
    _assertInitialized('off');
    _validateEventName(event);
    _validateHandler(handler);

    if (!_listeners[event]) return;

    _listeners[event] = _listeners[event].filter(entry => entry.handler !== handler);
  }

  /**
   * emit(event, payload)
   * Fire an event, calling all registered handlers in registration order.
   * Errors in individual handlers are caught and logged without stopping propagation.
   *
   * @param {string} event
   * @param {*}      [payload]
   */
  function emit(event, payload) {
    _assertInitialized('emit');
    _validateEventName(event);

    const entries = _listeners[event];
    if (!entries || entries.length === 0) return;

    // Snapshot to safely handle mutations during iteration
    const snapshot = entries.slice();
    const toRemove = [];

    for (const entry of snapshot) {
      try {
        entry.handler(payload);
      } catch (err) {
        console.error('[BotEvents] Handler error on event "' + event + '":', err);
      }
      if (entry.once) {
        toRemove.push(entry.handler);
      }
    }

    for (const handler of toRemove) {
      off(event, handler);
    }
  }

  /**
   * removeAllListeners(event)
   * Clear all handlers for a given event, or all events if no argument provided.
   *
   * @param {string} [event]
   */
  function removeAllListeners(event) {
    _assertInitialized('removeAllListeners');

    if (event !== undefined) {
      _validateEventName(event);
      delete _listeners[event];
    } else {
      _listeners = {};
    }
  }

  /**
   * listenerCount(event)
   * Return the number of handlers registered for an event.
   *
   * @param {string} event
   * @returns {number}
   */
  function listenerCount(event) {
    _assertInitialized('listenerCount');
    _validateEventName(event);
    return (_listeners[event] || []).length;
  }

  /**
   * destroy()
   * Tear down the event bus completely.
   */
  function destroy() {
    _listeners = {};
    _initialized = false;
    console.log('[BotEvents] Destroyed.');
  }

  // ─── Export ───────────────────────────────────────────────────────────────

  const BotEvents = {
    EVENTS,
    init,
    on,
    once,
    off,
    emit,
    removeAllListeners,
    listenerCount,
    destroy
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = BotEvents;
  } else {
    global.BotEvents = BotEvents;
  }

}(typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : this));
