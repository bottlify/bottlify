/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Publishing a library's own objects as COM interfaces, written once.
 *
 * The bridge's vtable publisher (`internal/vtable.js`) lays an interface out
 * in guest memory and answers IUnknown's three for whatever object it is
 * handed: QueryInterface by `interfaceFor`, AddRef and Release by the
 * object's own. A library whose objects model their own lifetimes -- a
 * Direct3D surface, a DirectSound buffer, a DirectInput device -- cannot be
 * handed over as it is: its methods take the library's object, not a COM
 * record, and its counts follow the library's rules. So it is handed over
 * through an adapter, and this is that adapter, the same for every library:
 *
 * - **identity**: one adapter per library object, however often it is
 *   published, because the bridge memoises by the object it is given and two
 *   adapters for one buffer are two identities to a program comparing
 *   pointers;
 * - **the table**: one method list per interface description, IUnknown's
 *   three first (but for a `bare` one), each method run on the library's
 *   object; shared by every object of that description, as a compiled program
 *   shares one vtable among all instances of a class -- a list per object
 *   built a table of stubs per object, and the stubs come out of a table of
 *   sixteen thousand;
 * - **QueryInterface's answer**: IID_IUnknown answers one record whichever
 *   interface it is asked through (or the interface marked `unknown`), a
 *   `sharedWith` interface answers with the pointer of the one whose table
 *   holds its slots and more, anything else undeclared is refused and counted;
 * - **the way back**: the library object behind a pointer a program hands in,
 *   for as long as the bridge keeps that pointer.
 *
 * What differs between libraries -- how references are counted -- is what a
 * library gives as `counting`.
 */

/** IID_IUnknown. Every object answers to it. */
export const IID_IUNKNOWN = '{00000000-0000-0000-C000-000000000046}';

/** The head of every COM vtable, in the only order it is ever in. */
export const IUNKNOWN_METHODS = Object.freeze([
    Object.freeze({ name: 'QueryInterface', argBytes: 12, builtin: 'queryInterface' }),
    Object.freeze({ name: 'AddRef', argBytes: 4, builtin: 'addRef' }),
    Object.freeze({ name: 'Release', argBytes: 4, builtin: 'release' }),
]);

/**
 * @typedef {Object} ComMethodDescription
 * @property {string} name
 * @property {number} argBytes  Counting the interface pointer.
 * @property {(target: any, args: number[]) => any} [invoke]
 *           `target` is whatever the table's methods run on: the published
 *           object itself (`methodTable`), or the library's object behind an
 *           adapter (`createComPublisher`).
 * @property {(builder: import('./internal/vtable.js').GuestSlotBuilder) => number} [guest]
 *           Guest code for the slot (`internal/vtable.js`).
 * @property {(call: number[]) => number | undefined} [inPlace]
 */

/**
 * @typedef {Object} ComInterfaceDescription
 * @property {string} id
 * @property {readonly ComMethodDescription[]} methods
 *           In vtable order, after IUnknown's three unless `bare`.
 * @property {boolean} [bare]
 *           The interface does not derive from IUnknown: its table starts with
 *           its own first method, and nothing can Release its pointer.
 * @property {string} [sharedWith]
 *           The interface this one is a front part of: asked for, it answers
 *           with that one's pointer and table, as single inheritance lays it
 *           out. Ignored where that interface is not declared beside it.
 * @property {boolean} [unknown]
 *           This interface's pointer is the object's IUnknown.
 * @property {(target: any, pointers: Iterable<number>) => void} [released]
 *           Not read here: a counting that ends objects calls it
 *           (`graphics/seam/com.js`).
 */

/** @type {WeakMap<object, readonly any[]>} */
const tables = new WeakMap();

/**
 * An interface's whole method list, IUnknown's three first unless it is
 * bare, made once per description: the bridge builds a table of stubs once
 * per list, so every object of one description has to hand it the same one.
 * Each method is run on the object the bridge was given.
 *
 * @param {{ methods: readonly any[], bare?: boolean }} description
 * @returns {readonly any[]}
 */
export function methodTable(description){
    let table = tables.get(description);
    if (!table)
    {
        table = Object.freeze([...description.bare ? [] : IUNKNOWN_METHODS,
            ...description.methods]);
        tables.set(description, table);
    }
    return table;
}

/** @type {WeakMap<object, readonly any[]>} */
const adaptedTables = new WeakMap();

