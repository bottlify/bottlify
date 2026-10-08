/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A program's IDispatch objects, as external objects a script can use: a
 * member access becomes GetIDsOfNames and Invoke through the object's own
 * vtable, with the arguments laid out as DISPPARAMS of VARIANTs in guest
 * memory and the answer read back out of one.
 *
 * Every guest pointer a script holds is held through one proxy per pointer,
 * which keeps the reference it came with until the engine lets them all go
 * (`releaseAll`, when the script engine closes): a script's objects have no
 * lifetime the engine can see end sooner.
 *
 * How a call is made is IDispatch's (oaidl.h): DISPATCH_METHOD with
 * DISPATCH_PROPERTYGET for a call whose answer is wanted, PROPERTYGET for a
 * read, PROPERTYPUT with the value as the named argument DISPID_PROPERTYPUT
 * for a write; DISPID_VALUE is the default member, DISPID_NEWENUM the
 * collection's IEnumVARIANT. A failed call is an {@link ExternalError} with
 * the HRESULT, or the EXCEPINFO's code and description for DISP_E_EXCEPTION.
 */

import { GUID_SIZE, parseGuid } from '../ole32/guid.js';
import { VT_DISPATCH, VT_UNKNOWN } from '../oleaut32/vartypes.js';
import {
    DISP_E_EXCEPTION, DISP_E_UNKNOWNNAME, ExternalError, ExternalObject,
} from './external.js';
import { ForeignValue, unknownValue } from './values.js';
import { VARIANT_SIZE, createVariantCodec } from './variant.js';

/**
 * @typedef {import('./values.js').Value} Value
 * @typedef {import('./variant.js').GuestCom} GuestCom
 */

export const IID_IUNKNOWN = '{00000000-0000-0000-C000-000000000046}';
export const IID_IDISPATCH = '{00020400-0000-0000-C000-000000000046}';
export const IID_IDISPATCHEX = '{A6EF9860-C720-11D0-9337-00A0C90DCAA9}';
export const IID_IENUMVARIANT = '{00020404-0000-0000-C000-000000000046}';

/** Invoke's wFlags. */
export const DISPATCH_METHOD = 1;
export const DISPATCH_PROPERTYGET = 2;
export const DISPATCH_PROPERTYPUT = 4;
export const DISPATCH_PROPERTYPUTREF = 8;
export const DISPATCH_CONSTRUCT = 0x4000;

/** The DISPIDs with a meaning of their own. */
export const DISPID_VALUE = 0;
export const DISPID_UNKNOWN = -1;
export const DISPID_PROPERTYPUT = -3;
export const DISPID_NEWENUM = -4;
export const DISPID_THIS = -10;
export const DISPID_STARTENUM = -1;

/** Vtable slots. */
const QUERY_INTERFACE = 0;
const ADD_REF = 1;
const RELEASE = 2;
const GET_IDS_OF_NAMES = 5;
const INVOKE = 6;
const GET_MEMBER_NAME = 12;
const GET_NEXT_DISP_ID = 13;
const ENUM_NEXT = 3;
const ENUM_RESET = 5;

const S_OK = 0;
const E_OUTOFMEMORY = 0x8007000e | 0;
const EXCEPINFO_SIZE = 32;
/** fdexEnumAll: GetNextDispID's every member, not only the enumerable ones. */
const FDEX_ENUM_DEFAULT = 1;
/** The locale a call is made in when the embedder names none: English (US). */
const DEFAULT_LCID = 0x0409;

/**
 * @typedef {Object} GuestBridgeHooks
 * @property {(value: Value) => number | Promise<number>} exportObject
 *     A script's object (anything not already a guest pointer) as an
 *     IDispatch pointer carrying one reference for the receiver.
 * @property {(pointer: number) => Value | undefined} [findExported]
 *     The script value behind a pointer this engine published, so that an
 *     object that went out and came back is the same object.
 * @property {(value: Value) => Value} [prepare]  What a value is written as.
 */

/**
 * @param {GuestCom} com @param {GuestBridgeHooks} hooks
 */
