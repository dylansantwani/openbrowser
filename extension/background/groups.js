/**
 * Tab grouping — making agent activity visible.
 *
 * When an agent is driving several tabs at once, a plain tab strip tells you
 * nothing: you cannot see which tabs it opened, which task each belongs to, or
 * which ones are safe to close. Chrome's tab groups solve exactly that, and
 * they cost nothing to maintain.
 *
 * Tabs are grouped by *workstream* rather than all lumped together, so three
 * parallel jobs read as three labelled, colour-coded groups. The name is the
 * agent's own choice of label, which means the tab strip ends up describing
 * the work in the agent's words.
 */

/** Group title prefix, so agent groups are distinguishable at a glance. */
const PREFIX = '⚡ ';

/**
 * Colours cycle per workstream. Chrome offers eight; these are ordered to stay
 * distinguishable from each other and from the greys of ungrouped tabs.
 */
const COLORS = ['blue', 'purple', 'cyan', 'green', 'orange', 'pink', 'yellow', 'red'];

/** workstream name -> {groupId, windowId, color} */
const groups = new Map();
let colorCursor = 0;

/** Chrome's sentinel for "not in a group". */
const NO_GROUP = chrome.tabGroups?.TAB_GROUP_ID_NONE ?? -1;

export function isSupported() {
  return typeof chrome.tabGroups !== 'undefined' && typeof chrome.tabs.group === 'function';
}

/**
 * Find a workstream's Chrome group, whether or not this service worker knows
 * about it.
 *
 * The `groups` map above is service-worker memory, and MV3 discards that every
 * ~30s idle — while the tab group itself survives. Trusting the map alone meant
 * a restarted worker believed a workstream had no group and created a *second*
 * one with the same title, splitting the workstream in two. Chrome is the
 * durable record; the map is only a cache in front of it.
 *
 * The title is compared here rather than passed to `query({title})`, whose
 * matching is a glob — a workstream called "checkout *" would collect its
 * neighbours.
 */
async function findGroup(name) {
  const wanted = PREFIX + name;
  const all = await chrome.tabGroups.query({});
  return all.find((g) => g.title === wanted) || null;
}

/**
 * Put a tab into the named workstream group, creating the group if needed.
 *
 * Failures here are always swallowed by the caller: grouping is presentation.
 * A tab that could not be grouped still works perfectly, and breaking a
 * navigation because a cosmetic API misbehaved would be a bad trade.
 *
 * @param {number} tabId
 * @param {string} name workstream label, e.g. "checkout flow"
 */
export async function assign(tabId, name = 'agent') {
  if (!isSupported()) return null;

  const tab = await chrome.tabs.get(tabId);

  // Fall back to Chrome when the in-memory cache is cold, or a restarted
  // service worker would create a duplicate group with the same title.
  let existing = groups.get(name);
  if (!existing) {
    const found = await findGroup(name).catch(() => null);
    if (found) existing = { groupId: found.id, windowId: found.windowId, color: found.color };
  }

  // Reuse the group only if it still exists and is in the same window —
  // chrome.tabs.group cannot move a tab across windows into a group.
  if (existing && existing.windowId === tab.windowId) {
    try {
      await chrome.tabGroups.get(existing.groupId);
      await chrome.tabs.group({ tabIds: [tabId], groupId: existing.groupId });
      groups.set(name, existing);
      return existing.groupId;
    } catch {
      groups.delete(name); // group was closed by the user; fall through
    }
  }

  const groupId = await chrome.tabs.group({ tabIds: [tabId] });
  const color = COLORS[colorCursor++ % COLORS.length];

  await chrome.tabGroups.update(groupId, {
    title: PREFIX + name,
    color,
    // Left expanded: a collapsed group hides exactly the thing this feature
    // exists to show.
    collapsed: false,
  });

  groups.set(name, { groupId, windowId: tab.windowId, color });
  return groupId;
}

/** Group several tabs into one workstream in a single call. */
export async function assignMany(tabIds, name) {
  const ids = [];
  for (const tabId of tabIds) {
    try {
      await assign(tabId, name);
      ids.push(tabId);
    } catch {
      /* cosmetic; keep going */
    }
  }
  return ids;
}

/**
 * Rename a workstream, e.g. to reflect progress ("checkout → order placed").
 * Cheap way for a long run to narrate itself in the tab strip.
 */
export async function rename(name, title) {
  try {
    const entry = groups.get(name) || (await findGroup(name).then((g) => g && { groupId: g.id }));
    if (!entry) return false;
    await chrome.tabGroups.update(entry.groupId, { title: PREFIX + title });
    groups.delete(name);
    return true;
  } catch {
    return false;
  }
}

/** Ungroup a workstream's tabs, leaving the tabs themselves open. */
export async function release(name) {
  groups.delete(name);
  try {
    const group = await findGroup(name);
    if (!group) return false;
    const tabs = await chrome.tabs.query({ groupId: group.id });
    if (tabs.length) await chrome.tabs.ungroup(tabs.map((t) => t.id));
    return true;
  } catch {
    return false;
  }
}

/** Close every tab in a workstream. Used to clean up after a finished job. */
export async function closeWorkstream(name) {
  groups.delete(name);
  try {
    const group = await findGroup(name);
    if (!group) return 0;
    const tabs = await chrome.tabs.query({ groupId: group.id });
    if (!tabs.length) return 0;
    await chrome.tabs.remove(tabs.map((t) => t.id));
    return tabs.length;
  } catch {
    return 0;
  }
}

/** Current workstreams and their tabs, for browser_tabs list and the panel. */
export async function list() {
  if (!isSupported()) return [];

  // Read from Chrome, not from the `groups` cache: after an MV3 restart the
  // cache is empty while the groups are still on screen, and a listing that
  // silently omits them tells an agent its own tabs do not exist.
  try {
    const out = [];
    for (const group of await chrome.tabGroups.query({})) {
      if (!group.title?.startsWith(PREFIX)) continue; // someone else's group
      const tabs = await chrome.tabs.query({ groupId: group.id });
      out.push({
        name: group.title.slice(PREFIX.length),
        title: group.title,
        color: group.color,
        groupId: group.id,
        tabIds: tabs.map((t) => t.id),
      });
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * A workstream's tabs, most recently accessed first.
 *
 * Queried from Chrome rather than read out of the `groups` map above, because
 * that map is service-worker memory and does not survive an MV3 restart — while
 * the tab group itself does. The group title is the durable record of which
 * tabs belong to whom, so it is the thing to ask.
 */
export async function tabsFor(name) {
  if (!isSupported() || !name) return [];
  try {
    const group = await findGroup(name);
    if (!group) return [];

    const tabs = await chrome.tabs.query({ groupId: group.id });
    return tabs
      .sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))
      .map((t) => t.id);
  } catch {
    return [];
  }
}

/**
 * Which workstream owns a tab, if any.
 *
 * Read from Chrome for the same reason as everything else here: the in-memory
 * map is gone after an MV3 restart, and a wrong "nobody owns this" is exactly
 * the answer that lets one session take over another's tab.
 */
export async function workstreamFor(tabId) {
  if (!isSupported()) return null;
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.groupId == null || tab.groupId === NO_GROUP) return null;
    const group = await chrome.tabGroups.get(tab.groupId);
    return group.title?.startsWith(PREFIX) ? group.title.slice(PREFIX.length) : null;
  } catch {
    return null;
  }
}

// A group the user closed or emptied should not linger in our map.
chrome.tabGroups?.onRemoved?.addListener((group) => {
  for (const [name, entry] of groups) {
    if (entry.groupId === group.id) groups.delete(name);
  }
});
