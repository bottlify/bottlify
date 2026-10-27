/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A process for the OLE tests: memory and a heap, this layer's objects
 * published and called through their tables, the program's own objects as
 * slots that count their references and record their calls, the registry,
 * and user32, gdi32 and kernel32 as far as OLE imports them -- a clipboard,
 * accelerator tables, key state, metafiles.
 */

import assert from 'node:assert/strict';
import { formatGuid, parseGuid } from './guid.js';
import { createComRegistry } from './objects.js';
import { createStorageFunctions } from './storage.js';
import { HKEY_CLASSES_ROOT, REG_SZ, createHive } from '../advapi32/registry.js';
import { encodeAnsi } from '../kernel32/locale.js';

export const S_OK = 0;
export const S_FALSE = 1;
export const E_NOINTERFACE = 0x80004002 | 0;
export const E_POINTER = 0x80004003 | 0;
export const E_INVALIDARG = 0x80070057 | 0;
export const REGDB_E_CLASSNOTREG = 0x80040154 | 0;

export const IID_IUNKNOWN = '{00000000-0000-0000-C000-000000000046}';

/**
 * @typedef {Object} GuestObject
 * @property {number} pointer
 * @property {number} refs
 * @property {string[]} calls  The slots called, by name where the test named them.
 */

/** @param {{ system?: boolean }} [options] */
export function oleProcess(options = {}){
    const bytes = new Uint8Array(0x200000);
    const view = new DataView(bytes.buffer);
    /** @type {Map<number, { size: number, capacity: number }>} */
    const live = new Map();
    let next = 0x10000;
    const heap = {
        live,
        /** @param {number} size */
        allocate(size){
            const address = next;
            const capacity = Math.max(16, (size + 15) & ~15);
            next += capacity + 16;
            live.set(address, { size, capacity });
            return address;
        },
        /** @param {number} address */
        free: address=>live.delete(address),
        /** @param {number} address */
        block: address=>live.get(address) ?? null,
        /** @param {number} address @param {number} size */
        resize(address, size){
            const block = live.get(address);
            if (!block || size > block.capacity)
            {
                return false;
            }
            block.size = size;
            return true;
        },
    };

    /** @param {number} address */
    const u32 = address=>view.getUint32(address, true);
    /** @param {number} address */
    const u16 = address=>view.getUint16(address, true);
    /** @param {number} address @param {number} value */
    const put = (address, value)=>view.setUint32(address, value >>> 0, true);
    /** @param {string} text */
    const wide = text=>{
        const address = heap.allocate((text.length + 1) * 2);
        [...text, '\0'].forEach((c, index)=>view.setUint16(address + index * 2, c.charCodeAt(0),
            true));
        return address;
    };
    /** @param {number} address */
    const readWide = address=>{
        let text = '';
        for (let at = address; view.getUint16(at, true) !== 0; at += 2)
        {
            text += String.fromCharCode(view.getUint16(at, true));
        }
        return text;
    };
    /** @param {string} text */
    const guid = text=>{
        const address = heap.allocate(16);
        bytes.set(/** @type {Uint8Array} */ (parseGuid(text)), address);
        return address;
    };
    /** @param {number} address */
    const guidAt = address=>formatGuid(bytes.subarray(address, address + 16));
    /** A slot for an out-parameter, filled so "not written" shows. */
    const out = (value = 0xdeadbeef, size = 8)=>{
        const address = heap.allocate(size);
        bytes.fill(0, address, address + size);
        put(address, value);
        return address;
    };

    const registry = createComRegistry();
    /** @type {Map<number, any>} */
    const records = new Map();
    /** @type {Map<any, number>} */
    const published = new Map();
    let nextPointer = 0x100000;
    const vtables = {
        /** @param {any} object @param {string} interfaceId */
        publish(object, interfaceId){
            const record = object.interfaceFor(interfaceId);
            if (!record)
            {
                return 0;
            }
            const existing = published.get(record);
            if (existing)
            {
                return existing;
            }
            nextPointer += 0x10;
            published.set(record, nextPointer);
            records.set(nextPointer, record);
            return nextPointer;
        },
    };

    /** @type {Map<number, { object: GuestObject, slots: Record<number, Function> }>} */
    const guests = new Map();
    let nextGuest = 0x180000;

    /**
     * A method call through an interface pointer: this layer's dispatch into
     * the published table, IUnknown's three as the vtable layer answers them;
     * the program's into its slots.
     *
     * @param {number} pointer @param {number} slot @param {number[]} args
     * @returns {Promise<number>}
     */
    const callMethod = async(pointer, slot, args)=>{
        const record = records.get(pointer >>> 0);
        if (record)
        {
            assert.ok(!record.object.destroyed, `call on a released object at ${pointer}`);
            const method = record.methods[slot];
            assert.ok(method, `no slot ${slot} on ${record.id}`);
            if (method.builtin === 'queryInterface')
            {
                const [iidAt, outAt] = args;
                const found = record.object.queryInterface(guidAt(iidAt));
                put(outAt, found ? vtables.publish(found.object, found.id) : 0);
                return found ? S_OK : E_NOINTERFACE;
            }
            if (method.builtin === 'addRef')
            {
                return record.object.addRef();
            }
            if (method.builtin === 'release')
            {
                // As the bridge does: what the object owes the program is
                // made, and waited for, inside its last Release.
                if (record.object.refCount === 1 && record.object.lastRelease)
                {
                    await record.object.lastRelease();
                }
                return record.object.release();
            }
            return (await method.invoke(record.object, args)) | 0;
        }
        const guest = guests.get(pointer >>> 0);
        assert.ok(guest, `no object at 0x${(pointer >>> 0).toString(16)}`);
        const fn = guest.slots[slot];
        assert.ok(fn, `the guest object has no slot ${slot}`);
        return (await fn(args)) | 0;
    };

    /**
     * A program's object: QueryInterface for the IIDs it lists answers
     * itself, AddRef and Release count, the rest is what `slots` says.
     *
     * @param {string[]} iids
     * @param {Record<number, (args: number[], self: GuestObject) => any>} slots
     * @param {Record<number, string>} [names]  What to record a slot's call as.
     * @returns {GuestObject}
     */
    const guestObject = (iids, slots, names = {})=>{
        nextGuest += 0x10;
        /** @type {GuestObject} */
        const object = { pointer: nextGuest, refs: 1, calls: [] };
        /** @type {Record<number, Function>} */
        const table = {
            0: (/** @type {number[]} */ [iidAt, outAt])=>{
                if ([IID_IUNKNOWN, ...iids].includes(guidAt(iidAt)))
                {
                    put(outAt, object.pointer);
                    object.refs++;
                    return S_OK;
                }
                put(outAt, 0);
                return E_NOINTERFACE;
            },
            1: ()=>++object.refs,
            // A turn of the event loop, as a guest call takes: a Release
            // nobody waits for has not happened when the caller looks.
            2: ()=>new Promise(resolve=>{
                setImmediate(()=>resolve(--object.refs));
            }),
        };
        for (const [slot, fn] of Object.entries(slots))
        {
            table[Number(slot)] = (/** @type {number[]} */ args)=>{
                object.calls.push(names[Number(slot)] ?? `slot ${slot}`);
                return fn(args, object);
            };
        }
        guests.set(object.pointer, { object, slots: table });
        return object;
    };

    /** @param {number} object @param {string} iid */
    const queryPointer = async(object, iid)=>{
        const block = heap.allocate(20);
        bytes.set(/** @type {Uint8Array} */ (parseGuid(iid)), block);
        put(block + 16, 0);
        const hr = await callMethod(object, 0, [block, block + 16]);
        const found = u32(block + 16);
        heap.free(block);
        return hr < 0 ? 0 : found;
    };

    const hive = createHive();
    const classesRoot = /** @type {any} */ (hive.root(HKEY_CLASSES_ROOT));
    /** Writes a string value under HKEY_CLASSES_ROOT. @param {string} path @param {string} [value] */
    const setKey = (path, value)=>{
        const { key } = hive.create(classesRoot, path);
        if (value !== undefined)
        {
            hive.setValue(key, '', REG_SZ, encodeAnsi(`${value}\0`));
        }
    };

    /** Classes the program serves in process: CoCreateInstance makes one of these. */
    /** @type {Map<string, () => GuestObject>} */
    const classes = new Map();
    /** @type {string[]} */
    const created = [];

    /** user32's clipboard and accelerators, gdi32's metafiles, kernel32's files. */
    const user32 = {
        open: false,
        /** @type {Map<number, number>} */
        clipboard: new Map(),
        /** @type {Map<number, string>} */
        names: new Map(),
        /** @type {Map<number, { flags: number, key: number, command: number }[]>} */
        accelerators: new Map(),
        /** @type {Set<number>} */
        keysDown: new Set(),
    };
    /** @type {Set<number>} */
    const metafiles = new Set();
    /** @type {string[]} */
    const systemCalls = [];
    /** @type {Record<string, (args: number[]) => number>} */
    const exports = {
        'USER32.dll!OpenClipboard': ()=>{
            if (user32.open)
            {
                return 0;
            }
            user32.open = true;
            return 1;
        },
        'USER32.dll!CloseClipboard': ()=>{
            const was = user32.open;
            user32.open = false;
            return was ? 1 : 0;
        },
        'USER32.dll!EmptyClipboard': ()=>{
            user32.clipboard.clear();
            return user32.open ? 1 : 0;
        },
        'USER32.dll!SetClipboardData': ([format, handle])=>{
            user32.clipboard.set(format, handle);
            return handle;
        },
        'USER32.dll!GetClipboardData': ([format])=>(user32.open
            ? user32.clipboard.get(format) ?? 0 : 0),
        'USER32.dll!EnumClipboardFormats': ([format])=>{
            const formats = [...user32.clipboard.keys()];
            return format === 0 ? formats[0] ?? 0 : formats[formats.indexOf(format) + 1] ?? 0;
        },
        'USER32.dll!RegisterClipboardFormatW': ([name])=>{
            const text = readWide(name);
            for (const [format, known] of user32.names)
            {
                if (known.toUpperCase() === text.toUpperCase())
                {
                    return format;
                }
            }
            const format = 0xc000 + user32.names.size;
            user32.names.set(format, text);
            return format;
        },
        'USER32.dll!GetClipboardFormatNameW': ([format, buffer, room])=>{
            const name = user32.names.get(format);
            if (!name)
            {
                return 0;
            }
            const text = name.slice(0, room - 1);
            [...text, '\0'].forEach((c, index)=>view.setUint16(buffer + index * 2,
                c.charCodeAt(0), true));
            return text.length;
        },
        'USER32.dll!CopyAcceleratorTableW': ([handle, buffer, room])=>{
            const entries = user32.accelerators.get(handle);
            if (!entries)
            {
                return 0;
            }
            const count = Math.min(room, entries.length);
            for (let index = 0; index < count; index++)
            {
                const at = buffer + index * 6;
                bytes[at] = entries[index].flags;
                bytes[at + 1] = 0;
                view.setUint16(at + 2, entries[index].key, true);
                view.setUint16(at + 4, entries[index].command, true);
            }
            return count;
        },
        'USER32.dll!GetKeyState': ([key])=>(user32.keysDown.has(key) ? 0xff80 : 0),
        'GDI32.dll!CopyMetaFileW': ([handle])=>{
            if (!metafiles.has(handle))
            {
                return 0;
            }
            const copy = handle + 0x1000;
            metafiles.add(copy);
            return copy;
        },
        'GDI32.dll!DeleteMetaFile': ([handle])=>(metafiles.delete(handle) ? 1 : 0),
    };
    /** @param {string} library @param {string} name @param {number[]} args */
    const system = (library, name, args)=>{
        const fn = exports[`${library}!${name}`];
        if (!fn)
        {
            return null;
        }
        systemCalls.push(name);
        return fn(args);
    };

    /** @type {string[]} */
    const reported = [];
    /** @type {string[]} */
    const releasedMedia = [];
    const thread = /** @type {any} */ ({ ole32: { model: 2, depth: 1, oleDepth: 1 } });
    /** The definition `makeObject` is making. @type {any} */
    let making = null;

    /** @type {import('./oleutil.js').OleEnv} */
    const env = {
        readMemory: (address, length)=>bytes.subarray(address, address + length),
        writeMemory: (address, data)=>bytes.set(data, address),
        heap,
        callMethod,
        queryPointer,
        // The thread whose call is answered, and the one running: one thread
        // while a call is answered, as the engine has them.
        callerThread: ()=>thread,
        currentThread: ()=>thread,
        makeObject: (clsid, definition)=>{
            if (!registry.isRegistered(clsid))
            {
                registry.registerClass(clsid, ()=>making);
            }
            making = definition;
            const object = registry.create(clsid);
            making = null;
            return object;
        },
        publish: (object, iid)=>vtables.publish(object, iid),
        createInstance: async(clsid, outer, context, iid, outAt)=>{
            put(outAt, 0);
            const make = classes.get(clsid.toUpperCase());
            if (!make)
            {
                return REGDB_E_CLASSNOTREG;
            }
            created.push(clsid);
            const object = make();
            const iidAt = guid(iid);
            const hr = await callMethod(object.pointer, 0, [iidAt, outAt]);
            // The factory's own reference, given back once the caller's is taken.
            await callMethod(object.pointer, 2, []);
            return hr;
        },
        releaseMedium: async medium=>{
            releasedMedia.push(`${u32(medium)}:${u32(medium + 4)}`);
            if (u32(medium) === 1 && u32(medium + 8) === 0)
            {
                heap.free(u32(medium + 4));
            }
            if (u32(medium + 8) !== 0)
            {
                await callMethod(u32(medium + 8), 2, []);
            }
            return 0;
        },
        oleInitialized: current=>(current?.ole32?.oleDepth ?? 0) > 0,
        hive,
        system: options.system === false ? undefined : system,
        divergence: (api, detail)=>reported.push(`${api}: ${detail}`),
    };

    const storage = /** @type {any} */ (createStorageFunctions({
        readMemory: env.readMemory, writeMemory: env.writeMemory,
        fillMemory: (address, value, length)=>bytes.fill(value, address, address + length),
        heap, registry, vtables,
    }));
    /** A docfile in memory, its root storage open read-write. */
    const docfile = ()=>{
        const lockBytes = out();
        assert.equal(storage.CreateILockBytesOnHGlobal.handler([0, 1, lockBytes]), S_OK);
        const root = out();
        assert.equal(storage.StgCreateDocfileOnILockBytes.handler([u32(lockBytes),
            0x1012, 0, root]), S_OK);
        records.get(u32(lockBytes)).object.release();
        return u32(root);
    };

    return {
        bytes, view, heap, u32, u16, put, wide, readWide, guid, guidAt, out, registry, records,
        callMethod, guestObject, queryPointer, hive, setKey, classes, created, user32, metafiles,
        systemCalls, reported, releasedMedia, thread, env, storage, docfile,
        /** The object behind a pointer this layer published. @param {number} pointer */
        objectAt: pointer=>records.get(pointer)?.object,
    };
}
