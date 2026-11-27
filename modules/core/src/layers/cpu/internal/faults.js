/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A processor exception, turned into something that can be reported: the
 * record the engine builds from a fault exit (`cork-host.js`), or one the host
 * raised itself, each named by its vector so a divide by zero, a bad pointer
 * and an illegal instruction read as what they were.
 */

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
 * @property {number | null} errorCode  Null for the exceptions that carry none.
 * @property {number} calledFrom
 *           When the fault is a jump to somewhere there is no code, the return
 *           address the call pushed -- which names the instruction that made the
 *           call, and the faulting address itself names nothing at all; 0 when
 *           not known.
 * @property {string} [detail]
 *           The whole report, for a fault the host raised: what the machine
 *           knows about it is the sentence, not a vector and a frame.
 * @property {number} [eax]    The faulting code's.
 * @property {number} [edx]
 * @property {number} [stack]  ESP as the faulting instruction had it.
 */

/**
 * The vector of a fault the host raised: a stop the processor never saw, named
 * by whoever decided the guest could not go on. Outside the table on purpose,
 * so nothing mistakes it for a processor exception.
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
 * What a vector is called.
 *
 * Past the processor's own: a software interrupt nothing here answers, named by
 * the number the program used.
 *
 * @param {number} vector
 * @returns {string}
 */
export function exceptionName(vector){
    return NAMES[vector] ?? (vector < 32
        ? `exception ${vector}`
        : `int 0x${vector.toString(16)} with no handler`);
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
