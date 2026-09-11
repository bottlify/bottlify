/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { calleeCleanup, readArguments } from './conventions.js';
import { isParkedCall } from './parking.js';

/**
 * A trap becomes a host call.
 *
 * The guest's side of the channel is a stub that raises a trap and then returns;
 * everything between those two instructions is here. The cpu layer knows that
 * trap id N fired and nothing about what N means -- the table of meanings is
 * this one, because what an import is called and how its arguments are laid out
 * is a contract, not a machine detail.
 */

/**
 * @typedef {Object} HostFunction
 * @property {string} name
 * @property {string} convention
 * @property {number} argBytes
 * @property {Function} handler
 * @property {boolean} [forwards]  The call goes on into guest code afterwards,
 *     so the handler's answer is not the call's answer.
 * @property {number} [saved]  Bytes of registers the stub pushed below the
 *     caller's frame before trapping, to be restored and dropped afterwards:
 *     a forwarding stub keeps the registers the real function will read.
 */

/**
 * @typedef {Object} CallFrame
 * @property {string} name
 * @property {number} freeStack    What is safe to write below now.
 * @property {number} callerStack  ESP as the caller left it: the return address
 *     is here and the stack arguments above it.
 * @property {number} restingStack Where the stack will be once the stub returns.
 * @property {number} hostReturn
 */

/**
 * How many call names the ring keeps. Enough that a failure report shows the
 * shape of what led to it, small enough that it is a rounding error in memory.
 */
const CALL_RING = 4096;

/**
 * How many calls are kept with their arguments and answers.
 *
 * Fewer than the names, because each carries arguments and an answer. Still
 * generous, because the call that explains a failure is routinely hundreds
 * back: a program that has just failed spends its last moments in its own
 * error reporting, and the answer that was wrong came before all of it. Names
 * alone say what a program was doing; these say what it asked and what it was
 * told, which is the only way to see an answer that was wrong rather than
 * missing.
 */
const DETAIL_RING = 4096;

/**
 * @param {Object} deps
 * @param {any} deps.cpu       For the registers a call frame is read from.
 * @param {any} deps.memory    For the stack itself, so a wild ESP is caught here.
 * @param {any} deps.parking   Brackets each handler and issues the parked token.
 * @param {(answer: Promise<number>, frame: any) => void} [deps.suspend]
 *        What to do with a handler that has not finished; wired by the module.
 * @param {() => number} [deps.lastError]
 *        The running thread's last error, for the trace. Injected because it
 *        belongs to a layer above this one.
 * @param {boolean} [deps.traceStrings]
 * @param {{ begin: (name: string, kind?: string) => void,
 *            end: (name?: string) => number }} [deps.profiler]
 *        Where a host call's time is accounted. Optional: this layer is
 *        testable without one, and a phase nobody reads is work nobody asked
 *        for.
 * @param {(record: any) => void} [deps.onCall]
 *        Read the text an argument points at while the call is being made
 *        rather than when the trace is read. Off by default: it costs a scan
 *        of guest memory per pointer argument on every recorded call. On, it
 *        is the only way to see a string a program built on its own stack,
 *        which by the end of a run is somebody else's stack.
 */
