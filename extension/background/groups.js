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

/** session/workstream scope -> {groupId, windowId, color} */
const groups = new Map();
let colorCursor = 0;

/** Durable groupId -> {sessionId, workstream} ownership metadata. */
const OWNERS_KEY = 'tabGroupOwnersV2';
let ownersQueue = Promise.resolve();

const scopeKey = (sessionId, workstream) => JSON.stringify([sessionId || null, workstream || sessionId || 'agent']);
const displayName = (sessionId, workstream) => workstream || sessionId || 'agent';

async function readOwners() {
  try {
    return (await chrome.storage.session.get(OWNERS_KEY))[OWNERS_KEY] || {};
  } catch {
    return {};
  }
}

function mutateOwners(fn) {
  const run = ownersQueue.then(async () => {
    const owners = await readOwners();
    const result = fn(owners);
    await chrome.storage.session.set({ [OWNERS_KEY]: owners });
    return result;
  });
  ownersQueue = run.then(() => {}, () => {});
  return run;
}

const rememberOwner = (groupId, sessionId, workstream) =>
  mutateOwners((owners) => {
    owners[groupId] = { sessionId: sessionId || null, workstream: displayName(sessionId, workstream) };
  });

const forgetOwner = (groupId) =>
  mutateOwners((owners) => {
    delete owners[groupId];
  });

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
async function findGroups(sessionId, workstream, windowId) {
  const owners = await readOwners();
  const all = await chrome.tabGroups.query({});
  return all.filter((g) => {
    const owner = owners[g.id];
    return (
      owner?.sessionId === (sessionId || null) &&
      owner?.workstream === displayName(sessionId, workstream) &&
      (windowId == null || g.windowId === windowId)
    );
  });
}

/**
 * @param {string} sessionId server-stamped authority boundary
 * @param {string} workstream model-chosen display label
 * @param {number} [preferWindowId] when a workstream somehow has more than one
 *   group, take the one in this window. Duplicates should no longer be created
 *   — see `assign` — but they can still exist from an older run or be made by
 *   hand, and picking arbitrarily is how a session ends up acting in a window
 *   it never chose.
 */
async function findGroup(sessionId, workstream, preferWindowId) {
  const found = await findGroups(sessionId, workstream);
  if (preferWindowId != null) {
    const here = found.find((g) => g.windowId === preferWindowId);
    if (here) return here;
  }
  return found[0] || null;
}

/**
 * Put a tab into the named workstream group, creating the group if needed.
 *
 * Failures here are always swallowed by the caller: grouping is presentation.
 * A tab that could not be grouped still works perfectly, and breaking a
 * navigation because a cosmetic API misbehaved would be a bad trade.
 *
 * @param {number} tabId
 * @param {string} sessionId server-stamped authority boundary
 * @param {string} workstream display label, e.g. "checkout flow"
 *
 * One `assign` at a time per workstream.
 *
 * `assign` looks for the group, finds nothing, and creates one — across two
 * awaits. Two tabs being grouped into the same workstream at once therefore
 * both look, both miss, and both create, leaving *two* Chrome groups carrying
 * the same title. Nothing errors. But `findGroup` returns the first match, so
 * `tabsFor` from then on reports only half the workstream, and a session asking
 * "which tab am I working on" can be handed one from the wrong half — in the
 * wrong window, if the user has since dragged one group elsewhere.
 *
 * An agent opening several tabs in one batch does this to itself; several
 * agents make it routine. Serialising per name costs nothing — grouping is
 * already off the critical path — and removes the whole class.
 */
const assignQueues = new Map();

export function assign(tabId, sessionId, workstream) {
  const key = scopeKey(sessionId, workstream);
  const run = (assignQueues.get(key) || Promise.resolve()).then(() => assignNow(tabId, sessionId, workstream));
  assignQueues.set(key, run.then(() => {}, () => {}));
  return run;
}