export function createGuestBridge(com, hooks){
    const lcid = com.lcid ?? DEFAULT_LCID;
    /** @type {Map<number, GuestDispatch>} */
    const proxies = new Map();
    /** Pointers held for values that are not proxies: an IUnknown, an enumerator. */
    /** @type {number[]} */
    const held = [];

    /**
     * @param {number} object @param {number} slot @param {number[]} args
     * @returns {Promise<number>} the HRESULT, signed
     */
    const callMethod = async(object, slot, args)=>{
        const entry = memory.u32(memory.u32(object) + slot * 4);
        return (await com.call(entry, [object >>> 0, ...args], bridge.thread)) | 0;
    };
    /** @param {number} pointer */
    const addRef = pointer=>callMethod(pointer, ADD_REF, []);
    /** @param {number} pointer */
    const release = pointer=>callMethod(pointer, RELEASE, []);

    /**
     * Scratch memory for one call, freed whatever happens.
     *
     * @template T
     * @param {number} bytes @param {(block: number) => Promise<T>} use
     * @returns {Promise<T>}
     */
    const withBlock = async(bytes, use)=>{
        const block = com.allocate(bytes) >>> 0;
        if (block === 0)
        {
            throw new ExternalError(E_OUTOFMEMORY);
        }
        try
        {
            return await use(block);
        }
        finally
        {
            com.free(block);
        }
    };

    /**
     * QueryInterface: the pointer, carrying a reference, or 0.
     *
     * @param {number} pointer @param {string} iid @returns {Promise<number>}
     */
    const queryInterface = (pointer, iid)=>withBlock(4 + GUID_SIZE, async block=>{
        memory.writeU32(block, 0);
        com.writeMemory(block + 4, /** @type {Uint8Array} */ (parseGuid(iid)));
        const hr = await callMethod(pointer, QUERY_INTERFACE, [block + 4, block]);
        const found = memory.u32(block);
        return hr < 0 ? 0 : found;
    });

    /**
     * A guest interface as a script value: its proxy, made once per pointer.
     *
     * @param {number} pointer @param {'dispatch' | 'unknown'} kind @param {boolean} owned
     * @returns {Promise<Value>}
     */
    const importInterface = async(pointer, kind, owned)=>{
        const own = hooks.findExported?.(pointer);
        if (own !== undefined)
        {
            if (owned)
            {
                await release(pointer);
            }
            return own;
        }
        if (kind === 'unknown')
        {
            const dispatch = await queryInterface(pointer, IID_IDISPATCH);
            if (dispatch === 0)
            {
                if (!owned)
                {
                    await addRef(pointer);
                }
                held.push(pointer);
                return unknownValue(pointer);
            }
            if (owned)
            {
                await release(pointer);
            }
            return importInterface(dispatch, 'dispatch', true);
        }
        const existing = proxies.get(pointer);
        if (existing)
        {
            if (owned)
            {
                await release(pointer);
            }
            return existing;
        }
        if (!owned)
        {
            await addRef(pointer);
        }
        const proxy = new GuestDispatch(bridge, pointer);
        proxies.set(pointer, proxy);
        return proxy;
    };

    /**
     * A value as an interface pointer with a reference for the receiver.
     *
     * @param {Value} value @returns {Promise<number>}
     */
    const exportInterface = async value=>{
        if (value instanceof GuestDispatch)
        {
            await addRef(value.pointer);
            return value.pointer;
        }
        if (value instanceof ForeignValue && value.vt === VT_UNKNOWN)
        {
            await addRef(value.value);
            return value.value;
        }
        return hooks.exportObject(value);
    };

    const codec = createVariantCodec(com, {
        import: importInterface, export: exportInterface, prepare: hooks.prepare,
    });
    const memory = codec.memory;

    /**
     * GetIDsOfNames for one name.
     *
     * @param {number} pointer @param {string} name @returns {Promise<number>}
     */
    const dispIdOf = (pointer, name)=>withBlock(GUID_SIZE + 8 + name.length * 2 + 2,
        async block=>{
            const names = block + GUID_SIZE;
            const out = names + 4;
            const text = out + 4;
            memory.zero(block, GUID_SIZE);
            memory.writeWide(text, name, true);
            memory.writeU32(names, text);
            memory.writeU32(out, DISPID_UNKNOWN >>> 0);
            const hr = await callMethod(pointer, GET_IDS_OF_NAMES, [block, names, 1, lcid, out]);
            if (hr < 0)
            {
                throw new ExternalError(hr);
            }
            return memory.i32(out);
        });

    /**
     * Invoke: the arguments first first, a put's value as the named
     * argument, the answer read when one is wanted.
     *
     * @param {number} pointer @param {number} dispid @param {number} flags
     * @param {Value[]} args @param {{ value: Value } | null} put
     * @returns {Promise<Value>}
     */
    const invoke = (pointer, dispid, flags, args, put)=>{
        const count = args.length + (put ? 1 : 0);
        const size = 16 + VARIANT_SIZE * count + 4 + VARIANT_SIZE + EXCEPINFO_SIZE + 4 + GUID_SIZE;
        return withBlock(size, async block=>{
            const params = block;
            const variants = params + 16;
            const named = variants + VARIANT_SIZE * count;
            const result = named + 4;
            const excepinfo = result + VARIANT_SIZE;
            const argErr = excepinfo + EXCEPINFO_SIZE;
            const iidNull = argErr + 4;
            memory.zero(block, size);
            // DISPPARAMS lists its arguments last first, the named one before
            // all of them.
            let slot = 0;
            /** @type {number[]} */
            const written = [];
            try
            {
                if (put)
                {
                    await codec.write(variants, put.value);
                    written.push(variants);
                    slot++;
                }
                for (let i = args.length - 1; i >= 0; i--)
                {
                    const at = variants + VARIANT_SIZE * slot++;
                    await codec.write(at, args[i]);
                    written.push(at);
                }
                memory.writeU32(params, count > 0 ? variants : 0);
                memory.writeU32(params + 4, put ? named : 0);
                memory.writeU32(params + 8, count);
                memory.writeU32(params + 12, put ? 1 : 0);
                memory.writeU32(named, DISPID_PROPERTYPUT >>> 0);
                const hr = await callMethod(pointer, INVOKE, [dispid >>> 0, iidNull, lcid, flags,
                    params, put ? 0 : result, excepinfo, argErr]);
                if (hr === DISP_E_EXCEPTION)
                {
                    throw await exception(excepinfo);
                }
                if (hr < 0)
                {
                    throw new ExternalError(hr);
                }
                return put ? undefined : await codec.read(result, true);
            }
            finally
            {
                for (const at of written)
                {
                    await com.oleaut32('VariantClear', [at]);
                }
            }
        });
    };

    /**
     * What an EXCEPINFO says, its strings freed: deferred filling first,
     * when the object asked for it.
     *
     * @param {number} excepinfo @returns {Promise<ExternalError>}
     */
    const exception = async excepinfo=>{
        const deferred = memory.u32(excepinfo + 24);
        if (deferred !== 0)
        {
            await com.call(deferred, [excepinfo], bridge.thread);
        }
        const code = memory.u16(excepinfo);
        const scode = memory.i32(excepinfo + 28);
        const source = memory.u32(excepinfo + 4);
        const description = memory.u32(excepinfo + 8);
        const help = memory.u32(excepinfo + 12);
        const failure = new ExternalError(scode !== 0 ? scode : (0x800a0000 | code) | 0,
            codec.readBstr(description), codec.readBstr(source));
        for (const bstr of [source, description, help])
        {
            if (bstr !== 0)
            {
                await com.oleaut32('SysFreeString', [bstr]);
            }
        }
        return failure;
    };

    /**
     * The names IDispatchEx lists, where the object has it.
     *
     * @param {number} pointer @returns {Promise<string[]>}
     */
    const memberNames = async pointer=>{
        const ex = await queryInterface(pointer, IID_IDISPATCHEX);
        if (ex === 0)
        {
            return [];
        }
        try
        {
            return await withBlock(8, async block=>{
                const names = [];
                let id = DISPID_STARTENUM;
                for (;;)
                {
                    memory.writeU32(block, DISPID_UNKNOWN >>> 0);
                    const hr = await callMethod(ex, GET_NEXT_DISP_ID, [FDEX_ENUM_DEFAULT,
                        id >>> 0, block]);
                    if (hr !== S_OK)
                    {
                        return names;
                    }
                    id = memory.i32(block);
                    memory.writeU32(block + 4, 0);
                    if ((await callMethod(ex, GET_MEMBER_NAME, [id >>> 0, block + 4])) >= 0)
                    {
                        const bstr = memory.u32(block + 4);
                        names.push(codec.readBstr(bstr));
                        if (bstr !== 0)
                        {
                            await com.oleaut32('SysFreeString', [bstr]);
                        }
                    }
                }
            });
        }
        finally
        {
            await release(ex);
        }
    };

    /**
     * The collection's IEnumVARIANT, walked one item at a time.
     *
     * @param {number} pointer
     * @returns {Promise<import('./external.js').ExternalEnumerator>}
     */
    const enumerate = async pointer=>{
        const size = VARIANT_SIZE + EXCEPINFO_SIZE + 16 + GUID_SIZE;
        const source = await withBlock(size, async block=>{
            const result = block;
            const excepinfo = result + VARIANT_SIZE;
            const params = excepinfo + EXCEPINFO_SIZE;
            const iidNull = params + 16;
            memory.zero(block, size);
            const hr = await callMethod(pointer, INVOKE, [DISPID_NEWENUM >>> 0, iidNull, lcid,
                DISPATCH_METHOD | DISPATCH_PROPERTYGET, params, result, excepinfo, 0]);
            if (hr === DISP_E_EXCEPTION)
            {
                throw await exception(excepinfo);
            }
            if (hr < 0)
            {
                throw new ExternalError(hr);
            }
            const vt = memory.u16(result);
            const unknown = vt === VT_UNKNOWN || vt === VT_DISPATCH ? memory.u32(result + 8) : 0;
            const enumerator = unknown === 0 ? 0 : await queryInterface(unknown, IID_IENUMVARIANT);
            await com.oleaut32('VariantClear', [result]);
            if (enumerator === 0)
            {
                throw new ExternalError(DISP_E_UNKNOWNNAME);
            }
            return enumerator;
        });
        held.push(source);
        return {
            next: ()=>withBlock(VARIANT_SIZE + 4, async block=>{
                memory.zero(block, VARIANT_SIZE + 4);
                const hr = await callMethod(source, ENUM_NEXT, [1, block, block + VARIANT_SIZE]);
                if (hr !== S_OK || memory.u32(block + VARIANT_SIZE) !== 1)
                {
                    return { done: true, value: undefined };
                }
                return { done: false, value: await codec.read(block, true) };
            }),
            reset: async()=>{
                await callMethod(source, ENUM_RESET, []);
            },
        };
    };

    const bridge = {
        /**
         * The guest thread the calls are made on: the one whose call into
         * the engine is being answered. Set by whoever takes that call.
         *
         * @type {unknown}
         */
        thread: undefined,
        /** Takes the calling thread, at the start of a call into the engine. */
        enter(){
            bridge.thread = com.callerThread?.();
        },
        codec,
        callMethod,
        queryInterface,
        importInterface,
        exportInterface,
        dispIdOf,
        invoke,
        memberNames,
        enumerate,
        /** Lets go of every guest pointer a script held. */
        async releaseAll(){
            const pointers = [...proxies.keys(), ...held];
            proxies.clear();
            held.length = 0;
            for (const pointer of pointers)
            {
                await release(pointer);
            }
        },
    };
    return bridge;
}

