/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Critical sections that stay in the guest.
 *
 * Entering and leaving a section is the most frequent call a program makes
 * into the system, and on Windows it never leaves the process: the structure
 * the program passes is the lock, and only a contended entry or a release
 * that owes somebody a wake goes to the kernel. Crossing into the host for
 * every one of them was the largest single boundary this engine paid --
 * measured on a real title, eighty-four thousand crossings in nine seconds of
 * loading, more than all of the drawing together.
 *
 * So the fast path is a few guest instructions, written once into memory the
 * processor executes, and every export the program binds to points at them.
 * The algorithm is the one Windows itself used before Vista, on the same
 * fields of the same structure:
 *
 *   LockCount       -1 free; otherwise one less than the threads that want it
 *   RecursionCount  how many times the owner has entered
 *   OwningThread    the owner's id, which is what FS:[0x24] holds
 *
 * Entering increments LockCount atomically; a result of zero means it was
 * free and the thread owns it. Anything else means an owner exists: if that
 * is us the recursion count grows, otherwise the thread waits -- through a
 * trap, since waiting is the scheduler's. Leaving decrements RecursionCount,
 * clears the owner at zero, then decrements LockCount; a result at or above
 * zero says somebody incremented it to wait, and the wake is a trap too.
 *
 * The increment and decrement are `lock`ed single instructions and the
 * scheduler only ever preempts between instructions, which is the whole of
 * what makes the fast path safe. The owner is written *after* the increment
 * that took the lock, exactly as Windows does it, so a thread that loses the
 * race sees either no owner or a stranger and waits in both cases; the
 * hand-off writes the owner for it before it is woken.
 *
 * What the host keeps per section is only what a wait needs: who is queued,
 * and how many wakes arrived before their waiter did. That second number is
 * the semaphore Windows uses for the same purpose -- a thread can increment
 * LockCount, be preempted before it traps, and be woken by a release that
 * happens in between; the wake must not be lost.
 */

/** Field offsets of RTL_CRITICAL_SECTION. */
export const CS = {
    LOCK_COUNT: 4,
    RECURSION_COUNT: 8,
    OWNING_THREAD: 12,
};

/** Where a thread's id lives in its environment block. */
const TEB_THREAD_ID = 0x24;

/**
 * Two counters the fast path keeps in guest memory, because nothing on the
 * host side sees a call that never crosses. Read for diagnostics.
 */
export const COUNTERS = {
    ENTERED: 0,
    LEFT: 4,
    SIZE: 8,
};

/** @param {number} value @returns {number[]} */
const dword = value=>[
    value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24 & 0xff,
];

/**
 * `jmp rel32` to an absolute target, from the instruction's own position.
 *
 * @param {number} from  Where the jump instruction starts.
 * @param {number} to
 * @returns {number[]}
 */
const jump = (from, to)=>[0xe9, ...dword((to - (from + 5)) | 0)];

/**
 * VOID EnterCriticalSection(LPCRITICAL_SECTION), as guest code.
 *
 *     mov ecx, [esp+4]
 *     mov eax, fs:[0x24]
 *     lock inc dword [counters.entered]
 *     lock inc dword [ecx+LockCount]
 *     jnz taken
 *     mov [ecx+OwningThread], eax
 *     mov dword [ecx+RecursionCount], 1
 *     ret 4
 *   taken:
 *     cmp [ecx+OwningThread], eax
 *     jne wait
 *     inc dword [ecx+RecursionCount]
 *     ret 4
 *   wait:
 *     jmp <cs-wait>          ; the trap answers the caller with the same stack
 *
 * @param {number} at        Where these bytes will live.
 * @param {number} waitTrap  The host's wait, a stdcall of one argument.
 * @param {number} counters  The counters block.
 * @returns {Uint8Array}
 */
export function enterCode(at, waitTrap, counters){
    const body = [
        0x8b, 0x4c, 0x24, 0x04,                                      // mov ecx, [esp+4]
        0x64, 0xa1, ...dword(TEB_THREAD_ID),                         // mov eax, fs:[0x24]
        0xf0, 0xff, 0x05, ...dword(counters + COUNTERS.ENTERED),     // lock inc [entered]
        0xf0, 0xff, 0x41, CS.LOCK_COUNT,                             // lock inc [ecx+4]
        0x75, 0x0d,                                                  // jnz taken (+13)
        0x89, 0x41, CS.OWNING_THREAD,                                // mov [ecx+12], eax
        0xc7, 0x41, CS.RECURSION_COUNT, ...dword(1),                 // mov [ecx+8], 1
        0xc2, 0x04, 0x00,                                            // ret 4
        // taken:
        0x39, 0x41, CS.OWNING_THREAD,                                // cmp [ecx+12], eax
        0x75, 0x06,                                                  // jne wait (+6)
        0xff, 0x41, CS.RECURSION_COUNT,                              // inc [ecx+8]
        0xc2, 0x04, 0x00,                                            // ret 4
    ];
    // wait:
    return new Uint8Array([...body, ...jump(at + body.length, waitTrap)]);
}

