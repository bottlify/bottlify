/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * PROPVARIANT: the property value a property set, a shell property or an
 * audio engine's settings pass around, and the two calls that make one a
 * value of its own and let it go.
 *
 * A PROPVARIANT is sixteen bytes: the type, three reserved words, and eight
 * bytes of value -- a number, a pointer, or a count and a pointer for a
 * vector. What the pointer reaches belongs to the PROPVARIANT, so a copy is
 * deep: strings, blobs, clipboard data and CLSIDs are duplicated in task
 * memory, BSTRs and SAFEARRAYs through oleaut32's own calls, and an
 * interface pointer is shared with a reference of its own taken. A clear
 * gives back all of that and leaves the record zero, VT_EMPTY.
 *
 * Which types may be held, and in which form -- by value, as a SAFEARRAY,
 * as a counted vector, by reference -- is a fixed table, the one ole32's
 * propvariant tests hold every version since Windows XP to: a copy refuses
 * any other with DISP_E_BADVARTYPE and leaves its destination alone, and a
 * clear refuses it with STG_E_INVALIDPARAMETER and zeroes the record anyway.
 */

const S_OK = 0;
const E_INVALIDARG = 0x80070057 | 0;
const E_OUTOFMEMORY = 0x8007000e | 0;
const DISP_E_BADVARTYPE = 0x80020008 | 0;
const STG_E_INVALIDPARAMETER = 0x80030057 | 0;

const VT_EMPTY = 0;
const VT_NULL = 1;
const VT_I2 = 2;
const VT_I4 = 3;
const VT_R4 = 4;
const VT_R8 = 5;
const VT_CY = 6;
const VT_DATE = 7;
const VT_BSTR = 8;
const VT_DISPATCH = 9;
const VT_ERROR = 10;
const VT_BOOL = 11;
const VT_VARIANT = 12;
const VT_UNKNOWN = 13;
const VT_DECIMAL = 14;
const VT_I1 = 16;
const VT_UI1 = 17;
const VT_UI2 = 18;
const VT_UI4 = 19;
const VT_I8 = 20;
const VT_UI8 = 21;
const VT_INT = 22;
const VT_UINT = 23;
const VT_LPSTR = 30;
const VT_LPWSTR = 31;
const VT_RECORD = 36;
const VT_FILETIME = 64;
const VT_BLOB = 65;
const VT_STREAM = 66;
const VT_STORAGE = 67;
const VT_STREAMED_OBJECT = 68;
const VT_STORED_OBJECT = 69;
const VT_BLOB_OBJECT = 70;
const VT_CF = 71;
const VT_CLSID = 72;
const VT_VECTOR = 0x1000;
const VT_ARRAY = 0x2000;
const VT_BYREF = 0x4000;
const VT_TYPEMASK = 0x0fff;

/** The bytes of a PROPVARIANT, and where its value starts. */
const PROPVARIANT_SIZE = 16;
const VALUE = 8;

/** CLIPDATA: a size that counts the format as well as the bytes, the format, the bytes. */
const CLIPDATA_SIZE = 12;
const FORMAT_BYTES = 4;

const GUID_BYTES = 16;

/** A pointer to an interface, whose copy shares it and takes a reference. */
const INTERFACES = new Set([VT_DISPATCH, VT_UNKNOWN, VT_STREAM, VT_STORAGE,
    VT_STREAMED_OBJECT, VT_STORED_OBJECT]);

/** The numbers, which are only bytes to copy, a simple value or a SAFEARRAY's element. */
const NUMBERS = [VT_I2, VT_I4, VT_R4, VT_R8, VT_CY, VT_DATE, VT_ERROR, VT_BOOL, VT_I1, VT_UI1,
    VT_UI2, VT_UI4, VT_I8, VT_UI8];

/** What each type may be held as. */
const SIMPLE = new Set([VT_EMPTY, VT_NULL, ...NUMBERS, VT_BSTR, VT_DISPATCH, VT_VARIANT,
    VT_UNKNOWN, VT_DECIMAL, VT_INT, VT_UINT, VT_LPSTR, VT_LPWSTR, VT_RECORD, VT_FILETIME, VT_BLOB,
    VT_STREAM, VT_STORAGE, VT_STREAMED_OBJECT, VT_STORED_OBJECT, VT_BLOB_OBJECT, VT_CF, VT_CLSID]);
const REFERENCED = new Set([...NUMBERS, VT_BSTR, VT_DISPATCH, VT_VARIANT, VT_UNKNOWN,
    VT_DECIMAL, VT_INT, VT_UINT, VT_RECORD]);