/** @typedef {ReturnType<typeof createGuestBridge>} GuestBridge */

/** A guest IDispatch, as an external object. */
export class GuestDispatch extends ExternalObject
{
    /** @param {GuestBridge} bridge @param {number} pointer */
    constructor(bridge, pointer){
        super();
        this.bridge = bridge;
        this.pointer = pointer;
        /** @type {Map<string, number>} DISPIDs by the name as the script spelled it */
        this.ids = new Map();
    }

    /** @param {string | null} name @returns {Promise<number>} */
    async id(name){
        if (name === null)
        {
            return DISPID_VALUE;
        }
        const known = this.ids.get(name);
        if (known !== undefined)
        {
            return known;
        }
        const id = await this.bridge.dispIdOf(this.pointer, name);
        this.ids.set(name, id);
        return id;
    }

    /** @param {string | null} name @param {Value[]} args */
    async get(name, args){
        return this.bridge.invoke(this.pointer, await this.id(name), DISPATCH_PROPERTYGET, args,
            null);
    }

    /** @param {string | null} name @param {Value} value @param {Value[]} args */
    async put(name, value, args){
        await this.bridge.invoke(this.pointer, await this.id(name), DISPATCH_PROPERTYPUT, args,
            { value });
    }

    /** @param {string | null} name @param {Value[]} args */
    async call(name, args){
        return this.bridge.invoke(this.pointer, await this.id(name),
            DISPATCH_METHOD | DISPATCH_PROPERTYGET, args, null);
    }

    /** @param {string} name */
    async has(name){
        try
        {
            await this.id(name);
            return true;
        }
        catch (e){
            if (e instanceof ExternalError)
            {
                return false;
            }
            throw e;
        }
    }

    keys(){
        return this.bridge.memberNames(this.pointer);
    }

    enumerate(){
        return this.bridge.enumerate(this.pointer);
    }
}
