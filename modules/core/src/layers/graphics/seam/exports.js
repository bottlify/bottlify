/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The libraries a program links against to reach any of this.
 *
 * Every drawing API in this layer is unreachable without these: a program does
 * not construct a Direct3D object, it calls `Direct3DCreate8` in `d3d8.dll` and
 * is handed one. So these tables are shaped exactly like a win32 library's --
 * `{ Name: { argBytes, handler } }` -- and the caller assembling the process
 * binds them the same way, with no special case for graphics.
 *
 * The COM entry points are thin by design. Each makes one object and publishes
 * one interface; everything a program does afterwards goes through the vtable
 * rather than through here, which is why this file is short and `d3d8.js` is
 * not.
 *
 * OpenGL has no COM at all -- its entry points are flat C functions -- so its
 * table is built from the context object directly rather than declared.
 */

import { createPublisher } from './com.js';
import { createDirect3D8Seam } from './d3d8.js';
import { describe, IDIRECT3D9_SLOTS, IDIRECTDRAW7_SLOTS } from './vtables.js';
import { IID_IDirect3D9, IID_IDirectDraw7 } from './iids.js';
import { createFields } from './structs.js';

const DD_OK = 0;
const D3DERR_INVALIDCALL = 0x8876086c | 0;
/** DDERR_INVALIDPARAMS. */
const DDERR_INVALIDPARAMS = 0x80070057 | 0;
/** E_OUTOFMEMORY, which is what a create that cannot make an object reports. */
const E_OUTOFMEMORY = 0x8007000e | 0;

/**
 * Every entry point in one place.
 *
 * @param {Object} deps
 * @param {any} deps.graphics   The graphics api: create(name), available().
 * @param {any} deps.memory     readMemory/writeMemory.
 * @param {(object: any, interfaceId: string) => number} deps.publishInterface
 * @param {() => any} deps.screen
 * @returns {{ libraries: Record<string, Record<string, any>>, diagnostics: () => any }}
 */
