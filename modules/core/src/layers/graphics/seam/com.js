/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What the vtable publisher needs from an object, over what the drawing APIs
 * already are.
 *
 * The APIs behind this seam model their own lifetimes: a Direct3D surface
 * counts its references, a DirectDraw surface dies with its root, and both
 * decide when a Reset may proceed by looking at those counts. Handing them to
 * `createComObject` would give every object a second count that agrees with the
 * first only by accident, and the first is the one the API's own rules read.
 *
 * So this is an adapter, not an object model. It supplies the three members the
 * publisher actually calls -- `interfaceFor`, `addRef`, `release` -- and takes
 * all three from the API object underneath. Everything else about COM,
 * including QueryInterface, identity and the vtable layout, is already in
 * `bridge/internal/vtable.js` and is not repeated here.
 *
 * Identity is the one thing this file owns. The publisher memoises by object
 * *reference*, so one API object must produce one adapter however often it is
 * asked for; two adapters for one surface are two identities, and a program
 * comparing interface pointers then decides it holds two surfaces.
 */

import { IUNKNOWN_METHODS, IID_IUNKNOWN } from '../../win32/ole32/objects.js';

/**
 * @typedef {Object} InterfaceDescriptor
 * @property {string} id
 * @property {{ name: string, argBytes: number,
 *              invoke?: (target: any, args: number[]) => number,
 *              guest?: (builder: { trap: number }) => number }[]} methods
 *           In vtable order, after IUnknown's three unless `bare`. `target` is the API object,
 *           not the adapter: an implementation never sees this file.
 * @property {boolean} [bare]
 *           The interface does not derive from IUnknown, so its table starts
 *           with its own first method. Nothing can Release such a pointer: it
 *           lives as long as whatever handed it out says it does.
 * @property {(target: any, pointers: Iterable<number>) => void} [released]
 *           Told when the program lets go of the object's last reference,
 *           while its pointers still name it: state the guest set by pointer
 *           and the host has not yet read is adopted then, or never.
 */

/**
 * One method list per interface descriptor, shared by every object that
 * exposes it, as a compiled program shares one vtable among all instances of
 * a class. The publisher keys its table of stubs by the list's identity, so a
 * list built afresh for each object was a table of stubs per object -- and
 * the stubs come out of a table of sixteen thousand, which a program making a
 * thousand textures had used up. Each method is reached through the adapter
 * the call arrived on, which is what makes one list serve every object.
 *
 * @type {WeakMap<any, any[]>}
 */
const methodLists = new WeakMap();
/** IUnknown alone, one list for everyone: it names no method of the object's own. */
const IUNKNOWN_ONLY = Object.freeze([...IUNKNOWN_METHODS]);

/** @param {any} descriptor */
function methodsFor(descriptor){
    let methods = methodLists.get(descriptor);
    if (!methods)
    {
        methods = [
            ...(descriptor.bare ? [] : IUNKNOWN_METHODS),
            ...descriptor.methods.map((/** @type {any} */ method)=>({
                name: method.name,
                argBytes: method.argBytes,
                guest: method.guest,
                invoke: method.invoke
                    ? (/** @type {any} */ adapter, /** @type {number[]} */ args)=>
                        method.invoke(adapter.api, args) ?? 0
                    : undefined,
            })),
        ];
        methodLists.set(descriptor, methods);
    }
    return methods;
}

/**
 * @param {any} api        The drawing API's own object.
 * @param {InterfaceDescriptor[]} interfaces
 * @param {(adapter: any) => void} onGone  Called when the last reference goes.
 * @param {(adapter: any, id: string) => void} onReferenced
 *        Called when a reference is taken through an interface.
 * @returns {any} something the bridge's publisher will accept
 */
