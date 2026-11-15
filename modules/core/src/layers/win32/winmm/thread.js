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
 *
 * The same thread serves anything else that owes a program calls from a thread
 * of its own -- a filter graph feeding a renderer the program wrote is one --
 * so the routine is not assumed to take five arguments: the loop puts the stack
 * back where it was after each call, and a routine that pops two of the five
 * words leaves nothing behind.
 */

/**
 * Guest-side layout of a notice: the routine, then its arguments - five for a
 * wave callback, seven words for the widest COM call made from here
 * (IPin::NewSegment: the pin, two REFERENCE_TIMEs and a double).
 */
const ARGS = 7;
const RECORD = {
    ENTRY: 0,
    ARGS: 4,
    SIZE: 4 + ARGS * 4,
};

/** How long the loop is. */
export const LOOP_BYTES = 35;

/**
 * The loop, as x86. `stub` is where the trap lives and `at` is where these
 * bytes will be, because the call to the stub is relative.
 *
 *     loop: push eax               ; what the last routine answered
 *           call stub              ; EAX = the record (the stub pops its word)
 *           mov esi, esp           ; callee-saved, so it outlives the call
 *           push dword [eax+28]    ; the seventh word
 *           push dword [eax+24]    ; the sixth
 *           push dword [eax+20]    ; dwParam2
 *           push dword [eax+16]    ; dwParam1
 *           push dword [eax+12]    ; dwInstance
 *           push dword [eax+8]     ; uMsg
 *           push dword [eax+4]     ; hwo
 *           call dword [eax]
 *           mov esp, esi           ; whatever the routine popped, none is left
 *           jmp loop
 *
 * @param {number} stub
 * @param {number} at
 * @returns {Uint8Array}
 */
export function loopCode(stub, at){
    const relative = (stub - (at + 6)) | 0;
    return new Uint8Array([
        0x50,
        0xe8, relative & 0xff, relative >>> 8 & 0xff,
        relative >>> 16 & 0xff, relative >>> 24 & 0xff,
        0x89, 0xe6,
        0xff, 0x70, 0x1c,
        0xff, 0x70, 0x18,
        0xff, 0x70, 0x14,
        0xff, 0x70, 0x10,
        0xff, 0x70, 0x0c,
        0xff, 0x70, 0x08,
        0xff, 0x70, 0x04,
        0xff, 0x10,
        0x89, 0xf4,
        0xeb, 0xdd,
    ]);
}

/**
 * @typedef {Object} NoticeThreadDeps
 * @property {(bytes: number) => number} allocate
 *           Guest memory the processor may execute and the host may write.
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(name: string, fn: { argBytes: number, handler: (args?: number[]) => any })
 *     => number} register
 *           Puts a host function behind a guest address.
 * @property {(options: { entry: number, name: string }) => any} createThread
 * @property {() => any} currentThread
 * @property {(thread: any, reason: string) => void} block
 * @property {(thread: any, result: number) => boolean} wake
 * @property {(thread: any) => any} park
 *           Stops the thread inside the trap; only legal from a handler.
 * @property {string} [name]    The thread's name; a wave device's by default.
 * @property {string} [reason]  What the thread is said to wait on while idle.
 * @property {string} [trap]    The name its trap is registered under.
 */

/**
 * @param {NoticeThreadDeps} deps
 */
export function createNoticeThread(deps){
    const name = deps.name ?? 'winmm';
    const reason = deps.reason ?? 'a wave notice';
    const trap = deps.trap ?? '<wave-notices>';
    /** @type {{ entry: number, args: number[], done?: (answer: number) => void, tag?: any }[]} */
    const queue = [];
    /** The notice whose routine is running: its loop has not asked again yet. */
    /** @type {{ done?: (answer: number) => void } | null} */
    let running = null;
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
        const next = /** @type {{ entry: number, args: number[], done?: (answer: number) => void }} */ (
            queue.shift());
        deps.writeMemory(record + RECORD.ENTRY, dword(next.entry));
        for (let index = 0; index < ARGS; index++)
        {
            deps.writeMemory(record + RECORD.ARGS + index * 4, dword(next.args[index] ?? 0));
        }
        delivered++;
        running = next;
        return record;
    };

    /** What the loop's trap answers: the next notice, or nothing until there is one. */
    /** @param {number[]} args  What the last routine left in EAX; nothing on the first ask. */
    const fetch = ([answer] = [])=>{
        // Asking again is how the loop says the last routine returned, and
        // what it returned comes with it: a COM method's HRESULT.
        const finished = running;
        running = null;
        finished?.done?.((answer ?? 0) >>> 0);
        if (queue.length > 0)
        {
            return handOut();
        }
        const me = deps.currentThread();
        waiting = me;
        deps.block(me, reason);
        return deps.park(me);
    };

    const start = ()=>{
        record = deps.allocate(RECORD.SIZE);
        const stub = deps.register(trap, { argBytes: 4, handler: fetch });
        const code = deps.allocate(LOOP_BYTES);
        deps.writeMemory(code, loopCode(stub, code));
        thread = deps.createThread({ entry: code, name });
    };

    return {
        /**
         * Queues a call to the program's routine, on the thread, in order.
         *
         * @param {number} entry
         * @param {number[]} args  Up to seven words; the loop pushes seven whatever
         *        the routine takes, and missing ones are zero.
         * @param {(answer: number) => void} [done]  Called once the routine has
         *        returned, with what it returned.
         * @param {any} [tag]  What `drop` finds it by.
         */
        deliver(entry, args, done, tag){
            queue.push({ entry, args: args.slice(0, ARGS), done, tag });
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

        /**
         * Takes back every queued notice with this tag that has not started:
         * the object it was for is going, and a call made after it went is a
         * call into freed memory. One already running is the caller's to wait
         * for.
         *
         * @param {any} tag
         * @returns {{ entry: number, args: number[], done?: (answer: number) => void }[]}
         *          what was taken back
         */
        drop(tag){
            /** @type {{ entry: number, args: number[], done?: (answer: number) => void }[]} */
            const dropped = [];
            for (let at = queue.length - 1; at >= 0; at--)
            {
                if (queue[at].tag === tag)
                {
                    dropped.unshift(...queue.splice(at, 1));
                }
            }
            return dropped;
        },

        diagnostics: ()=>({
            started: thread !== null,
            waiting: waiting !== null,
            queued: queue.length,
            delivered,
            running: running !== null,
        }),
    };
}