export function createGraphicsLibraries({ graphics, memory, publishInterface, screen }){
    const publisher = createPublisher({ publishInterface });
    const fields = createFields(memory);
    const d3d8 = createDirect3D8Seam({ publisher, memory, screen });

    /** What a program has actually asked us to make, for a report. */
    /** @type {string[]} */
    const created = [];

    /**
     * The shape every creation entry point shares: make the object, publish it,
     * write the pointer back. A null place to write it is the one failure that
     * is the caller's rather than ours.
     *
     * @param {string} api
     * @param {number} out
     * @param {(object: any) => number} publish
     */
    const createInto = (api, out, publish)=>{
        if ((out >>> 0) === 0)
        {
            return DDERR_INVALIDPARAMS;
        }
        const object = graphics.create(api);
        if (!object)
        {
            fields.writeU32(out >>> 0, 0);
            return E_OUTOFMEMORY;
        }
        created.push(api);
        fields.writeU32(out >>> 0, publish(object));
        return DD_OK;
    };

    // Direct3D 9's object is the same shape as 8's and differs only in its
    // vtable, so it is published with 9's slots and no marshalling of its own
    // yet -- every method answers E_NOTIMPL, which is honest, where a wrong
    // implementation would not be.
    const d3d9Interfaces = [describe(IID_IDirect3D9, IDIRECT3D9_SLOTS)];
    const ddrawInterfaces = [describe(IID_IDirectDraw7, IDIRECTDRAW7_SLOTS)];

    const libraries = {
        'D3D8.dll': {
            /**
             * IDirect3D8* Direct3DCreate8(UINT SDKVersion)
             *
             * The only entry point in the library, and the odd one out among
             * these: it returns the interface pointer rather than writing it
             * through an out-parameter, and reports failure as null.
             */
            Direct3DCreate8: {
                argBytes: 4,
                handler: ()=>{
                    const root = graphics.create('d3d8');
                    if (!root)
                    {
                        return 0;
                    }
                    created.push('d3d8');
                    return d3d8.publishRoot(root);
                },
            },
        },

        'D3D9.dll': {
            /** IDirect3D9* Direct3DCreate9(UINT SDKVersion) */
            Direct3DCreate9: {
                argBytes: 4,
                handler: ()=>{
                    const root = graphics.create('d3d9');
                    if (!root)
                    {
                        return 0;
                    }
                    created.push('d3d9');
                    return publisher.publish(root, d3d9Interfaces, IID_IDirect3D9);
                },
            },
        },

        'DDRAW.dll': {
            /** HRESULT DirectDrawCreate(GUID*, LPDIRECTDRAW*, IUnknown*) */
            DirectDrawCreate: {
                argBytes: 12,
                /** @param {number[]} args */
                handler: ([, out])=>createInto('ddraw', out,
                    object=>publisher.publish(object, ddrawInterfaces, IID_IDirectDraw7)),
            },

            /**
             * HRESULT DirectDrawCreateEx(GUID*, LPVOID*, REFIID, IUnknown*)
             *
             * The identifier the caller passes is which interface it wants, and
             * DirectDraw refuses anything but IDirectDraw7 here -- the whole
             * point of the Ex form is that it is the modern one.
             */
            DirectDrawCreateEx: {
                argBytes: 16,
                /** @param {number[]} args */
                handler: ([, out])=>createInto('ddraw', out,
                    object=>publisher.publish(object, ddrawInterfaces, IID_IDirectDraw7)),
            },

            /**
             * HRESULT DirectDrawEnumerateA(LPDDENUMCALLBACKA, LPVOID)
             *
             * Enumeration needs to call back into guest code once per device.
             * There is one device and the callback machinery is the bridge's,
             * not this table's, so this reports success having enumerated
             * nothing -- which a caller reads as "no secondary devices" and
             * handles, since that is the common case on a real machine.
             */
            DirectDrawEnumerateA: { argBytes: 8, handler: ()=>DD_OK },

            /** HRESULT DirectDrawCreateClipper(DWORD, LPDIRECTDRAWCLIPPER*, IUnknown*) */
            DirectDrawCreateClipper: {
                argBytes: 12,
                handler: ()=>D3DERR_INVALIDCALL,
            },
        },
    };

    return {
        libraries,
        diagnostics: ()=>({
            created: [...created],
            interfaces: publisher.count(),
        }),
    };
}

/**
 * OpenGL's table, built from the objects that implement it.
 *
 * These are flat C functions taking dwords, so the table is derived rather than
 * transcribed: a method's declared parameter count is its argument count, and
 * four bytes each. That derivation is sound only while every argument is one
 * word wide, which is true of the functions here and is asserted beside this
 * file -- a double-precision entry point would take two words and break it
 * silently, in the way a wrong argBytes always does.
 *
 * @param {Object} sources
 * @param {any} sources.wgl      createWgl's object.
 * @param {any} sources.context  createGlContext's object, or null before one exists.
 * @returns {Record<string, any>}
 */
export function createOpenglTable({ wgl, context }){
    /** @type {Record<string, any>} */
    const table = {};

    /** @param {any} owner @param {string} name */
    const add = (owner, name)=>{
        const fn = owner[name];
        if (typeof fn !== 'function')
        {
            return;
        }
        table[name] = {
            argBytes: fn.length * 4,
            /** @param {number[]} args */
            handler: args=>{
                const answer = fn.apply(owner, args);
                // A GL function that answers nothing answers zero: the guest
                // reads EAX either way, and leaving it as whatever the last
                // call left there is a value a program may believe.
                return typeof answer === 'number' ? answer | 0 : Number(answer ?? 0) | 0;
            },
        };
    };

    for (const name of Object.keys(wgl ?? {}))
    {
        // Only the exported spellings: the object also carries helpers, and a
        // helper in an export table is a name a program could import and reach
        // something that was never meant to be an entry point.
        const exported = /^(Choose|Describe|Get|Set)PixelFormat$|^SwapBuffers$/;
        if (name.startsWith('wgl') || exported.test(name))
        {
            add(wgl, name);
        }
    }
    for (const name of Object.keys(context ?? {}))
    {
        if (name.startsWith('gl'))
        {
            add(context, name);
        }
    }
    return table;
}
