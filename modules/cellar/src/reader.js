/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The cache as one thread uses it: names looked up and hot bodies read in
 * place, with no word to the keeper; room to write asked of the keeper and
 * the body written straight into its segment, then made hot by the writer
 * itself.
 *
 * A body is read only inside `with`: the record counts the reader while the
 * callback runs, and the keeper takes no body a reader is in. A view kept past
 * the callback would see whatever the keeper put there next.
 *
 * A segment reaches this thread by a message (`adopt`); a body in a segment
 * not adopted yet reads as a miss, which a cache may answer.
 */

import {
    COLD, HOT, R_LENGTH, R_OFFSET, R_SEGMENT, R_STATE, WRITING, stateWord, viewIndex,
} from './shared.js';

/**
 * What the reader asks the keeper: `reserve` and `raise` answer at once,
 * across a link by a blocking call; `raiseLater` and `drop` are not waited on.
 *
 * @typedef {Object} KeeperCalls
 * @property {(name: string, length: number, options: { onlyCopy: boolean, known: number })
 *     => { id: number, segment: number, offset: number } | null} reserve
 * @property {(name: string) => boolean} raise
 * @property {(name: string) => void} raiseLater
 * @property {(name: string) => void} drop
 */

/**
 * @param {Object} options
 * @param {import('./shared.js').SharedIndex} options.shared
 * @param {(SharedArrayBuffer | null)[]} [options.segments]  those known when the reader is made
 * @param {KeeperCalls} options.keeper
 */
export function createReader({ shared, segments = [], keeper }){
    const index = viewIndex(shared);
    /** @type {(Uint8Array | null)[]} */
    const views = segments.map(buffer=>(buffer === null ? null : new Uint8Array(buffer)));
    /** Reserved and not committed yet, by name. @type {Map<string, number>} */
    const writing = new Map();
    const counts = {
        hits: 0, misses: 0, cold: 0, unseen: 0, raisedWaiting: 0, reserved: 0, refused: 0,
    };

    /**
     * Reads `name`'s body inside `read`, where it is hot here.
     *
     * @template T
     * @param {number} id @param {(body: Uint8Array) => T} read
     * @returns {{ done: true, value: T } | { done: false, state: 'cold' | 'unseen' | 'none' }}
     */
    const readHot = (id, read)=>{
        if (!index.enter(id))
        {
            return { done: false, state: index.state(id) === COLD ? 'cold' : 'none' };
        }
        try
        {
            const base = index.at(id);
            const view = views[index.words[base + R_SEGMENT]];
            if (view === undefined || view === null)
            {
                return { done: false, state: 'unseen' };
            }
            const offset = index.words[base + R_OFFSET];
            const value = read(view.subarray(offset, offset + index.words[base + R_LENGTH]));
            index.stamp(id);
            return { done: true, value };
        }
        finally {
            index.leave(id);
        }
    };

    return {
        /**
         * A message from the keeper: a segment made or let go, a larger table.
         *
         * @param {{ segment?: number, buffer?: SharedArrayBuffer | null,
         *     table?: SharedArrayBuffer }} message
         */
        adopt(message){
            if (message.table !== undefined)
            {
                index.adoptTable(message.table);
            }
            if (message.segment !== undefined)
            {
                while (views.length <= message.segment)
                {
                    views.push(null);
                }
                views[message.segment] = message.buffer ? new Uint8Array(message.buffer) : null;
            }
        },

        /**
         * Where `name`'s body is, without reading it.
         *
         * @param {string} name @returns {'hot' | 'cold' | null}
         */
        look(name){
            const id = index.find(name);
            if (id < 0)
            {
                return null;
            }
            const state = index.state(id);
            return state === HOT ? 'hot' : state === COLD ? 'cold' : null;
        },

        /**
         * Calls `read` with `name`'s body and answers what it returned; with
         * `wait`, a cold body is brought back first. A miss answers
         * `undefined` and, for a cold body without `wait`, asks for it to be
         * brought back for later.
         *
         * @template T
         * @param {string} name @param {(body: Uint8Array) => T} read
         * @param {{ wait?: boolean }} [options]
         * @returns {T | undefined}
         */
        with(name, read, { wait = false } = {}){
            const id = index.find(name);
            if (id < 0)
            {
                counts.misses++;
                return undefined;
            }
            let got = readHot(id, read);
            if (!got.done && got.state === 'cold' && wait && keeper.raise(name))
            {
                counts.raisedWaiting++;
                got = readHot(id, read);
            }
            if (got.done)
            {
                counts.hits++;
                return got.value;
            }
            counts.misses++;
            if (got.state === 'cold')
            {
                counts.cold++;
                if (!wait)
                {
                    keeper.raiseLater(name);
                }
            }
            else if (got.state === 'unseen')
            {
                counts.unseen++;
            }
            return undefined;
        },

        /**
         * Room for `name`'s body: a view to write it into, or null where the
         * keeper has none. The body is not seen by anyone until `commit`.
         *
         * @param {string} name @param {number} length @param {{ onlyCopy?: boolean }} [options]
         */
        reserve(name, length, { onlyCopy = false } = {}){
            const place = keeper.reserve(name, length, { onlyCopy, known: views.length });
            const view = place === null ? null : views[place.segment];
            if (place === null || view === null || view === undefined)
            {
                counts.refused++;
                return null;
            }
            writing.set(name, place.id);
            counts.reserved++;
            return view.subarray(place.offset, place.offset + length);
        },

        /**
         * Makes the body written into `reserve`'s view readable.
         *
         * @param {string} name
         */
        commit(name){
            const id = writing.get(name);
            if (id === undefined)
            {
                throw new Error(`cache: ${name} was not reserved here`);
            }
            writing.delete(name);
            index.stamp(id);
            // Hot, the writer out; or, where the name was written anew meanwhile,
            // only the writer out of a record retired under it.
            if (Atomics.compareExchange(index.words, index.at(id) + R_STATE,
                stateWord(WRITING, 1), stateWord(HOT)) !== stateWord(WRITING, 1))
            {
                index.leave(id);
            }
        },

        /**
         * `reserve`, a copy of `bytes`, `commit`: false where there was no room.
         *
         * @param {string} name @param {Uint8Array} bytes @param {{ onlyCopy?: boolean }} [options]
         */
        put(name, bytes, options){
            const into = this.reserve(name, bytes.length, options);
            if (into === null)
            {
                return false;
            }
            into.set(bytes);
            this.commit(name);
            return true;
        },

        /** @param {string} name */
        drop(name){
            keeper.drop(name);
        },

        figures: ()=>({ ...counts }),
    };
}

/** @typedef {ReturnType<typeof createReader>} Reader */
