#!/usr/bin/env node
/**
 * End-to-end tests for the parts that are easy to get subtly wrong.
 *
 * Priorities, in order of how much damage a bug would do:
 *   1. The hand-rolled WebSocket framing. A masking or length-prefix mistake
 *      shows up as silent corruption on large payloads (i.e. screenshots) and
 *      nowhere else.
 *   2. The MCP stdio protocol. Getting this wrong means the server simply never
 *      appears in the client, with no useful error.
 *   3. The full round trip: MCP client -> server -> hub -> extension -> back.
 *   4. Output formatting, which is where the token budget is actually spent.
 *
 * Browser behaviour is not covered here — that needs a real Chrome, and the
 * manual checklist in docs/TESTING.md covers it.
 *
 *   node test/run.mjs
 */

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = join(ROOT, 'mcp-server', 'src', 'index.js');

/** Windows absolute paths are not valid ESM specifiers; they must be file:// URLs. */
const importFrom = (...segments) => import(pathToFileURL(join(ROOT, ...segments)).href);

// A port well away from the default, so a running instance cannot interfere.
const PORT = 8899;

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail = '') {
  if (condition) {
    passed++;
    process.stdout.write(`  ok  ${name}\n`);
  } else {
    failed++;
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    process.stdout.write(`  FAIL ${name}${detail ? ` — ${detail}` : ''}\n`);
  }
}

function section(title) {
  process.stdout.write(`\n${title}\n`);
}

// -----------------------------------------------------------------------------
// A stand-in for the Chrome extension
// -----------------------------------------------------------------------------

/**
 * Connects to the hub exactly as the extension does and answers tool calls with
 * canned results. Lets us exercise the whole path without a browser.
 */
async function fakeExtension(port, { onCall } = {}) {
  const { connectWebSocket } = await importFrom('mcp-server', 'src', 'ws.js');
  const conn = await connectWebSocket(`ws://127.0.0.1:${port}/ext`);
  const seen = [];

  conn.on('message', async (raw) => {
    const msg = JSON.parse(raw);
    if (msg.type !== 'call') return;
    seen.push(msg);

    try {
      const result = (await onCall?.(msg)) ?? { text: `handled ${msg.tool}` };
      conn.sendJSON({ type: 'result', id: msg.id, ok: true, result });
    } catch (err) {
      conn.sendJSON({ type: 'result', id: msg.id, ok: false, error: { message: err.message } });
    }
  });

  conn.sendJSON({ type: 'hello', role: 'extension', version: '1.0.0', browser: 'fake' });
  return { conn, seen };
}

// -----------------------------------------------------------------------------
// An MCP client speaking to the server over stdio
// -----------------------------------------------------------------------------

function startServer(port) {
  const proc = spawn(process.execPath, [SERVER, '--port', String(port)], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const pending = new Map();
  let nextId = 1;

  createInterface({ input: proc.stdout }).on('line', (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    const entry = pending.get(msg.id);
    if (!entry) return;
    pending.delete(msg.id);
    clearTimeout(entry.timer);
    entry.resolve(msg);
  });

  const stderr = [];
  proc.stderr.on('data', (chunk) => stderr.push(chunk.toString()));

  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`timed out waiting for ${method}\nstderr: ${stderr.join('')}`));
      }, 20_000);
      pending.set(id, { resolve, timer });
      proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });

  const notify = (method, params) =>
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');

  return { proc, request, notify, stderr };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// -----------------------------------------------------------------------------

