/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { calleeCleanup, registerArgumentCount } from './conventions.js';
import { isParkedCall } from './parking.js';
import { isDriven } from './drive.js';

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
 * @property {Map<number, number>} [callers]  Sampled crossings by return address.
 * @property {Map<string, number>} [chains]  The same, by the two callers above it.
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
 * @property {number} kept          How many of them the ring keeps.
 * @property {number} writer
 *     Where the memory layer charges what this call writes into the guest,
 *     resolved here once so the crossing stores a number and looks nothing up.
 * @property {number} sinkRevision  The journal revision `sinkOn` was asked at.
 * @property {boolean} sinkOn       Whether the sink wants this function's calls.
 * @property {number} calls        Calls made to it.
 * @property {number} sampledMs    Host ms the timed ones of them took, each standing for
 *     `TRAP_SAMPLE` calls on average (`dispatch`).
 * @property {number} [windowCalls]  `calls` when the rate window began (`measureRates`).
 * @property {number} [windowMs]     `sampledMs` when it began.
 */

/**
 * @typedef {Object} CallFrame
 * @property {string} name
 * @property {number} freeStack    What is safe to write below now.
 * @property {number} callerStack  ESP as the caller left it: the return address
 *     is here and the stack arguments above it.
 * @property {number} restingStack Where the stack will be once the stub returns.
 * @property {number} hostReturn
 * @property {any} thread           Whose call this is: parking stamps it as the call begins.
 */

/**
 * How many calls the ring keeps, with their arguments and answers.
 *
 * Generous, because the call that explains a failure is routinely hundreds
 * back: a program that has just failed spends its last moments in its own
 * error reporting, and the answer that was wrong came before all of it. Names
 * alone say what a program was doing; arguments and answers say what it asked
 * and what it was told, which is the only way to see an answer that was wrong
 * rather than missing. Small enough that it is a rounding error in memory.
 * A power of two: the crossing masks its index into the ring.
 */
const CALL_RING = 4096;

/**
 * How many of a call's arguments the ring keeps: enough for a Direct3D method's
 * (CreateTexture has nine with its object, CheckDeviceFormat seven -- the one
 * that names the format is the last) and CreateWindowEx's twelve.
 */
const KEPT_ARGS = 12;

/** How a call ended, as the ring keeps it, by the number it keeps. */
const KINDS = ['threw', 'answered', 'fellThrough', 'parked', 'waiting', 'forwarded'];
const THREW = 0;
const ANSWERED = 1;
const FELL_THROUGH = 2;
const PARKED_KIND = 3;
const WAITING = 4;
const FORWARDED = 5;

/** Indices into the cpu's register file, in the encoding's order. */
const EAX = 0;
const ECX = 1;
const ESP = 4;
const EBP = 5;

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
 * @property {string | null} [thread]  The calling thread's name, for a sink: a
 *     waiting call's answer is reported while another thread runs.
 */

/**
 * @param {CallRecord} record
 * @returns {string}
 */
const describe = record=>record.kind === 'answered'
    ? `0x${(record.answer >>> 0).toString(16)}`
    : record.kind;

/**
 * A record's `result`, made from its answer when read.
 *
 * One getter for every dispatcher in the realm, not one per instance. The
 * getter is part of a record's hidden class, so a getter of each instance's
 * own gave the records of a second machine in a process classes of their
 * own; the crossing's code, compiled once for the whole realm, then met
 * records it had never seen and wrote each of their fields through V8's
 * generic property path: the largest single part of a second machine's
 * crossing costing several times its first's.
 */
const RESULT = {
    /** @this {CallRecord} */
    get(){
        return describe(this);
    },
    enumerable: true,
    configurable: true,
};

/** The journal area a hook's crossings are written under. */
const HOOK_AREA = 'call.hook';

/** How many calls one timed crossing stands for, on average (`sampleInterval`). */
const TRAP_SAMPLE = 32;
/** How many return addresses each function's sampled crossings are counted at. */
const CALLERS_KEPT = 64;
const TRAP_WEIGHT = Object.freeze({ weight: TRAP_SAMPLE });
/** What a phase inside a timed crossing stands for: as many as the crossing (`innerBegin`). */
const INNER_WEIGHT = Object.freeze({ weight: TRAP_SAMPLE, withParent: true });

/** How many functions the report names by the host time they took. */
const BY_FUNCTION_KEPT = 80;

/**
 * The window the call rates are measured over, and how often a run of calls
 * looks at the clock to see whether one has passed: a clock read per call
 * would cost more than the counting.
 */
const RATE_WINDOW_MS = 1000;
const RATE_CHECK_CALLS = 1024;
/**
 * A function the program calls more often than this a second, or that holds
 * the host for more than this share of each second, is named in the report
 * and once in the journal: a program that has started going to the host for
 * ever -- polling a query, spinning on a message -- shows as it starts,
 * rather than as a frame rate nobody can explain.
 */
const CHATTY_CALLS_PER_SECOND = 20000;
const CHATTY_MS_PER_SECOND = 100;
/** How many chatty functions the report names. */
const CHATTY_KEPT = 10;

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
function makeRecord(){
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
        /** @type {string | null} */
        thread: null,
    };
    return /** @type {CallRecord} */ (Object.defineProperty(record, 'result', RESULT));
}

/** The last error of a dispatcher that was handed no reader. */
const NO_ERROR = ()=>0;

