/**
 * Guided "Sign in with Google" — the *decision* half, kept pure so the safety
 * gates are provable without a browser (see test/run.mjs → testOAuth).
 *
 * The point of this feature is not to log a user in on its own. It is to make
 * the two things a model must never decide by itself into explicit, human-gated
 * steps:
 *
 *   1. *Which* Google account. An account chooser is an identity decision — it
 *      tells a third-party site who the user is. So the chooser is enumerated
 *      and the flow STOPS until the caller passes an explicit `account`; the
 *      model is told to ask the user which one (or whether to use Google at
 *      all), never to pick.
 *   2. *Whether* to grant access. The OAuth consent screen ("X wants access to
 *      your Google account") is the irreversible grant. It STOPS until the
 *      caller passes `consent:true`, which the model may only send after the
 *      user has confirmed.
 *
 * And the one thing it must never do at all — type a password — is a hard stop
 * with no override. `googleDecision` returns what to do; the router
 * (`googleLogin`) is the only place that turns a `click`/`allow` into a trusted
 * event, and it does so only for these vetted decisions.
 */

/** Resolve a caller's `account` (an index, an email, a fragment, or a name). */
export function matchAccount(accounts, account) {
  if (account == null || account === '') return null;
  const s = String(account).trim().toLowerCase();

  if (/^\d+$/.test(s)) return accounts.find((a) => a.index === Number(s)) || null;

  // Exact email wins over any partial, so "sam@x.com" never resolves to
  // "sam@y.com" just because it was listed first.
  const exact = accounts.find((a) => (a.email || '').toLowerCase() === s);
  if (exact) return exact;

  const byEmail = accounts.filter((a) => (a.email || '').toLowerCase().includes(s));
  if (byEmail.length === 1) return byEmail[0];
  if (byEmail.length > 1) return null; // ambiguous — refuse rather than guess

  const byName = accounts.filter((a) => (a.name || '').toLowerCase().includes(s));
  if (byName.length === 1) return byName[0];

  return null;
}

/**
 * @param {object} p
 * @param {string} p.stage  chooser | password | consent | email | unknown
 * @param {Array<{index:number,email:string,name?:string}>} [p.accounts]
 * @param {string|number} [p.account]  the caller's explicit choice
 * @param {boolean} [p.consent]        the caller's explicit grant
 * @returns {{do:'list'|'click'|'allow'|'stop', reason?:string, message:string,
 *   account?:object}}
 */
export function googleDecision({ stage, accounts = [], account, consent } = {}) {
  // Hard stop, no override: a password is off-limits to automation entirely.
  if (stage === 'password') {
    return {
      do: 'stop',
      reason: 'password',
      message:
        'This is the Google password screen. I will not type a password. Ask the user to sign in here ' +
        'themselves, then call browser_act action:"google_login" again to continue from the next step.',
    };
  }

  // The grant. Requires an explicit, separate consent — never inferred.
  if (stage === 'consent') {
    if (consent === true) return { do: 'allow', message: 'Granting the requested access, as confirmed.' };
    return {
      do: 'stop',
      reason: 'consent',
      message:
        'Google is asking to grant this app access to the account. Confirm with the user first — say what access ' +
        'is requested — then call browser_act action:"google_login" consent:true. Do not grant access on your own.',
    };
  }

  // The account chooser. List and stop, unless the user has already chosen.
  if (stage === 'chooser') {
    if (!accounts.length) {
      return { do: 'stop', reason: 'empty', message: 'A Google chooser is showing but no accounts could be read from it.' };
    }
    if (account == null || account === '') {
      const list = accounts.map((a) => `[${a.index}] ${a.email}${a.name ? ` (${a.name})` : ''}`).join(', ');
      return {
        do: 'list',
        accounts,
        message:
          `Google is offering ${accounts.length} account(s): ${list}. Ask the user which account to use — or ` +
          'whether to sign in with Google at all — then call browser_act action:"google_login" account:"<email or index>". ' +
          'Do not choose an identity for them.',
      };
    }
    const chosen = matchAccount(accounts, account);
    if (!chosen) {
      return {
        do: 'stop',
        reason: 'no-match',
        message:
          `"${account}" does not match exactly one offered account. Offered: ` +
          `${accounts.map((a) => a.email).join(', ')}. Ask the user which one.`,
      };
    }
    return { do: 'click', account: chosen, message: `Selecting ${chosen.email}.` };
  }

  if (stage === 'email') {
    return {
      do: 'stop',
      reason: 'email',
      message:
        'Google is asking for an email address rather than offering a chooser. Ask the user which address to use ' +
        '(I will not guess an identity); enter it with browser_input, then run this action again.',
    };
  }

  return {
    do: 'stop',
    reason: 'unknown',
    message:
      'No Google account chooser, password, or consent screen was found here. Navigate to the Google sign-in / ' +
      'account chooser first (e.g. click "Sign in with Google"), then run browser_act action:"google_login".',
  };
}

/**
 * Merge the per-frame reads from `googleAccounts` into one view. Safety-first
 * precedence: a password or consent screen anywhere outranks a stray chooser
 * match, so a misread row on a consent page can never turn into a click. The
 * account list is unioned across frames (a One-Tap iframe plus the page) and
 * de-duplicated by email, then re-indexed so indices are stable for the caller.
 */
export function mergeGoogleFrames(frameReads) {
  const reads = frameReads.filter(Boolean);
  const any = (s) => reads.some((r) => r.stage === s);

  const accounts = [];
  const seen = new Set();
  for (const r of reads) {
    for (const a of r.accounts || []) {
      const key = (a.email || '').toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      accounts.push(a);
    }
  }
  accounts.forEach((a, i) => (a.index = i));

  const allow = reads.map((r) => r.allow).find(Boolean) || null;

  let stage = 'unknown';
  if (any('password')) stage = 'password';
  else if (any('consent')) stage = 'consent';
  else if (accounts.length) stage = 'chooser';
  else if (any('email')) stage = 'email';

  const isGoogle = reads.some((r) => r.isGoogle);
  return { isGoogle, stage, accounts, allow };
}
