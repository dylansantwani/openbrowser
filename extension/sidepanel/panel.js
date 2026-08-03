/**
 * Side panel controller.
 *
 * The panel is a thin client over the same `dispatch` the MCP server calls, so
 * there is no separate code path to keep in sync — what you see here is exactly
 * what an agent gets. That makes it the fastest way to debug a flow: try the
 * tool by hand, see the real output, then hand it to the model.
 */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

/** Mirrors mcp-server/src/tools.js — kept short since the panel shows one at a time. */
const TOOLS = {
  browser_tabs: { hint: 'List, open, close, select, or reload tabs.', example: { action: 'list' } },
  browser_navigate: { hint: 'Go to a URL, or back/forward/reload.', example: { url: 'example.com' } },
  browser_snapshot: { hint: 'Read the page as an accessibility tree with refs.', example: { mode: 'interactive' } },
  browser_find: { hint: 'Find elements by description.', example: { query: 'sign in button' } },
  browser_act: { hint: 'Click, hover, drag, select — with trusted input events.', example: { action: 'click', ref: 'e1' } },
  browser_input: { hint: 'Type text, fill many fields, or press keys.', example: { fields: [{ ref: 'e1', value: 'hello' }] } },
  browser_screenshot: { hint: 'Capture the page as an image.', example: { mode: 'viewport' } },
  browser_wait: { hint: 'Block until a condition holds.', example: { for: 'text', value: 'Welcome' } },
  browser_eval: { hint: 'Run JavaScript in the page.', example: { code: 'document.title' } },
  browser_inspect: { hint: 'Console, network, cookies, storage, downloads.', example: { what: 'console' } },
  browser_batch: { hint: 'Run several calls as one request.', example: { steps: [{ tool: 'browser_snapshot', args: {} }] } },
  browser_upload: { hint: 'Attach local files to a file input.', example: { ref: 'e1', paths: ['C:\\path\\to\\file.png'] } },
  browser_window: { hint: 'Resize, emulate a device, theme, zoom, throttle.', example: { preset: 'mobile' } },
  browser_macro: { hint: 'Save and replay step sequences.', example: { action: 'list' } },
};

let state = { bridge: { status: 'disconnected' }, settings: {}, activity: [], macros: [] };

// -----------------------------------------------------------------------------
// Messaging
// -----------------------------------------------------------------------------

function call(type, payload = {}) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type, ...payload }, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!response?.ok) reject(new Error(response?.error || 'request failed'));
      else resolve(response.result);
    });
  });
}

const runTool = (tool, args = {}) => call('run_tool', { tool, args });

// -----------------------------------------------------------------------------
// Rendering
// -----------------------------------------------------------------------------

function renderStatus() {
  const { status, port, stats } = state.bridge;
  const button = $('#connection');

  button.className = `status status--${status}`;
  $('#status-text').textContent =
    status === 'connected' ? `Connected · ${port}` :
    status === 'connecting' ? 'Connecting…' : 'Disconnected';

  // Troubleshooting steps belong to a link that is actually down, not one that
  // is mid-reconnect. Reconnects are routine — MV3 recycles the worker every
  // idle cycle — and showing "here is how to fix your broken setup" each time
  // trains people to distrust a status that was telling the truth.
  $('#connection-help').hidden = status !== 'disconnected';
  $$('[data-port]').forEach((el) => (el.textContent = port ?? state.settings.port ?? 8848));

  $('#stat-calls').textContent = stats?.calls ?? 0;
  $('#stat-errors').textContent = stats?.errors ?? 0;
}

async function renderTabs() {
  const tabs = await chrome.tabs.query({});
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const list = $('#tab-list');

  if (!tabs.length) {
    list.innerHTML = '<li class="empty">No tabs open.</li>';
    return;
  }

  list.replaceChildren(
    ...tabs.map((tab) => {
      const li = document.createElement('li');
      li.className = `tab-item${tab.id === active?.id ? ' is-active' : ''}`;
      li.title = tab.url || '';

      const body = document.createElement('div');
      body.className = 'tab-item-body';

      const title = document.createElement('div');
      title.className = 'tab-item-title';
      title.textContent = tab.title || '(untitled)';

      const url = document.createElement('div');
      url.className = 'tab-item-url';
      url.textContent = shortUrl(tab.url || tab.pendingUrl || '');

      body.append(title, url);

      const id = document.createElement('span');
      id.className = 'tab-item-id';
      id.textContent = tab.id;

      const close = document.createElement('button');
      close.className = 'tab-close';
      close.type = 'button';
      close.textContent = '✕';
      close.title = 'Close tab';
      close.addEventListener('click', async (event) => {
        event.stopPropagation();
        await chrome.tabs.remove(tab.id);
        renderTabs();
      });

      li.append(id, body, close);
      li.addEventListener('click', async () => {
        await chrome.tabs.update(tab.id, { active: true });
        await chrome.windows.update(tab.windowId, { focused: true });
        renderTabs();
      });

      return li;
    })
  );
}

