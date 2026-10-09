/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * SMSW in its register form, answered where the processor reported it invalid.
 *
 * SMSW is not privileged: on Windows a ring-3 thread runs it and reads CR0's
 * low bits -- programs of the period test the EM and MP bits that way to find
 * the floating-point unit. A translator that leaves the 0F 01 group to the
 * system raises an illegal instruction instead, and a program whose detection
 * meets that dies in its own crash handler. Answering it in the fault path
 * keeps the instruction out of every hot path: it runs once, at start-up.
 */

/**
 * The CR0 a user thread of 32-bit Windows sees: paging, write protect,
 * numeric error, extension type, monitor coprocessor, protection enable.
 * EM and TS are clear -- there is a floating-point unit and it is this
 * thread's.
 */
export const CR0 = 0x80010033;

const REGISTERS = ['eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi'];

/**
 * The registers after SMSW at `registers.eip`, or null when the bytes there
 * are anything else (or SMSW to memory, which this does not decode).
 *
 * @param {(address: number, length: number) => Uint8Array} read
 * @param {Record<string, number>} registers
 * @returns {Record<string, number> | null}
 */
export function storeMachineStatus(read, registers){
    const eip = registers.eip >>> 0;
    const bytes = read(eip, 4);
    let at = 0;
    const wide = bytes[0] !== 0x66;
    if (!wide)
    {
        at = 1;
    }
    if (bytes[at] !== 0x0f || bytes[at + 1] !== 0x01)
    {
        return null;
    }
    const modrm = bytes[at + 2];
    if (modrm >> 6 !== 3 || (modrm >> 3 & 7) !== 4)
    {
        return null;
    }
    const name = REGISTERS[modrm & 7];
    // A 16-bit destination keeps its register's upper half; a 32-bit one
    // takes the whole word, which is what every processor since the P6
    // stores although the manual leaves the upper half undefined.
    const value = wide ? CR0 : (registers[name] & 0xffff0000 | CR0 & 0xffff);
    return { ...registers, [name]: value >>> 0, eip: eip + at + 3 >>> 0 };
}