async function assignNow(tabId, sessionId, workstream) {
  if (!isSupported()) return null;

  const name = displayName(sessionId, workstream);
  const key = scopeKey(sessionId, workstream);

  const tab = await chrome.tabs.get(tabId);

  // Fall back to Chrome when the in-memory cache is cold, or a restarted
  // service worker would create a duplicate group with the same title.
  let existing = groups.get(key);
  if (!existing) {
    const found = await findGroup(sessionId, workstream, tab.windowId).catch(() => null);
    if (found) existing = { groupId: found.id, windowId: found.windowId, color: found.color };
  }

  // Reuse the group only if it still exists and is in the same window —
  // chrome.tabs.group cannot move a tab across windows into a group.
  if (existing && existing.windowId === tab.windowId) {
    try {
      await chrome.tabGroups.get(existing.groupId);
      await chrome.tabs.group({ tabIds: [tabId], groupId: existing.groupId });
      groups.set(key, existing);
      return existing.groupId;
    } catch {
      groups.delete(key); // group was closed by the user; fall through
    }
  }

  // `createProperties.windowId` is not optional in practice, whatever the API
  // says. Without it a new group is created in the *current* window — Chrome's
  // last-focused one — and the tabs are **moved** there to join it. So grouping,
  // a purely cosmetic step whose failures are deliberately swallowed, silently
  // relocates the tab it was only supposed to colour.
  //
  // Invisible for as long as agents worked in the window that was already
  // current: the move was a no-op. The moment a session got a window of its own
  // it became total — every first tab of every workstream was dragged back into
  // the user's window, and the agent's own window, now empty, closed itself. The
  // session then reported no window bound, having been given one two calls ago.
  //
  // Read from `tab`, which was fetched above, so this is the window the tab is
  // actually in rather than the one anybody believes it is in.
  const groupId = await chrome.tabs.group({
    tabIds: [tabId],
    createProperties: { windowId: tab.windowId },
  });
  const color = COLORS[colorCursor++ % COLORS.length];

  await chrome.tabGroups.update(groupId, {
    title: PREFIX + name,
    color,
    // Left expanded: a collapsed group hides exactly the thing this feature
    // exists to show.
    collapsed: false,
  });

  await rememberOwner(groupId, sessionId, workstream);
  groups.set(key, { groupId, windowId: tab.windowId, color });
  return groupId;
}

