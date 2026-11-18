/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Fibers: threads of execution a program schedules itself, inside one thread.
 *
 * A fiber is a stack and the registers a call preserves. SwitchToFiber is a
 * call that returns on another stack: it keeps where the calling fiber will
 * resume -- the stack as the call's return leaves it, the return address, EBX,
 * ESI, EDI and EBP -- and takes up where the other one left off. Nothing is
 * scheduled; the thread stays the thread, its handle and id unchanged.
 *
 * What the thread block says follows the fiber, as on Windows: the head of
 * the exception handler chain, the stack's bounds, its fibre-local values
 * (fls.js), its own stack of activation contexts - a made fiber starts with
 * none active - and FiberData, which is the fiber itself -- GetCurrentFiber
 * reads it, and GetFiberData the first word of what it points at, the
 * parameter the fiber was made with. A thread that runs no fiber has 0x1e00
 * there and HasFiberData clear in SameTebFlags; converting it sets the flag,
 * and converting it back clears both. The kernel's own
 * idea of the thread's stack follows too: a callback the host makes on the
 * thread is laid on the stack it is running on, and the bridge refuses one
 * outside the bounds it knows.
 *
 * A fiber made here gets a stack from the pool threads' stacks come from, so
 * the translator knows it for one. Its start routine is entered as a thread's
 * is, its parameter above the return address, and a routine that returns ends
 * the thread, as Windows' does.
 */

import { HAS_FIBER_DATA, TEB } from './teb.js';

/** Where each word of a fiber's record is. The first is the program's: GetFiberData reads it. */
const FIBER = Object.freeze({
    DATA: 0x00,
    EXCEPTION_LIST: 0x04,
    STACK_BASE: 0x08,
    STACK_LIMIT: 0x0c,
    EBX: 0x10,
    ESI: 0x14,
    EDI: 0x18,
    EBP: 0x1c,
    ESP: 0x20,
    EIP: 0x24,
    FLS: 0x28,
    ACTIVATION_STACK: 0x2c,
    SIZE: 0x30,
});

/** A handler chain with nothing on it. */
const CHAIN_END = 0xffffffff;
const ERROR_INVALID_PARAMETER = 87;
const ERROR_ALREADY_FIBER = 1280;
const ERROR_ALREADY_THREAD = 1281;
const ERROR_NOT_ENOUGH_MEMORY = 8;

/**
 * @typedef {Object} FiberHost
 * @property {(address: number) => number} readU32
 * @property {(address: number, value: number) => void} writeU32
 * @property {() => Record<string, number>} registers
 * @property {(values: Record<string, number>) => void} setRegisters
 * @property {() => any} currentThread
 * @property {() => number} teb
 * @property {(bytes: number) => number} allocate
 * @property {(address: number) => void} free
 * @property {(asked: { commit?: number, reserve?: number }) =>
 *     { base: number, top: number } | null} allocateStack
 *     A stack from the threads' pool, made known to the translator.
 * @property {(stack: { base: number, top: number }) => void} releaseStack
 * @property {() => number} threadReturn  Where a start routine returns to: it ends the thread.
 * @property {(code: number) => any} exitThread
 * @property {(code: number) => void} setLastError
 * @property {{ release: (block: number) => Promise<void> }} [storage]
 *     Fibre-local storage (fls.js): a deleted fiber's block is let go through it.
 */

/**
 * @param {FiberHost} host
 */