/** A vector's element types, and the bytes each takes. */
const VECTOR_ELEMENT = new Map([
    [VT_I1, 1], [VT_UI1, 1], [VT_I2, 2], [VT_UI2, 2], [VT_BOOL, 2], [VT_I4, 4], [VT_UI4, 4],
    [VT_R4, 4], [VT_ERROR, 4], [VT_I8, 8], [VT_UI8, 8], [VT_R8, 8], [VT_CY, 8], [VT_DATE, 8],
    [VT_FILETIME, 8], [VT_CLSID, GUID_BYTES], [VT_CF, CLIPDATA_SIZE], [VT_BSTR, 4],
    [VT_LPSTR, 4], [VT_LPWSTR, 4], [VT_VARIANT, PROPVARIANT_SIZE],
]);

/**
 * Whether a type is one a PROPVARIANT may hold: one form at most, of a
 * type that form allows.
 *
 * @param {number} vt
 */
const holdable = vt=>{
    const type = vt & VT_TYPEMASK;
    switch (vt & ~VT_TYPEMASK)
    {
        case 0:
            return SIMPLE.has(type);
        case VT_ARRAY:
        case VT_BYREF:
            return REFERENCED.has(type);
        case VT_VECTOR:
            return VECTOR_ELEMENT.has(type);
        default:
            return false;
    }
};

/**
 * @typedef {Object} PropVariantHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {{ allocate: (bytes: number) => number, free: (address: number) => unknown }} heap
 *           Task memory, which what a PROPVARIANT owns is made of.
 * @property {{ copy: (bstr: number) => number, free: (bstr: number) => unknown }} [bstr]
 *           oleaut32's SysAllocString and SysFreeString. Absent, a BSTR
 *           cannot be copied.
 * @property {{ copy: (array: number, out: number) => number | Promise<number>,
 *              destroy: (array: number) => number | Promise<number> }} [safeArray]
 *           oleaut32's SafeArrayCopy and SafeArrayDestroy. Absent, a
 *           SAFEARRAY cannot be copied.
 * @property {(entry: number, args: number[], thread?: unknown) => Promise<number>} [call]
 *           A stdcall into the program's code: AddRef and Release on the
 *           interfaces a PROPVARIANT holds. Absent, they are shared without.
 * @property {() => unknown} [callerThread]
 * @property {(api: string, detail: string) => void} [divergence]
 */

/**
 * What a copy or a clear leaves to do once the records are written: the
 * references to take or give back, each a call into the program.
 *
 * @typedef {Object} Owed
 * @property {number[]} addRef
 * @property {number[]} release
 * @property {number[]} [arrays]  SAFEARRAYs to destroy, which releases what they hold.
 * @property {Promise<number>[]} [pending]  Copies of arrays still taking the
 *     references they hold, which have to be waited for first.
 */

/**
 * `then` of a value, or of what a promise of one settles to.
 *
 * @param {any} value @param {(value: any) => any} then
 */
const after = (value, then)=>(typeof value?.then === 'function' ? value.then(then) : then(value));

/**
 * @param {PropVariantHost} host
 */
