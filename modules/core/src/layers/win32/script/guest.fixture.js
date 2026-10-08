/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A guest for the scripting runtime's tests: flat memory with a heap that
 * notices a double free and reports what is still allocated, functions at
 * addresses that a call reaches, COM vtables for host objects as the
 * bridge publishes them, the OLEAUT32 exports the runtime calls, and a
 * guest-side IDispatch written against the ABI with its own small VARIANT
 * reading -- not the runtime's, so a test of the runtime's is not the
 * runtime agreeing with itself.
 */

import { formatGuid } from '../ole32/guid.js';

const S_OK = 0;
const E_NOINTERFACE = 0x80004002 | 0;
const DISP_E_UNKNOWNNAME = 0x80020006 | 0;
const DISP_E_MEMBERNOTFOUND = 0x80020003 | 0;
const DISP_E_EXCEPTION = 0x80020009 | 0;
const IID_IUNKNOWN = '{00000000-0000-0000-C000-000000000046}';
const IID_IDISPATCH = '{00020400-0000-0000-C000-000000000046}';
const IID_IENUMVARIANT = '{00020404-0000-0000-C000-000000000046}';
const DISPID_PROPERTYPUT = -3;
const DISPID_NEWENUM = -4;

/** Bytes of one element, by VARTYPE, as SafeArrayCreate sizes them. */
const ELEMENT_BYTES = new Map([[2, 2], [3, 4], [4, 4], [5, 8], [7, 8], [8, 4], [9, 4],
    [11, 2], [12, 16], [13, 4], [17, 1]]);