/**
 * The same list, each method run on the library's object behind the adapter
 * the call arrived through rather than on the adapter, which is what lets one
 * list serve every object of its description. A method's undefined answer is
 * S_OK.
 *
 * @param {ComInterfaceDescription} description
 */
function adaptedTable(description){
    let table = adaptedTables.get(description);
    if (!table)
    {
        table = methodTable({ bare: description.bare, methods: description.methods.map(method=>{
            const invoke = method.invoke;
            return invoke
                ? { ...method, invoke: (/** @type {any} */ adapter, /** @type {number[]} */ args)=>
                    invoke(adapter.api, args) ?? 0 }
                : method;
        }) });
        adaptedTables.set(description, table);
    }
    return table;
}

/**
 * What a counting is given for its object.
 *
 * @typedef {Object} ComSeat
 * @property {any} api  The library's object.
 * @property {ReadonlyMap<string, ComInterfaceDescription>} declared
 *           Its interfaces, by id, as the first publish named them.
 * @property {Set<number>} pointers  Every pointer the way back knows for it.
 * @property {(id: string) => void} remember
 *           Puts the pointer the bridge has laid out for `id` on the way back:
 *           a pointer QueryInterface answered never came through `publish`,
 *           and a program hands such pointers back too.
 * @property {() => void} forgetAll
 *           The way back from every pointer goes, for an object that is over.
 */

/**
 * How one object's references are counted: what the bridge's AddRef and
 * Release, and its questions after a release, are answered with.
 *
 * @typedef {Object} ComCounting
 * @property {(id: string | undefined) => number} addRef
 *           With the interface it came through, for a library that counts per
 *           interface; undefined for one the host takes itself.
 * @property {(id: string | undefined) => number} release
 * @property {() => boolean} destroyed
 *           Whether the latest release ended the object, and with it every
 *           interface it was published as; otherwise a zero ends only the one
 *           it came through.
 * @property {(id: string) => boolean} [reachable]
 *           Whether an interface at a count of zero may still be called
 *           through the pointer the program kept.
 * @property {() => number} [guestState]  `internal/vtable.js`'s state word.
 * @property {() => number} [countCell]   `internal/vtable.js`'s count word.
 */

/**
 * The counting an object gets when its library says nothing: every call is
 * the library object's own, and it says when it is over with `destroyed`.
 *
 * @param {ComSeat} seat
 * @returns {ComCounting}
 */
export const countedByTheObject = ({ api })=>({
    addRef: id=>api.addRef?.(id) ?? 1,
    release: id=>api.release?.(id) ?? 0,
    destroyed: ()=>api.destroyed === true,
    reachable: id=>api.reachable?.(id) === true,
});

/**
 * @typedef {Object} ComPublisher
 * @property {(api: any, interfaces: readonly ComInterfaceDescription[], id: string,
 *             context?: any) => number} publish
 *           The pointer for `id`, 0 where the bridge refused it. The first
 *           publish of an object fixes its interfaces and its counting
 *           (`context` is handed to `counting` then).
 * @property {(api: any) => void} unpublish
 *           Gives back every interface the object was published as, for one
 *           the program has no Release for.
 * @property {(pointer: number) => any} objectAt
 *           The library object a pointer names; null for 0, for a pointer not
 *           published here and for one whose object was let go.
 * @property {(api: any) => any} adapterFor  The adapter, or null.
 * @property {() => number} count  Pointers the way back still knows.
 * @property {() => Record<string, number>} refused
 *           Interface ids asked for and refused, with counts: a program that
 *           did not get one takes another path silently, and which one it
 *           wanted is the only trace of that.
 */

/**
 * @param {Object} deps
 * @param {(object: any, interfaceId: string) => number} deps.publishInterface
 *        The bridge's.
 * @param {(object: any, interfaceId: string) => boolean} [deps.unpublishInterface]
 *        The bridge's; without it `unpublish` forgets only the way back.
 * @param {(seat: ComSeat, context: any) => ComCounting} [deps.counting]
 *        `countedByTheObject` where not given.
 * @param {(api: any, id: string) => boolean} [deps.offers]
 *        Whether an object answers to a declared interface now: one
 *        interface list can serve objects that do not all answer to all of
 *        it. Not asked for IID_IUnknown.
 * @param {'pointer'} [deps.nullInterface]
 *        QueryInterface with no interface id answers E_POINTER and leaves the
 *        out pointer alone (`internal/vtable.js`).
 * @returns {ComPublisher}
 */
