/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Which proxy/stub class marshals an interface, and its class object.
 *
 * The class is the one the process registered for itself (CoRegisterPSClsid)
 * ahead of the one the registry names under Interface\{iid}\ProxyStubClsid32.
 * Its class object, an IPSFactoryBuffer, is one the process registered
 * (CoRegisterClassObject) ahead of the DLL the registry names: a module that
 * brings its own proxies registers both and writes nothing to the registry.
 * Such a class object is asked again each time and never kept, since the
 * module behind it revokes it and is unloaded while the process goes on, and
 * may be loaded again elsewhere. A DLL's class object is loaded once and held,
 * as COM holds the DLLs it loads. The universal marshaler's classes are not of
 * this kind: a type library describes what they marshal.
 */

import { canonicalGuid } from './guid.js';

const PSOAINTERFACE = '{00020424-0000-0000-C000-000000000046}';
const PSDISPATCH = '{00020420-0000-0000-C000-000000000046}';

/**
 * @typedef {Object} ProxyStubHost
 * @property {(iid: string) => string | null} registryClass
 *     Interface\{iid}\ProxyStubClsid32, or null.
 * @property {(clsid: string, thread: unknown) => number | Promise<number>} registeredFactory
 *     The IPSFactoryBuffer of a class object the process registered for
 *     `clsid`, with a reference the caller gives back; 0 when none is
 *     registered or it is no factory.
 * @property {(factory: number, thread: unknown) => any} release  A reference given back.
 * @property {(clsid: string, thread: unknown) => Promise<number>} loadFactory
 *     The IPSFactoryBuffer of the DLL the registry names for `clsid`, or 0.
 * @property {(detail: string) => void} [divergence]
 */

/** @param {ProxyStubHost} host */
export function createProxyStubs(host){
    /** The classes the process registered for itself, by interface. @type {Map<string, string>} */
    const own = new Map();
    /** The DLLs' class objects, by class. @type {Map<string, Promise<number>>} */
    const loaded = new Map();

    /**
     * @param {string} iid
     * @returns {string | null}
     */
    const classOf = iid=>own.get(canonicalGuid(iid) ?? '')
        ?? canonicalGuid(host.registryClass(iid) ?? '');

    return {
        /** @param {string} iid @param {string} clsid */
        register(iid, clsid){
            own.set(canonicalGuid(iid) ?? iid, canonicalGuid(clsid) ?? clsid);
        },

        classOf,

        /**
         * The interface's IPSFactoryBuffer, or 0.
         *
         * @param {string} iid @param {unknown} thread  whose call needs it
         * @returns {Promise<number>}
         */
        async factory(iid, thread){
            const clsid = classOf(iid);
            if (clsid === null || clsid === PSOAINTERFACE || clsid === PSDISPATCH)
            {
                return 0;
            }
            const registered = (await host.registeredFactory(clsid, thread)) >>> 0;
            if (registered !== 0)
            {
                // The registration holds the object; the reference the
                // query took is given back at once.
                await host.release(registered, thread);
                return registered;
            }
            const known = loaded.get(clsid);
            if (known)
            {
                return known;
            }
            const loading = host.loadFactory(clsid, thread).then(factory=>{
                if (factory === 0)
                {
                    host.divergence?.(`the proxy/stub class ${clsid} of ${iid} gave no`
                        + ' IPSFactoryBuffer');
                    loaded.delete(clsid);
                }
                return factory;
            });
            loaded.set(clsid, loading);
            return loading;
        },
    };
}
