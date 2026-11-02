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

/** The legacy prefixes an instruction may carry ahead of its opcode. */
const PREFIXES = new Set([0x26, 0x2e, 0x36, 0x3e, 0x64, 0x65, 0x66, 0x67, 0xf0, 0xf2, 0xf3]);

/** One-byte opcodes ring 3 may not run: port I/O, CLI, STI, HLT. */
const PRIVILEGED = new Set([0x6c, 0x6d, 0x6e, 0x6f, 0xe4, 0xe5, 0xe6, 0xe7, 0xec, 0xed, 0xee,
    0xef, 0xf4, 0xfa, 0xfb]);

/** Two-byte ones: CLTS, INVD, WBINVD, MOV to and from CRn and DRn, WRMSR, RDMSR. */
const PRIVILEGED_0F = new Set([0x06, 0x08, 0x09, 0x20, 0x21, 0x22, 0x23, 0x30, 0x32]);

/**
 * Whether the instruction at the fault is one a user-mode thread may not run
 * - port I/O, CLI, STI, HLT, a control or debug register, a descriptor
 * table load, an MSR - which Windows reports as STATUS_PRIVILEGED_INSTRUCTION
 * rather than an illegal one. A packer's handler may tell the two apart: one
 * that decrypts with the code it is handed unpacked garbage here. The stores
 * that read the machine (SGDT, SIDT, SLDT, STR, SMSW) are allowed at ring 3.
 *
 * @param {(address: number, length: number) => Uint8Array} read
 * @param {number} eip
 * @returns {boolean}
 */
export function privilegedAt(read, eip){
    const bytes = read(eip >>> 0, 16);
    let at = 0;
    while (at < 14 && PREFIXES.has(bytes[at]))
    {
        at++;
    }
    if (bytes[at] !== 0x0f)
    {
        return PRIVILEGED.has(bytes[at]);
    }
    const opcode = bytes[at + 1];
    const reg = bytes[at + 2] >> 3 & 7;
    // 0F 00 /2 LLDT, /3 LTR; 0F 01 /2 LGDT, /3 LIDT, /6 LMSW, /7 INVLPG.
    return PRIVILEGED_0F.has(opcode)
        || (opcode === 0x00 && (reg === 2 || reg === 3))
        || (opcode === 0x01 && (bytes[at + 2] >> 6 !== 3 || reg === 6)
            && (reg === 2 || reg === 3 || reg === 6 || reg === 7));
}