export function createComPublisher({ publishInterface, unpublishInterface,
    counting = countedByTheObject, offers, nullInterface })
{
    /** Keyed by the library's object, so one object is one identity. */
    const adapters = new WeakMap();
    /**
     * The way back. An entry lives as long as the bridge keeps its pointer
     * (`forgotten`) or until the counting says the object is over: a map that
     * only grew would keep every object a program ever made, and its guest
     * memory, for the life of the process.
     *
     * @type {Map<number, any>}
     */
    const byPointer = new Map();
    /** @type {Record<string, number>} */
    const refusals = {};

    /** @param {any} adapter @param {number} pointer */
    const record = (adapter, pointer)=>{
        byPointer.set(pointer >>> 0, adapter.api);
        adapter.pointers.add(pointer >>> 0);
    };

    /** @param {any} adapter */
    const forgetAll = adapter=>{
        for (const pointer of adapter.pointers)
        {
            byPointer.delete(pointer);
        }
        adapter.pointers.clear();
    };

    /**
     * @param {any} api @param {readonly ComInterfaceDescription[]} interfaces
     * @param {any} context
     */
    const adapt = (api, interfaces, context)=>{
        const declared = new Map(interfaces.map(entry=>[entry.id, entry]));
        /** @param {string} id */
        const refuse = id=>{
            refusals[id] = (refusals[id] ?? 0) + 1;
            return null;
        };
        /** @type {Set<number>} */
        const pointers = new Set();
        /** @type {Set<string>} */
        const ids = new Set();
        /** @type {ComCounting} */
        let counts;
        const adapter = {
            api,
            pointers,
            /** The interfaces it was published as: what `unpublish` gives back. */
            ids,
            ...nullInterface === undefined ? {} : { nullInterface },
            /** @param {string} id */
            interfaceFor(id){
                const unknown = id === IID_IUNKNOWN;
                if (!unknown && offers && !offers(api, id))
                {
                    return refuse(id);
                }
                const named = unknown
                    ? interfaces.find(entry=>entry.unknown === true)
                    : declared.get(id);
                if (!named)
                {
                    return unknown ? { id, methods: IUNKNOWN_METHODS } : refuse(id);
                }
                const whole = named.sharedWith === undefined
                    ? undefined
                    : declared.get(named.sharedWith);
                const answer = whole ?? named;
                return answer.id === id
                    ? { id, methods: adaptedTable(answer) }
                    : { id, sharedWith: answer.id, methods: adaptedTable(answer) };
            },
            /** @param {string} [id] */
            addRef: id=>counts.addRef(id),
            /** @param {string} [id] */
            release: id=>counts.release(id),
            get destroyed(){
                return counts.destroyed();
            },
            /** @param {string} id */
            reachable: id=>counts.reachable?.(id) ?? false,
            guestState: ()=>counts.guestState?.() ?? 0,
            countCell: ()=>counts.countCell?.() ?? 0,
            /** @param {number} pointer */
            forgotten(pointer){
                if (pointers.delete(pointer >>> 0))
                {
                    byPointer.delete(pointer >>> 0);
                }
            },
        };
        counts = counting({
            api,
            declared,
            pointers,
            remember: id=>{
                const pointer = publishInterface(adapter, id);
                if (pointer !== 0 && !pointers.has(pointer >>> 0))
                {
                    record(adapter, pointer);
                    ids.add(id);
                }
            },
            forgetAll: ()=>forgetAll(adapter),
        }, context);
        return adapter;
    };

    return {
        publish(api, interfaces, id, context){
            let adapter = adapters.get(api);
            if (!adapter)
            {
                adapter = adapt(api, interfaces, context);
                adapters.set(api, adapter);
            }
            const pointer = publishInterface(adapter, id);
            if (pointer !== 0)
            {
                record(adapter, pointer);
                adapter.ids.add(id);
            }
            return pointer;
        },
        unpublish(api){
            const adapter = adapters.get(api);
            if (!adapter)
            {
                return;
            }
            for (const id of adapter.ids)
            {
                unpublishInterface?.(adapter, id);
            }
            adapter.ids.clear();
            forgetAll(adapter);
        },
        objectAt: pointer=>((pointer >>> 0) === 0 ? null : byPointer.get(pointer >>> 0) ?? null),
        adapterFor: api=>adapters.get(api) ?? null,
        count: ()=>byPointer.size,
        refused: ()=>({ ...refusals }),
    };
}