/** Group several tabs into one workstream in a single call. */
export async function assignMany(tabIds, sessionId, workstream) {
  const ids = [];
  for (const tabId of tabIds) {
    try {
      await assign(tabId, sessionId, workstream);
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
export async function rename(sessionId, workstream, title) {
  try {
    const key = scopeKey(sessionId, workstream);
    const entry = groups.get(key) || (await findGroup(sessionId, workstream).then((g) => g && { groupId: g.id }));
    if (!entry) return false;
    await chrome.tabGroups.update(entry.groupId, { title: PREFIX + title });
    await rememberOwner(entry.groupId, sessionId, title);
    groups.delete(key);
    return true;
  } catch {
    return false;
  }
}

/** Ungroup a workstream's tabs, leaving the tabs themselves open. */
export async function release(sessionId, workstream) {
  const selected = workstream == null
    ? (await list()).filter((g) => g.sessionId === sessionId)
    : await findGroups(sessionId, workstream);
  if (workstream != null) groups.delete(scopeKey(sessionId, workstream));
  try {
    const found = workstream == null ? selected.map((g) => ({ id: g.groupId })) : selected;
    if (!found.length) return false;
    for (const group of found) {
      const tabs = await chrome.tabs.query({ groupId: group.id });
      if (tabs.length) await chrome.tabs.ungroup(tabs.map((t) => t.id));
      await forgetOwner(group.id);
    }
    if (workstream == null) {
      for (const key of [...groups.keys()]) {
        try {
          if (JSON.parse(key)[0] === sessionId) groups.delete(key);
        } catch {
          /* old cache entry; harmless */
        }
      }
    }
    return true;
  } catch {
    return false;
  }
}

/** Close every tab in a workstream. Used to clean up after a finished job. */
export async function closeWorkstream(sessionId, workstream) {
  groups.delete(scopeKey(sessionId, workstream));
  try {
    const ids = [];
    const found = await findGroups(sessionId, workstream);
    for (const group of found) {
      const tabs = await chrome.tabs.query({ groupId: group.id });
      ids.push(...tabs.map((t) => t.id));
    }
    if (!ids.length) return 0;
    await chrome.tabs.remove(ids);
    for (const group of found) await forgetOwner(group.id);
    return ids.length;
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
    const owners = await readOwners();
    for (const group of await chrome.tabGroups.query({})) {
      if (!group.title?.startsWith(PREFIX)) continue; // someone else's group
      const tabs = await chrome.tabs.query({ groupId: group.id });
      const owner = owners[group.id] || null;
      out.push({
        name: owner?.workstream || group.title.slice(PREFIX.length),
        sessionId: owner?.sessionId || null,
        title: group.title,
        color: group.color,
        groupId: group.id,
        // Reported because a workstream can have a group in two windows, and a
        // listing that omits which is which is how a session concludes it is
        // working somewhere it is not.
        windowId: group.windowId,
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
 * the tab group itself does. Durable ownership metadata, not the visible title,
 * is the authority record: two sessions may use the same workstream label.
 *
 * @param {number} [windowId] restrict to this window. A workstream can end up
 *   with a group in each of two windows — the user drags a tab out, or the
 *   session was rebound with `browser_window use` after it had already opened
 *   tabs — and without this the *resolution* path can hand back a tab from the
 *   window the session is no longer working in. That is the wrong-window bug in
 *   its purest form: the session is told it is in the window it chose, and
 *   every subsequent call lands in the other one. Cleanup deliberately does not
 *   pass this, because releasing half a workstream is worse than releasing it
 *   all.
 */
export async function tabsFor(sessionId, workstream, windowId) {
  if (!isSupported() || !sessionId) return [];
  try {
    const all = [];
    const selected = workstream == null
      ? (await list()).filter((g) => g.sessionId === sessionId && (windowId == null || g.windowId === windowId))
      : await findGroups(sessionId, workstream, windowId);
    for (const group of selected) {
      all.push(...(await chrome.tabs.query({ groupId: group.id ?? group.groupId })));
    }
    return all
      .sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))
      .map((t) => t.id);
  } catch {
    return [];
  }
}

/**
 * Move a workstream's tabs into `windowId`, so its group follows the session.
 *
 * Rebinding a session to another window used to change only the bookkeeping:
 * new tabs went to the new window while the group — and every tab already in it
 * — stayed put, so a listing said "this workstream is in window A" about tabs
 * physically sitting in window B. Both halves were internally consistent and
 * they disagreed with each other, which is exactly the state an agent cannot
 * reason its way out of.
 *
 * Tabs are moved first and regrouped after, because `chrome.tabs.group` cannot
 * pull a tab across a window boundary into an existing group.
 *
 * @returns {number} how many tabs moved
 */
export async function moveTo(sessionId, windowId, workstream) {
  if (!isSupported() || !sessionId) return 0;
  let moved = 0;
  try {
    const selected = workstream == null
      ? (await list()).filter((g) => g.sessionId === sessionId)
      : await findGroups(sessionId, workstream);
    for (const group of selected) {
      if (group.windowId === windowId) continue;
      const groupId = group.id ?? group.groupId;
      const owner = (await readOwners())[groupId];
      const tabs = await chrome.tabs.query({ groupId });
      for (const tab of tabs) {
        try {
          // Ungrouped first: moving a tab that is still in a group takes the
          // whole group with it in some Chrome builds, which would drag another
          // session's tabs along if it shares the window.
          await chrome.tabs.ungroup([tab.id]);
          await chrome.tabs.move(tab.id, { windowId, index: -1 });
          await assign(tab.id, sessionId, owner?.workstream || workstream);
          moved++;
        } catch {
          /* a pinned or otherwise immovable tab is not worth failing the bind */
        }
      }
    }
  } catch {
    /* presentation; never fail the call that asked */
  }
  return moved;
}

/**
 * Which workstream owns a tab, if any.
 *
 * Read from Chrome for the same reason as everything else here: the in-memory
 * map is gone after an MV3 restart, and a wrong "nobody owns this" is exactly
 * the answer that lets one session take over another's tab.
 */
export async function ownerFor(tabId) {
  if (!isSupported()) return null;
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.groupId == null || tab.groupId === NO_GROUP) return null;
    await chrome.tabGroups.get(tab.groupId);
    return (await readOwners())[tab.groupId] || null;
  } catch {
    return null;
  }
}

export async function workstreamFor(tabId) {
  return (await ownerFor(tabId))?.workstream || null;
}

// A group the user closed or emptied should not linger in our map.
chrome.tabGroups?.onRemoved?.addListener((group) => {
  for (const [key, entry] of groups) {
    if (entry.groupId === group.id) groups.delete(key);
  }
  forgetOwner(group.id).catch(() => {});
});
