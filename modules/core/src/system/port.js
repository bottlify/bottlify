/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The guest memory port: the one way host code reads and writes the guest's
 * memory, built once per process width over the memory layer's accessors
 * (`memory` api `port`) and handed to every layer; win32's handlers have it
 * as `host.guest` with the process's text beside it (`win32/common/guest.js`).
 *
 * A number of every width and sign is read and written where it lies: no
 * buffer, no DataView and no closure made for it, a float reinterpreted
 * through one scratch word. A block is either a snapshot (`snapshot`, a copy
 * the caller keeps) or a view in place (`view`, valid until anything else
 * runs), never a call that may be either. Every access is checked by the
 * memory layer against its regions: an address not there, or not for this,
 * is the memory layer's `GUEST_ACCESS` fault, which a handler's guard turns
 * into the access violation Windows raises; a write goes by the memory
 * layer's write path, which charges it, tells the translator of a write over
 * code and is seen by a write watch. x86 has no alignment fault with AC
 * clear, so an unaligned access answers as the bytes do, one straddling two
 * regions faulting where the second is not there. The pointer width is the
 * process's: 8 bytes in a 64-bit one, an address read and written whole up
 * to 2^53, 4 in a 32-bit one; any address below 2^53 is reached, past 4 GiB
 * too.
 */

/**
 * What the port is made over: the memory layer's api, or its accessors.
 *
 * @typedef {Object} PortMemory
 * @property {(address: number) => number} readU8
 * @property {(address: number) => number} readU16
 * @property {(address: number) => number} readU32
 * @property {(address: number, value: number) => void} writeU8
 * @property {(address: number, value: number) => void} writeU16
 * @property {(address: number, value: number) => void} writeU32
 * @property {(address: number, length: number) => Uint8Array} readBytes  a copy
 * @property {(address: number, length: number) => Uint8Array} window
 *     The bytes where they lie, until anything else runs.
 * @property {(address: number, bytes: Uint8Array) => void} writeBytes
 * @property {(address: number, value: number, length: number) => void} fillBytes
 */

/**
 * @typedef {Object} Port
 * @property {4 | 8} pointerSize
 * @property {(address: number) => number} u8
 * @property {(address: number) => number} i8
 * @property {(address: number) => number} u16
 * @property {(address: number) => number} i16
 * @property {(address: number) => number} u32
 * @property {(address: number) => number} i32
 * @property {(address: number) => bigint} u64
 * @property {(address: number) => bigint} i64
 * @property {(address: number) => number} f32
 * @property {(address: number) => number} f64
 * @property {(address: number) => number} ptr  a pointer of the process's width, whole
 * @property {(address: number, value: number) => void} set8  either sign: the low byte
 * @property {(address: number, value: number) => void} set16
 * @property {(address: number, value: number) => void} set32
 * @property {(address: number, value: bigint | number) => void} set64
 * @property {(address: number, value: number) => void} setF32
 * @property {(address: number, value: number) => void} setF64
 * @property {(address: number, value: number) => void} setPtr
 * @property {(address: number, values: ArrayLike<number>) => number} set32s
 *     Consecutive dwords; answers the address after the last, where a
 *     marshaler writes on.
 * @property {(address: number, length: number, into?: Uint8Array) => Uint8Array} snapshot
 *     The bytes copied, the caller's to keep: into `into` from its start
 *     where it is given, which is answered, or into one new buffer.
 * @property {(address: number, length: number) => Uint8Array} view
 *     The bytes in place, read before anything else runs and never kept.
 * @property {(address: number, bytes: Uint8Array) => void} setBytes
 * @property {(address: number, value: number, length: number) => void} fill
 * @property {(address: number, length: number,
 *     make: (chunk: Uint8Array, offset: number) => void) => void} setMade
 *     `length` bytes made a chunk at a time and each written as it is made:
 *     `make` fills the chunk with the bytes from `offset` on, a multiple of
 *     eight. Bytes a handler makes to a guest's length (a pattern, random
 *     bytes) are never all on the host at once, and a destination that is not
 *     there faults at its first chunk, before the rest is made.
 * @property {(to: number, from: number, length: number) => void} copy
 *     Guest bytes moved within the guest, ranges overlapping or not.
 */

/** One word a float is reinterpreted through: nothing runs between its write and its read. */
const word = new DataView(new ArrayBuffer(8));
/** The same word's bytes, a quadword stored whole. */
const wordBytes = new Uint8Array(word.buffer);

