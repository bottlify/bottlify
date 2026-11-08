/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What every WIC object here is made with: its interfaces from wincodec.h's
 * layout (a derived interface repeating its bases' methods first), each
 * method's answer a CodecError turned into its HRESULT, a method this build
 * does not give said once as a divergence and answered E_NOTIMPL, and guest
 * memory read and written through the host.
 */

import { createComObject } from '../ole32/objects.js';
import { readGuid, writeGuid } from '../ole32/guid.js';
import { CodecError } from './frames.js';
import { INTERFACES } from './layout.js';

export const S_OK = 0;
export const S_FALSE = 1;
export const E_NOTIMPL = 0x80004001 | 0;
export const E_NOINTERFACE = 0x80004002 | 0;
export const E_POINTER = 0x80004003 | 0;
export const E_FAIL = 0x80004005 | 0;
export const E_OUTOFMEMORY = 0x8007000e | 0;
export const E_INVALIDARG = 0x80070057 | 0;

/**
 * What WIC needs of the rest of the system.
 *
 * @typedef {Object} CodecsHost
 * @property {import('../ole32/objects.js').ComRegistry} registry
 * @property {{ publish: (object: import('../ole32/objects.js').ComObject, iid: string) => number }}
 *     vtables
 * @property {(pointer: number) => any} objectAt  the object behind a pointer this engine published
 * @property {{ allocate: (bytes: number) => number, free: (address: number) => void }} heap
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number, maxLength: number) => string} readWideString
 * @property {(call: { entry: number, args: number[], thread?: unknown }) => Promise<number>}
 *     callGuest
 * @property {() => unknown} currentThread
 * @property {(path: string) => Promise<Uint8Array | null>} readFile
 * @property {(handle: number) => Promise<Uint8Array | null>} [readHandle]
 *     a file handle's whole contents, or null for no file
 * @property {(handle: number) => { width: number, height: number, bgra: Uint8Array,
 *     alpha: boolean } | null} [bitmapOf]  an HBITMAP's pixels, top-down
 * @property {(handle: number) => { width: number, height: number, bgra: Uint8Array } | null}
 *     [iconOf]  an HICON's pixels, its mask made alpha
 * @property {(section: number, offset: number, bytes: number) => number} [mapSection]
 *     a view of a section, 0 when it cannot be had
 * @property {(api: string, detail: string, kind?: string) => void} [divergence]
 */

/**
 * The methods of an interface and its bases, IUnknown's left out, and the
 * chain of interfaces from the first base on.
 *
 * @param {string} name
 * @returns {{ chain: string[], methods: [string, number][] }}
 */
export function flatten(name){
    /** @type {string[]} */
    const chain = [];
    for (let at = name; at !== 'IUnknown'; at = INTERFACES[at].base)
    {
        if (!INTERFACES[at])
        {
            throw new Error(`no layout for ${at}`);
        }
        chain.unshift(at);
    }
    return { chain, methods: chain.flatMap(n=>INTERFACES[n].methods) };
}

/**
 * @typedef {(object: import('../ole32/objects.js').ComObject, args: number[])
 *     => number | Promise<number>} Method
 */

/** @param {CodecsHost} host */
export function createKit(host){
    /** @type {Set<string>} */
    const said = new Set();
    /**
     * Each object's definition: COM's registry makes its own object of a
     * class's definition, so a class registered with it hands over the
     * definition one of ours was made of (its state lives in the closures).
     *
     * @type {WeakMap<object, import('../ole32/objects.js').ComClassDefinition>}
     */
    const definitions = new WeakMap();
    /** @param {string} api @param {string} detail */
    const diverge = (api, detail)=>{
        if (!said.has(`${api}:${detail}`))
        {
            said.add(`${api}:${detail}`);
            host.divergence?.(api, detail);
        }
    };

    /** @param {unknown} e @returns {number} */
    const answer = e=>{
        if (e instanceof CodecError)
        {
            return e.hr;
        }
        throw e;
    };

    /** @param {Method} fn @returns {Method} */
    const guarded = fn=>(object, args)=>{
        try
        {
            const result = fn(object, args);
            return typeof result === 'number' ? result : result.catch(answer);
        }
        catch (e){
            return answer(e);
        }
    };

    /**
     * Interface descriptors for `names` and every base of theirs, each method
     * the implementation's or, missing there, E_NOTIMPL said once.
     *
     * @param {string[]} names @param {Record<string, Method>} impl
     * @returns {import('../ole32/objects.js').ComInterfaceDescriptor[]}
     */
    const descriptors = (names, impl)=>{
        /** @type {Map<string, import('../ole32/objects.js').ComInterfaceDescriptor>} */
        const out = new Map();
        for (const name of names)
        {
            const { chain } = flatten(name);
            chain.forEach((link, i)=>{
                const { iid } = INTERFACES[link];
                if (out.has(iid))
                {
                    return;
                }
                const methods = flatten(chain[i]).methods.map(([method, argBytes])=>{
                    const own = impl[method];
                    return { name: method, argBytes, invoke: own ? guarded(own)
                        : ()=>{
                            diverge(`${link}::${method}`, 'not provided');
                            return E_NOTIMPL;
                        } };
                });
                out.set(iid, { id: iid, methods });
            });
        }
        return [...out.values()];
    };

    /** @param {number} at */
    const u32 = at=>new DataView(host.readMemory(at >>> 0, 4).slice().buffer).getUint32(0, true);
    /** @param {number} at */
    const i32 = at=>u32(at) | 0;
    /** @param {number} at @param {number} value */
    const putU32 = (at, value)=>{
        const bytes = new Uint8Array(4);
        new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
        host.writeMemory(at >>> 0, bytes);
    };
    /** @param {number} at @param {number} value */
    const putF64 = (at, value)=>{
        const bytes = new Uint8Array(8);
        new DataView(bytes.buffer).setFloat64(0, value, true);
        host.writeMemory(at >>> 0, bytes);
    };
    /** A double passed by value: its two halves among the arguments. @param {number} lo @param {number} hi */
    const f64 = (lo, hi)=>{
        const view = new DataView(new ArrayBuffer(8));
        view.setUint32(0, lo >>> 0, true);
        view.setUint32(4, hi >>> 0, true);
        return view.getFloat64(0, true);
    };
    /** @param {number} at */
    const guid = at=>readGuid(host, at >>> 0);
    /** @param {number} at @param {string} value */
    const putGuid = (at, value)=>writeGuid(host, at >>> 0, value);
    /** A WICRect, or null for a null pointer. @param {number} at */
    const rect = at=>(at === 0 ? null
        : { x: i32(at), y: i32(at + 4), width: i32(at + 8), height: i32(at + 12) });

    /**
     * A WIC string getter's contract: (cch, buffer, pcchActual). The length
     * with its NUL is said whenever there is somewhere to say it, before a
     * size with no buffer is refused (Wine's info test); a buffer too small
     * answers WINCODEC_ERR_INSUFFICIENTBUFFER.
     *
     * @param {string} text @param {number} cch @param {number} buffer @param {number} actual
     */
    const giveString = (text, cch, buffer, actual)=>{
        if (actual === 0)
        {
            return E_INVALIDARG;
        }
        putU32(actual, text.length + 1);
        if (buffer === 0)
        {
            return cch === 0 ? S_OK : E_INVALIDARG;
        }
        if (cch < text.length + 1)
        {
            return 0x88982f8c | 0;
        }
        const bytes = new Uint8Array((text.length + 1) * 2);
        for (let i = 0; i < text.length; i++)
        {
            bytes[i * 2] = text.charCodeAt(i) & 0xff;
            bytes[i * 2 + 1] = text.charCodeAt(i) >> 8;
        }
        host.writeMemory(buffer >>> 0, bytes);
        return S_OK;
    };

    /**
     * A guest object's method by its vtable slot, its HRESULT.
     *
     * @param {unknown} thread @param {number} pointer @param {number} slot @param {number[]} args
     */
    const method = (thread, pointer, slot, args)=>host.callGuest({
        entry: u32(u32(pointer) + slot * 4), args: [pointer >>> 0, ...args.map(a=>a >>> 0)],
        ...(thread === undefined ? {} : { thread }) }).then(hr=>hr | 0);

    /**
     * An object of ours, made with the interfaces named and published
     * through `out` as the first; at no `out`, released and E_INVALIDARG.
     *
     * @param {string} clsid @param {string[]} names @param {Record<string, Method>} impl
     * @param {any} state
     * @param {{ destroy?: () => void, lastRelease?: () => Promise<void> | void }} [hooks]
     */
    const make = (clsid, names, impl, state, hooks = {})=>{
        const definition = { interfaces: descriptors(names, impl), state, ...hooks };
        const object = createComObject(clsid, definition);
        definitions.set(object, definition);
        return object;
    };

    /**
     * Publishes `object` as `name` into `out`; with no `out` releases it.
     *
     * @param {import('../ole32/objects.js').ComObject} object @param {string} name
     * @param {number} out
     */
    const hand = (object, name, out)=>{
        if (out === 0)
        {
            object.release();
            return E_INVALIDARG;
        }
        const pointer = host.vtables.publish(object, INTERFACES[name].iid) >>> 0;
        putU32(out, pointer);
        return pointer === 0 ? E_OUTOFMEMORY : S_OK;
    };

    /** @param {import('../ole32/objects.js').ComObject} object */
    const definitionOf = object=>/** @type {import('../ole32/objects.js').ComClassDefinition} */ (
        definitions.get(object));

    return { diverge, descriptors, make, definitionOf, hand, method, u32, i32, putU32, putF64,
        f64, guid,
        putGuid, rect, giveString };
}

/** @typedef {ReturnType<typeof createKit>} Kit */
