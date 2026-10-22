/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The NDR engine a MIDL `-Os` stub calls: a type format string walked over
 * guest memory, into and out of an RPC buffer.
 *
 * A proxy or stub compiled in `-Os` mode is x86 code of its own that sizes,
 * marshals and unmarshals its arguments by calling rpcrt4 with a pointer into
 * the type format string it was compiled with; the simplest values (a long, an
 * HRESULT) it writes into the buffer itself. Everything here is what those
 * calls do, and it has to agree byte for byte with the code MIDL inlined,
 * because the two write the same buffer in turns:
 *
 * - Alignment is of the buffer pointer itself, as the inlined
 *   `(Buffer + 3) & ~3` does, so a buffer has to start eight-aligned for the
 *   sizing pass, which aligns the length, to have counted enough.
 * - A top-level reference pointer has no representation; a unique, object or
 *   full pointer is a four-byte referent ID, zero for NULL, followed by what it
 *   points at. A pointer embedded in a structure or an array is its ID in
 *   place, and what it points at follows the whole structure, in the order of
 *   the pointer layout, each pointee's own pointees after it.
 * - A conformant string is its maximum count, its offset (zero) and its actual
 *   count, each four bytes, then the characters with the terminator.
 * - A conformant array is its count first, then its elements; a conformant
 *   varying array its count, offset and length, then the elements in range.
 * - An interface pointer is a unique pointer to an MInterfacePointer: the
 *   conformance and the byte count of an OBJREF, then the OBJREF, which ole32
 *   makes and reads.
 *
 * The rules of ownership are NDR's. On the server an [in] value that can be
 * used where it lies in the buffer is not copied, and freeing it frees
 * nothing; everything else unmarshaled is allocated through the stub
 * descriptor's allocator and freed through its free routine. A proxy that
 * failed clears its [out] parameters, releasing only what its own unmarshal
 * made.
 *
 * Format characters and layouts are those of the MIDL format string
 * documentation. A character this file does not implement is said, through
 * the divergence the host reports, and fails the call with
 * RPC_S_CANNOT_SUPPORT rather than walking on through bytes it cannot read.
 */

import { readToTerminator } from '../common/scan-windows.js';

/** Format characters. */
export const FC = Object.freeze({
    BYTE: 0x01,
    CHAR: 0x02,
    SMALL: 0x03,
    USMALL: 0x04,
    WCHAR: 0x05,
    SHORT: 0x06,
    USHORT: 0x07,
    LONG: 0x08,
    ULONG: 0x09,
    FLOAT: 0x0a,
    HYPER: 0x0b,
    DOUBLE: 0x0c,
    ENUM16: 0x0d,
    ENUM32: 0x0e,
    IGNORE: 0x0f,
    ERROR_STATUS_T: 0x10,
    RP: 0x11,
    UP: 0x12,
    OP: 0x13,
    FP: 0x14,
    STRUCT: 0x15,
    PSTRUCT: 0x16,
    CSTRUCT: 0x17,
    CPSTRUCT: 0x18,
    CVSTRUCT: 0x19,
    BOGUS_STRUCT: 0x1a,
    CARRAY: 0x1b,
    CVARRAY: 0x1c,
    SMFARRAY: 0x1d,
    LGFARRAY: 0x1e,
    SMVARRAY: 0x1f,
    LGVARRAY: 0x20,
    BOGUS_ARRAY: 0x21,
    C_CSTRING: 0x22,
    C_WSTRING: 0x25,
    IP: 0x2f,
    STRING_SIZED: 0x44,
    NO_REPEAT: 0x46,
    FIXED_REPEAT: 0x47,
    VARIABLE_REPEAT: 0x48,
    FIXED_OFFSET: 0x49,
    VARIABLE_OFFSET: 0x4a,
    PP: 0x4b,
    EMBEDDED_COMPLEX: 0x4c,
    DEREFERENCE: 0x54,
    DIV_2: 0x55,
    MULT_2: 0x56,
    ADD_1: 0x57,
    SUB_1: 0x58,
    CALLBACK: 0x59,
    CONSTANT_IID: 0x5a,
    END: 0x5b,
    PAD: 0x5c,
    INT3264: 0xb8,
    UINT3264: 0xb9,
});

/** A pointer's attribute byte. */
export const POINTER = Object.freeze({
    ALLOCATE_ALL_NODES: 0x01,
    DONT_FREE: 0x02,
    ALLOCED_ON_STACK: 0x04,
    SIMPLE_POINTER: 0x08,
    DEREF: 0x10,
});

/** A correlation descriptor's kinds, the high nibble of its first byte. */
const CORRELATION = Object.freeze({
    NORMAL: 0x00,
    POINTER: 0x10,
    TOP_LEVEL: 0x20,
    CONSTANT: 0x40,
    TOP_LEVEL_MULTID: 0x80,
});

/**
 * MIDL_STUB_MESSAGE, 32-bit, as far as it is the same in every header since
 * NT 3.5: the fields past the stub phase differ between versions, and a stub
 * compiled against an old header has no room for them on its stack.
 */
export const STUB_MESSAGE = Object.freeze({
    RPC_MESSAGE: 0,
    BUFFER: 4,
    BUFFER_START: 8,
    BUFFER_END: 12,
    BUFFER_MARK: 16,
    BUFFER_LENGTH: 20,
    MEMORY_SIZE: 24,
    MEMORY: 28,
    IS_CLIENT: 32,
    REUSE_BUFFER: 36,
    IGNORE_EMBEDDED_POINTERS: 48,
    MAX_COUNT: 60,
    OFFSET: 64,
    ACTUAL_COUNT: 68,
    ALLOCATE: 72,
    FREE: 76,
    STACK_TOP: 80,
    STUB_DESC: 96,
    DEST_CONTEXT: 116,
    DEST_CONTEXT_POINTER: 120,
    CHANNEL: 132,
    STUB_PHASE: 156,
    SIZE: 160,
});

/** RPC_MESSAGE, and RPCOLEMESSAGE, which has the same layout. */
export const RPC_MESSAGE = Object.freeze({
    HANDLE: 0,
    DATA_REPRESENTATION: 4,
    BUFFER: 8,
    BUFFER_LENGTH: 12,
    PROC_NUM: 16,
    TRANSFER_SYNTAX: 20,
    INTERFACE_INFORMATION: 24,
    FLAGS: 40,
    SIZE: 44,
});

