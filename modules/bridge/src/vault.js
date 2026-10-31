/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Where the stores' sessions are kept: the extension origin's IndexedDB, which
 * only the extension's own contexts open -- not the content script, whose
 * IndexedDB is the page's. Sessions an earlier version kept in
 * `chrome.storage.local`, which a content script can read, are moved here
 * when they are asked for, and removed from there.
 */

const DB = 'gamehub';
const SESSIONS = 'sessions';

/** @param {IDBFactory} indexedDB @returns {Promise<IDBDatabase>} */
function open(indexedDB){
    return new Promise((resolve, reject)=>{
        const request = indexedDB.open(DB, 1);
        request.onupgradeneeded = ()=>request.result.createObjectStore(SESSIONS);
        request.onsuccess = ()=>resolve(request.result);
        request.onerror = ()=>reject(request.error);
    });
}

/**
 * @param {IDBDatabase} db @param {IDBTransactionMode} mode
 * @param {(store: IDBObjectStore) => IDBRequest} work
 * @returns {Promise<any>}
 */
function inStore(db, mode, work){
    return new Promise((resolve, reject)=>{
        const transaction = db.transaction(SESSIONS, mode);
        const request = work(transaction.objectStore(SESSIONS));
        transaction.oncomplete = ()=>resolve(request.result);
        transaction.onerror = ()=>reject(transaction.error);
        transaction.onabort = ()=>reject(transaction.error);
    });
}

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
    return {
        /** @returns {Promise<any>} */
        async get(){
            if (legacy)
            {
                const old = (await legacy.get(store))?.[store];
                if (old)
                {
                    await inStore(await db(), 'readwrite', kept=>kept.put(old, store));
                }
                await legacy.remove(store);
            }
            return (await inStore(await db(), 'readonly', kept=>kept.get(store))) ?? null;
        },
        /** @param {any} session  Null forgets it. */
        async set(session){
            await legacy?.remove(store);
            await inStore(await db(), 'readwrite', kept=>(session
                ? kept.put(session, store) : kept.delete(store)));
        },
    };
}
