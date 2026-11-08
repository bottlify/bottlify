/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A machine for Media Foundation's tests: flat memory, a bump heap, a
 * publisher that hands out one pointer per object and interface (an alias
 * the primary's), and a guest that answers calls on the foreign interfaces
 * a test lays out with `foreign`.
 */

import { createMfplatFunctions } from './functions.js';

const IID_IUNKNOWN = '{00000000-0000-0000-C000-000000000046}';

/**
 * @param {{ propVariant?: any }} [options]
 */
export function mfMachine(options = {}){
    const memory = new Uint8Array(1 << 20);
    const view = new DataView(memory.buffer);
    let next = 0x10000;
    /** @type {Set<number>} */
    const freed = new Set();
    const heap = {
        /** @param {number} bytes */
        allocate: bytes=>{
            const at = next;
            next += (Math.max(bytes, 1) + 15) & ~15;
            return at;
        },
        /** @param {number} at */
        free: at=>{
            if (at)
            {
                freed.add(at);
            }
        },
    };
    /** @type {Map<number, { object: any, id: string }>} */
    const owners = new Map();
    /** @type {Map<any, Map<string, number>>} */
    const published = new Map();
    let nextPointer = 0xc0000;
    const vtables = {
        /** @param {any} object @param {string} id */
        publish(object, id){
            const record = object.interfaceFor(id);
            if (!record)
            {
                return 0;
            }
            const key = record.sharedWith ?? record.id;
            let byId = published.get(object);
            if (!byId)
            {
                byId = new Map();
                published.set(object, byId);
            }
            if (!byId.has(key))
            {
                byId.set(key, nextPointer);
                owners.set(nextPointer, { object, id: key });
                nextPointer += 16;
            }
            return /** @type {number} */ (byId.get(key));
        },
        /** @param {any} object @param {string} id */
        unpublish(object, id){
            const at = published.get(object)?.get(id);
            if (at === undefined)
            {
                return false;
            }
            published.get(object)?.delete(id);
            owners.delete(at);
            return true;
        },
    };

    /** Foreign interfaces: an entry number per method, answered here. */
    /** @type {Map<number, (args: number[]) => number>} */
    const entries = new Map();
    let nextEntry = 0x7000_0000;
    /** @type {{ api: string, detail: string, kind?: string }[]} */
    const said = [];

    const host = {
        /** @param {number} at @param {number} length */
        readMemory: (at, length)=>memory.subarray(at, at + length),
        /** @param {number} at @param {Uint8Array} bytes */
        writeMemory: (at, bytes)=>memory.set(bytes, at),
        heap,
        vtables,
        /** @param {number} pointer */
        objectAt: pointer=>owners.get(pointer)?.object ?? null,
        /** @param {{ entry: number, args: number[] }} call */
        callGuest: async call=>{
            const fn = entries.get(call.entry);
            if (!fn)
            {
                throw new Error(`no guest entry ${call.entry}`);
            }
            return fn(call.args);
        },
        callerThread: ()=>'main',
        /** @param {string} api @param {string} detail @param {string} [kind] */
        divergence: (api, detail, kind)=>said.push({ api, detail, kind }),
        propVariant: options.propVariant,
    };
    const mf = createMfplatFunctions(host);

    /** @param {number} at */
    const u32 = at=>view.getUint32(at, true);
    /** @param {number} at @param {number} value */
    const putU32 = (at, value)=>view.setUint32(at, value >>> 0, true);
    /** A GUID's bytes in fresh memory. @param {string} text */
    const guid = text=>{
        const at = heap.allocate(16);
        const hex = text.replace(/[{}-]/g, '');
        view.setUint32(at, parseInt(hex.slice(0, 8), 16), true);
        view.setUint16(at + 4, parseInt(hex.slice(8, 12), 16), true);
        view.setUint16(at + 6, parseInt(hex.slice(12, 16), 16), true);
        for (let i = 0; i < 8; i++)
        {
            memory[at + 8 + i] = parseInt(hex.slice(16 + i * 2, 18 + i * 2), 16);
        }
        return at;
    };
    /** @param {number} at */
    const guidAt = at=>{
        const hex = (/** @type {number} */ v, /** @type {number} */ n)=>
            v.toString(16).toUpperCase().padStart(n, '0');
        const tail = [...memory.subarray(at + 8, at + 16)].map(b=>hex(b, 2)).join('');
        return `{${hex(u32(at), 8)}-${hex(view.getUint16(at + 4, true), 4)}-`
            + `${hex(view.getUint16(at + 6, true), 4)}-${tail.slice(0, 4)}-${tail.slice(4)}}`;
    };
    /** A wide string in fresh memory. @param {string} text */
    const wide = text=>{
        const at = heap.allocate((text.length + 1) * 2);
        for (let i = 0; i < text.length; i++)
        {
            view.setUint16(at + i * 2, text.charCodeAt(i), true);
        }
        view.setUint16(at + text.length * 2, 0, true);
        return at;
    };
    /** @param {number} at */
    const wideAt = at=>{
        let text = '';
        for (let i = at; view.getUint16(i, true) !== 0; i += 2)
        {
            text += String.fromCharCode(view.getUint16(i, true));
        }
        return text;
    };
    /** Room for an out argument, filled with a pattern. @param {number} [bytes] */
    const out = (bytes = 16)=>{
        const at = heap.allocate(bytes);
        memory.fill(0xee, at, at + bytes);
        return at;
    };

    /**
     * A method called through a pointer: IUnknown's three as the bridge
     * answers them, the rest by name.
     *
     * @param {number} pointer @param {string} name @param {...number} args
     * @returns {Promise<number>}
     */
    const call = async(pointer, name, ...args)=>{
        const owner = owners.get(pointer);
        if (!owner)
        {
            throw new Error(`no object at ${pointer}`);
        }
        const { object, id } = owner;
        if (name === 'AddRef')
        {
            return object.addRef();
        }
        if (name === 'Release')
        {
            const left = object.release();
            if (left === 0)
            {
                for (const key of [...published.get(object)?.keys() ?? []])
                {
                    vtables.unpublish(object, key);
                }
            }
            await object.afterRelease?.();
            return left;
        }
        if (name === 'QueryInterface')
        {
            return mf.kit.query(pointer, args[0], args[1], 'main');
        }
        const record = object.interfaceFor(id);
        const method = record.methods.find((/** @type {any} */ m)=>m.name === name);
        if (!method)
        {
            throw new Error(`${name} is not on ${id}`);
        }
        return (await method.invoke(object, args)) | 0;
    };

    /** A pointer an export wrote, after it answered S_OK. @param {string} name @param {...number} args */
    const make = async(name, ...args)=>{
        const at = out(4);
        // MFCreateAttributes alone takes its out first.
        const hr = await mf.table[/** @type {keyof typeof mf.table} */ (name)].handler(
            /** @type {any} */ (name === 'MFCreateAttributes' ? [at, ...args] : [...args, at]));
        if (hr !== 0)
        {
            throw new Error(`${name} answered ${hr}`);
        }
        return u32(at);
    };

    /**
     * A foreign interface: a vtable in memory whose slots this machine
     * answers with the functions given, IUnknown's counting a count of its own.
     *
     * @param {((args: number[]) => number)[]} methods  after IUnknown's three
     */
    const foreign = methods=>{
        const self = heap.allocate(8);
        const table = heap.allocate((methods.length + 3) * 4);
        putU32(self, table);
        const state = { refs: 1 };
        const all = [
            ()=>0x80004002,
            ()=>++state.refs,
            ()=>--state.refs,
            ...methods,
        ];
        all.forEach((fn, i)=>{
            entries.set(nextEntry, args=>fn(args.slice(1)));
            putU32(table + i * 4, nextEntry++);
        });
        return { pointer: self, state };
    };

    return { memory, view, heap, freed, host, mf, said, u32, putU32, guid, guidAt, wide, wideAt,
        out, call, make, foreign, owners, IID_IUNKNOWN };
}
