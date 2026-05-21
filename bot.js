(function (global) {
  "use strict";

  // ---------------------------------------------------------------------------
  // Defensive module guards (Phase 4 – Step 12)
  // ---------------------------------------------------------------------------
  function assertModule(name, obj) {
    if (!obj) {
      var msg =
        "[bot.js] FATAL: Required module '" +
        name +
        "' is not available. " +
        "Ensure " +
        name +
        " is loaded before bot.js.";
      console.error(msg);
      throw new ReferenceError(msg);
    }
  }

  assertModule("SessionManager", global.SessionManager);
  assertModule("Classifier", global.Classifier);
  assertModule("BotEvents", global.BotEvents);

  // ---------------------------------------------------------------------------
  // Module references
  // ---------------------------------------------------------------------------
  var Session = global.SessionManager;
  var Classifier = global.Classifier;
  var BotEvents = global.BotEvents;

  // ---------------------------------------------------------------------------
  // Bot configuration
  // ---------------------------------------------------------------------------
  var BOT_CONFIG = {
    botName: "Assistant",
    defaultResponse: "I'm not sure I understand. Could you rephrase that?",
    greetingMessage: "Hello! How can I help you today?",
    sessionTimeoutMs: 30 * 60 * 1000, // 30 minutes
    debug: false,
  };

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------
  function log() {
    if (BOT_CONFIG.debug) {
      var args = Array.prototype.slice.call(arguments);
      args.unshift("[bot.js]");
      console.log.apply(console, args);
    }
  }

  function warn() {
    var args = Array.prototype.slice.call(arguments);
    args.unshift("[bot.js] WARN:");
    console.warn.apply(console, args);
  }

  // ---------------------------------------------------------------------------
  // Session orchestration (delegates entirely to session.js)
  // ---------------------------------------------------------------------------
  function getOrCreateSession(userId) {
    var session = Session.get(userId);
    if (!session) {
      session = Session.create(userId, {
        startedAt: Date.now(),
        turnCount: 0,
        lastIntent: null,
        context: {},
      });
      log("Created new session for user:", userId);
      BotEvents.emit("session:created", { userId: userId, session: session });
    }
    return session;
  }

  function updateSessionAfterTurn(userId, intentResult) {
    var session = Session.get(userId);
    if (!session) {
      warn("Attempted to update session for unknown user:", userId);
      return;
    }
    var updates = {
      turnCount: (session.turnCount || 0) + 1,
      lastIntent: intentResult.intent || null,
      lastActive: Date.now(),
      context: Object.assign({}, session.context || {}, intentResult.context || {}),
    };
    Session.update(userId, updates);
    log("Session updated for user:", userId, updates);
  }

  function destroySession(userId) {
    Session.destroy(userId);
    BotEvents.emit("session:destroyed", { userId: userId });
    log("Session destroyed for user:", userId);
  }

  // ---------------------------------------------------------------------------
  // Classification orchestration (delegates entirely to classifier.js)
  // ---------------------------------------------------------------------------
  function classify(message, sessionContext) {
    var result;
    try {
      result = Classifier.classify(message, sessionContext);
    } catch (err) {
      warn("Classifier threw an error:", err);
      result = {
        intent: "unknown",
        confidence: 0,
        context: {},
        raw: message,
      };
    }
    log("Classification result:", result);
    return result;
  }

  // ---------------------------------------------------------------------------
  // Response generation
  // ---------------------------------------------------------------------------
  var RESPONSE_HANDLERS = {
    greeting: function () {
      return BOT_CONFIG.greetingMessage;
    },
    farewell: function () {
      return "Goodbye! Have a great day!";
    },
    thanks: function () {
      return "You're welcome! Is there anything else I can help you with?";
    },
    help: function () {
      return (
        "I can help you with a variety of topics. " +
        "Just type your question and I'll do my best to assist."
      );
    },
    affirmative: function () {
      return "Great! Let me know if you need anything else.";
    },
    negative: function () {
      return "I understand. How else can I assist you?";
    },
    unknown: function () {
      return BOT_CONFIG.defaultResponse;
    },
  };

  function generateResponse(intentResult, session) {
    var intent = intentResult.intent || "unknown";
    var handler = RESPONSE_HANDLERS[intent] || RESPONSE_HANDLERS["unknown"];
    var response;
    try {
      response = handler(intentResult, session);
    } catch (err) {
      warn("Response handler threw an error for intent '" + intent + "':", err);
      response = BOT_CONFIG.defaultResponse;
    }
    log("Generated response for intent '" + intent + "':", response);
    return response;
  }

  // ---------------------------------------------------------------------------
  // Core message pipeline
  // incoming message → classifier → session update → bot-events → response
  // ---------------------------------------------------------------------------
  function processMessage(userId, rawMessage) {
    if (typeof rawMessage !== "string" || rawMessage.trim() === "") {
      warn("processMessage called with empty or invalid message.");
      return null;
    }

    var message = rawMessage.trim();
    log("Processing message from user '" + userId + "':", message);

    // Step 1: Get or create session
    var session = getOrCreateSession(userId);

    // Step 2: Emit pre-classification event
    BotEvents.emit("message:received", {
      userId: userId,
      message: message,
      session: session,
    });

    // Step 3: Classify the message
    var intentResult = classify(message, session.context || {});

    // Step 4: Update session state
    updateSessionAfterTurn(userId, intentResult);
    var updatedSession = Session.get(userId);

    // Step 5: Emit post-classification event
    BotEvents.emit("message:classified", {
      userId: userId,
      message: message,
      intentResult: intentResult,
      session: updatedSession,
    });

    // Step 6: Generate response
    var response = generateResponse(intentResult, updatedSession);

    // Step 7: Emit response ready event
    BotEvents.emit("message:response", {
      userId: userId,
      message: message,
      response: response,
      intentResult: intentResult,
      session: updatedSession,
    });

    // Step 8: Handle session teardown on farewell
    if (intentResult.intent === "farewell") {
      destroySession(userId);
    }

    return response;
  }

  // ---------------------------------------------------------------------------
  // DOM interface helpers
  // ---------------------------------------------------------------------------
  function appendMessage(container, text, role) {
    if (!container) return;
    var messageEl = document.createElement("div");
    messageEl.className = "chat-message chat-message--" + (role || "bot");
    var bubbleEl = document.createElement("span");
    bubbleEl.className = "chat-bubble";
    bubbleEl.textContent = text;
    messageEl.appendChild(bubbleEl);
    container.appendChild(messageEl);
    container.scrollTop = container.scrollHeight;
  }

  function setInputState(inputEl, buttonEl, disabled) {
    if (inputEl) inputEl.disabled = disabled;
    if (buttonEl) buttonEl.disabled = disabled;
  }

  // ---------------------------------------------------------------------------
  // DOM bootstrap
  // ---------------------------------------------------------------------------
  function initDOM() {
    var chatContainer = document.getElementById("chat-messages");
    var chatInput = document.getElementById("chat-input");
    var chatSend = document.getElementById("chat-send");
    var chatForm = document.getElementById("chat-form");

    if (!chatContainer || !chatInput) {
      warn("Required DOM elements (#chat-messages, #chat-input) not found. Bot UI not initialized.");
      return;
    }

    // Generate a stable anonymous user ID for this browser session
    var userId =
      (global.sessionStorage && global.sessionStorage.getItem("bot_user_id")) ||
      "user_" + Math.random().toString(36).slice(2, 10);
    if (global.sessionStorage) {
      global.sessionStorage.setItem("bot_user_id", userId);
    }

    log("Bot UI initialized. userId:", userId);

    // Register BotEvents listeners for DOM updates
    BotEvents.on("message:response", function (payload) {
      if (payload.userId !== userId) return;
      appendMessage(chatContainer, payload.response, "bot");
      setInputState(chatInput, chatSend, false);
      if (chatInput) chatInput.focus();
    });

    BotEvents.on("session:created", function (payload) {
      log("Session created event received:", payload.userId);
    });

    BotEvents.on("session:destroyed", function (payload) {
      log("Session destroyed event received:", payload.userId);
    });

    // Display greeting on load
    appendMessage(chatContainer, BOT_CONFIG.greetingMessage, "bot");

    // Handle send action
    function handleSend() {
      var text = chatInput ? chatInput.value.trim() : "";
      if (!text) return;
      appendMessage(chatContainer, text, "user");
      chatInput.value = "";
      setInputState(chatInput, chatSend, true);
      try {
        processMessage(userId, text);
      } catch (err) {
        warn("processMessage threw an unexpected error:", err);
        appendMessage(chatContainer, BOT_CONFIG.defaultResponse, "bot");
        setInputState(chatInput, chatSend, false);
      }
    }

    // Bind form submit
    if (chatForm) {
      chatForm.addEventListener("submit", function (e) {
        e.preventDefault();
        handleSend();
      });
    }

    // Bind send button click (in case there's no wrapping form)
    if (chatSend && !chatForm) {
      chatSend.addEventListener("click", function () {
        handleSend();
      });
    }

    // Bind Enter key on input
    if (chatInput) {
      chatInput.addEventListener("keydown", function (e) {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          handleSend();
        }
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Public API exposed on global namespace
  // ---------------------------------------------------------------------------
  var Bot = {
    init: function (config) {
      if (config && typeof config === "object") {
        Object.assign(BOT_CONFIG, config);
      }
      initDOM();
      log("Bot initialized with config:", BOT_CONFIG);
      return Bot;
    },
    processMessage: processMessage,
    destroySession: destroySession,
    getSession: function (userId) {
      return Session.get(userId);
    },
    registerResponseHandler: function (intent, fn) {
      if (typeof intent !== "string" || typeof fn !== "function") {
        warn("registerResponseHandler: invalid arguments.");
        return;
      }
      RESPONSE_HANDLERS[intent] = fn;
      log("Registered custom response handler for intent:", intent);
    },
    on: function (event, handler) {
      BotEvents.on(event, handler);
    },
    off: function (event, handler) {
      BotEvents.off(event, handler);
    },
    _config: BOT_CONFIG,
  };

  global.Bot = Bot;

  // ---------------------------------------------------------------------------
  // Auto-initialize when DOM is ready
  // ---------------------------------------------------------------------------
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () {
      Bot.init();
    });
  } else {
    Bot.init();
  }
})(typeof window !== "undefined" ? window : this);
