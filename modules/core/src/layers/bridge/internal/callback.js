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
    /**
     * Counts suspensions. A host call that calls the guest back builds the
     * callback's frame before it suspends, so a frame stamped with the count
     * still current when a call suspends is that call's own, however far
     * below its stack it stands.
     */
    let epoch = 0;
    /**
     * Whoever is waiting for the next host call to answer, and the promise
     * they hold. Made when first asked for and settled by the next `finish`,
     * so a run loop with nothing to do sleeps until something has changed
     * rather than waking to look.
     *
     * @type {{ promise: Promise<void>, settle: () => void } | null}
     */
    let answered = null;
    /**
     * The last few routines the guest was sent to, and who sent it.
     *
     * A fault inside guest code says where the processor stopped and nothing
     * about how it got there. When the guest was started by us -- a window
     * procedure, a callback, an initialiser -- the entry we chose and the host
     * call that chose it are the first two facts a reader needs, and neither
     * exists anywhere else once the frame has unwound.
     *
     * @type {{ entry: number, by: string, thread: string }[]}
     */
    const started = [];
    const STARTED_RING = 8;

    /** @param {any} thread */
    const callbackFrames = thread=>(thread.callbackFrames ??= []);
    /**
     * @param {any} thread
     * @returns {{ name: string, restingStack: number, hostReturn: number, at?: number }[]}
     */
    const hostCalls = thread=>(thread.hostCalls ??= []);

    /**
     * Where a thread's stack is while it is stopped: the lower of where its
     * innermost callback frame began and where its innermost suspended host
     * call left the stack.
     *
     * The lower, not the more recent kind. A callback frame that is still
     * open belongs to a procedure that has since run on, pushed its locals
     * and made a host call of its own; that call suspended below everything
     * the procedure is using, and its resting stack is the true position.
     * Taking the frame base instead built the next callback on top of the
     * procedure's live locals and its return address -- which is what a
     * modal loop does to the dialog procedure that opened it, the moment a
     * message is dispatched after the nested dialog has ended.
     *
     * @param {any} thread
     * @returns {number | undefined}
     */
    function restingStack(thread){
        const frames = callbackFrames(thread);
        const suspended = hostCalls(thread);
        const frame = frames.length > 0 ? frames[frames.length - 1].frameBase : undefined;
        const call = suspended.length > 0
            ? suspended[suspended.length - 1].restingStack
            : undefined;
        if (frame === undefined || call === undefined)
        {
            return frame ?? call;
        }
        return Math.min(frame, call);
    }

    /**
     * Forgets every callback and host call a thread's own code has left by a
     * jump of its own, seen when the thread next stands above them.
     *
     * A C++ catch found by the runtime's frame handler in guest code ends in
     * the runtime's own jump to the continuation: the throw's host call and
     * the handler's callback never return, and neither `returned` nor
     * `transfer` hears of it. Left in the books, the thread counted as inside
     * a callback, so its next wait for a message was a wait the scheduler ran
     * -- a process spinning in the park loop for good, which never idled and
     * so never let the child it had started have a turn.
     *
     * Only on the thread's own stack: a fiber's stack is elsewhere, and a
     * host call made on one says nothing about the frames on the other. And
     * never the frames the suspending call has just built for its own
     * callback, which stand below it too.
     *
     * @param {any} thread @param {number} stack  Where the thread's stack is now.
     */
    function abandonBelow(thread, stack){
        const own = (/** @type {number} */ address)=>thread.stackLimit === undefined
            || (address >= thread.stackLimit >>> 0 && address <= thread.stackTop >>> 0);
        if (!own(stack))
        {
            return;
        }
        const frames = callbackFrames(thread);
        let top = frames.length;
        while (top > 0 && frames[top - 1].epoch === epoch)
        {
            top--;
        }
        let cut = top;
        while (cut > 0 && frames[cut - 1].extent >>> 0 <= stack
            && own(frames[cut - 1].frameBase >>> 0))
        {
            cut--;
        }
        if (cut < top)
        {
            frames.splice(cut, top - cut);
        }
        const suspended = hostCalls(thread);
        while (suspended.length > 0 && suspended[suspended.length - 1].restingStack >>> 0 < stack
            && own(suspended[suspended.length - 1].restingStack >>> 0))
        {
            suspended.pop();
            pending--;
        }
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
            abandonBelow(thread, call.restingStack >>> 0);
            const frames = callbackFrames(thread);
            const callingBack = frames.length > 0 && frames[frames.length - 1].epoch === epoch;
            epoch++;
            pending++;
            // A thread whose host call has not answered has nothing to run: it
            // is parked on `hlt` and retires the park loop and nothing else.
            // Left counted as runnable, it keeps the scheduler from ever
            // reaching the branch that moves the guest's clock to the next
            // deadline -- so a fifteen-millisecond wait inside the guest is
            // crossed in steps of however long the host loop takes to come
            // round, which measured at a fifth to a third of a whole run.
            //
            // Unless this call is running a callback. Then the very same
            // suspension is what sends it into guest code, and it is the most
            // runnable thread there is. Only this call's: a wait made inside a
            // callback some outer call is running -- a modal loop inside a
            // window procedure, a script's message loop inside a COM call --
            // is a wait like any other, and counted runnable it spun the park
            // loop for as long as the wait lasted.
            thread.awaitingHost = !callingBack;
            // Stamped so a report can say how long it has been waiting. A call
            // that suspends and never answers stops the whole machine -- every
            // thread of it -- and from outside that is indistinguishable from a
            // machine that is merely slow.
            hostCalls(thread).push({ ...call,
                at: import.meta.BOTTLIFY_DIAGNOSTICS !== false ? Date.now() : 0 });
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
         * Where the guest was last sent, newest last, and by which host call.
         *
         * @returns {{ entry: number, by: string, thread: string }[]}
         */
        recentlyStarted: ()=>started.slice(),

        /**
         * Starts a call into guest code and returns its result.
         *
         * @param {Object} call
         * @param {any} call.thread
         * @param {number} call.entry            Guest address of the routine.
         * @param {number[]} [call.args]
         * @param {number} [call.stackAtRest]    Where the stack is, when nothing else knows.
         * @param {string} [call.by]             Which host call is starting it.
         * @param {Record<string, number>} [call.registers]
         *        What the routine finds in the registers besides its stack --
         *        a funclet reads its parent's frame through EBP before it has
         *        set anything.
         * @returns {Promise<number>}
         */
        call({ thread, entry, args = [], stackAtRest, by = 'somewhere', registers }){
            if (!thread)
            {
                throw new Error('bridge: a guest callback needs a thread to run on');
            }
            if (sentinelId === null)
            {
                throw new Error('bridge: the callback sentinel was never reserved');
            }
            // A routine at address zero is not a routine. Sending the guest
            // there produces a fault at 0x00000000 that reads exactly like the
            // program's own null call, when in fact we chose the address -- and
            // which of our calls chose it is gone by the time anyone reads the
            // report. So it is refused here, named.
            if ((entry >>> 0) === 0)
            {
                throw new Error(`bridge: ${by} asked to run guest code at address zero`);
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
            // its arguments above that, and one spare dword above those. Built
            // below everything already in use, so an outer frame is still
            // intact when this one unwinds.
            //
            // The spare is the sentinel's. A stdcall callback pops its own
            // arguments on the way out, which leaves ESP exactly where the frame
            // began; the sentinel stub then parks the thread by writing the park
            // address at ESP and returning through it. Without the spare that
            // write lands on the first live dword above the frame -- a saved
            // register, or the return address of the procedure that made the
            // suspended call -- and the procedure returns into the park loop
            // once its call is answered, with nothing to say for itself.
            const frameBase = resting - 4 * (args.length + 2);
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
            started.push({ entry: entry >>> 0, by, thread: thread.name });
            if (started.length > STARTED_RING)
            {
                started.shift();
            }

            /** @type {(value: number) => void} */
            let settle = ()=>{};
            const answer = new Promise(resolve=>{
                settle = resolve;
            });
            frames.push({ frameBase, extent: frameBase + 4 * (args.length + 2), settle, epoch });

            kernel.scheduleResume(thread, { eip: entry, esp: frameBase, registers });
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
            const frames = callbackFrames(thread);
            // A routine that never came back leaves its frame behind: an
            // exception handler in guest code that found its catch unwinds
            // and jumps there, and the frame the dispatch called it on lies
            // wholly below the stack the routine returning now came back to.
            // Settling that one instead would answer the dispatch -- the
            // throw returns to its caller, which has nothing after it -- and
            // leave the real caller waiting for ever.
            const esp = cpu.readReg32('esp') >>> 0;
            while (frames.length > 1 && frames[frames.length - 1].extent <= esp)
            {
                frames.pop();
            }
            const frame = frames.pop();
            if (!frame)
            {
                return false;
            }
            // So are the host calls such a routine was inside: the throw's own.
            const suspended = hostCalls(thread);
            while (suspended.length > 0
                && (suspended[suspended.length - 1].restingStack >>> 0) < frame.frameBase)
            {
                suspended.pop();
                pending--;
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
            if (answered)
            {
                const open = answered.settle;
                answered = null;
                open();
            }
            kernel.scheduleResume(thread, {
                eip: call.hostReturn,
                esp: call.restingStack,
                returnValue,
            });
        },

        /**
         * A host call has decided the thread does not come back to it at all:
         * it continues at `registers`, wherever that is, and every host call
         * and callback the thread was inside below that stack is abandoned.
         *
         * This is what an exception handler does when it finds its catch. The
         * throw is a host call, the dispatch it started called the guest's
         * frame handler, and that handler -- another host call -- chose a
         * block in a frame well above all of them. None of those calls
         * returns: on Windows the stack they stood on is simply discarded by
         * the jump, and the same is true here. What is below the new stack
         * pointer is gone; what is above it -- the window procedure the
         * program was in when it threw, the dispatch that called it -- is
         * still live and still waiting, and is kept.
         *
         * The line is `below` when given, and the new stack pointer when not.
         * They differ for a C++ catch: the block ran on a stack deeper than
         * the throw, and the function goes on at the stack pointer the block
         * left -- so the line is where the function stood when the throw left
         * it, which the handler read before running anything.
         *
         * The promises of the abandoned calls never settle. Nothing is left
         * that would read their answer.
         *
         * @param {any} thread
         * @param {Record<string, number>} registers  `eip` and `esp` at least.
         * @param {number} [below]
         */
        transfer(thread, registers, below){
            const target = (below ?? registers.esp) >>> 0;
            const suspended = hostCalls(thread);
            while (suspended.length > 0
                && (suspended[suspended.length - 1].restingStack >>> 0) <= target)
            {
                suspended.pop();
                pending--;
            }
            const frames = callbackFrames(thread);
            while (frames.length > 0
                && (frames[frames.length - 1].frameBase >>> 0) < target)
            {
                frames.pop();
            }
            thread.awaitingHost = false;
            if (answered)
            {
                const open = answered.settle;
                answered = null;
                open();
            }
            const { eip, esp, ...rest } = registers;
            kernel.scheduleResume(thread, {
                eip, esp, ...Object.keys(rest).length > 0 ? { registers: rest } : {},
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

        /**
         * Settles when the next suspended host call answers. The one thing
         * that can change a machine whose every thread is parked on the host,
         * so it is what the run loop waits on instead of a timer.
         */
        answered: ()=>{
            if (!answered)
            {
                /** @type {() => void} */
                let settle = ()=>{};
                /** @type {Promise<void>} */
                const promise = new Promise(resolve=>{
                    settle = ()=>resolve();
                });
                answered = { promise, settle };
            }
            return answered.promise;
        },

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
                    forMs: call.at ? Date.now() - call.at : 0,
                }))),
        }),
    };
}