/**
 * @param {Object} deps
 * @param {any} deps.cpu       For the registers a call frame is read from.
 * @param {any} deps.memory    For the stack itself, so a wild ESP is caught here.
 * @param {any} deps.parking   Brackets each handler and issues the parked token.
 * @param {(answer: Promise<number> | import('./drive.js').Driven, frame: any) => void}
 *     [deps.suspend]
 * @param {() => number} [deps.now]  The clock call rates are measured by;
 *        performance.now unless a test keeps its own.
 *        What to do with a handler that has not finished; wired by the module.
 * @param {() => number} [deps.lastError]
 *        The running thread's last error, for the trace. Injected because it
 *        belongs to a layer above this one.
 * @param {number} [deps.lastErrorOffset]
 *        Where a thread's last error lives in its thread block (the kernel's
 *        `tebAddress`), handed down as a number by the layer that owns the
 *        block's layout: read there after the call rather than through
 *        `lastError`, which then answers only for a thread with no block.
 * @param {boolean} [deps.traceStrings]
 * @param {boolean} [deps.callPhases]  Time each call as a phase of its own.
 * @param {{ begin: (name: string, kind?: string) => void,
 *            end: (name?: string, detail?: { weight?: number, withParent?: boolean }) => number
 *          }} [deps.profiler]
 *        Where a host call's time is accounted. Optional: this layer is
 *        testable without one, and a phase nobody reads is work nobody asked
 *        for.
 * @param {(record: any) => void} [deps.onCall]
 *        Read the text an argument points at while the call is being made
 *        rather than when the trace is read. Off by default: it costs a scan
 *        of guest memory per pointer argument on every recorded call. On, it
 *        is the only way to see a string a program built on its own stack,
 *        which by the end of a run is somebody else's stack.
 * @param {(name: string) => boolean} [deps.wantsCall]
 *        Whether `onCall` wants the calls of a function, asked once for each
 *        and again only when the journal's revision moves (`revisionCell`):
 *        a sink that keeps nothing but what the journal traces is not called
 *        for the rest. Absent, or with no journal to say when to ask again,
 *        every call goes to the sink.
 * @param {{ enabled: (category: string, level: number) => boolean,
 *            write: (level: number, category: string, message: string,
 *                a?: any, b?: any, c?: any, d?: any) => void,
 *            Level: { TRACE: number, WARN?: number }, revisionCell?: () => Int32Array }}
 *        [deps.journal]
 *        Where a slot hook's crossings are written when `call.hook` is on:
 *        the frame as the guest's own call site left it, and where the
 *        call was sent afterwards. A hook stands in front of a call the
 *        engine did not marshal by declaration but by a sidecar's word, and
 *        this record is the only account of whether that word held.
 */
export function createDispatcher(deps){
    return new Dispatcher(deps);
}

/**
 * The dispatcher of one machine: its state is the instance's, its code the
 * class's.
 *
 * The code every host call runs is one set of functions for the realm rather
 * than closures each machine makes afresh. V8 optimises a function per
 * closure it has, and a closure a later machine makes starts over: it runs
 * unoptimised until it is hot again, and the code it gets is compiled around
 * feedback the machines before it left -- a call target one of them had is a
 * deoptimisation for the next -- so each later machine of a process paid for
 * much of its run what the first paid for a moment. A method is one function
 * for every machine, optimised once; what differs between machines is data
 * it reads off the instance.
 */