async function main() {
  process.stdout.write('OpenBrowser test suite\n');

  // ── MCP protocol ─────────────────────────────────────────────────────────
  section('MCP protocol');
  const server = startServer(PORT);

  const init = await server.request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test', version: '1.0.0' },
  });
  server.notify('notifications/initialized');

  check('initialize responds', !!init.result, JSON.stringify(init).slice(0, 200));
  check('negotiates the requested protocol version', init.result?.protocolVersion === '2025-06-18');
  check('advertises the tools capability', !!init.result?.capabilities?.tools);
  check('sends usage instructions', (init.result?.instructions || '').length > 100);

  const list = await server.request('tools/list');
  const tools = list.result?.tools || [];
  check('lists 14 tools', tools.length === 14, `got ${tools.length}`);
  check('every tool has a description', tools.every((t) => t.description?.length > 20));
  check('every tool has an object schema', tools.every((t) => t.inputSchema?.type === 'object'));
  check(
    'required params are declared in properties',
    tools.every((t) => (t.inputSchema.required || []).every((r) => r in t.inputSchema.properties))
  );

  // Token budget is a real constraint: the whole tool list ships on every
  // request, so regressions here are expensive and easy to miss. 13.5KB is
  // about 3,400 tokens for all 14 tools. Trimming below that starts cutting the
  // guidance that stops models from misusing the tools, which costs more in
  // retried calls than it saves in schema.
  //
  // Raised from 13KB when three pieces of guidance were added, each of which
  // had already cost real failed calls in a live session: `selector` on
  // browser_find (a dozen extra round trips), the no-regex-literals rule on
  // browser_eval (four failed calls), and forward slashes on upload paths. A
  // single retried call costs more than the ~90 tokens they add to every
  // request. Raise this again only for guidance that demonstrably prevents a
  // failure — never to make room for prose.
  const schemaBytes = JSON.stringify(tools).length;
  check('tool schemas stay under 13.5KB', schemaBytes < 13_500, `${schemaBytes} bytes`);

  // Exactly one blank line between paragraphs was unreachable in rich editors
  // until `newline` existed, so the option has to stay advertised — a model
  // cannot ask for a soft break it has never been told about.
  const input = tools.find((t) => t.name === 'browser_input');
  check(
    'browser_input offers a soft newline',
    input?.inputSchema?.properties?.newline?.enum?.includes('soft'),
    JSON.stringify(input?.inputSchema?.properties?.newline)
  );

  const ping = await server.request('ping');
  check('answers ping', !!ping.result);

  const unknown = await server.request('tools/call', { name: 'nope', arguments: {} });
  check('unknown tool reports an in-band error', unknown.result?.isError === true);

  // ── Full round trip ──────────────────────────────────────────────────────
  section('Round trip: MCP client -> server -> hub -> extension');
  const ext = await fakeExtension(PORT, {
    onCall: async (msg) => {
      if (msg.tool === 'browser_snapshot') {
        return { text: 'example.com · tab 1\nbutton "Sign in" [e1]' };
      }
      if (msg.tool === 'browser_screenshot') {
        // Exercise a payload large enough to need 16-bit and 64-bit length
        // prefixes, which is exactly where framing bugs hide.
        return { text: 'shot', images: [{ data: 'A'.repeat(500_000), mimeType: 'image/jpeg' }] };
      }
      if (msg.tool === 'browser_eval') throw new Error('ReferenceError: nope is not defined');
      return { text: `handled ${msg.tool}` };
    },
  });
  await sleep(300); // let the hello land

  const snapshot = await server.request('tools/call', {
    name: 'browser_snapshot',
    arguments: { mode: 'interactive' },
  });
  check('tool call reaches the extension', ext.seen.some((c) => c.tool === 'browser_snapshot'));
  check('arguments are forwarded intact', ext.seen.find((c) => c.tool === 'browser_snapshot')?.args.mode === 'interactive');
  check('result text comes back', snapshot.result?.content?.[0]?.text?.includes('Sign in'));
  check('successful calls are not flagged as errors', snapshot.result?.isError === false);

  // `selector` on find is the escape hatch for pages too big to read whole, so
  // it has to survive the trip to the extension — a silently dropped scope
  // looks exactly like "no matches", which is the failure it exists to fix.
  await server.request('tools/call', {
    name: 'browser_find',
    arguments: { query: 'Send', selector: 'div[role=dialog]' },
  });
  check(
    'find forwards its selector scope',
    ext.seen.find((c) => c.tool === 'browser_find')?.args.selector === 'div[role=dialog]'
  );

  // `tabId` on the batch itself is the shape people write first, and repeating
  // it on every step is easy to get subtly wrong — one step missing it silently
  // drives a different tab.
  const batchTab = await server.request('tools/call', {
    name: 'browser_batch',
    arguments: { tabId: 77, steps: [{ tool: 'browser_navigate', args: { url: 'https://example.com' } }] },
  });
  check('browser_batch accepts a tabId of its own', batchTab.result?.isError === false, batchTab.result?.content?.[0]?.text);

  // A silently-ignored argument is worse than a rejected one. `newTab: true`
  // on browser_navigate — a parameter that does not exist — used to be dropped
  // and the call then drove whatever tab was active, which in a shared browser
  // meant taking over another agent's tab mid-task.
  const bogus = await server.request('tools/call', {
    name: 'browser_navigate',
    arguments: { url: 'https://example.com', newTab: true },
  });
  check('an unknown parameter is rejected', bogus.result?.isError === true);
  check(
    'the rejection names the parameter and the real ones',
    /newTab/.test(bogus.result?.content?.[0]?.text || '') &&
      /waitUntil/.test(bogus.result?.content?.[0]?.text || ''),
    bogus.result?.content?.[0]?.text?.slice(0, 160)
  );
  check('a rejected call never reaches the browser', !ext.seen.some((c) => c.tool === 'browser_navigate'));

  // `group` is read by the router for every tool but declared only on
  // browser_tabs, so a schema-strict check has to allow it explicitly.
  const grouped = await server.request('tools/call', {
    name: 'browser_snapshot',
    arguments: { group: 'research' },
  });
  check('the universal `group` param is still accepted', grouped.result?.isError === false);

  // Batch is where most calls actually live, so its steps need the same check —
  // otherwise the validation has a hole exactly where volume is highest.
  const badStep = await server.request('tools/call', {
    name: 'browser_batch',
    arguments: { steps: [{ tool: 'browser_navigate', args: { url: 'https://example.com', newTab: true } }] },
  });
  check('a bad argument inside a batch step is rejected', badStep.result?.isError === true);

  // Upload paths are checked here, in the only process that has a filesystem.
  // `DOM.setFileInputFiles` accepts anything, so an unchecked stale path used to
  // report "attached 1 file(s)" and then sit at 0% forever — a failure with no
  // error attached to it anywhere.
  const missing = await server.request('tools/call', {
    name: 'browser_upload',
    arguments: { ref: 'e1', paths: [join(ROOT, 'no-such-file.mp4').split('\\').join('/')] },
  });
  check('a missing upload path is rejected', missing.result?.isError === true);
  check(
    'the rejection names the file and says nothing was attached',
    /no such file.*no-such-file\.mp4/s.test(missing.result?.content?.[0]?.text || '') &&
      /nothing was attached/i.test(missing.result?.content?.[0]?.text || ''),
    missing.result?.content?.[0]?.text?.slice(0, 160)
  );
  check('a rejected upload never reaches the browser', !ext.seen.some((c) => c.tool === 'browser_upload'));

  const asDir = await server.request('tools/call', {
    name: 'browser_upload',
    arguments: { ref: 'e1', paths: [ROOT.split('\\').join('/')] },
  });
  check(
    'a directory is rejected as not a file',
    asDir.result?.isError === true && /not a file/.test(asDir.result?.content?.[0]?.text || '')
  );

  const realUpload = await server.request('tools/call', {
    name: 'browser_upload',
    arguments: { ref: 'e1', paths: [SERVER.split('\\').join('/')] },
  });
  check('a path that exists is dispatched', realUpload.result?.isError === false);
  check('the valid upload reached the extension', ext.seen.some((c) => c.tool === 'browser_upload'));

  const shot = await server.request('tools/call', { name: 'browser_screenshot', arguments: {} });
  const imageBlock = shot.result?.content?.find((c) => c.type === 'image');
  check('image content survives the round trip', !!imageBlock);
  check('large payloads are not truncated', imageBlock?.data?.length === 500_000, `got ${imageBlock?.data?.length}`);
  check('image mime type is preserved', imageBlock?.mimeType === 'image/jpeg');

  const thrown = await server.request('tools/call', { name: 'browser_eval', arguments: { code: 'nope' } });
  check('extension errors surface as isError', thrown.result?.isError === true);
  check('the original error message is kept', thrown.result?.content?.[0]?.text?.includes('ReferenceError'));

  // ── Multi-client sharing ─────────────────────────────────────────────────
  section('Two MCP clients sharing one browser');
  const second = startServer(PORT);
  await second.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'second', version: '1' } });
  second.notify('notifications/initialized');

  const viaSecond = await second.request('tools/call', { name: 'browser_tabs', arguments: { action: 'list' } });
  check('second server joins the existing hub', viaSecond.result?.content?.[0]?.text?.includes('handled browser_tabs'));
  check('both servers drove the same extension', ext.seen.some((c) => c.tool === 'browser_tabs'));

  // Session labels are what a human reads in the tab strip, and they are also
  // what scopes a session to its own tabs. Both properties are asserted here:
  // readable, and never shared.
  const firstLabel = ext.seen.find((c) => c.tool === 'browser_snapshot')?.args._session;
  const secondLabel = ext.seen.find((c) => c.tool === 'browser_tabs')?.args._session;
  check('sessions are labelled', !!firstLabel && !!secondLabel, `${firstLabel} / ${secondLabel}`);
  check(
    'two concurrent sessions never share a label',
    firstLabel !== secondLabel,
    `both were ${firstLabel}`
  );
  check(
    'the label is a readable word, not a hex id',
    /^[\w-]+ · [a-z-]+\d*$/.test(secondLabel || ''),
    secondLabel
  );
  // A label must never be just the client name. It briefly was, when the hub
  // supplied no name, and every session of a given client then shared one tab
  // group and drove each other's tabs.
  check(
    'a label always carries a distinguishing suffix',
    / · \S+$/.test(firstLabel || '') && / · \S+$/.test(secondLabel || ''),
    `${firstLabel} / ${secondLabel}`
  );

  // A disconnected client is the only reliable "task over" signal, so the hub
  // has to notice the socket close and tell the browser to tidy up.
  second.proc.kill();
  await sleep(700);
  const ended = ext.seen.filter((c) => c.tool === '__session_end');
  check('a disconnecting client ends its session', ended.length > 0);
  check(
    'the cleanup names the session that left, not the one still running',
    ended.some((c) => c.args._session === secondLabel) && !ended.some((c) => c.args._session === firstLabel),
    JSON.stringify(ended.map((c) => c.args._session))
  );

  // ── Disconnection ────────────────────────────────────────────────────────
  section('Browser disconnected');
  ext.conn.close();
  await sleep(400);

  const orphaned = await server.request('tools/call', { name: 'browser_snapshot', arguments: {} });
  check('reports the browser as missing', orphaned.result?.isError === true);
  check(
    'the error explains how to fix it',
    /extension is installed|No browser connected/i.test(orphaned.result?.content?.[0]?.text || ''),
    orphaned.result?.content?.[0]?.text?.slice(0, 120)
  );

  server.proc.kill();

  // ── Formatting ───────────────────────────────────────────────────────────
  section('Output formatting');
  await testFormatting();

  // ── Macros ───────────────────────────────────────────────────────────────
  section('Macro substitution');
  await testMacros();

  // ── Summary ──────────────────────────────────────────────────────────────
  process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
  if (failures.length) {
    process.stdout.write(`\nFailures:\n${failures.map((f) => `  - ${f}`).join('\n')}\n`);
  }
  process.exit(failed ? 1 : 0);
}