function adapt(api, interfaces, onGone, onReferenced){
    const declared = new Map(interfaces.map(entry=>[entry.id, entry]));

    /**
     * References a program took without crossing into the host -- a texture
     * level handed back by guest code -- are charged before the count is read
     * or lowered. Without it a Release for such a reference takes the count
     * one past what the program owes, and the object dies while it is held.
     */
    const settle = ()=>api.settleGuestRefs?.();
    /** Whether the latest release ended the object, which the bridge asks next. */
    let gone = false;

    const adapter = {
        api,
        // Every interface pointer goes with the object at the bridge then,
        // and not while the object says it outlives the count that went, as
        // a DirectDraw object does while another generation is held.
        get destroyed(){
            return gone;
        },
        // Where a method that runs in the guest finds the object's memory:
        // the object's own answer, or nothing for an object that keeps none.
        guestState: ()=>(typeof api.guestState === 'function' ? api.guestState() : 0),
        /**
         * Every pointer this object has been published as, so the map back can
         * be given up all at once when the object dies.
         *
         * @type {Set<number>}
         */
        pointers: new Set(),
        /** @param {string} id */
        interfaceFor(id){
            // IUnknown is every object's, and answers with one record whichever
            // interface it was reached through -- which is what a program
            // comparing two pointers is testing.
            if (id === IID_IUNKNOWN)
            {
                return { id, methods: IUNKNOWN_ONLY };
            }
            const descriptor = declared.get(id);
            if (!descriptor)
            {
                return null;
            }
            return { id, methods: methodsFor(descriptor) };
        },

        // Forwarded with the interface it was called through, because an API
        // whose generations count separately needs to know which one.
        /** @param {string} [id] */
        addRef(id){
            settle();
            if (id !== undefined)
            {
                onReferenced(adapter, id);
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
         *
         * @param {string} [id]
         */
        release(id){
            if (typeof api.release !== 'function')
            {
                return 0;
            }
            settle();
            const left = api.release(id);
            gone = left === 0 && api.destroyed !== false;
            if (gone)
            {
                for (const descriptor of declared.values())
                {
                    descriptor.released?.(api, adapter.pointers);
                }
                onGone(adapter);
            }
            return left;
        },
    };
    return adapter;
}

/**
 * Publishes API objects as COM interfaces, keeping one adapter per object.
 *
 * @param {Object} deps
 * @param {(object: any, interfaceId: string) => number} deps.publishInterface
 *        The bridge's, which lays the vtable out in guest memory.
 * @returns {{ publish: (api: any, interfaces: InterfaceDescriptor[], id: string) => number,
 *             objectAt: (pointer: number) => any,
 *             adapterFor: (api: any) => any, count: () => number }}
 */
export function createPublisher({ publishInterface }){
    /** Keyed by the API object, so one object is one identity. */
    const adapters = new WeakMap();

    /**
     * @param {any} api
     * @param {InterfaceDescriptor[]} interfaces
     */
    const adapterFor = (api, interfaces = [])=>{
        let adapter = adapters.get(api);
        if (!adapter)
        {
            adapter = adapt(api, interfaces, forget, remember);
            adapters.set(api, adapter);
        }
        return adapter;
    };

    /**
     * A pointer QueryInterface laid out, recorded when the reference it
     * carries is taken. The bridge answers a query from the object's own
     * interfaces without coming through `publish`, and a program then hands
     * that pointer back -- an IDirect3DTexture2 exists only as a query's
     * answer, and SetTexture takes one -- so without this the way back from
     * it knew nothing. Asking the bridge again is its memoised answer, the
     * pointer the program holds.
     *
     * @param {any} adapter @param {string} id
     */
    const remember = (adapter, id)=>{
        const pointer = publishInterface(adapter, id);
        if (pointer !== 0 && !adapter.pointers.has(pointer >>> 0))
        {
            byPointer.set(pointer >>> 0, adapter.api);
            adapter.pointers.add(pointer >>> 0);
        }
    };

    /** @param {any} adapter */
    const forget = adapter=>{
        for (const pointer of adapter.pointers)
        {
            byPointer.delete(pointer);
        }
        adapter.pointers.clear();
    };

    /**
     * The way back: an interface pointer the guest hands us, to the object it
     * names.
     *
     * A program passes interfaces around -- SetTexture, SetStreamSource,
     * SetRenderTarget all take one -- and what arrives is the pointer we
     * published, which nothing else can turn back into an object.
     *
     * The entry lives exactly as long as the object does. A strong map that
     * only ever grew would hold every object a program ever made for the life
     * of the process -- its guest vtable, its stubs and its storage with it --
     * and would keep a texture alive behind the weak table the renderer uses to
     * account for them, which is the same as having no accounting. Dropping the
     * entry when the last reference goes is safe because the vtable publisher
     * memoises by object: anything published again comes back as the same
     * pointer and is recorded here again.
     *
     * @type {Map<number, any>}
     */
    const byPointer = new Map();

    return {
        /**
         * @param {any} api
         * @param {InterfaceDescriptor[]} interfaces
         * @param {string} id  Which of them to hand back a pointer to.
         * @returns {number}
         */
        publish(api, interfaces, id){
            const adapter = adapterFor(api, interfaces);
            const pointer = publishInterface(adapter, id);
            if (pointer !== 0)
            {
                byPointer.set(pointer >>> 0, api);
                adapter.pointers.add(pointer >>> 0);
            }
            return pointer;
        },

        /**
         * The object an interface pointer names, or null. A null pointer is a
         * legitimate argument -- unbinding a texture is SetTexture with one --
         * so it answers null rather than refusing. So is a pointer whose object
         * has been released: a program that goes on using one is doing what it
         * would be doing on Windows, and answering null makes that a call that
         * fails rather than one that faults.
         *
         * @param {number} pointer
         */
        objectAt: pointer=>((pointer >>> 0) === 0
            ? null
            : byPointer.get(pointer >>> 0) ?? null),

        /** @param {any} api */
        adapterFor: api=>adapters.get(api) ?? null,

        /**
         * Interface pointers a program can still call through. It falls as
         * objects are released, and a build where it only ever rises is one
         * where nothing is being given back.
         */
        count: ()=>byPointer.size,
    };
}