class Dispatcher {
    /** @param {Parameters<typeof createDispatcher>[0]} deps */
    constructor(deps){
        const { cpu, memory, parking } = deps;
        /** @type {any} */
        this.cpu = cpu;
        /** @type {any} */
        this.memory = memory;
        /** @type {any} */
        this.parking = parking;
        /** @type {((answer: Promise<number> | import('./drive.js').Driven, frame: any) => void) | null} */
        this.suspend = deps.suspend ?? null;

        /**
         * The cpu's general registers as a view, when it lends one
         * (`cpu.registerFile`): ESP read and EAX written in place rather than
         * through `readReg32` and `writeReg32`, each a walk through the cpu
         * layer's api, its host and a search of the register names. Taken
         * again when it reads empty -- an emulator that grows its memory
         * detaches the buffer the view was on -- and never asked for again
         * once the cpu says it has none.
         *
         * @type {Int32Array | null}
         */
        this.file = null;
        this.lends = typeof cpu?.registerFile === 'function';

        /**
         * Where a call's frame words land before they are handed out: grown to
         * the longest frame seen and kept.
         *
         * @type {number[]}
         */
        this.spanWords = new Array(8).fill(0);

        /** @type {Parameters<typeof createDispatcher>[0]['journal'] | null} */
        this.journal = deps.journal ?? null;

        /** The clock the call rates are measured by (`chatty`). */
        this.now = deps.now ?? (()=>performance.now());
        /** When the current rate window began. */
        this.windowStart = this.now();
        /**
         * The functions over the chatty thresholds in the last whole window,
         * as report lines, the heaviest host time first.
         *
         * @type {string[]}
         */
        this.chatty = [];
        /** The names already written to the journal as chatty, once each. @type {Set<string>} */
        this.chattyNoted = new Set();
        /**
         * Whose writes into guest memory these are.
         *
         * Bytes written by the host are one number for the whole run unless
         * somebody says which call was in flight, and this is the only place
         * that knows. A slot in, the previous slot out, restored on the way
         * back: a handler that calls the guest back into another host call
         * nests without a stack of its own, and a write made with nothing in
         * flight keeps the name the account gives it rather than the last
         * call's.
         *
         * @type {((slot: number) => number) | null}
         */
        this.charging = typeof memory?.charging === 'function' ? memory.charging : null;
        /**
         * The same account's cell, where the memory layer lends it: the slot
         * swapped in and back with two stores rather than two calls into
         * that layer.
         *
         * @type {Int32Array | null}
         */
        this.chargeSlot = typeof memory?.chargeSlot === 'function'
            ? memory.chargeSlot() ?? null : null;
        /**
         * The memory layer's checked dword reads as an object of its own
         * class, where it lends one: the stack words and the thread block's
         * last error read through methods that are one for the realm, not
         * through that layer's closures and the cpu's under them.
         *
         * @type {{ readU32sInto: (address: number, count: number, into: number[],
         *     at: number) => void, readU32: (address: number) => number } | null}
         */
        this.reader = typeof memory?.reader === 'function' ? memory.reader() ?? null : null;
        this.lastError = deps.lastError ?? NO_ERROR;
        this.errorReader = deps.lastError !== undefined;
        // The dword itself rather than `lastError`, which walked the kernel
        // for the running thread and the memory layer for its block on every
        // call -- measured at a fifth of a call to a handler that does nothing.
        this.errorOffset = deps.lastErrorOffset ?? -1;
        this.traceStrings = deps.traceStrings ?? false;
        // A ring holds the end of a run, and the end of a run is rarely where
        // the decision was made: a program that gives up after opening its
        // archives made up its mind thousands of calls earlier. A sink keeps
        // all of it, for whoever is willing to pay for the file.
        this.onCall = deps.onCall ?? null;
        /** @type {((name: string) => boolean) | null} */
        this.wantsCall = null;
        /** @type {Int32Array | null} */
        this.revision = null;
        if (deps.wantsCall && typeof deps.journal?.revisionCell === 'function')
        {
            this.wantsCall = deps.wantsCall;
            this.revision = deps.journal.revisionCell();
        }
        /**
         * Where a host call's time is accounted, when the caller wired one.
         *
         * Optional because this layer is testable without one, and because a
         * phase that nobody reads is work nobody asked for.
         */
        this.profiler = deps.profiler ?? null;
        // Whether each call is timed as a phase of its own, under the
        // crossing's. That is what a report's cost per API comes from, and it
        // costs two clock readings per call -- measured at three percent of a
        // frame in a match, where a frame makes fifteen hundred calls. Off
        // unless a measurement asks; the crossing is sampled whenever there is
        // a profiler, so the host's share is known -- and a production bundle,
        // which has none, times nothing.
        this.phased = import.meta.BOTTLIFY_DIAGNOSTICS !== false && this.profiler !== null
            && (deps.callPhases ?? false);
        // An int32 from the start, so the field keeps one representation.
        this.sampler = 0x9e3779b9 | 0;
        this.untilSample = this.sampleInterval();
        /** Whether the crossing being made is a sampled one, whose caller is counted. */
        this.sampleCaller = false;
        /**
         * What a phase opened inside the crossing being made stands for
         * (`innerBegin`): with every call a phase of its own, each is timed and
         * stands for itself; otherwise only inside a timed crossing, standing
         * for as many as it does; 0 is not timed.
         */
        this.innerWeight = this.phased ? 1 : 0;

        // Indexed by trap id: the cpu hands them out in sequence from zero.
        /** @type {(Entry | undefined)[]} */
        this.functions = [];
        this.implemented = 0;
        /**
         * Frames by depth of nesting, reused: a guest callback can trap into
         * another host call, so there is one per level rather than one.
         *
         * Made holding what it will hold, as the rings below are, so every
         * dispatcher's arrays have the one hidden class from the start: an
         * array's class moves with the kind of element it holds, and the
         * crossing's code, shared by every machine in a process, would
         * otherwise find a new machine's arrays in the class the first
         * machine's left behind.
         *
         * @type {(CallFrame | null | undefined)[]}
         */
        this.frames = [null];
        this.depth = 0;
        /**
         * The names of recent calls, as a ring.
         *
         * Bounded, and that is the whole point of it. This is diagnostics: a
         * failure report wants the last handful of calls, and nothing wants
         * the millionth. Kept as a growing list it is a leak that scales with
         * how well the engine works -- a program that runs for an hour makes
         * hundreds of millions of calls, and the array eventually refuses to
         * grow at all, failing inside the dispatcher with a message about
         * array length that says nothing about the guest.
         *
         * A slot a call, `ringCount` its index, in typed arrays a field
         * each, and a record made of a slot only when somebody reads it: a
         * record object per slot was written field by field on every
         * crossing, each name and array a store the collector has to be told
         * about, and that bookkeeping was as much of a crossing as all the
         * rest of it.
         */
        // One slot past the ring: where a call kept out of it (`skipInRing`)
        // is written, so the rest of a crossing need not ask.
        this.ids = new Int32Array(CALL_RING + 1);
        this.froms = new Int32Array(CALL_RING + 1);
        this.argWords = new Int32Array((CALL_RING + 1) * KEPT_ARGS);
        this.argCounts = new Uint8Array(CALL_RING + 1);
        this.kinds = new Uint8Array(CALL_RING + 1);
        this.answers = new Float64Array(CALL_RING + 1);
        this.errors = new Float64Array(CALL_RING + 1);
        /**
         * The text each argument pointed at, by slot, read only when tracing
         * asked for it.
         * @type {((string | null)[] | null)[]}
         */
        this.strings = new Array(CALL_RING + 1).fill(null);
        /** What a sink is handed, written over for each call it is handed. */
        this.sinkRecord = makeRecord();
        /**
         * The sink record's argument array of each length, made the first
         * time: a record whose array was the wrong length was given a new
         * one, an allocation on most traced crossings of a mixed run.
         * @type {(number[] | undefined)[]}
         */
        this.sinkArgs = [];
        /** Guest address of each stub, so a return address can be given a name. */
        /** @type {Map<number, string>} */
        this.byAddress = new Map();
        this.callCount = 0;
        /** The calls written into the ring, which the ring is read by. */
        this.ringCount = 0;
        /**
         * The functions kept out of the ring, by id: a program's idle loop
         * calling a few of them a hundred thousand times a second pushed out
         * of it, in milliseconds, the calls a reader was after.
         *
         * @type {Set<number>}
         */
        this.ringSkip = new Set();
        /** A hook's name to its trap id, for `reportMismatch`. */
        /** @type {Map<string, number>} */
        this.hooksByName = new Map();
    }

    /**
     * The crossing is timed one call in this many on average, each standing
     * for all of them: two clock readings a call were a measured share of a
     * frame in a match, and a share is as true of a sample as of the whole --
     * of a random sample. Every eighth call of a program that draws in a
     * fixed sequence of calls is the same few calls of that sequence every
     * time, and the estimate was those calls' cost eight times over: more
     * host time than the frame had, and a guest phase whose own time came out
     * below nothing. So the calls between two timed ones are drawn from a
     * xorshift, TRAP_SAMPLE on average. One in thirty-two rather than one in
     * eight: the timed call's two clock readings and phase were most of what
     * the sampling cost every call, and a title's thirty thousand calls a
     * second still time about a thousand.
     *
     * Two draws of 0..31 and one: 32 calls on average, never none.
     */
    sampleInterval(){
        let sampler = this.sampler;
        sampler ^= sampler << 13;
        sampler ^= sampler >>> 17;
        sampler ^= sampler << 5;
        this.sampler = sampler;
        return (sampler & 31) + (sampler >>> 5 & 31) + 1;
    }

    /** The register file, asked for again when it reads empty. */
    registers(){
        const file = this.file;
        if (file !== null && file.length !== 0)
        {
            return file;
        }
        if (this.lends)
        {
            this.file = this.cpu.registerFile() ?? null;
            this.lends = this.file !== null;
        }
        return this.file;
    }

    /** @param {number} count */
    frameWords(count){
        if (this.spanWords.length < count)
        {
            this.spanWords = new Array(count).fill(0);
        }
        return this.spanWords;
    }

    /**
     * The return addresses of the two frames an EBP chain names from `ebp`,
     * as text; a frame outside mapped memory ends it.
     *
     * @param {number} ebp
     */
    frameChain(ebp){
        const found = [];
        let frame = ebp >>> 0;
        while (found.length < 2 && frame !== 0)
        {
            const region = this.memory.find?.(frame);
            if (!region || frame + 8 > region.base + region.size)
            {
                break;
            }
            found.push(`0x${(this.memory.readU32(frame + 4) >>> 0).toString(16)}`);
            frame = this.memory.readU32(frame) >>> 0;
        }
        return found.join('<');
    }

