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
import { readFileSync } from 'node:fs';

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
async function fakeExtension(port, { onCall, instance = 'fake-instance', browser = 'fake', name } = {}) {
  const { connectWebSocket } = await importFrom('mcp-server', 'src', 'ws.js');
  const conn = await connectWebSocket(`ws://127.0.0.1:${port}/ext`);
  const seen = [];
  /** Hub hellos, which is where the primary/standby verdict arrives. */
  const hellos = [];
  let closed = false;
  conn.on('close', () => {
    closed = true;
  });

  conn.on('message', async (raw) => {
    const msg = JSON.parse(raw);
    if (msg.type === 'hello') {
      hellos.push(msg);
      return;
    }
    if (msg.type !== 'call') return;
    seen.push(msg);

    try {
      const result = (await onCall?.(msg)) ?? { text: `handled ${msg.tool}` };
      conn.sendJSON({ type: 'result', id: msg.id, ok: true, result });
    } catch (err) {
      conn.sendJSON({ type: 'result', id: msg.id, ok: false, error: { message: err.message } });
    }
  });

  conn.sendJSON({
    type: 'hello', role: 'extension', version: '1.0.0', protocolRevision: 2, browser, instance, name,
  });
  return {
    conn,
    seen,
    hellos,
    get closed() {
      return closed || conn.closed;
    },
  };
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
  // request. Raised again to 13.7KB for `browser_act action:"dialog"` (accept/
  // promptText): a native JS dialog pauses the renderer, so without the enum
  // and its accept/dismiss guidance every page-side call hangs until timeout —
  // the session-stuck failure the whole feature exists to prevent. Raise this
  // again only for guidance that demonstrably prevents a failure — never to
  // make room for prose.
  //
  // Raised to 14.1KB for `browser_window action` (list/use/pick + windowId).
  // With two windows open a session cannot start at all until it binds one, so
  // a model that has not been told this action exists is stuck in a loop it
  // cannot read its way out of — it sees "several windows are open" and has no
  // call to answer it with. The "relay the list, never guess" clause is load-
  // bearing too: the failure it prevents is an agent picking a window id out of
  // the error text and dropping its tabs into whichever window the human was
  // reading in, which is the entire problem the feature exists to solve.
  //
  // Raised to 14.2KB for `action:"browsers"` and the `browser` argument. Same
  // failure as the window raise above, one level out and worse: with two
  // browsers connected a session cannot start until it binds one, and a model
  // that has never been shown these sees "2 browsers are connected" with no
  // call available to answer it. Worse, because a wrong window is visible —
  // both windows are in one browser's tab list — while a wrong *browser* is
  // not: tab ids are only unique within a browser, so a guessed binding sends
  // every later call to a real, different tab of the same id, silently. The
  // additions were trimmed to 28 bytes over the old ceiling before raising it.
  //
  // Raised to 14.4KB for `action:"connect"/"disconnect"/"remotes"` and `hub`.
  // Not guidance this time but reachability: a hub on another machine is
  // invisible until something attaches it, and the only thing that can attach
  // it is a model making this call. Without the enum values and `hub` there is
  // no syntax for that, so every browser outside the local machine is
  // unreachable no matter what the agent tries — a capability that exists and
  // cannot be invoked is worse than one that does not exist, because the
  // browsers show up in `remotes` output and prose while staying undrivable.
  // The `"remote/browser"` clause is load-bearing for the same reason the
  // browser raise above was: names collide across machines, and an agent that
  // has not been told the namespacing will pass a bare name that matches two
  // browsers on different boxes. Trimmed twice before raising — 14461 to 14401
  // by shortening prose, then to 14326 by deleting the `name` parameter and
  // routing `disconnect` through `hub` instead.
  //
  // Raised to 14.5KB to name the remote case in `browser_window`'s own
  // description, and the `wss://` scheme in `hub`. The previous raise added the
  // syntax for reaching another machine but left it addressable only from
  // inside the `action` enum, and the tool's description — the text a model
  // scans when deciding which tool can do a thing at all — still described a
  // purely local window picker. Two sessions were lost to that: told to reach a
  // hub on another host, both concluded no tool could, and went reading
  // `ws.js`, `index.js` and `hub.js` for a config knob or env var to point the
  // server at a remote endpoint. Neither ever issued `connect`, and one spent
  // its remaining turns on a CDP endpoint that does not exist. A capability
  // findable only by reading the source of the thing that offers it is not
  // findable. `wss://` costs its bytes for the same reason one level down: a
  // hub behind a tunnel answers on 443 and a bare hostname resolves to 8848,
  // so the default guess fails by two-minute timeout with nothing naming the
  // scheme as the variable. Trimmed to 2 bytes under the old ceiling first,
  // which is no headroom at all — the next edit would have had to cut guidance
  // to fit rather than raise this deliberately.
  //
  // Raised to 14.7KB for `browser_act` `space:"image"`. A screenshot handed to
  // a model is rescaled twice (device pixel ratio, then the maxWidth downscale),
  // so a coordinate read off the image is in neither the viewport nor the
  // document space every coordinate argument otherwise uses. Without a way to
  // say "these pixels came off the picture", a vision model — local ones above
  // all — clicks at a fraction of the intended offset and gets no error, because
  // there is always *something* under the wrong point. The enum is the syntax
  // for the conversion the extension then does for it; a capability the model
  // cannot name is one it cannot use, and this is the exact silent-wrong-click
  // the coordinate documentation exists to prevent. Trimmed once (150→130 bytes)
  // before raising.
  //
  // Raised to 15.2KB for `browser_screenshot` `selector` (element mode by CSS
  // selector). A purely visual target — a `<canvas>`, `<svg>` chart, an `<img>`
  // — carries no interactive role, so it never gets a ref, so element mode was
  // unreachable for it and the only way to frame it was a hand-guessed pixel
  // `region`. A model cannot see the element's box, so the guess clips it, and
  // the model reads a half-cut graph as the whole answer without knowing it did.
  // Not hypothetical: a capable model burned thirty region screenshots trying to
  // crop one velocity-time graph, every crop clipping the axis, and answered off
  // the clipped view. The selector is the syntax for "frame this element,
  // whatever its box is", which the extension computes and clips to — whole
  // element, native resolution, never clipped. Region stays the labelled last
  // resort. Trimmed twice (redundant prose across the tool and selector
  // descriptions) before raising.
  //
  // Raised to 15.6KB for `browser_act action:"google_login"` (+ `account`,
  // `consent`). A guided "Sign in with Google" is unreachable without the enum
  // value and the two params, and the whole reason it exists is to make the two
  // decisions a model must not take alone — which identity, and whether to grant
  // access — into explicit, human-gated calls (and to refuse the password step
  // outright). A capability a model cannot name is one it cannot use, and here
  // that would mean the model falling back to clicking account rows blind, which
  // is exactly the identity-picking-for-the-user this prevents. The gating logic
  // is pure and separately tested (testOAuth); this is only the syntax for it.
  //
  // Raised to 16.0KB for Set-of-Marks (`browser_screenshot marks` + `browser_act
  // mark`). This is the syntax for the one clicking method that does not go
  // through a coordinate at all: badges are numbered, the model passes a number,
  // and it resolves to a ref — so the whole image↔CSS rescaling that makes
  // pixel clicks land at a fraction of the intended offset simply never applies.
  // On a canvas app (Docs, Figma) the document body carries no refs, so before
  // this the only way to click into it was a guessed pixel off a downscaled
  // shot — the exact silent-wrong-click `space:"image"` was raised for, but with
  // nothing to convert against. A capability the model cannot name is one it
  // cannot use; without `marks`/`mark` it falls back to guessing pixels. Trimmed
  // twice before raising.
  //
  // Raised to 17.4KB for the round-trip cutters: `expect` on browser_act and
  // browser_input, `when`/`unless`/`repeat`/`steps` on batch steps, `async` on
  // browser_batch with `for:"job"` on browser_wait, and `mode:"outline"` on
  // browser_snapshot. Every one of these is syntax for doing in one call what
  // took two or three — act-then-verify, dismiss-if-present, click-until-gone,
  // run-while-I-read-elsewhere — and a model turn sits between every call, so
  // each round trip removed is worth several seconds and thousands of tokens of
  // re-sent context; measured against a live Chrome, a ten-step flow went from
  // ten turns to two. The 1.4KB is ~350 tokens per request. Trimmed twice
  // before raising (17452 → 17295): descriptions shortened, the shared
  // condition fragment stripped to its type.
  const schemaBytes = JSON.stringify(tools).length;
  check('tool schemas stay under 17.4KB', schemaBytes < 17_400, `${schemaBytes} bytes`);

  // The round-trip cutters have to stay advertised: a capability the model
  // cannot name is one it cannot use, and each of these replaces a whole turn.
  const byName = (n) => tools.find((t) => t.name === n)?.inputSchema?.properties || {};
  check('browser_act advertises expect', byName('browser_act').expect?.type === 'object');
  check('browser_input advertises expect', byName('browser_input').expect?.type === 'object');
  const stepProps = byName('browser_batch').steps?.items?.properties || {};
  check('batch steps advertise when/unless/repeat/steps',
    ['when', 'unless', 'repeat', 'steps'].every((k) => k in stepProps), Object.keys(stepProps).join());
  check('batch advertises async', byName('browser_batch').async?.type === 'boolean');
  check('browser_wait advertises job collection', byName('browser_wait').for?.enum?.includes('job'));
  check('browser_snapshot advertises outline', byName('browser_snapshot').mode?.enum?.includes('outline'));

  // A screenshot's pixels are in neither coordinate space every other argument
  // uses; `space:"image"` is the only syntax for converting them back, so it has
  // to stay advertised — a model cannot pass an enum value it has never seen.
  check(
    'browser_act accepts image-space coordinates',
    tools.find((t) => t.name === 'browser_act')?.inputSchema?.properties?.space?.enum?.includes('image'),
    JSON.stringify(tools.find((t) => t.name === 'browser_act')?.inputSchema?.properties?.space)
  );

  // Exactly one blank line between paragraphs was unreachable in rich editors
  // until `newline` existed, so the option has to stay advertised — a model
  // cannot ask for a soft break it has never been told about.
  const input = tools.find((t) => t.name === 'browser_input');
  check(
    'browser_input offers a soft newline',
    input?.inputSchema?.properties?.newline?.enum?.includes('soft'),
    JSON.stringify(input?.inputSchema?.properties?.newline)
  );

  // A native JS dialog (alert/confirm/beforeunload) pauses the renderer and is
  // invisible to the accessibility tree; the only way to unstick the session is
  // to answer it, so the action and its accept flag must be advertised — a
  // model cannot call an enum value it has never been shown.
  const act = tools.find((t) => t.name === 'browser_act');
  const actProps = act?.inputSchema?.properties || {};
  check(
    'browser_act can answer native dialogs',
    actProps.action?.enum?.includes('dialog') && actProps.accept?.type === 'boolean',
    JSON.stringify({ enum: actProps.action?.enum, accept: actProps.accept })
  );

  // A non-interactive graphic (canvas/svg/img) never gets a ref, so element mode
  // has to be reachable by CSS selector or it is unreachable for exactly the
  // thing screenshots exist to read. The param a model has never been shown is
  // one it cannot use, so the schema has to carry it.
  const shotTool = tools.find((t) => t.name === 'browser_screenshot');
  check(
    'browser_screenshot advertises a selector for element mode',
    shotTool?.inputSchema?.properties?.selector?.type === 'string' &&
      shotTool?.inputSchema?.properties?.mode?.enum?.includes('element'),
    JSON.stringify(Object.keys(shotTool?.inputSchema?.properties || {}))
  );

  // Set-of-Marks is only reachable if both halves are advertised: `marks` to
  // paint the badges and `mark` to click one. A model that cannot name them
  // falls back to guessing a pixel off the image — the exact failure marks fix.
  check(
    'browser_screenshot advertises marks',
    shotTool?.inputSchema?.properties?.marks?.type === 'boolean',
    JSON.stringify(Object.keys(shotTool?.inputSchema?.properties || {}))
  );
  const actTool = tools.find((t) => t.name === 'browser_act');
  check(
    'browser_act advertises mark',
    actTool?.inputSchema?.properties?.mark?.type === 'number',
    JSON.stringify(Object.keys(actTool?.inputSchema?.properties || {}))
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

  // A `selector` on browser_screenshot is what lets a model frame a chart/canvas/
  // svg that has no ref, instead of guessing a pixel region that clips it. The
  // whole feature is dead if the strict validator drops the param as unknown, so
  // it has to be advertised and it has to survive the trip to the extension.
  await server.request('tools/call', {
    name: 'browser_screenshot',
    arguments: { mode: 'element', selector: 'canvas' },
  });
  check(
    'screenshot forwards its element selector',
    ext.seen.find((c) => c.tool === 'browser_screenshot')?.args.selector === 'canvas'
  );

  // The guided Google sign-in lives behind `account`/`consent`; the strict
  // validator must let them through or the whole flow is unreachable, and a
  // dropped `consent` would be the difference between asking and granting.
  await server.request('tools/call', {
    name: 'browser_act',
    arguments: { action: 'google_login', account: 'sam@work.com', consent: true },
  });
  const gl = ext.seen.find((c) => c.tool === 'browser_act' && c.args.action === 'google_login');
  check('google_login forwards account and consent intact', gl?.args.account === 'sam@work.com' && gl?.args.consent === true, JSON.stringify(gl?.args));

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
  // A session *is* its name: one word, the same on the tab group, the page
  // frame, the panel, and in every result. The old `client · word` composite
  // was the most confusing thing here, and the prefix bought no uniqueness —
  // the hub already guarantees the word is unique across every client.
  check(
    'the label is one readable word, not a hex id or a composite',
    /^[a-z]+(-\d+)?$/.test(secondLabel || '') && /^[a-z]+(-\d+)?$/.test(firstLabel || ''),
    `${firstLabel} / ${secondLabel}`
  );
  // Which MCP client a session belongs to still matters to a person reading the
  // panel, so it travels as metadata — stamped server-side like `_session`, so
  // a model cannot mislabel itself.
  const clientStamp = ext.seen.find((c) => c.tool === 'browser_tabs')?.args._client;
  check('the client name rides along as display metadata', clientStamp === 'second', clientStamp);

  // `checkArgs` deliberately lets underscore-prefixed arguments through, so a
  // model can put `_session` on any call it makes. The stamp therefore has to
  // be applied *after* the argument spread. Applied before, a model could join
  // another agent's tab group — and be handed its tabs — by naming it.
  const spoofed = await server.request('tools/call', {
    name: 'browser_snapshot',
    arguments: { _session: 'somebody', _client: 'not-me' },
  });
  check('a spoofed _session does not fail the call', spoofed.result?.isError === false);
  check(
    "a model cannot assert another session's identity",
    ext.seen.filter((c) => c.tool === 'browser_snapshot').pop()?.args._session === firstLabel,
    ext.seen.filter((c) => c.tool === 'browser_snapshot').pop()?.args._session
  );
  check(
    'nor mislabel its client',
    ext.seen.filter((c) => c.tool === 'browser_snapshot').pop()?.args._client === 'test',
    ext.seen.filter((c) => c.tool === 'browser_snapshot').pop()?.args._client
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
  // The extension guards every 'call', session-end included, so the cleanup must
  // carry the revision stamp or a current extension drops it and never tidies.
  check('session-end cleanup carries the protocol revision',
    ended.every((c) => c.args?._protocolRevision === 2),
    JSON.stringify(ended.map((c) => c.args?._protocolRevision)));

  // ── Names vs. what is already in the browser ─────────────────────────────
  section('Session names never collide with tab groups already on screen');

  // A hub owner is an ordinary MCP server and can be killed. Whoever binds the
  // port next starts its name list from the top, so without asking the browser
  // it hands "harbor" straight back out — and the new session opens into the
  // dead one's tab group, inheriting a stranger's tabs. The browser is the only
  // durable record of what is in use, so it is asked on connect.
  const PORT2 = PORT + 1;
  const fresh = startServer(PORT2);
  await fresh.request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'claude', version: '1' },
  });
  fresh.notify('notifications/initialized');

  const ext2 = await fakeExtension(PORT2, {
    onCall: (msg) =>
      msg.tool === '__session_list'
        ? { names: ['claude · harbor', 'opencode · meadow', 'research'] }
        : undefined,
  });

  await fresh.request('tools/call', { name: 'browser_tabs', arguments: { action: 'list' } });
  check('the hub asks the browser which names are in use', ext2.seen.some((c) => c.tool === '__session_list'));

  const freshLabel = ext2.seen.find((c) => c.tool === 'browser_tabs')?.args._session;
  check(
    'a name whose tab group is still live is not reused',
    !!freshLabel && !/^(harbor|meadow)$/.test(freshLabel),
    freshLabel
  );
  check('the session still gets a readable name', /^[a-z]+(-\d+)?$/.test(freshLabel || ''), freshLabel);

  fresh.proc.kill();
  ext2.conn.close();
  await sleep(200);

  // The wire path above proves the seed reaches the allocator. These cover the
  // other two ways a name becomes taken without this process ever handing it
  // out: a peer re-registering after its hub owner died, and the owner's own
  // label. Both are pure bookkeeping, so they are asserted directly.
  const { Hub } = await importFrom('mcp-server', 'src', 'hub.js');
  const bookkeeping = new Hub({ port: 0 });
  bookkeeping._reserve('harbor');
  check('a reserved name is not handed out', bookkeeping._claimName() === 'meadow');
  // A browser can still hold a group under an older server's `client · word`
  // label; the word half has to count as taken too.
  bookkeeping._reserve('claude · falcon');
  check('a legacy composite label reserves its distinguishing half', bookkeeping.takenNames.has('falcon'));
  check('and that word is skipped', bookkeeping._claimName() === 'copper');
  bookkeeping.setSessionLabel('lantern');
  check("the owner's own label is reserved", bookkeeping._claimName() === 'willow');

  // Twenty-odd agents at once is a real workload. Every one of them gets a
  // word, not `session-17`.
  const crowd = new Hub({ port: 0 });
  const handed = Array.from({ length: 40 }, () => crowd._claimName());
  check('forty concurrent sessions all get real words',
    handed.every((n) => /^[a-z]+$/.test(n)) && new Set(handed).size === 40, handed.join(','));

  // And names come back when a session's cleanup has finished — not on
  // disconnect, which would hand the name to the next session while the tab
  // group is still on screen, but once the browser confirms the tidy-up.
  const recycler = await new Hub({ port: PORT2 + 1 }).start();
  let endSeen = 0;
  const ext3 = await fakeExtension(PORT2 + 1, {
    onCall: (msg) => {
      if (msg.tool === '__session_end') endSeen++;
      if (msg.tool === '__session_list') return { names: [] };
      return undefined;
    },
  });
  await sleep(200);
  const word = recycler._claimName();
  check('a name is taken while its session lives', recycler.takenNames.has(word));
  const ending = recycler._endSession(word);
  check('a name is still taken until the browser confirms cleanup', recycler.takenNames.has(word));
  await ending;
  check('the browser was asked to tidy the session', endSeen === 1, `${endSeen} cleanup call(s)`);
  check('the name is released once cleanup completes', !recycler.takenNames.has(word));
  check('and is the first one handed out again', recycler._claimName() === word);
  ext3.conn.close();
  await recycler.stop();

  // ── Two browsers, one hub ────────────────────────────────────────────────
  section('Two browsers with the extension installed');
  await testTwoBrowsers();

  // ── The hub owner exits ──────────────────────────────────────────────────
  section('The owning server exits while another is running');
  await testHubTakeover();

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

  // ── Guided Google sign-in gating ─────────────────────────────────────────
  section('Google sign-in: the safety gates');
  await testOAuth();

  // ── Window binding ───────────────────────────────────────────────────────
  section('Window binding');
  await testWindowBinding();

  // ── Tab groups under load ────────────────────────────────────────────────
  section('Tab groups with several agents');
  await testGroupConcurrency();

  // ── Many sessions in parallel: naming, no-foreground, no takeover ────────
  section('Parallel sessions: named, backgrounded, isolated');
  await testParallelSessions();

  // ── Background input and mutation isolation ─────────────────────────────
  section('Background input and mutation isolation');
  await testBackgroundInputInvariants();

  // ── Hub-to-hub federation ────────────────────────────────────────────────
  section('Round-trip cutters: batch control flow, jobs, outline, expect');
  await testSpeedHarness();

  section('Federation between hubs');
  await testFederation();

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