/**
 * VOID LeaveCriticalSection(LPCRITICAL_SECTION), as guest code.
 *
 *     mov ecx, [esp+4]
 *     lock inc dword [counters.left]
 *     dec dword [ecx+RecursionCount]
 *     jnz nested
 *     mov dword [ecx+OwningThread], 0
 *     lock dec dword [ecx+LockCount]
 *     jge wake               ; somebody incremented it to wait
 *     ret 4
 *   nested:
 *     lock dec dword [ecx+LockCount]
 *     ret 4
 *   wake:
 *     jmp <cs-wake>
 *
 * @param {number} at
 * @param {number} wakeTrap
 * @param {number} counters
 * @returns {Uint8Array}
 */
export function leaveCode(at, wakeTrap, counters){
    const body = [
        0x8b, 0x4c, 0x24, 0x04,                                      // mov ecx, [esp+4]
        0xf0, 0xff, 0x05, ...dword(counters + COUNTERS.LEFT),        // lock inc [left]
        0xff, 0x49, CS.RECURSION_COUNT,                              // dec [ecx+8]
        0x75, 0x10,                                                  // jnz nested (+16)
        0xc7, 0x41, CS.OWNING_THREAD, ...dword(0),                   // mov [ecx+12], 0
        0xf0, 0xff, 0x49, CS.LOCK_COUNT,                             // lock dec [ecx+4]
        0x7d, 0x0a,                                                  // jge wake (+10)
        0xc2, 0x04, 0x00,                                            // ret 4
        // nested:
        0xf0, 0xff, 0x49, CS.LOCK_COUNT,                             // lock dec [ecx+4]
        0xc2, 0x04, 0x00,                                            // ret 4
    ];
    // wake:
    return new Uint8Array([...body, ...jump(at + body.length, wakeTrap)]);
}

/**
 * BOOL TryEnterCriticalSection(LPCRITICAL_SECTION), as guest code. Never
 * traps: a try that would wait answers FALSE instead.
 *
 *     mov ecx, [esp+4]
 *     mov edx, fs:[0x24]
 *     push ebx                           ; callee-saved, and the only register left
 *     xor ebx, ebx
 *     mov eax, -1
 *     lock cmpxchg [ecx+LockCount], ebx  ; free -> owned, in one instruction
 *     pop ebx
 *     jnz held
 *     mov [ecx+OwningThread], edx
 *     mov dword [ecx+RecursionCount], 1
 *     mov eax, 1
 *     ret 4
 *   held:
 *     cmp [ecx+OwningThread], edx
 *     jne no
 *     lock inc dword [ecx+LockCount]
 *     inc dword [ecx+RecursionCount]
 *     mov eax, 1
 *     ret 4
 *   no:
 *     xor eax, eax
 *     ret 4
 *
 * @returns {Uint8Array}
 */
export function tryEnterCode(){
    return new Uint8Array([
        0x8b, 0x4c, 0x24, 0x04,                                      // mov ecx, [esp+4]
        0x64, 0x8b, 0x15, ...dword(TEB_THREAD_ID),                   // mov edx, fs:[0x24]
        0x53,                                                        // push ebx
        0x31, 0xdb,                                                  // xor ebx, ebx
        0xb8, ...dword(-1),                                          // mov eax, -1
        0xf0, 0x0f, 0xb1, 0x59, CS.LOCK_COUNT,                       // lock cmpxchg [ecx+4], ebx
        0x5b,                                                        // pop ebx (flags kept)
        0x75, 0x12,                                                  // jnz held (+18)
        0x89, 0x51, CS.OWNING_THREAD,                                // mov [ecx+12], edx
        0xc7, 0x41, CS.RECURSION_COUNT, ...dword(1),                 // mov [ecx+8], 1
        0xb8, ...dword(1),                                           // mov eax, 1
        0xc2, 0x04, 0x00,                                            // ret 4
        // held:
        0x39, 0x51, CS.OWNING_THREAD,                                // cmp [ecx+12], edx
        0x75, 0x0f,                                                  // jne no (+15)
        0xf0, 0xff, 0x41, CS.LOCK_COUNT,                             // lock inc [ecx+4]
        0xff, 0x41, CS.RECURSION_COUNT,                              // inc [ecx+8]
        0xb8, ...dword(1),                                           // mov eax, 1
        0xc2, 0x04, 0x00,                                            // ret 4
        // no:
        0x31, 0xc0,                                                  // xor eax, eax
        0xc2, 0x04, 0x00,                                            // ret 4
    ]);
}

/**
 * @typedef {Object} CriticalHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {() => any} currentThread
 * @property {(thread: any, reason: string) => void} block
 * @property {(thread: any, result?: number) => boolean} wake
 * @property {(thread?: any) => any} park
 * @property {(bytes: number) => number} allocate
 *           Guest memory for the two counters the fast paths keep.
 */

/**
 * The host's half: the queue behind a contended section, and the wake that
 * hands it over.
 *
 * @param {CriticalHost} host
 */
