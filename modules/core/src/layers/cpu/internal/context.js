/*
 * Copyright © 2026 Bottlify Project
 * Licensed under BSD-2-Clause License
 * See LICENSE for details
 */

/**
 * The CPU context: everything a thread owns while it is running.
 *
 * Guest threads share one register file, so every scrap of state below has to
 * move with the thread. Omitting any of it does not fault -- it silently hands
 * one thread another thread's arithmetic, which is the most expensive class of
 * bug this project has (master plan §12.1).
 *
 * This lives in the cpu layer rather than the kernel because it is shaped by
 * the emulator's own representation. The kernel decides *when* to switch; what
 * a CPU context *is* belongs here, behind an opaque record.
 *
 * Every field was located and round-tripped against the vendored v86 before
 * being listed. Two of them are the traps:
 *
 *   - Arithmetic flags are lazy. The raw `flags` word is missing OF, SF, AF and
 *     PF while `flags_changed` is non-zero -- measured, not theorised: after an
 *     overflowing add the raw word read 0x2 where the materialised value was
 *     0x896. All five lazy fields move together, which is bit-exact and needs no
 *     call into wasm.
 *   - `fpu_stack_ptr` and `fpu_stack_empty` are two single bytes that decide
 *     what the eight x87 registers *mean*. `fpu_stack_empty` is the tag word;
 *     there is no other. Any MMX instruction zeroes both, because MMX registers
 *     are the same storage. Restoring the 32 register words without them yields
 *     a wrong number with no fault at all.
 */

/** Index of FS in the segment tables; its base is the thread's TEB. */
export const SEGMENT_FS = 4;

/** @param {Int32Array | Uint32Array | Uint16Array | Uint8Array} view */
const copy = view=>Array.from(view);

/**
 * Captures the running thread's context.
 *
 * @param {any} cpu  The emulator's CPU object.
 * @returns {any} an opaque context record
 */
export function captureContext(cpu){
    return {
        reg32: copy(cpu.reg32),
        eip: cpu.instruction_pointer[0],
        previousIp: cpu.previous_ip[0],

        sreg: copy(cpu.sreg),
        segmentOffsets: copy(cpu.segment_offsets),
        segmentIsNull: copy(cpu.segment_is_null),
        segmentLimits: copy(cpu.segment_limits),
        segmentAccessBytes: copy(cpu.segment_access_bytes),

        // All five, together: see the note above on lazy flags.
        flags: cpu.flags[0],
        flagsChanged: cpu.flags_changed[0],
        lastOp1: cpu.last_op1[0],
        lastResult: cpu.last_result[0],
        lastOpSize: cpu.last_op_size[0],

        fpuSt: copy(cpu.fpu_st),
        fpuStackPtr: cpu.fpu_stack_ptr[0],
        fpuStackEmpty: cpu.fpu_stack_empty[0],
        fpuControlWord: cpu.fpu_control_word[0],
        fpuStatusWord: cpu.fpu_status_word[0],
        fpuOpcode: cpu.fpu_opcode[0],
        fpuIp: cpu.fpu_ip[0],
        fpuIpSelector: cpu.fpu_ip_selector[0],
        fpuDp: cpu.fpu_dp[0],
        fpuDpSelector: cpu.fpu_dp_selector[0],

        regXmm: copy(cpu.reg_xmm32s),
        mxcsr: cpu.mxcsr[0],

        // A thread parked on `hlt` is halted; without this it resumes running.
        inHlt: cpu.in_hlt[0],
    };
}

/**
 * Restores a captured context.
 *
 * No guest instruction runs during a restore, so the writes are independent and
 * their order does not matter. What matters is that all of them happen.
 *
 * @param {any} cpu
 * @param {any} context
 */
export function restoreContext(cpu, context){
    cpu.reg32.set(context.reg32);
    cpu.instruction_pointer[0] = context.eip;
    cpu.previous_ip[0] = context.previousIp;

    cpu.sreg.set(context.sreg);
    cpu.segment_offsets.set(context.segmentOffsets);
    cpu.segment_is_null.set(context.segmentIsNull);
    cpu.segment_limits.set(context.segmentLimits);
    cpu.segment_access_bytes.set(context.segmentAccessBytes);

    cpu.flags[0] = context.flags;
    cpu.flags_changed[0] = context.flagsChanged;
    cpu.last_op1[0] = context.lastOp1;
    cpu.last_result[0] = context.lastResult;
    cpu.last_op_size[0] = context.lastOpSize;

    cpu.fpu_st.set(context.fpuSt);
    cpu.fpu_stack_ptr[0] = context.fpuStackPtr;
    cpu.fpu_stack_empty[0] = context.fpuStackEmpty;
    cpu.fpu_control_word[0] = context.fpuControlWord;
    cpu.fpu_status_word[0] = context.fpuStatusWord;
    cpu.fpu_opcode[0] = context.fpuOpcode;
    cpu.fpu_ip[0] = context.fpuIp;
    cpu.fpu_ip_selector[0] = context.fpuIpSelector;
    cpu.fpu_dp[0] = context.fpuDp;
    cpu.fpu_dp_selector[0] = context.fpuDpSelector;

    cpu.reg_xmm32s.set(context.regXmm);
    cpu.mxcsr[0] = context.mxcsr;

    cpu.in_hlt[0] = context.inHlt;
}

/**
 * The TEB base the thread runs on. Kept next to the context because moving it
 * is part of switching threads, not a duty of whoever calls the switch (§12.5).
 *
 * @param {any} context
 * @param {number} tebAddress
 */
export function setThreadBase(context, tebAddress){
    context.segmentOffsets[SEGMENT_FS] = tebAddress;
}

/**
 * Reports which fields differ, for tests and for diagnosing a switch that lost
 * something. Empty means the two contexts are identical.
 *
 * @param {any} a
 * @param {any} b
 * @returns {string[]}
 */
export function diffContexts(a, b){
    /** @type {string[]} */
    const differing = [];
    for (const key of Object.keys(a))
    {
        const left = a[key];
        const right = b[key];
        const same = Array.isArray(left)
            ? left.length === right.length && left.every((value, i)=>value === right[i])
            : left === right;
        if (!same)
        {
            differing.push(key);
        }
    }
    return differing;
}