    /**
     * Reads a call's stack words one at a time up to the end of the region
     * they start in, and zeroes the rest. Only reached when the span runs past
     * that region; a read that fails for any other reason fails as it did.
     *
     * @param {number} from @param {number} count @param {number[]} into
     * @param {number} at @param {unknown} failure
     */
    readWithinStack(from, count, into, at, failure){
        const region = this.memory.find?.(from);
        if (!region)
        {
            throw failure;
        }
        const end = region.base + region.size;
        for (let word = 0; word < count; word++)
        {
            const address = from + word * 4;
            into[at + word] = address + 4 <= end ? this.memory.readU32(address) | 0 : 0;
        }
    }

    /**
     * The most-called names in the ring, with their counts, commonest first.
     *
     * @param {number} count
     * @returns {[string, number][]}
     */
    hot(count){
        /** @type {Map<string, number>} */
        const counts = new Map();
        for (const name of this.history(CALL_RING))
        {
            counts.set(name, (counts.get(name) ?? 0) + 1);
        }
        return [...counts].sort((left, right)=>right[1] - left[1]).slice(0, count);
    }

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
    peekString(value){
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
        const region = this.memory.find(address);
        if (region === undefined || region.access === 'none')
        {
            return null;
        }
        const span = Math.min(PEEK_LIMIT, region.base + region.size - address);
        const bytes = this.memory.window(address, span);
        // A printable character and a zero is how a UTF-16 string starts: the
        // W functions' paths and messages are read as that.
        const step = span >= 4 && bytes[1] === 0 && bytes[0] !== 0 ? 2 : 1;
        let text = '';
        for (let at = 0; at + step <= span; at += step)
        {
            const byte = bytes[at];
            if (step === 2 && bytes[at + 1] !== 0)
            {
                return null;
            }
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
        // Text that runs to the end of the read is a long path or message
        // cut short, and is shown as that rather than as nothing.
        return text.length >= 2 && span === PEEK_LIMIT ? `${text}…` : null;
    }

    /**
     * The last `count` calls, oldest first.
     *
     * @param {number} count
     * @returns {string[]}
     */
    history(count){
        const kept = Math.min(count, this.ringCount, CALL_RING);
        /** @type {string[]} */
        const out = [];
        for (let back = kept; back > 0; back--)
        {
            out.push(this.nameAt((this.ringCount - back) & CALL_RING - 1));
        }
        return out;
    }

    /**
     * A site hook's eight registers, off the stub's own `pushad` before it
     * trapped: pushed lowest to highest is edi, esi, ebp, the original esp,
     * ebx, edx, ecx, eax -- so eax is the last one pushed, at `pushed + 28`.
     * Read into `args` in declaration order rather than straight into
     * `entry.registers` so a fallthrough can restore exactly what the site's
     * own call site held even if the handler edited the mutable object it
     * was given.
     *
     * @param {Entry} entry @param {number} pushed @param {number} esp
     * @returns {number} the dword at the site's ESP
     */
    readSite(entry, pushed, esp){
        const args = entry.args;
        const block = this.frameWords(8);
        this.memory.readU32sInto(pushed, 8, block, 0);
        args[0] = block[7]; // eax
        args[1] = block[6]; // ecx
        args[2] = block[5]; // edx
        args[3] = block[4]; // ebx
        args[4] = esp | 0;  // esp: the site's own
        args[5] = block[2]; // ebp
        args[6] = block[1]; // esi
        args[7] = block[0]; // edi
        // Non-null: `entry.registers` is only null for a non-site entry.
        const r = /** @type {NonNullable<Entry['registers']>} */ (entry.registers);
        r.eax = args[0];
        r.ecx = args[1];
        r.edx = args[2];
        r.ebx = args[3];
        r.esp = args[4];
        r.ebp = args[5];
        r.esi = args[6];
        r.edi = args[7];
        return this.memory.readU32(esp);
    }

    /**
     * A call's arguments into its entry's own array, which the handler reads
     * and this layer writes over on the next call -- a handler that answers
     * later than it returns keeps the array (see `settleLate`).
     *
     * @param {Entry} entry @param {Int32Array | null} regs
     * @param {number} pushed @param {number} esp
     * @returns {number} the return address at ESP
     */
    readCall(entry, regs, pushed, esp){
        const args = entry.args;
        let at = 0;
        if (entry.registerArgs >= 1)
        {
            // Live: nothing in the trap sequence touches ECX.
            args[at++] = regs === null ? this.cpu.readReg32('ecx') | 0 : regs[ECX];
        }
        if (entry.registerArgs >= 2)
        {
            // Fastcall's EDX is not live by this point: `mov dx, port`
            // spends the low half of the very register the argument is
            // in, so the stub pushed it first and this reads it from
            // there -- the one word between `pushed` and the caller's
            // own frame at `esp`.
            args[at++] = this.memory.readU32(pushed) | 0;
        }
        // The return address and the stack arguments above it in one read of
        // the span: the memory layer validates it once and hands it to the
        // machine in one call, where each word, and the return address on its
        // own, was a walk down through the memory and cpu layers of its own.
        const count = entry.stackWords + 1;
        const words = this.frameWords(count);
        try
        {
            const reader = this.reader;
            if (reader !== null)
            {
                reader.readU32sInto(esp, count, words, 0);
            }
            else
            {
                this.memory.readU32sInto(esp, count, words, 0);
            }
        }
        catch {
            if (count > 1)
            {
                try
                {
                    this.memory.readU32sInto(esp + 4, count - 1, args, at);
                }
                catch (e){
                    // A variadic entry reads a fixed number of slots, and a
                    // call made near the top of its thread's stack has fewer
                    // words above it than that: past the stack is nothing the
                    // caller passed, so it reads as zero rather than stopping
                    // the machine.
                    this.readWithinStack(esp + 4, count - 1, args, at, e);
                }
            }
            // The return address alone fails as the stack does.
            return this.memory.readU32(esp);
        }
        for (let word = 1; word < count; word++)
        {
            args[at++] = words[word];
        }
        return words[0] >>> 0;
    }

    /**
     * Whether a hook's crossing is traced, and its entry line when it is:
     * written before the handler runs, so a handler that never comes back
     * still leaves the frame it was handed on the record.
     *
     * @param {Entry} entry @param {number} esp @param {number} hostReturn
     * @param {number[]} args
     */
    traceHookEntry(entry, esp, hostReturn, args){
        const journal = this.journal;
        if (!journal || !journal.enabled(HOOK_AREA, journal.Level.TRACE))
        {
            return false;
        }
        journal.write(journal.Level.TRACE, HOOK_AREA,
            '{0} entry esp={1} ret={2} args={3}',
            entry.name, `0x${esp.toString(16)}`,
            `0x${(hostReturn >>> 0).toString(16)}`,
            args.map(value=>`0x${(value >>> 0).toString(16)}`).join(','));
        return true;
    }

    /**
     * Where a hook sent the call, for a traced crossing.
     *
     * @param {Entry} entry @param {string} kind
     */
    traceHookExit(entry, kind){
        const journal = /** @type {NonNullable<Dispatcher['journal']>} */ (this.journal);
        journal.write(journal.Level.TRACE, HOOK_AREA, '{0} {1} eip={2} esp={3}',
            entry.name, kind,
            `0x${(this.cpu.readReg32('eip') >>> 0).toString(16)}`,
            `0x${(this.cpu.readReg32('esp') >>> 0).toString(16)}`);
    }

    /**
     * A slot or site hook's decision, carried out: where EIP and the
     * registers go now that the handler has said whether it computed the
     * call itself.
     *
     * @param {Entry} entry @param {boolean} answered @param {number[]} args
     * @param {number} pushed @param {number} esp
     */
    finishHook(entry, answered, args, pushed, esp){
        const cpu = this.cpu;
        if (entry.site)
        {
            if (answered)
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
            return;
        }
        // Whichever way this goes, EDX reads exactly as the guest's
        // own call set it: the trap sequence's `mov dx, port` spent
        // half of it getting here, and the pushed word is the only
        // place that still holds it. ECX was never touched.
        cpu.writeReg32('edx', this.memory.readU32(pushed));
        if (answered)
        {
            // The kernel computed the call itself: return to the
            // caller as the guest function's own `ret cleanup` would,
            // since no such instruction is baked into this stub for
            // the CPU to run on its own.
            const returnTo = this.memory.readU32(esp);
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
    }

    /**
     * A call that did not answer by returning: parked, or waiting on a
     * promise.
     *
     * @param {Entry} entry @param {number[]} args @param {number} at  Its slot in the ring.
     * @param {any} result @param {CallFrame} frame
     */
    settleLate(entry, args, at, result, frame){
        // The handler still holds these and will read them after whatever it
        // is waiting for: they are its now, and the next call gets fresh
        // ones. Paid only by a call that already costs a wait, never by the
        // prompt ones.
        entry.args = new Array(args.length);
        this.frames[this.depth] = undefined;
        // A parked call's EAX belongs to whatever wakes the thread, and it
        // carries the wait's own result. Writing a placeholder here would
        // overwrite the answer before the guest ever sees it.
        if (this.kinds[at] === PARKED_KIND)
        {
            return;
        }
        if (this.suspend === null)
        {
            throw new Error(
                `bridge: ${entry.name} answered asynchronously with nowhere to wait`);
        }
        // The trace says "waiting" and nothing after it, which for a read of
        // a game's own archive is the whole question: whether it eventually
        // delivered, and how much. Recorded when the answer arrives, as a
        // line of its own -- the first line is already written and in order,
        // and moving it would put the call somewhere it did not happen.
        const onCall = this.onCall;
        if (onCall !== null && this.sinks(entry))
        {
            const asked = { ...this.recordAt(at), thread: frame.thread?.name ?? null };
            if (isDriven(result))
            {
                result.onDone = (/** @type {number} */ value)=>{
                    asked.result = `0x${(value >>> 0).toString(16)} (was waiting)`;
                    onCall(asked);
                };
                this.suspend(result, frame);
                return;
            }
            result.then((/** @type {number} */ value)=>{
                asked.result = `0x${(value >>> 0).toString(16)} (was waiting)`;
                onCall(asked);
            }, ()=>{
                // The failure itself is whoever suspended the call's to
                // report; a rejection nobody listened to here would bring the
                // host down before it could.
                asked.kind = 'threw';
                asked.result = 'threw (was waiting)';
                onCall(asked);
            });
        }
        this.suspend(result, frame);
    }

    /**
     * Whether this call goes to the sink: asked of `wantsCall` once for each
     * function and again whenever the journal's revision has moved since.
     *
     * @param {Entry} entry
     */
    sinks(entry){
        const revision = this.revision;
        if (revision === null)
        {
            return true;
        }
        const now = revision[0];
        if (entry.sinkRevision !== now)
        {
            entry.sinkOn = /** @type {(name: string) => boolean} */ (this.wantsCall)(entry.name);
            entry.sinkRevision = now;
        }
        return entry.sinkOn;
    }

    /**
     * The crossing itself: marshal, invoke, place the result.
     *
     * Everything a call of every kind needs is here, and every kind's own
     * business -- a hook's trace and clock, a site's registers, a late
     * answer -- is a method of its own reached only by that kind.
     *
     * @param {number} id
     */
    cross(id){
        const entry = this.functions[id];
        if (entry === undefined)
        {
            throw new Error(`bridge: trap ${id} has no implementation`);
        }

        const regs = this.registers();
        const pushed = regs === null ? this.cpu.readReg32('esp') : regs[ESP] >>> 0;
        const esp = pushed + entry.saved;
        const args = entry.args;
        const hostReturn = entry.site
            ? this.readSite(entry, pushed, esp)
            : this.readCall(entry, regs, pushed, esp);

        this.callCount++;
        const at = this.ringSkip.has(id) ? CALL_RING : this.ringCount++ & CALL_RING - 1;
        this.ids[at] = id;
        entry.calls++;
        if ((this.callCount & RATE_CHECK_CALLS - 1) === 0)
        {
            this.measureRates();
        }

        // Everything the handler might need about where it was called from,
        // read before it runs: a handler that calls the guest back writes
        // into the stack, and by then some of this is no longer there to
        // read. `freeStack` is what is safe to write below *now*, while the
        // return address at ESP is still live; `restingStack` is where the
        // stack will be once the stub has returned. `thread` is in the
        // literal, for the class reason the arrays above give: parking
        // stamps it on every frame it is handed.
        const depth = this.depth;
        const frame = this.frames[depth] ??= {
            name: '', freeStack: 0, callerStack: 0, restingStack: 0, hostReturn: 0,
            thread: null,
        };
        frame.name = entry.name;
        frame.freeStack = pushed;
        frame.callerStack = esp;
        frame.restingStack = esp + 4 + entry.cleanup;
        frame.hostReturn = hostReturn;

        // Which instruction made this call. Read from the frame that was
        // captured above rather than the stack, because a handler that
        // calls the guest back has overwritten the stack by the time
        // anybody reads this.
        this.froms[at] = hostReturn;
        // The sampled crossings also say where they came from: a function
        // called millions of times is a loop somewhere, and the loop's
        // address is what names it.
        if (this.sampleCaller)
        {
            this.sampleCaller = false;
            const callers = entry.callers ??= new Map();
            if (callers.has(hostReturn) || callers.size < CALLERS_KEPT)
            {
                callers.set(hostReturn, (callers.get(hostReturn) ?? 0) + 1);
            }
            // And the two callers above it, by the frame chain: the caller is
            // often a wrapper that sixty places call, and the loop is in one.
            const chain = this.frameChain(regs === null
                ? this.cpu.readReg32('ebp') : regs[EBP] >>> 0);
            const chains = entry.chains ??= new Map();
            if (chains.has(chain) || chains.size < CALLERS_KEPT)
            {
                chains.set(chain, (chains.get(chain) ?? 0) + 1);
            }
        }
        // Copied, because a handler that writes through a pointer can
        // change what the arguments describe before anyone reads them.
        const kept = entry.kept;
        const argWords = this.argWords;
        for (let i = 0; i < kept; i++)
        {
            argWords[at * KEPT_ARGS + i] = args[i];
        }
        this.argCounts[at] = kept;
        // Read now rather than later when asked for: a string a program
        // assembled on its own stack has been overwritten several
        // frames deep by the time anybody reads the trace, and what
        // comes back then belongs to whatever ran next.
        if (this.traceStrings)
        {
            const strings = this.strings[at] ??= [];
            strings.length = kept;
            for (let i = 0; i < kept; i++)
            {
                strings[i] = this.peekString(args[i]);
            }
        }
        const kinds = this.kinds;
        kinds[at] = THREW;
        this.errors[at] = 0;

        const hookTraced = entry.hook && this.traceHookEntry(entry, esp, hostReturn, args);

        this.parking.beginCall(frame);
        this.depth = depth + 1;
        const slot = this.chargeSlot;
        const charging = this.charging;
        let charged = -1;
        if (entry.writer >= 0)
        {
            if (slot !== null)
            {
                charged = slot[0];
                slot[0] = entry.writer;
            }
            else if (charging !== null)
            {
                charged = charging(entry.writer);
            }
        }
        let result;
        let late = false;
        // A hook's `ms` times only the handler call itself, every time --
        // unlike the sampled `trap` phase this is the number a kernel's own
        // cost is read from, so it is not sampled.
        const hookStart = import.meta.BOTTLIFY_DIAGNOSTICS !== false && entry.hookStats !== null
            ? hookClock() : 0;
        const phased = import.meta.BOTTLIFY_DIAGNOSTICS !== false && this.phased;
        if (phased)
        {
            /** @type {NonNullable<Dispatcher['profiler']>} */ (this.profiler)
                .begin(entry.name, 'host');
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
                kinds[at] = FORWARDED;
            }
            else if (entry.hook)
            {
                // A hook's handler answers synchronously with whether it
                // computed the call itself; there is no guest to park or
                // wait for on this side of the decision.
                kinds[at] = result === true ? ANSWERED : FELL_THROUGH;
                this.answers[at] = result === true ? 1 : 0;
            }
            else if (isParkedCall(result))
            {
                kinds[at] = PARKED_KIND;
                late = true;
            }
            else if (isDriven(result))
            {
                // Steps: the first runs here, while the call still holds the
                // processor. Steps that call the guest for nothing answer now,
                // as a plain handler does; the rest the bridge runs on in this
                // slice.
                const first = result.steps.next();
                if (first.done)
                {
                    result = first.value;
                    kinds[at] = ANSWERED;
                    this.answers[at] = Number(result);
                }
                else
                {
                    result.first = first.value;
                    kinds[at] = WAITING;
                    late = true;
                }
            }
            else if (typeof (/** @type {any} */ (result))?.then === 'function')
            {
                kinds[at] = WAITING;
                late = true;
            }
            else
            {
                kinds[at] = ANSWERED;
                this.answers[at] = Number(result);
            }
        }
        finally
        {
            if (phased)
            {
                /** @type {NonNullable<Dispatcher['profiler']>} */ (this.profiler)
                    .end(entry.name);
            }
            if (charged >= 0)
            {
                if (slot !== null)
                {
                    slot[0] = charged;
                }
                else
                {
                    /** @type {(slot: number) => number} */ (charging)(charged);
                }
            }
            this.depth = depth;
            this.parking.endCall();
            // What this call left in the thread's last error. A program
            // reports a code long after whatever produced it returned, and
            // this is the only record that ties the two together. Not read
            // for a function that cannot have set it.
            if (entry.readsError)
            {
                const block = this.errorOffset < 0 ? 0 : frame.thread?.tebAddress ?? 0;
                const reader = this.reader;
                this.errors[at] = block === 0
                    ? this.lastError()
                    : reader !== null
                        ? reader.readU32(block + this.errorOffset)
                        : this.cpu.readU32(block + this.errorOffset);
            }
            if (this.onCall !== null && this.sinks(entry))
            {
                // As recorded, strings included only when tracing asked
                // for them. Peeking every argument for a sink that does
                // not read the strings cost more than the whole dispatch:
                // measured at 1.6 of 2.3 microseconds per call.
                this.onCall(this.sinkRecordOf(at, frame.thread));
            }
        }

        if (entry.hookStats !== null)
        {
            entry.hookStats.calls++;
            if (kinds[at] === ANSWERED)
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
            this.settleLate(entry, args, at, result, frame);
            return;
        }
        if (entry.hook)
        {
            this.finishHook(entry, kinds[at] === ANSWERED, args, pushed, esp);
            if (hookTraced)
            {
                this.traceHookExit(entry, KINDS[kinds[at]]);
            }
            return;
        }
        if (entry.saved !== 0)
        {
            // The stub saved with `pushad`, EAX first and EDI last; the
            // trap spent EAX and DX and nothing else. Put those two back
            // and drop the block, so the function it forwards into sees
            // the registers exactly as its caller set them.
            this.cpu.writeReg32('eax', this.memory.readU32(pushed + 28));
            this.cpu.writeReg32('edx', this.memory.readU32(pushed + 20));
            this.cpu.writeReg32('esp', esp);
            return;
        }
        // Asked again rather than reusing `regs`: the handler may have
        // grown the emulator's memory under the view.
        const answerTo = this.registers();
        if (answerTo === null)
        {
            this.cpu.writeReg32('eax', result >>> 0);
        }
        else
        {
            answerTo[EAX] = /** @type {number} */ (result) | 0;
        }
    }

    /**
     * @param {number} id
     * @param {HostFunction} fn
     */
    register(id, fn){
        if (this.functions[id] !== undefined)
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
        this.functions[id] = {
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
            readsError: this.errorReader && fn.lastError !== false,
            args: new Array(site ? 8 : stackWords + registerArgs),
            kept: Math.min(site ? 8 : stackWords + registerArgs, KEPT_ARGS),
            writer: typeof this.memory?.writer === 'function' ? this.memory.writer(fn.name) : -1,
            sinkRevision: -1,
            sinkOn: true,
            calls: 0,
            sampledMs: 0,
        };
        if (hook)
        {
            this.hooksByName.set(fn.name, id);
        }
        this.implemented++;
    }

    /** @param {number} id */
    lookup(id){
        return this.functions[id]?.fn ?? null;
    }

    /**
     * What lives at a guest address, when it is one of our stubs.
     *
     * @param {number} address
     * @returns {string | null}
     */
    symbolize(address){
        return this.byAddress.get(address >>> 0) ?? null;
    }

    /**
     * @param {number} address
     * @param {string} name
     */
    placed(address, name){
        this.byAddress.set(address >>> 0, name);
    }

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
        // One crossing in about TRAP_SAMPLE is timed, in every build, and its
        // time charged to the function it crossed into: what the host's share
        // of a run is made of, by function, at two clock reads a sample. A
        // title's menu makes tens of thousands of crossings a second and a
        // draw-heavy scene hundreds of thousands, and until this existed
        // there was no way to tell a machine slowed by its own emulation from
        // one slowed by leaving it so often.
        if (--this.untilSample > 0)
        {
            if (this.innerWeight === 0 || this.phased)
            {
                this.cross(id);
                return;
            }
            // An untimed crossing made from inside a timed one -- a callback
            // into the guest that calls the host again -- times nothing
            // inside it: what it does is in the timed crossing's own time.
            const outer = this.innerWeight;
            this.innerWeight = 0;
            try
            {
                this.cross(id);
            }
            finally
            {
                this.innerWeight = outer;
            }
            return;
        }
        this.untilSample = this.sampleInterval();
        this.sampleCaller = true;
        const profiler = import.meta.BOTTLIFY_DIAGNOSTICS !== false ? this.profiler : null;
        profiler?.begin('trap', 'host');
        const outer = this.innerWeight;
        if (profiler && !this.phased)
        {
            this.innerWeight = TRAP_SAMPLE;
        }
        const began = performance.now();
        try
        {
            this.cross(id);
        }
        finally
        {
            const entry = this.functions[id];
            if (entry !== undefined)
            {
                entry.sampledMs += performance.now() - began;
            }
            this.innerWeight = outer;
            profiler?.end('trap', TRAP_WEIGHT);
        }
    }

