/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { Convention, calleeCleanup } from './internal/conventions.js';
import { createParking } from './internal/parking.js';
import { createDispatcher } from './internal/dispatch.js';
import { createCallbacks } from './internal/callback.js';
import { driven, isDriven, stepsThroughPromises } from './internal/drive.js';
import { createVtables } from './internal/vtable.js';

/**
 * bridge — the boundary a call crosses in either direction.
 *
 * Above it, a host function is an ordinary function of numbers. Below it, a call
 * is a stub, a trap, a stack frame and a register that has to end up holding the
 * answer. Neither side is allowed to know the other's shape, which is the whole
 * point: `win32` describes what a function is without knowing how a guest
 * reaches it, and `cpu` emits the stub without knowing what it implements.
 */

/** Marks an answer that is not a value but a place to continue. */
const CONTINUATION = Symbol('continuation');

/**
 * @param {Record<string, number>} registers
 * @param {number} [below]
 * @returns {{ [CONTINUATION]: true, registers: Record<string, number>, below?: number }}
 */
const continuation = (registers, below)=>{
    if (registers.eip === undefined || registers.esp === undefined)
    {
        throw new Error('bridge: a continuation needs both eip and esp');
    }
    return Object.freeze({
        [CONTINUATION]: /** @type {true} */ (true), registers: { ...registers }, below,
    });
};

/**
 * @param {any} value
 * @returns {value is { registers: Record<string, number>, below?: number }}
 */
const isContinuation = value=>typeof value === 'object' && value !== null
    && value[CONTINUATION] === true;

/** Marks an answer that returns a value and sets other registers besides. */
const RETURNING = Symbol('returning');

/**
 * @param {any} value
 * @returns {value is { value: number, registers: Record<string, number> }}
 */
const isReturning = value=>typeof value === 'object' && value !== null
    && value[RETURNING] === true;

