/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What a page and the bridge say to each other, over `window.postMessage` on
 * the page's own origin.
 *
 * The page asks `{ to: 'bottlify-bridge', id, op, args }`; the bridge answers
 * `{ from: 'bottlify-bridge', id, result }` or `{ ..., id, error }`, and an op
 * that goes on for a while (a sign-in) sends `{ ..., id, event, data }` first.
 * `id` is the page's, any number it has not used for a request still open.
 * The bridge is present when the page's root element carries
 * `data-bottlify-bridge` (its version): set before any of the page's scripts
 * runs, so a page that does not find it need not wait for an answer.
 *
 * Ops:
 * - `hello` -> `{ version, platforms: { steam: boolean } }`, the platforms the
 *   site has switched on (its `config.json`'s `bridge`).
 * - `signIn` -> `{ accountName }`; events `challenge` `{ url }` (show it as a
 *   QR code; sent again when the code changes) and `scanned`.
 * - `cancel { target }` -> `{}`: stops the sign-in asked as `target`.
 * - `signOut` -> `{}`.
 * - `account { fresh? }` -> `{ steamId, accountName, apps, licenses }`, or null
 *   when nobody is signed in: every app the account's licences grant (games,
 *   DLC, tools), by id, and how many licences there are. `fresh` logs on again and reads them
 *   anew rather than as they were read a while ago.
 * - `depotKey { app, depot }` -> Uint8Array, the depot's AES key.
 * - `appOwnershipTicket { app }` -> Uint8Array, the signed-in account's app
 *   ownership ticket for the app as Steam signs it (EMsg 857/858), or null
 *   signed out or for an app the account does not own.
 * - `manifestCode { app, depot, gid, branch? }` -> string; `gid` a decimal string.
 * - `contentServers` -> `[{ host, vhost, type }]`, those the page may fetch from.
 *
 * Without a sign-in the bridge logs on anonymously, which is enough for what
 * Steam gives everyone. The session's refresh token never crosses to the page.
 */

export const TO = 'bottlify-bridge';
export const FROM = 'bottlify-bridge';

/** @typedef {'uint' | 'id' | 'u64' | 'string?' | 'bool?'} ArgKind */

/** Each op's arguments and what they must be. @type {Record<string, Record<string, ArgKind>>} */
export const OPS = Object.freeze({
    hello: {},
    signIn: {},
    cancel: { target: 'id' },
    signOut: {},
    account: { fresh: 'bool?' },
    depotKey: { app: 'uint', depot: 'uint' },
    appOwnershipTicket: { app: 'uint' },
    manifestCode: { app: 'uint', depot: 'uint', gid: 'u64', branch: 'string?' },
    contentServers: {},
});

/** @type {Record<ArgKind, (value: unknown) => boolean>} */
const VALID = {
    uint: value=>Number.isInteger(value) && /** @type {number} */ (value) >= 0
        && /** @type {number} */ (value) <= 0xFFFFFFFF,
    id: value=>Number.isSafeInteger(value),
    u64: value=>typeof value === 'string' && /^[0-9]{1,20}$/.test(value)
        && BigInt(value) < 2n ** 64n,
    'string?': value=>value === undefined || (typeof value === 'string' && value.length <= 256),
    'bool?': value=>value === undefined || typeof value === 'boolean',
};

/**
 * @typedef {{ id: number, op: string, args: Record<string, any> }} Request
 * @typedef {{ id: number, error: string }} Refusal
 */

/**
 * A message the page posted, read as a request: null for one not meant for
 * the bridge, a refusal for one that is but cannot be answered.
 *
 * @param {unknown} data
 * @returns {Request | Refusal | null}
 */
export function readRequest(data){
    const message = /** @type {Record<string, any> | null} */ (data);
    if (typeof message !== 'object' || message === null || message.to !== TO)
    {
        return null;
    }
    const { id, op } = message;
    if (!Number.isSafeInteger(id))
    {
        return null;
    }
    const kinds = typeof op === 'string' && Object.hasOwn(OPS, op) ? OPS[op] : null;
    if (!kinds)
    {
        return { id, error: `no op ${String(op)}` };
    }
    const given = typeof message.args === 'object' && message.args !== null ? message.args : {};
    /** @type {Record<string, any>} */
    const args = {};
    for (const [name, kind] of Object.entries(kinds))
    {
        if (!VALID[kind](given[name]))
        {
            return { id, error: `${op}: ${name} is not a valid ${kind.replace('?', '')}` };
        }
        args[name] = given[name];
    }
    return { id, op, args };
}