export function createDispatcher(deps){
    const { cpu, memory, parking, suspend, lastError } = deps;
    const traceStrings = deps.traceStrings ?? false;
    // A ring holds the end of a run, and the end of a run is rarely where the
    // decision was made: a program that gives up after opening its archives
    // made up its mind thousands of calls earlier. A sink keeps all of it, for
    // whoever is willing to pay for the file.
    const onCall = deps.onCall ?? null;
    /**
     * Where a host call's time is accounted, when the caller wired one.
     *
     * Optional because this layer is testable without one, and because a phase
     * that nobody reads is work nobody asked for.
     */
    const profiler = deps.profiler ?? null;
    /** @type {Map<number, HostFunction>} */
    const functions = new Map();
    /**
     * The names of recent calls, as a ring.
     *
     * Bounded, and that is the whole point of it. This is diagnostics: a
     * failure report wants the last handful of calls, and nothing wants the
     * millionth. Kept as a growing list it is a leak that scales with how well
     * the engine works -- a program that runs for an hour makes hundreds of
     * millions of calls, and the array eventually refuses to grow at all,
     * failing inside the dispatcher with a message about array length that says
     * nothing about the guest.
     *
     * @type {string[]}
     */
    const called = new Array(CALL_RING);
    let ringAt = 0;
    /**
     * @type {{ name: string, from: number, args: number[], result: string,
     *          error: number, strings: (string | null)[] | null }[]}
     */
    const detailed = new Array(DETAIL_RING);
    let detailAt = 0;

    /**
     * The most-called names in the ring, with their counts, commonest first.
     *
     * @param {number} count
     * @returns {[string, number][]}
     */
    const hot = count=>{
        /** @type {Map<string, number>} */
        const counts = new Map();
        for (const name of history(CALL_RING))
        {
            counts.set(name, (counts.get(name) ?? 0) + 1);
        }
        return [...counts].sort((left, right)=>right[1] - left[1]).slice(0, count);
    };

    /**
     * An argument as the text it points at, or null when it is not a pointer
     * to text.
     *
     * A trace of raw dwords says a library was asked for and not which one,
     * and reading each pointer out of an image by hand is not a workflow. So
     * this guesses, and the guess is safe because it happens only when a
     * reader asks: reading is not on the path of a running program, and a
     * value that only looks like a string costs nothing but a wrong line in a
     * report.
     *
     * The pointer is read *now* rather than when the call was made, so what
     * comes back is what is there at the end of a run. For the arguments this
     * matters for -- a library name, a registry path, a file name -- that is
     * the image's own constant data and does not move.
     *
     * @param {number} value
     * @returns {string | null}
     */
    const peekString = value=>{
        const address = value >>> 0;
        if (address < 0x1000)
        {
            return null;
        }
        try
        {
            let text = '';
            for (let at = address; at < address + 96; at++)
            {
                const byte = memory.readU8(at);
                if (byte === 0)
                {
                    return text.length >= 2 ? text : null;
                }
                // Tab, newline and carriage return are text: a message a
                // program is about to show a person is full of them, and
                // rejecting them turns the most interesting string in a trace
                // back into a bare pointer.
                const printable = (byte >= 0x20 && byte <= 0x7e)
                    || byte === 0x09 || byte === 0x0a || byte === 0x0d;
                if (!printable)
                {
                    return null;
                }
                text += String.fromCharCode(byte);
            }
        }
        catch (e){
            void e;
        }
        return null;
    };

    /**
     * The last `count` calls, oldest first.
     *
     * @param {number} count
     * @returns {string[]}
     */
    const history = count=>{
        const kept = Math.min(count, ringAt, CALL_RING);
        /** @type {string[]} */
        const out = [];
        for (let back = kept; back > 0; back--)
        {
            out.push(called[(ringAt - back) % CALL_RING]);
        }
        return out;
    };
    /** Guest address of each stub, so a return address can be given a name. */
    /** @type {Map<number, string>} */
    const byAddress = new Map();
    let calls = 0;

    return {
        /**
         * @param {number} id
         * @param {HostFunction} fn
         */
        register(id, fn){
            if (functions.has(id))
            {
                throw new Error(`bridge: trap ${id} is already implemented by ${fn.name}`);
            }
            functions.set(id, fn);
        },

        /** @param {number} id */
        lookup: id=>functions.get(id) ?? null,

        /**
         * What lives at a guest address, when it is one of our stubs.
         *
         * @param {number} address
         * @returns {string | null}
         */
        symbolize: address=>byAddress.get(address >>> 0) ?? null,

        /**
         * @param {number} address
         * @param {string} name
         */
        placed(address, name){
            byAddress.set(address >>> 0, name);
        },

        /**
         * Handles one trap: marshal, invoke, place the result.
         *
         * @param {number} id
         */
        dispatch(id){
            // Everything a crossing costs that is not the handler itself:
            // reading the frame, marshalling the arguments, the bookkeeping a
            // trace needs, and the return. Opened around the whole of it, so
            // what is left as this phase's own time -- the handler runs inside
            // it and takes its own -- is the price of the boundary.
            //
            // It is the number that decides where speed is lost. A title's menu
            // makes about thirty thousand of these a second while every handler
            // in the report costs a fraction of a millisecond a frame, and
            // until this existed there was no way to tell a machine slowed by
            // its own emulation from one slowed by leaving it so often.
            profiler?.begin('trap', 'host');
            try
            {
                this.dispatchNow(id);
            }
            finally
            {
                profiler?.end('trap');
            }
        },

        /**
         * The crossing itself, with the phase above already open.
         *
         * @param {number} id
         */
        dispatchNow(id){
            const fn = functions.get(id);
            if (!fn)
            {
                throw new Error(`bridge: trap ${id} has no implementation`);
            }

            const pushed = cpu.readReg32('esp');
            const esp = pushed + (fn.saved ?? 0);
            const args = readArguments(fn.convention, fn.argBytes, {
                esp,
                ecx: cpu.readReg32('ecx'),
                read32: (/** @type {number} */ address)=>memory.readU32(address),
            });

            calls++;
            called[ringAt++ % CALL_RING] = fn.name;

            // Everything the handler might need about where it was called from,
            // read before it runs: a handler that calls the guest back writes
            // into the stack, and by then some of this is no longer there to
            // read. `freeStack` is what is safe to write below *now*, while the
            // return address at ESP is still live; `restingStack` is where the
            // stack will be once the stub has returned.
            /** @type {CallFrame} */
            const frame = {
                name: fn.name,
                freeStack: pushed,
                callerStack: esp,
                restingStack: esp + 4 + calleeCleanup(fn.convention, fn.argBytes),
                hostReturn: memory.readU32(esp),
            };

            parking.beginCall(frame);
            let result;
            const record = {
                name: fn.name,
                // Which instruction made this call. Read from the frame that was
                // captured above rather than the stack, because a handler that
                // calls the guest back has overwritten the stack by the time
                // anybody reads this.
                from: frame.hostReturn,
                // Copied, because a handler that writes through a pointer can
                // change what the arguments describe before anyone reads them.
                args: args.slice(0, 6),
                // Read now rather than later when asked for: a string a program
                // assembled on its own stack has been overwritten several
                // frames deep by the time anybody reads the trace, and what
                // comes back then belongs to whatever ran next.
                strings: traceStrings ? args.slice(0, 6).map(peekString) : null,
                result: 'threw',
                error: 0,
            };
            detailed[detailAt++ % DETAIL_RING] = record;
            profiler?.begin(fn.name, 'host');
            try
            {
                result = fn.handler(args, frame);
                // A promise is neither a value nor the parked token: it is a
                // call that has not finished, and the thread is about to be
                // parked on it. Rendering it as a number turns every such call
                // into a plain zero -- a failure under most conventions -- and
                // a reader then chases a failure that did not happen.
                record.result = fn.forwards
                    ? 'forwarded'
                    : isParkedCall(result)
                        ? 'parked'
                        : (typeof (/** @type {any} */ (result))?.then === 'function'
                            ? 'waiting'
                            : `0x${(Number(result) >>> 0).toString(16)}`);
            }
            finally
            {
                profiler?.end(fn.name);
                parking.endCall();
                // What this call left in the thread's last error. A program
                // reports a code long after whatever produced it returned, and
                // this is the only record that ties the two together.
                record.error = lastError ? lastError() : 0;
                if (onCall)
                {
                    // As recorded, strings included only when tracing asked
                    // for them. Peeking every argument for a sink that does
                    // not read the strings cost more than the whole dispatch:
                    // measured at 1.6 of 2.3 microseconds per call.
                    onCall(record);
                }
            }

            // A parked call's EAX belongs to whatever wakes the thread, and it
            // carries the wait's own result. Writing a placeholder here would
            // overwrite the answer before the guest ever sees it.
            if (isParkedCall(result))
            {
                return;
            }
            if (typeof result?.then === 'function')
            {
                if (!suspend)
                {
                    throw new Error(
                        `bridge: ${fn.name} answered asynchronously with nowhere to wait`);
                }
                // The trace says "waiting" and nothing after it, which for a
                // read of a game's own archive is the whole question: whether
                // it eventually delivered, and how much. Recorded when the
                // answer arrives, as a line of its own -- the first line is
                // already written and in order, and moving it would put the
                // call somewhere it did not happen.
                if (onCall)
                {
                    const asked = record;
                    result.then((/** @type {number} */ value)=>onCall({
                        ...asked,
                        result: `0x${(value >>> 0).toString(16)} (was waiting)`,
                    }));
                }
                suspend(result, frame);
                return;
            }
            if (fn.saved)
            {
                // The stub saved with `pushad`, EAX first and EDI last; the
                // trap spent EAX and DX and nothing else. Put those two back
                // and drop the block, so the function it forwards into sees
                // the registers exactly as its caller set them.
                cpu.writeReg32('eax', memory.readU32(pushed + 28));
                cpu.writeReg32('edx', memory.readU32(pushed + 20));
                cpu.writeReg32('esp', esp);
                return;
            }
            cpu.writeReg32('eax', result >>> 0);
        },

        diagnostics: ()=>({
            implemented: functions.size,
            calls,
            lastCall: ringAt === 0 ? null : called[(ringAt - 1) % CALL_RING],
            // What the guest has been doing, rather than the one thing it did
            // last. A program stuck in a loop says so here in a line; a stack
            // trace only shows where the loop was when it was interrupted.
            hot: hot(40),
        }),

        /**
         * The last few calls with what was asked and what was answered, oldest
         * first. Read backwards from a failure, this is where an answer that
         * was wrong rather than missing shows itself.
         *
         * @param {number} [count]
         */
        detailed(count = DETAIL_RING){
            const kept = Math.min(count, detailAt, DETAIL_RING);
            /** @type {any[]} */
            const out = [];
            for (let back = kept; back > 0; back--)
            {
                const record = detailed[(detailAt - back) % DETAIL_RING];
                out.push(record.strings
                    ? record
                    : { ...record, strings: record.args.map(peekString) });
            }
            return out;
        },

        /**
         * The calls the guest has made, oldest first -- as many as the ring
         * still holds, which is every one of them until it wraps.
         */
        calls: ()=>history(ringAt),

        /** @param {number} count @returns {string[]} the last few, oldest first */
        recent: count=>history(Math.min(count, CALL_RING)),
    };
}
