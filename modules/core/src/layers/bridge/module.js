/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { Convention, calleeCleanup } from './internal/conventions.js';
import { createParking } from './internal/parking.js';
import { createDispatcher } from './internal/dispatch.js';
import { createCallbacks } from './internal/callback.js';
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

/** @type {any} */
let dispatcher = null;
/** @type {any} */
let parking = null;
/** @type {any} */
let callbacks = null;
/** @type {any} */
let vtables = null;
/** @type {Error | null} */
let failure = null;

export const bridgeModule = {
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

        failure = null;

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

        parking = createParking({
            kernel,
            /** @param {any} frame */
            onBegin: frame=>record({
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

        callbacks = createCallbacks({ cpu, kernel, memory, reserveTrap });

        /**
         * A handler that has not finished: the thread is stopped, and told where
         * to pick up its own code once the answer arrives.
         *
         * @param {Promise<number>} answer
         * @param {any} frame
         */
        const suspend = (answer, frame)=>{
            const thread = kernel.currentThread();
            record({ t: 'park', name: frame.name, thread: thread?.name });
            // Where it returns to was read before the handler ran: a handler
            // that called the guest back has since written over that part of
            // the stack, so reading it now would find an argument.
            kernel.holdThread();
            callbacks.suspended(thread, {
                name: frame.name,
                restingStack: frame.restingStack,
                hostReturn: frame.hostReturn,
            });
            answer.then(
                value=>{
                    record({ t: 'finish', name: frame.name, thread: thread?.name });
                    callbacks.finish(thread, value | 0);
                },
                // Nothing above is waiting on this promise, so a handler that
                // throws would otherwise vanish and leave the guest parked
                // forever. Whoever is driving the machine asks for this.
                (/** @type {Error} */ error)=>{
                    failure ??= error;
                });
        };

        // Reading the thread's last error belongs to win32, which sits above
        // this layer and cannot be reached from it. The assembling caller
        // hands it down instead, the way it hands down the interface
        // publisher: what it buys is a trace that says which call left an
        // error behind, and that is the only cheap way to find out where a
        // code a program later complains about actually came from.
        dispatcher = createDispatcher({
            cpu, memory, parking, suspend, lastError: config?.lastError,
            traceStrings: config?.traceStrings ?? false,
            callPhases: config?.callPhases ?? false,
            onCall: config?.onCall,
            // Where the time a host call takes is accounted. Nested inside the
            // guest phase the driver opens, so what is left as the guest's own
            // self time is the emulator executing and this is our code -- which
            // is the only division that answers a question about speed.
            profiler: /** @type {any} */ (host.requireApi('log')),
        });

        // Claimed here rather than by whoever assembles the process: a trap that
        // reached anything but the bridge would be a call nobody marshalled.
        cpu.onTrap((/** @type {number} */ id)=>{
            if (id === callbacks.sentinel())
            {
                // A guest callback has returned. Stop the thread before reading
                // its answer: the sentinel stub is about to `ret` into whatever
                // the callback left on the stack, which is not code.
                kernel.holdThread();
                record({ t: 'returned', thread: kernel.currentThread()?.name });
                callbacks.returned(kernel.currentThread());
                return;
            }
            dispatcher.dispatch(id);
        });

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
             * @returns {number} the guest address that calls it
             */
            register(
                name,
                { convention = Convention.STDCALL, argBytes, handler, preserveResult = false })
            {
                // Before the first import, so the slot a callback returns to is
                // in the table that gets written into guest memory.
                callbacks.reserve();
                const { id, address } = cpu.registerTrap(
                    name, calleeCleanup(convention, argBytes), { preserveResult });
                dispatcher.register(id, { name, convention, argBytes, handler });
                dispatcher.placed(address, name);
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
             * @returns {number} the guest address to use in place of `target`
             */
            watch(name, { argBytes, target, convention = Convention.STDCALL, handler }){
                callbacks.reserve();
                const { id, address } = cpu.registerTrap(
                    name, calleeCleanup(convention, argBytes), { forwardTo: target });
                dispatcher.register(id, {
                    name, convention, argBytes, handler,
                    // So a trace does not report our nothing as the function's
                    // answer. What this call returns is decided by the code it
                    // forwards into, long after the record is written, and a
                    // zero printed there reads as a failure that never happened.
                    forwards: true,
                    saved: cpu.forwardSave,
                });
                dispatcher.placed(address, name);
                return address;
            },

            /**
             * Parks the calling thread and returns the only value a handler may
             * return in place of an answer.
             *
             * @param {any} [thread]
             */
            park: thread=>parking.park(thread),

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
             * @returns {Promise<number>}
             */
            callGuest({ entry, args = [], thread }){
                const frame = parking.current();
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
                const runOn = thread ?? frame?.thread ?? null;
                if (!runOn)
                {
                    throw new Error('bridge: a guest callback made after an await must name'
                        + ' the thread whose call it answers');
                }
                record({
                    t: 'guest', entry: entry >>> 0, thread: runOn?.name,
                    by: parking.chain().at(-1) ?? null, named: thread !== undefined,
                });
                return callbacks.call({
                    thread: runOn,
                    entry,
                    args,
                    // Which host call is sending the guest off, so a fault in
                    // what it runs has an author.
                    by: parking.chain().at(-1) ?? 'somewhere',
                    // Only a call still holding the processor describes this
                    // thread's stack; otherwise the thread's own suspended call
                    // is the record of where it came to rest.
                    stackAtRest: parking.freeStackFor(runOn),
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
             */
            useHeap(heap){
                vtables = createVtables({
                    memory,
                    heap,
                    register: (/** @type {string} */ name, /** @type {any} */ fn)=>
                        this.register(name, fn),
                });
                return vtables;
            },

            /**
             * @param {any} object
             * @param {string} interfaceId
             * @returns {number}
             */
            publishInterface(object, interfaceId){
                if (!vtables)
                {
                    throw new Error('bridge: no heap to put a COM interface in yet');
                }
                return vtables.publish(object, interfaceId);
            },

            /**
             * How many host calls are suspended, waiting on something. A driver
             * loop that sees this above zero has to let the host run, not merely
             * flush microtasks.
             */
            suspended: ()=>callbacks.pendingCalls(),

            /**
             * Whose call is being handled right now.
             *
             * Read at the top of a handler that is going to await and then call
             * guest code: after the await the thread on the processor is
             * somebody else, and this is the only moment the answer is still
             * there to take.
             */
            callerThread: ()=>parking.current()?.thread ?? kernel.currentThread(),

            /** Where the guest was last sent by us, newest last. */
            recentlyStarted: ()=>callbacks.recentlyStarted(),

            /**
             * The recorded session: every event at this seam, in order.
             *
             * Empty unless the build was configured to record. Written out, it
             * is what `replaySession` takes -- a failure that took a person a
             * minute of clicking to produce becomes a file that reproduces it
             * in a test, with no browser and no game.
             */
            recorded: ()=>events.slice(),

            /**
             * An error thrown by a suspended handler, which nothing above was
             * waiting on. Null unless one happened.
             */
            failure: ()=>failure,

            /**
             * The trap a guest callback returns through. Needed by anything
             * driving this layer without a processor under it -- a replay of a
             * recorded session -- which has to raise it by hand.
             */
            sentinelTrap: ()=>callbacks.sentinel(),

            /**
             * What is on our side of the boundary right now, for a failure
             * report: which host calls are in flight, what the guest has been
             * calling, and what name -- if any -- a guest address belongs to.
             */
            chain: ()=>[
                // Suspended first: a call waiting on a callback is the reason
                // the one running right now is running at all.
                ...callbacks.waiting(kernel.currentThread()),
                ...parking.chain(),
            ],
            /** @param {number} [count] */
            recent: (count = 12)=>dispatcher.recent(count),
            /** @param {number} address */
            symbolize: address=>dispatcher.symbolize(address),

            /**
             * Gives a guest address a name for a failure report. A stub already
             * has one; the trampoline in a synthesised module that jumps to it
             * is a different address the guest is far more likely to be standing
             * on, and nothing else knows the two are the same function.
             *
             * @param {number} address
             * @param {string} name
             */
            label: (address, name)=>dispatcher.placed(address, name),

            /** @param {number} id */
            dispatch: id=>dispatcher.dispatch(id),
            calls: ()=>dispatcher.calls(),
        };
    },

    /** @returns {import('../../system/contract.js').ModuleDiagnostics} */
    diagnostics(){
        return {
            name: 'bridge',
            version: '0.1.0',
            status: dispatcher ? 'ready' : 'created',
            metrics: dispatcher
                ? {
                    ...dispatcher.diagnostics(),
                    recentDetailed: dispatcher.detailed(),
                    // The order calls arrived in, not just how many of each.
                    // A program stuck between two functions, or one that took
                    // a branch nobody expected, is legible here and nowhere
                    // else: the histogram below says what it did, this says
                    // what it was doing.
                    sequence: dispatcher.recent(80),
                    ...parking.diagnostics(),
                    ...callbacks.diagnostics(),
                    ...vtables ? vtables.diagnostics() : {},
                    failure: failure ? failure.message : null,
                }
                : {},
        };
    },

    async dispose(){
        dispatcher = null;
        parking = null;
        callbacks = null;
        vtables = null;
        failure = null;
    },
};