    /**
     * Opens a phase inside the host call being made, for the work a call
     * does before or around what it was asked for: timed when the crossing
     * is, one in about TRAP_SAMPLE, and weighed as the crossing is -- a
     * second clock beside the crossing's would cost what sampling saves.
     *
     * @param {string} name
     * @returns {number} what it stands for, to hand to `innerEnd`; 0, not opened
     */
    innerBegin(name){
        const weight = this.innerWeight;
        if (import.meta.BOTTLIFY_DIAGNOSTICS !== false && weight !== 0)
        {
            /** @type {NonNullable<Dispatcher['profiler']>} */ (this.profiler).begin(name, 'host');
            return weight;
        }
        return 0;
    }

    /**
     * @param {string} name
     * @param {number} weight  what `innerBegin` answered; 0 closes nothing
     */
    innerEnd(name, weight){
        if (import.meta.BOTTLIFY_DIAGNOSTICS !== false && weight !== 0)
        {
            /** @type {NonNullable<Dispatcher['profiler']>} */ (this.profiler)
                .end(name, weight === 1 ? undefined : INNER_WEIGHT);
        }
    }

    /**
     * The crossing itself, with the phase above already open.
     *
     * @param {number} id
     */
    dispatchNow(id){
        this.cross(id);
    }

    /**
     * Closes the rate window if a whole one has passed: each function's calls
     * and host time in it, per second, and the ones over the chatty
     * thresholds kept for the report.
     */
    measureRates(){
        const now = this.now();
        const elapsed = now - this.windowStart;
        if (elapsed < RATE_WINDOW_MS)
        {
            return;
        }
        this.windowStart = now;
        /** @type {{ name: string, perSecond: number, msPerSecond: number }[]} */
        const over = [];
        for (const entry of this.functions)
        {
            if (!entry)
            {
                continue;
            }
            const calls = entry.calls - (entry.windowCalls ?? 0);
            const ms = (entry.sampledMs - (entry.windowMs ?? 0)) * TRAP_SAMPLE;
            entry.windowCalls = entry.calls;
            entry.windowMs = entry.sampledMs;
            const perSecond = calls * 1000 / elapsed;
            const msPerSecond = ms * 1000 / elapsed;
            if (perSecond >= CHATTY_CALLS_PER_SECOND || msPerSecond >= CHATTY_MS_PER_SECOND)
            {
                over.push({ name: entry.name, perSecond, msPerSecond });
            }
        }
        over.sort((left, right)=>right.msPerSecond - left.msPerSecond
            || right.perSecond - left.perSecond);
        this.chatty = over.slice(0, CHATTY_KEPT).map(({ name, perSecond, msPerSecond })=>
            `${name} ${Math.round(perSecond)}/s ${Math.round(msPerSecond)}ms/s`);
        const journal = this.journal;
        for (const { name, perSecond, msPerSecond } of over)
        {
            if (this.chattyNoted.has(name))
            {
                continue;
            }
            this.chattyNoted.add(name);
            journal?.write(journal.Level.WARN ?? journal.Level.TRACE, 'call.chatty',
                '{0} goes to the host {1} times a second, {2} ms of each second',
                name, Math.round(perSecond), Math.round(msPerSecond));
        }
    }

