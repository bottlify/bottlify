/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Events as the guest reads them, without asking the host.
 *
 * A thread that polls an event -- WaitForSingleObject(h, 0), round and round
 * while it waits for work -- crosses into the host at every poll, and from
 * another executor each crossing waits for the process's executor to answer:
 * Call of Duty 4's render thread polled its work event some 1 300 times a
 * second, every answer WAIT_TIMEOUT, each a round trip of about a third of a
 * millisecond. Here every handle onto an event has a word in a table in guest
 * memory, which the kernel keeps saying whether the event is signalled, and
 * the guest's WaitForSingleObject answers a poll of one that is not by itself.
 *
 * The kernel is the only writer: a word changes as the handle opens or closes
 * and as the event's state does, in the same step, so a poll that reads a word
 * the host is about to change is a poll that came before the change. A
 * signalled event, and every other case, is the host's: taking an auto-reset
 * event is a change of state, and only the host changes state.
 */

/** What a handle's word says. */
export const MIRROR = Object.freeze({
    /** Nothing the guest may answer by itself: not an event, or not this process's. */
    NONE: 0,
    /** An event that is not signalled: a poll of it times out. */
    CLEAR: 1,
    /** A signalled event: a poll of it takes it, which is the host's. */
    SET: 3,
});

/**
 * A handle onto a mutex of this process has the address of the mutex's own
 * word (`mutex-words.js`) with these low bits set, which no event's word has:
 * the guest's WaitForSingleObject and ReleaseMutex take and give it there.
 */
export const MUTEX_TAG = 2;

/** Handles are multiples of four; the two bits below are the program's own. */
const HANDLE_SHIFT = 2;

/**
 * @param {(address: number, value: number) => void} write  a word of guest memory
 */
export function createEventMirror(write){
    let table = 0;
    let slots = 0;
    /** The word of each handle given one, and its event. @type {Map<number, any>} */
    const byHandle = new Map();
    /** The words of each event's handles. @type {WeakMap<any, number[]>} */
    const words = new WeakMap();

    /** @param {any} event */
    const state = event=>(event.signalled ? MIRROR.SET : MIRROR.CLEAR);

    const mirror = {
        /**
         * The table the guest reads, one word a handle from handle 0 up, and
         * the handles of every event already open.
         *
         * @param {number} at  the table's address
         * @param {number} count  how many handles it has a word for
         * @param {{ handle: number, type: string, object: any }[]} open
         */
        attach(at, count, open){
            table = at >>> 0;
            slots = count;
            for (const { handle, type, object } of open)
            {
                mirror.opened(handle, type, object);
            }
        },

        /**
         * A handle was opened onto an object. Only an event of this process,
         * and a mutex of it with a word of its own, has a word: one another
         * process holds changes there, unseen here.
         *
         * @param {number} handle @param {string} type @param {any} object
         */
        opened(handle, type, object){
            const index = handle >>> HANDLE_SHIFT;
            if (slots === 0 || object.remote || index >= slots)
            {
                return;
            }
            const address = table + index * 4;
            if (type === 'mutex' && typeof object.word === 'number')
            {
                byHandle.set(handle, object);
                write(address, (object.word | MUTEX_TAG) >>> 0);
                return;
            }
            if (type !== 'event')
            {
                return;
            }
            byHandle.set(handle, object);
            const held = words.get(object);
            if (held)
            {
                held.push(address);
            }
            else
            {
                words.set(object, [address]);
            }
            write(address, state(object));
        },

        /** @param {number} handle */
        closed(handle){
            const object = byHandle.get(handle);
            if (object === undefined)
            {
                return;
            }
            byHandle.delete(handle);
            const address = table + (handle >>> HANDLE_SHIFT) * 4;
            const held = words.get(object);
            if (held !== undefined && held.includes(address))
            {
                held.splice(held.indexOf(address), 1);
            }
            write(address, MIRROR.NONE);
        },

        /** @param {any} event  its signalled state just changed */
        changed(event){
            const held = words.get(event);
            if (held === undefined)
            {
                return;
            }
            const value = state(event);
            for (const address of held)
            {
                write(address, value);
            }
        },
    };
    return mirror;
}
