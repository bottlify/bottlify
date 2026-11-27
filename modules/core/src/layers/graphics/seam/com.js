/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * How the drawing APIs' objects count their references, for the bridge's COM
 * seam (`bridge/com-seam.js`).
 *
 * The APIs behind this seam model their own lifetimes: a Direct3D surface
 * counts its references, a DirectDraw surface dies with its root, and both
 * decide when a Reset may proceed by looking at those counts. Handing them to
 * `createComObject` would give every object a second count that agrees with the
 * first only by accident, and the first is the one the API's own rules read.
 *
 * So each is published through the seam's adapter, and what this file adds is
 * how that adapter counts: every count is the API object's own, what the guest
 * did to it in a command ring is settled first, a count can live in a word of
 * guest memory (`createCountCells`), the release that ends the object tells
 * each interface (`released`) and gives up the way back from all its
 * pointers, and what that release owes the program is called before it
 * answers (`owe`). Which interfaces an object has now (`supports`), answers
 * to (`answers`) and refuses with a word of its own (`refusal`) are the API
 * object's to say.
 */

import { createComPublisher } from '../../bridge/com-seam.js';

/**
 * @typedef {import('../../bridge/com-seam.js').ComInterfaceDescription} InterfaceDescriptor
 *           Its methods' `target` is the API object, not the adapter: an
 *           implementation never sees this file.
 */

/**
 * @param {CountCells | null} cells
 * @param {() => unknown} settleOwed  Makes the calls into the program a
 *        release left owing (`createPublisher`'s `owe`).
 * @returns {(seat: import('../../bridge/com-seam.js').ComSeat) =>
 *     import('../../bridge/com-seam.js').ComCounting}
 */
const countedByTheApi = (cells, settleOwed)=>({ api, declared, pointers, remember,
    forgetAll })=>{
    /**
     * What the guest did that the object's count has to meet before it is
     * read or lowered here -- a binding it made in a command ring that holds
     * the object -- is made first.
     */
    const settle = ()=>api.settleGuestRefs?.(pointers);
    /** Whether the latest release ended the object, which the bridge asks next. */
    let gone = false;
    return {
        // Every interface pointer goes with the object at the bridge then,
        // and not while the object says it outlives the count that went, as
        // a DirectDraw object does while another generation is held.
        destroyed: ()=>gone,
        // Whether an interface whose count went to zero may still be called
        // through the pointer the program kept: an object its device owns
        // says so, and the bridge then keeps the interface published.
        reachable: id=>(typeof api.reachable === 'function' ? api.reachable(id) === true : false),
        // Where a method that runs in the guest finds the object's memory:
        // the object's own answer, or nothing for an object that keeps none.
        guestState: ()=>(typeof api.guestState === 'function' ? api.guestState() : 0),
        // Where the guest's AddRef and Release find the object's count, or
        // nothing for an object that keeps it on the host.
        countCell: ()=>(cells ? cells.of(api.counter) : 0),
        // Where the count its crossings of zero move is kept, for an object
        // whose first reference is one on another (`ReferenceCount.owner`).
        ownerCell: ()=>(cells && api.counter?.owner ? cells.of(api.counter.owner) : 0),
        // The calls into the program a release left owing (`owe`), which the
        // bridge makes and waits for before it answers the Release.
        afterRelease: settleOwed,

        // Forwarded with the interface it was called through, because an API
        // whose generations count separately needs to know which one. A
        // reference taken through an interface puts its pointer on the way
        // back: the bridge answers a query from the object's own interfaces
        // without coming through `publish`, and a program then hands that
        // pointer back -- an IDirect3DTexture2 exists only as a query's
        // answer, and SetTexture takes one.
        addRef(id){
            settle();
            if (id !== undefined)
            {
                remember(id);
            }
            return api.addRef?.(id) ?? 1;
        },

        /**
         * The object's own release, and the one moment this file learns that an
         * object is over.
         *
         * An API that does not count references at all is left alone: nothing
         * it answers means "gone", and reading its zero that way would forget a
         * live object on its first Release.
         *
         * A count of zero is not the whole test either. DirectDraw counts per
         * interface generation, so one generation reaching zero says nothing
         * about the object -- three others may still be held, and the program
         * still holds their pointers. Those objects report `destroyed`, and
         * that is what decides it for them.
         */
        release(id){
            if (typeof api.release !== 'function')
            {
                return 0;
            }
            settle();
            const left = api.release(id);
            if (api.counter?.destroyed)
            {
                cells?.giveBack(api.counter);
            }
            gone = left === 0 && api.destroyed !== false;
            if (gone)
            {
                for (const descriptor of declared.values())
                {
                    descriptor.released?.(api, pointers);
                }
                // The way back goes with the object: a strong map that only
                // grew would hold every object a program ever made, and keep
                // a texture alive behind the weak table the renderer accounts
                // for them with. Published again, it comes back as the same
                // pointer and is recorded again.
                forgetAll();
            }
            return left;
        },
    };
};

/**
 * What an object counts its references with, which can keep the count in a
 * word of guest memory (`d3d9/resources.js`, `ReferenceCount`).
 *
 * @typedef {Object} Counter
 * @property {(cell: import('../d3d9/resources.js').CountCell | null) => void} place
 * @property {number} placed
 * @property {boolean} [destroyed]
 */