function renderActivity() {
  const list = $('#activity-list');
  const entries = state.activity.slice().reverse();

  if (!entries.length) {
    list.innerHTML = '<li class="empty">Nothing yet. Tool calls will appear here as they run.</li>';
    return;
  }

  list.replaceChildren(
    ...entries.map((entry) => {
      const li = document.createElement('li');
      li.className = `activity-item${entry.ok ? '' : ' is-error'}`;

      const mark = document.createElement('span');
      mark.className = 'activity-mark';

      const body = document.createElement('div');
      body.className = 'activity-item-body';

      const tool = document.createElement('div');
      tool.className = 'activity-tool';
      tool.textContent = entry.tool;

      const detail = document.createElement('div');
      detail.className = 'activity-detail';
      detail.textContent = entry.ok ? summarizeArgs(entry.args) : entry.error;
      detail.title = detail.textContent;

      body.append(tool, detail);

      const ms = document.createElement('span');
      ms.className = 'activity-ms';
      ms.textContent = `${entry.ms}ms`;

      li.append(mark, body, ms);
      return li;
    })
  );
}

function renderMacros() {
  const list = $('#macro-list');

  if (!state.macros.length) {
    list.innerHTML = '<li class="empty">No macros saved yet.</li>';
    return;
  }

  list.replaceChildren(
    ...state.macros.map((macro) => {
      const li = document.createElement('li');
      li.className = 'macro-item';

      const body = document.createElement('div');
      body.className = 'macro-item-body';

      const name = document.createElement('div');
      name.className = 'macro-name';
      name.textContent = macro.name;

      const desc = document.createElement('div');
      desc.className = 'macro-desc';
      desc.textContent = macro.description || `${macro.steps?.length ?? 0} steps`;

      body.append(name, desc);

      const run = document.createElement('button');
      run.className = 'btn btn--sm';
      run.type = 'button';
      run.textContent = 'Run';
      run.addEventListener('click', () =>
        withOutput(`Macro: ${macro.name}`, () => runTool('browser_macro', { action: 'run', name: macro.name }))
      );

      const del = document.createElement('button');
      del.className = 'btn btn--ghost btn--sm';
      del.type = 'button';
      del.textContent = 'Delete';
      del.addEventListener('click', async () => {
        state.macros = await call('delete_macro', { name: macro.name });
        renderMacros();
      });

      li.append(body, run, del);
      return li;
    })
  );
}

function renderToolPicker() {
  const select = $('#tool-select');
  select.replaceChildren(
    ...Object.keys(TOOLS).map((name) => {
      const option = document.createElement('option');
      option.value = name;
      option.textContent = name;
      return option;
    })
  );
  syncToolForm();
}

function syncToolForm() {
  const name = $('#tool-select').value;
  const tool = TOOLS[name];
  $('#tool-desc').textContent = tool?.hint || '';
  $('#tool-args').value = JSON.stringify(tool?.example ?? {}, null, 2);
}

// -----------------------------------------------------------------------------
// Output
// -----------------------------------------------------------------------------