/** MIDL_STUB_DESC, the fields the runtime reads. */
export const STUB_DESC = Object.freeze({
    INTERFACE_INFORMATION: 0,
    ALLOCATE: 4,
    FREE: 8,
    FORMAT_TYPES: 32,
    VERSION: 40,
});

/** Little-endian integers, ASCII characters and IEEE floats. */
export const NDR_LOCAL_DATA_REPRESENTATION = 0x10;

/** Where a proxy is in its call, which its exception filter reads. */
export const PROXY_PHASE = Object.freeze({
    CALCSIZE: 0,
    GETBUFFER: 1,
    MARSHAL: 2,
    SENDRECEIVE: 3,
    UNMARSHAL: 4,
});

/** The statuses the engine raises. */
export const RPC_STATUS = Object.freeze({
    S_OUT_OF_MEMORY: 14,
    X_INVALID_BOUND: 1734,
    S_CANNOT_SUPPORT: 1764,
    S_INTERNAL_ERROR: 1766,
    X_NULL_REF_POINTER: 1780,
    X_ENUM_VALUE_OUT_OF_RANGE: 1781,
    X_BAD_STUB_DATA: 1783,
});

/** The first referent ID a message hands out; the next are four apart. */
const FIRST_REFERENT = 0x20000;

/** The longest string a marshal will look for the end of, in characters. */
const LONGEST_STRING = 1 << 20;

/**
 * What an NDR call raises: the status the generated code's exception block
 * receives as its exception code.
 */
export class RpcException extends Error {
    /** @param {number} code @param {string} [detail] */
    constructor(code, detail){
        super(detail ?? `RPC status ${code}`);
        this.code = code;
    }
}

/**
 * One call as the engine sees it: the stub message, and the thread whose call
 * it is, for whatever the host has to run in the guest along the way.
 *
 * @typedef {Object} NdrCall
 * @property {number} message
 * @property {unknown} [thread]
 */

/**
 * @typedef {Object} NdrHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(call: NdrCall, bytes: number) => number | Promise<number>} allocate
 *           Through the stub descriptor's allocator; 0 when nothing fits.
 * @property {(call: NdrCall, address: number) => unknown} free
 * @property {(call: NdrCall, pointer: number, iid: Uint8Array) => Promise<Uint8Array>}
 *           marshalInterface  An OBJREF for the pointer, holding a reference
 *           of its own for the receiver. Throws an RpcException on failure.
 * @property {(call: NdrCall, objref: Uint8Array, iid: Uint8Array | null) => Promise<number>}
 *           unmarshalInterface  A pointer of this process holding one reference,
 *           for the interface the OBJREF carries when `iid` is null.
 * @property {(call: NdrCall, pointer: number) => unknown} releaseInterface
 * @property {number} interfaceBytes  The most an OBJREF takes.
 * @property {(detail: string) => void} [divergence]
 */

/**
 * @typedef {Object} BaseType
 * @property {number} memory  Bytes it takes in memory.
 * @property {number} wire    Bytes it takes in the buffer, and its alignment there.
 */

/** @type {Map<number, BaseType>} */
const BASE_TYPES = new Map([
    [FC.BYTE, { memory: 1, wire: 1 }],
    [FC.CHAR, { memory: 1, wire: 1 }],
    [FC.SMALL, { memory: 1, wire: 1 }],
    [FC.USMALL, { memory: 1, wire: 1 }],
    [FC.WCHAR, { memory: 2, wire: 2 }],
    [FC.SHORT, { memory: 2, wire: 2 }],
    [FC.USHORT, { memory: 2, wire: 2 }],
    [FC.LONG, { memory: 4, wire: 4 }],
    [FC.ULONG, { memory: 4, wire: 4 }],
    [FC.FLOAT, { memory: 4, wire: 4 }],
    [FC.ENUM32, { memory: 4, wire: 4 }],
    [FC.ERROR_STATUS_T, { memory: 4, wire: 4 }],
    [FC.INT3264, { memory: 4, wire: 4 }],
    [FC.UINT3264, { memory: 4, wire: 4 }],
    // An enum16 is an int in memory and two bytes on the wire.
    [FC.ENUM16, { memory: 4, wire: 2 }],
    [FC.HYPER, { memory: 8, wire: 8 }],
    [FC.DOUBLE, { memory: 8, wire: 8 }],
    // An [ignore] pointer crosses as a null one.
    [FC.IGNORE, { memory: 4, wire: 4 }],
]);

/** @type {Set<number>} */
const POINTER_TYPES = new Set([FC.RP, FC.UP, FC.OP, FC.FP]);

/** @param {number} value @param {number} to */
const align = (value, to)=>to <= 1 ? value >>> 0 : ((value + to - 1) & ~(to - 1)) >>> 0;

/**
 * @typedef {Object} PointerEntry
 * @property {number} memory  Where the pointer is, from the start of what holds it.
 * @property {number} buffer  Where its ID is in the buffer, likewise.
 * @property {number} format  Its four-byte description.
 */

/**
 * @typedef {Object} MessageState
 * @property {number} nextReferent
 * @property {Map<number, number>} fullSized       Full pointers already counted.
 * @property {Map<number, number>} fullMarshalled  Full pointer to its ID.
 * @property {Map<number, number>} fullUnmarshalled  ID to the pointer made for it.
 * @property {Set<number>} fullFreed
 * @property {[number, number][]} inPlace  Buffer ranges values were left in.
 * @property {Set<number>} made      Blocks this call's unmarshal allocated.
 * @property {Set<number>} imported  Interfaces this call's unmarshal made.
 */

/**
 * @param {NdrHost} host
 */