/**
 * @typedef {Object} CountCells
 * @property {(counter: Counter | undefined) => number} of  The address of the
 *           word the counter keeps its count in, placing it there first; 0 for
 *           none.
 * @property {(counter: Counter) => void} giveBack  The counter keeps its count on
 *           the host again, and its word goes back.
 */

/**
 * Words of guest memory for objects' reference counts, so that the guest's
 * AddRef and Release (`bridge/internal/vtable.js`) can answer one that is
 * not a zero crossing without coming into the host. They come out of pages
 * of the guest's heap, a word at a time: a heap block per object would cost
 * the arena a block's overhead for every texture a program makes.
 *
 * @param {{ allocate: (bytes: number) => number,
 *           memory: { readU32: (address: number) => number,
 *                     writeU32: (address: number, value: number) => void,
 *                     compareExchangeU32?: (address: number, expected: number,
 *                         value: number) => number } }} deps
 * @returns {CountCells}
 */
export function createCountCells({ allocate, memory }){
    const PAGE = 4096;
    /** @type {number[]} */
    const spare = [];
    let next = 0;
    let end = 0;
    const take = ()=>{
        const reused = spare.pop();
        if (reused !== undefined)
        {
            return reused;
        }
        if (next === end)
        {
            const page = allocate(PAGE);
            if (page === 0)
            {
                return 0;
            }
            next = page;
            end = page + PAGE;
        }
        const at = next;
        next += 4;
        return at;
    };
    return {
        of(counter){
            if (!counter || typeof counter.place !== 'function' || counter.destroyed)
            {
                return 0;
            }
            if (counter.placed === 0)
            {
                const address = take();
                if (address === 0)
                {
                    return 0;
                }
                counter.place({
                    address,
                    read: ()=>memory.readU32(address),
                    write: value=>memory.writeU32(address, value >>> 0),
                    ...(memory.compareExchangeU32 === undefined ? {} : {
                        exchange: (/** @type {number} */ expected, /** @type {number} */ value)=>
                            /** @type {(a: number, e: number, v: number) => number} */
                            (memory.compareExchangeU32)(address, expected >>> 0, value >>> 0),
                    }),
                });
            }
            return counter.placed;
        },
        giveBack(counter){
            const address = counter.placed;
            if (address !== 0)
            {
                counter.place(null);
                spare.push(address);
            }
        },
    };
}


/**
 * Publishes API objects as COM interfaces (`bridge/com-seam.js`), counted as
 * the APIs count them.
 *
 * `objectAt` answers null for a null pointer -- unbinding a texture is
 * SetTexture with one -- and for one whose object was released: a program
 * that goes on using one is doing what it would be doing on Windows, and
 * null makes that a call that fails rather than one that faults. `count` is
 * the pointers a program can still call through; a build where it only ever
 * rises is one where nothing is being given back.
 *
 * @param {Object} deps
 * @param {(object: any, interfaceId: string) => number} deps.publishInterface
 *        The bridge's, which lays the vtable out in guest memory.
 * @param {(object: any, interfaceId: string) => boolean} [deps.unpublishInterface]
 *        The bridge's, which gives an interface back; without it an object
 *        given back leaves only this file's way back to it.
 * @param {CountCells} [deps.cells]  Where objects that can keep their count in
 *        the guest keep it; on the host, without.
 * @param {() => unknown} [deps.currentThread]  The thread whose call is being answered.
 * @returns {import('../../bridge/com-seam.js').ComPublisher & {
 *             owe: (call: (thread: unknown) => unknown) => void,
 *             countCell: (api: any) => number }}
 */
export function createPublisher({ publishInterface, unpublishInterface, cells, currentThread }){
    /**
     * Calls into the program that an object going owes it -- the Release of
     * an interface of the program's that its private data held -- made one
     * after another on the releasing thread once the Release that ended it
     * is done, and waited for before the program hears its answer.
     *
     * @type {((thread: unknown) => unknown)[]}
     */
    const owed = [];
    /** @returns {unknown} a promise while the calls are made */
    const settleOwed = ()=>{
        if (owed.length === 0)
        {
            return undefined;
        }
        const thread = currentThread?.();
        /** @returns {unknown} */
        const next = ()=>{
            const call = owed.shift();
            if (!call)
            {
                return 0;
            }
            const made = call(thread);
            return typeof (/** @type {any} */ (made))?.then === 'function'
                ? /** @type {Promise<unknown>} */ (made).then(next) : next();
        };
        return next();
    };

    return {
        ...createComPublisher({
            publishInterface,
            unpublishInterface,
            counting: countedByTheApi(cells ?? null, settleOwed),
            offers: (api, id)=>typeof api.supports !== 'function' || api.supports(id),
            answers: (api, id)=>typeof api.answers !== 'function' || api.answers(id),
            refusal: (api, id)=>(typeof api.refusal === 'function' ? api.refusal(id) : undefined),
        }),
        /**
         * A call into the program to make once the Release being answered is
         * done (`settleOwed`).
         *
         * @param {(thread: unknown) => unknown} call
         */
        owe(call){
            owed.push(call);
        },
        /**
         * The word of guest memory an object's count is kept in, placed there
         * now if it is not yet; 0 for an object that keeps it on the host.
         *
         * @param {any} api
         */
        countCell: api=>(cells ? cells.of(api.counter) : 0),
    };
}