export function createCriticalSections(host){
    /**
     * @typedef {Object} Queue
     * @property {any[]} waiters
     * @property {number} owed
     *           Wakes that arrived before their waiter did. A thread that has
     *           incremented LockCount and not yet trapped is owed exactly one.
     */
    /** @type {Map<number, Queue>} */
    const queues = new Map();
    let waits = 0;
    let wakes = 0;
    let handoffs = 0;
    /**
     * The counters block, zeroed once made: the fast paths only ever
     * increment it. Made on first use rather than here, because this is
     * built before the memory it would come from is mapped.
     */
    let counters = 0;
    const countersBlock = ()=>{
        if (counters === 0)
        {
            counters = host.allocate(COUNTERS.SIZE);
            host.writeMemory(counters, new Uint8Array(COUNTERS.SIZE));
        }
        return counters;
    };
    /** @param {number} at */
    const readU32 = at=>{
        const bytes = host.readMemory(at, 4);
        return (bytes[0] | bytes[1] << 8 | bytes[2] << 16 | bytes[3] << 24) >>> 0;
    };

    /** @param {number} address */
    const queueAt = address=>{
        let queue = queues.get(address);
        if (!queue)
        {
            queue = { waiters: [], owed: 0 };
            queues.set(address, queue);
        }
        return queue;
    };

    /** @param {number} value */
    const dwordBytes = value=>new Uint8Array(dword(value));

    /**
     * Makes `thread` the owner in the structure, the way the fast path would
     * have for itself. Written by whoever hands over, because the thread
     * receiving it is not running.
     *
     * @param {number} address @param {any} thread
     */
    const handOver = (address, thread)=>{
        host.writeMemory(address + CS.OWNING_THREAD, dwordBytes(thread.id));
        host.writeMemory(address + CS.RECURSION_COUNT, dwordBytes(1));
        handoffs++;
    };

    return {
        /** Where the fast paths count themselves; theirs to increment, ours to read. */
        counters: countersBlock,

        /**
         * The fast path found an owner that was not the caller. LockCount
         * already counts the caller; nothing here touches it.
         *
         * @param {number} address
         */
        wait(address){
            waits++;
            const thread = host.currentThread();
            const queue = queueAt(address);
            if (queue.owed > 0)
            {
                // The owner left between the caller's increment and this
                // trap, and its wake found nobody: it is ours.
                queue.owed--;
                handOver(address, thread);
                return 0;
            }
            queue.waiters.push(thread);
            // The structure as the waiter saw it, for the report's blocked-thread
            // line: a wait with no owner names a lost release, not contention.
            host.block(thread, `critical section 0x${address.toString(16)}`
                + ` (lock ${readU32(address + CS.LOCK_COUNT) | 0},`
                + ` owner ${readU32(address + CS.OWNING_THREAD)},`
                + ` recursion ${readU32(address + CS.RECURSION_COUNT) | 0}, me ${thread.id})`);
            return host.park(thread);
        },

        /**
         * The fast path's decrement found LockCount at or above zero: at least
         * one thread has incremented it to wait, whether or not it has reached
         * `wait` yet.
         *
         * @param {number} address
         */
        wake(address){
            wakes++;
            const queue = queueAt(address);
            // A suspended waiter is not waiting while it is suspended, so the
            // section goes to the first that can run. With none, the release
            // is owed, as a wake that came before its waiter is.
            const at = queue.waiters.findIndex(thread=>!(thread.suspendCount > 0));
            if (at >= 0)
            {
                const [next] = queue.waiters.splice(at, 1);
                handOver(address, next);
                host.wake(next, 0);
                return 0;
            }
            queue.owed++;
            return 0;
        },

        /**
         * A thread has been resumed: if it is queued behind a section whose
         * release was owed while nobody could take it, the section is its own.
         *
         * @param {any} thread
         */
        resumed(thread){
            for (const [address, queue] of queues)
            {
                const at = queue.waiters.indexOf(thread);
                if (at >= 0 && queue.owed > 0)
                {
                    queue.owed--;
                    queue.waiters.splice(at, 1);
                    handOver(address, thread);
                    host.wake(thread, 0);
                    return;
                }
            }
        },

        /**
         * A section being deleted or reinitialised takes its queue with it.
         *
         * @param {number} address
         */
        forget(address){
            queues.delete(address);
        },

        /** @returns {string[]} one line per thread queued behind a section */
        waiting: ()=>[...queues].flatMap(([address, queue])=>
            queue.waiters.map(thread=>
                `${thread.name}: critical section 0x${address.toString(16)}`)),

        diagnostics: ()=>({
            // What never crossed into the host, which is the point of all this.
            entered: counters === 0 ? 0 : readU32(counters + COUNTERS.ENTERED),
            left: counters === 0 ? 0 : readU32(counters + COUNTERS.LEFT),
            waits,
            wakes,
            handoffs,
            queued: [...queues.values()].reduce((total, queue)=>total + queue.waiters.length, 0),
            owed: [...queues.values()].reduce((total, queue)=>total + queue.owed, 0),
        }),
    };
}