/** Run something, show a spinner-ish state, then render its result or error. */
async function withOutput(title, fn) {
  const panel = $('#output-panel');
  panel.hidden = false;
  panel.classList.remove('is-error');
  $('#output-title').textContent = title;
  $('#output-meta').textContent = '';
  $('#output-image').hidden = true;
  $('#output').textContent = 'Running…';

  const started = performance.now();
  try {
    const result = await fn();
    const text = typeof result === 'string' ? result : result?.text ?? '';
    $('#output').textContent = text || '(no output)';
    $('#output-meta').textContent = `${Math.round(performance.now() - started)}ms · ${text.length} chars`;

    const image = result?.images?.[0];
    if (image) {
      const img = $('#output-image');
      img.src = `data:${image.mimeType};base64,${image.data}`;
      img.hidden = false;
    }
  } catch (err) {
    panel.classList.add('is-error');
    $('#output').textContent = err.message;
    $('#output-meta').textContent = 'failed';
  }

  panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// -----------------------------------------------------------------------------
// Wiring
// -----------------------------------------------------------------------------

function wire() {
  // View switching.
  $$('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      $$('.tab').forEach((t) => {
        const on = t === tab;
        t.classList.toggle('is-active', on);
        t.setAttribute('aria-selected', String(on));
      });
      $$('.view').forEach((v) => v.classList.toggle('is-active', v.id === `view-${tab.dataset.view}`));
    });
  });

  $('#connection').addEventListener('click', async () => {
    const connected = state.bridge.status === 'connected';
    state.bridge = await call(connected ? 'disconnect' : 'connect');
    renderStatus();
  });

  $('#refresh-tabs').addEventListener('click', renderTabs);

  $('#open-tab-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const input = $('#new-tab-url');
    const url = input.value.trim();
    if (!url) return;
    await withOutput('Open tab', () => runTool('browser_tabs', { action: 'new', url }));
    input.value = '';
    renderTabs();
  });

  $('#find-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const query = $('#find-query').value.trim();
    if (query) withOutput(`Find: ${query}`, () => runTool('browser_find', { query }));
  });

  const QUICK = {
    snapshot: ['Snapshot', 'browser_snapshot', { mode: 'interactive' }],
    screenshot: ['Screenshot', 'browser_screenshot', { mode: 'viewport' }],
    page_info: ['Page info', 'browser_inspect', { what: 'page_info' }],
    console: ['Console', 'browser_inspect', { what: 'console' }],
    network: ['Network', 'browser_inspect', { what: 'network' }],
    frames: ['Frames', 'browser_inspect', { what: 'frames' }],
  };

  $$('[data-quick]').forEach((button) => {
    button.addEventListener('click', () => {
      const [title, tool, args] = QUICK[button.dataset.quick];
      withOutput(title, () => runTool(tool, args));
    });
  });

  $('#tool-select').addEventListener('change', syncToolForm);

  $('#run-tool').addEventListener('click', () => {
    const tool = $('#tool-select').value;
    let args;
    try {
      args = JSON.parse($('#tool-args').value || '{}');
    } catch (err) {
      withOutput(tool, () => Promise.reject(new Error(`Arguments are not valid JSON: ${err.message}`)));
      return;
    }
    withOutput(tool, () => runTool(tool, args));
  });

  $('#insert-tab-id').addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab) return;
    const field = $('#tool-args');
    try {
      const args = JSON.parse(field.value || '{}');
      args.tabId = tab.id;
      field.value = JSON.stringify(args, null, 2);
    } catch {
      field.value = JSON.stringify({ tabId: tab.id }, null, 2);
    }
  });

  $('#copy-output').addEventListener('click', async () => {
    await navigator.clipboard.writeText($('#output').textContent);
    const button = $('#copy-output');
    button.textContent = 'Copied';
    setTimeout(() => (button.textContent = 'Copy'), 1200);
  });

  $('#close-output').addEventListener('click', () => ($('#output-panel').hidden = true));

  $('#clear-activity').addEventListener('click', () => {
    state.activity = [];
    renderActivity();
  });

  $('#detach-all').addEventListener('click', async () => {
    await call('detach_all');
    $('#stat-attached').textContent = '0 tabs';
  });

  $('#open-options').addEventListener('click', () => chrome.runtime.openOptionsPage());

  // Live updates pushed from the service worker.
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'bridge_status') {
      state.bridge = msg.status;
      renderStatus();
    } else if (msg?.type === 'activity') {
      state.activity.push(msg.entry);
      if (state.activity.length > 100) state.activity.shift();
      renderActivity();
    }
  });

  chrome.tabs.onCreated.addListener(renderTabs);
  chrome.tabs.onRemoved.addListener(renderTabs);
  chrome.tabs.onUpdated.addListener((_id, info) => {
    if (info.status === 'complete' || info.title) renderTabs();
  });
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function shortUrl(url) {
  try {
    const u = new URL(url);
    return `${u.hostname.replace(/^www\./, '')}${u.pathname === '/' ? '' : u.pathname}`;
  } catch {
    return url;
  }
}

/** One-line gist of a call's arguments for the activity feed. */
function summarizeArgs(args = {}) {
  const interesting = ['action', 'url', 'query', 'mode', 'what', 'for', 'ref', 'name', 'preset'];
  const parts = interesting
    .filter((key) => args[key] != null)
    .map((key) => `${key}=${String(args[key]).slice(0, 40)}`);
  return parts.join(' ') || '—';
}

// -----------------------------------------------------------------------------
// Init
// -----------------------------------------------------------------------------

(async function init() {
  wire();
  renderToolPicker();
  $('#version').textContent = `v${chrome.runtime.getManifest().version}`;

  try {
    state = { ...state, ...(await call('get_status')) };
  } catch {
    // The service worker may have been asleep; the retry below usually lands.
    setTimeout(() => call('get_status').then((s) => {
      state = { ...state, ...s };
      renderStatus();
      renderMacros();
    }).catch(() => {}), 400);
  }

  renderStatus();
  renderActivity();
  renderMacros();
  renderTabs();

  $('#stat-attached').textContent = `${state.attachedTabs?.length ?? 0} tabs`;
})();
