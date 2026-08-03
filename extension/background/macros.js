/**
 * Saved step sequences.
 *
 * A macro is the cheapest thing in this codebase. Logging into a site might
 * take an agent eight tool calls and several thousand tokens of snapshot to
 * work out the first time; replaying it afterwards is one call. Placeholders
 * keep the reusable shape while letting the values change.
 */

const KEY = 'macros';

async function load() {
  const stored = await chrome.storage.local.get(KEY);
  return stored[KEY] || {};
}

export async function list() {
  const all = await load();
  return Object.entries(all)
    .map(([name, macro]) => ({ name, ...macro }))
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

export async function get(name) {
  if (!name) return null;
  const all = await load();
  const macro = all[name];
  return macro ? { name, ...macro } : null;
}

export async function save(name, { description, steps }) {
  const all = await load();
  all[name] = {
    description: description || all[name]?.description || '',
    steps,
    updatedAt: Date.now(),
  };
  await chrome.storage.local.set({ [KEY]: all });
  return all[name];
}

export async function remove(name) {
  const all = await load();
  if (!(name in all)) throw new Error(`no macro named "${name}"`);
  delete all[name];
  await chrome.storage.local.set({ [KEY]: all });
}

/**
 * Replace `{{placeholders}}` throughout a step tree.
 *
 * Substitution walks the whole structure rather than string-replacing the
 * serialised JSON, so a value containing quotes or braces cannot corrupt the
 * surrounding structure.
 *
 * A placeholder that stands alone in a string is replaced by the raw value,
 * preserving its type — `{{count}}` with `count: 3` yields the number 3, not
 * the string "3". Placeholders embedded in longer text interpolate as strings.
 */
export function substitute(steps, vars) {
  const missing = new Set();

  const walk = (value) => {
    if (typeof value === 'string') {
      const solo = /^\{\{\s*([\w.]+)\s*\}\}$/.exec(value);
      if (solo) {
        if (!(solo[1] in vars)) {
          missing.add(solo[1]);
          return value;
        }
        return vars[solo[1]];
      }
      return value.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (match, key) => {
        if (!(key in vars)) {
          missing.add(key);
          return match;
        }
        return String(vars[key]);
      });
    }
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v)]));
    }
    return value;
  };

  const result = walk(steps);

  if (missing.size) {
    throw new Error(
      `macro needs these vars: ${[...missing].join(', ')}. Pass them in \`vars\`, e.g. vars:{${[...missing][0]}:"…"}.`
    );
  }
  return result;
}