// -----------------------------------------------------------------------------
// Extension modules, with a chrome API stub
// -----------------------------------------------------------------------------

/** Enough of the chrome API for the pure modules to import. */
function stubChrome() {
  const store = {};
  globalThis.chrome = {
    tabs: { onRemoved: { addListener() {} }, onUpdated: { addListener() {} } },
    webNavigation: { onCommitted: { addListener() {} } },
    storage: {
      local: {
        async get(key) {
          return key in store ? { [key]: store[key] } : {};
        },
        async set(obj) {
          Object.assign(store, obj);
        },
      },
      onChanged: { addListener() {} },
    },
    runtime: { getManifest: () => ({ version: '1.0.0' }) },
  };
}

async function testFormatting() {
  stubChrome();
  const fmt = await importFrom('extension', 'background', 'format.js');

  const nodes = [
    { role: 'heading', name: 'Sign in', depth: 0, state: ['h1'], children: [] },
    {
      role: 'form', name: '', depth: 0, children: [
        { role: 'textbox', name: 'Email', ref: 'e1', depth: 1, state: ['required'], children: [] },
        { role: 'password', name: 'Password', ref: 'e2', depth: 1, children: [] },
        { role: 'checkbox', name: 'Remember me', ref: 'e3', depth: 1, state: ['unchecked'], children: [] },
        { role: 'button', name: 'Sign in', ref: 'e4', depth: 1, children: [] },
      ],
    },
    { role: 'generic', name: '', depth: 0, children: [{ role: 'link', name: 'Help', ref: 'e5', href: '/help', depth: 1, children: [] }] },
  ];

  const rendered = fmt.renderTree(nodes);
  check('renders role, name, and ref', rendered.text.includes('textbox "Email" [e1] required'));
  check('counts refs', rendered.refCount === 5, `got ${rendered.refCount}`);
  check('includes link targets', rendered.text.includes('link "Help" [e5] /help'));
  check('drops unnamed generic wrappers', !rendered.text.includes('generic'));
  check('nests children under their parent', /form\n {2}textbox/.test(rendered.text));

  // The whole point of this format: a real login page should cost very little.
  check('a login form renders under 250 chars', rendered.text.length < 250, `${rendered.text.length} chars`);

  check('respects the character budget', fmt.renderTree(nodes, { maxChars: 40 }).truncated === true);

  // Diffing.
  fmt.storeSnapshot(1, 'a\nb\nc');
  const same = fmt.diffSnapshot(1, 'a\nb\nc');
  check('identical snapshots report no change', same.unchanged === true);

  fmt.storeSnapshot(1, 'a\nb\nc');
  const diff = fmt.diffSnapshot(1, 'a\nc\nd');
  check('diff reports additions', diff.text.includes('+ d'));
  check('diff reports removals', diff.text.includes('- b'));
  check('diff omits unchanged lines', !/^[+-] a$/m.test(diff.text));

  // Clicking anything focusable moves focus, and the tree reports that as a
  // change — so a click that achieved nothing still returns a two-line diff and
  // reads as if it worked. Getting this wrong in either direction is costly:
  // too loose and real changes are dismissed as noise, too strict and the
  // settling hint never fires on a button, which is exactly where it is needed.
  check('a focus-only delta is recognised as nothing happening',
    fmt.isFocusOnly('changes:\n+ button "Dead" [e2] focused\n- button "Dead" [e2]'));
  check('focus moving between two controls is still nothing',
    fmt.isFocusOnly('changes:\n+ button "A" [e2]\n+ button "B" [e3] focused\n- button "A" [e2] focused\n- button "B" [e3]'));
  check('a delta with new content is a real change',
    !fmt.isFocusOnly('changes:\n+ heading "Results" h2\n+ button "A" [e2] focused\n- button "A" [e2]'));
  check('a removal is a real change',
    !fmt.isFocusOnly('changes:\n- dialog "Cookie banner"'));
  check('no delta at all is not a focus-only delta', !fmt.isFocusOnly(undefined));
  check('a substantial-rewrite message is not a focus-only delta',
    !fmt.isFocusOnly('page changed substantially — snapshot for detail'));

  // URL shortening.
  check('strips the www prefix', fmt.shortUrl('https://www.example.com/a') === 'example.com/a');
  check('drops a bare root path', fmt.shortUrl('https://example.com/') === 'example.com');
  check('truncates long query strings', fmt.shortUrl(`https://e.com/p?${'x=1&'.repeat(40)}`).length < 120);

  // Page header.
  const header = fmt.pageHeader(
    { url: 'https://example.com/login', title: 'Sign in', viewport: { w: 1280, h: 800 }, scroll: { y: 0, maxY: 0 } },
    42
  );
  check('header carries url, title, and tab', header.includes('example.com/login') && header.includes('tab 42'));
  check('header omits scroll when at the top', !header.includes('scrolled'));

  const scrolled = fmt.pageHeader(
    { url: 'https://e.com', viewport: { w: 800, h: 600 }, scroll: { y: 500, maxY: 1000 } },
    1
  );
  check('header reports scroll position when scrolled', scrolled.includes('scrolled 50%'));
}

