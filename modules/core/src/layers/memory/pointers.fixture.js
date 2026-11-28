/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * For the tests: a stand-in for guest memory given the memory layer's pointer
 * reader and writer (`readPointer`, `writePointer`), made of whatever dword or
 * byte access the stand-in already has, by the same rule the layer keeps - a
 * pointer of 4 or 8 bytes, whole, its upper dword the value's own. A seam
 * reads and writes every pointer through those two, so a test's memory needs
 * them as the product's facades have them. A stand-in that keeps no writer
 * account is given the layer's answer for a name it does not attribute (-1).
 */

/** @param {number} value */
const unsigned = value=>(value < 0 ? value >>> 0 : value);

/**
 * @template {Record<string, any>} M
 * @param {M} memory  with readU32/writeU32, readMemory/writeMemory or readBytes/writeBytes
 * @returns {M & { readPointer: (address: number, bytes: 4 | 8) => number,
 *     writePointer: (address: number, value: number, bytes: 4 | 8) => void,
 *     writer: (name: string) => number }}
 */
export function withPointers(memory){
    /** @param {number} address @param {number} length */
    const read = (address, length)=>(memory.readMemory ?? memory.readBytes)
        .call(memory, address, length);
    /** @param {number} address @param {Uint8Array} bytes */
    const write = (address, bytes)=>(memory.writeMemory ?? memory.writeBytes)
        .call(memory, address, bytes);
    /** @param {number} address */
    const readDword = address=>(typeof memory.readU32 === 'function'
        ? memory.readU32(address) >>> 0
        : new DataView(read(address, 4).slice().buffer).getUint32(0, true));
    /** @param {number} address @param {number} value */
    const writeDword = (address, value)=>{
        if (typeof memory.writeU32 === 'function')
        {
            memory.writeU32(address, value >>> 0);
            return;
        }
        const bytes = new Uint8Array(4);
        new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
        write(address, bytes);
    };
    return Object.assign(memory, {
        writer: memory.writer ?? (()=>-1),
        /** @param {number} address @param {4 | 8} bytes */
        readPointer: (address, bytes)=>(bytes === 8
            ? readDword(address) + readDword(address + 4) * 2 ** 32 : readDword(address)),
        /** @param {number} address @param {number} value @param {4 | 8} bytes */
        writePointer: (address, value, bytes)=>{
            const whole = unsigned(value);
            writeDword(address, whole % 2 ** 32);
            if (bytes === 8)
            {
                writeDword(address + 4, Math.floor(whole / 2 ** 32));
            }
        },
    });
}