export function createPropVariantFunctions(host){
    /** @param {number} address */
    const readU16 = address=>{
        const bytes = host.readMemory(address, 2);
        return bytes[0] | bytes[1] << 8;
    };
    /** @param {number} address */
    const readU32 = address=>{
        const bytes = host.readMemory(address, 4);
        return (bytes[0] | bytes[1] << 8 | bytes[2] << 16 | bytes[3] << 24) >>> 0;
    };
    /** @param {Uint8Array} bytes @param {number} at @param {number} value */
    const put32 = (bytes, at, value)=>new DataView(bytes.buffer, bytes.byteOffset)
        .setUint32(at, value >>> 0, true);
    /** @param {Uint8Array} bytes @param {number} at */
    const get32 = (bytes, at)=>new DataView(bytes.buffer, bytes.byteOffset).getUint32(at, true);

    /**
     * The length of a terminated string in bytes, its terminator included,
     * or as much as memory holds of one that runs off its end.
     *
     * @param {number} address @param {number} unit  1 or 2
     */
    const terminatedBytes = (address, unit)=>{
        for (let at = address; ; at += 256)
        {
            const piece = host.readMemory(at, 256);
            for (let index = 0; index + unit <= piece.length; index += unit)
            {
                if (piece[index] === 0 && (unit === 1 || piece[index + 1] === 0))
                {
                    return at - address + index + unit;
                }
            }
            if (piece.length < 256)
            {
                return at - address + piece.length;
            }
        }
    };

    /**
     * Everything a copy made, so that one that fails part of the way gives it
     * all back and leaves the destination as it was.
     *
     * @typedef {Object} Made
     * @property {number[]} blocks  Task memory.
     * @property {number[]} strings  BSTRs.
     * @property {number[]} arrays  SAFEARRAYs.
     */

    /**
     * A block of task memory holding `length` bytes read from `source`; 0
     * when none can be had.
     *
     * @param {number} source @param {number} length @param {Made} made
     */
    const duplicate = (source, length, made)=>{
        const block = host.heap.allocate(length) >>> 0;
        if (block !== 0)
        {
            made.blocks.push(block);
            host.writeMemory(block, host.readMemory(source, length).slice());
        }
        return block;
    };

    /**
     * The value bytes of a copy of the PROPVARIANT at `source`, or the
     * HRESULT that refuses it.
     *
     * @param {number} source @param {Made} made @param {Owed} owed
     * @returns {Uint8Array | number}
     */
    const copyOf = (source, made, owed)=>{
        const vt = readU16(source);
        if (!holdable(vt))
        {
            return DISP_E_BADVARTYPE;
        }
        const record = host.readMemory(source, PROPVARIANT_SIZE).slice();
        const type = vt & VT_TYPEMASK;
        const pointer = get32(record, VALUE);
        const form = vt & ~VT_TYPEMASK;
        if (form === VT_BYREF)
        {
            return record;
        }
        if (form === VT_ARRAY)
        {
            // A SAFEARRAY pointer is all the value holds.
            put32(record, VALUE + 4, 0);
            if (pointer === 0)
            {
                return record;
            }
            const slot = host.heap.allocate(4) >>> 0;
            if (!host.safeArray || slot === 0)
            {
                if (slot !== 0)
                {
                    host.heap.free(slot);
                }
                return E_OUTOFMEMORY;
            }
            const answer = host.safeArray.copy(pointer, slot);
            const array = readU32(slot);
            host.heap.free(slot);
            // A copy of interfaces is answered once their references are
            // taken, calls into the program: the copy is made and named
            // already, and only that much is left to wait for.
            if (typeof answer !== 'number')
            {
                (owed.pending ??= []).push(answer);
            }
            else if (answer !== S_OK)
            {
                return answer;
            }
            made.arrays.push(array);
            put32(record, VALUE, array);
            return record;
        }
        if (form === VT_VECTOR)
        {
            const count = pointer;
            const elements = get32(record, VALUE + 4);
            const size = /** @type {number} */ (VECTOR_ELEMENT.get(type));
            if (count === 0 || elements === 0)
            {
                put32(record, VALUE + 4, 0);
                return record;
            }
            const copied = duplicate(elements, count * size, made);
            if (copied === 0)
            {
                return E_OUTOFMEMORY;
            }
            put32(record, VALUE + 4, copied);
            for (let index = 0; index < count; index++)
            {
                const at = copied + index * size;
                const answer = type === VT_VARIANT ? copyOf(elements + index * size, made, owed)
                    : copyOwned(type, readU32(at), at, made);
                if (typeof answer === 'number' && answer !== S_OK)
                {
                    return answer;
                }
                if (typeof answer !== 'number')
                {
                    host.writeMemory(at, answer);
                }
            }
            return record;
        }
        if (INTERFACES.has(type) || type === VT_RECORD)
        {
            // A record is its data and the IRecordInfo that knows it; the
            // copy shares both, and the reference it takes is on the second.
            const shared = type === VT_RECORD ? get32(record, VALUE + 4) : pointer;
            if (shared !== 0)
            {
                owed.addRef.push(shared);
                if (type === VT_RECORD)
                {
                    host.divergence?.('PropVariantCopy', 'a VT_RECORD is shared with the copy '
                        + 'rather than copied');
                }
            }
            return record;
        }
        if (type === VT_BLOB || type === VT_BLOB_OBJECT)
        {
            // A size, and then the bytes it counts.
            const size = pointer;
            const data = get32(record, VALUE + 4);
            const copied = size === 0 || data === 0 ? 0 : duplicate(data, size, made);
            if (size !== 0 && data !== 0 && copied === 0)
            {
                return E_OUTOFMEMORY;
            }
            put32(record, VALUE + 4, copied);
            return record;
        }
        const answer = copyOwned(type, pointer, -1, made);
        if (typeof answer === 'number' && answer !== S_OK)
        {
            return answer;
        }
        if (typeof answer !== 'number')
        {
            record.set(answer, VALUE);
        }
        return record;
    };

    /**
     * A copy of what a simple value or a vector element of a type owns: a
     * string, clipboard data, a CLSID. Answers the pointer to put in its
     * place, S_OK when there is nothing to put there, or the failure.
     *
     * `at` is where a vector element stands, for the two types a vector
     * holds by value -- a CLIPDATA, whose bytes are copied where it stands,
     * and a CLSID, which is copied with the vector; -1 for a simple value.
     *
     * @param {number} type @param {number} pointer @param {number} at @param {Made} made
     * @returns {Uint8Array | number}
     */
    const copyOwned = (type, pointer, at, made)=>{
        /** @param {number} value */
        const one = value=>{
            const bytes = new Uint8Array(4);
            put32(bytes, 0, value);
            return bytes;
        };
        switch (type)
        {
            case VT_BSTR: {
                if (pointer === 0)
                {
                    return S_OK;
                }
                const copy = host.bstr ? host.bstr.copy(pointer) >>> 0 : 0;
                if (copy === 0)
                {
                    return E_OUTOFMEMORY;
                }
                made.strings.push(copy);
                return one(copy);
            }
            case VT_LPSTR:
            case VT_LPWSTR: {
                if (pointer === 0)
                {
                    return S_OK;
                }
                const copy = duplicate(pointer,
                    terminatedBytes(pointer, type === VT_LPWSTR ? 2 : 1), made);
                return copy === 0 ? E_OUTOFMEMORY : one(copy);
            }
            case VT_CF: {
                // A vector holds CLIPDATA records themselves; a simple
                // value points at one, which is copied too.
                const clip = at >= 0 ? at : pointer;
                if (clip === 0)
                {
                    return S_OK;
                }
                const header = host.readMemory(clip, CLIPDATA_SIZE).slice();
                const data = get32(header, 8);
                const length = Math.max(0, get32(header, 0) - FORMAT_BYTES);
                const copy = data === 0 || length === 0 ? 0 : duplicate(data, length, made);
                if (data !== 0 && length !== 0 && copy === 0)
                {
                    return E_OUTOFMEMORY;
                }
                put32(header, 8, copy);
                if (at >= 0)
                {
                    host.writeMemory(at, header);
                    return S_OK;
                }
                const block = host.heap.allocate(CLIPDATA_SIZE) >>> 0;
                if (block === 0)
                {
                    return E_OUTOFMEMORY;
                }
                made.blocks.push(block);
                host.writeMemory(block, header);
                return one(block);
            }
            case VT_CLSID: {
                if (at >= 0 || pointer === 0)
                {
                    return S_OK;
                }
                const copy = duplicate(pointer, GUID_BYTES, made);
                return copy === 0 ? E_OUTOFMEMORY : one(copy);
            }
            default:
                return S_OK;
        }
    };

    /**
     * Gives back what the PROPVARIANT at `address` owns, the interfaces'
     * references into `owed`; false for a type it may not hold, which owns
     * nothing that can be known.
     *
     * @param {number} address @param {Owed} owed
     */
    const release = (address, owed)=>{
        const vt = readU16(address);
        if (!holdable(vt))
        {
            return false;
        }
        const type = vt & VT_TYPEMASK;
        const form = vt & ~VT_TYPEMASK;
        const pointer = readU32(address + VALUE);
        const second = readU32(address + VALUE + 4);
        if (form === VT_BYREF)
        {
            return true;
        }
        if (form === VT_ARRAY)
        {
            if (pointer !== 0)
            {
                (owed.arrays ??= []).push(pointer);
            }
            return true;
        }
        if (form === VT_VECTOR)
        {
            const size = /** @type {number} */ (VECTOR_ELEMENT.get(type));
            if (second === 0)
            {
                return true;
            }
            for (let index = 0; index < pointer; index++)
            {
                const at = second + index * size;
                if (type === VT_VARIANT)
                {
                    release(at, owed);
                }
                else
                {
                    releaseOwned(type, readU32(at), at);
                }
            }
            host.heap.free(second);
            return true;
        }
        if (INTERFACES.has(type) && pointer !== 0)
        {
            owed.release.push(pointer);
        }
        else if (type === VT_RECORD && second !== 0)
        {
            owed.release.push(second);
        }
        else if ((type === VT_BLOB || type === VT_BLOB_OBJECT) && second !== 0)
        {
            host.heap.free(second);
        }
        else
        {
            releaseOwned(type, pointer, -1);
        }
        return true;
    };

    /**
     * Gives back what a simple value or a vector element of a type owns;
     * `at` as `copyOwned` takes it.
     *
     * @param {number} type @param {number} pointer @param {number} at
     */
    const releaseOwned = (type, pointer, at)=>{
        switch (type)
        {
            case VT_BSTR:
                if (pointer !== 0)
                {
                    host.bstr?.free(pointer);
                }
                break;
            case VT_LPSTR:
            case VT_LPWSTR:
                if (pointer !== 0)
                {
                    host.heap.free(pointer);
                }
                break;
            case VT_CLSID:
                if (pointer !== 0 && at < 0)
                {
                    host.heap.free(pointer);
                }
                break;
            case VT_CF: {
                const clip = at >= 0 ? at : pointer;
                if (clip === 0)
                {
                    break;
                }
                const data = readU32(clip + 8);
                if (data !== 0)
                {
                    host.heap.free(data);
                }
                if (at < 0)
                {
                    host.heap.free(clip);
                }
                break;
            }
            default:
                break;
        }
    };

    /**
     * Destroys SAFEARRAYs one after another. oleaut32's SafeArrayDestroy
     * answers once it has released the interfaces an array holds, which is a
     * call into the program, so a call that destroys one answers no sooner.
     *
     * @param {number[]} arrays
     * @returns {number | Promise<number>}
     */
    const destroyAll = arrays=>arrays.reduce((before, array)=>
        after(before, ()=>host.safeArray?.destroy(array) ?? S_OK), S_OK);

    /** @param {Owed} owed @returns {number | Promise<unknown>} */
    const waited = owed=>(owed.pending ? Promise.all(owed.pending) : S_OK);

    /**
     * Takes or gives back the references a copy or a clear owes, one call
     * into the program at a time, on the thread whose call this is.
     *
     * @param {Owed} owed @param {unknown} thread @param {string} api
     * @returns {number | Promise<number>}
     */
    const reference = (owed, thread, api)=>{
        const calls = [...owed.addRef.map(object=>[object, 1]),
            ...owed.release.map(object=>[object, 2])];
        if (calls.length === 0)
        {
            return S_OK;
        }
        const call = host.call;
        if (!call)
        {
            host.divergence?.(api, api === 'PropVariantCopy'
                ? 'an interface is shared with the copy without a reference of its own'
                : 'an interface the value held is not released');
            return S_OK;
        }
        return calls.reduce((before, [object, slot])=>before.then(()=>
            call(readU32(readU32(object) + slot * 4), [object], thread)),
        Promise.resolve(0)).then(()=>S_OK);
    };

    /**
     * Everything a copy or a clear owes once its records are written: the
     * copied arrays' references, the arrays it destroys, then its own.
     *
     * @param {Owed} owed @param {unknown} thread @param {string} api
     * @returns {number | Promise<number>}
     */
    const settle = (owed, thread, api)=>after(waited(owed),
        ()=>after(destroyAll(owed.arrays ?? []), ()=>reference(owed, thread, api)));

    return {
        /**
         * HRESULT PropVariantCopy(PROPVARIANT *pvarDest, const PROPVARIANT *pvarSrc)
         *
         * The destination is not cleared first, and is written only once
         * the whole copy is made: a type it may not hold, or memory that
         * runs out part of the way, leaves it as it was and gives back
         * whatever had been made.
         */
        PropVariantCopy: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([dest, src])=>{
                if ((dest >>> 0) === 0 || (src >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                const thread = host.callerThread?.();
                /** @type {Made} */
                const made = { blocks: [], strings: [], arrays: [] };
                /** @type {Owed} */
                const owed = { addRef: [], release: [] };
                const copy = copyOf(src >>> 0, made, owed);
                if (typeof copy === 'number')
                {
                    made.blocks.forEach(block=>host.heap.free(block));
                    made.strings.forEach(string=>host.bstr?.free(string));
                    return after(waited(owed), ()=>after(destroyAll(made.arrays), ()=>copy));
                }
                host.writeMemory(dest >>> 0, copy);
                return settle(owed, thread, 'PropVariantCopy');
            },
        },

        /**
         * HRESULT PropVariantClear(PROPVARIANT *pvar)
         *
         * NULL is nothing to clear. Whatever the type, the record is zero
         * afterwards.
         */
        PropVariantClear: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([pvar])=>{
                if ((pvar >>> 0) === 0)
                {
                    return S_OK;
                }
                const thread = host.callerThread?.();
                /** @type {Owed} */
                const owed = { addRef: [], release: [] };
                const known = release(pvar >>> 0, owed);
                host.writeMemory(pvar >>> 0, new Uint8Array(PROPVARIANT_SIZE));
                if (!known)
                {
                    return STG_E_INVALIDPARAMETER;
                }
                return settle(owed, thread, 'PropVariantClear');
            },
        },
    };
}