    diagnostics(){
        this.measureRates();
        const entries = /** @type {Entry[]} */ (this.functions.filter(Boolean));
        return {
            implemented: this.implemented,
            calls: this.callCount,
            lastCall: this.ringCount === 0 ? null
                : this.nameAt((this.ringCount - 1) & CALL_RING - 1),
            // What the guest has been doing, rather than the one thing it did
            // last. A program stuck in a loop says so here in a line; a stack
            // trace only shows where the loop was when it was interrupted.
            hot: this.hot(40),
            // Where the host's time went, by function, since the start: the
            // calls made and the ms the timed ones stand for, the heaviest
            // first.
            // The functions going to the host too often or for too long a
            // second, over the last whole second measured (`measureRates`).
            chatty: this.chatty,
            hostMs: Math.round(entries.reduce((sum, entry)=>sum + entry.sampledMs, 0)
                * TRAP_SAMPLE),
            byFunction: entries
                .filter(entry=>entry.calls > 0)
                .sort((left, right)=>right.sampledMs - left.sampledMs || right.calls - left.calls)
                .slice(0, BY_FUNCTION_KEPT)
                .map(entry=>`${entry.name} ${entry.calls} ${
                    Math.round(entry.sampledMs * TRAP_SAMPLE)}ms${entry.callers
                    ? ` from ${[...entry.callers].sort((a, b)=>b[1] - a[1]).slice(0, 3)
                        .map(([from, count])=>`0x${(from >>> 0).toString(16)}x${count}`)
                        .join(',')}` : ''}${entry.chains
                    ? ` via ${[...entry.chains].sort((a, b)=>b[1] - a[1]).slice(0, 3)
                        .map(([chain, count])=>`${chain}x${count}`).join(',')}` : ''}`),
        };
    }