/** The bridge layer's module for one graph; see `defaultModules`. */
export function createBridgeModule(){
    /**
     * The instance this module object made last, for `diagnostics()` and
     * `dispose()`. Every graph is given module objects of its own
     * (`defaultModules`), so a child's graph built beside its parent's has
     * its own and neither one's going reaches the other's.
     *
     * The module contract puts both on the module rather than on the api, so
     * something outside a `create()` call has to be able to see in. That is
     * the only reason this exists, and it holds a reference rather than the
     * state itself -- the crossing belongs to the closure `create()` returns,
     * so a second instance in one realm cannot take the first one's
     * dispatcher, parking or vtables.
     *
     * @type {any}
     */
    let current = null;

    return {
        name: 'bridge',
        version: '0.1.0',
        // memory as well as cpu: a call frame is read through the guest's own stack
        // pointer, and a wild ESP should fail against the region map rather than
        // quietly marshal whatever bytes happen to live there.
        requires: /** @type {readonly string[]} */ (['cpu', 'kernel', 'memory', 'log']),

        /**
         * @param {any} config
         * @param {import('../../system/contract.js').ScopedModuleHost} host
         * @returns {Promise<any>}
         */
        async create(config, host){
            const cpu = host.requireApi('cpu');
            const kernel = host.requireApi('kernel');
            const memory = host.requireApi('memory');

            /** The thread `answering` names while its function runs, or null. @type {any} */
            let answeringFor = null;

            /**
             * Everything this instance owns, and whether it is still open.
             *
             * The calls an api hands out close over this object rather than over
             * module-level bindings, because `create()` may run more than once in
             * one realm -- a process replacement does, and the plan for more than
             * one machine in a worker needs two at once -- so each run keeps its
             * own dispatcher, parking and vtables.
             *
             * @type {{ dispatcher: any, parking: any, callbacks: any, vtables: any,
             *          failure: Error | null, disposed: boolean }}
             */
            const state = {
                dispatcher: null,
                parking: null,
                callbacks: null,
                vtables: null,
                failure: null,
                disposed: false,
            };

            // What actually happened at this seam, in order, so that a session can
            // be replayed later without the machine it came from. A crash here is
            // almost never a wrong value: it is an order of events -- a handler
            // that awaited, a turn that went elsewhere, a callback built on what
            // that turn left. Values can be reasoned about from a report; an order
            // cannot, and this is the only place it exists.
            /** @type {any[]} */
            const events = [];
            const recording = config?.record ?? 0;
            /** @param {any} event */
            const record = event=>{
                if (recording === 0)
                {
                    return;
                }
                events.push(event);
                if (events.length > recording)
                {
                    events.shift();
                }
            };

            state.parking = createParking({
                kernel,
                // Wired only when recording: the event is built before it is
                // kept or dropped, and building one per call for nobody was an
                // allocation on every crossing.
                onBegin: recording === 0
                    ? undefined
                    : /** @param {any} frame */ frame=>record({
                        t: 'call', name: frame.name, thread: frame.thread?.name,
                        freeStack: frame.freeStack, restingStack: frame.restingStack,
                    }),
            });

            /**
             * @param {string} name
             * @param {number} popBytes
             * @param {object} [options]
             */
            const reserveTrap = (name, popBytes, options)=>
                cpu.registerTrap(name, popBytes, options);

            state.callbacks = createCallbacks({ cpu, kernel, memory, reserveTrap });

            /**
             * A handler that has not finished: the thread is stopped, and told where
             * to pick up its own code once the answer arrives.
             *
             * @param {Promise<number> | import('./internal/drive.js').Driven} answer
             * @param {any} frame
             */
            const suspend = (answer, frame)=>{
                if (isDriven(answer))
                {
                    driveNow(answer, frame);
                    return;
                }
                const thread = kernel.currentThread();
                // Everything wanted of the frame is taken now: it describes this
                // call only until the dispatcher's next one.
                const { name, restingStack, hostReturn } = frame;
                record({ t: 'park', name, thread: thread?.name });
                // Where it returns to was read before the handler ran: a handler
                // that called the guest back has since written over that part of
                // the stack, so reading it now would find an argument.
                kernel.holdThread();
                state.callbacks.suspended(thread, { name, restingStack, hostReturn });
                answer.then(
                    value=>{
                        record({ t: 'finish', name, thread: thread?.name });
                        if (isContinuation(value))
                        {
                            state.callbacks.transfer(thread, value.registers, value.below);
                            return;
                        }
                        if (isReturning(value))
                        {
                            state.callbacks.finish(thread, value.value | 0, value.registers);
                            return;
                        }
                        state.callbacks.finish(thread, value | 0);
                    },
                    // Nothing above is waiting on this promise, so a handler that
                    // throws would otherwise vanish and leave the guest parked
                    // forever. Whoever is driving the machine asks for this.
                    (/** @type {Error} */ error)=>{
                        state.failure ??= error;
                    });
            };

            /**
             * Steps a handler answered with (`drive`), run in the slice its call
             * came in: each guest call it asks for is entered at once, and its
             * return to the sentinel runs the next step at once, until the
             * steps answer and the thread returns from the host call with it.
             * The host call is booked as suspended meanwhile, as a promise's
             * is, so a callback that waits or calls the host again finds it.
             *
             * @param {import('./internal/drive.js').Driven} token
             * @param {any} frame
             */
            const driveNow = (token, frame)=>{
                const thread = kernel.currentThread();
                const { name, restingStack, hostReturn, freeStack } = frame;
                record({ t: 'drive', name, thread: thread?.name });
                state.callbacks.suspended(thread, { name, restingStack, hostReturn });
                /**
                 * @param {import('./internal/drive.js').GuestCall} call
                 * @param {number} [stackAtRest]
                 */
                const enter = (call, stackAtRest)=>state.callbacks.callNow({
                    thread, entry: call.entry, args: call.args ?? [], stackAtRest, by: name,
                    onReturn: step,
                });
                /** @param {number} returned */
                function step(returned){
                    /** @type {IteratorResult<import('./internal/drive.js').GuestCall, any>} */
                    let next;
                    try
                    {
                        next = token.steps.next(returned);
                    }
                    catch (e){
                        // As a promise's rejection: whoever drives the machine is
                        // told, and the thread waits on an answer that never comes.
                        kernel.holdThread();
                        state.failure ??= /** @type {Error} */ (e);
                        return;
                    }
                    if (!next.done)
                    {
                        enter(next.value);
                        return;
                    }
                    const value = next.value;
                    record({ t: 'finish', name, thread: thread?.name });
                    token.onDone?.(isReturning(value) ? value.value : value);
                    if (isContinuation(value) || isReturning(value))
                    {
                        // What else they set is applied where a promise's is: on
                        // the thread's resume.
                        kernel.holdThread();
                        if (isContinuation(value))
                        {
                            state.callbacks.transfer(thread, value.registers, value.below);
                        }
                        else
                        {
                            state.callbacks.finish(thread, value.value | 0, value.registers);
                        }
                        return;
                    }
                    state.callbacks.finishNow(thread, value | 0);
                }
                // The first call from where the call in flight left the stack;
                // the rest from where it rests, as `callGuest` builds them.
                enter(/** @type {import('./internal/drive.js').GuestCall} */ (token.first),
                    freeStack);
            };

            // Reading the thread's last error belongs to win32, which sits above
            // this layer and cannot be reached from it. The assembling caller
            // hands it down instead, the way it hands down the interface
            // publisher: what it buys is a trace that says which call left an
            // error behind, and that is the only cheap way to find out where a
            // code a program later complains about actually came from.
            state.dispatcher = createDispatcher({
                cpu, memory, parking: state.parking, suspend, lastError: config?.lastError,
                lastErrorOffset: config?.lastErrorOffset,
                traceStrings: config?.traceStrings ?? false,
                callPhases: config?.callPhases ?? false,
                onCall: config?.onCall,
                wantsCall: config?.wantsCall,
                // Where the time a host call takes is accounted. Nested inside the
                // guest phase the driver opens, so what is left as the guest's own
                // self time is the emulator executing and this is our code -- which
                // is the only division that answers a question about speed.
                profiler: /** @type {any} */ (host.requireApi('log')),
                // The same journal, for the record of a slot hook's crossings
                // under `call.hook` -- off by default like every call area.
                journal: /** @type {any} */ (host.requireApi('log')),
            });

            /**
             * Whether this instance is still open. A trap that fires after
             * disposal -- the cpu it was registered on outlives it, briefly, while
             * the rest of the machine is torn down -- must not dispatch through a
             * table that answers for nobody.
             */
            const live = ()=>!state.disposed;

            // Claimed here rather than by whoever assembles the process: a trap that
            // reached anything but the bridge would be a call nobody marshalled.
            cpu.onTrap((/** @type {number} */ id)=>{
                if (!live())
                {
                    return;
                }
                if (id === state.callbacks.sentinel())
                {
                    const thread = kernel.currentThread();
                    if (state.callbacks.returnsNow(thread))
                    {
                        // A routine steps sent the thread into: the next step
                        // runs here, and the thread goes on in this slice.
                        record({ t: 'returned', thread: thread?.name });
                        state.callbacks.returned(thread);
                        return;
                    }
                    // A guest callback has returned. Stop the thread before reading
                    // its answer: the sentinel stub is about to `ret` into whatever
                    // the callback left on the stack, which is not code.
                    kernel.holdThread();
                    record({ t: 'returned', thread: kernel.currentThread()?.name });
                    state.callbacks.returned(kernel.currentThread());
                    return;
                }
                state.dispatcher.dispatch(id);
            });

            current = state;
            return {
                Convention,

                /**
                 * Makes a host function callable from guest code.
                 *
                 * @param {string} name        Which import this is, for diagnostics.
                 * @param {Object} fn
                 * @param {string} [fn.convention]
                 * @param {number} fn.argBytes
                 * @param {Function} fn.handler
                 * @param {boolean} [fn.preserveResult]
                 *     For a stub a `ret` lands on rather than a `call`: whatever
                 *     EAX held arrives in ECX, since the trap needs EAX itself.
                 * @param {boolean} [fn.lastError]
                 *     Whether the function can set the thread's last error, which
                 *     the trace reads after each call that can. A COM method
                 *     cannot, and says so.
                 * @returns {number} the guest address that calls it, or 0 once
                 *     this instance is disposed -- there is no guest left to place
                 *     one in.
                 */
                register(
                    name,
                    {
                        convention = Convention.STDCALL, argBytes, handler,
                        preserveResult = false, lastError = true,
                    })
                {
                    if (convention === Convention.FASTCALL)
                    {
                        // Only `hook`'s stub pushes EDX before it traps; a
                        // `register` stub built for FASTCALL would hand a handler
                        // the return address as its second argument instead.
                        throw new Error('bridge: register does not support FASTCALL, use hook');
                    }
                    if (!live())
                    {
                        return 0;
                    }
                    // Before the first import, so the slot a callback returns to is
                    // in the table that gets written into guest memory.
                    state.callbacks.reserve();
                    const { id, address } = cpu.registerTrap(
                        name, calleeCleanup(convention, argBytes), { preserveResult });
                    state.dispatcher.register(id,
                        { name, convention, argBytes, handler, lastError });
                    state.dispatcher.placed(address, name);
                    return address;
                },

                /**
                 * A place to stand between one guest module and another.
                 *
                 * Returns an address to put where the real one was: a call through
                 * it is seen by `handler` with its arguments already marshalled,
                 * and then goes on into the real function as though nothing had
                 * happened. Nothing else in the engine can see a call from one
                 * guest library into another -- there is no stub in the way and no
                 * trap to record -- and those are exactly the calls whose absence
                 * makes a trace stop short of the decision it was taken to explain.
                 *
                 * @param {string} name       What to call it in a trace.
                 * @param {Object} fn
                 * @param {number} fn.argBytes
                 * @param {number} fn.target  The real function, where the call goes on to.
                 * @param {string} [fn.convention]
                 * @param {Function} fn.handler
                 * @returns {number} the guest address to use in place of `target`,
                 *     or 0 once this instance is disposed.
                 */
                watch(name, { argBytes, target, convention = Convention.STDCALL, handler }){
                    if (!live())
                    {
                        return 0;
                    }
                    state.callbacks.reserve();
                    const { id, address } = cpu.registerTrap(
                        name, calleeCleanup(convention, argBytes), { forwardTo: target });
                    state.dispatcher.register(id, {
                        name, convention, argBytes, handler,
                        // So a trace does not report our nothing as the function's
                        // answer. What this call returns is decided by the code it
                        // forwards into, long after the record is written, and a
                        // zero printed there reads as a failure that never happened.
                        forwards: true,
                        saved: cpu.forwardSave,
                    });
                    state.dispatcher.placed(address, name);
                    return address;
                },

                /**
                 * A place to stand in front of a guest call whose slot -- not its
                 * code -- is what redirected it here: a compiled SIMD dispatch
                 * table, for instance, is one vtable slot per kernel, so
                 * overwriting one word of `.rdata` covers every caller with no
                 * code-page write and no displaced-prologue trampoline, and the
                 * guest's own function stays intact for the fallback below.
                 *
                 * `handler` answers `true` when it computed the call itself, or
                 * `false` to run the guest's own function at `target` instead --
                 * decided fresh on every call, which is why neither a `ret` nor a
                 * `jmp` can be part of the stub the way `watch`'s is: this layer
                 * writes EIP itself once the handler has answered.
                 *
                 * @param {string} name
                 * @param {Object} fn
                 * @param {string} [fn.convention]  Only `Convention.FASTCALL` is
                 *     supported today -- `this` in ECX, the first argument in EDX,
                 *     the rest on the stack; the one convention a hooked SIMD
                 *     kernel uses and the one whose live argument the trap
                 *     sequence would otherwise clobber.
                 * @param {number} fn.argBytes
                 * @param {number} fn.target  The guest's own function.
                 * @param {Function} fn.handler
                 * @returns {number} the guest address to write into the slot, or 0
                 *     once this instance is disposed.
                 */
                hook(name, { convention = Convention.FASTCALL, argBytes, target, handler }){
                    if (!live())
                    {
                        return 0;
                    }
                    state.callbacks.reserve();
                    const { id, address } = cpu.registerTrap(
                        name, calleeCleanup(convention, argBytes),
                        { pushEdx: true, holdEip: true });
                    state.dispatcher.register(id, {
                        name, convention, argBytes, handler, hook: true, target,
                        // Only EDX needs saving (see `pushEdx`), so only 4 bytes
                        // separate the trap from the caller's own frame -- not the
                        // 32 `forwardSave` costs, which a hook running on
                        // whatever stack depth the guest's own call reached
                        // cannot spend freely.
                        saved: 4,
                    });
                    state.dispatcher.placed(address, name);
                    return address;
                },

                /**
                 * A place to stand inside a guest function -- a code patch at one
                 * point in it, resuming at another -- rather than in front of a
                 * call to it: for a function a vtable slot or an import never
                 * reaches, one taken by `call rel32` from inside its own module
                 * with a compiler-private register convention, where the part
                 * worth replacing is not the whole function but one loop in the
                 * middle of it.
                 *
                 * `handler(registers, frame)` sees all eight general registers as
                 * a plain object -- `{ eax, ecx, edx, ebx, esp, ebp, esi, edi }`,
                 * exactly as the site's own code held them -- and may edit any of
                 * them. Answering `true` means it computed the site's own work
                 * itself: every register is written back as the object holds it,
                 * ESP becomes `registers.esp + stackAdjust` (so a handler may
                 * move the stack itself) and EIP moves to `resume`. Answering
                 * `false` means "run the displaced instructions instead": every
                 * register is restored to what the site's own call site held,
                 * ESP is untouched and EIP moves to `trampoline` -- the
                 * instructions the patch displaced, ending in a jump back into
                 * the function right after the site, as though it had never been
                 * patched. Neither a `ret` nor a `jmp` is part of the stub, for
                 * the same reason as `hook`'s: the outcome is decided per call.
                 *
                 * @param {string} name
                 * @param {Object} fn
                 * @param {number} fn.trampoline
                 *     Guest address of the displaced instructions plus the jump
                 *     back, built by whoever calls this (the loader's `bindHooks`
                 *     today).
                 * @param {number} fn.resume  Guest address the handled path moves EIP to.
                 * @param {number} [fn.stackAdjust]
                 *     Added to the handler's own `registers.esp` before EIP moves
                 *     to `resume` -- what the instructions between the site and
                 *     the resume point would have popped, had they run.
                 * @param {(registers: { eax: number, ecx: number, edx: number, ebx: number,
                 *     esp: number, ebp: number, esi: number, edi: number }, frame: any) =>
                 *     boolean} fn.handler
                 * @returns {number} the guest address to patch the site to jump
                 *     to, or 0 once this instance is disposed.
                 */
                siteHook(name, { trampoline, resume, stackAdjust = 0, handler }){
                    if (!live())
                    {
                        return 0;
                    }
                    state.callbacks.reserve();
                    // `saveRegisters` and `holdEip` each already existed for a
                    // forwarding stub and a slot hook respectively; a site hook
                    // is the first to need both together -- every register saved,
                    // because the whole point is to read and possibly rewrite all
                    // eight, and no fixed `ret`/`jmp` baked in, because which of
                    // the two exits above this takes is decided only once the
                    // handler has run.
                    const { id, address } = cpu.registerTrap(
                        name, 0, { saveRegisters: true, holdEip: true });
                    state.dispatcher.register(id, {
                        name, handler, site: true, trampoline, resume, stackAdjust,
                        saved: cpu.forwardSave,
                    });
                    state.dispatcher.placed(address, name);
                    return address;
                },

                /**
                 * Counts one of a hook's own comparisons against the guest as
                 * having disagreed -- what an `oracle`-mode kernel calls once it
                 * has checked the guest's output against what it computed itself.
                 * This layer does not know what was compared; it only counts it,
                 * the way it counts everything else at this seam.
                 *
                 * @param {string} name
                 */
                reportHookMismatch(name){
                    if (live())
                    {
                        state.dispatcher.reportMismatch(name);
                    }
                },

                /**
                 * Parks the calling thread and returns the only value a handler may
                 * return in place of an answer.
                 *
                 * @param {any} [thread]
                 */
                park: thread=>live() ? state.parking.park(thread) : undefined,

                /**
                 * Calls a guest routine and resolves with what it returned.
                 *
                 * Only legal while a guest call is in flight: a thread has to be
                 * stopped somewhere known before a frame can be built below it.
                 * A handler that awaits this must return the promise, so the
                 * dispatcher knows there is no answer yet.
                 *
                 * @param {Object} call
                 * @param {number} call.entry
                 * @param {number[]} [call.args]
                 * @param {any} [call.thread]
                 *   Whose stack to build the frame on. Defaults to the thread on
                 *   the processor, which is right only while the host call that is
                 *   doing this has not let go of it. A handler that awaited
                 *   anything -- a file, a range request -- has: the loop kept
                 *   turning and gave other threads their turns, and by the time it
                 *   resumes the thread on the processor is somebody else. A caller
                 *   in that position has to remember whose call it is answering.
                 * @param {number} [call.stackAtRest]
                 *   Where to build the frame instead of at the call in flight's
                 *   free stack. A caller that has put something on the stack
                 *   itself -- an exception record and context, handed to the
                 *   routine it is about to run -- names the stack below that, or
                 *   the routine's own frames grow down over what it was given.
                 * @param {Record<string, number>} [call.registers]
                 *   Registers the routine reads before it sets them -- the frame
                 *   pointer a funclet addresses its parent's locals through.
                 * @returns {Promise<number>} resolves to 0 once this instance is
                 *     disposed -- there is no guest left to call into.
                 */
                callGuest({ entry, args = [], thread, stackAtRest, registers }){
                    if (!live())
                    {
                        return Promise.resolve(0);
                    }
                    const frame = state.parking.current();
                    // Whose call this answers, and never "whoever is running". A
                    // handler still holding the processor is answering the call in
                    // flight, and that call knows its own thread. A handler that
                    // awaited anything has let the processor go -- its call has
                    // ended, the loop has turned, and the thread standing here is
                    // somebody else, whose stack a frame built now would be written
                    // onto. Three separate defects have been exactly that, each
                    // silent where it happened and fatal much later, so a caller in
                    // that position is made to say whose call it is answering
                    // rather than being given a plausible wrong answer.
                    const runOn = thread ?? answeringFor ?? frame?.thread ?? null;
                    if (!runOn)
                    {
                        throw new Error('bridge: a guest callback made after an await must name'
                            + ' the thread whose call it answers');
                    }
                    record({
                        t: 'guest', entry: entry >>> 0, thread: runOn?.name,
                        by: state.parking.chain().at(-1) ?? null, named: thread !== undefined,
                    });
                    return state.callbacks.call({
                        thread: runOn,
                        entry,
                        args,
                        // Which host call is sending the guest off, so a fault in
                        // what it runs has an author.
                        by: state.parking.chain().at(-1) ?? 'somewhere',
                        // Only a call still holding the processor describes this
                        // thread's stack; otherwise the thread's own suspended call
                        // is the record of where it came to rest.
                        stackAtRest: stackAtRest ?? state.parking.freeStackFor(runOn),
                        registers,
                    });
                },

                /**
                 * What a handler returns to call the guest step by step: `steps`
                 * yields `{ entry, args }` for each call and is handed back what
                 * it returned (EAX, signed); what it returns is the call's
                 * answer. The bridge runs them in the slice the call came in
                 * (see `internal/drive.js`); with `driveGuestCalls` off, through
                 * promises, as `callGuest` would -- the second path the gate
                 * compares them with.
                 *
                 * @param {import('./internal/drive.js').Steps} steps
                 */
                drive(steps){
                    return config?.driveGuestCalls === false || !live()
                        ? stepsThroughPromises(steps, call=>this.callGuest(call))
                        : driven(steps);
                },

                /**
                 * What an asynchronous handler resolves with when the call it is
                 * answering does not return: the thread continues at `registers`,
                 * and every host call and guest callback it was inside below the
                 * new stack pointer is abandoned. An exception handler that has
                 * found its catch answers this way; nothing else should.
                 *
                 * @param {Record<string, number>} registers  `eip` and `esp` at least.
                 * @param {{ below?: number }} [options]  Where the abandoned stack
                 *   ends, when that is not the new stack pointer: the catching
                 *   frame's own address, for a catch block that ran below the
                 *   throw and continues on the stack it ran on.
                 */
                continueAt: (registers, options)=>continuation(registers, options?.below),

                /**
                 * What an asynchronous handler resolves with when its call
                 * returns as usual but answers in registers besides EAX: an
                 * exception a handler continued from, whose context the
                 * thread takes back. Writing them when the answer arrives
                 * would write them into whichever thread is on the processor
                 * by then; these are applied when the caller resumes.
                 *
                 * @param {number} value  EAX.
                 * @param {Record<string, number>} registers  The others;
                 *     `eip`, `esp` and `eax` are the call's own and are not
                 *     taken from here.
                 */
                answerWith: (value, registers)=>Object.freeze({
                    [RETURNING]: /** @type {true} */ (true), value, registers: { ...registers },
                }),

                /**
                 * Holds the running thread while a processor exception it took is
                 * offered to its handlers, the way a host call holds it while it
                 * waits: the thread is sent to the park loop from the vector's
                 * stub, and `answer` decides where it goes next -- a continuation,
                 * or a plain value resuming it at `where.hostReturn`.
                 *
                 * Called from inside the trap that reported the fault, with the
                 * thread still on the processor.
                 *
                 * @param {any} thread
                 * @param {{ name: string, restingStack: number, hostReturn: number }} where
                 * @param {Promise<any>} answer
                 */
                holdForFault(thread, where, answer){
                    if (!live())
                    {
                        return;
                    }
                    cpu.writeReg32('eip', cpu.parkAddress());
                    record({ t: 'park', name: where.name, thread: thread?.name });
                    state.callbacks.suspended(thread, where);
                    answer.then(
                        value=>{
                            record({ t: 'finish', name: where.name, thread: thread?.name });
                            if (isContinuation(value))
                            {
                                state.callbacks.transfer(thread, value.registers, value.below);
                                return;
                            }
                            if (isReturning(value))
                            {
                                state.callbacks.finish(thread, value.value | 0, value.registers);
                                return;
                            }
                            state.callbacks.finish(thread, value | 0);
                        },
                        (/** @type {Error} */ error)=>{
                            state.failure ??= error;
                        });
                },

                /**
                 * Puts a COM interface into guest memory and answers with the
                 * pointer a program may walk, call through and compare.
                 *
                 * Wired here rather than by a library, because the addresses in a
                 * vtable are stubs and the calls through them are stdcall -- both
                 * of which are this layer's, and neither of which anything above it
                 * should have to know.
                 *
                 * @param {{ allocate: (bytes: number) => number }} heap
                 * @returns {any} null once this instance is disposed.
                 */
                useHeap(heap){
                    if (!live())
                    {
                        return null;
                    }
                    state.vtables = createVtables({
                        memory,
                        heap,
                        register: (/** @type {string} */ name, /** @type {any} */ fn)=>
                            this.register(name, fn),
                    });
                    return state.vtables;
                },

                /**
                 * @param {any} object
                 * @param {string} interfaceId
                 * @returns {number}
                 */
                publishInterface(object, interfaceId){
                    if (!live())
                    {
                        return 0;
                    }
                    if (!state.vtables)
                    {
                        throw new Error('bridge: no heap to put a COM interface in yet');
                    }
                    return state.vtables.publish(object, interfaceId);
                },

                /**
                 * Gives back an interface the program has no Release for.
                 *
                 * @param {any} object
                 * @param {string} interfaceId
                 * @returns {boolean} whether it was published
                 */
                unpublishInterface(object, interfaceId){
                    return live() && state.vtables
                        ? state.vtables.unpublish(object, interfaceId)
                        : false;
                },

                /**
                 * The object behind an interface pointer this engine published.
                 *
                 * @param {number} pointer
                 * @returns {any}
                 */
                interfaceObject(pointer){
                    return live() && state.vtables ? state.vtables.objectAt(pointer) : null;
                },

                /**
                 * How many host calls are suspended, waiting on something. A driver
                 * loop that sees this above zero has to let the host run, not merely
                 * flush microtasks.
                 */
                suspended: ()=>live() ? state.callbacks.pendingCalls() : 0,

                /**
                 * Settles when the next suspended call answers: what a driver loop
                 * with nothing else to do waits on, so it wakes when the machine
                 * can move rather than on a schedule of its own. Resolves at once
                 * once this instance is disposed -- nothing will ever answer.
                 */
                answered: ()=>live() ? state.callbacks.answered() : Promise.resolve(),

                /**
                 * Whose call is being handled right now.
                 *
                 * Read at the top of a handler that is going to await and then call
                 * guest code: after the await the thread on the processor is
                 * somebody else, and this is the only moment the answer is still
                 * there to take.
                 */
                callerThread: ()=>live()
                    ? (answeringFor ?? state.parking.current()?.thread ?? kernel.currentThread())
                    : null,

                /**
                 * Runs `fn` as the call of `thread` it answers, after an await:
                 * a handler waiting on behalf of a parked thread that goes on to
                 * call other handlers -- a wait that dispatches the thread's
                 * messages -- names the thread once, here, and what those
                 * handlers read as their caller and what they call back into
                 * the guest is that thread's. Only `fn`'s own synchronous run is
                 * covered: whatever it awaits names its thread again.
                 *
                 * @template T
                 * @param {any} thread @param {() => T} fn
                 * @returns {T}
                 */
                answering(thread, fn){
                    const before = answeringFor;
                    answeringFor = thread;
                    try
                    {
                        return fn();
                    }
                    finally
                    {
                        answeringFor = before;
                    }
                },

                /** Where the guest was last sent by us, newest last. */
                recentlyStarted: ()=>live() ? state.callbacks.recentlyStarted() : [],

                /**
                 * The recorded session: every event at this seam, in order.
                 *
                 * Empty unless the build was configured to record. Written out, it
                 * is what `replaySession` takes -- a failure that took a person a
                 * minute of clicking to produce becomes a file that reproduces it
                 * in a test, with no browser and no game.
                 */
                recorded: ()=>live() ? events.slice() : [],

                /**
                 * An error thrown by a suspended handler, which nothing above was
                 * waiting on. Null unless one happened.
                 */
                failure: ()=>live() ? state.failure : null,

                /**
                 * The trap a guest callback returns through. Needed by anything
                 * driving this layer without a processor under it -- a replay of a
                 * recorded session -- which has to raise it by hand.
                 */
                sentinelTrap: ()=>live() ? state.callbacks.sentinel() : null,

                /**
                 * What is on our side of the boundary right now, for a failure
                 * report: which host calls are in flight, what the guest has been
                 * calling, and what name -- if any -- a guest address belongs to.
                 */
                chain: ()=>live()
                    ? [
                        // Suspended first: a call waiting on a callback is the reason
                        // the one running right now is running at all.
                        ...state.callbacks.waiting(kernel.currentThread()),
                        ...state.parking.chain(),
                    ]
                    : [],
                /** @param {number} [count] */
                recent: (count = 12)=>live() ? state.dispatcher.recent(count) : [],
                /** @param {number} address */
                symbolize: address=>live() ? state.dispatcher.symbolize(address) : null,

                /**
                 * Gives a guest address a name for a failure report. A stub already
                 * has one; the trampoline in a synthesised module that jumps to it
                 * is a different address the guest is far more likely to be standing
                 * on, and nothing else knows the two are the same function.
                 *
                 * @param {number} address
                 * @param {string} name
                 */
                label: (address, name)=>{
                    if (live())
                    {
                        state.dispatcher.placed(address, name);
                    }
                },

                /** @param {number} id */
                dispatch: id=>{
                    if (live())
                    {
                        state.dispatcher.dispatch(id);
                    }
                },
                calls: ()=>live() ? state.dispatcher.calls() : [],
            };
        },

        /** @returns {import('../../system/contract.js').ModuleDiagnostics} */
        diagnostics(){
            const instance = current;
            if (!instance || instance.disposed)
            {
                return { name: 'bridge', version: '0.1.0', status: 'created', metrics: {} };
            }
            return {
                name: 'bridge',
                version: '0.1.0',
                status: 'ready',
                metrics: {
                    ...instance.dispatcher.diagnostics(),
                    recentDetailed: instance.dispatcher.detailed(),
                    // The order calls arrived in, not just how many of each.
                    // A program stuck between two functions, or one that took
                    // a branch nobody expected, is legible here and nowhere
                    // else: the histogram below says what it did, this says
                    // what it was doing.
                    sequence: instance.dispatcher.recent(80),
                    // Per-hook, not folded into `hot`: a hook's own share of the
                    // trace is one line among thousands, and whether it is
                    // answering the call or falling through to the guest is
                    // exactly the number a hook's own report reads.
                    hooks: instance.dispatcher.hooks(),
                    ...instance.parking.diagnostics(),
                    ...instance.callbacks.diagnostics(),
                    ...instance.vtables ? instance.vtables.diagnostics() : {},
                    failure: instance.failure ? instance.failure.message : null,
                },
            };
        },

        async dispose(){
            if (current)
            {
                current.disposed = true;
            }
            current = null;
        },
    };
}

/** One graph's worth, for the boundary check and for a test that builds this layer alone. */
export const bridgeModule = createBridgeModule();
