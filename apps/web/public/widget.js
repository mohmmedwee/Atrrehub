/**
 * Atrrehub chat widget.
 *
 * Embed with:
 *   <script src="https://app.example.com/widget.js"
 *           data-api="https://api.example.com"
 *           data-key="wk_..." defer></script>
 *
 * Deliberately dependency-free and self-contained: it loads on a customer's
 * own site, so it must not pull a framework, must not collide with the host
 * page's styles, and must fail silently rather than break their page.
 */
(function () {
  'use strict';

  var script = document.currentScript;
  if (!script) return;

  var API = script.getAttribute('data-api') || window.location.origin;
  var KEY = script.getAttribute('data-key') || '';
  var TITLE = script.getAttribute('data-title') || 'Chat with us';
  var ACCENT = script.getAttribute('data-accent') || '#2563eb';
  var GREETING = script.getAttribute('data-greeting') || 'Hello! How can we help today?';

  var STORAGE_SESSION = 'atrrehub.widget.session';
  var STORAGE_TOKEN = 'atrrehub.widget.token';

  var state = { open: false, sending: false, messages: [], conversationId: null, poll: null };

  function store(key, value) {
    try {
      if (value === undefined) return localStorage.getItem(key);
      localStorage.setItem(key, value);
    } catch (error) {
      // A blocked storage API must not stop the widget working for one visit.
    }
    return value;
  }

  function sessionId() {
    var existing = store(STORAGE_SESSION);
    if (existing) return existing;
    var generated = 'ws_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    store(STORAGE_SESSION, generated);
    return generated;
  }

  // ── Styles, scoped so the host page cannot be affected ────────────────────
  var style = document.createElement('style');
  style.textContent = [
    '.atr-root{position:fixed;bottom:20px;right:20px;z-index:2147483000;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.5}',
    '.atr-root *{box-sizing:border-box}',
    '.atr-btn{width:56px;height:56px;border-radius:50%;border:none;background:' + ACCENT + ';color:#fff;font-size:22px;cursor:pointer;box-shadow:0 6px 20px rgba(0,0,0,.18);display:flex;align-items:center;justify-content:center}',
    '.atr-btn:focus-visible{outline:3px solid ' + ACCENT + ';outline-offset:3px}',
    '.atr-panel{position:absolute;bottom:70px;right:0;width:min(370px,calc(100vw - 32px));height:min(540px,calc(100vh - 120px));background:#fff;border-radius:14px;box-shadow:0 12px 40px rgba(0,0,0,.22);display:flex;flex-direction:column;overflow:hidden}',
    '.atr-head{background:' + ACCENT + ';color:#fff;padding:14px 16px;font-weight:600;display:flex;justify-content:space-between;align-items:center}',
    '.atr-close{background:none;border:none;color:#fff;font-size:20px;cursor:pointer;line-height:1;padding:0 4px}',
    '.atr-body{flex:1;overflow-y:auto;padding:14px;background:#f8fafc;display:flex;flex-direction:column;gap:8px}',
    '.atr-msg{max-width:80%;padding:8px 11px;border-radius:12px;white-space:pre-wrap;word-break:break-word}',
    '.atr-in{align-self:flex-start;background:#fff;border:1px solid #e2e8f0;color:#0f172a}',
    '.atr-out{align-self:flex-end;background:' + ACCENT + ';color:#fff}',
    '.atr-cite{margin-top:6px;padding-top:6px;border-top:1px solid rgba(0,0,0,.08);font-size:11px;opacity:.75}',
    '.atr-foot{border-top:1px solid #e2e8f0;padding:10px;display:flex;gap:8px;background:#fff}',
    '.atr-input{flex:1;border:1px solid #e2e8f0;border-radius:9px;padding:9px 11px;font:inherit;color:#0f172a;resize:none;max-height:90px}',
    '.atr-input:focus{outline:none;border-color:' + ACCENT + '}',
    '.atr-send{background:' + ACCENT + ';color:#fff;border:none;border-radius:9px;padding:0 15px;cursor:pointer;font:inherit;font-weight:600}',
    '.atr-send:disabled{opacity:.5;cursor:not-allowed}',
    '.atr-note{color:#64748b;font-size:12px;text-align:center;padding:4px}',
    '@media (prefers-reduced-motion:no-preference){.atr-panel{animation:atr-in .2s ease-out}}',
    '@keyframes atr-in{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}',
  ].join('\n');
  document.head.appendChild(style);

  // ── Markup ────────────────────────────────────────────────────────────────
  var root = document.createElement('div');
  root.className = 'atr-root';
  root.innerHTML =
    '<div class="atr-panel" hidden role="dialog" aria-label="' + escapeAttribute(TITLE) + '">' +
    '<div class="atr-head"><span>' + escapeHtml(TITLE) + '</span>' +
    '<button class="atr-close" aria-label="Close chat">&times;</button></div>' +
    '<div class="atr-body" aria-live="polite"></div>' +
    '<div class="atr-foot">' +
    '<textarea class="atr-input" rows="1" placeholder="Write a message…" aria-label="Message"></textarea>' +
    '<button class="atr-send">Send</button></div></div>' +
    '<button class="atr-btn" aria-label="Open chat" aria-expanded="false">&#128172;</button>';
  document.body.appendChild(root);

  var panel = root.querySelector('.atr-panel');
  var toggle = root.querySelector('.atr-btn');
  var closeButton = root.querySelector('.atr-close');
  var body = root.querySelector('.atr-body');
  var input = root.querySelector('.atr-input');
  var sendButton = root.querySelector('.atr-send');

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, function (character) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character];
    });
  }
  function escapeAttribute(value) {
    return escapeHtml(value).replace(/"/g, '&quot;');
  }

  function render() {
    body.innerHTML = state.messages
      .map(function (message) {
        var citations = (message.citations || [])
          .map(function (citation) {
            return '[' + citation.index + '] ' + escapeHtml(citation.title);
          })
          .join('<br>');
        return (
          '<div class="atr-msg ' + (message.direction === 'inbound' ? 'atr-out' : 'atr-in') + '">' +
          escapeHtml(message.body) +
          (citations ? '<div class="atr-cite">' + citations + '</div>' : '') +
          '</div>'
        );
      })
      .join('');
    if (state.sending) body.insertAdjacentHTML('beforeend', '<div class="atr-note">Sending…</div>');
    body.scrollTop = body.scrollHeight;
  }

  function setOpen(open) {
    state.open = open;
    panel.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
    if (open) {
      if (!state.messages.length) {
        state.messages.push({ direction: 'outbound', body: GREETING });
        render();
      }
      input.focus();
      startPolling();
    } else {
      stopPolling();
    }
  }

  toggle.addEventListener('click', function () {
    setOpen(!state.open);
  });
  closeButton.addEventListener('click', function () {
    setOpen(false);
  });
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && state.open) setOpen(false);
  });

  input.addEventListener('keydown', function (event) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      send();
    }
  });
  sendButton.addEventListener('click', send);

  function send() {
    var text = input.value.trim();
    if (!text || state.sending) return;

    state.messages.push({ direction: 'inbound', body: text });
    input.value = '';
    state.sending = true;
    render();

    request('/api/v1/widget/messages', {
      sessionId: sessionId(),
      body: text,
      conversationId: state.conversationId,
    })
      .then(function (result) {
        state.conversationId = result.conversationId || state.conversationId;
        if (result.reply) state.messages.push({ direction: 'outbound', body: result.reply, citations: result.citations });
        else if (result.queued) state.messages.push({ direction: 'outbound', body: 'Thanks — a member of our team will reply shortly.' });
      })
      .catch(function () {
        state.messages.push({ direction: 'outbound', body: 'Sorry, that message could not be delivered. Please try again.' });
      })
      .finally(function () {
        state.sending = false;
        render();
        startPolling();
      });
  }

  function request(path, payload) {
    return fetch(API + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-widget-key': KEY },
      body: JSON.stringify(payload),
    }).then(function (response) {
      if (!response.ok) throw new Error('request failed');
      return response.json().then(function (json) {
        return json.data || json;
      });
    });
  }

  /** Poll for agent replies while the panel is open, and only then. */
  function startPolling() {
    stopPolling();
    if (!state.conversationId) return;
    state.poll = setInterval(function () {
      fetch(API + '/api/v1/widget/conversations/' + state.conversationId + '/messages', {
        headers: { 'x-widget-key': KEY, 'x-widget-session': sessionId() },
      })
        .then(function (response) {
          return response.ok ? response.json() : null;
        })
        .then(function (json) {
          if (!json) return;
          var messages = (json.data || []).map(function (message) {
            return { direction: message.direction, body: message.body, citations: message.citations };
          });
          if (messages.length !== state.messages.length) {
            state.messages = messages;
            render();
          }
        })
        .catch(function () {
          // Transient failures are expected on a customer's network.
        });
    }, 5000);
  }

  function stopPolling() {
    if (state.poll) clearInterval(state.poll);
    state.poll = null;
  }
})();
