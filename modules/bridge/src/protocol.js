/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What a page and GameHub say to each other, over `window.postMessage` on the
 * page's own origin; the content script carries both ways (pipe.js), and the
 * service worker reads the request here.
 *
 * The page asks `{ to: 'bottlify-bridge', id, op, args }`; GameHub answers
 * `{ from: 'bottlify-bridge', id, result }` or `{ ..., id, error }`, and an op
 * that goes on for a while (a sign-in) sends `{ ..., id, event, data }` first.
 * `id` is the page's, any number it has not used for a request still open.
 * GameHub is present when the page's root element carries
 * `data-bottlify-bridge` (its version): set before any of the page's scripts
 * runs, so a page that does not find it need not wait for an answer.
 *
 * No op names a store's protocol: the store is an argument (`steam`).
 * - `hello` -> `{ version, stores: [{ id, name, on }] }`: the stores GameHub has,
 *   and which the site has on (its `config.json`'s `bridge`).
 * - `cancel { target }` -> `{}`: stops the request asked as `target` (a sign-in).
 * - `account { store, fresh? }` -> `{ name }`, or null for nobody signed in;
 *   `fresh` logs on again and reads the account's licences anew.
 * - `signIn { store }` -> `{ name }`; events `challenge` `{ url }` (shown as a
 *   QR code; sent again when the code changes) and `scanned`.
 * - `signOut { store }` -> `{}`.
 * - `list { store, fresh? }` -> `[{ id, name, bytes, exact, installable, covers }]`,
 *   the account's games; `covers` the URLs `cover` answers, by kind.
 * - `cover { store, game, kind }` -> the URL of the store's picture of a game;
 *   `kind` is `header`, `capsule` or `hero`.
 * - `download { store, game }` -> what an install needs; the store's own shape
 *   (Steam's: `{ name, launch, installscript, art, servers, depots }`).
 * - `runData { store, game }` -> what a run hands the engine's emulation of the
 *   store's client (Steam's: `{ win32: { steam } }`), `{}` signed out.
 *
 * The session's token never crosses to the page.
 */

export const TO = 'bottlify-bridge';
export const FROM = 'bottlify-bridge';

/** @typedef {'id' | 'store' | 'game' | 'kind' | 'bool?'} ArgKind */

/** Each op's arguments and what they must be. @type {Record<string, Record<string, ArgKind>>} */
export const OPS = Object.freeze({
    hello: {},
    cancel: { target: 'id' },
    account: { store: 'store', fresh: 'bool?' },
    signIn: { store: 'store' },
    signOut: { store: 'store' },
    list: { store: 'store', fresh: 'bool?' },
    cover: { store: 'store', game: 'game', kind: 'kind' },
    download: { store: 'store', game: 'game' },
    runData: { store: 'store', game: 'game' },
});

/** @type {Record<ArgKind, (value: unknown) => boolean>} */
const VALID = {
    id: value=>Number.isSafeInteger(value),
    store: value=>typeof value === 'string' && /^[a-z][a-z0-9]{0,31}$/.test(value),
    game: value=>typeof value === 'string' && /^[A-Za-z0-9._:-]{1,64}$/.test(value),
    kind: value=>value === 'header' || value === 'capsule' || value === 'hero',
    'bool?': value=>value === undefined || typeof value === 'boolean',
};

/**
 * @typedef {{ id: number, op: string, args: Record<string, any> }} Request
 * @typedef {{ id: number, error: string }} Refusal
 */

/**
 * A message the page posted, read as a request: null for one not meant for
 * GameHub, a refusal for one that is but cannot be answered.
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