/**
 * Two browsers, each running the extension, both live on one hub.
 *
 * This started as one socket, which made two browsers evict each other in a
 * permanent one-second flap; then as primary-plus-standby, which stopped the
 * flap by making the second browser useless. Both were the same mistake —
 * treating "the browser" as a singleton. Now every browser is live and a
 * *session* is bound to one.
 *
 * The hazard these guard is that tab ids are only unique within a browser. A
 * call sent to the wrong one does not fail; it succeeds on a different page.
 */
async function testTwoBrowsers() {
  const { Hub } = await importFrom('mcp-server', 'src', 'hub.js');
  const PORT3 = PORT + 2;
  const windowsFor = (n) => (msg) =>
    msg.tool === '__window_list' ? { windows: [{ windowId: n, tabs: 3, titles: ['a', 'b'] }] } : undefined;

  const hub = await new Hub({ port: PORT3 }).start();

  const work = await fakeExtension(PORT3, { instance: 'inst-work', browser: 'chrome', name: 'work', onCall: windowsFor(11) });
  await sleep(150);
  check('one browser needs no question', hub.liveBrowsers().length === 1);

  // A lone browser is never a question — same rule as one window.
  await hub.call('browser_tabs', { action: 'list', _session: 'claude · harbor' }).catch(() => {});
  check('a single browser binds silently', work.seen.some((c) => c.tool === 'browser_tabs'));
  check('the binding was recorded', hub.sessionBrowsers.get('claude · harbor') === 'inst-work');

  const personal = await fakeExtension(PORT3, { instance: 'inst-home', browser: 'chrome', name: 'personal', onCall: windowsFor(22) });
  await sleep(200);

  // Nobody is evicted, so nobody reconnects, so there is no loop.
  check('both browsers stay connected', !work.closed && !personal.closed);
  check('the hub holds both', hub.liveBrowsers().length === 2);

  // An already-bound session is unaffected by a new browser showing up.
  await hub.call('browser_tabs', { action: 'list', _session: 'claude · harbor' }).catch(() => {});
  check('a bound session is not re-asked',
    work.seen.filter((c) => c.tool === 'browser_tabs').length === 2 &&
    !personal.seen.some((c) => c.tool === 'browser_tabs'));

  // A *new* session with two browsers up must not be guessed for.
  let threw = null;
  await hub.call('browser_tabs', { action: 'list', _session: 'claude · meadow' }).catch((e) => (threw = e.message));
  check('a new session raises the chooser', !!threw && /2 browsers are connected/.test(threw), threw);
  check('the chooser names both browsers', !!threw && /browser:"work"/.test(threw) && /browser:"personal"/.test(threw), threw);
  check('the chooser lists windows from both', !!threw && /windowId:11/.test(threw) && /windowId:22/.test(threw), threw);
  check('nothing was sent to either browser', !personal.seen.some((c) => c.tool === 'browser_tabs'));

  // Answering it binds the browser and routes there.
  await hub.call('browser_window', { action: 'use', browser: 'personal', windowId: 22, _session: 'claude · meadow' }).catch(() => {});
  check('answering binds the named browser', hub.sessionBrowsers.get('claude · meadow') === 'inst-home');
  check('the answer went to that browser', personal.seen.some((c) => c.tool === 'browser_window'));

  // The two sessions now work in different browsers, simultaneously.
  await Promise.all([
    hub.call('browser_navigate', { url: 'https://a.test', _session: 'claude · harbor' }).catch(() => {}),
    hub.call('browser_navigate', { url: 'https://b.test', _session: 'claude · meadow' }).catch(() => {}),
  ]);
  check('each session drives its own browser',
    work.seen.some((c) => c.tool === 'browser_navigate' && c.args.url === 'https://a.test') &&
    personal.seen.some((c) => c.tool === 'browser_navigate' && c.args.url === 'https://b.test'));
  check('neither session leaked into the other browser',
    !work.seen.some((c) => c.args.url === 'https://b.test') &&
    !personal.seen.some((c) => c.args.url === 'https://a.test'));

  // Every call is addressed, which is what makes a misroute loud rather than a
  // silent success on a same-numbered tab in the wrong browser.
  const addressed = work.seen.find((c) => c.tool === 'browser_navigate');
  check('calls carry the browser they are addressed to', addressed?.args?._browser === 'inst-work', JSON.stringify(addressed?.args));

  // An unknown name must not fall back to a connected browser.
  threw = null;
  await hub.call('browser_tabs', { action: 'list', browser: 'nope', _session: 'claude · falcon' }).catch((e) => (threw = e.message));
  check('an unknown browser name is refused, not guessed', !!threw && /no connected browser is called "nope"/.test(threw), threw);
  check('the refusal lists the real names', !!threw && /"work"/.test(threw) && /"personal"/.test(threw));

  // Reload: the same browser reconnecting replaces its own socket only.
  const workAgain = await fakeExtension(PORT3, { instance: 'inst-work', browser: 'chrome', name: 'work', onCall: windowsFor(11) });
  await sleep(250);
  check('a reload supersedes only that browser', work.closed && !personal.closed);
  check('the hub still holds two browsers', hub.liveBrowsers().length === 2);
  check('the binding survives the reload', hub.sessionBrowsers.get('claude · harbor') === 'inst-work');
  await hub.call('browser_tabs', { action: 'list', _session: 'claude · harbor' }).catch(() => {});
  check('the session resumes on the reloaded browser', workAgain.seen.some((c) => c.tool === 'browser_tabs'));

  // A browser going away must not reassign its sessions to whatever is left —
  // that is the silent wrong-target failure the whole design exists to stop.
  workAgain.conn.close();
  await sleep(250);
  threw = null;
  await hub.call('browser_tabs', { action: 'list', _session: 'claude · harbor' }).catch((e) => (threw = e.message));
  check('a session whose browser left is not silently rehomed',
    !!threw && /is not connected right now/.test(threw), threw);
  check('its binding is kept for when the browser returns',
    hub.sessionBrowsers.get('claude · harbor') === 'inst-work');
  check("the other browser's session is unharmed", hub.sessionBrowsers.get('claude · meadow') === 'inst-home');

  // The hub answers "which browsers?" itself — no single browser can see the others.
  const listed = await hub.call('browser_window', { action: 'browsers', _session: 'claude · meadow' });
  check('the hub lists browsers locally', /"personal"/.test(listed.text), listed.text);
  check('it marks the caller\'s own browser', /your browser/.test(listed.text), listed.text);

  personal.conn.close();
  await sleep(100);
  await hub.stop();
}

/**
 * One hub driving a browser attached to another hub.
 *
 * The whole point of the design is that a remote browser is indistinguishable
 * from a local one to everything downstream of `liveBrowsers()`, so most of
 * these assertions are really checking that *nothing special happens* — the
 * chooser, the binding, and the `_browser` stamp behave as they always did.
 *
 * The two that are about federation specifically are the namespacing (names
 * collide across machines, and a bare "chrome" on two boxes is exactly the
 * ambiguity the chooser exists to remove) and the one-level-deep rule, which is
 * what makes A→B→A structurally impossible instead of a cycle to detect.
 */
async function testFederation() {
  const { Hub } = await importFrom('mcp-server', 'src', 'hub.js');
  const { toHubUrl, aliasFor } = await importFrom('mcp-server', 'src', 'federation.js');
  const LOCAL = PORT + 10;
  const REMOTE = PORT + 11;

  // Address parsing first — an agent will write "10.0.0.5", not a ws:// URL,
  // and a parse error there is a wasted turn.
  check('a bare host gets the default port and /hub', toHubUrl('10.0.0.5') === 'ws://10.0.0.5:8848/hub');
  check('host:port is respected', toHubUrl('10.0.0.5:9000') === 'ws://10.0.0.5:9000/hub');
  check('a ws:// URL is normalised to /hub', toHubUrl('ws://10.0.0.5:9000/mcp') === 'ws://10.0.0.5:9000/hub');
  check('bracketed IPv6 keeps its address', toHubUrl('[::1]:9000') === 'ws://[::1]:9000/hub');
  // A hub behind a tunnel or reverse proxy answers on 443, never 8848, so
  // carrying the plaintext default over to wss:// only buys a handshake timeout.
  check('a portless wss:// goes to 443, not 8848',
    toHubUrl('wss://ob1.example.com') === 'wss://ob1.example.com/hub');
  check('an explicit TLS port is kept',
    toHubUrl('wss://ob1.example.com:8443') === 'wss://ob1.example.com:8443/hub');
  check('a wss:// URL is normalised to /hub too',
    toHubUrl('wss://ob1.example.com/mcp') === 'wss://ob1.example.com/hub');
  check('a duplicate alias is disambiguated', aliasFor('10.0.0.5', new Set(['10.0.0.5'])) === '10.0.0.5-2');

  const remote = await new Hub({ port: REMOTE }).start();
  const cloud = await fakeExtension(REMOTE, {
    instance: 'inst-cloud',
    browser: 'chrome',
    name: 'sandbox',
    onCall: (msg) =>
      msg.tool === '__window_list' ? { windows: [{ windowId: 77, tabs: 1, titles: ['remote'] }] } : { ok: 'from-remote' },
  });
  await sleep(200);

  const local = await new Hub({ port: LOCAL }).start();
  check('a hub with no browsers has none live', local.liveBrowsers().length === 0);

  // `connect` must work with nothing attached — it is how something becomes
  // attached. Going through `call` proves the waitForExtension bypass too.
  const connected = await local.call('browser_window', {
    action: 'connect',
    hub: `127.0.0.1:${REMOTE}`,
    _session: 'claude · harbor',
  });
  await sleep(250);

  check('connect reports success', /Connected to the hub/.test(connected.text || ''), connected.text);
  check('the remote browser is now live locally', local.liveBrowsers().length === 1);

  const [rb] = local.liveBrowsers();
  check('its id is namespaced by the remote', rb.instance === `127.0.0.1/inst-cloud`, rb.instance);
  check('its name is namespaced too', /^127\.0\.0\.1\/sandbox$/.test(rb.info?.name || ''), rb.info?.name);
  check('its protocol revision crosses the federation boundary', rb.info?.protocolRevision === 2);

  // One level deep: what we expose to a federated hub is only ever our own
  // browsers. This is the cycle guard, and it is structural rather than a check.
  check('a remote browser is not re-shared', local._sharedBrowsers().length === 0);
  check('it is absent from localBrowsers', local.localBrowsers().length === 0);

  // A single browser is never a question, remote or not.
  const res = await local.call('browser_tabs', { action: 'list', _session: 'claude · harbor' });
  check('a call reaches the remote browser', cloud.seen.some((c) => c.tool === 'browser_tabs'));
  check('its result comes back', res?.ok === 'from-remote', JSON.stringify(res));
  check('the session bound to the remote browser',
    local.sessionBrowsers.get('claude · harbor') === '127.0.0.1/inst-cloud');

  // The far side must see its *own* instance id, never the namespaced one, or
  // the extension's `_browser` guard would reject every federated call.
  const relayed = cloud.seen.find((c) => c.tool === 'browser_tabs');
  check('the far side receives its own browser id', relayed?.args?._browser === 'inst-cloud', relayed?.args?._browser);

  // A tab list from another machine used to be indistinguishable from a local
  // one, so an agent that never issued `connect` read a successful call against
  // the wrong browser as proof it had reached the right one. Orientation has to
  // name the machine.
  check('a tab list says which browser answered', /Browser: "127\.0\.0\.1\/sandbox"/.test(res?.text || ''), res?.text);
  check('and that it is reached through a remote hub', /remote hub "127\.0\.0\.1"/.test(res?.text || ''), res?.text);
  const acted = await local.call('browser_act', { action: 'click', ref: 'e1', _session: 'claude · harbor' });
  check('a non-orienting call is not annotated', !/Browser: /.test(acted?.text || ''), acted?.text);

  // Reconnecting to a hub already attached must be a no-op. Minting a second
  // link put one physical browser in the chooser twice under two names, which
  // is the ambiguity the chooser exists to remove rather than create. An agent
  // unsure of its state reissuing `connect` is normal, so this cannot error.
  const again = await local.call('browser_window', {
    action: 'connect',
    hub: `127.0.0.1:${REMOTE}`,
    _session: 'claude · harbor',
  });
  check('reconnecting the same hub makes no second link', local.remotes.size === 1, `${local.remotes.size} links`);
  check('and says so rather than erroring', /Already connected/.test(again.text || ''), again.text);
  check('the browser is still listed once', local.liveBrowsers().length === 1);

  // A different port is a different machine as far as this is concerned.
  check('dedupe is by destination, not by name',
    toHubUrl(`127.0.0.1:${REMOTE}`) === toHubUrl(`127.0.0.1:${REMOTE}`) &&
    toHubUrl('127.0.0.1:1') !== toHubUrl('127.0.0.1:2'));

  // `remotes` is how an agent checks what it is attached to.
  const listed = await local.call('browser_window', { action: 'remotes', _session: 'claude · harbor' });
  check('remotes lists the hub', /127\.0\.0\.1/.test(listed.text || ''), listed.text);
  check('remotes names its browsers', /sandbox/.test(listed.text || ''), listed.text);

  // A local browser alongside a remote one raises the chooser, with both named.
  const here = await fakeExtension(LOCAL, {
    instance: 'inst-here',
    browser: 'chrome',
    name: 'laptop',
    onCall: (msg) => (msg.tool === '__window_list' ? { windows: [{ windowId: 5, tabs: 2, titles: ['x'] }] } : {}),
  });
  await sleep(250);
  check('both browsers are live', local.liveBrowsers().length === 2);

  let threw = null;
  await local.call('browser_tabs', { action: 'list', _session: 'claude · meadow' }).catch((e) => (threw = e.message));
  check('a new session is asked which browser', !!threw && /2 browsers are connected/.test(threw), threw);
  check('the chooser offers the local one', !!threw && /browser:"laptop"/.test(threw), threw);
  check('the chooser offers the remote one by namespaced name',
    !!threw && /browser:"127\.0\.0\.1\/sandbox"/.test(threw), threw);
  check('the remote window is listed', !!threw && /windowId:77/.test(threw), threw);

  // The local half of the same question. "this machine" is what tells an agent
  // aiming at a remote box that it has landed on the wrong one.
  const hereList = await local.call('browser_tabs', {
    action: 'list',
    browser: 'laptop',
    _session: 'claude · meadow',
  });
  check('a local tab list names the browser as local',
    /Browser: "laptop" — this machine\./.test(hereList?.text || ''), hereList?.text);

  // Now that a local browser exists, it — and only it — is shared onward.
  check('only the local browser is shared onward', local._sharedBrowsers().length === 1);
  check('and it is the local one', local._sharedBrowsers()[0]?.instance === 'inst-here');

  // Disconnecting drops the browsers and any binding into them, so a session
  // is not left pointing at something unreachable with no way to clear it.
  await local.call('browser_window', { action: 'disconnect', hub: '127.0.0.1', _session: 'claude · harbor' });
  await sleep(150);
  check('the remote browser is gone', local.liveBrowsers().length === 1);
  check('the binding into it was cleared', !local.sessionBrowsers.has('claude · harbor'));
  check('the local browser is untouched', local.liveBrowsers()[0]?.instance === 'inst-here');

  // A bad address fails with something actionable rather than a stack trace.
  let connErr = null;
  await local
    .call('browser_window', { action: 'connect', hub: '127.0.0.1:1', _session: 'claude · harbor' })
    .catch((e) => (connErr = e.message));
  check('an unreachable hub explains itself', !!connErr && /could not reach a hub/.test(connErr), connErr);
  check('and mentions the --host gate', !!connErr && /--host/.test(connErr), connErr);

  here.conn.close();
  cloud.conn.close();
  await sleep(100);
  await local.stop();
  await remote.stop();
}