/** @param {number} [size] */
export function createFakeGuest(size = 1 << 22){
    const bytes = new Uint8Array(size);
    const view = new DataView(bytes.buffer);
    let top = 0x10000;
    /** @type {Map<number, number>} */
    const live = new Map();
    /** @type {Map<number, (args: number[]) => number | Promise<number>>} */
    const functions = new Map();
    let nextEntry = 0x7f000000;

    const memory = {
        /** @param {number} a */
        u16: a=>view.getUint16(a, true),
        /** @param {number} a */
        u32: a=>view.getUint32(a, true),
        /** @param {number} a */
        i32: a=>view.getInt32(a, true),
        /** @param {number} a */
        f64: a=>view.getFloat64(a, true),
        /** @param {number} a @param {number} v */
        setU16: (a, v)=>view.setUint16(a, v, true),
        /** @param {number} a @param {number} v */
        setU32: (a, v)=>view.setUint32(a, v >>> 0, true),
        /** @param {number} a @param {number} v */
        setF64: (a, v)=>view.setFloat64(a, v, true),
        /** @param {number} a @param {number} units */
        wide: (a, units)=>{
            let text = '';
            for (let i = 0; i < units; i++)
            {
                text += String.fromCharCode(view.getUint16(a + i * 2, true));
            }
            return text;
        },
        /** @param {number} a */
        wideString: a=>{
            let text = '';
            for (let at = a; view.getUint16(at, true) !== 0; at += 2)
            {
                text += String.fromCharCode(view.getUint16(at, true));
            }
            return text;
        },
        /** @param {number} a @param {string} text */
        setWide: (a, text)=>{
            for (let i = 0; i < text.length; i++)
            {
                view.setUint16(a + i * 2, text.charCodeAt(i), true);
            }
            view.setUint16(a + text.length * 2, 0, true);
        },
        /** @param {number} a */
        guid: a=>formatGuid(bytes.subarray(a, a + 16)),
    };

    /** @param {number} count @returns {number} */
    const allocate = count=>{
        const at = top;
        top += (Math.max(count, 1) + 15) & ~15;
        if (top > size)
        {
            return 0;
        }
        bytes.fill(0xcd, at, at + count);
        live.set(at, count);
        return at;
    };
    /** @param {number} at */
    const free = at=>{
        if ((at >>> 0) === 0)
        {
            return;
        }
        if (!live.delete(at >>> 0))
        {
            throw new Error(`free of 0x${(at >>> 0).toString(16)}, which is not allocated`);
        }
    };

    /** @param {(args: number[]) => number | Promise<number>} handler @returns {number} */
    const entry = handler=>{
        const at = nextEntry;
        nextEntry += 4;
        functions.set(at, handler);
        return at;
    };
    /** @param {number} at @param {number[]} args */
    const call = (at, args)=>{
        const handler = functions.get(at >>> 0);
        if (!handler)
        {
            throw new Error(`no function at 0x${(at >>> 0).toString(16)}`);
        }
        return handler(args);
    };
    /**
     * Calls a method of an object through its vtable.
     *
     * @param {number} object @param {number} slot @param {number[]} args
     */
    const callMethod = (object, slot, args)=>call(memory.u32(memory.u32(object) + slot * 4),
        [object, ...args]);

    /**
     * An object whose methods are these functions, `this` first in each
     * one's arguments.
     *
     * @param {((args: number[]) => number | Promise<number>)[]} methods @returns {number}
     */
    const guestObject = methods=>{
        const vtable = allocate(methods.length * 4);
        methods.forEach((method, slot)=>memory.setU32(vtable + slot * 4, entry(method)));
        const object = allocate(4);
        memory.setU32(object, vtable);
        return object;
    };

    /** @type {Map<object, number>} */
    const publishedRecords = new Map();
    /** @type {Map<number, any>} */
    const publishedObjects = new Map();
    /**
     * A host COM object's interface in guest memory, as the bridge
     * publishes one: IUnknown's three answered from the object model.
     *
     * @param {any} object @param {string} iid @returns {number}
     */
    const publish = (object, iid)=>{
        const record = object.interfaceFor(iid);
        if (!record)
        {
            return 0;
        }
        const known = publishedRecords.get(record);
        if (known !== undefined)
        {
            return known;
        }
        const pointer = guestObject(record.methods.map((/** @type {any} */ method)=>{
            /** @type {(args: number[]) => number | Promise<number>} */
            let handler;
            switch (method.builtin)
            {
                case 'queryInterface':
                    handler = ([, riid, out])=>{
                        const found = object.queryInterface(memory.guid(riid));
                        memory.setU32(out, found ? publish(object, found.id) : 0);
                        return found ? S_OK : E_NOINTERFACE;
                    };
                    break;
                case 'addRef':
                    handler = ()=>object.addRef();
                    break;
                case 'release':
                    handler = ()=>object.release();
                    break;
                default:
                    handler = ([, ...args])=>method.invoke(object, args);
                    break;
            }
            return handler;
        }));
        publishedRecords.set(record, pointer);
        publishedObjects.set(pointer, object);
        return pointer;
    };

    /** @param {string} text @returns {number} */
    const sysAllocString = text=>{
        const block = allocate(4 + text.length * 2 + 2);
        memory.setU32(block, text.length * 2);
        memory.setWide(block + 4, text);
        return block + 4;
    };
    /** @param {number} bstr @returns {string} */
    const readBstr = bstr=>(bstr === 0 ? '' : memory.wide(bstr, memory.u32(bstr - 4) / 2));

    /** @param {number} variant @returns {Promise<void>} */
    const variantClear = async variant=>{
        const vt = memory.u16(variant);
        if ((vt & 0x4000) === 0)
        {
            if ((vt & 0x2000) !== 0)
            {
                await safeArrayDestroy(memory.u32(variant + 8));
            }
            else if (vt === 8)
            {
                free(memory.u32(variant + 8) - 4);
            }
            else if ((vt === 9 || vt === 13) && memory.u32(variant + 8) !== 0)
            {
                await callMethod(memory.u32(variant + 8), 2, []);
            }
        }
        bytes.fill(0, variant, variant + 16);
    };
    /** @param {number} array */
    const safeArrayDestroy = async array=>{
        const dims = memory.u16(array);
        const elementBytes = memory.u32(array + 4);
        const data = memory.u32(array + 12);
        const type = memory.u32(array - 4);
        let count = 1;
        for (let d = 0; d < dims; d++)
        {
            count *= memory.u32(array + 16 + d * 8);
        }
        for (let i = 0; i < count; i++)
        {
            const at = data + i * elementBytes;
            if (type === 12)
            {
                await variantClear(at);
            }
            else if (type === 8 && memory.u32(at) !== 0)
            {
                free(memory.u32(at) - 4);
            }
        }
        free(data);
        free(array - 4);
    };

    /** @type {Record<string, (args: number[]) => number | Promise<number>>} */
    const oleaut32 = {
        SysAllocStringLen: ([source, length])=>{
            const bstr = sysAllocString('\0'.repeat(length));
            if (source !== 0)
            {
                bytes.copyWithin(bstr, source, source + length * 2);
            }
            return bstr;
        },
        SysFreeString: ([bstr])=>{
            if (bstr !== 0)
            {
                free(bstr - 4);
            }
            return 0;
        },
        VariantClear: async([variant])=>{
            await variantClear(variant);
            return S_OK;
        },
        // The VARTYPE is kept in the four bytes before the descriptor, as
        // FADF_HAVEVARTYPE arrays keep it.
        SafeArrayCreate: ([vt, dims, bounds])=>{
            const elementBytes = ELEMENT_BYTES.get(vt) ?? 0;
            let count = 1;
            for (let d = 0; d < dims; d++)
            {
                count *= memory.u32(bounds + d * 8);
            }
            const block = allocate(4 + 16 + dims * 8);
            const array = block + 4;
            const data = allocate(count * elementBytes);
            bytes.fill(0, data, data + count * elementBytes);
            memory.setU32(block, vt);
            memory.setU16(array, dims);
            memory.setU16(array + 2, 0);
            memory.setU32(array + 4, elementBytes);
            memory.setU32(array + 8, 0);
            memory.setU32(array + 12, data);
            for (let d = 0; d < dims; d++)
            {
                bytes.copyWithin(array + 16 + (dims - 1 - d) * 8, bounds + d * 8,
                    bounds + d * 8 + 8);
            }
            return array;
        },
        SafeArrayDestroy: async([array])=>{
            await safeArrayDestroy(array);
            return S_OK;
        },
    };

    /** @type {import('./variant.js').GuestCom} */
    const com = {
        call: (at, args)=>call(at, args),
        readMemory: (address, length)=>bytes.subarray(address, address + length),
        writeMemory: (address, data)=>bytes.set(data, address),
        allocate,
        free,
        oleaut32: (name, args)=>{
            const handler = oleaut32[name];
            if (!handler)
            {
                throw new Error(`OLEAUT32 ${name} is not in the fixture`);
            }
            return handler(args);
        },
    };

    /**
     * A VARIANT, read as a test reads one: what it holds, plainly.
     *
     * @param {number} variant @returns {any}
     */
    const readVariant = variant=>{
        const vt = memory.u16(variant);
        switch (vt)
        {
            // An argument passed by reference, as VBScript passes a variable.
            case 0x400c: return readVariant(memory.u32(variant + 8));
            case 0: return undefined;
            case 1: return null;
            case 2: return view.getInt16(variant + 8, true);
            case 3: return memory.i32(variant + 8);
            case 5: return memory.f64(variant + 8);
            case 7: return { date: memory.f64(variant + 8) };
            case 8: return readBstr(memory.u32(variant + 8));
            case 9: case 13: return { pointer: memory.u32(variant + 8) };
            case 11: return memory.u16(variant + 8) !== 0;
            default: return { vt };
        }
    };
    /**
     * Writes a plain value as a VARIANT: an integer as VT_I4, any other
     * number as VT_R8, a string as a new BSTR, `{ pointer }` as a
     * VT_DISPATCH it adds a reference to.
     *
     * @param {number} variant @param {any} value
     */
    const writeVariant = async(variant, value)=>{
        bytes.fill(0, variant, variant + 16);
        if (value === undefined)
        {
            return;
        }
        if (value === null)
        {
            memory.setU16(variant, 1);
        }
        else if (typeof value === 'boolean')
        {
            memory.setU16(variant, 11);
            memory.setU16(variant + 8, value ? 0xffff : 0);
        }
        else if (typeof value === 'number' && Number.isInteger(value))
        {
            memory.setU16(variant, 3);
            view.setInt32(variant + 8, value, true);
        }
        else if (typeof value === 'number')
        {
            memory.setU16(variant, 5);
            memory.setF64(variant + 8, value);
        }
        else if (typeof value === 'string')
        {
            memory.setU16(variant, 8);
            memory.setU32(variant + 8, sysAllocString(value));
        }
        else if (typeof value.pointer === 'number')
        {
            memory.setU16(variant, 9);
            memory.setU32(variant + 8, value.pointer);
            await callMethod(value.pointer, 1, []);
        }
    };

    /**
     * A guest IDispatch over a table of members, each `{ get, put, call }`
     * on plain values, matched without case. Every Invoke is recorded.
     *
     * @param {Record<string, { get?: (args: any[]) => any, put?: (value: any, args: any[]) => void,
     *     call?: (args: any[]) => any }>} members
     * @param {{ items?: any[], value?: () => any }} [extra]
     */
    const dispatchObject = (members, extra = {})=>{
        const names = Object.keys(members);
        const state = {
            refs: 1,
            /** @type {{ name: string, flags: number, args: any[] }[]} */
            invokes: [],
            pointer: 0,
        };
        /** @param {number} self @param {number} riid @param {number} out */
        const queryInterface = (self, riid, out)=>{
            const iid = memory.guid(riid);
            if (iid === IID_IUNKNOWN || iid === IID_IDISPATCH)
            {
                state.refs++;
                memory.setU32(out, self);
                return S_OK;
            }
            memory.setU32(out, 0);
            return E_NOINTERFACE;
        };
        state.pointer = guestObject([
            ([self, riid, out])=>queryInterface(self, riid, out),
            ()=>++state.refs,
            ()=>--state.refs,
            ([, out])=>{
                memory.setU32(out, 0);
                return S_OK;
            },
            ()=>0x8002000b | 0,
            ([, , namesAt, count, , out])=>{
                const name = memory.wideString(memory.u32(namesAt)).toLowerCase();
                const index = names.findIndex(known=>known.toLowerCase() === name);
                for (let i = 0; i < count; i++)
                {
                    memory.setU32(out + i * 4, i === 0 && index >= 0 ? index + 1 : -1);
                }
                return index >= 0 ? S_OK : DISP_E_UNKNOWNNAME;
            },
            async([, id, , , flags, params, result, excepinfo])=>{
                const variants = memory.u32(params);
                const count = memory.u32(params + 8);
                const named = memory.u32(params + 12);
                /** @type {any[]} */
                const args = [];
                for (let i = count - 1; i >= named; i--)
                {
                    args.push(readVariant(variants + i * 16));
                }
                const putting = named > 0
                    && memory.i32(memory.u32(params + 4)) === DISPID_PROPERTYPUT;
                const putValue = putting ? readVariant(variants) : undefined;
                if ((id | 0) === DISPID_NEWENUM)
                {
                    const enumerator = itemsEnumerator(extra.items ?? []);
                    memory.setU16(result, 13);
                    memory.setU32(result + 8, enumerator);
                    return S_OK;
                }
                const name = (id | 0) === 0 ? '' : names[id - 1];
                state.invokes.push({ name, flags, args: putValue === undefined
                    ? args : [...args, putValue] });
                const member = (id | 0) === 0 ? { get: extra.value } : members[name];
                if (!member)
                {
                    return DISP_E_MEMBERNOTFOUND;
                }
                try
                {
                    let answer;
                    if ((flags & 4) !== 0 && member.put)
                    {
                        member.put(putValue, args);
                    }
                    else if ((flags & 1) !== 0 && member.call)
                    {
                        answer = await member.call(args);
                    }
                    else if ((flags & 2) !== 0 && member.get)
                    {
                        answer = await member.get(args);
                    }
                    else
                    {
                        return DISP_E_MEMBERNOTFOUND;
                    }
                    if (result !== 0)
                    {
                        await writeVariant(result, answer);
                    }
                    return S_OK;
                }
                catch (e){
                    bytes.fill(0, excepinfo, excepinfo + 32);
                    memory.setU32(excepinfo + 4, sysAllocString('Fixture'));
                    memory.setU32(excepinfo + 8, sysAllocString(e instanceof Error
                        ? e.message : String(e)));
                    memory.setU32(excepinfo + 28, 0x800a0001);
                    return DISP_E_EXCEPTION;
                }
            },
        ]);
        return state;
    };

    /**
     * An IEnumVARIANT over plain values.
     *
     * @param {any[]} items @returns {number}
     */
    const itemsEnumerator = items=>{
        let at = 0;
        return guestObject([
            ([self, riid, out])=>{
                const iid = memory.guid(riid);
                const known = iid === IID_IUNKNOWN || iid === IID_IENUMVARIANT;
                memory.setU32(out, known ? self : 0);
                return known ? S_OK : E_NOINTERFACE;
            },
            ()=>1,
            ()=>0,
            async([, count, variants, fetched])=>{
                let n = 0;
                while (n < count && at < items.length)
                {
                    await writeVariant(variants + n * 16, items[at++]);
                    n++;
                }
                if (fetched !== 0)
                {
                    memory.setU32(fetched, n);
                }
                return n === count ? S_OK : 1;
            },
            ([, count])=>{
                at += count;
                return S_OK;
            },
            ()=>{
                at = 0;
                return S_OK;
            },
        ]);
    };

    return {
        bytes, view, memory, com, allocate, free, live, entry, call, callMethod, guestObject,
        publish, publishedObjects, readBstr, sysAllocString, readVariant, writeVariant,
        dispatchObject,
    };
}

/** @typedef {ReturnType<typeof createFakeGuest>} FakeGuest */