    /**
     * Keeps the functions named out of the ring of recent calls, or none with
     * an empty list: a debugging aid for reading what a program did around
     * one moment when a loop of a few calls drowns it. Matched by the name
     * after the library's, `ShowWindow` for `USER32.dll!ShowWindow`; every
     * function of that name, either width's too when its suffix is left off.
     *
     * @param {string[]} names
     * @returns {string[]} the functions kept out
     */
    skipInRing(names){
        const wanted = new Set(names.map(name=>name.trim()).filter(Boolean));
        this.ringSkip.clear();
        /** @type {string[]} */
        const skipped = [];
        this.functions.forEach((entry, id)=>{
            const bare = entry?.name.slice(entry.name.indexOf('!') + 1) ?? '';
            if (entry && (wanted.has(bare) || wanted.has(bare.replace(/[AW]$/, ''))))
            {
                this.ringSkip.add(id);
                skipped.push(entry.name);
            }
        });
        return skipped;
    }

    /**
     * The last few calls with what was asked and what was answered, oldest
     * first. Read backwards from a failure, this is where an answer that
     * was wrong rather than missing shows itself.
     *
     * @param {number} [count]
     */
    detailed(count = CALL_RING){
        const kept = Math.min(count, this.ringCount, CALL_RING);
        /** @type {any[]} */
        const out = [];
        for (let back = kept; back > 0; back--)
        {
            const copy = this.recordAt((this.ringCount - back) & CALL_RING - 1);
            copy.strings ??= copy.args.map(value=>this.peekString(value));
            out.push(copy);
        }
        return out;
    }