export function createNdr(host){
    /** @param {number} at */
    const u8 = at=>host.readMemory(at >>> 0, 1)[0];
    /** @param {number} at */
    const u16 = at=>{
        const bytes = host.readMemory(at >>> 0, 2);
        return bytes[0] | (bytes[1] << 8);
    };
    /** @param {number} at */
    const i16 = at=>(u16(at) << 16) >> 16;
    /** @param {number} at */
    const u32 = at=>{
        const bytes = host.readMemory(at >>> 0, 4);
        return (bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24)) >>> 0;
    };
    /** @param {number} at @param {number} value */
    const w32 = (at, value)=>host.writeMemory(at >>> 0, Uint8Array.of(
        value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff));

    /** @param {NdrCall} call @param {number} offset */
    const field = (call, offset)=>u32(call.message + offset);
    /** @param {NdrCall} call @param {number} offset @param {number} value */
    const setField = (call, offset, value)=>w32(call.message + offset, value);

    /** @type {Map<number, MessageState>} */
    const states = new Map();
    /** @param {NdrCall} call */
    const state = call=>{
        let found = states.get(call.message);
        if (!found)
        {
            found = {
                nextReferent: FIRST_REFERENT,
                fullSized: new Map(),
                fullMarshalled: new Map(),
                fullUnmarshalled: new Map(),
                fullFreed: new Set(),
                inPlace: [],
                made: new Set(),
                imported: new Set(),
            };
            states.set(call.message, found);
        }
        return found;
    };

    /** @param {string} what */
    const unsupported = what=>{
        host.divergence?.(`${what} is not implemented`);
        return new RpcException(RPC_STATUS.S_CANNOT_SUPPORT, `${what} is not implemented`);
    };

    /** @param {number} at */
    const unknownType = at=>unsupported(
        `format character 0x${u8(at).toString(16).padStart(2, '0')}`);

    /** @param {NdrCall} call */
    const isClient = call=>(u8(call.message + STUB_MESSAGE.IS_CLIENT)) !== 0;

    /**
     * Sizing: the length grows by padding to `to` and then by `bytes`.
     *
     * @param {NdrCall} call @param {number} to @param {number} bytes
     */
    const grow = (call, to, bytes)=>{
        const length = align(field(call, STUB_MESSAGE.BUFFER_LENGTH), to);
        setField(call, STUB_MESSAGE.BUFFER_LENGTH, length + bytes);
    };

    /**
     * Marshaling: the buffer aligned, with the padding cleared, and `bytes`
     * of room taken. Answers where they start.
     *
     * @param {NdrCall} call @param {number} to @param {number} bytes
     */
    const put = (call, to, bytes)=>{
        const buffer = field(call, STUB_MESSAGE.BUFFER);
        const at = align(buffer, to);
        const end = field(call, STUB_MESSAGE.BUFFER_END);
        if (at + bytes > end)
        {
            throw new RpcException(RPC_STATUS.S_INTERNAL_ERROR,
                'the buffer is smaller than what is marshaled into it');
        }
        if (at > buffer)
        {
            host.writeMemory(buffer, new Uint8Array(at - buffer));
        }
        setField(call, STUB_MESSAGE.BUFFER, at + bytes);
        return at;
    };

    /**
     * Unmarshaling: the buffer aligned and `bytes` of it taken, which must be
     * there. Answers where they start.
     *
     * @param {NdrCall} call @param {number} to @param {number} bytes
     */
    const take = (call, to, bytes)=>{
        const at = align(field(call, STUB_MESSAGE.BUFFER), to);
        const end = field(call, STUB_MESSAGE.BUFFER_END);
        if (bytes < 0 || at + bytes > end || at + bytes < at)
        {
            throw new RpcException(RPC_STATUS.X_BAD_STUB_DATA, 'the buffer ends early');
        }
        setField(call, STUB_MESSAGE.BUFFER, at + bytes);
        return at;
    };

    /** @param {NdrCall} call @param {number} bytes */
    const allocate = async(call, bytes)=>{
        const at = (await host.allocate(call, Math.max(bytes, 1))) >>> 0;
        if (at === 0)
        {
            throw new RpcException(RPC_STATUS.S_OUT_OF_MEMORY);
        }
        state(call).made.add(at);
        return at;
    };

    /** @param {NdrCall} call @param {number} address */
    const leftInBuffer = (call, address)=>state(call).inPlace.some(([start, end])=>
        address >= start && address < end);

    /** @param {NdrCall} call @param {number} address */
    const release = async(call, address)=>{
        if (address === 0 || leftInBuffer(call, address))
        {
            return;
        }
        state(call).made.delete(address);
        await host.free(call, address);
    };

    /**
     * On the server, a value that is laid out in the buffer as it would be in
     * memory is used where it lies, unless the stub asked for a copy.
     *
     * @param {NdrCall} call @param {number} ppMemory @param {boolean} mustAlloc
     */
    const mayUseBuffer = (call, ppMemory, mustAlloc)=>!mustAlloc && !isClient(call)
        && u32(ppMemory) === 0;

    /** @param {NdrCall} call @param {number} start @param {number} bytes */
    const keepInPlace = (call, start, bytes)=>{
        state(call).inPlace.push([start, start + bytes]);
    };

    /**
     * Where a value the stub's memory is to hold goes: where the pointer
     * already points, a fresh block, or the buffer.
     *
     * @param {NdrCall} call @param {number} ppMemory @param {boolean} mustAlloc
     * @param {number} bytes
     */
    const destination = async(call, ppMemory, mustAlloc, bytes)=>{
        const current = u32(ppMemory);
        if (current !== 0 && !mustAlloc)
        {
            return current;
        }
        const made = await allocate(call, bytes);
        w32(ppMemory, made);
        return made;
    };

    // --- correlation ------------------------------------------------------------

    /**
     * The value a correlation descriptor names: a count, a length, or the
     * address of an IID. Null for a top-level one the generated code set
     * itself, which is how `-Os` code passes them.
     *
     * @param {NdrCall} call @param {number} at  The descriptor.
     * @param {number} memory  What a normal correlation is relative to.
     * @returns {number | null}
     */
    const correlate = (call, at, memory)=>{
        const first = u8(at);
        const operator = u8(at + 1);
        const offset = i16(at + 2);
        const kind = first & 0xf0;
        const type = first & 0x0f;
        if (kind === CORRELATION.CONSTANT)
        {
            return ((operator << 16) | u16(at + 2)) >>> 0;
        }
        let base;
        if (kind === CORRELATION.TOP_LEVEL)
        {
            const top = field(call, STUB_MESSAGE.STACK_TOP);
            if (top === 0)
            {
                return null;
            }
            base = top + offset;
        }
        else if (kind === CORRELATION.NORMAL)
        {
            base = memory + offset;
        }
        else if (kind === CORRELATION.POINTER)
        {
            base = field(call, STUB_MESSAGE.MEMORY) + offset;
        }
        else
        {
            throw unsupported(`correlation kind 0x${kind.toString(16)}`);
        }
        if (operator === FC.DEREFERENCE)
        {
            base = u32(base);
        }
        let value = readCorrelation(base >>> 0, type);
        switch (operator)
        {
            case 0:
            case FC.DEREFERENCE:
                break;
            case FC.DIV_2:
                value = Math.floor(value / 2);
                break;
            case FC.MULT_2:
                value *= 2;
                break;
            case FC.ADD_1:
                value += 1;
                break;
            case FC.SUB_1:
                value -= 1;
                break;
            default:
                throw unsupported(`correlation operator 0x${operator.toString(16)}`);
        }
        return value >>> 0;
    };

    /** @param {number} at @param {number} type */
    const readCorrelation = (at, type)=>{
        switch (type)
        {
            case FC.BYTE:
            case FC.USMALL:
            case FC.CHAR:
                return u8(at);
            case FC.SMALL:
                return (u8(at) << 24) >> 24;
            case FC.USHORT:
            case FC.WCHAR:
                return u16(at);
            case FC.SHORT:
                return i16(at);
            default:
                return u32(at);
        }
    };

    /** @param {NdrCall} call @param {number} at @param {number} memory */
    const conformance = (call, at, memory)=>
        correlate(call, at, memory) ?? field(call, STUB_MESSAGE.MAX_COUNT);

    /**
     * A variance descriptor: the length the array has, and the element it
     * starts at, which for a top-level one the generated code set as well.
     *
     * @param {NdrCall} call @param {number} at @param {number} memory
     */
    const variance = (call, at, memory)=>{
        const length = correlate(call, at, memory);
        if (length !== null)
        {
            return { offset: 0, length };
        }
        return { offset: field(call, STUB_MESSAGE.OFFSET),
            length: field(call, STUB_MESSAGE.ACTUAL_COUNT) };
    };

    // --- base types -------------------------------------------------------------

    /** @param {number} fc */
    const baseType = fc=>BASE_TYPES.get(fc) ?? null;

    /** @param {NdrCall} call @param {number} memory @param {number} fc */
    const marshallBase = (call, memory, fc)=>{
        const type = /** @type {BaseType} */ (baseType(fc));
        const at = put(call, type.wire, type.wire);
        if (fc === FC.IGNORE)
        {
            host.writeMemory(at, new Uint8Array(4));
            return;
        }
        if (fc === FC.ENUM16 && u32(memory) > 0x7fff)
        {
            throw new RpcException(RPC_STATUS.X_ENUM_VALUE_OUT_OF_RANGE);
        }
        host.writeMemory(at, host.readMemory(memory, type.wire).slice());
    };

    /** @param {NdrCall} call @param {number} memory @param {number} fc */
    const unmarshallBase = (call, memory, fc)=>{
        const type = /** @type {BaseType} */ (baseType(fc));
        const at = take(call, type.wire, type.wire);
        if (fc === FC.IGNORE)
        {
            w32(memory, 0);
            return;
        }
        const bytes = new Uint8Array(type.memory);
        bytes.set(host.readMemory(at, type.wire));
        host.writeMemory(memory, bytes);
    };

    // --- layouts ----------------------------------------------------------------

    /**
     * A pointer layout (FC_PP FC_PAD ... FC_END), as the pointers it names.
     *
     * Offsets are from the first element in range, in memory as in the
     * buffer: a varying array's pointers are read from where its range
     * starts, which is what FC_VARIABLE_OFFSET says of them.
     *
     * @param {number} at  The FC_PP.
     * @param {number} count  Elements, for a variable repeat.
     * @returns {PointerEntry[]}
     */
    const pointerLayout = (at, count)=>{
        /** @type {PointerEntry[]} */
        const pointers = [];
        let cursor = at + 2;
        for (let guard = 0; guard < 4096; guard++)
        {
            const kind = u8(cursor);
            if (kind === FC.END)
            {
                return pointers;
            }
            if (kind === FC.NO_REPEAT)
            {
                pointers.push({ memory: i16(cursor + 2), buffer: i16(cursor + 4),
                    format: cursor + 6 });
                cursor += 10;
                continue;
            }
            if (kind !== FC.FIXED_REPEAT && kind !== FC.VARIABLE_REPEAT)
            {
                throw unknownType(cursor);
            }
            const fixed = kind === FC.FIXED_REPEAT;
            const iterations = fixed ? u16(cursor + 2) : count;
            const header = fixed ? cursor + 4 : cursor + 2;
            const increment = u16(header);
            const toArray = i16(header + 2);
            const each = u16(header + 4);
            for (let element = 0; element < iterations; element++)
            {
                for (let index = 0; index < each; index++)
                {
                    const entry = header + 6 + index * 8;
                    pointers.push({
                        memory: toArray + element * increment + i16(entry),
                        buffer: toArray + element * increment + i16(entry + 2),
                        format: entry + 4,
                    });
                }
            }
            cursor = header + 6 + each * 8;
        }
        throw new RpcException(RPC_STATUS.S_INTERNAL_ERROR, 'a pointer layout without an end');
    };

    /**
     * The pointer layout an array's format has after its header, or 0.
     *
     * @param {number} at
     */
    const layoutAt = at=>u8(at) === FC.PP ? at : 0;

    /**
     * Everything an array is, read from its format.
     *
     * @param {NdrCall} call @param {number} format @param {number} memory
     * @param {'size' | 'marshall' | 'unmarshall' | 'free'} purpose
     * @returns {{ alignment: number, elementSize: number, count: number, offset: number,
     *     length: number, conformant: boolean, varying: boolean, layout: number,
     *     total: number }}
     */
    const arrayShape = (call, format, memory, purpose)=>{
        const fc = u8(format);
        const alignment = u8(format + 1) + 1;
        if (fc === FC.SMFARRAY || fc === FC.LGFARRAY)
        {
            const small = fc === FC.SMFARRAY;
            const total = small ? u16(format + 2) : u32(format + 2);
            const layout = layoutAt(format + (small ? 4 : 6));
            return { alignment, elementSize: 1, count: total, offset: 0, length: total,
                conformant: false, varying: false, layout, total };
        }
        const elementSize = u16(format + 2);
        const varying = fc === FC.CVARRAY;
        const tail = format + (varying ? 12 : 8);
        const layout = layoutAt(tail);
        if (purpose === 'unmarshall')
        {
            return { alignment, elementSize, count: 0, offset: 0, length: 0,
                conformant: true, varying, layout, total: 0 };
        }
        const count = conformance(call, format + 4, memory);
        const range = varying ? variance(call, format + 8, memory)
            : { offset: 0, length: count };
        return { alignment, elementSize, count, offset: range.offset, length: range.length,
            conformant: true, varying, layout, total: count * elementSize };
    };

    // --- pointers ---------------------------------------------------------------

    /** @param {number} format */
    const pointeeOf = format=>(u8(format + 1) & POINTER.SIMPLE_POINTER) !== 0
        ? format + 2
        : format + 2 + i16(format + 2);

    /** @param {NdrCall} call */
    const referent = call=>{
        const held = state(call);
        const id = held.nextReferent;
        held.nextReferent += 4;
        return id;
    };

    /**
     * Counts a pointer and what it points at. `embedded` when its ID was
     * counted with what holds it.
     *
     * @param {NdrCall} call @param {number} value @param {number} format
     * @param {boolean} embedded
     */
    const sizePointer = async(call, value, format, embedded)=>{
        const type = u8(format);
        if (type !== FC.RP && !embedded)
        {
            grow(call, 4, 4);
        }
        if (value === 0)
        {
            if (type === FC.RP)
            {
                throw new RpcException(RPC_STATUS.X_NULL_REF_POINTER,
                    `a null [ref] pointer sized at format 0x${format.toString(16)}`);
            }
            return;
        }
        if (type === FC.FP)
        {
            const sized = state(call).fullSized;
            if (sized.has(value))
            {
                return;
            }
            sized.set(value, 1);
        }
        await sizePointee(call, value, format);
    };

    /** @param {NdrCall} call @param {number} value @param {number} format */
    const sizePointee = async(call, value, format)=>{
        const deref = (u8(format + 1) & POINTER.DEREF) !== 0;
        await bufferSize(call, deref ? u32(value) : value, pointeeOf(format));
    };

    /**
     * Writes a pointer's ID -- into the stream, or into `slot` for one held
     * in a structure -- and answers whether its pointee is to follow.
     *
     * @param {NdrCall} call @param {number} value @param {number} format
     * @param {number | null} slot
     */
    const pointerId = (call, value, format, slot)=>{
        const type = u8(format);
        if (type === FC.RP)
        {
            if (value === 0)
            {
                throw new RpcException(RPC_STATUS.X_NULL_REF_POINTER,
                    `a null [ref] pointer marshalled at format 0x${format.toString(16)}`);
            }
            if (slot !== null)
            {
                w32(slot, referent(call));
            }
            return true;
        }
        let id = 0;
        let follows = value !== 0;
        if (value !== 0 && type === FC.FP)
        {
            const known = state(call).fullMarshalled;
            const already = known.get(value);
            follows = already === undefined;
            id = already ?? referent(call);
            known.set(value, id);
        }
        else if (value !== 0)
        {
            id = referent(call);
        }
        w32(slot ?? put(call, 4, 4), id);
        return follows;
    };

    /** @param {NdrCall} call @param {number} value @param {number} format */
    const marshallPointee = async(call, value, format)=>{
        const deref = (u8(format + 1) & POINTER.DEREF) !== 0;
        await marshall(call, deref ? u32(value) : value, pointeeOf(format));
    };

    /**
     * Reads a pointer back: its ID from the stream (or `id` for one held in a
     * structure), then what it points at, into `slot`.
     *
     * @param {NdrCall} call @param {number} slot  Where the pointer lives.
     * @param {number} format @param {boolean} mustAlloc
     * @param {number | null} id
     */
    const unmarshallPointer = async(call, slot, format, mustAlloc, id)=>{
        const type = u8(format);
        const attributes = u8(format + 1);
        let referentId = id;
        if (type !== FC.RP && referentId === null)
        {
            referentId = u32(take(call, 4, 4));
        }
        if (referentId === 0)
        {
            if (type === FC.RP)
            {
                throw new RpcException(RPC_STATUS.X_BAD_STUB_DATA,
                    'a reference pointer is null in the buffer');
            }
            w32(slot, 0);
            return;
        }
        const full = type === FC.FP ? state(call).fullUnmarshalled : null;
        const seen = full?.get(referentId ?? 0);
        if (seen !== undefined)
        {
            w32(slot, seen);
            return;
        }
        const pointee = pointeeOf(format);
        if ((attributes & POINTER.DEREF) !== 0)
        {
            let inner = u32(slot);
            if (inner === 0 || mustAlloc)
            {
                inner = await allocate(call, 4);
                w32(inner, 0);
                w32(slot, inner);
            }
            await unmarshall(call, inner, pointee, mustAlloc);
        }
        else
        {
            await unmarshall(call, slot, pointee, mustAlloc);
        }
        full?.set(referentId ?? 0, u32(slot));
    };

    /**
     * Frees what a pointer points at, and the block it points into unless
     * the stub owns it, the buffer holds it, or the format says not to.
     *
     * @param {NdrCall} call @param {number} value @param {number} format
     */
    const freePointer = async(call, value, format)=>{
        if (value === 0)
        {
            return;
        }
        const attributes = u8(format + 1);
        if (u8(format) === FC.FP)
        {
            const freed = state(call).fullFreed;
            if (freed.has(value))
            {
                return;
            }
            freed.add(value);
        }
        const pointee = pointeeOf(format);
        const deref = (attributes & POINTER.DEREF) !== 0;
        await free(call, deref ? u32(value) : value, pointee);
        if (!deref && u8(pointee) === FC.IP)
        {
            // The pointer is the interface, which has no block of its own.
            return;
        }
        if ((attributes & (POINTER.DONT_FREE | POINTER.ALLOCED_ON_STACK)) === 0)
        {
            await release(call, value);
        }
    };

    // --- what holds pointers ----------------------------------------------------

    /**
     * The pointers a structure or an array holds, written as IDs into its
     * copy in the buffer, then what they point at, after it.
     *
     * @param {NdrCall} call @param {number} memory @param {number} copy
     * @param {PointerEntry[]} pointers
     */
    const marshallEmbedded = async(call, memory, copy, pointers)=>{
        if (field(call, STUB_MESSAGE.IGNORE_EMBEDDED_POINTERS) !== 0)
        {
            return;
        }
        /** @type {{ value: number, format: number }[]} */
        const following = [];
        for (const entry of pointers)
        {
            const value = u32(memory + entry.memory);
            if (pointerId(call, value, entry.format, copy + entry.buffer))
            {
                following.push({ value, format: entry.format });
            }
        }
        const outer = field(call, STUB_MESSAGE.MEMORY);
        setField(call, STUB_MESSAGE.MEMORY, memory);
        for (const { value, format } of following)
        {
            await marshallPointee(call, value, format);
        }
        setField(call, STUB_MESSAGE.MEMORY, outer);
    };

    /**
     * @param {NdrCall} call @param {number} memory @param {PointerEntry[]} pointers
     */
    const sizeEmbedded = async(call, memory, pointers)=>{
        if (field(call, STUB_MESSAGE.IGNORE_EMBEDDED_POINTERS) !== 0)
        {
            return;
        }
        const outer = field(call, STUB_MESSAGE.MEMORY);
        setField(call, STUB_MESSAGE.MEMORY, memory);
        for (const entry of pointers)
        {
            await sizePointer(call, u32(memory + entry.memory), entry.format, true);
        }
        setField(call, STUB_MESSAGE.MEMORY, outer);
    };

    /**
     * The pointers of a structure or array whose flat copy is in memory
     * already: each slot holds the ID it crossed as until it is given a
     * pointer of this process.
     *
     * @param {NdrCall} call @param {number} memory @param {number} copy
     * @param {PointerEntry[]} pointers @param {boolean} mustAlloc
     */
    const unmarshallEmbedded = async(call, memory, copy, pointers, mustAlloc)=>{
        const outer = field(call, STUB_MESSAGE.MEMORY);
        setField(call, STUB_MESSAGE.MEMORY, memory);
        const ids = pointers.map(entry=>u32(copy + entry.buffer));
        for (const entry of pointers)
        {
            w32(memory + entry.memory, 0);
        }
        for (let index = 0; index < pointers.length; index++)
        {
            const entry = pointers[index];
            await unmarshallPointer(call, memory + entry.memory, entry.format, mustAlloc,
                ids[index]);
        }
        setField(call, STUB_MESSAGE.MEMORY, outer);
    };

    /** @param {NdrCall} call @param {number} memory @param {PointerEntry[]} pointers */
    const freeEmbedded = async(call, memory, pointers)=>{
        for (const entry of pointers)
        {
            await freePointer(call, u32(memory + entry.memory), entry.format);
        }
    };

    // --- structures -------------------------------------------------------------

    /**
     * @param {number} format
     * @returns {{ alignment: number, size: number, pointers: PointerEntry[] }}
     */
    const structShape = format=>{
        const fc = u8(format);
        const alignment = u8(format + 1) + 1;
        const size = u16(format + 2);
        const pointers = fc === FC.PSTRUCT && u8(format + 4) === FC.PP
            ? pointerLayout(format + 4, 0)
            : [];
        return { alignment, size, pointers };
    };

    // --- strings ----------------------------------------------------------------

    /** @param {number} format */
    const charSize = format=>u8(format) === FC.C_WSTRING ? 2 : 1;

    /**
     * Characters up to and including the terminator; read a window at a time,
     * so a string at the end of what the program allocated is not read past.
     *
     * @param {number} memory @param {number} unit
     */
    const stringLength = (memory, unit)=>{
        const { bytes, terminated } = readToTerminator(host, memory, unit, LONGEST_STRING);
        if (!terminated)
        {
            throw new RpcException(RPC_STATUS.X_BAD_STUB_DATA, 'a string without an end');
        }
        return bytes.length / unit + 1;
    };

    /**
     * A sized string's maximum count, or its length when it is not sized.
     *
     * @param {NdrCall} call @param {number} format @param {number} length
     */
    const stringMaximum = (call, format, length)=>{
        if (u8(format + 1) !== FC.STRING_SIZED)
        {
            return length;
        }
        const maximum = conformance(call, format + 2, field(call, STUB_MESSAGE.MEMORY));
        if (length > maximum)
        {
            throw new RpcException(RPC_STATUS.X_INVALID_BOUND);
        }
        return maximum;
    };

    // --- interface pointers ----------------------------------------------------

    /**
     * The IID an FC_IP names: in the format, or in memory a correlation
     * points at.
     *
     * @param {NdrCall} call @param {number} format
     */
    const interfaceId = (call, format)=>{
        if (u8(format + 1) === FC.CONSTANT_IID)
        {
            return host.readMemory(format + 2, 16).slice();
        }
        const at = conformance(call, format + 2, field(call, STUB_MESSAGE.MEMORY));
        if (at === 0)
        {
            throw new RpcException(RPC_STATUS.X_NULL_REF_POINTER,
                `iid_is names no IID: format 0x${format.toString(16)}, correlation 0x${
                    u32(format + 2).toString(16)}`);
        }
        return host.readMemory(at, 16).slice();
    };

    // --- the four passes --------------------------------------------------------

    /**
     * Counts what `memory` holds, as `format` describes it, onto the stub
     * message's buffer length.
     *
     * @param {NdrCall} call @param {number} memory @param {number} format
     * @returns {Promise<void>}
     */
    const bufferSize = async(call, memory, format)=>{
        const fc = u8(format);
        const base = baseType(fc);
        if (base)
        {
            grow(call, base.wire, base.wire);
            return;
        }
        if (POINTER_TYPES.has(fc))
        {
            await sizePointer(call, memory, format, false);
            return;
        }
        switch (fc)
        {
            case FC.STRUCT:
            case FC.PSTRUCT: {
                const shape = structShape(format);
                grow(call, shape.alignment, shape.size);
                await sizeEmbedded(call, memory, shape.pointers);
                return;
            }
            case FC.C_CSTRING:
            case FC.C_WSTRING: {
                const unit = charSize(format);
                const length = stringLength(memory, unit);
                stringMaximum(call, format, length);
                grow(call, 4, 12);
                grow(call, 1, length * unit);
                return;
            }
            case FC.CARRAY:
            case FC.CVARRAY:
            case FC.SMFARRAY:
            case FC.LGFARRAY: {
                const shape = arrayShape(call, format, memory, 'size');
                if (shape.conformant)
                {
                    grow(call, 4, shape.varying ? 12 : 4);
                }
                grow(call, shape.alignment, shape.length * shape.elementSize);
                if (shape.layout !== 0)
                {
                    await sizeEmbedded(call, memory + shape.offset * shape.elementSize,
                        pointerLayout(shape.layout, shape.length));
                }
                return;
            }
            case FC.IP:
                grow(call, 4, 4);
                if (memory !== 0)
                {
                    grow(call, 4, 8 + host.interfaceBytes);
                }
                return;
            default:
                throw unknownType(format);
        }
    };

    /**
     * Writes what `memory` holds into the buffer.
     *
     * @param {NdrCall} call @param {number} memory @param {number} format
     * @returns {Promise<void>}
     */
    const marshall = async(call, memory, format)=>{
        const fc = u8(format);
        if (baseType(fc))
        {
            marshallBase(call, memory, fc);
            return;
        }
        if (POINTER_TYPES.has(fc))
        {
            if (pointerId(call, memory, format, null))
            {
                await marshallPointee(call, memory, format);
            }
            return;
        }
        switch (fc)
        {
            case FC.STRUCT:
            case FC.PSTRUCT: {
                const shape = structShape(format);
                const copy = put(call, shape.alignment, shape.size);
                host.writeMemory(copy, host.readMemory(memory, shape.size).slice());
                await marshallEmbedded(call, memory, copy, shape.pointers);
                return;
            }
            case FC.C_CSTRING:
            case FC.C_WSTRING: {
                const unit = charSize(format);
                const length = stringLength(memory, unit);
                const maximum = stringMaximum(call, format, length);
                const header = put(call, 4, 12);
                w32(header, maximum);
                w32(header + 4, 0);
                w32(header + 8, length);
                const at = put(call, 1, length * unit);
                host.writeMemory(at, host.readMemory(memory, length * unit).slice());
                return;
            }
            case FC.CARRAY:
            case FC.CVARRAY:
            case FC.SMFARRAY:
            case FC.LGFARRAY: {
                const shape = arrayShape(call, format, memory, 'marshall');
                if (shape.varying && shape.offset + shape.length > shape.count)
                {
                    throw new RpcException(RPC_STATUS.X_INVALID_BOUND);
                }
                if (shape.conformant)
                {
                    const header = put(call, 4, shape.varying ? 12 : 4);
                    w32(header, shape.count);
                    if (shape.varying)
                    {
                        w32(header + 4, shape.offset);
                        w32(header + 8, shape.length);
                    }
                }
                const bytes = shape.length * shape.elementSize;
                const first = memory + shape.offset * shape.elementSize;
                const copy = put(call, shape.alignment, bytes);
                host.writeMemory(copy, host.readMemory(first, bytes).slice());
                if (shape.layout !== 0)
                {
                    await marshallEmbedded(call, first, copy,
                        pointerLayout(shape.layout, shape.length));
                }
                return;
            }
            case FC.IP: {
                const at = put(call, 4, 4);
                if (memory === 0)
                {
                    w32(at, 0);
                    return;
                }
                w32(at, referent(call));
                const objref = await host.marshalInterface(call, memory, interfaceId(call, format));
                const header = put(call, 4, 8);
                w32(header, objref.length);
                w32(header + 4, objref.length);
                host.writeMemory(put(call, 1, objref.length), objref);
                return;
            }
            default:
                throw unknownType(format);
        }
    };

    /**
     * Reads a value out of the buffer into `*ppMemory`: where it already
     * points, or somewhere new that the pointer is then set to.
     *
     * @param {NdrCall} call @param {number} ppMemory @param {number} format
     * @param {boolean} mustAlloc
     * @returns {Promise<void>}
     */
    const unmarshall = async(call, ppMemory, format, mustAlloc)=>{
        const fc = u8(format);
        const base = baseType(fc);
        if (base)
        {
            if (base.memory === base.wire && mayUseBuffer(call, ppMemory, mustAlloc))
            {
                const at = take(call, base.wire, base.wire);
                keepInPlace(call, at, base.wire);
                w32(ppMemory, at);
                return;
            }
            unmarshallBase(call, await destination(call, ppMemory, mustAlloc, base.memory), fc);
            return;
        }
        if (POINTER_TYPES.has(fc))
        {
            await unmarshallPointer(call, ppMemory, format, mustAlloc, null);
            return;
        }
        switch (fc)
        {
            case FC.STRUCT:
            case FC.PSTRUCT: {
                const shape = structShape(format);
                if (shape.pointers.length === 0 && mayUseBuffer(call, ppMemory, mustAlloc))
                {
                    const at = take(call, shape.alignment, shape.size);
                    keepInPlace(call, at, shape.size);
                    w32(ppMemory, at);
                    return;
                }
                const copy = take(call, shape.alignment, shape.size);
                const memory = await destination(call, ppMemory, mustAlloc, shape.size);
                host.writeMemory(memory, host.readMemory(copy, shape.size).slice());
                if (shape.pointers.length > 0)
                {
                    await unmarshallEmbedded(call, memory, copy, shape.pointers, mustAlloc);
                }
                return;
            }
            case FC.C_CSTRING:
            case FC.C_WSTRING: {
                const unit = charSize(format);
                const header = take(call, 4, 12);
                const maximum = u32(header);
                const offset = u32(header + 4);
                const length = u32(header + 8);
                if (offset !== 0 || length > maximum || length === 0)
                {
                    throw new RpcException(RPC_STATUS.X_INVALID_BOUND);
                }
                const at = take(call, 1, length * unit);
                const last = host.readMemory(at + (length - 1) * unit, unit);
                if (last[0] !== 0 || (unit === 2 && last[1] !== 0))
                {
                    throw new RpcException(RPC_STATUS.X_BAD_STUB_DATA,
                        'a string without its terminator');
                }
                if (mayUseBuffer(call, ppMemory, mustAlloc))
                {
                    keepInPlace(call, at, length * unit);
                    w32(ppMemory, at);
                    return;
                }
                const memory = await destination(call, ppMemory, mustAlloc, maximum * unit);
                host.writeMemory(memory, host.readMemory(at, length * unit).slice());
                return;
            }
            case FC.CARRAY:
            case FC.CVARRAY:
            case FC.SMFARRAY:
            case FC.LGFARRAY: {
                const shape = arrayShape(call, format, 0, 'unmarshall');
                let count = shape.count;
                let offset = 0;
                let length = shape.length;
                if (shape.conformant)
                {
                    const header = take(call, 4, shape.varying ? 12 : 4);
                    count = u32(header);
                    offset = shape.varying ? u32(header + 4) : 0;
                    length = shape.varying ? u32(header + 8) : count;
                    if (offset + length > count || offset + length < offset)
                    {
                        throw new RpcException(RPC_STATUS.X_INVALID_BOUND);
                    }
                }
                const bytes = length * shape.elementSize;
                const copy = take(call, shape.alignment, bytes);
                if (shape.layout === 0 && !shape.varying
                    && mayUseBuffer(call, ppMemory, mustAlloc))
                {
                    keepInPlace(call, copy, bytes);
                    w32(ppMemory, copy);
                    return;
                }
                const memory = await destination(call, ppMemory, mustAlloc,
                    count * shape.elementSize);
                const first = memory + offset * shape.elementSize;
                host.writeMemory(first, host.readMemory(copy, bytes).slice());
                if (shape.layout !== 0)
                {
                    await unmarshallEmbedded(call, first, copy,
                        pointerLayout(shape.layout, length), mustAlloc);
                }
                return;
            }
            case FC.IP: {
                const id = u32(take(call, 4, 4));
                if (id === 0)
                {
                    w32(ppMemory, 0);
                    return;
                }
                const header = take(call, 4, 8);
                const bytes = u32(header + 4);
                if (u32(header) !== bytes)
                {
                    throw new RpcException(RPC_STATUS.X_BAD_STUB_DATA,
                        'an interface pointer whose two counts differ');
                }
                const objref = host.readMemory(take(call, 1, bytes), bytes).slice();
                // No IID: the one the OBJREF carries, as NdrInterfacePointerUnmarshall
                // passes IID_NULL. An iid_is correlation is set by the generated
                // code only for sizing and marshalling, and reads nothing here.
                const pointer = (await host.unmarshalInterface(call, objref, null)) >>> 0;
                if (pointer !== 0)
                {
                    state(call).imported.add(pointer);
                }
                w32(ppMemory, pointer);
                return;
            }
            default:
                throw unknownType(format);
        }
    };

    /**
     * Frees what a value holds -- what its pointers point at, the interfaces
     * it has -- but not the value's own memory, which is its holder's.
     *
     * @param {NdrCall} call @param {number} memory @param {number} format
     * @returns {Promise<void>}
     */
    const free = async(call, memory, format)=>{
        const fc = u8(format);
        if (baseType(fc))
        {
            return;
        }
        if (POINTER_TYPES.has(fc))
        {
            await freePointer(call, memory, format);
            return;
        }
        switch (fc)
        {
            case FC.STRUCT:
            case FC.PSTRUCT:
                if (memory !== 0)
                {
                    await freeEmbedded(call, memory, structShape(format).pointers);
                }
                return;
            case FC.C_CSTRING:
            case FC.C_WSTRING:
                return;
            case FC.CARRAY:
            case FC.CVARRAY:
            case FC.SMFARRAY:
            case FC.LGFARRAY: {
                const shape = arrayShape(call, format, memory, 'free');
                if (memory !== 0 && shape.layout !== 0)
                {
                    const first = memory + shape.offset * shape.elementSize;
                    await freeEmbedded(call, first, pointerLayout(shape.layout, shape.length));
                }
                return;
            }
            case FC.IP:
                if (memory !== 0)
                {
                    state(call).imported.delete(memory);
                    await host.releaseInterface(call, memory);
                }
                return;
            default:
                throw unknownType(format);
        }
    };

    /**
     * The bytes a value of this type takes in memory, where the format alone
     * says; 0 where it depends on the value.
     *
     * @param {number} format
     */
    const memorySize = format=>{
        const fc = u8(format);
        const base = baseType(fc);
        if (base)
        {
            return base.memory;
        }
        if (POINTER_TYPES.has(fc) || fc === FC.IP)
        {
            return 4;
        }
        switch (fc)
        {
            case FC.STRUCT:
            case FC.PSTRUCT:
            case FC.SMFARRAY:
                return u16(format + 2);
            case FC.LGFARRAY:
                return u32(format + 2);
            default:
                return 0;
        }
    };

    /**
     * What this call's unmarshal made and a failed call leaves behind: every
     * block and interface reachable from an [out] parameter that the
     * unmarshal allocated or imported, and nothing else. A value that was not
     * made here may be whatever the caller's variable held before the call,
     * so it is neither freed nor followed.
     *
     * @param {NdrCall} call @param {number} value @param {number} format
     */
    const dropMade = async(call, value, format)=>{
        const held = state(call);
        const fc = u8(format);
        if (fc === FC.IP)
        {
            if (held.imported.delete(value))
            {
                await host.releaseInterface(call, value);
            }
            return;
        }
        if (!POINTER_TYPES.has(fc) || !held.made.has(value))
        {
            return;
        }
        const pointee = pointeeOf(format);
        if ((u8(format + 1) & POINTER.DEREF) !== 0)
        {
            await dropMade(call, u32(value), pointee);
        }
        else
        {
            await dropHeld(call, value, pointee);
        }
        await release(call, value);
    };

    /**
     * The pointers a structure holds, dropped as `dropMade` drops them.
     *
     * @param {NdrCall} call @param {number} memory @param {number} format
     */
    const dropHeld = async(call, memory, format)=>{
        if (u8(format) !== FC.PSTRUCT)
        {
            return;
        }
        for (const entry of structShape(format).pointers)
        {
            await dropMade(call, u32(memory + entry.memory), entry.format);
        }
    };

    return {
        /**
         * A new call begins on this stub message: its referent IDs, full
         * pointers and bookkeeping start again.
         *
         * @param {number} message
         */
        begin(message){
            states.delete(message);
        },

        /** @param {number} message */
        end(message){
            states.delete(message);
        },

        bufferSize,
        marshall,
        unmarshall,
        free,
        memorySize,

        /**
         * NdrSimpleTypeMarshall and NdrSimpleTypeUnmarshall: a base type by its
         * format character, in memory the caller names.
         *
         * @param {NdrCall} call @param {number} memory @param {number} fc
         * @param {'marshall' | 'unmarshall'} direction
         */
        simple(call, memory, fc, direction){
            if (!baseType(fc))
            {
                throw unsupported(`simple type 0x${fc.toString(16)}`);
            }
            if (direction === 'marshall')
            {
                marshallBase(call, memory, fc);
            }
            else
            {
                unmarshallBase(call, memory, fc);
            }
        },

        /**
         * NdrClearOutParameters: an [out] parameter of a call that failed is
         * cleared, and what this call's unmarshal had already put there is
         * freed. Anything else there is the caller's own and is left alone.
         *
         * @param {NdrCall} call @param {number} format @param {number} argument
         */
        async clearOut(call, format, argument){
            if (argument === 0)
            {
                return;
            }
            let size = memorySize(format);
            if (POINTER_TYPES.has(u8(format)))
            {
                const pointee = pointeeOf(format);
                if ((u8(format + 1) & POINTER.DEREF) !== 0)
                {
                    await dropMade(call, u32(argument), pointee);
                    size = 4;
                }
                else
                {
                    await dropHeld(call, argument, pointee);
                    size = memorySize(pointee);
                }
            }
            if (size > 0)
            {
                host.writeMemory(argument, new Uint8Array(size));
            }
        },
    };
}