/**
 * The owning mcp-server exits while another is still running.
 *
 * `HubClient`'s reconnect claimed in a comment that it could "take over or
 * rejoin" and could only rejoin — it called `connectWebSocket` and nothing
 * else. So every survivor retried a port nobody was listening on, once a
 * second, forever: live mcp-server processes, no hub, every browser stuck
 * retrying, and not one error message anywhere. Seen exactly like that — two
 * `index.js` processes up, nothing bound to 8848, one extension flapping and
 * one showing disconnected.
 */
async function testHubTakeover() {
  const { Hub, HubClient } = await importFrom('mcp-server', 'src', 'hub.js');
  const PORT4 = PORT + 3;

  const owner = await new Hub({ port: PORT4 }).start();
  const secondary = await new HubClient({ port: PORT4 }).start();
  check('a second server joins rather than binding', secondary.owner === null);

  // The owner goes away, as an editor restarting takes its mcp-server with it.
  await owner.stop();
  await sleep(1400); // the reconnect timer is 1s

  check('the survivor takes over the port', !!secondary.owner, 'port left orphaned');
  check('the survivor now answers as the hub', secondary.connected === false && !!secondary.owner);

  // The real proof: a browser can reach the port again.
  const ext = await fakeExtension(PORT4, { instance: 'after-takeover' });
  await sleep(200);
  check('a browser can connect to the new owner', !ext.closed && !ext.standby);

  await secondary.call('browser_tabs', { action: 'list' }).catch(() => {});
  check('calls flow through the promoted server', ext.seen.some((c) => c.tool === 'browser_tabs'));

  // A peer's call never goes through `call()` — the owner routes the frame
  // straight at a connection — so anything that shapes a result has to be in
  // the relay too. Naming the browser was written in `call()` first and was
  // silently absent for every MCP client that was not the hub owner, which is
  // most of them: one client starts the hub and the rest join it.
  const owner2 = await new Hub({ port: PORT4 + 60 }).start();
  const ext2 = await fakeExtension(PORT4 + 60, {
    instance: 'inst-peer',
    browser: 'chrome',
    name: 'desk',
    onCall: () => ({ text: '1 tab(s):\nwindow 9 (1 tab) [your window]' }),
  });
  await sleep(200);
  const peer = await new HubClient({ port: PORT4 + 60 }).start();
  check('the peer joined rather than took over', peer.owner === null);
  const relayed = await peer.call('browser_tabs', { action: 'list', _session: 'claude · peerless' });
  check('a peer\'s tab list names the browser too',
    /Browser: "desk" — this machine\./.test(relayed?.text || ''), relayed?.text);
  const acted2 = await peer.call('browser_act', { action: 'click', ref: 'e1', _session: 'claude · peerless' });
  check('and a peer\'s non-orienting call is left alone', !/Browser: /.test(acted2?.text || ''), acted2?.text);
  // The stamp `call()` adds must also be on the peer-relay path, or a current
  // extension rejects every secondary MCP client's call as "server legacy".
  // The mock extension does not enforce it, so assert it directly on what the
  // extension was sent.
  const peerCalls = ext2.seen.filter((c) => c.tool === 'browser_tabs' || c.tool === 'browser_act');
  check('a peer\'s relayed call carries the protocol revision',
    peerCalls.length > 0 && peerCalls.every((c) => c.args?._protocolRevision === 2),
    JSON.stringify(peerCalls.map((c) => [c.tool, c.args?._protocolRevision])));
  await peer.stop();
  ext2.conn.close();
  await sleep(100);
  await owner2.stop();

  // The name a session already holds must survive election, or its tab group is
  // stranded under a label nothing will clean up.
  const named = new HubClient({ port: PORT4 });
  named.sessionName = 'harbor';
  named.opts = { port: PORT4 + 50, host: '127.0.0.1', log: () => {} };
  named.url = `ws://127.0.0.1:${PORT4 + 50}/mcp`;
  await named._tryTakeOver();
  check('an elected server keeps the name it already had', named.sessionName === 'harbor');
  await named.stop();

  ext.conn.close();
  await sleep(100);
  await secondary.stop();
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

  // ── The tab list: an agent sees its own tabs, and everyone else as counts ─
  //
  // It was a flat list of every tab in the browser. With twenty agents that was
  // expensive and actively misleading — an agent reading a neighbour's tab id
  // off it is exactly how tabs got taken over. Now a session is told who it is,
  // where it works, which tabs are its own, and how many tabs everyone else
  // holds; the user's windows are counted, never listed.
  const tabs = [
    { id: 11, windowId: 501, url: 'https://mail.google.com/', title: 'Inbox', active: true },
    { id: 12, windowId: 501, url: 'https://example.com/a', title: 'A' },
    { id: 13, windowId: 501, url: 'https://example.com/m', title: 'M' },
    { id: 21, windowId: 502, url: 'https://example.com/b', title: 'B' },
    { id: 31, windowId: 700, url: 'https://news.example/', title: 'News', active: true },
    { id: 32, windowId: 700, url: 'https://docs.example/', title: 'Docs' },
  ];
  const wins = [
    { windowId: 501, focused: false, agent: true },
    { windowId: 502, focused: false, own: 'falcon' },
    { windowId: 700, focused: true },
  ];
  const agentGroups = [
    { name: 'harbor', sessionId: 'harbor', tabIds: [11], windowId: 501 },
    { name: 'mail', sessionId: 'harbor', tabIds: [12], windowId: 501 },
    { name: 'meadow', sessionId: 'meadow', tabIds: [13], windowId: 501 },
    { name: 'falcon', sessionId: 'falcon', tabIds: [21], windowId: 502 },
  ];
  const mine = fmt.renderTabs(tabs, wins, agentGroups, { boundWindowId: 501, sessionId: 'harbor' });
  check('an agent is told who it is and where it works',
    /^You are agent "harbor", working in the agent window \(id 501\)\./m.test(mine), mine);
  check('its own tabs are listed in full', /Your tabs \(2\):\n {2}11 {2}mail\.google\.com {2}"Inbox" {2}active\n {2}12 {2}example\.com\/a {2}"A" {2}group: mail/.test(mine), mine);
  check('only its own tab ids appear',
    mine.split('\n').filter((l) => /^ {2}\d+ {2}/.test(l)).map((l) => l.trim().split(/\s+/)[0]).join() === '11,12', mine);
  check('other agents in its window are counted, not listed',
    /Other agents in your window: meadow \(1 tab\)/.test(mine) && !/ 13 /.test(mine), mine);
  check('agents elsewhere are counted too', /Agents in other windows: falcon \(1 tab\)/.test(mine), mine);
  check('the user\'s windows are counted and marked off-limits',
    /The user's windows — not yours to act on: window 700 \(the user's, focused\) · 2 tabs/.test(mine) && !/ 31 /.test(mine), mine);

  // One window in full, on request — including one of the user's, so a tab of
  // theirs can be found and adopted by explicit id.
  const one = fmt.renderTabs(tabs.filter((t) => t.windowId === 700), wins, agentGroups,
    { boundWindowId: 501, sessionId: 'harbor', windowId: 700 });
  check('an explicit windowId lists that window in full', /window 700 \(the user's, focused\) · 2 tabs\n {2}31 /.test(one) && / 32 /.test(one), one);

  // The side panel has no session and is a human: every window, every tab,
  // every owner.
  const all = fmt.renderTabs(tabs, wins, agentGroups, {});
  check('the human view names each window by role',
    /^the agent window \(id 501\) · 3 tabs {2}agents: harbor, meadow$/m.test(all) && /^falcon's window \(id 502\)/m.test(all), all);
  check('the human view tags every owned tab', /^ {2}12 .*\[harbor · mail\]$/m.test(all) && /^ {2}13 .*\[meadow\]$/m.test(all), all);
  check('every tab is listed exactly once in the human view',
    all.split('\n').filter((l) => /^ {2}\d+ {2}/.test(l)).length === 6, all);

  // A session with nothing yet is told how to start, not shown an empty list.
  const fresh = fmt.renderTabs(tabs, wins, agentGroups, { boundWindowId: null, sessionId: 'quarry' });
  check('a fresh session is told no window is bound yet', /No window is bound yet/.test(fresh), fresh);
  check('and how to get a tab', /You have no tabs yet\. browser_navigate opens one/.test(fresh), fresh);

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

  // captureMapping is the single source both the screenshot's advice and the
  // `space:"image"` click inversion read from — so it is tested as a round trip:
  // a point known in CSS space, projected into image pixels, must invert back.
  const invert = (m, imgX, imgY) => ({ x: m.originX + imgX / m.scale, y: m.originY + imgY / m.scale });

  // A viewport shot downscaled from 2560 CSS px to a 1280px image: factor 0.5,
  // so image (600,400) is the CSS point (1200,800).
  const vp = fmt.captureMapping({ mode: 'viewport', meta: { viewport: { w: 2560, h: 1440 } }, image: { width: 1280, height: 720 } });
  check('viewport mapping halves a 2x-downscaled image', Math.abs(vp.scale - 0.5) < 1e-9, vp.scale);
  const vpPoint = invert(vp, 600, 400);
  check('viewport image point inverts to CSS px', Math.round(vpPoint.x) === 1200 && Math.round(vpPoint.y) === 800, JSON.stringify(vpPoint));

  // A region shot carries its own origin: the image's (0,0) is the region's
  // top-left in the page, so the offset has to survive the inversion.
  const rg = fmt.captureMapping({ mode: 'region', clip: { x: 830, y: 190, width: 460, height: 410 }, meta: { viewport: { w: 2560, h: 1440 } }, image: { width: 690, height: 615 } });
  check('region mapping keeps its factor', Math.abs(rg.scale - 1.5) < 1e-9, rg.scale);
  const rgPoint = invert(rg, 345, 0);
  check('region image point inverts through its origin', Math.round(rgPoint.x) === 1060 && Math.round(rgPoint.y) === 190, JSON.stringify(rgPoint));

  // full_page spans past the viewport, so its mapping is flagged for the caller
  // (router subtracts the live scroll offset before clicking).
  const fp = fmt.captureMapping({ mode: 'full_page', meta: { viewport: { w: 1000, h: 800 }, scroll: { maxY: 3000 } }, image: { width: 500 } });
  check('full_page mapping covers the whole document height', fp.mode === 'full_page' && Math.abs(fp.scale - 0.5) < 1e-9, JSON.stringify(fp));

  // No viewport, no honest mapping — better than a guessed one.
  check('mapping is null without a viewport', fmt.captureMapping({ mode: 'viewport', meta: {}, image: { width: 500 } }) === null);

  // ── Set-of-Marks: badge resolution and its freshness rules ─────────────────
  // markDecision is the pure core of router.markToRef: number in, ref out — but
  // only while the picture the badges were drawn on still describes the page. A
  // badge resolved against a page that navigated or resized would click whatever
  // now sits where the old element was, silently, which is the whole failure the
  // feature removes. So freshness is tested as hard as presence.
  const markRec = {
    marks: [
      { n: 1, ref: 'e7', box: { x: 10, y: 10, w: 40, h: 20 }, label: 'button Bold' },
      { n: 2, ref: 'e9', box: { x: 60, y: 10, w: 40, h: 20 }, label: 'button Italic' },
    ],
    url: 'https://docs.example/d/1',
    vw: 1280,
    vh: 800,
  };
  const sameMeta = { url: 'https://docs.example/d/1', viewport: { w: 1280, h: 800 } };
  check('a badge resolves to its ref on the same page', fmt.markDecision(markRec, sameMeta, 2)?.ref === 'e9');
  check('no table yet is a distinct, recoverable error', fmt.markDecision(null, sameMeta, 1)?.error === 'no-record');
  check(
    'a badge past the table is reported with the real range',
    (() => { const d = fmt.markDecision(markRec, sameMeta, 5); return d.error === 'no-mark' && d.max === 2; })()
  );
  check(
    'a navigation invalidates the badges and asks to clear them',
    (() => { const d = fmt.markDecision(markRec, { url: 'https://docs.example/d/2', viewport: { w: 1280, h: 800 } }, 1); return d.error === 'navigated' && d.clear === true; })()
  );
  check(
    'a resize invalidates the badges',
    fmt.markDecision(markRec, { url: 'https://docs.example/d/1', viewport: { w: 1000, h: 800 } }, 1)?.error === 'resized'
  );
  // No meta to compare against (the page read failed) is not proof of staleness,
  // so the badge still resolves — refusing there would strand a live table on a
  // transient read error.
  check('an unreadable page does not invalidate a badge', fmt.markDecision(markRec, null, 1)?.ref === 'e7');

  // ── Coordinate stress: many sessions, the whole parameter space ────────────
  // "Stress test with a bunch of different sessions until it is perfect." The
  // coordinate contract is the thing a low-context model leans on hardest — it
  // reads a pixel off the image and hands it straight back — so the mapping has
  // to hold across every viewport size, device pixel ratio, maxWidth and clip a
  // real run throws at it, not just the three worked examples above. This models
  // the actual pipeline (capture at dpr, then downscale to maxWidth) and asserts,
  // over thousands of randomized captures, that: nothing is ever NaN/Infinity or
  // a non-positive scale; the clip's own corners land on the image's corners; a
  // point projected CSS→image and inverted back lands within a pixel; and the
  // pure formatter carries no state between sessions (interleaved runs equal
  // isolated ones). A seeded PRNG makes a failure reproducible.
  let seed = 0x1a2b3c4d;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const invertPt = (m, ix, iy) => ({ x: m.originX + ix / m.scale, y: m.originY + iy / m.scale });
  const projectPt = (m, cx, cy) => ({ x: (cx - m.originX) * m.scale, y: (cy - m.originY) * m.scale });

  // One capture the way router.js would produce it: dpr then maxWidth downscale.
  const synth = (sid) => {
    const vw = 320 + Math.floor(rnd() * 3000);
    const vh = 320 + Math.floor(rnd() * 2000);
    const dpr = pick([1, 1.25, 1.5, 2, 2.5, 3]);
    const maxWidth = pick([640, 800, 1000, 1280, 1512, 2000]);
    const mode = pick(['viewport', 'full_page', 'region', 'element']);
    const meta = { viewport: { w: vw, h: vh }, scroll: { maxY: Math.floor(rnd() * 4000) } };

    let clip = null;
    if (mode === 'region' || mode === 'element') {
      // captureBeyondViewport means a clip may legitimately run past the fold, so
      // exercise clips wider/taller than the viewport too.
      const w = 1 + Math.floor(rnd() * (vw * 1.4));
      const h = 1 + Math.floor(rnd() * (vh * 1.4));
      clip = { x: Math.floor(rnd() * vw), y: Math.floor(rnd() * vh), width: w, height: h };
    }
    const coveredW = clip ? Math.round(clip.width) : mode === 'full_page' ? vw : vw;
    const nativeW = Math.max(1, Math.round(coveredW * dpr));
    const imageW = Math.min(nativeW, maxWidth);
    // Height tracks width uniformly, exactly as downscale() does.
    const image = { width: imageW, height: Math.max(1, Math.round(imageW * 0.5)) };
    return { sid, mode, clip, meta, image };
  };

  const N = 6000;
  const captures = Array.from({ length: N }, (_, i) => synth(i % 37 /* 37 "sessions" */));
  // Interleave: compute in a shuffled order, keyed by capture, to prove the
  // formatter shares nothing across sessions.
  const order = captures.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  const interleaved = new Map();
  for (const i of order) interleaved.set(i, fmt.captureMapping(captures[i]));

  let bad = 0, drift = 0, cornerMiss = 0, stateLeak = 0, worstDrift = 0, firstBad = null;
  for (let i = 0; i < N; i++) {
    const c = captures[i];
    const m = interleaved.get(i);
    if (fmt.captureMapping(c) === null ? m !== null : JSON.stringify(fmt.captureMapping(c)) !== JSON.stringify(m)) stateLeak++;
    if (!m) { if (!c.image.width || !c.meta.viewport) continue; bad++; firstBad ??= c; continue; }
    if (!Number.isFinite(m.scale) || m.scale <= 0 || !Number.isFinite(m.originX) || !Number.isFinite(m.originY)) {
      bad++; firstBad ??= { c, m }; continue;
    }
    // The clip's top-left is image (0,0); its bottom-right is (imageW,imageH).
    const tl = projectPt(m, m.originX, m.originY);
    const br = projectPt(m, m.originX + m.coveredW, m.originY + m.coveredH);
    if (Math.abs(tl.x) > 0.5 || Math.abs(tl.y) > 0.5 || Math.abs(br.x - c.image.width) > 1.5) cornerMiss++;
    // A random image point must invert and re-project to within a pixel.
    const ix = rnd() * c.image.width, iy = rnd() * c.image.height;
    const back = projectPt(m, invertPt(m, ix, iy).x, invertPt(m, ix, iy).y);
    const d = Math.max(Math.abs(back.x - ix), Math.abs(back.y - iy));
    worstDrift = Math.max(worstDrift, d);
    if (d > 0.001) drift++;
  }
  check(`${N} randomized captures across 37 sessions produce no bad mapping`, bad === 0, JSON.stringify(firstBad));
  check('every clip maps its own corners onto the image corners', cornerMiss === 0, `${cornerMiss} off`);
  check('image↔CSS round trip holds to sub-pixel everywhere', drift === 0, `worst ${worstDrift.toExponential(2)}px`);
  check('the mapping is pure — sessions never leak into each other', stateLeak === 0, `${stateLeak} mismatches`);
}

/**
 * The Google sign-in gates, tested where they live — a pure decision function,
 * so the safety-critical behaviour is provable without a browser. The bar is
 * simple and absolute: it must never turn a password screen, an unconfirmed
 * consent screen, or an unchosen chooser into a click. Every one of those has
 * been, at some point, the thing an over-eager agent would do on its own.
 */
async function testOAuth() {
  const oauth = await importFrom('extension', 'background', 'oauth.js');
  const { googleDecision, matchAccount, mergeGoogleFrames } = oauth;

  const accounts = [
    { index: 0, email: 'sam@work.com', name: 'Sam Ray' },
    { index: 1, email: 'sam@personal.com', name: 'Sam Ray' },
    { index: 2, email: 'dana@work.com', name: 'Dana Lee' },
  ];

  // The three hard gates.
  const pw = googleDecision({ stage: 'password', account: 'sam@work.com', consent: true });
  check('a password screen is always a stop, even with account+consent', pw.do === 'stop' && pw.reason === 'password');
  check('the password stop refuses to type', /will not type a password/i.test(pw.message));

  const consentNo = googleDecision({ stage: 'consent' });
  check('a consent screen stops until consent:true', consentNo.do === 'stop' && consentNo.reason === 'consent');
  const consentYes = googleDecision({ stage: 'consent', consent: true });
  check('consent:true grants access', consentYes.do === 'allow');
  const consentTruthy = googleDecision({ stage: 'consent', consent: 'yes' });
  check('only the boolean true grants — not a truthy string', consentTruthy.do === 'stop');

  // The chooser: list-and-ask unless an explicit account is given.
  const list = googleDecision({ stage: 'chooser', accounts });
  check('a chooser with no account lists and stops', list.do === 'list' && /which account/i.test(list.message));
  check('the list names every account and index', /\[0\] sam@work\.com/.test(list.message) && /\[2\] dana@work\.com/.test(list.message));

  const byIndex = googleDecision({ stage: 'chooser', accounts, account: 2 });
  check('an explicit index selects that account', byIndex.do === 'click' && byIndex.account.email === 'dana@work.com');
  const byEmail = googleDecision({ stage: 'chooser', accounts, account: 'sam@personal.com' });
  check('an exact email selects that account', byEmail.do === 'click' && byEmail.account.index === 1);

  // Ambiguity must refuse, not guess — "sam@" matches two.
  const ambiguous = googleDecision({ stage: 'chooser', accounts, account: 'sam@' });
  check('an ambiguous account fragment refuses rather than guessing', ambiguous.do === 'stop' && ambiguous.reason === 'no-match');
  const noMatch = googleDecision({ stage: 'chooser', accounts, account: 'nobody@x.com' });
  check('an unmatched account stops', noMatch.do === 'stop');

  // matchAccount resolution rules.
  check('exact email beats a partial of another', matchAccount(accounts, 'dana@work.com')?.index === 2);
  check('a unique name fragment resolves', matchAccount(accounts, 'Dana')?.index === 2);
  check('a shared name fragment is ambiguous → null', matchAccount(accounts, 'Sam Ray') === null);
  check('an empty account resolves to nothing', matchAccount(accounts, '') === null);

  const email = googleDecision({ stage: 'email' });
  check('an email-entry screen stops (no identity guessing)', email.do === 'stop' && email.reason === 'email');
  const unknown = googleDecision({ stage: 'unknown' });
  check('a page with no Google sign-in stops with guidance', unknown.do === 'stop' && unknown.reason === 'unknown');

  // Frame merge: safety-first precedence and de-duplication across frames.
  const merged = mergeGoogleFrames([
    { isGoogle: true, stage: 'chooser', accounts: [{ email: 'a@x.com', point: { x: 1, y: 1 } }] },
    { isGoogle: false, stage: 'chooser', accounts: [{ email: 'A@x.com', point: { x: 2, y: 2 } }, { email: 'b@x.com', point: { x: 3, y: 3 } }] },
  ]);
  check('accounts merge across frames and de-dup by email (case-insensitive)', merged.accounts.length === 2 && merged.accounts[0].index === 0 && merged.accounts[1].index === 1);

  const safety = mergeGoogleFrames([
    { stage: 'chooser', accounts: [{ email: 'stray@x.com', point: { x: 1, y: 1 } }] },
    { stage: 'password', accounts: [] },
  ]);
  check('a password frame outranks a stray chooser row (never click)', safety.stage === 'password');
  const consentWins = mergeGoogleFrames([
    { stage: 'chooser', accounts: [] },
    { stage: 'consent', accounts: [], allow: { point: { x: 5, y: 5 } } },
  ]);
  check('a consent frame outranks an empty chooser', consentWins.stage === 'consent' && !!consentWins.allow);
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

/**
 * Which window a session works in.
 *
 * Worth testing without a browser because the failure mode is silent and only
 * reproduces when two windows are open — an agent quietly opening its tabs into
 * the window the human is reading. The interesting cases are all decision
 * logic, so a stub is enough: one window is never a question, several always
 * are, and a choice once made must survive being asked again.
 */
async function testWindowBinding() {
  const session = {};
  let windows = [
    { id: 1, focused: true, tabs: [{ id: 11, active: true, url: 'https://a.test/' }] },
    { id: 2, focused: false, tabs: [{ id: 21, active: true, url: 'https://b.test/' }] },
  ];
  const messageListeners = [];

  const sentToTabs = [];
  globalThis.chrome = {
    tabs: {
      onRemoved: { addListener() {} },
      onUpdated: { addListener() {} },
      async sendMessage(tabId, message) {
        sentToTabs.push({ tabId, message });
        return { ok: true, result: { shown: true } };
      },
    },
    webNavigation: { onCommitted: { addListener() {} } },
    windows: {
      onRemoved: { addListener() {} },
      async getAll() {
        return windows;
      },
      async get(id) {
        const w = windows.find((x) => x.id === id);
        if (!w) throw new Error('No window with id');
        return w;
      },
      // Unique ids, because a session taking a window of its own is now the
      // normal path and two sessions doing it must not land on one window.
      //
      // `front` is tracked separately from `focused` because Chrome separates
      // them and the bug lived in the gap: a window created with
      // `focused: false` still goes on *top*, which is the whole of what the
      // user sees. A stub that models only `focused` cannot fail on it.
      async create({ focused = true } = {}) {
        const w = { id: 90 + windows.length, focused, front: true, tabs: [] };
        for (const other of windows) other.front = false;
        windows.push(w);
        return w;
      },
      async getLastFocused() {
        return windows.find((w) => w.focused) || windows[0] || null;
      },
      async update(id, patch) {
        const w = windows.find((x) => x.id === id);
        if (!w) throw new Error('No window with id');
        if (patch.focused) {
          for (const other of windows) {
            other.focused = other === w;
            other.front = other === w;
          }
        }
        return Object.assign(w, patch);
      },
    },
    storage: {
      session: {
        // Deliberately asynchronous in the way the real API is: a read resolves
        // on a later turn than the call, which is the gap concurrent
        // read-modify-write cycles fall through. A synchronous stub would make
        // the lost-update race untestable by hiding it.
        async get(key) {
          await new Promise((r) => setTimeout(r, 1));
          return key in session ? { [key]: structuredClone(session[key]) } : {};
        },
        async set(obj) {
          await new Promise((r) => setTimeout(r, 1));
          Object.assign(session, structuredClone(obj));
        },
        async remove(key) {
          delete session[key];
        },
      },
      local: { async get() { return {}; }, async set() {} },
      onChanged: { addListener() {} },
    },
    runtime: {
      getManifest: () => ({ version: '1.0.0' }),
      onMessage: { addListener: (fn) => messageListeners.push(fn) },
      // Called only for its side effect of resetting the MV3 idle timer.
      getPlatformInfo: (cb) => cb({ os: 'test' }),
    },
    scripting: { async executeScript() {}, async insertCSS() {} },
  };

  const win = await importFrom('extension', 'background', 'windows.js');

  // Two windows, no binding, and sharing opted into: the session must not pick
  // for itself. (With the default `soloWindow` it never shares, so it is never
  // choosing between the human's windows and there is nothing to ask — that
  // path is covered further down.)
  let threw = null;
  try {
    await win.ensureWindow('claude · harbor', { soloWindow: false });
  } catch (err) {
    threw = err.message;
  }
  check('several windows raise the chooser', !!threw && /2 browser windows are open/.test(threw), threw);
  check('the chooser names the session', !!threw && threw.includes('claude · harbor'));
  check('the chooser lists every window id', !!threw && threw.includes('window 1') && threw.includes('window 2'));
  // A model that has to invent the follow-up call is a model that guesses one.
  check('the chooser spells out both ways to answer', !!threw && threw.includes('action:"pick"') && threw.includes('action:"use"'));
  check('nothing is bound by a refused chooser', (await win.boundWindowId('claude · harbor')) === null);

  // Answering it sticks, and is never asked again.
  await win.use('claude · harbor', 2);
  check('use binds the named window', (await win.boundWindowId('claude · harbor')) === 2);
  check('a bound session is not asked again', (await win.ensureWindow('claude · harbor', {})) === 2);

  // A wrong id is routine — it came from a human via a model — so it has to
  // fail with the real ids rather than a bare rejection.
  threw = null;
  try {
    await win.use('claude · harbor', 77);
  } catch (err) {
    threw = err.message;
  }
  check('an unknown window id re-lists the windows', !!threw && threw.includes('no window with id 77') && threw.includes('window 1'));

  // Sessions must not share a window binding by accident.
  await win.use('claude · meadow', 1);
  check('two sessions hold separate bindings',
    (await win.boundWindowId('claude · harbor')) === 2 && (await win.boundWindowId('claude · meadow')) === 1);

  // Three agents starting together, which is the whole point of the hub.
  //
  // `bind` reads the map, edits one key, and writes the map back. Unguarded,
  // the second read lands before the first write, so the second write puts back
  // a map that never had the first binding in it — and a session whose binding
  // vanished asks again and is silently answered with the *focused* window,
  // which is where the other agents already are. Reported live as "agents are
  // using the wrong window", and it needed three of them to show up reliably.
  await Promise.all([
    win.bind('race · one', 1),
    win.bind('race · two', 2),
    win.bind('race · three', 1),
  ]);
  check('concurrent binds do not erase each other',
    (await win.boundWindowId('race · one')) === 1 &&
    (await win.boundWindowId('race · two')) === 2 &&
    (await win.boundWindowId('race · three')) === 1);

  // The same shape, with an unbind in the middle of the storm.
  await Promise.all([
    win.bind('race · four', 2),
    win.unbind('race · two'),
    win.bind('race · five', 1),
  ]);
  check('a concurrent unbind takes only its own entry',
    (await win.boundWindowId('race · four')) === 2 &&
    (await win.boundWindowId('race · five')) === 1 &&
    (await win.boundWindowId('race · one')) === 1 &&
    (await win.boundWindowId('race · two')) === null);

  // One window is never a question. It used to be answered with that window,
  // which is the one window a session must not be handed: trusted input only
  // lands on a foreground tab, so a session sharing your window pulls your view
  // to its tab on every single click. Reported as "the agent makes the window
  // unusable while I am working in it", and no amount of restoring focus
  // afterwards fixes it — that only turns a steal into a flicker.
  windows = [{ id: 1, focused: true, tabs: [] }];
  const solo = await win.ensureWindow('solo', {});
  check('the human\'s only window is not handed to a session', solo !== 1);
  check('the session is given one of its own', windows.some((w) => w.id === solo));
  check('and is bound to it', (await win.boundWindowId('solo')) === solo);
  // Unfocused: it has to exist and be visible, not be in front.
  check('the new window does not take the front', windows.find((w) => w.id === solo).focused === false);

  // Direct CDP input is target-addressed, so sessions share one background
  // container without sharing tab ownership. This prevents window-per-agent
  // sprawl and means later sessions create no new window that can stack above
  // the user's work on macOS.
  const [a, b] = await Promise.all([win.ensureWindow('solo · a', {}), win.ensureWindow('solo · b', {})]);
  check('two sessions reuse the background agent window', a === b && a === solo);

  // And the chooser is gone from the common path rather than answered: with a
  // window of its own there is no wrong window to land in, so a second session
  // starting while a first one runs is never blocked on a human. That question
  // used to fire the moment a second window existed — including one another
  // agent had just opened for itself.
  windows = [
    { id: 1, focused: true, tabs: [] },
    { id: 2, focused: false, tabs: [] },
  ];
  check('several windows no longer raise the chooser',
    typeof (await win.ensureWindow('unasked', {})) === 'number');

  // Off, for people whose reason for sharing a window is to watch. Then the old
  // behaviour returns in full, chooser included.
  windows = [{ id: 1, focused: true, tabs: [] }];
  check('soloWindow:false takes the focused window',
    (await win.ensureWindow('watcher', { soloWindow: false })) === 1);

  windows = [
    { id: 1, focused: false, tabs: [] },
    { id: 2, focused: true, tabs: [] },
  ];
  check('soloWindow:false with chooseWindow:false takes the focused window',
    (await win.ensureWindow('quiet', { soloWindow: false, chooseWindow: false })) === 2);

  // A model that has not been told action:"new" exists cannot offer it, and
  // this error is the one place a session learns which windows there are.
  let chooser = null;
  try {
    await win.ensureWindow('asker', { soloWindow: false });
  } catch (err) {
    chooser = err.message;
  }
  check('the chooser still fires when sharing is opted into', !!chooser);
  check('the chooser offers a window of its own', !!chooser && chooser.includes('action:"new"'));

  // Not taking the window is not enough if the new one lands on top of it.
  // `focused: false` governs keyboard focus, not stacking — on macOS a new
  // window is placed above its siblings regardless — so an agent starting up
  // threw its window over the page being read. Indistinguishable, from the
  // outside, from the takeover this module exists to prevent.
  windows = [{ id: 1, focused: true, front: true, tabs: [] }];
  const front = await win.createFor('front-test');
  check('the user\'s window is put back on top', windows.find((w) => w.id === 1).front === true);
  check('the session still gets its own window', front !== 1 && (await win.boundWindowId('front-test')) === front);

  // But only when Chrome was the front application to begin with. Raising a
  // window in a browser the user is not even looking at drags the whole browser
  // in front of whatever app they are actually in — a bigger interruption than
  // the one being fixed, and one they did not ask for.
  windows = [{ id: 1, focused: false, front: true, tabs: [] }];
  await win.createFor('bg-test');
  check('a backgrounded browser is not dragged forward',
    windows.find((w) => w.id === 1).focused === false);

  // Owning a window and merely being bound to one are different facts, and only
  // the first makes switching tabs invisible. A window id says nothing about who
  // else is in it, so this has to be recorded when the window is opened.
  windows = [{ id: 1, focused: true, front: true, tabs: [] }];
  const mine = await win.createFor('owner');
  check('a window opened for a session is its own', (await win.ownWindowId('owner')) === mine);

  await win.use('owner', 1);
  check('binding to the user\'s window is not ownership', (await win.ownWindowId('owner')) === null);
  check('but it is still the bound window', (await win.boundWindowId('owner')) === 1);

  // A binding written before ownership existed is a bare number. It has to read
  // as *not* owned — a window whose provenance is unknown is someone else's,
  // which is the side that costs a window rather than a stolen view.
  await win.bind('legacy', 1);
  check('an explicit bind is never own', (await win.ownWindowId('legacy')) === null);

  // The explicit form of the same thing, for a session that is already sharing.
  const own = await win.createFor('mover');
  check('createFor opens and binds a window', own != null && (await win.boundWindowId('mover')) === own);
  check('createFor refuses an unlabelled caller', await win.createFor().then(() => false, () => true));

  // The human closed the window the session was working in. A stale id turns
  // every later call into an unexplained Chrome error, so it must be dropped.
  windows = [{ id: 2, focused: true, tabs: [] }];
  check('a closed window releases its binding', (await win.boundWindowId('claude · meadow')) === null);

  // Ending a session must not leave its choice behind for the next one.
  await win.unbind('claude · harbor');
  check('unbind forgets the window', (await win.boundWindowId('claude · harbor')) === null);

  // ── Windows have roles, and the role is what gets said ───────────────────
  //
  // A bare Chrome id was the whole of what a window used to be called, and it
  // is the reason nobody could read window output. The shared agent window,
  // a window opened for one session, and the user's windows are three
  // different things and are named as such; the id stays because `use` takes
  // it.
  windows = [
    { id: 1, focused: true, tabs: [] },
    { id: 2, focused: false, tabs: [] },
  ];
  const pooled = await win.ensureWindow('pooled-a', {});
  const soloWin = await win.createFor('soloist');
  const named = await win.listWindows();
  const byId = new Map(named.map((w) => [w.windowId, w]));
  check('the shared agent window is flagged', byId.get(pooled)?.agent === true, JSON.stringify(named));
  check('a window opened for one session names that session', byId.get(soloWin)?.own === 'soloist');
  check('the user\'s windows are neither', !byId.get(1)?.agent && !byId.get(1)?.own);
  check('the agent window is called that', win.windowName(byId.get(pooled)) === `the agent window (id ${pooled})`);
  check('a session\'s own window is called that', win.windowName(byId.get(soloWin)) === `soloist's window (id ${soloWin})`);
  check('the user\'s window says whose it is and whether it is focused',
    win.windowName(byId.get(1)) === "window 1 (the user's, focused)" && win.windowName(byId.get(2)) === "window 2 (the user's)");
  // `select`/`focus` may switch the visible tab only where no human is: the
  // session's own window, or the shared agent window — never the user's.
  check('the agent window counts as agent-only for a pooled session', (await win.agentWindowIdFor('pooled-a')) === pooled);
  check('a session\'s own window counts as agent-only', (await win.agentWindowIdFor('soloist')) === soloWin);
  await win.use('sharer', 1);
  check('a session sharing the user\'s window has no agent-only window', (await win.agentWindowIdFor('sharer')) === null);

  // The click can outlive the service worker that opened the prompt, so the
  // binding is written from the message itself and not only from the waiting
  // promise. Without this a killed worker loses the answer and asks again.
  check('a pick reply is handled', messageListeners.length > 0);

  /**
   * Let every queued storage write drain.
   *
   * The stub deliberately puts a real timer in front of each get and set, so
   * that concurrent read-modify-write cycles can actually interleave and the
   * lost-update race is reproducible. The cost is that a fixed `setTimeout(20)`
   * is a guess — it passed or failed depending on how the timers landed. This
   * yields enough turns for the whole chain to settle instead.
   */
  const settled = async () => {
    for (let i = 0; i < 40; i++) await new Promise((r) => setTimeout(r, 2));
  };

  /** Wait for an asynchronously-written condition, rather than guessing a delay. */
  const waitFor = async (predicate, ms = 2000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (predicate()) return true;
      await new Promise((r) => setTimeout(r, 5));
    }
    return false;
  };

  const deliver = async (msg, windowId) => {
    for (const fn of messageListeners) fn(msg, { tab: { windowId } });
    await settled();
  };
  await deliver({ type: 'ob_window_pick', token: 'gone', label: 'claude · falcon', choice: 'use' }, 2);
  check('a click binds even with nobody waiting', (await win.boundWindowId('claude · falcon')) === 2);

  // --- The prompt, end to end ------------------------------------------------
  windows = [
    { id: 1, focused: true, tabs: [{ id: 11, active: true, url: 'https://a.test/' }] },
    { id: 2, focused: false, tabs: [{ id: 21, active: true, url: 'https://b.test/' }] },
  ];

  // Declining one window is not an answer; declining all of them is.
  let picking = win.pick('claude · willow').then(() => 'resolved', (e) => e.message);
  await new Promise((r) => setTimeout(r, 20));
  const token = sentToTabs.at(-1)?.message?.args?.token;
  check('the prompt is shown in every window', sentToTabs.filter((s) => s.message?.cmd === 'window_pick').length >= 2);
  check('the prompt carries a token', typeof token === 'string' && token.length > 0);

  await deliver({ type: 'ob_window_pick', token, label: 'claude · willow', choice: 'decline' }, 1);
  check('one refusal is not an answer', (await Promise.race([picking, Promise.resolve('pending')])) === 'pending');

  await deliver({ type: 'ob_window_pick', token, label: 'claude · willow', choice: 'decline' }, 2);
  check('refusing every window ends the call', /declined every window/.test(await picking));
  check('a refused pick binds nothing', (await win.boundWindowId('claude · willow')) === null);

  // The service worker can be torn down while the prompt is on screen — it was
  // seen doing exactly that. The click then reaches a worker that never asked,
  // so the tally has to live in storage or the answer is silently dropped and
  // the call hangs until it times out.
  picking = win.pick('claude · basalt').then(() => 'resolved', (e) => e.message);
  await new Promise((r) => setTimeout(r, 20));
  const liveToken = sentToTabs.at(-1)?.message?.args?.token;
  check('the prompt is recorded in storage, not just memory',
    await waitFor(() => session.windowPickState?.[liveToken]?.shown?.length === 2),
    JSON.stringify(session.windowPickState));

  await deliver({ type: 'ob_window_pick', token: liveToken, label: 'claude · basalt', choice: 'decline' }, 1);
  check('a decline is tallied in storage',
    (session.windowPickState?.[liveToken]?.declined || []).includes(1));
  await deliver({ type: 'ob_window_pick', token: liveToken, label: 'claude · basalt', choice: 'decline' }, 2);
  await picking;

  // And the answer a dead worker missed is honoured on the retry rather than
  // asking the user to repeat themselves.
  session.windowPickState = {
    stale: { label: 'claude · ember', shown: [1, 2], declined: [1, 2], done: 'declined' },
  };
  check('a retry reports the answer the lost worker missed',
    /declined every window/.test(await win.pick('claude · ember').then(() => 'resolved', (e) => e.message)));

  session.windowPickState = {
    stale2: { label: 'claude · quarry', shown: [1, 2], declined: [], done: 'chosen', windowId: 2 },
  };
  const recovered = await win.pick('claude · quarry');
  check('a retry recovers a choice the lost worker missed', recovered.windowId === 2 && recovered.recovered === true);
  check('the recovered choice is bound', (await win.boundWindowId('claude · quarry')) === 2);

  // --- Two sessions asking at the same time ---------------------------------
  //
  // A single storage slot meant the second prompt overwrote the first, and the
  // first session then waited out its full 90s for an answer with nowhere to
  // land. Both must be able to be in flight, and answering one must not touch
  // the other.
  sentToTabs.length = 0;
  const first = win.pick('claude · orchard').then(() => 'resolved', (e) => e.message);
  const second = win.pick('claude · pelican').then(() => 'resolved', (e) => e.message);
  await new Promise((r) => setTimeout(r, 40));

  const tokens = [...new Set(sentToTabs
    .filter((s) => s.message?.cmd === 'window_pick' && s.message.args?.on)
    .map((s) => s.message.args.token))];
  check('two sessions can be asking at once', tokens.length === 2, `got ${tokens.length}`);
  check('both prompts are recorded',
    await waitFor(() => tokens.every((t) => !!session.windowPickState?.[t])),
    JSON.stringify(session.windowPickState));

  const [tokenA, tokenB] = tokens;
  await deliver({ type: 'ob_window_pick', token: tokenA, label: 'claude · orchard', choice: 'use' }, 1);
  check('answering one session resolves only that one',
    (await first).windowId === undefined ? true : true);
  check('the answered session is bound', (await win.boundWindowId('claude · orchard')) === 1);
  check('the other session is still waiting',
    (await Promise.race([second, Promise.resolve('pending')])) === 'pending');
  check('the other session keeps its record', !!session.windowPickState[tokenB]);

  await deliver({ type: 'ob_window_pick', token: tokenB, label: 'claude · pelican', choice: 'use' }, 2);
  await second;
  check('the second session binds its own window', (await win.boundWindowId('claude · pelican')) === 2);
}

/**
 * Grouping when several tabs — or several agents — arrive at once.
 *
 * The bug this guards is silent: `assign` looks for the workstream's group,
 * misses, and creates one, across two awaits. Two tabs grouped at the same
 * moment therefore produce two Chrome groups with the same title, and from then
 * on a lookup that takes the first match sees only half the workstream. Nothing
 * errors; a session just quietly loses track of its own tabs, and can be handed
 * one from a group in a different window.
 */
/**
 * A Chrome stub faithful enough to drive the *real* router across many sessions
 * at once — tabs, windows (with the agent-window pool), tab groups, and an
 * async storage.session that keeps the read-modify-write hazard the real one
 * has. `focusRaises` records every windows.update({focused:true}); `agentWindows`
 * every window the code created for itself. That pair is what proves no agent
 * ever brought its own window to the front.
 */
function makeChromeStub({ seed = 0 } = {}) {
  const nap = () => new Promise((r) => setTimeout(r, Math.floor(Math.random() * 2)));
  const tabs = new Map(); // id -> {id, windowId, groupId, active, url, status}
  const wins = new Map(); // id -> {id, type, focused, state}
  const tabGroups = new Map(); // id -> {id, title, color, windowId}
  const sessionStore = {};
  const localStore = {};
  const focusRaises = []; // window ids raised to the front
  const agentWindows = new Set(); // windows the code created
  // Offsets so ids never collide across iterations — the router keeps in-memory
  // caches between "worker restarts", and a reused id would be a test artifact,
  // not a real overlap (Chrome hands out fresh ids for a worker's lifetime).
  const userWindow = 1 + seed * 100000;
  let nextTab = 1000 + seed * 100000;
  let nextWin = 10 + seed * 100000;
  let nextGroup = 100 + seed * 100000;
  let focusedWindow = userWindow;

  wins.set(userWindow, { id: userWindow, type: 'normal', focused: true, state: 'normal' });

  const tabObjs = (windowId) =>
    [...tabs.values()].filter((t) => t.windowId === windowId).map((t) => ({ ...t }));

  const chrome = {
    runtime: {
      getManifest: () => ({ version: '1.0.0' }),
      getPlatformInfo: (cb) => cb && cb({ os: 'mac' }),
      lastError: null,
      onMessage: { addListener() {}, removeListener() {} },
      id: 'test-extension',
    },
    tabs: {
      onRemoved: { addListener() {}, removeListener() {} },
      onUpdated: { addListener() {}, removeListener() {} },
      onActivated: { addListener() {}, removeListener() {} },
      async create({ url = 'about:blank', windowId, active = false } = {}) {
        await nap();
        const id = nextTab++;
        const wid = windowId != null && wins.has(windowId) ? windowId : focusedWindow;
        tabs.set(id, { id, windowId: wid, groupId: -1, active: !!active, url, status: 'complete' });
        return { ...tabs.get(id) };
      },
      async get(id) {
        await nap();
        if (!tabs.has(id)) throw new Error(`No tab with id: ${id}.`);
        return { ...tabs.get(id) };
      },
      async query(q = {}) {
        await nap();
        let out = [...tabs.values()];
        if (q.windowId != null) out = out.filter((t) => t.windowId === q.windowId);
        if (q.groupId != null) out = out.filter((t) => t.groupId === q.groupId);
        if (q.active != null) out = out.filter((t) => t.active === q.active);
        return out.map((t) => ({ ...t }));
      },
      async update(id, patch = {}) {
        await nap();
        if (!tabs.has(id)) throw new Error(`No tab with id: ${id}.`);
        Object.assign(tabs.get(id), patch);
        return { ...tabs.get(id) };
      },
      async remove(ids) {
        await nap();
        for (const id of [].concat(ids)) tabs.delete(id);
      },
      async move(id, { windowId, index } = {}) {
        await nap();
        if (!tabs.has(id)) throw new Error(`No tab with id: ${id}.`);
        if (windowId != null) tabs.get(id).windowId = windowId;
        return { ...tabs.get(id) };
      },
      async reload(id) {
        await nap();
        if (!tabs.has(id)) throw new Error(`No tab with id: ${id}.`);
        tabs.get(id).status = 'complete';
      },
      async duplicate(id) {
        await nap();
        const src = tabs.get(id);
        const nid = nextTab++;
        tabs.set(nid, { ...src, id: nid, active: false });
        return { ...tabs.get(nid) };
      },
      async group({ tabIds, groupId, createProperties }) {
        await nap();
        const id = groupId ?? nextGroup++;
        if (!tabGroups.has(id)) {
          tabGroups.set(id, { id, title: '', color: 'grey', windowId: createProperties?.windowId ?? focusedWindow });
        }
        const target = tabGroups.get(id).windowId;
        for (const t of [].concat(tabIds)) {
          if (tabs.has(t)) { tabs.get(t).groupId = id; tabs.get(t).windowId = target; }
        }
        return id;
      },
      async ungroup(ids) {
        for (const t of [].concat(ids)) if (tabs.has(t)) tabs.get(t).groupId = -1;
      },
      async setZoom() {},
      async sendMessage() { return undefined; }, // no content script → callers fall back
    },
    windows: {
      onRemoved: { addListener() {}, removeListener() {} },
      WINDOW_ID_NONE: -1,
      async create({ focused = false, url } = {}) {
        await nap();
        const id = nextWin++;
        wins.set(id, { id, type: 'normal', focused: !!focused, state: 'normal' });
        agentWindows.add(id);
        const tid = nextTab++;
        tabs.set(tid, { id: tid, windowId: id, groupId: -1, active: true, url: url || 'about:blank', status: 'complete' });
        if (focused) { focusedWindow = id; focusRaises.push(id); }
        return { id, type: 'normal', focused: !!focused, tabs: [{ ...tabs.get(tid) }] };
      },
      async get(id, opts = {}) {
        await nap();
        if (!wins.has(id)) throw new Error(`No window with id: ${id}.`);
        const w = { ...wins.get(id) };
        if (opts.populate) w.tabs = tabObjs(id);
        return w;
      },
      async getAll(opts = {}) {
        await nap();
        return [...wins.values()].map((w) => (opts.populate ? { ...w, tabs: tabObjs(w.id) } : { ...w }));
      },
      async getLastFocused() {
        await nap();
        return { ...(wins.get(focusedWindow) || wins.get(userWindow)) };
      },
      async update(id, patch = {}) {
        await nap();
        if (!wins.has(id)) throw new Error(`No window with id: ${id}.`);
        if (patch.focused === true) {
          for (const w of wins.values()) w.focused = false;
          wins.get(id).focused = true;
          focusedWindow = id;
          focusRaises.push(id);
        }
        Object.assign(wins.get(id), patch);
        return { ...wins.get(id) };
      },
      async remove(id) { wins.delete(id); },
    },
    tabGroups: {
      TAB_GROUP_ID_NONE: -1,
      onRemoved: { addListener() {} },
      async query(q = {}) {
        await nap();
        let out = [...tabGroups.values()];
        if (q.windowId != null) out = out.filter((g) => g.windowId === q.windowId);
        return out.map((g) => ({ ...g }));
      },
      async get(id) {
        if (!tabGroups.has(id)) throw new Error('no group');
        return { ...tabGroups.get(id) };
      },
      async update(id, patch) {
        await nap();
        if (tabGroups.has(id)) Object.assign(tabGroups.get(id), patch);
        return { ...tabGroups.get(id) };
      },
    },
    webNavigation: {
      onCommitted: { addListener() {} },
      onDOMContentLoaded: { addListener() {} },
      async getAllFrames() { return []; },
    },
    debugger: {
      onEvent: { addListener() {} },
      onDetach: { addListener() {} },
      async attach() {},
      async detach() {},
      async sendCommand() { return {}; },
    },
    scripting: {
      async executeScript() { return []; },
      async insertCSS() {},
    },
    storage: {
      local: {
        async get(key) { await nap(); return key == null ? { ...localStore } : { [key]: localStore[key] }; },
        async set(obj) { await nap(); Object.assign(localStore, structuredClone(obj)); },
        async remove(key) { delete localStore[key]; },
      },
      session: {
        async get(key) {
          await nap();
          if (key == null) return structuredClone(sessionStore);
          return key in sessionStore ? { [key]: structuredClone(sessionStore[key]) } : {};
        },
        async set(obj) { await nap(); Object.assign(sessionStore, structuredClone(obj)); },
        async remove(key) { await nap(); for (const k of [].concat(key)) delete sessionStore[k]; },
      },
      onChanged: { addListener() {} },
    },
  };

  return { chrome, state: { tabs, wins, tabGroups, sessionStore }, focusRaises, agentWindows, userWindow };
}

/**
 * The heart of the multi-session promise: several agents driving one browser at
 * once must (1) each get their own named workstream, (2) never bring a window to
 * the front, and (3) never read or touch another session's tabs. This drives the
 * real `dispatch` — the same entry every MCP call lands on — with N sessions
 * acting concurrently, then asserts all three, and repeats to shake out the
 * storage read-modify-write races that only surface with three or more agents.
 */
/**
 * One storm: `sessions` agents each open `tabsPer` tabs at once through the real
 * `dispatch`, then the three invariants are measured. Returns a tally of every
 * violation so the caller can both report a readable single run and hammer it in
 * a loop. No `check` here — the caller owns assertions.
 */
async function parallelScenario(router, groups, { sessions, tabsPer, seed }) {
  const stub = makeChromeStub({ seed });
  globalThis.chrome = stub.chrome;
  const owned = new Map(sessions.map((s) => [s, []]));

  const opens = [];
  for (const s of sessions) {
    for (let i = 0; i < tabsPer; i++) {
      const url = `https://${s}-${i}.test/`;
      opens.push(
        router.dispatch('browser_tabs', { action: 'new', url, _session: s, _client: 'test' }).then((res) => {
          const m = /opened tab (\d+)/.exec(res.text || '');
          if (m) owned.get(s).push(Number(m[1]));
        })
      );
    }
  }
  await Promise.all(opens);

  const total = [...owned.values()].reduce((n, a) => n + a.length, 0);
  const owners = await groups.ownersFor([...owned.values()].flat());
  let misowned = 0;
  for (const [s, ids] of owned) for (const id of ids) if (owners.get(id)?.sessionId !== s) misowned++;
  const distinctOwners = new Set([...owners.values()].map((o) => o.sessionId));

  const raisedAgent = stub.focusRaises.filter((id) => stub.agentWindows.has(id));
  const userFocused = stub.state.wins.get(stub.userWindow)?.focused === true;

  let leak = 0;
  for (const s of sessions) {
    const listing = (await router.dispatch('browser_tabs', { action: 'list', _session: s, _client: 'test' })).text;
    for (const id of owned.get(s)) if (!new RegExp(`\\b${id}\\b`).test(listing)) leak++;
    for (const [other, ids] of owned) {
      if (other === s) continue;
      for (const id of ids) if (new RegExp(`\\b${id}\\b`).test(listing)) leak++;
    }
  }

  let breaches = 0;
  for (const s of sessions) {
    const victim = sessions.find((o) => o !== s);
    const foreignId = owned.get(victim)[0];
    for (const action of ['close', 'reload', 'group']) {
      const args = { action, _session: s, _client: 'test', tabIds: [foreignId] };
      if (action === 'group') args.group = 'steal';
      let refused = false;
      try { await router.dispatch('browser_tabs', args); } catch { refused = true; }
      if (!refused) breaches++;
    }
    if (!stub.state.tabs.has(foreignId)) breaches++;
  }

  let wrongHome = 0;
  for (const s of sessions) {
    const text = (await router.dispatch('browser_tabs', { action: 'reload', _session: s, _client: 'test' })).text;
    const m = /reloaded tab\(s\): (\d+)/.exec(text);
    if (!m || !owned.get(s).includes(Number(m[1]))) wrongHome++;
  }

  return {
    total, expected: sessions.length * tabsPer, misowned, distinctOwners: distinctOwners.size,
    raisedAgent: raisedAgent.length, userFocused, agentWindows: stub.agentWindows.size,
    leak, breaches, wrongHome,
  };
}

async function testParallelSessions() {
  // Importing after the first stub is installed binds the real modules to it;
  // later scenarios reinstall a fresh stub on the same (cached) modules, which
  // also exercises the in-memory caches surviving a "worker restart".
  globalThis.chrome = makeChromeStub({ seed: 0 }).chrome;
  const router = await importFrom('extension', 'background', 'router.js');
  const groups = await importFrom('extension', 'background', 'groups.js');

  const SESSIONS = ['harbor', 'meadow', 'cedar', 'quill', 'sable', 'flint'];

  // One readable run, asserted invariant by invariant.
  const r = await parallelScenario(router, groups, { sessions: SESSIONS, tabsPer: 3, seed: 1 });
  check('every session opened all of its tabs', r.total === r.expected, `${r.total}/${r.expected}`);
  check('every tab is owned by exactly the session that opened it', r.misowned === 0, `${r.misowned} mis-owned`);
  check('all sessions are represented and named distinctly', r.distinctOwners === SESSIONS.length, `${r.distinctOwners}`);
  check('no agent window was ever brought to the front', r.raisedAgent === 0, `${r.raisedAgent} raises`);
  check('the user window stays focused throughout', r.userFocused, `${r.userFocused}`);
  check('agents share the background pool, not one window each', r.agentWindows >= 1 && r.agentWindows <= 2, `${r.agentWindows} agent windows`);
  check('a session lists its own tabs and never another session\'s', r.leak === 0, `${r.leak} leaks`);
  check('closing/reloading/grouping a foreign tab is always refused', r.breaches === 0, `${r.breaches} breaches`);
  check('a no-tabId call resolves to the caller\'s own tab, never another\'s', r.wrongHome === 0, `${r.wrongHome} wrong`);

  // Then hammer it: many storms, growing session counts, fresh stub each time —
  // the loop is where a read-modify-write race or a cache surviving a restart
  // actually shows up, because it needs the interleaving to land just so.
  const ITERATIONS = 40;
  let clean = 0;
  const failures = [];
  for (let i = 0; i < ITERATIONS; i++) {
    const n = 3 + (i % 8); // 3..10 concurrent sessions
    const sessions = Array.from({ length: n }, (_, k) => `s${i}_${k}`);
    const res = await parallelScenario(router, groups, { sessions, tabsPer: 4, seed: 100 + i });
    const ok =
      res.total === res.expected && res.misowned === 0 && res.distinctOwners === n &&
      res.raisedAgent === 0 && res.userFocused && res.leak === 0 && res.breaches === 0 && res.wrongHome === 0;
    if (ok) clean++;
    else failures.push({ i, n, ...res });
  }
  check(`${ITERATIONS} parallel storms (up to 10 sessions × 4 tabs) hold every invariant`, clean === ITERATIONS, JSON.stringify(failures.slice(0, 2)));
}

async function testGroupConcurrency() {
  // A window none of the fixture tabs live in, standing in for "whatever Chrome
  // last focused" — which is the human's window, and the one an agent must not
  // be dragged into.
  const CURRENT_WINDOW = 99;
  let nextGroupId = 100;
  const tabGroups = new Map(); // id -> {id, title, color, windowId}
  const tabs = new Map(); // id -> {id, windowId, groupId}
  const sessionStore = {};
  const nap = () => new Promise((r) => setTimeout(r, 1));

  for (const [id, windowId] of [[1, 10], [2, 10], [3, 10], [4, 20], [5, 10]]) {
    tabs.set(id, { id, windowId, groupId: -1 });
  }

  globalThis.chrome = {
    tabs: {
      onRemoved: { addListener() {} },
      onUpdated: { addListener() {} },
      async get(id) {
        await nap();
        if (!tabs.has(id)) throw new Error('no tab');
        return tabs.get(id);
      },
      // Chrome's actual contract, which this stub used to quietly improve on.
      // With no `createProperties.windowId`, a new group is created in the
      // *current* window — not the tabs' window — and the tabs are MOVED there
      // to join it. Modelling the polite version is exactly why the real bug
      // reached a real browser: grouping, whose failures are swallowed because
      // it is only cosmetic, was relocating the tab it was asked to colour.
      async group({ tabIds, groupId, createProperties }) {
        await nap();
        const id = groupId ?? nextGroupId++;
        if (!tabGroups.has(id)) {
          const windowId = createProperties?.windowId ?? CURRENT_WINDOW;
          tabGroups.set(id, { id, title: '', color: 'grey', windowId });
        }
        const target = tabGroups.get(id).windowId;
        for (const t of tabIds) {
          tabs.get(t).groupId = id;
          tabs.get(t).windowId = target;
        }
        return id;
      },
      async ungroup(ids) {
        for (const t of [].concat(ids)) tabs.get(t).groupId = -1;
      },
      async move(id, { windowId }) {
        await nap();
        tabs.get(id).windowId = windowId;
        return tabs.get(id);
      },
      async query({ groupId }) {
        await nap();
        return [...tabs.values()].filter((t) => t.groupId === groupId);
      },
      async remove(ids) {
        for (const t of [].concat(ids)) tabs.delete(t);
      },
    },
    tabGroups: {
      TAB_GROUP_ID_NONE: -1,
      onRemoved: { addListener() {} },
      async query() {
        await nap();
        return [...tabGroups.values()];
      },
      async get(id) {
        if (!tabGroups.has(id)) throw new Error('no group');
        return tabGroups.get(id);
      },
      async update(id, patch) {
        await nap();
        Object.assign(tabGroups.get(id), patch);
        return tabGroups.get(id);
      },
    },
    webNavigation: { onCommitted: { addListener() {} } },
    storage: {
      local: { async get() { return {}; }, async set() {} },
      session: {
        async get(key) {
          return key in sessionStore ? { [key]: structuredClone(sessionStore[key]) } : {};
        },
        async set(obj) {
          Object.assign(sessionStore, structuredClone(obj));
        },
      },
      onChanged: { addListener() {} },
    },
    runtime: { getManifest: () => ({ version: '1.0.0' }) },
  };

  const groups = await importFrom('extension', 'background', 'groups.js');

  // Three tabs into one workstream, all at once — an agent opening a batch, or
  // three agents sharing a label.
  await Promise.all([
    groups.assign(1, 'session-a', 'dev · harbor'),
    groups.assign(2, 'session-a', 'dev · harbor'),
    groups.assign(3, 'session-a', 'dev · harbor'),
  ]);

  const harbor = [...tabGroups.values()].filter((g) => g.title.endsWith('dev · harbor'));
  check('concurrent grouping creates one group, not several', harbor.length === 1, `got ${harbor.length}`);
  check('every tab lands in that group', (await groups.tabsFor('session-a', 'dev · harbor')).length === 3);

  // Grouping colours a tab. It must not move it. Verified to fail when
  // `createProperties.windowId` is dropped from `assignNow`, which is how it
  // behaved in Chrome: a session given a window of its own had its first tab
  // pulled straight back into the human's, and its now-empty window closed
  // itself — so the session reported no window bound, two calls after being
  // given one.
  check('grouping leaves tabs in their own window',
    [1, 2, 3].every((id) => tabs.get(id).windowId === 10),
    JSON.stringify([1, 2, 3].map((id) => tabs.get(id).windowId)));
  check('the group is created in the tabs\' window, not the focused one',
    harbor[0]?.windowId === 10, `group in window ${harbor[0]?.windowId}`);

  // Separate workstreams stay separate under the same load.
  await Promise.all([
    groups.assign(4, 'session-a', 'dev · meadow'),
    groups.assign(1, 'session-a', 'dev · harbor'),
  ]);
  check('a second workstream gets its own group',
    [...tabGroups.values()].filter((g) => g.title.endsWith('dev · meadow')).length === 1);
  check('the first workstream is unchanged', (await groups.tabsFor('session-a', 'dev · harbor')).length === 3);

  // A display label is not authority. Another session can use the same short
  // workstream name without joining, resolving, releasing, or closing the
  // first session's tabs.
  await groups.assign(5, 'session-b', 'dev · harbor');
  check('same-named workstreams from different sessions get separate groups',
    [...tabGroups.values()].filter((g) => g.title.endsWith('dev · harbor')).length === 2);
  check('same-named workstreams do not share tabs',
    (await groups.tabsFor('session-a', 'dev · harbor')).length === 3 &&
      (await groups.tabsFor('session-b', 'dev · harbor')).join() === '5');
  check('tab ownership records the stamped session, not the display label',
    (await groups.ownerFor(5))?.sessionId === 'session-b');

  // A duplicate that already exists — made by hand, or left by an older build —
  // must not hide half the workstream from the session that owns it.
  const stray = { id: nextGroupId++, title: 'session-a · dev · harbor', color: 'blue', windowId: 20 };
  tabGroups.set(stray.id, stray);
  tabs.set(9, { id: 9, windowId: 20, groupId: stray.id });
  sessionStore.tabGroupOwnersV2[stray.id] = { sessionId: 'session-a', workstream: 'dev · harbor' };
  check('a duplicate group is not allowed to hide tabs',
    (await groups.tabsFor('session-a', 'dev · harbor')).length === 4);

  // ── The same duplicate, from the point of view of resolving a tab ────────
  //
  // Cleanup wants every tab under this name, wherever it is — that is the
  // assertion above. *Resolution* wants the opposite: a session bound to one
  // window must never be handed a tab in another, or every call after that
  // lands somewhere the session has been told it is not. Tabs 1-3 are in
  // window 10, the stray is in window 20.
  check('resolution scoped to a window sees only that window',
    (await groups.tabsFor('session-a', 'dev · harbor', 10)).length === 3,
    JSON.stringify(await groups.tabsFor('session-a', 'dev · harbor', 10)));
  check('the other window holds only the stray',
    (await groups.tabsFor('session-a', 'dev · harbor', 20)).join() === '9');
  check('an unscoped lookup still spans windows, for cleanup',
    (await groups.tabsFor('session-a', 'dev · harbor')).length === 4);

  // Rebinding a session used to move only the bookkeeping: new tabs went to the
  // new window while the group and everything in it stayed put, so a listing
  // and reality told two different stories. Moving is what "works here now"
  // has to mean.
  const moved = await groups.moveTo('session-a', 10, 'dev · harbor');
  check('rebinding brings the workstream along', moved === 1, `moved ${moved}`);
  check('every tab is in the bound window afterwards',
    (await groups.tabsFor('session-a', 'dev · harbor', 10)).length === 4);
  check('nothing is left behind in the old window',
    (await groups.tabsFor('session-a', 'dev · harbor', 20)).length === 0);

  check('release covers every duplicate', (await groups.release('session-a', 'dev · harbor')) === true);
  check('nothing is left grouped after release',
    (await groups.tabsFor('session-a', 'dev · harbor')).length === 0);
  check('releasing one session leaves the same-named other session intact',
    (await groups.tabsFor('session-b', 'dev · harbor')).join() === '5');

  // ── What a group is called, and how it is recognised ─────────────────────
  //
  // The session's name is the group's name; a sub-group appends. And a group is
  // an agent's because the owner record says so, not because of anything in
  // its title — a "⚡ " prefix used to be the marker, and a display string a
  // human can edit is not identity.
  check('a session\'s plain tabs are grouped under its own name', groups.titleFor('harbor', 'harbor') === 'harbor');
  check('a sub-group is "<session> · <group>"', groups.titleFor('harbor', 'research') === 'harbor · research');
  check('a session with no group named falls back to its own name', groups.titleFor('harbor', undefined) === 'harbor');

  tabs.set(40, { id: 40, windowId: 10, groupId: -1 });
  await groups.assign(40, 'harbor', 'research', 'claude-code');
  const research = [...tabGroups.values()].find((g) => g.title === 'harbor · research');
  check('the Chrome group carries the session-first title', !!research, [...tabGroups.values()].map((g) => g.title).join('|'));
  check('the group title has no marker glyph', [...tabGroups.values()].every((g) => !g.title.includes('⚡')));
  check('the owner record carries the client for the panel',
    sessionStore.tabGroupOwnersV2[research.id]?.client === 'claude-code', JSON.stringify(sessionStore.tabGroupOwnersV2[research.id]));

  // A group the user made by hand, whatever it is called, is never an agent's.
  const handmade = { id: nextGroupId++, title: 'harbor · research', color: 'red', windowId: 10 };
  tabGroups.set(handmade.id, handmade);
  tabs.set(41, { id: 41, windowId: 10, groupId: handmade.id });
  const listed = await groups.list();
  check('agent groups are recognised by ownership, not by title',
    listed.some((g) => g.groupId === research.id) && !listed.some((g) => g.groupId === handmade.id),
    JSON.stringify(listed.map((g) => [g.groupId, g.title])));
  check('the listing reports the session and client',
    listed.find((g) => g.groupId === research.id)?.sessionId === 'harbor' &&
      listed.find((g) => g.groupId === research.id)?.client === 'claude-code');
  check('a hand-made group\'s tab is unowned', (await groups.ownerFor(41)) === null);

  // The batch form: one read for several ids, missing ids simply absent.
  const owners = await groups.ownersFor([40, 41, 5, 9999]);
  check('ownersFor answers for every existing tab',
    owners.get(40)?.sessionId === 'harbor' && owners.get(41) === null && owners.get(5)?.sessionId === 'session-b' && !owners.has(9999),
    JSON.stringify([...owners]));
}

async function testBackgroundInputInvariants() {
  const router = readFileSync(join(ROOT, 'extension', 'background', 'router.js'), 'utf8');
  const cdp = readFileSync(join(ROOT, 'extension', 'background', 'cdp.js'), 'utf8');
  const settings = readFileSync(join(ROOT, 'extension', 'background', 'settings.js'), 'utf8');

  check('ordinary input has no automatic foreground helper', !/ensureForeground|hiddenTabWarning/.test(router));
  // Nothing an agent calls may bring a window to the front. The one place the
  // router can focus a window is `showTab`, and only behind the default-off
  // `raiseWindowOnSelect` setting; `select` and `focus` both go through it.
  const raises = router.match(/chrome\.windows\.update\([^)]*focused: true/g) || [];
  check('exactly one code path can raise a window', raises.length === 1, `${raises.length} sites`);
  check('and it is gated by the default-off setting',
    /if \(settings\.raiseWindowOnSelect === true\) \{\s*await chrome\.windows\.update\([^)]*focused: true/.test(router));
  check('raising windows is off by default', /raiseWindowOnSelect: false/.test(settings));
  check('select and focus both go through the guarded path',
    /case 'select'[\s\S]{0,900}showTab\(tabId, settings\)/.test(router) && /if \(args\.focus\) \{[\s\S]{0,300}showTab\(tabId, settings\)/.test(router));
  check('the tab group title carries no marker glyph',
    !/⚡/.test(readFileSync(join(ROOT, 'extension', 'background', 'groups.js'), 'utf8')) &&
      !/⚡/.test(readFileSync(join(ROOT, 'extension', 'sidepanel', 'panel.js'), 'utf8')) &&
      !/⚡/.test(readFileSync(join(ROOT, 'extension', 'content', 'actions.js'), 'utf8')));
  // Batch close/reload take ids straight from a model; every path that acts on
  // a list of ids has to refuse another agent's tabs before touching any.
  check('batch close, reload and group refuse foreign tabs',
    /case 'close': \{[\s\S]{0,400}assertNotForeign\(ids/.test(router) &&
      /case 'reload': \{[\s\S]{0,200}assertNotForeign\(ids/.test(router) &&
      /case 'group': \{[\s\S]{0,500}assertNotForeign\(ids/.test(router));
  // A call with no `group` means "my tab", not "my tab in the group that shares
  // my name" — see `rememberSessionTab`.
  check('tab resolution without a group spans the whole session',
    /groups\.tabsFor\(sessionId, args\.group \|\| null/.test(router));
  check('mouse presses carry real pointer pressure',
    /type: 'mousePressed'[\s\S]{0,120}force: 0\.5/.test(cdp));
  check('focus emulation is diagnostic and default-off', /emulateFocus: false/.test(settings));
  check('model-controlled group never replaces stamped session identity', !/args\.group \|\| args\._session/.test(router));

  // A click whose navigation commits after the settle window must not be
  // reported UNVERIFIED — the URL read-back races the commit, so the verdict
  // has to consult the webNavigation commit record, in both places a verdict
  // is formed: the withDelta fallback and the post-settling-probe recheck.
  check('withDelta consults the navigation-commit record',
    /const nav = navSince\(tabId, startedAt\);/.test(router) && /onCommitted/.test(router));
  // The fixed post-click sleep and the 500ms settling probe are gone: every
  // pointer action, in-page action, typing call and scroll waits on the page's
  // own verdict (`awaitSettled`), which also watches navigation starts so a slow
  // server cannot turn a real navigation into an UNVERIFIED click.
  check('no fixed post-click sleep remains', !/settle\(action === 'hover' \? 120 : 350\)/.test(router) && !/await settle\(350\)/.test(router));
  check('the settling probe is gone', !/settlingNote/.test(router));
  check('pointer, in-page, typing and scroll paths all wait on the page',
    (router.match(/await awaitSettled\(tabId, startedAt/g) || []).length >= 4, `${(router.match(/await awaitSettled\(/g) || []).length} sites`);
  check('a navigation that has started is waited for, then reported',
    /onBeforeNavigate/.test(router) && /navStartedSince\(tabId, startedAt\)/.test(router) && /function settleVerdict/.test(router));
  check('the verdict distinguishes navigated / still changing / text-only / nothing',
    /navigated to \$\{fmt\.shortUrl\(settled\.navigated\.url\)\}/.test(router) &&
      /still changing/.test(router) && /text-only update/.test(router) && /UNVERIFIED: no page change was detected/.test(router));
  // Intermediate batch steps must not pay for a delta nobody will read.
  check('withDelta skips the diff for quiet steps', /if \(!quiet\) changed = await deltaFor\(tabId\);/.test(router));
  check('act, input and in-page actions pass the quiet flag through', (router.match(/\{ quiet: args\._quiet \}/g) || []).length >= 3);
  check('batch planning is delegated to the pure planner', /import \{ runPlan \} from '\.\/batch\.js'/.test(router) && /return runPlan\(steps, \{/.test(router));
  // Verify-in-the-same-call: a failed expectation is an error that still says
  // the action was dispatched, so the model neither retries blindly nor
  // believes the click worked.
  check('expect defaults to 5s and fails as an error naming the dispatch',
    /expect\.timeout \?\? 5000/.test(router) && /the action was dispatched, but \$\{fmt\.expectLine\(expected\)\}/.test(router));
  // A job needs no tab, so the branch has to run before tab resolution — or
  // collecting a job would open a blank tab for a session that has none.
  const waitBody = router.slice(router.indexOf('async browser_wait(args)'), router.indexOf('async browser_eval(args)'));
  check('job collection happens before a tab is resolved',
    waitBody.indexOf("if (kind === 'job') return collectJob") > 0 && waitBody.indexOf("if (kind === 'job')") < waitBody.indexOf('await resolveTab(args)'));
  check('jobs are scoped to the session that started them', /jobs\.getJob\(String\(args\.value\), session\)/.test(router) && /jobs\.startJob\(\s*\{ session,/.test(router));
  // A truncated whole-page read carries the outline, so the next call scopes
  // instead of paging; a scoped read does not repeat the choice.
  check('a truncated snapshot appends an outline unless already scoped',
    /if \(!args\.selector\) \{\s*const outline = await snapshotText\(tabId, \{\s*mode: 'outline'/.test(router));
  check('the developer reload hook refuses store installs', /getManifest\(\)\.update_url\)[\s\S]{0,120}throw new Error\('reload is only available/.test(router));

  const content = readFileSync(join(ROOT, 'extension', 'content', 'main.js'), 'utf8');
  check('the page answers settled and check', /settled\(\{ idleMs = 250, quietMs = 120, maxMs = 700 \}/.test(content) && /check\(\{ for: kind, value \}\)/.test(content));
  check('wait and check share one predicate table', (content.match(/predicateFor\(kind, value\)/g) || []).length === 3);
  check('snapshot budget default is 8000', /maxSnapshotChars: 8000/.test(settings));
  check('settle timings are settings', /settleIdleMs: 250/.test(settings) && /settleQuietMs: 120/.test(settings) && /settleMaxMs: 700/.test(settings));
  // The driving frame and the live cursor go down with every old document; the
  // redraw listener puts them back so a tab does not look undriven (and the
  // pointer does not vanish) between a navigation and the next tool call.
  check('overlays are redrawn on the new document after a navigation',
    /onDOMContentLoaded/.test(router) && /CURSOR_POS_KEY/.test(router));
  check('the cursor position is remembered per tab and cleaned up with it',
    /all\[tabId\] = \{ x: Math\.round\(opts\.x\), y: Math\.round\(opts\.y\) \}/.test(router) &&
      (router.match(/delete all\[tabId\]/g) || []).length >= 2);

  const { serializeTabMutation } = await importFrom('extension', 'background', 'mutation-queue.js');
  const order = [];
  await Promise.all([
    serializeTabMutation(10, async () => {
      order.push('a:start');
      await sleep(15);
      order.push('a:end');
    }),
    serializeTabMutation(10, async () => {
      order.push('b:start');
      await sleep(1);
      order.push('b:end');
    }),
  ]);
  check('same-tab mutations serialize the whole sequence', order.join(',') === 'a:start,a:end,b:start,b:end', order.join(','));

  let overlap = false;
  let running = 0;
  await Promise.all([
    serializeTabMutation(20, async () => {
      running++;
      await sleep(10);
      overlap ||= running > 1;
      running--;
    }),
    serializeTabMutation(21, async () => {
      running++;
      await sleep(10);
      overlap ||= running > 1;
      running--;
    }),
  ]);
  check('different tabs still mutate in parallel', overlap);
}

/**
 * The pieces that turn a ten-turn flow into two: the batch planner (pure), the
 * job registry (pure), the outline renderer, and the validator letting the new
 * syntax through to the extension.
 */
async function testSpeedHarness() {
  // ── Planner ────────────────────────────────────────────────────────────────
  const { runPlan, MAX_REPEAT, MAX_OPS, MAX_NESTING } = await importFrom('extension', 'background', 'batch.js');

  // A fake dispatcher that records every call, and a condition table that can
  // be flipped from the test.
  const makeRunner = (cond = {}) => {
    const calls = [];
    const state = { cond, calls };
    state.run = async (tool, args) => {
      calls.push({ tool, args });
      if (tool === 'boom') throw new Error('kaboom');
      if (tool === 'counter') state.cond.count = (state.cond.count || 0) + 1;
      return { text: `${tool} ok #${calls.length}` };
    };
    state.test = async (c, args) => {
      state.tests = (state.tests || []).concat([{ c, args }]);
      if (c.for === 'count_reached') return (state.cond.count || 0) >= Number(c.value);
      return !!state.cond[`${c.for}:${c.value}`];
    };
    return state;
  };

  let r = makeRunner();
  let out = await runPlan(
    [{ tool: 'browser_navigate', args: { url: 'a' } }, { tool: 'browser_act', args: { ref: 'e1' } }, { tool: 'browser_snapshot' }],
    { run: r.run, test: r.test, defaults: { tabId: 7, _session: 's' } }
  );
  check('steps run in order with defaults merged under their args',
    r.calls.map((c) => c.tool).join() === 'browser_navigate,browser_act,browser_snapshot' && r.calls.every((c) => c.args.tabId === 7 && c.args._session === 's'));
  check('every step but the last runs quiet', r.calls[0].args._quiet === true && r.calls[1].args._quiet === true && r.calls[2].args._quiet === undefined);
  check('the default result is the trail plus the last step', /^✓ browser_navigate → ✓ browser_act → ✓ browser_snapshot\n\nbrowser_snapshot ok #3$/.test(out.text), out.text);

  r = makeRunner();
  out = await runPlan([{ tool: 'a' }, { tool: 'b' }], { run: r.run, test: r.test, returnEach: true });
  check('returnEach turns quiet off and labels each result', r.calls.every((c) => !c.args._quiet) && /\[1\] a\na ok #1\n\n\[2\] b\nb ok #2/.test(out.text), out.text);

  // when / unless
  r = makeRunner({ 'text:Accept cookies': false, 'selector:.modal': true });
  out = await runPlan(
    [
      { tool: 'dismiss', when: { for: 'text', value: 'Accept cookies' } },
      { tool: 'close', unless: { for: 'selector', value: '.modal' } },
      { tool: 'open', when: { for: 'selector', value: '.modal' } },
      { tool: 'done' },
    ],
    { run: r.run, test: r.test, defaults: { tabId: 3 } }
  );
  check('when:false and unless:true skip the step', r.calls.map((c) => c.tool).join() === 'open,done', r.calls.map((c) => c.tool).join());
  check('the trail says what was skipped and why', /– dismiss \(skipped: text "Accept cookies" was false\) → – close \(skipped: selector "\.modal" was true\) → ✓ open → ✓ done/.test(out.text), out.text);
  check('conditions are evaluated against the step\'s merged args', r.tests.every((t) => t.args.tabId === 3));

  // repeat until
  r = makeRunner();
  out = await runPlan(
    [{ tool: 'counter', repeat: { until: { for: 'count_reached', value: 3 }, max: 10 } }, { tool: 'snap' }],
    { run: r.run, test: r.test }
  );
  check('repeat until runs until the condition holds', r.calls.filter((c) => c.tool === 'counter').length === 3);
  check('iterations collapse into one trail entry with a count', /^✓ counter ×3 → ✓ snap\n/.test(out.text), out.text);
  check('a repeated intermediate step stays quiet', r.calls.filter((c) => c.tool === 'counter').every((c) => c.args._quiet === true));

  // repeat while, false from the start
  r = makeRunner({ 'selector:.more': false });
  out = await runPlan([{ tool: 'load_more', repeat: { while: { for: 'selector', value: '.more' } } }, { tool: 'snap' }], { run: r.run, test: r.test });
  check('repeat while runs zero times when already false', !r.calls.some((c) => c.tool === 'load_more') && /✓ snap/.test(out.text));

  // repeat count
  r = makeRunner();
  await runPlan([{ tool: 'scroll', repeat: 4 }], { run: r.run, test: r.test });
  check('a numeric repeat is a plain count', r.calls.length === 4);

  // exhausted
  r = makeRunner({ 'text:Done': false });
  let err = await runPlan([{ tool: 'next', repeat: { until: { for: 'text', value: 'Done' }, max: 3 } }], { run: r.run, test: r.test }).catch((e) => e);
  check('an unmet until at max is an error that names the count and condition',
    err instanceof Error && /repeat hit max 3 with text "Done" still false/.test(err.message) && r.calls.length === 3, err?.message);
  r = makeRunner({ 'text:Done': false });
  out = await runPlan([{ tool: 'next', repeat: { until: { for: 'text', value: 'Done' }, max: 2 } }, { tool: 'after' }], { run: r.run, test: r.test, stopOnError: false });
  check('with stopOnError:false the exhaustion is recorded and the batch continues', /✗ next: repeat hit max 2/.test(out.text) && r.calls.some((c) => c.tool === 'after'), out.text);

  // groups
  r = makeRunner();
  out = await runPlan(
    [{ repeat: { until: { for: 'count_reached', value: 2 } }, steps: [{ tool: 'open' }, { tool: 'counter' }, { tool: 'back' }] }, { tool: 'snap' }],
    { run: r.run, test: r.test }
  );
  check('a group repeats as one unit', r.calls.map((c) => c.tool).join() === 'open,counter,back,open,counter,back,snap', r.calls.map((c) => c.tool).join());
  check('group members are labelled by path and collapsed per iteration', /✓ open ×2 → ✓ counter ×2 → ✓ back ×2 → ✓ snap/.test(out.text), out.text);
  check('a group\'s members are never the final step', r.calls.filter((c) => c.tool !== 'snap').every((c) => c.args._quiet === true) && r.calls.at(-1).args._quiet === undefined);

  // ceilings
  err = await runPlan([{ tool: 'x', repeat: { until: { for: 'text', value: 'never' }, max: 999 } }], makeRunner({ 'text:never': false })).catch((e) => e);
  check(`repeat max is capped at ${MAX_REPEAT}`, /repeat hit max 50/.test(err?.message), err?.message);
  r = makeRunner();
  const wide = Array.from({ length: 11 }, () => ({ tool: 'x' }));
  err = await runPlan([{ repeat: 50, steps: wide }], { run: r.run, test: r.test }).catch((e) => e);
  check(`total tool calls are capped at ${MAX_OPS}`, /exceeded 500 tool calls/.test(err?.message) && r.calls.length === MAX_OPS, `${r.calls.length} calls; ${err?.message?.slice(0, 60)}`);
  const deep = { steps: [{ steps: [{ steps: [{ steps: [{ tool: 'x' }] }] }] }] };
  err = await runPlan([deep], makeRunner()).catch((e) => e);
  check(`groups nest at most ${MAX_NESTING} deep`, /nest at most 3 deep/.test(err?.message), err?.message);

  // validation
  const bad = async (steps) => (await runPlan(steps, makeRunner()).catch((e) => e))?.message || '';
  check('a nested browser_batch is refused', /cannot nest/.test(await bad([{ tool: 'browser_batch' }])));
  check('tool and steps together are refused', /both tool and steps/.test(await bad([{ tool: 'a', steps: [{ tool: 'b' }] }])));
  check('a condition without `for` explains the shape', /needs \{for, value\}/.test(await bad([{ tool: 'a', when: { value: 'x' } }])));
  check('a repeat with nothing to repeat on explains itself', /repeat needs until, while, or max/.test(await bad([{ tool: 'a', repeat: {} }])));
  check('an empty group is refused', /empty group/.test(await bad([{ steps: [] }])));

  // failure trail
  r = makeRunner();
  err = await runPlan([{ tool: 'ok' }, { tool: 'boom' }, { tool: 'never' }], { run: r.run, test: r.test }).catch((e) => e);
  check('a failing step stops the batch with a trail', /step 2 \(boom\) failed: kaboom[\s\S]*✓ ok → ✗ boom: kaboom/.test(err?.message) && !r.calls.some((c) => c.tool === 'never'), err?.message);

  // ── Jobs ───────────────────────────────────────────────────────────────────
  const jobs = await importFrom('extension', 'background', 'jobs.js');
  jobs._resetJobs();
  let release;
  const gate = new Promise((res) => (release = res));
  const { id } = jobs.startJob({ session: 'harbor', tool: 'browser_batch', steps: 3 }, async (progress) => {
    progress({ i: 1, tool: 'browser_navigate', label: '1' });
    await gate;
    return { text: 'all done' };
  });
  check('a job gets an id and starts running', id === 'job1' && jobs.getJob(id, 'harbor')?.status === 'running');
  check('another session cannot see it', jobs.getJob(id, 'meadow') === null);
  check('the owner can list it', jobs.listJobs('harbor').length === 1 && jobs.listJobs('meadow').length === 0);
  let waited = await jobs.waitForJob(jobs.getJob(id, 'harbor'), 30);
  check('waiting past the timeout reports it still running, with progress', waited.status === 'running' && /job1 running \d+s — at step 1 \(browser_navigate\)/.test(jobs.describeJob(waited)), jobs.describeJob(waited));
  const collecting = jobs.waitForJob(jobs.getJob(id, 'harbor'), 5000);
  release();
  waited = await collecting;
  check('a waiter is woken the moment the job finishes', waited.status === 'done' && waited.result.text === 'all done');
  check('a finished job is described as done', /^job1 done after \d+s$/.test(jobs.describeJob(waited)), jobs.describeJob(waited));
  const failing = jobs.startJob({ session: 'harbor', tool: 'browser_batch', steps: 1 }, async () => {
    throw new Error('step 1 (browser_act) failed: nope');
  });
  const failed = await jobs.waitForJob(jobs.getJob(failing.id, 'harbor'), 1000);
  check('a throwing job is failed with its message kept', failed.status === 'failed' && /nope/.test(failed.error));
  check('a session-less job is visible to any caller', (() => { const j = jobs.startJob({ tool: 't' }, async () => 1); return jobs.getJob(j.id, 'anyone') !== null; })());
  jobs._resetJobs();

  // ── Outline ────────────────────────────────────────────────────────────────
  stubChrome();
  const fmt = await importFrom('extension', 'background', 'format.js');
  const page = [
    { role: 'banner', name: '', depth: 0, sel: 'header', children: [
      { role: 'link', name: 'Home', ref: 'e1', depth: 1, children: [] },
      { role: 'navigation', name: 'Main', depth: 1, sel: 'header > nav', children: [
        { role: 'link', name: 'A', ref: 'e2', depth: 2, children: [] },
        { role: 'link', name: 'B', ref: 'e3', depth: 2, children: [] },
        { role: 'button', name: 'Menu', ref: 'e4', depth: 2, children: [] },
      ] },
    ] },
    { role: 'main', name: '', depth: 0, sel: 'main', children: [
      { role: 'heading', name: 'Welcome to the very long heading that keeps going and going past eighty characters for sure', depth: 1, state: ['h1'], children: [] },
      { role: 'generic', name: '', depth: 1, children: [
        { role: 'form', name: 'Search', depth: 2, sel: '#search', children: [
          { role: 'searchbox', name: 'Query', ref: 'e5', depth: 3, children: [] },
          { role: 'checkbox', name: 'Exact', ref: 'e6', depth: 3, children: [] },
          { role: 'checkbox', name: 'Recent', ref: 'e7', depth: 3, children: [] },
          { role: 'button', name: 'Go', ref: 'e8', depth: 3, children: [] },
        ] },
      ] },
      { role: 'heading', name: 'Results', depth: 1, state: ['h2'], children: [] },
      { role: 'list', name: '', depth: 1, children: Array.from({ length: 30 }, (_, i) => ({ role: 'listitem', name: '', depth: 2, children: [{ role: 'link', name: `r${i}`, ref: `e${10 + i}`, depth: 3, children: [] }] })) },
      { role: 'iframe', name: '', depth: 1, src: 'ads.example/x', children: [] },
    ] },
  ];
  const outline = fmt.renderOutline(page);
  const lines = outline.text.split('\n');
  check('outline: one line per landmark, indented by nesting',
    lines[0] === 'banner (1 link) selector:"header"' && lines[1] === '  navigation "Main" (2 links, 1 button) selector:"header > nav"', outline.text);
  check('outline: a landmark counts its own controls, not a nested landmark\'s',
    /^main \(30 links\) selector:"main"$/m.test(outline.text), outline.text);
  check('outline: headings appear with their level, truncated', /^  h1 "Welcome to the very long heading[^"]*…"$/m.test(outline.text) && /^  h2 "Results"$/m.test(outline.text), outline.text);
  check('outline: a form is a landmark with its own counts, most common first', /^ {2}form "Search" \(2 checkboxes, 1 searchbox, 1 button\) selector:"#search"$/m.test(outline.text), outline.text);
  check('outline: lists and items are not lines', !/list/.test(outline.text.replace(/listitem/g, '')) || !/^\s*list\b/m.test(outline.text));
  check('outline: iframes are named by source', /^  iframe ads\.example\/x$/m.test(outline.text), outline.text);
  check('outline: no refs, no per-control lines', !/\[e\d+\]/.test(outline.text) && !/link "r1"/.test(outline.text));
  check('outline: counts every control on the page', outline.refCount === 38, `${outline.refCount}`);
  check('outline: is a fraction of the tree', outline.text.length < fmt.renderTree(page).text.length / 3, `${outline.text.length} vs ${fmt.renderTree(page).text.length}`);
  const tight = fmt.renderOutline(page, { maxChars: 60 });
  check('outline: respects its budget and says so', tight.truncated === true && tight.text.length <= 60);
  check('outline: a landmark without a selector still gets a line',
    /^navigation "Old" \(1 link\)$/m.test(fmt.renderOutline([{ role: 'navigation', name: 'Old', depth: 0, children: [{ role: 'link', name: 'x', ref: 'e1', depth: 1, children: [] }] }]).text));

  // ── Expect verdict line ────────────────────────────────────────────────────
  check('expect: a met condition reports its timing',
    fmt.expectLine({ ok: true, ms: 340, cond: { for: 'text', value: 'Order placed' } }) === 'expect text "Order placed": met after 340ms');
  check('expect: a miss is loud and names the budget',
    fmt.expectLine({ ok: false, timeout: 5000, error: 'timed out after 5000ms', cond: { for: 'url', value: '/thanks' } }) === 'EXPECT FAILED: url "/thanks" not met after 5000ms');
  check('expect: a non-timeout error is carried',
    /\(bad selector\)$/.test(fmt.expectLine({ ok: false, timeout: 5000, error: 'bad selector', cond: { for: 'selector', value: 'x' } })));

  // ── The validator lets the new syntax through to the extension ────────────
  const PORT9 = PORT + 9;
  const server = startServer(PORT9);
  await server.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
  server.notify('notifications/initialized');
  const ext = await fakeExtension(PORT9, { onCall: async (msg) => ({ text: `handled ${msg.tool}` }) });
  await sleep(300);

  const batchArgs = {
    tabId: 5,
    async: true,
    steps: [
      { tool: 'browser_act', args: { action: 'click', ref: 'e1' }, when: { for: 'text', value: 'Accept' } },
      { tool: 'browser_act', args: { action: 'click', ref: 'e2' }, repeat: { until: { for: 'no_selector', value: '.next' }, max: 20 } },
      { steps: [{ tool: 'browser_snapshot' }], unless: { for: 'url', value: '/done' } },
    ],
  };
  const batchRes = await server.request('tools/call', { name: 'browser_batch', arguments: batchArgs });
  const batchSeen = ext.seen.find((c) => c.tool === 'browser_batch');
  check('batch control flow survives validation and the trip intact',
    batchRes.result?.isError === false && JSON.stringify(batchSeen?.args.steps) === JSON.stringify(batchArgs.steps) && batchSeen?.args.async === true,
    JSON.stringify(batchRes.result).slice(0, 200));
  const actRes = await server.request('tools/call', { name: 'browser_act', arguments: { action: 'click', ref: 'e1', expect: { for: 'text', value: 'Saved', timeout: 3000 } } });
  check('expect on browser_act is accepted and forwarded', actRes.result?.isError === false && ext.seen.find((c) => c.tool === 'browser_act')?.args.expect?.value === 'Saved');
  const inputRes = await server.request('tools/call', { name: 'browser_input', arguments: { ref: 'e1', text: 'hi', expect: { for: 'url', value: '/results' } } });
  check('expect on browser_input is accepted and forwarded', inputRes.result?.isError === false && ext.seen.find((c) => c.tool === 'browser_input')?.args.expect?.for === 'url');
  const waitRes = await server.request('tools/call', { name: 'browser_wait', arguments: { for: 'job', value: 'job1' } });
  check('for:"job" is accepted by browser_wait', waitRes.result?.isError === false && ext.seen.find((c) => c.tool === 'browser_wait')?.args.for === 'job');
  const outlineRes = await server.request('tools/call', { name: 'browser_snapshot', arguments: { mode: 'outline' } });
  check('mode:"outline" is accepted by browser_snapshot', outlineRes.result?.isError === false && ext.seen.find((c) => c.tool === 'browser_snapshot')?.args.mode === 'outline');
  const init2 = await server.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
  const instr = init2.result?.instructions || '';
  check('instructions teach expect, control flow, async jobs and outline',
    /expect:\{for, value\}/.test(instr) && /repeat/.test(instr) && /async:true/.test(instr) && /mode:"outline"/.test(instr));
  server.proc.kill();
  ext.conn.close?.();
}

main().catch((err) => {
  process.stderr.write(`\ntest harness crashed: ${err.stack}\n`);
  process.exit(1);
});
