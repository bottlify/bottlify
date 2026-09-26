/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { calleeCleanup, registerArgumentCount } from './conventions.js';
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
 * @property {string} [convention]  Unused, and may be omitted, by a `site` entry.
 * @property {number} [argBytes]    Unused, and may be omitted, by a `site` entry.
 * @property {Function} handler
 * @property {boolean} [forwards]  The call goes on into guest code afterwards,
 *     so the handler's answer is not the call's answer.
 * @property {number} [saved]  Bytes of registers the stub pushed below the
 *     caller's frame before trapping, to be restored and dropped afterwards:
 *     a forwarding stub keeps the registers the real function will read.
 * @property {boolean} [lastError]  Whether the function can leave a thread
 *     error behind, so the trace reads it afterwards. Default true; a COM
 *     method answers with an HRESULT and never touches it.
 * @property {boolean} [hook]
 *     A slot hook: `handler` answers `true` (it computed the call itself) or
 *     `false` (run the guest's own code, at `target`). Which of the two
 *     happens is decided per call, so neither a `ret` nor a `jmp` can be
 *     baked into the stub -- see `holdEip` in `cpu`'s thunks.
 * @property {number} [target]  Where a hook's call goes when not handled.
 * @property {boolean} [site]
 *     A site hook: a code patch inside a function rather than a slot in
 *     front of one. `handler(registers, frame)` sees all eight general
 *     registers as a plain object and may edit any of them; answering `true`
 *     moves EIP to `resume` (ESP becomes `registers.esp + stackAdjust`, so
 *     the handler may move the stack itself), `false` restores every
 *     register to what the site's own call site held and moves EIP to
 *     `trampoline` -- the displaced instructions, running as though the site
 *     had never been patched.
 * @property {number} [trampoline]  Where a site hook's fallthrough resumes.
 * @property {number} [resume]      Where a site hook's handled path resumes.
 * @property {number} [stackAdjust]
 *     Added to the handler's own `registers.esp` before EIP moves to
 *     `resume` -- what the instructions between the site and the resume
 *     point would have popped, had they run.
 */

/**
 * The eight general registers a site hook's handler sees and may edit.
 *
 * @typedef {{ eax: number, ecx: number, edx: number, ebx: number, esp: number,
 *     ebp: number, esi: number, edi: number }} SiteRegisters
 */

/**
 * A registered function with everything the crossing needs worked out once:
 * what the convention means in words and bytes, and the array a call fills.
 *
 * @typedef {Object} Entry
 * @property {HostFunction} fn
 * @property {string} name
 * @property {Function} handler
 * @property {number} registerArgs
 *     How many logical arguments arrive in registers ahead of the stack: 0,
 *     1 (`this`, thiscall) or 2 (`this` and one more, fastcall).
 * @property {number} stackWords
 * @property {number} cleanup       What the stub's `ret` pops.
 * @property {number} saved
 * @property {boolean} forwards
 * @property {boolean} hook
 * @property {number} target
 * @property {boolean} site
 * @property {number} trampoline
 * @property {number} resume
 * @property {number} stackAdjust
 * @property {SiteRegisters | null} registers
 *     A site hook's mutable register view, reused like `args`; null otherwise.
 * @property {{ calls: number, handled: number, fellThrough: number,
 *     mismatches: number, ms: number } | null} hookStats
 * @property {boolean} readsError
 * @property {number[]} args        The argument array, reused while answers are prompt.
 * @property {number} writer
 *     Where the memory layer charges what this call writes into the guest,
 *     resolved here once so the crossing stores a number and looks nothing up.
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

/** How far a pointer argument is read for the text it may point at. */
const PEEK_LIMIT = 96;

/**
 * The clock a hook's own `ms` is measured against.
 *
 * `performance.now` where there is one, the same choice the phase profiler
 * makes for the same reason (`layers/log/module.js`'s `createProfiler`
 * clock): `Date.now` moves in whole milliseconds, which reads as a column of
 * zeroes for a kernel that costs a few microseconds a call. `Date.now` only
 * where `performance` is not a global -- true of every environment this runs
 * in today, so this is a guard rather than a live fallback.
 */
const hookClock = import.meta.BOTTLIFY_DIAGNOSTICS !== false && typeof performance !== 'undefined'
    ? ()=>performance.now() : Date.now;

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
 * @param {boolean} [deps.callPhases]  Time each call as a phase of its own.
 * @param {{ begin: (name: string, kind?: string) => void,
 *            end: (name?: string, detail?: { weight?: number }) => number }} [deps.profiler]
 *        Where a host call's time is accounted. Optional: this layer is
 *        testable without one, and a phase nobody reads is work nobody asked
 *        for.
 * @param {(record: any) => void} [deps.onCall]
 *        Read the text an argument points at while the call is being made
 *        rather than when the trace is read. Off by default: it costs a scan
 *        of guest memory per pointer argument on every recorded call. On, it
 *        is the only way to see a string a program built on its own stack,
 *        which by the end of a run is somebody else's stack.
 * @param {{ enabled: (category: string, level: number) => boolean,
 *            write: (level: number, category: string, message: string,
 *                a?: any, b?: any, c?: any, d?: any) => void,
 *            Level: { TRACE: number } }} [deps.journal]
 *        Where a slot hook's crossings are written when `call.hook` is on:
 *        the frame as the guest's own call site left it, and where the
 *        call was sent afterwards. A hook stands in front of a call the
 *        engine did not marshal by declaration but by a sidecar's word, and
 *        this record is the only account of whether that word held.
 */
export function createDispatcher(deps){
    const { cpu, memory, parking, suspend } = deps;

    /**
     * Reads a call's stack words one at a time up to the end of the region
     * they start in, and zeroes the rest. Only reached when the span runs past
     * that region; a read that fails for any other reason fails as it did.
     *
     * @param {number} from @param {number} count @param {number[]} into
     * @param {number} at @param {unknown} failure
     */
    const readWithinStack = (from, count, into, at, failure)=>{
        const region = memory.find?.(from);
        if (!region)
        {
            throw failure;
        }
        const end = region.base + region.size;
        for (let word = 0; word < count; word++)
        {
            const address = from + word * 4;
            into[at + word] = address + 4 <= end ? memory.readU32(address) | 0 : 0;
        }
    };

    const journal = deps.journal ?? null;
    const HOOK_AREA = 'call.hook';
    /**
     * Whose writes into guest memory these are.
     *
     * Bytes written by the host are one number for the whole run unless
     * somebody says which call was in flight, and this is the only place that
     * knows. A slot in, the previous slot out, restored on the way back: a
     * handler that calls the guest back into another host call nests without a
     * stack of its own, and a write made with nothing in flight keeps the
     * name the account gives it rather than the last call's.
     */
    const charging = typeof memory?.charging === 'function'
        ? /** @type {(slot: number) => number} */ (memory.charging)
        : null;
    const lastError = deps.lastError ?? (()=>0);
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
    // Whether each call is timed as a phase of its own, under the crossing's.
    // That is what a report's cost per API comes from, and it costs two clock
    // readings per call -- measured at three percent of a frame in a match,
    // where a frame makes fifteen hundred calls. Off unless a measurement
    // asks; the crossing is sampled whenever there is a profiler, so the
    // host's share is known -- and a production bundle, which has none, times
    // nothing.
    const callPhases = deps.callPhases ?? false;
    const phased = import.meta.BOTTLIFY_DIAGNOSTICS !== false && profiler !== null && callPhases;
    // The crossing is timed one call in this many, each standing for all of
    // them: two clock readings a call were a measured share of a frame in a
    // match, and a share is as true of a sample as of the whole -- of a random
    // sample. Every eighth call of a program that draws in a fixed sequence of
    // calls is the same few calls of that sequence every time, and the estimate
    // was those calls' cost eight times over: more host time than the frame had,
    // and a guest phase whose own time came out below nothing. Which call is
    // timed is drawn from a xorshift instead, one in eight on average.
    const TRAP_SAMPLE = 8;
    let sampler = 0x9e3779b9;
    // Indexed by trap id: the cpu hands them out in sequence from zero.
    /** @type {(Entry | undefined)[]} */
    const functions = [];
    let implemented = 0;
    /**
     * Frames by depth of nesting, reused: a guest callback can trap into
     * another host call, so there is one per level rather than one.
     *
     * @type {(CallFrame | undefined)[]}
     */
    const frames = [];
    let depth = 0;
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
     * @typedef {Object} CallRecord
     * @property {string} name
     * @property {number} from
     * @property {number[]} args
     * @property {(string | null)[] | null} strings
     * @property {number} error
     * @property {number} answer   What the handler returned, when it returned a number.
     * @property {string} kind     How the call ended: 'answered', 'parked', 'waiting',
     *     'forwarded' or 'threw'.
     * @property {string} result   The answer as a reader wants it, made when read.
     */

    /** @type {CallRecord[]} */
    const detailed = new Array(DETAIL_RING);
    let detailAt = 0;

    /**
     * @param {CallRecord} record
     * @returns {string}
     */
    const describe = record=>record.kind === 'answered'
        ? `0x${(record.answer >>> 0).toString(16)}`
        : record.kind;
    /** A record's `result`, made from its answer when read. */
    const RESULT = {
        /** @this {CallRecord} */
        get(){
            return describe(this);
        },
        enumerable: true,
        configurable: true,
    };

    /**
     * A ring record. The text of the answer is the one thing about a call that
     * costs an allocation to write down, and almost nobody reads it: so it is
     * made from the number when it is read, not when the call is made.
     *
     * The getter is defined onto the record after its fields rather than
     * written in the literal: a getter in an object literal puts the object in
     * V8's dictionary mode, and every call writes seven of a record's fields
     * -- each a hash lookup there. Defined, it stays an own enumerable
     * property, so a sink's `{ ...record }` still carries it.
     *
     * @returns {CallRecord}
     */
    const makeRecord = ()=>{
        const record = {
            name: '',
            from: 0,
            /** @type {number[]} */
            args: [],
            /** @type {(string | null)[] | null} */
            strings: null,
            error: 0,
            answer: 0,
            kind: 'threw',
        };
        return /** @type {CallRecord} */ (Object.defineProperty(record, 'result', RESULT));
    };

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
        // Asked of the region map rather than read and caught: most values
        // above the floor are enumerated constants and handles, which point
        // at nothing, and a read that throws carries a formatted message and
        // a stack -- measured at ten microseconds an argument, which with
        // tracing on was the whole cost of a call several times over.
        const region = memory.find(address);
        if (region === undefined || region.access === 'none')
        {
            return null;
        }
        const span = Math.min(PEEK_LIMIT, region.base + region.size - address);
        const bytes = memory.window(address, span);
        let text = '';
        for (let at = 0; at < span; at++)
        {
            const byte = bytes[at];
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
        return null;
    };

    /**
     * A record as a reader may keep it: the ring writes over its own when it
     * comes round.
     *
     * @param {CallRecord} record
     */
    const copyOf = record=>({
        name: record.name,
        from: record.from,
        args: record.args.slice(),
        strings: record.strings ? record.strings.slice() : null,
        kind: record.kind,
        result: describe(record),
        error: record.error,
    });

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
    /** A hook's name to its trap id, for `reportMismatch`. */
    /** @type {Map<string, number>} */
    const hooksByName = new Map();

    return {
        /**
         * @param {number} id
         * @param {HostFunction} fn
         */
        register(id, fn){
            if (functions[id] !== undefined)
            {
                throw new Error(`bridge: trap ${id} is already implemented by ${fn.name}`);
            }
            const site = fn.site === true;
            // A site hook marshals nothing through a convention: its eight
            // registers come straight off the pushad block, not off a
            // calling convention nobody chose -- the call was never a call.
            // `convention`/`argBytes` are optional only for a `site` entry;
            // every other caller still provides them, checked at `register`'s
            // own call sites (`bridge/module.js`).
            const convention = /** @type {string} */ (fn.convention);
            const argBytes = /** @type {number} */ (fn.argBytes);
            const registerArgs = site ? 0 : registerArgumentCount(convention);
            // Validates the convention and the byte count here, once, rather
            // than on every call.
            const cleanup = site ? 0 : calleeCleanup(convention, argBytes);
            const stackWords = site ? 0 : (argBytes - registerArgs * 4) >>> 2;
            // A site hook shares a slot hook's counters and journal record --
            // both are "a guest call this engine decided by a sidecar word,
            // rather than by declaration" -- so it is a `hook` for every
            // purpose downstream except how its registers are marshalled.
            const hook = fn.hook === true || site;
            functions[id] = {
                fn,
                name: fn.name,
                handler: fn.handler,
                registerArgs,
                stackWords,
                cleanup,
                saved: fn.saved ?? 0,
                forwards: fn.forwards === true,
                hook,
                target: fn.target ?? 0,
                site,
                trampoline: fn.trampoline ?? 0,
                resume: fn.resume ?? 0,
                stackAdjust: fn.stackAdjust ?? 0,
                registers: site
                    ? { eax: 0, ecx: 0, edx: 0, ebx: 0, esp: 0, ebp: 0, esi: 0, edi: 0 }
                    : null,
                hookStats: hook
                    ? { calls: 0, handled: 0, fellThrough: 0, mismatches: 0, ms: 0 } : null,
                readsError: deps.lastError !== undefined && fn.lastError !== false,
                args: new Array(site ? 8 : stackWords + registerArgs),
                writer: typeof memory?.writer === 'function' ? memory.writer(fn.name) : -1,
            };
            if (hook)
            {
                hooksByName.set(fn.name, id);
            }
            implemented++;
        },

        /** @param {number} id */
        lookup: id=>functions[id]?.fn ?? null,

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
            // A production bundle times no crossing at all.
            if (import.meta.BOTTLIFY_DIAGNOSTICS === false || profiler === null)
            {
                this.dispatchNow(id);
                return;
            }
            sampler ^= sampler << 13;
            sampler ^= sampler >>> 17;
            sampler ^= sampler << 5;
            if ((sampler & (TRAP_SAMPLE - 1)) !== 0)
            {
                this.dispatchNow(id);
                return;
            }
            profiler.begin('trap', 'host');
            try
            {
                this.dispatchNow(id);
            }
            finally
            {
                profiler.end('trap', { weight: TRAP_SAMPLE });
            }
        },

        /**
         * The crossing itself, with the phase above already open.
         *
         * @param {number} id
         */
        dispatchNow(id){
            const entry = functions[id];
            if (entry === undefined)
            {
                throw new Error(`bridge: trap ${id} has no implementation`);
            }

            const pushed = cpu.readReg32('esp');
            const esp = pushed + entry.saved;
            // Straight off the stack into the entry's own array, which the
            // handler reads and this layer writes over on the next call. A
            // handler that answers later than it returns -- a promise, a
            // parked thread -- keeps the array: see below.
            const args = entry.args;
            if (entry.site)
            {
                // The stub's own `pushad` before it trapped: pushed lowest to
                // highest is edi, esi, ebp, the original esp, ebx, edx, ecx,
                // eax -- so eax is the last one pushed, at `pushed + 28`.
                // Read into `args` in declaration order rather than straight
                // into `entry.registers` so a fallthrough can restore exactly
                // what the site's own call site held even if the handler
                // edited the mutable object it was given.
                args[0] = memory.readU32(pushed + 28) | 0; // eax
                args[1] = memory.readU32(pushed + 24) | 0; // ecx
                args[2] = memory.readU32(pushed + 20) | 0; // edx
                args[3] = memory.readU32(pushed + 16) | 0; // ebx
                args[4] = esp | 0;                          // esp: the site's own
                args[5] = memory.readU32(pushed + 8) | 0;  // ebp
                args[6] = memory.readU32(pushed + 4) | 0;  // esi
                args[7] = memory.readU32(pushed + 0) | 0;  // edi
                // Non-null: `entry.registers` is only null for a non-site
                // entry, and this branch runs only when `entry.site` is true.
                const r = /** @type {NonNullable<Entry['registers']>} */ (entry.registers);
                r.eax = args[0];
                r.ecx = args[1];
                r.edx = args[2];
                r.ebx = args[3];
                r.esp = args[4];
                r.ebp = args[5];
                r.esi = args[6];
                r.edi = args[7];
            }
            else
            {
                let at = 0;
                if (entry.registerArgs >= 1)
                {
                    // Live: nothing in the trap sequence touches ECX.
                    args[at++] = cpu.readReg32('ecx') | 0;
                }
                if (entry.registerArgs >= 2)
                {
                    // Fastcall's EDX is not live by this point: `mov dx, port`
                    // spends the low half of the very register the argument is
                    // in, so the stub pushed it first and this reads it from
                    // there -- the one word between `pushed` and the caller's
                    // own frame at `esp`.
                    args[at++] = memory.readU32(pushed) | 0;
                }
                if (entry.stackWords > 0)
                {
                    // One call for the whole span rather than a read per word:
                    // each of those cost its own region check and cache lookup,
                    // and a call takes several words at once. The memory layer
                    // validates the span once and falls back to per-word reads
                    // itself when a stack straddles two adjacent regions (legal
                    // layout, if rare).
                    try
                    {
                        memory.readU32sInto(esp + 4, entry.stackWords, args, at);
                    }
                    catch (e){
                        // A variadic entry reads a fixed number of slots, and a
                        // call made near the top of its thread's stack has
                        // fewer words above it than that: past the stack is
                        // nothing the caller passed, so it reads as zero rather
                        // than stopping the machine.
                        readWithinStack(esp + 4, entry.stackWords, args, at, e);
                    }
                }
            }

            calls++;
            called[ringAt++ % CALL_RING] = entry.name;

            // Everything the handler might need about where it was called from,
            // read before it runs: a handler that calls the guest back writes
            // into the stack, and by then some of this is no longer there to
            // read. `freeStack` is what is safe to write below *now*, while the
            // return address at ESP is still live; `restingStack` is where the
            // stack will be once the stub has returned.
            const frame = frames[depth] ??= {
                name: '', freeStack: 0, callerStack: 0, restingStack: 0, hostReturn: 0,
            };
            frame.name = entry.name;
            frame.freeStack = pushed;
            frame.callerStack = esp;
            frame.restingStack = esp + 4 + entry.cleanup;
            frame.hostReturn = memory.readU32(esp);

            // The ring's records are made once and written over: a record and
            // an argument array allocated per call, thirty thousand times a
            // second, was the garbage collector's whole share of a frame.
            // Whoever reads the ring gets a copy; a sink gets the record for
            // the length of its call and nothing longer.
            const slot = detailAt++ % DETAIL_RING;
            const record = detailed[slot] ??= makeRecord();
            record.name = entry.name;
            // Which instruction made this call. Read from the frame that was
            // captured above rather than the stack, because a handler that
            // calls the guest back has overwritten the stack by the time
            // anybody reads this.
            record.from = frame.hostReturn;
            // Copied, because a handler that writes through a pointer can
            // change what the arguments describe before anyone reads them.
            const kept = Math.min(args.length, 6);
            // A fresh array only when the length differs: setting `length` is
            // a trip into the runtime every time, a fifth of the crossing.
            if (record.args.length !== kept)
            {
                record.args = new Array(kept);
            }
            for (let i = 0; i < kept; i++)
            {
                record.args[i] = args[i];
            }
            // Read now rather than later when asked for: a string a program
            // assembled on its own stack has been overwritten several
            // frames deep by the time anybody reads the trace, and what
            // comes back then belongs to whatever ran next.
            if (traceStrings)
            {
                const strings = record.strings ??= [];
                strings.length = kept;
                for (let i = 0; i < kept; i++)
                {
                    strings[i] = peekString(args[i]);
                }
            }
            else
            {
                record.strings = null;
            }
            record.kind = 'threw';
            record.error = 0;

            // Written before the handler runs, so a handler that never comes
            // back still leaves the frame it was handed on the record.
            const hookTraced = entry.hook && journal !== null
                && journal.enabled(HOOK_AREA, journal.Level.TRACE);
            if (hookTraced)
            {
                journal.write(journal.Level.TRACE, HOOK_AREA,
                    '{0} entry esp={1} ret={2} args={3}',
                    entry.name, `0x${esp.toString(16)}`,
                    `0x${(frame.hostReturn >>> 0).toString(16)}`,
                    args.map(value=>`0x${(value >>> 0).toString(16)}`).join(','));
            }

            parking.beginCall(frame);
            depth++;
            const charged = charging !== null && entry.writer >= 0
                ? charging(entry.writer) : -1;
            let result;
            let late = false;
            // A hook's `ms` times only the handler call itself, every time --
            // unlike the `trap` phase above (sampled one call in eight,
            // weighted back up), this is the number a kernel's own cost is
            // read from, so it is not sampled.
            const hookStart = import.meta.BOTTLIFY_DIAGNOSTICS !== false && entry.hookStats !== null
                ? hookClock() : 0;
            if (import.meta.BOTTLIFY_DIAGNOSTICS !== false && phased)
            {
                profiler.begin(entry.name, 'host');
            }
            try
            {
                // A site kernel edits registers, not stack arguments: it sees
                // the mutable object built above, not `args` (which stays the
                // pristine reading a fallthrough restores from).
                result = entry.handler(entry.site ? entry.registers : args, frame);
                if (import.meta.BOTTLIFY_DIAGNOSTICS !== false && entry.hookStats !== null)
                {
                    entry.hookStats.ms += hookClock() - hookStart;
                }
                // A promise is neither a value nor the parked token: it is a
                // call that has not finished, and the thread is about to be
                // parked on it. Rendering it as a number turns every such call
                // into a plain zero -- a failure under most conventions -- and
                // a reader then chases a failure that did not happen.
                if (entry.forwards)
                {
                    record.kind = 'forwarded';
                }
                else if (entry.hook)
                {
                    // A hook's handler answers synchronously with whether it
                    // computed the call itself; there is no guest to park or
                    // wait for on this side of the decision.
                    record.kind = result === true ? 'answered' : 'fellThrough';
                    record.answer = record.kind === 'answered' ? 1 : 0;
                }
                else if (isParkedCall(result))
                {
                    record.kind = 'parked';
                    late = true;
                }
                else if (typeof (/** @type {any} */ (result))?.then === 'function')
                {
                    record.kind = 'waiting';
                    late = true;
                }
                else
                {
                    record.kind = 'answered';
                    record.answer = Number(result);
                }
            }
            finally
            {
                if (import.meta.BOTTLIFY_DIAGNOSTICS !== false && phased)
                {
                    profiler.end(entry.name);
                }
                if (charging !== null && charged >= 0)
                {
                    charging(charged);
                }
                depth--;
                parking.endCall();
                // What this call left in the thread's last error. A program
                // reports a code long after whatever produced it returned, and
                // this is the only record that ties the two together. Not read
                // for a function that cannot have set it.
                if (entry.readsError)
                {
                    record.error = lastError();
                }
                if (onCall !== null)
                {
                    // As recorded, strings included only when tracing asked
                    // for them. Peeking every argument for a sink that does
                    // not read the strings cost more than the whole dispatch:
                    // measured at 1.6 of 2.3 microseconds per call.
                    onCall(record);
                }
            }

            if (entry.hookStats !== null)
            {
                entry.hookStats.calls++;
                if (record.kind === 'answered')
                {
                    entry.hookStats.handled++;
                }
                else
                {
                    entry.hookStats.fellThrough++;
                }
            }

            if (late)
            {
                // The handler still holds these and will read them after
                // whatever it is waiting for: they are its now, and the next
                // call gets fresh ones. Paid only by a call that already costs
                // a wait, never by the prompt ones.
                entry.args = new Array(args.length);
                frames[depth] = undefined;
            }
            // A parked call's EAX belongs to whatever wakes the thread, and it
            // carries the wait's own result. Writing a placeholder here would
            // overwrite the answer before the guest ever sees it.
            if (record.kind === 'parked')
            {
                return;
            }
            if (record.kind === 'waiting')
            {
                if (!suspend)
                {
                    throw new Error(
                        `bridge: ${entry.name} answered asynchronously with nowhere to wait`);
                }
                // The trace says "waiting" and nothing after it, which for a
                // read of a game's own archive is the whole question: whether
                // it eventually delivered, and how much. Recorded when the
                // answer arrives, as a line of its own -- the first line is
                // already written and in order, and moving it would put the
                // call somewhere it did not happen.
                if (onCall !== null)
                {
                    const asked = copyOf(record);
                    result.then((/** @type {number} */ value)=>{
                        asked.result = `0x${(value >>> 0).toString(16)} (was waiting)`;
                        onCall(asked);
                    }, ()=>{
                        // The failure itself is whoever suspended the call's
                        // to report; a rejection nobody listened to here would
                        // bring the host down before it could.
                        asked.kind = 'threw';
                        asked.result = 'threw (was waiting)';
                        onCall(asked);
                    });
                }
                suspend(result, frame);
                return;
            }
            if (entry.hook && entry.site)
            {
                if (record.kind === 'answered')
                {
                    // The kernel may have edited any of the eight; every one
                    // is written back, ESP last of the registers (it may have
                    // moved) and EIP last of all. EFLAGS are not restored --
                    // a `pushad`/`popad` pair does not touch them either --
                    // so the resume point must not depend on flags a branch
                    // between the site and it would have set.
                    const r = /** @type {NonNullable<Entry['registers']>} */ (entry.registers);
                    cpu.writeReg32('eax', r.eax >>> 0);
                    cpu.writeReg32('ecx', r.ecx >>> 0);
                    cpu.writeReg32('edx', r.edx >>> 0);
                    cpu.writeReg32('ebx', r.ebx >>> 0);
                    cpu.writeReg32('ebp', r.ebp >>> 0);
                    cpu.writeReg32('esi', r.esi >>> 0);
                    cpu.writeReg32('edi', r.edi >>> 0);
                    cpu.writeReg32('esp', (r.esp + entry.stackAdjust) >>> 0);
                    cpu.writeReg32('eip', entry.resume);
                }
                else
                {
                    // Not handled: every register restored to exactly what
                    // the site's own call site held -- `args`, never
                    // `entry.registers`, so a handler that fell through after
                    // editing the object it was given leaves nothing behind
                    // -- and EIP goes to the trampoline: the displaced
                    // instructions, then a jump back into the function right
                    // after the site, as though it had never been patched.
                    cpu.writeReg32('eax', args[0] >>> 0);
                    cpu.writeReg32('ecx', args[1] >>> 0);
                    cpu.writeReg32('edx', args[2] >>> 0);
                    cpu.writeReg32('ebx', args[3] >>> 0);
                    cpu.writeReg32('ebp', args[5] >>> 0);
                    cpu.writeReg32('esi', args[6] >>> 0);
                    cpu.writeReg32('edi', args[7] >>> 0);
                    cpu.writeReg32('esp', esp);
                    cpu.writeReg32('eip', entry.trampoline);
                }
                if (hookTraced)
                {
                    journal.write(journal.Level.TRACE, HOOK_AREA,
                        '{0} {1} eip={2} esp={3}',
                        entry.name, record.kind,
                        `0x${(cpu.readReg32('eip') >>> 0).toString(16)}`,
                        `0x${(cpu.readReg32('esp') >>> 0).toString(16)}`);
                }
                return;
            }
            if (entry.hook)
            {
                // Whichever way this goes, EDX reads exactly as the guest's
                // own call set it: the trap sequence's `mov dx, port` spent
                // half of it getting here, and the pushed word is the only
                // place that still holds it. ECX was never touched.
                cpu.writeReg32('edx', memory.readU32(pushed));
                if (record.kind === 'answered')
                {
                    // The kernel computed the call itself: return to the
                    // caller as the guest function's own `ret cleanup` would,
                    // since no such instruction is baked into this stub for
                    // the CPU to run on its own.
                    const returnTo = memory.readU32(esp);
                    cpu.writeReg32('eax', 0);
                    cpu.writeReg32('esp', esp + 4 + entry.cleanup);
                    cpu.writeReg32('eip', returnTo);
                }
                else
                {
                    // Not handled: drop the saved block and hand the call to
                    // the guest's own function exactly as its caller made it
                    // -- the return address and stack arguments untouched,
                    // now that ECX/EDX are restored.
                    cpu.writeReg32('esp', esp);
                    cpu.writeReg32('eip', entry.target);
                }
                if (hookTraced)
                {
                    journal.write(journal.Level.TRACE, HOOK_AREA,
                        '{0} {1} eip={2} esp={3}',
                        entry.name, record.kind,
                        `0x${(cpu.readReg32('eip') >>> 0).toString(16)}`,
                        `0x${(cpu.readReg32('esp') >>> 0).toString(16)}`);
                }
                return;
            }
            if (entry.saved !== 0)
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
            implemented,
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
                const copy = copyOf(record);
                copy.strings ??= record.args.map(peekString);
                out.push(copy);
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

        /**
         * A kernel's own comparison against the guest failed. Named rather
         * than aimed at an id, because whoever built the kernel only ever
         * knew the hook by its name -- the oracle's own differential check is
         * the kernel's business, not this dispatcher's; this only counts it.
         *
         * @param {string} name
         */
        reportMismatch(name){
            const id = hooksByName.get(name);
            const entry = id === undefined ? undefined : functions[id];
            if (entry?.hookStats)
            {
                entry.hookStats.mismatches++;
            }
        },

        /**
         * Every hook's own counters, for a frame report: how often it ran,
         * how often it answered the call itself, how often the guest's own
         * code ran instead, how often -- in oracle mode -- the two
         * disagreed, and the wall time spent inside the handler call itself
         * (every call, not sampled -- unlike the `trap` phase).
         */
        hooks(){
            /** @type {{ name: string, calls: number, handled: number,
             *   fellThrough: number, mismatches: number, ms: number }[]} */
            const out = [];
            for (const [name, id] of hooksByName)
            {
                const stats = functions[id]?.hookStats;
                if (stats)
                {
                    out.push({ name, ...stats });
                }
            }
            return out;
        },
    };
}
