/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Module stubs: stand-ins for disabled modules and for layers that are not yet
 * implemented. Any call to a stub method throws NOT_IMPLEMENTED.
 */

/**
 * Builds a stub API: any unknown method throws NOT_IMPLEMENTED.
 *
 * @param {string} moduleName
 * @returns {any}
 */
export function createStubApi(moduleName){
    const marker = `[stub:${moduleName}]`;
    const proxy = new Proxy({ marker }, {
        get(target, prop){
            if (prop === 'marker')
            {
                return target.marker;
            }
            if (prop === 'then')
            {
                return undefined; // keep the stub a non-thenable
            }
            if (typeof prop === 'symbol')
            {
                return undefined;
            }
            const method = ()=>{
                const error = /** @type {Error & { code: string }} */ (
                    new Error(`NOT_IMPLEMENTED: ${moduleName}.${String(prop)}`));
                error.code = 'NOT_IMPLEMENTED';
                throw error;
            };
            Object.defineProperty(method, 'name',
                { value: `${moduleName}:${String(prop)}`, configurable: true });
            return method;
        },
    });
    return proxy;
}

/**
 * Builds a stub module definition following the BottlifyModule contract.
 *
 * @param {string} name
 * @param {string} version
 * @param {readonly string[]} [requires]
 * @returns {import("./contract.js").BottlifyModule}
 */
export function createStubModule(name, version, requires = []){
    return Object.freeze({
        name,
        version,
        requires: Object.freeze([...requires]),
        async create(){
            return createStubApi(name);
        },
        diagnostics(){
            return {
                name, version, status: 'stub',
                metrics: { methods: 'any', code: 'NOT_IMPLEMENTED' },
            };
        },
        async dispose(){},
    });
}
