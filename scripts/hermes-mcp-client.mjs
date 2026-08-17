#!/usr/bin/env node
/**
 * Minimal MCP stdio client for the OpenBrowser mcp-server.
 * File-based command channel (works where process stdin is unavailable):
 *   - watches CMDS file for appended JSON lines: {"tool": "...", "args": {...}, "label": "..."}
 *   - appends each result to OUT file as:
 *       ===RESULT <label>===\n<text>\n===END===
 *   - command "QUIT" (bare line) exits cleanly.
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

const SERVER = '/Users/dylan/openbrowser/mcp-server/src/index.js';
const CMDS = '/tmp/ob_cmds.jsonl';
const OUT = '/tmp/ob_out.txt';

if (!existsSync(CMDS)) writeFileSync(CMDS, '');
writeFileSync(OUT, '');

const server = spawn('node', [SERVER], { stdio: ['pipe', 'pipe', 'inherit'] });

let nextId = 1;
const pending = new Map();
let processed = 0;

const serverLines = createInterface({ input: server.stdout, crlfDelay: Infinity });
serverLines.on('line', (line) => {
  const text = line.trim();
  if (!text) return;
  let msg;
  try { msg = JSON.parse(text); } catch { return; }
  if (msg.id && pending.has(msg.id)) {
    const { resolve, label } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) { resolve(`ERROR: ${msg.error.message}`); return; }
    const content = msg.result?.content ?? [];
    const parts = content.map((c) => (c.type === 'text' ? c.text : `[image ${c.mimeType}]`));
    resolve(`===RESULT ${label}===\n${parts.join('\n')}\n===END===`);
  }
});

server.on('exit', (code) => {
  appendFileSync(OUT, `[client] server exited: ${code}\n`);
  process.exit(code ?? 1);
});

function rpc(method, params, label) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, label: label ?? method });
    server.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); reject(new Error(`timeout waiting for ${method}`)); }
    }, 180000);
  });
}

async function init() {
  await rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'hermes-desktop', version: '1.0' },
  }, 'initialize');
  server.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  appendFileSync(OUT, 'READY\n');
}

function drain() {
  const raw = readFileSync(CMDS, 'utf8');
  const lines = raw.split('\n');
  if (lines.length - 1 <= processed) return;
  const batch = lines.slice(processed, lines.length - 1); // last element is trailing ''
  processed = lines.length - 1;
  for (const line of batch) {
    const text = line.trim();
    if (!text) continue;
    if (text === 'QUIT') { server.kill(); process.exit(0); }
    let cmd;
    try { cmd = JSON.parse(text); } catch {
      appendFileSync(OUT, '===RESULT parse-error===\nbad JSON\n===END===\n');
      continue;
    }
    rpc('tools/call', { name: cmd.tool, arguments: cmd.args ?? {} }, cmd.label ?? cmd.tool)
      .then((out) => { appendFileSync(OUT, out + '\n'); })
      .catch((err) => { appendFileSync(OUT, `===RESULT ${cmd.label ?? cmd.tool}===\nCLIENT ERROR: ${err.message}\n===END===\n`); });
  }
}

init().then(() => setInterval(drain, 250)).catch((err) => {
  appendFileSync(OUT, `[client] init failed: ${err.message}\n`);
  process.exit(1);
});
