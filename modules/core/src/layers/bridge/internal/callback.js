/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Calling the guest back.
 *
 * A host function that takes a function pointer -- a comparator, a window
 * procedure, an enumeration callback -- has to run guest code and use its
 * answer. It cannot simply call it: the handler runs inside the emulator's own
 * loop, and the emulator cannot be re-entered from within it.
 *
 * So the call happens the way §12.3 describes, pointed the other way. The
 * calling thread is stopped where it stands, a frame for the callback is built
 * below where its stack comes to rest, and the thread is sent to the callback
 * with a return address that traps. When that trap fires the answer is in EAX,
 * the thread is stopped again, and the host function -- suspended on a promise
 * all this while -- carries on.
 *
 * Both stacks here are per thread and both are stacks rather than single slots,
 * because either kind of call can nest: a callback may trap into another host
 * function, and that one may call the guest back in turn.
 */

/**
 * @param {Object} deps
 * @param {any} deps.cpu
 * @param {any} deps.kernel
 * @param {any} deps.memory
 * @param {(name: string, popBytes: number, options?: object) => { id: number, address: number }}
 *        deps.reserveTrap
 */
export function createCallbacks({ cpu, kernel, memory, reserveTrap }){
    /** The stub every guest callback returns to. Taken on first use, once. */
    /** @type {number | null} */
    let sentinelId = null;
    let sentinelAddress = 0;
    let calls = 0;
    let deepest = 0;
    let pending = 0;

    /** @param {any} thread */
    const callbackFrames = thread=>(thread.callbackFrames ??= []);
    /**
     * @param {any} thread
     * @returns {{ name: string, restingStack: number, hostReturn: number, at?: number }[]}
     */
    const hostCalls = thread=>(thread.hostCalls ??= []);

    /**
     * Where a thread's stack is while it is stopped: inside the innermost
     * callback frame if it is in one, otherwise where the host call that
     * suspended it left the stack.
     *
     * @param {any} thread
     * @returns {number | undefined}
     */
    function restingStack(thread){
        const frames = callbackFrames(thread);
        if (frames.length > 0)
        {
            return frames[frames.length - 1].frameBase;
        }
        const suspended = hostCalls(thread);
        return suspended.length > 0 ? suspended[suspended.length - 1].restingStack : undefined;
    }

    return {
        /**
         * Takes the sentinel's slot in the stub table.
         *
         * Called before the first ordinary registration rather than on first
         * use: the table is written into guest memory once, after everything is
         * registered, so a slot taken later exists only on the host side and the
         * address a callback returns to holds no code at all.
         */
        reserve(){
            if (sentinelId === null)
            {
                // Reached by the callback's own `ret`, so the answer is in EAX
                // and the stub has to put it somewhere before using EAX itself.
                const taken = reserveTrap('<callback-return>', 0, { preserveResult: true });
                sentinelId = taken.id;
                sentinelAddress = taken.address;
            }
        },

        /** @returns {number | null} the trap id the sentinel raises, once taken */
        sentinel: ()=>sentinelId,

        /**
         * Records that a host call has suspended, and where the thread it
         * suspended will pick up its own code again.
         *
         * @param {any} thread
         * @param {Object} call
         * @param {string} call.name
         * @param {number} call.restingStack
         * @param {number} call.hostReturn
         */
        suspended(thread, call){
            pending++;
            // A thread whose host call has not answered has nothing to run: it
            // is parked on `hlt` and retires the park loop and nothing else.
            // Left counted as runnable, it keeps the scheduler from ever
            // reaching the branch that moves the guest's clock to the next
            // deadline -- so a fifteen-millisecond wait inside the guest is
            // crossed in steps of however long the host loop takes to come
            // round, which measured at a fifth to a third of a whole run.
            //
            // Unless it is running a callback. Then the very same suspension is
            // what sends it into guest code, and it is the most runnable thread
            // there is.
            thread.awaitingHost = callbackFrames(thread).length === 0;
            // Stamped so a report can say how long it has been waiting. A call
            // that suspends and never answers stops the whole machine -- every
            // thread of it -- and from outside that is indistinguishable from a
            // machine that is merely slow.
            hostCalls(thread).push({ ...call, at: Date.now() });
        },

        /**
         * Which host calls this thread is in the middle of but not running --
         * suspended on a callback. A failure report wants these as much as the
         * one on the stack right now: they are why the guest is where it is.
         *
         * @param {any} thread
         * @returns {string[]}
         */
        waiting: thread=>thread ? hostCalls(thread).map(call=>call.name) : [],

        /**
         * Starts a call into guest code and returns its result.
         *
         * @param {Object} call
         * @param {any} call.thread
         * @param {number} call.entry            Guest address of the routine.
         * @param {number[]} [call.args]
         * @param {number} [call.stackAtRest]    Where the stack is, when nothing else knows.
         * @returns {Promise<number>}
         */
        call({ thread, entry, args = [], stackAtRest }){
            if (!thread)
            {
                throw new Error('bridge: a guest callback needs a thread to run on');
            }
            if (sentinelId === null)
            {
                throw new Error('bridge: the callback sentinel was never reserved');
            }

            // The call in flight decides where the frame goes, and the callback
            // frames only answer when there is none.
            //
            // The other way round is a stack corruption with no symptom at the
            // moment it happens. A window procedure that subclasses another
            // calls back into the guest from inside a callback, and the
            // innermost callback frame's base is where the *outer* procedure's
            // frame began -- which that procedure is by now standing well below,
            // using every byte in between. Building the new frame there writes
            // the sentinel and the arguments over its live locals and its return
            // address. The inner call returns perfectly; the outer one then
            // returns to whatever the overwrite left, never reaches the
            // sentinel, and the host call waiting on it is never answered. The
            // thread is parked for ever and the program stops with nothing to
            // say for itself.
            const resting = stackAtRest ?? restingStack(thread);
            if (resting === undefined)
            {
                throw new Error('bridge: a guest callback must know where the thread\'s stack is');
            }

            // The frame the callback will find: its return address at the top,
            // its arguments above that. Built below everything already in use,
            // so an outer frame is still intact when this one unwinds.
            const frameBase = resting - 4 * (args.length + 1);
            // And it has to land on this thread's own stack. Three separate
            // defects have written a callback frame onto a stack belonging to
            // another thread -- each time because the resting position was read
            // from something that had moved on while a handler awaited -- and
            // every one of them was silent at the moment it happened, surfacing
            // much later as a return into an address that holds no code. There
            // is no legitimate reason for a frame to be anywhere else, so the
            // fourth instance stops here and says whose stack it was about to
            // write on instead of corrupting it.
            if (thread.stackLimit !== undefined
                && (frameBase < thread.stackLimit || frameBase > thread.stackTop))
            {
                throw new Error(`bridge: a callback frame for ${thread.name} at`
                    + ` 0x${(frameBase >>> 0).toString(16)} is outside its stack`
                    + ` (0x${(thread.stackLimit >>> 0).toString(16)}`
                    + `..0x${(thread.stackTop >>> 0).toString(16)})`);
            }
            memory.writeU32(frameBase, sentinelAddress);
            args.forEach((value, index)=>memory.writeU32(frameBase + 4 + index * 4, value));

            const frames = callbackFrames(thread);
            calls++;
            deepest = Math.max(deepest, frames.length + 1);

            /** @type {(value: number) => void} */
            let settle = ()=>{};
            const answer = new Promise(resolve=>{
                settle = resolve;
            });
            frames.push({ frameBase, settle });

            kernel.scheduleResume(thread, { eip: entry, esp: frameBase });
            // Off to run guest code, whatever it was doing before.
            thread.awaitingHost = false;
            return answer;
        },

        /**
         * A callback has just returned; the stub moved its answer to ECX.
         *
         * @param {any} thread
         * @returns {boolean} whether this thread was in a callback at all
         */
        returned(thread){
            const frame = callbackFrames(thread).pop();
            if (!frame)
            {
                return false;
            }
            // Back inside whatever host call was waiting for it, which has not
            // answered yet: nothing for this thread to run until it does.
            thread.awaitingHost = hostCalls(thread).length > 0;
            frame.settle(cpu.readReg32('ecx') | 0);
            return true;
        },

        /**
         * A host call has produced its answer: the thread goes back to its own
         * code, with the stack it had before any of this started.
         *
         * @param {any} thread
         * @param {number} returnValue
         */
        finish(thread, returnValue){
            const call = hostCalls(thread).pop();
            if (!call)
            {
                throw new Error('bridge: a host call finished that was never suspended');
            }
            pending--;
            thread.awaitingHost = false;
            kernel.scheduleResume(thread, {
                eip: call.hostReturn,
                esp: call.restingStack,
                returnValue,
            });
        },

        /**
         * How many host calls are suspended right now.
         *
         * Whoever drives the machine needs this: a suspended call may be waiting
         * on something outside the event loop's microtask queue -- a fetch, a
         * file read -- and a loop that only flushes microtasks between turns
         * would spin until it gave up.
         */
        pendingCalls: ()=>pending,

        diagnostics: ()=>({
            callbacks: calls,
            deepestCallback: deepest,
            suspended: pending,
            // Named, not merely counted. A count above zero says the run loop
            // has to keep handing the thread back to the host; it does not say
            // which call is holding the machine, and that is the only question
            // anyone asks of it.
            suspendedCalls: kernel.threads().flatMap((/** @type {any} */ thread)=>
                hostCalls(thread).map(call=>({
                    thread: thread.name,
                    name: call.name,
                    forMs: Date.now() - (call.at ?? Date.now()),
                }))),
        }),
    };
}