    /** @param {number} at  A slot of the ring. */
    nameAt(at){
        return /** @type {Entry} */ (this.functions[this.ids[at]]).name;
    }

    /**
     * A slot of the ring as a record a reader may keep: the ring writes over
     * its own when it comes round.
     *
     * @param {number} at
     */
    recordAt(at){
        const kind = KINDS[this.kinds[at]];
        /** @type {number[]} */
        const args = [];
        for (let i = 0; i < this.argCounts[at]; i++)
        {
            args.push(this.argWords[at * KEPT_ARGS + i]);
        }
        return {
            name: this.nameAt(at),
            from: this.froms[at] >>> 0,
            args,
            strings: this.strings[at]?.slice() ?? null,
            kind,
            result: kind === 'answered' ? `0x${(this.answers[at] >>> 0).toString(16)}` : kind,
            error: this.errors[at],
        };
    }

    /**
     * A slot of the ring as the record a sink is handed, written over for
     * the next call: a sink has it for the length of its call and nothing
     * longer.
     *
     * @param {number} at @param {{ name?: string } | null} thread  whose call it was
     */
    sinkRecordOf(at, thread){
        const record = this.sinkRecord;
        const kept = this.argCounts[at];
        const args = this.sinkArgs[kept] ??= new Array(kept);
        for (let i = 0; i < kept; i++)
        {
            args[i] = this.argWords[at * KEPT_ARGS + i];
        }
        record.name = this.nameAt(at);
        record.from = this.froms[at] >>> 0;
        record.args = args;
        record.strings = this.traceStrings ? this.strings[at] : null;
        record.error = this.errors[at];
        record.answer = this.answers[at];
        record.kind = KINDS[this.kinds[at]];
        record.thread = thread?.name ?? null;
        return record;
    }

    /**
     * The calls the guest has made, oldest first -- as many as the ring
     * still holds, which is every one of them until it wraps.
     */
    calls(){
        return this.history(this.ringCount);
    }

    /** @param {number} count @returns {string[]} the last few, oldest first */
    recent(count){
        return this.history(Math.min(count, CALL_RING));
    }

    /**
     * A kernel's own comparison against the guest failed. Named rather
     * than aimed at an id, because whoever built the kernel only ever
     * knew the hook by its name -- the oracle's own differential check is
     * the kernel's business, not this dispatcher's; this only counts it.
     *
     * @param {string} name
     */
    reportMismatch(name){
        const id = this.hooksByName.get(name);
        const entry = id === undefined ? undefined : this.functions[id];
        if (entry?.hookStats)
        {
            entry.hookStats.mismatches++;
        }
    }

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
        for (const [name, id] of this.hooksByName)
        {
            const stats = this.functions[id]?.hookStats;
            if (stats)
            {
                out.push({ name, ...stats });
            }
        }
        return out;
    }
}