export function createFiberFunctions(host){
    /** The stacks of the fibers made here, by fiber. @type {Map<number, { base: number, top: number }>} */
    const stacks = new Map();
    /** The fiber each thread was converted into, by thread. @type {Map<any, number>} */
    const converted = new Map();
    /**
     * The bounds the kernel keeps for each fiber's stack: a made one's from
     * its stack, a converted thread's as the kernel had them.
     *
     * @type {Map<number, { stackTop: number, stackLimit: number }>}
     */
    const bounds = new Map();

    /** @param {number} parameter @returns {number} the record, or 0 */
    const record = parameter=>{
        const fiber = host.allocate(FIBER.SIZE) >>> 0;
        if (fiber !== 0)
        {
            for (let at = 0; at < FIBER.SIZE; at += 4)
            {
                host.writeU32(fiber + at, 0);
            }
            host.writeU32(fiber + FIBER.DATA, parameter);
        }
        return fiber;
    };

    /** SameTebFlags is a WORD at an odd word: read and written in its dword. */
    const FLAGS_DWORD = TEB.SAME_TEB_FLAGS & ~3;
    const FLAGS_SHIFT = (TEB.SAME_TEB_FLAGS & 3) * 8;
    /** @param {number} teb */
    const runsFibers = teb=>
        ((host.readU32(teb + FLAGS_DWORD) >>> FLAGS_SHIFT) & HAS_FIBER_DATA) !== 0;
    /** @param {number} teb @param {boolean} on */
    const setRunsFibers = (teb, on)=>{
        const flags = host.readU32(teb + FLAGS_DWORD) >>> 0;
        const bit = HAS_FIBER_DATA << FLAGS_SHIFT;
        host.writeU32(teb + FLAGS_DWORD, (on ? flags | bit : flags & ~bit) >>> 0);
    };

    /** The thread's current fiber, or 0 when it is not running one. */
    const current = ()=>{
        const teb = host.teb() >>> 0;
        return teb === 0 || !runsFibers(teb) ? 0 : host.readU32(teb + TEB.FIBER_DATA) >>> 0;
    };

    /**
     * @param {number} parameter @returns {number}
     */
    const convert = parameter=>{
        const thread = host.currentThread();
        if (converted.has(thread))
        {
            host.setLastError(ERROR_ALREADY_FIBER);
            return 0;
        }
        const fiber = record(parameter);
        if (fiber === 0)
        {
            host.setLastError(ERROR_NOT_ENOUGH_MEMORY);
            return 0;
        }
        converted.set(thread, fiber);
        if (thread?.stackTop !== undefined && thread.stackLimit !== undefined)
        {
            bounds.set(fiber, { stackTop: thread.stackTop, stackLimit: thread.stackLimit });
        }
        const teb = host.teb() >>> 0;
        host.writeU32(teb + TEB.FIBER_DATA, fiber);
        setRunsFibers(teb, true);
        return fiber;
    };

    /**
     * @param {number} commit @param {number} reserve
     * @param {number} start @param {number} parameter
     * @returns {number}
     */
    const create = (commit, reserve, start, parameter)=>{
        if (start === 0)
        {
            host.setLastError(ERROR_INVALID_PARAMETER);
            return 0;
        }
        const stack = host.allocateStack({ commit, reserve });
        const fiber = stack ? record(parameter) : 0;
        if (!stack || fiber === 0)
        {
            if (stack)
            {
                host.releaseStack(stack);
            }
            host.setLastError(ERROR_NOT_ENOUGH_MEMORY);
            return 0;
        }
        stacks.set(fiber, stack);
        bounds.set(fiber, { stackTop: stack.top, stackLimit: stack.base });
        // The start routine's frame, as a thread's: its return address, then
        // its parameter, with headroom above so neither is on the edge.
        const esp = stack.top - 16;
        host.writeU32(esp, host.threadReturn());
        host.writeU32(esp + 4, parameter);
        host.writeU32(fiber + FIBER.EXCEPTION_LIST, CHAIN_END);
        host.writeU32(fiber + FIBER.STACK_BASE, stack.top);
        host.writeU32(fiber + FIBER.STACK_LIMIT, stack.base);
        host.writeU32(fiber + FIBER.ESP, esp);
        host.writeU32(fiber + FIBER.EIP, start);
        return fiber;
    };

    return {
        /** LPVOID ConvertThreadToFiber(LPVOID lpParameter) */
        ConvertThreadToFiber: {
            returns: 'pointer',
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([parameter])=>convert(parameter),
        },

        /** LPVOID ConvertThreadToFiberEx(LPVOID lpParameter, DWORD dwFlags) */
        ConvertThreadToFiberEx: {
            returns: 'pointer',
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([parameter])=>convert(parameter),
        },

        /** BOOL ConvertFiberToThread(void) */
        ConvertFiberToThread: {
            argBytes: 0,
            handler: ()=>{
                const thread = host.currentThread();
                const fiber = converted.get(thread);
                if (fiber === undefined)
                {
                    host.setLastError(ERROR_ALREADY_THREAD);
                    return 0;
                }
                converted.delete(thread);
                bounds.delete(fiber);
                const teb = host.teb() >>> 0;
                host.writeU32(teb + TEB.FIBER_DATA, 0);
                setRunsFibers(teb, false);
                host.free(fiber);
                return 1;
            },
        },

        /** LPVOID CreateFiber(SIZE_T dwStackSize, LPFIBER_START_ROUTINE lpStartAddress, LPVOID lpParameter) */
        CreateFiber: {
            returns: 'pointer',
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([size, start, parameter])=>create(size >>> 0, 0, start >>> 0, parameter),
        },

        /**
         * LPVOID CreateFiberEx(SIZE_T dwStackCommitSize, SIZE_T dwStackReserveSize,
         *     DWORD dwFlags, LPFIBER_START_ROUTINE lpStartAddress, LPVOID lpParameter)
         *
         * FIBER_FLAG_FLOAT_SWITCH asks for the floating-point state to be
         * switched too; it is not (ponytail: x87 and SSE control words stay the
         * thread's, switch them in SwitchToFiber when a program is seen to rely on it).
         */
        CreateFiberEx: {
            returns: 'pointer',
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([commit, reserve, , start, parameter])=>
                create(commit >>> 0, reserve >>> 0, start >>> 0, parameter),
        },

        /**
         * VOID DeleteFiber(LPVOID lpFiber) -- the running fiber's own deletion
         * ends the thread. Its fibre-local values are called back first, on
         * the calling thread.
         */
        DeleteFiber: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([fiber])=>{
                const at = fiber >>> 0;
                if (at !== 0 && at === current())
                {
                    return host.exitThread(1);
                }
                const gone = ()=>{
                    const stack = stacks.get(at);
                    if (stack)
                    {
                        stacks.delete(at);
                        host.releaseStack(stack);
                    }
                    bounds.delete(at);
                    if (at !== 0)
                    {
                        host.free(at);
                    }
                    return 0;
                };
                const block = at === 0 ? 0 : host.readU32(at + FIBER.FLS) >>> 0;
                return block !== 0 && host.storage
                    ? host.storage.release(block).then(gone) : gone();
            },
        },

        /** BOOL IsThreadAFiber(void) */
        IsThreadAFiber: {
            argBytes: 0,
            handler: ()=>(current() !== 0 ? 1 : 0),
        },

        /** VOID SwitchToFiber(LPVOID lpFiber) */
        SwitchToFiber: {
            argBytes: 4,
            /**
             * @param {number[]} args
             * @param {{ restingStack: number, hostReturn: number }} [frame]
             */
            handler: ([target], frame)=>{
                const to = target >>> 0;
                const teb = host.teb() >>> 0;
                const from = current();
                if (to === 0 || teb === 0 || !frame)
                {
                    return 0;
                }
                const registers = host.registers();
                const thread = host.currentThread();
                if (from !== 0)
                {
                    host.writeU32(from + FIBER.EBX, registers.ebx);
                    host.writeU32(from + FIBER.ESI, registers.esi);
                    host.writeU32(from + FIBER.EDI, registers.edi);
                    host.writeU32(from + FIBER.EBP, registers.ebp);
                    // Where the caller resumes: the stack as the call's own
                    // return leaves it, and the instruction after the call.
                    host.writeU32(from + FIBER.ESP, frame.restingStack);
                    host.writeU32(from + FIBER.EIP, frame.hostReturn);
                    host.writeU32(from + FIBER.EXCEPTION_LIST,
                        host.readU32(teb + TEB.EXCEPTION_LIST));
                    host.writeU32(from + FIBER.STACK_BASE, host.readU32(teb + TEB.STACK_BASE));
                    host.writeU32(from + FIBER.STACK_LIMIT, host.readU32(teb + TEB.STACK_LIMIT));
                    host.writeU32(from + FIBER.FLS, host.readU32(teb + TEB.FLS_SLOTS));
                    host.writeU32(from + FIBER.ACTIVATION_STACK,
                        host.readU32(teb + TEB.ACTIVATION_STACK));
                }
                host.writeU32(teb + TEB.FLS_SLOTS, host.readU32(to + FIBER.FLS));
                host.writeU32(teb + TEB.ACTIVATION_STACK,
                    host.readU32(to + FIBER.ACTIVATION_STACK));
                host.writeU32(teb + TEB.EXCEPTION_LIST, host.readU32(to + FIBER.EXCEPTION_LIST));
                host.writeU32(teb + TEB.STACK_BASE, host.readU32(to + FIBER.STACK_BASE));
                host.writeU32(teb + TEB.STACK_LIMIT, host.readU32(to + FIBER.STACK_LIMIT));
                // A fiber's stack is committed whole, its reservation from its limit.
                host.writeU32(teb + TEB.DEALLOCATION_STACK, host.readU32(to + FIBER.STACK_LIMIT));
                host.writeU32(teb + TEB.FIBER_DATA, to);
                const kept = bounds.get(to);
                if (thread && kept)
                {
                    thread.stackTop = kept.stackTop;
                    thread.stackLimit = kept.stackLimit;
                }
                host.setRegisters({
                    ebx: host.readU32(to + FIBER.EBX),
                    esi: host.readU32(to + FIBER.ESI),
                    edi: host.readU32(to + FIBER.EDI),
                    ebp: host.readU32(to + FIBER.EBP),
                    esp: host.readU32(to + FIBER.ESP),
                    eip: host.readU32(to + FIBER.EIP),
                });
                return 0;
            },
        },
    };
}
