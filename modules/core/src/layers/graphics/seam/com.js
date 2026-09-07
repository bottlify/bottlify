/*
 * Copyright © 2026 Bottlify Project
 * Licensed under BSD-2-Clause License
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
 *              invoke?: (target: any, args: number[]) => number }[]} methods
 *           In vtable order, after IUnknown's three. `target` is the API object,
 *           not the adapter: an implementation never sees this file.
 */

/**
 * @param {any} api        The drawing API's own object.
 * @param {InterfaceDescriptor[]} interfaces
 * @returns {any} something the bridge's publisher will accept
 */
function adapt(api, interfaces){
    const declared = new Map(interfaces.map(entry=>[entry.id, entry]));

    const adapter = {
        api,
        /** @param {string} id */
        interfaceFor(id){
            // IUnknown is every object's, and answers with one record whichever
            // interface it was reached through -- which is what a program
            // comparing two pointers is testing.
            const descriptor = id === IID_IUNKNOWN
                ? { id, methods: [] }
                : declared.get(id);
            if (!descriptor)
            {
                return null;
            }
            return {
                id,
                methods: [
                    ...IUNKNOWN_METHODS,
                    ...descriptor.methods.map(method=>({
                        name: method.name,
                        argBytes: method.argBytes,
                        invoke: method.invoke
                            ? (/** @type {any} */ unused, /** @type {number[]} */ args)=>
                                method.invoke?.(api, args) ?? 0
                            : undefined,
                    })),
                ],
            };
        },

        addRef: ()=>api.addRef?.() ?? 1,
        release: ()=>api.release?.() ?? 0,
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
            adapter = adapt(api, interfaces);
            adapters.set(api, adapter);
        }
        return adapter;
    };

    /**
     * The way back: an interface pointer the guest hands us, to the object it
     * names.
     *
     * A program passes interfaces around -- SetTexture, SetStreamSource,
     * SetRenderTarget all take one -- and what arrives is the pointer we
     * published, which nothing else can turn back into an object. Kept as a
     * plain map rather than a weak one because a published pointer stays valid
     * as long as guest memory does, and forgetting it would mean handing the
     * guest an address that no longer resolves.
     *
     * @type {Map<number, any>}
     */
    const byPointer = new Map();

    let published = 0;
    return {
        /**
         * @param {any} api
         * @param {InterfaceDescriptor[]} interfaces
         * @param {string} id  Which of them to hand back a pointer to.
         * @returns {number}
         */
        publish(api, interfaces, id){
            const pointer = publishInterface(adapterFor(api, interfaces), id);
            if (pointer !== 0)
            {
                byPointer.set(pointer >>> 0, api);
                published++;
            }
            return pointer;
        },

        /**
         * The object an interface pointer names, or null. A null pointer is a
         * legitimate argument -- unbinding a texture is SetTexture with one --
         * so it answers null rather than refusing.
         *
         * @param {number} pointer
         */
        objectAt: pointer=>((pointer >>> 0) === 0
            ? null
            : byPointer.get(pointer >>> 0) ?? null),

        /** @param {any} api */
        adapterFor: api=>adapters.get(api) ?? null,

        count: ()=>published,
    };
}
