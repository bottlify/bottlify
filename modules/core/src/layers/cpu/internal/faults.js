/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A processor exception, turned into something that can be reported.
 *
 * Without an interrupt table the emulator has nowhere to send a fault and stops
 * the machine, so a divide by zero, a bad pointer and an illegal instruction
 * all arrive as "the emulator gave up" -- the same message, at an address that
 * is wherever the CPU happened to be, with nothing to say which of them it was.
 * The ROM gives each of the first thirty-two vectors a gate and a stub, and
 * this reads what the processor pushed before that stub ran.
 *
 * What it pushed depends on the vector. Some exceptions carry an error code and
 * some do not, and reading the frame the wrong way round reports the faulting
 * address as a selector -- a plausible number, and wrong. The set that carries
 * one is fixed by the architecture and is listed below rather than guessed at.
 */

import { inDeadBootCode } from './boot-rom.js';

/** Vectors whose exception pushes an error code before the return frame. */
const WITH_ERROR_CODE = new Set([8, 10, 11, 12, 13, 14, 17, 21]);

/** What each exception is called, so a report names it rather than numbering it. */
const NAMES = Object.freeze([
    'divide error', 'debug', 'non-maskable interrupt', 'breakpoint',
    'overflow', 'bound range exceeded', 'invalid opcode', 'device not available',
    'double fault', 'coprocessor segment overrun', 'invalid TSS', 'segment not present',
    'stack-segment fault', 'general protection', 'page fault', 'reserved',
    'x87 floating-point', 'alignment check', 'machine check', 'SIMD floating-point',
    'virtualisation', 'control protection',
]);

/**
 * @typedef {Object} GuestFault
 * @property {number} vector
 * @property {string} name
 * @property {number} eip          Where the faulting instruction is.
 * @property {number} cs
 * @property {number} eflags
 * @property {number | null} errorCode  Null for the exceptions that push none.
 * @property {number} calledFrom
 *           The word sitting directly above the frame. When the fault is a jump
 *           to somewhere there is no code, that word is the return address the
 *           call pushed -- which names the instruction that made the call, and
 *           the faulting address itself names nothing at all.
 * @property {string} [detail]
 *           The whole report, for a fault the host raised rather than read off
 *           the processor: what the machine knows about it is the sentence,
 *           not a vector and a frame.
 */

/**
 * The vector of a fault the host raised: a stop the processor never saw, named
 * by whoever decided the guest could not go on. Outside the table on purpose,
 * so nothing mistakes it for an exception with a frame to read.
 */
export const HOST_VECTOR = -1;

/**
 * A fault raised from our side of the boundary, shaped like the processor's so
 * that everything downstream -- the poll, the trace, the report -- treats the
 * two alike.
 *
 * @param {Object} fault
 * @param {string} fault.name
 * @param {string} fault.detail    The report, in full.
 * @param {number} fault.eip       Where the guest was, as far as a reader is concerned.
 * @param {number} [fault.calledFrom]
 * @param {number} [fault.vector]  For a stop that stands in for a processor exception.
 * @param {number} [fault.errorCode]
 * @returns {GuestFault}
 */
export function hostFault({ name, detail, eip, calledFrom = 0, vector = HOST_VECTOR, errorCode }){
    return {
        vector, name, detail,
        eip: eip >>> 0, cs: 0, eflags: 0,
        errorCode: errorCode ?? null,
        calledFrom: calledFrom >>> 0,
    };
}

/**
 * Reads the frame the processor pushed, given the stack pointer as the stub
 * found it.
 *
 * The stub reports before touching the stack, so ESP still points at the top of
 * that frame: the error code when there is one, then EIP, CS and EFLAGS. There
 * is no stack switch to account for -- the guest runs at ring zero, so the
 * processor pushes no SS:ESP.
 *
 * @param {number} vector
 * @param {number} esp
 * @param {(address: number) => number} readU32
 * @returns {GuestFault}
 */
export function readFault(vector, esp, readU32){
    const hasError = WITH_ERROR_CODE.has(vector);
    const at = hasError ? esp + 4 : esp;
    return {
        vector,
        // Past the processor's own: a software interrupt nothing here
        // answers, named by the number the program used.
        name: NAMES[vector] ?? (vector < 32
            ? `exception ${vector}`
            : `int 0x${vector.toString(16)} with no handler`),
        errorCode: hasError ? readU32(esp) >>> 0 : null,
        eip: readU32(at) >>> 0,
        cs: readU32(at + 4) >>> 0,
        eflags: readU32(at + 8) >>> 0,
        calledFrom: readU32(at + 12) >>> 0,
    };
}

/**
 * How a fault reads in a report.
 *
 * A page fault's error code is worth spelling out because its bits are the
 * whole diagnosis -- whether the page was present, and whether the access that
 * failed was a write -- and reading them out of a hexadecimal number is a step
 * nobody should have to take twice.
 *
 * @param {GuestFault} fault
 * @returns {string}
 */
export function describeFault(fault){
    if (fault.detail !== undefined)
    {
        return fault.detail;
    }
    const where = `at 0x${fault.eip.toString(16).padStart(8, '0')}`;
    const from = `, called from 0x${fault.calledFrom.toString(16).padStart(8, '0')}`;
    // The breakpoint is a trap, so the frame names the byte after it.
    const executed = fault.vector === 3 ? fault.eip - 1 : fault.eip;
    if (inDeadBootCode(executed))
    {
        return `guest jumped into the boot ROM ${where}${from}`;
    }
    if (fault.errorCode === null)
    {
        // A fault at an address with no code is a call that should not have
        // been made, and the useful address is the one that made it.
        return `${fault.name} ${where}${fault.eip < 0x1000 ? from : ''}`;
    }
    if (fault.vector === 14)
    {
        const present = (fault.errorCode & 1) !== 0 ? 'protection' : 'not present';
        const access = (fault.errorCode & 2) !== 0 ? 'writing' : 'reading';
        return `page fault ${where}: ${access}, ${present}`;
    }
    return `${fault.name} ${where}, error code 0x${fault.errorCode.toString(16)}`;
}