async function testMacros() {
  stubChrome();
  const macros = await importFrom('extension', 'background', 'macros.js');

  const steps = [
    { tool: 'browser_navigate', args: { url: '{{site}}/login' } },
    { tool: 'browser_input', args: { fields: [{ ref: 'e1', value: '{{user}}' }], delay: '{{delay}}' } },
  ];

  const filled = macros.substitute(steps, { site: 'https://example.com', user: 'ada', delay: 50 });
  check('interpolates inside a longer string', filled[0].args.url === 'https://example.com/login');
  check('substitutes nested values', filled[1].args.fields[0].value === 'ada');
  check('a lone placeholder keeps its type', filled[1].args.delay === 50);

  let threw = null;
  try {
    macros.substitute(steps, { site: 'x' });
  } catch (err) {
    threw = err.message;
  }
  check('missing vars raise a named error', !!threw && threw.includes('user'), threw);

  // A value containing braces must not be able to corrupt the structure.
  const injected = macros.substitute([{ tool: 't', args: { v: '{{x}}' } }], { x: '{{y}} "quoted"' });
  check('substituted values are not re-expanded', injected[0].args.v === '{{y}} "quoted"');

  // Storage round trip.
  await macros.save('login', { description: 'Log in', steps });
  const loaded = await macros.get('login');
  check('macros persist and reload', loaded?.steps.length === 2 && loaded.description === 'Log in');
  check('macros are listed', (await macros.list()).some((m) => m.name === 'login'));
  await macros.remove('login');
  check('macros can be deleted', (await macros.get('login')) === null);
}

main().catch((err) => {
  process.stderr.write(`\ntest harness crashed: ${err.stack}\n`);
  process.exit(1);
});
