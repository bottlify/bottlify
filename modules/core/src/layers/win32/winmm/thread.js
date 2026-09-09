/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The thread a wave device calls back on.
 *
 * Windows delivers WOM_DONE from a thread of its own, never from inside the
 * call that queued the buffer. A program is written against that: the routine
 * that writes buffers holds a lock while it does, and its callback takes the
 * same lock -- which is fine across two threads and a deadlock, or a recursion
 * that runs the stack out, on one. Delivering the callback by parking the
 * caller and running it on the caller's stack was that recursion.
 *
 * So there is a thread here, made the first time a callback is owed. It runs a
 * loop of a few guest instructions: ask the host for the next notice, call the
 * program's routine with it, ask again. Asking is a trap; when nothing is owed
 * the trap blocks the thread and parks it, and the next notice wakes it with
 * the notice's address in EAX. Everything the loop needs -- the routine and its
 * five arguments -- is in one record the host writes before each wake, and one
 * record is enough because the loop finishes with a notice before it asks for
 * another.
 *
 * The loop is guest code so that the callback is an ordinary call from an
 * ordinary thread: its frame is on the thread's own stack, its return address
 * is the loop's, and nothing on the host side has to know where a stack came
 * to rest.
 */

/** Guest-side layout of a notice: the routine, then its five arguments. */
const RECORD = {
    ENTRY: 0,
    ARGS: 4,
    SIZE: 24,
};

/**
 * The loop, as x86. `stub` is where the trap lives and `at` is where these
 * bytes will be, because the call to the stub is relative.
 *
 *     loop: call stub              ; EAX = the record
 *           push dword [eax+20]    ; dwParam2
 *           push dword [eax+16]    ; dwParam1
 *           push dword [eax+12]    ; dwInstance
 *           push dword [eax+8]     ; uMsg
 *           push dword [eax+4]     ; hwo
 *           call dword [eax]       ; stdcall, so the routine pops its own arguments
 *           jmp loop
 *
 * @param {number} stub
 * @param {number} at
 * @returns {Uint8Array}
 */
export function loopCode(stub, at){
    const relative = (stub - (at + 5)) | 0;
    return new Uint8Array([
        0xe8, relative & 0xff, relative >>> 8 & 0xff,
        relative >>> 16 & 0xff, relative >>> 24 & 0xff,
        0xff, 0x70, 0x14,
        0xff, 0x70, 0x10,
        0xff, 0x70, 0x0c,
        0xff, 0x70, 0x08,
        0xff, 0x70, 0x04,
        0xff, 0x10,
        0xeb, 0xe8,
    ]);
}

/**
 * @typedef {Object} NoticeThreadDeps
 * @property {(bytes: number) => number} allocate
 *           Guest memory the processor may execute and the host may write.
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(name: string, fn: { argBytes: number, handler: () => any }) => number} register
 *           Puts a host function behind a guest address.
 * @property {(options: { entry: number, name: string }) => any} createThread
 * @property {() => any} currentThread
 * @property {(thread: any, reason: string) => void} block
 * @property {(thread: any, result: number) => boolean} wake
 * @property {(thread: any) => any} park
 *           Stops the thread inside the trap; only legal from a handler.
 */

/**
 * @param {NoticeThreadDeps} deps
 */
export function createNoticeThread(deps){
    /** @type {{ entry: number, args: number[] }[]} */
    const queue = [];
    /** @type {any} */
    let thread = null;
    /** The thread, while it is parked in the trap with nothing to do. */
    /** @type {any} */
    let waiting = null;
    let record = 0;
    let delivered = 0;

    /** @param {number} value */
    const dword = value=>new Uint8Array([
        value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24 & 0xff,
    ]);

    /** Writes the next notice where the loop reads it. @returns {number} */
    const handOut = ()=>{
        const next = /** @type {{ entry: number, args: number[] }} */ (queue.shift());
        deps.writeMemory(record + RECORD.ENTRY, dword(next.entry));
        next.args.forEach((value, index)=>
            deps.writeMemory(record + RECORD.ARGS + index * 4, dword(value)));
        delivered++;
        return record;
    };

    /** What the loop's trap answers: the next notice, or nothing until there is one. */
    const fetch = ()=>{
        if (queue.length > 0)
        {
            return handOut();
        }
        const me = deps.currentThread();
        waiting = me;
        deps.block(me, 'a wave notice');
        return deps.park(me);
    };

    const start = ()=>{
        record = deps.allocate(RECORD.SIZE);
        const stub = deps.register('<wave-notices>', { argBytes: 0, handler: fetch });
        const code = deps.allocate(24);
        deps.writeMemory(code, loopCode(stub, code));
        thread = deps.createThread({ entry: code, name: 'winmm' });
    };

    return {
        /**
         * Queues a call to the program's routine, on the thread, in order.
         *
         * @param {number} entry
         * @param {number[]} args  Exactly five: the routine takes no other shape.
         */
        deliver(entry, args){
            queue.push({ entry, args: args.slice(0, 5) });
            if (thread === null)
            {
                start();
            }
            else if (waiting !== null)
            {
                const woken = waiting;
                waiting = null;
                deps.wake(woken, handOut());
            }
        },

        diagnostics: ()=>({
            started: thread !== null,
            waiting: waiting !== null,
            queued: queue.length,
            delivered,
        }),
    };
}
