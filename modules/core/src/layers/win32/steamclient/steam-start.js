/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What a running Steam client offers a game's DRM wrapper (SteamStub) that
 * failed to start it: a lock event and a shared section, which the wrapper
 * opens by name, and through which it asks the client to take the launch
 * over -- the app, its own process, the failure, and an event to be told on.
 * The client answers for an app the account owns by setting that event; the
 * wrapper then ends without its error box. An app the account does not own
 * is not answered, and the wrapper's wait runs out into its error.
 *
 * The layout is the wrapper's, read from its code (Astroneer's, 64-bit):
 * READY (2 when the client is there) and REQUEST (0 free, 2 posted) are the
 * client's and the wrapper's handshake; the rest the wrapper writes.
 */

/** The objects' names, in the session's namespace. */
export const STEAM_START_LOCK = 'Local\\SteamStart_SharedMemLock';
export const STEAM_START_FILE = 'Local\\SteamStart_SharedMemFile';

/** The section's fields, by offset. */
export const STEAM_START = Object.freeze({
    SIZE: 0x1000,
    READY: 0x90,
    REQUEST: 0x94,
    PROCESS: 0x98,
    EVENT: 0xa0,
    APP: 0xa8,
    HEADER_44: 0xac,
    CODE: 0xb0,
    ENTRY: 0xb4,
});

/** READY's value while the client runs, and REQUEST's for a request posted. */
export const STEAM_START_READY = 2;
export const STEAM_START_POSTED = 2;

/** How often a view's request word is looked at, in the guest's milliseconds. */
const POLL_MS = 10;

/** SEC_COMMIT: a page-file section committed whole. */
const SEC_COMMIT = 0x8000000;

/**
 * A view of the section as the mapping layer hands its owner one.
 *
 * @typedef {Object} ServedView
 * @property {(offset: number, length: number) => Uint8Array} read
 * @property {(offset: number, bytes: Uint8Array) => void} write
 * @property {(handle: number) => any} event  The mapping process's event, or null.
 * @property {(ms: number, tick: () => void) => () => void} every
 */

/**
 * @param {{ kernel: any, owns: (app: number) => boolean }} host
 */
export function createSteamStart({ kernel, owns }){
    const contents = new Uint8Array(STEAM_START.SIZE);
    new DataView(contents.buffer).setUint32(STEAM_START.READY, STEAM_START_READY, true);
    /** @type {any} */
    let lock = null;
    /** @type {{ app: number, process: number, code: number, answered: boolean }[]} */
    const requests = [];

    /** @param {Uint8Array} bytes @param {number} at */
    const u32 = (bytes, at)=>new DataView(bytes.buffer, bytes.byteOffset).getUint32(at, true);

    /** @param {ServedView} view */
    const answer = view=>{
        const posted = view.read(0, 0xb8);
        if (u32(posted, STEAM_START.REQUEST) !== STEAM_START_POSTED)
        {
            return;
        }
        const app = u32(posted, STEAM_START.APP);
        const requester = view.event(u32(posted, STEAM_START.EVENT));
        const answered = owns(app) && requester !== null;
        requests.push({ app, process: u32(posted, STEAM_START.PROCESS),
            code: posted[STEAM_START.CODE], answered });
        // Taken: free for the next, and the lock given back.
        view.write(STEAM_START.REQUEST, new Uint8Array(4));
        if (answered)
        {
            kernel.setEvent(requester);
        }
        if (lock)
        {
            kernel.setEvent(lock);
        }
    };

    const section = {
        node: null, writable: true, size: STEAM_START.SIZE, attributes: SEC_COMMIT,
        /** What a view starts with. */
        contents: ()=>contents,
        /** @param {ServedView} view @returns {() => void} */
        watch: view=>view.every(POLL_MS, ()=>answer(view)),
    };

    return {
        /**
         * The object a name stands for, made the first time a process opens it.
         *
         * @param {string} name @param {string} kind
         */
        provide(name, kind){
            if (name === STEAM_START_LOCK && kind === 'event')
            {
                lock ??= kernel.createEvent({ manualReset: false, signalled: true, name });
                return lock;
            }
            return name === STEAM_START_FILE && kind === 'mapping' ? section : null;
        },

        /** The requests answered or not, for a report. */
        requests: ()=>requests.slice(),
    };
}
