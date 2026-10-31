/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Where the stores' sessions are kept: the extension origin's IndexedDB, which
 * only the extension's own contexts open -- not the content script, whose
 * IndexedDB is the page's. A session's token is sealed with AES-GCM under a
 * key made non-extractable and kept beside it: the database read off the disk
 * gives the token only to code that runs as the extension. Sessions an
 * earlier version kept in `chrome.storage.local`, which a content script can
 * read, or unsealed in this database, are sealed when they are next asked for
 * and removed from where they were.
 */

const DB = 'gamehub';
const SESSIONS = 'sessions';
const KEYS = 'keys';

/** @param {IDBFactory} indexedDB @returns {Promise<IDBDatabase>} */
function open(indexedDB){
    return new Promise((resolve, reject)=>{
        const request = indexedDB.open(DB, 2);
        request.onupgradeneeded = ()=>{
            for (const name of [SESSIONS, KEYS])
            {
                if (!request.result.objectStoreNames.contains(name))
                {
                    request.result.createObjectStore(name);
                }
            }
        };
        request.onsuccess = ()=>resolve(request.result);
        request.onerror = ()=>reject(request.error);
    });
}

/**
 * @param {IDBDatabase} db @param {string} name @param {IDBTransactionMode} mode
 * @param {(store: IDBObjectStore) => IDBRequest} work
 * @returns {Promise<any>}
 */
function inStore(db, name, mode, work){
    return new Promise((resolve, reject)=>{
        const transaction = db.transaction(name, mode);
        const request = work(transaction.objectStore(name));
        transaction.oncomplete = ()=>resolve(request.result);
        transaction.onerror = ()=>reject(transaction.error);
        transaction.onabort = ()=>reject(transaction.error);
    });
}

/**
 * A session with its token sealed: what the database keeps.
 *
 * @typedef {{ accountName: string, id?: string, iv: Uint8Array, sealed: Uint8Array }} Sealed
 * @typedef {{ accountName: string, id?: string, refreshToken: string }} Session
 */

/**
 * @param {CryptoKey} key @param {Session} session
 * @returns {Promise<Sealed>}
 */
export async function seal(key, { accountName, id, refreshToken }){
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key,
        new TextEncoder().encode(refreshToken)));
    return { accountName, ...id ? { id } : {}, iv, sealed };
}

/**
 * @param {CryptoKey} key @param {Sealed} kept
 * @returns {Promise<Session>}
 */
export async function unseal(key, { accountName, id, iv, sealed }){
    const token = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: /** @type {any} */ (iv) },
        key, /** @type {any} */ (sealed));
    return { accountName, ...id ? { id } : {}, refreshToken: new TextDecoder().decode(token) };
}

/** A key that seals and unseals and that nothing can read out. */
export const newKey = ()=>crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false,
    ['encrypt', 'decrypt']);

/**
 * A store's session, kept.
 *
 * @param {string} store  `steam`.
 * @param {Object} [options]
 * @param {IDBFactory} [options.indexedDB]
 * @param {{ get(key: string): Promise<Record<string, any>>, remove(key: string): Promise<void> }
 *     | null} [options.legacy]  Where an earlier version kept it.
 */
export function vaultFor(store, { indexedDB = globalThis.indexedDB,
    legacy = /** @type {any} */ (globalThis).chrome?.storage?.local ?? null } = {})
{
    /** @type {Promise<IDBDatabase> | null} */
    let opened = null;
    const db = ()=>(opened ??= open(indexedDB));
    /** @type {Promise<CryptoKey> | null} */
    let keyed = null;
    const key = ()=>(keyed ??= db().then(async now=>{
        const kept = await inStore(now, KEYS, 'readonly', keys=>keys.get('sessions'));
        if (kept)
        {
            return kept;
        }
        const made = await newKey();
        await inStore(now, KEYS, 'readwrite', keys=>keys.put(made, 'sessions'));
        return made;
    }));
    /** @param {Session | null} session */
    const put = async session=>{
        const sealed = session ? await seal(await key(), session) : null;
        await inStore(await db(), SESSIONS, 'readwrite', kept=>(sealed
            ? kept.put(sealed, store) : kept.delete(store)));
    };
    return {
        /** @returns {Promise<Session | null>} */
        async get(){
            if (legacy)
            {
                const old = (await legacy.get(store))?.[store];
                if (old?.refreshToken)
                {
                    await put(old);
                }
                await legacy.remove(store);
            }
            const kept = await inStore(await db(), SESSIONS, 'readonly',
                sessions=>sessions.get(store));
            if (!kept)
            {
                return null;
            }
            if (typeof kept.refreshToken === 'string')
            {
                await put(kept);
                return kept;
            }
            return unseal(await key(), kept);
        },
        /** @param {Session | null} session  Null forgets it. */
        async set(session){
            await legacy?.remove(store);
            await put(session);
        },
    };
}