/** The chunk `writeMade` makes its bytes in, a multiple of eight. */
const made = new Uint8Array(0x10000);

/**
 * `length` bytes made a chunk at a time, each written as it is made (the
 * port's `setMade`, over any write of guest memory): `make` fills the chunk
 * with the bytes from `offset` on, a multiple of eight, and makes no other
 * bytes this way, the chunk being one for every caller. A destination that is
 * not there faults at its first chunk, before the rest is made, as Windows'
 * loop faults at its first byte not there.
 *
 * @param {(address: number, bytes: Uint8Array) => void} write
 * @param {number} address @param {number} length
 * @param {(chunk: Uint8Array, offset: number) => void} make
 */
export function writeMade(write, address, length, make){
    for (let offset = 0; offset < length; offset += made.length)
    {
        const chunk = made.subarray(0, Math.min(made.length, length - offset));
        make(chunk, offset);
        write(address + offset, chunk);
    }
}

/** @param {Uint8Array} chunk */
const zeros = chunk=>void chunk.fill(0);

/**
 * `length` zero bytes, written a chunk at a time: for a library handed only
 * a write, where the port's `fill` is the memory layer's own.
 *
 * @param {(address: number, bytes: Uint8Array) => void} write
 * @param {number} address @param {number} length
 */
export const writeZeros = (write, address, length)=>writeMade(write, address, length, zeros);

/**
 * @param {PortMemory} memory
 * @param {4 | 8} [pointerSize]
 * @returns {Port}
 */
export function createPort(memory, pointerSize = 4){
    const { readU8, readU16, readU32, writeU8, writeU16, writeU32, writeBytes } = memory;
    const wide = pointerSize === 8;
    /**
     * A quadword stored in one write, as the processor's one store: one that
     * faults on its second half writes nothing of its first.
     *
     * @param {number} address @param {number} low @param {number} high
     */
    const set64 = (address, low, high)=>{
        word.setUint32(0, low, true);
        word.setUint32(4, high, true);
        writeBytes(address, wordBytes);
    };
    /** @type {Port} */
    const port = {
        pointerSize,
        u8: readU8,
        i8: address=>readU8(address) << 24 >> 24,
        u16: readU16,
        i16: address=>readU16(address) << 16 >> 16,
        u32: readU32,
        i32: address=>readU32(address) | 0,
        u64: address=>BigInt(readU32(address)) | BigInt(readU32(address + 4)) << 32n,
        i64: address=>BigInt.asIntN(64, port.u64(address)),
        f32: address=>{
            word.setUint32(0, readU32(address), true);
            return word.getFloat32(0, true);
        },
        f64: address=>{
            word.setUint32(0, readU32(address), true);
            word.setUint32(4, readU32(address + 4), true);
            return word.getFloat64(0, true);
        },
        ptr: wide ? address=>readU32(address) + readU32(address + 4) * 2 ** 32 : readU32,
        set8: writeU8,
        set16: writeU16,
        set32: writeU32,
        set64: (address, value)=>{
            const whole = BigInt.asUintN(64, BigInt(value));
            set64(address, Number(whole & 0xffffffffn), Number(whole >> 32n));
        },
        setF32: (address, value)=>{
            word.setFloat32(0, value, true);
            writeU32(address, word.getUint32(0, true));
        },
        setF64: (address, value)=>{
            word.setFloat64(0, value, true);
            set64(address, word.getUint32(0, true), word.getUint32(4, true));
        },
        // A negative value is a dword some bitwise operator made signed and
        // names the same address; its upper dword is the value's own, never
        // left as it was.
        setPtr: wide
            ? (address, value)=>{
                const whole = value < 0 ? value >>> 0 : value;
                set64(address, whole % 2 ** 32, Math.floor(whole / 2 ** 32));
            }
            : writeU32,
        set32s: (address, values)=>{
            for (let at = 0; at < values.length; at++)
            {
                writeU32(address + at * 4, values[at]);
            }
            return address + values.length * 4;
        },
        snapshot: (address, length, into)=>{
            if (!into)
            {
                return memory.readBytes(address, length);
            }
            into.set(memory.window(address, length));
            return into;
        },
        view: memory.window,
        setBytes: writeBytes,
        fill: memory.fillBytes,
        setMade: (address, length, make)=>writeMade(writeBytes, address, length, make),
        // The memory layer's read is a copy already, so the source is read
        // whole before the destination is written: an overlap moves as memmove.
        copy: (to, from, length)=>writeBytes(to, memory.readBytes(from, length)),
    };
    return port;
}
