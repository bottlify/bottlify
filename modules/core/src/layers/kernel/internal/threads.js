/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Threads and the queue they take turns in.
 *
 * A thread is its saved CPU state, its stack, its TEB, and where it is in the
 * lifecycle. The scheduler here gives each turn to the highest-priority ready
 * thread and round-robins among equals, with the quantum counted in retired
 * guest instructions -- so the point at which one thread yields to another is
 * a function of what the guest did, not of how fast the host happens to be.
 *
 * Priority is composed the way Windows composes it: the process's class gives
 * a base of 8 and the thread's relative priority moves it by up to two, with
 * the two saturating values (idle, time-critical) pinned to 1 and 15. A
 * program that streams sound raises its feeder above the thread that draws,
 * and the order in which the two get the machine is what it is asking for.
 */

/** @enum {string} */
export const ThreadState = {
    /** Runnable, waiting for a turn. */
    READY: 'ready',
    /** On the CPU right now. */
    RUNNING: 'running',
    /** Waiting for something; not a candidate until woken. */
    BLOCKED: 'blocked',
    /** Finished. Its handle may outlive it. */
    TERMINATED: 'terminated',
};

/** How finely the guest's whereabouts are recorded: one entry per 64 KiB. */
const PAGE = 0x10000;

/**
 * What the scheduler publishes as numbers, for a reader on another thread.
 *
 * The counters are one row in this order; the thread table has a row per
 * thread with names as dictionary ids; the slow-slice table the eight slices
 * that held the machine longest. Written where the figure changes or once a
 * frame -- never walked on request.
 */
export const SCHEDULER_COUNTERS = [
    'quantum', 'turns', 'overruns', 'worstSlice', 'worstSliceAt', 'worstSliceFrom',
    'worstSliceMs', 'expiries', 'boosts', 'stackEscapes', 'threads', 'current',
];
export const THREAD_COLUMNS = [
    'id', 'name', 'instructions', 'state', 'priority', 'boosts', 'boosted', 'waitingOn',
    'stackUsed', 'stackSize',
];
export const THREAD_ROWS = 512;
export const SLOW_SLICE_COLUMNS = ['ms', 'instructions', 'from', 'at', 'thread'];
/** A thread's state as the table stores it. */
export const THREAD_STATES = ['ready', 'running', 'blocked', 'terminated'];

/** The base of the normal priority class, and the two relative values pinned outside it. */
const NORMAL_BASE = 8;
const THREAD_PRIORITY_IDLE = -15;
const THREAD_PRIORITY_TIME_CRITICAL = 15;
/** Above anything a thread can ask for: what a starved thread is raised to for one turn. */
const STARVED = 16;

/**
 * A thread's absolute priority, from the relative one a program set on it.
 *
 * @param {number} relative
 */
export function absolutePriority(relative){
    if (relative === THREAD_PRIORITY_IDLE)
    {
        return 1;
    }
    if (relative === THREAD_PRIORITY_TIME_CRITICAL)
    {
        return 15;
    }
    return NORMAL_BASE + relative;
}

/**
 * @param {Object} options
 * @param {any} options.cpu        The cpu layer's API.
 * @param {any} options.switcher   The single switch primitive.
 * @param {number} [options.quantum]  Retired instructions per turn.
 * @param {number} [options.starvation]
 *        Guest milliseconds a ready thread may be passed over before it is
 *        raised above everything for one turn. Windows uses about four seconds.
 * @param {() => number} [options.now]  The guest's clock, for timed waits and starvation.
 * @param {(deadline: number) => number} [options.skipTo]
 *        Moves the guest's clock to a deadline when every thread is waiting on
 *        one, and answers how far it actually moved -- which is nothing once the
 *        clock has caught up with the host's.
 * @param {(thread: any, reason: string | null, value: number) => void} [options.onResume]
 *        Told what a parked thread is resumed with, and from which wait.
 * @param {() => number} [options.wall]  The host's clock, for how long a slice held the machine.
 * @param {Float64Array} [options.pages]
 *        Retired instructions by 64 KiB page, one entry per page of guest
 *        memory and a last one for anywhere else. Credited in place.
 * @param {Float64Array} [options.counters]   One entry per `SCHEDULER_COUNTERS`.
 * @param {{ set: (row: number, column: number, value: number) => void,
 *     used: (count: number) => void, rows: number }} [options.threadTable]
 * @param {{ set: (row: number, column: number, value: number) => void,
 *     used: (count: number) => void, rows: number }} [options.slowSliceTable]
 * @param {(text: string) => number} [options.intern]  A name as a dictionary id.
 */
export function createScheduler(options){
    const { cpu, switcher, quantum = 100_000, now = ()=>0, skipTo = ()=>0 } = options;
    // A gigabyte's worth of pages when nobody says: what a machine is given
    // by default, and small enough to make for every scheduler a test builds.
    const pages = options.pages ?? new Float64Array(1024 * 1024 * 1024 / PAGE + 1);
    const counters = options.counters ?? new Float64Array(SCHEDULER_COUNTERS.length);
    const threadTable = options.threadTable ?? null;
    const slowSliceTable = options.slowSliceTable ?? null;
    const intern = options.intern ?? (()=>-1);
    counters[0] = quantum;
    const starvation = options.starvation ?? 4000;
    /** Turns given to a thread because it had been passed over too long. */
    let boosts = 0;
    const wall = options.wall ?? (()=>performance.now());
    /**
     * Told what a parked thread is about to be resumed with: which wait it
     * was in and the value the call answers. The only record of that answer
     * -- the call was logged as parked when it began, and the value is put
     * straight into a register when the thread comes back.
     *
     * @type {((thread: any, reason: string | null, value: number) => void) | null}
     */
    const onResume = options.onResume ?? null;
    /** Turns where the emulator ran past the slice it was given, and the worst. */
    let overruns = 0;
    let worstSlice = 0;
    /**
     * Where the worst one ended and on which thread. A number alone says the
     * slice was overrun; an address says which code did it.
     */
    let worstSliceAt = 0;
    /** And where it began, which is the code that ran for all of it. */
    let worstSliceFrom = 0;
    /** @type {string | null} */
    let worstSliceOn = null;
    /**
     * The slices that held the machine longest, by the host's clock. An
     * instruction count says the emulator ran past its bound; a time says a
     * frame and the sound ring waited, whether the count was over or not --
     * a slice of a hundred thousand instructions that each take a microsecond
     * is a freeze the count alone would never show. Kept few and sorted, so
     * a report names the worst offenders with where they ran.
     *
     * @type {{ ms: number, instructions: number, from: number, at: number,
     *     thread: string | null }[]}
     */
    const slowSlices = [];
    const SLOW_SLICES_KEPT = 8;
    const SLOW_SLICE_MS = 40;
    /** @type {any[]} */
    const threads = [];
    /** @type {any} */
    let current = null;
    let nextId = 1;
    let turns = 0;
    /**
     * Where the machine went, by 64 KiB page of guest code.
     *
     * A sampling profile taken at slice boundaries: the address is the one the
     * slice started at and the weight is everything it retired, so a slice that
     * ran through several pages is credited entirely to the first. Across
     * thousands of slices that averages out to where the guest actually is, and
     * it is the only account of that available -- the emulator's own profiler
     * is compiled out of the build we vendor. Coarse deliberately: a page is
     * enough to name the module, and per-address would cost an entry for
     * every basic block the guest ever entered.
     *
     * One add into a flat array, indexed by page: no map, no bound to hit,
     * nothing to sort here. Whoever reads it sorts it on their own thread.
     * An address past the array's span -- the guest jumped somewhere that is
     * not memory -- is credited to the last entry.
     *
     * @param {number} address @param {number} instructions
     */
    const creditPage = (address, instructions)=>{
        const page = Math.floor((address >>> 0) / PAGE);
        pages[page < pages.length - 1 ? page : pages.length - 1] += instructions;
    };
    let expiries = 0;
    /**
     * Threads whose stack pointer has been seen outside the stack they were
     * given, and the worst one.
     *
     * A stack that overflows into whatever is under it corrupts silently: the
     * thread below loses its locals and its return addresses, and what fails is
     * that thread, later, at an address holding no code. Nothing said how much
     * of its stack a thread was using, so a run that ended in a wild stack
     * pointer offered no way to tell an overflow from a corrupted frame. This
     * is that fact, measured once a turn.
     *
     * @type {string[]}
     */
    const escaped = [];
    /** @type {Map<any, number>} */
    const lowWater = new Map();
    /** @type {((thread: any) => void)[]} */
    const onExpiry = [];

    // A thread parked on a host call that has not answered is not a candidate.
    // It is stopped on `hlt` with nothing of its own to run, and counting it as
    // ready is what kept `soonest()` below out of reach: with one such thread
    // the scheduler always had someone to give a turn to, so it never moved the
    // clock to the next deadline and every timed wait in the guest expired in
    // host time instead of guest time.
    const ready = ()=>threads.filter(thread=>
        thread.state === ThreadState.READY && !thread.awaitingHost);

    /**
     * Where a thread's stack pointer stood at the end of its slice.
     *
     * Read once a turn rather than per instruction: an overflow is not a moment
     * but a direction of travel, and a turn's resolution is enough to see it.
     *
     * @param {any} thread
     */
    const watchStack = thread=>{
        if (thread.stackTop === undefined || thread.stackLimit === undefined)
        {
            return;
        }
        const esp = cpu.readReg32('esp') >>> 0;
        const low = lowWater.get(thread);
        if (low === undefined || esp < low)
        {
            lowWater.set(thread, esp);
        }
        if ((esp < thread.stackLimit || esp > thread.stackTop)
            && !escaped.some(entry=>entry.startsWith(`${thread.name}:`)))
        {
            escaped.push(`${thread.name}: esp 0x${esp.toString(16)} outside`
                + ` 0x${(thread.stackLimit >>> 0).toString(16)}`
                + `..0x${(thread.stackTop >>> 0).toString(16)}`);
        }
    };

    /**
     * A time before which no deadline can pass: every deadline set since the
     * last scan is at or after it. The scan for expired waits ran on every
     * turn and looked at every thread, tens of thousands of times a second,
     * to find nothing nearly every time; now it runs only once the clock has
     * reached this. It is a lower bound, not the soonest deadline: a wait
     * that ends early leaves it where it was, which costs one empty scan.
     *
     * @type {number | null}
     */
    let noDeadlineBefore = null;

    /** The soonest deadline any blocked thread is waiting on, or null. */
    const soonest = ()=>threads.reduce((best, thread)=>(
        thread.state === ThreadState.BLOCKED && thread.deadline !== null
        && thread.deadline !== undefined && (best === null || thread.deadline < best)
            ? thread.deadline
            : best), /** @type {number | null} */ (null));

    /**
     * Wakes every thread whose deadline has passed.
     *
     * A timed wait that expires is not a failure: the thread runs again and its
     * call answers that the time ran out, which is a result a program acts on
     * rather than an error it reports. Whoever put the thread on a waiter list
     * is told, so the list does not keep a thread that has stopped waiting.
     */
    const expire = ()=>{
        if (noDeadlineBefore === null)
        {
            return;
        }
        const at = now();
        if (at < noDeadlineBefore)
        {
            return;
        }
        noDeadlineBefore = null;
        for (const thread of threads)
        {
            if (thread.state !== ThreadState.BLOCKED
                || thread.deadline === null || thread.deadline === undefined
                || thread.deadline > at)
            {
                continue;
            }
            thread.deadline = null;
            thread.waitResult = thread.timeoutResult ?? 0;
            thread.state = ThreadState.READY;
            thread.readySince = at;
            thread.waitingOn = null;
            expiries++;
            for (const told of onExpiry)
            {
                told(thread);
            }
        }
        noDeadlineBefore = soonest();
    };

    return {
        /**
         * Creates a thread. It does not run yet, and creating it does not move
         * the CPU: the creator has not necessarily finished setting up whatever
         * the new thread is about to read (§12.4).
         *
         * @param {Object} options
         * @param {number} options.entry
         * @param {number} options.stackTop
         * @param {number} [options.stackLimit]  The low end of the same stack, when known.
         * @param {number} options.tebAddress
         * @param {string} [options.name]
         * @returns {any} the thread
         */
        create({ entry, stackTop, stackLimit, tebAddress, name }){
            const thread = {
                id: nextId++,
                name: name ?? `thread-${nextId - 1}`,
                state: ThreadState.READY,
                tebAddress,
                stackTop,
                // Both ends, so anything writing on this thread's behalf can
                // check that what it wrote landed on this thread's stack.
                stackLimit,
                entry,
                context: cpu.newContext({ entry, stackTop }),
                instructions: 0,
                exitCode: null,
                /**
                 * The relative priority a program set, in Windows's own
                 * values; the absolute one is composed at each turn.
                 */
                priority: 0,
                /** When it last became ready without running: what starvation is measured from. */
                readySince: now(),
                /** Turns it was given for having been passed over too long. */
                boosts: 0,
                boosted: false,
                /** What it is waiting for, when blocked; for diagnostics. */
                waitingOn: null,
                /**
                 * Set while a host call this thread made has not answered. Such
                 * a thread is ready in every other sense and has nothing to run.
                 */
                awaitingHost: false,
                // A thread is a waitable object in its own right: a program
                // joins one by waiting on its handle, and it becomes signalled
                // when it ends and stays that way. Carried here rather than in
                // a parallel table so that the thing a handle resolves to is
                // the thing a wait examines.
                kind: 'thread',
                /** @type {any[]} */
                waiters: [],
            };
            threads.push(thread);
            return thread;
        },

        /** @returns {any} the thread on the CPU, or null */
        current: ()=>current,

        /** @returns {any[]} */
        all: ()=>[...threads],

        /**
         * Gives the CPU to the next ready thread and lets it run a quantum.
         *
         * Returns what happened, so a caller driving the machine can tell the
         * difference between progress, an idle system and a finished one --
         * three states that look identical if all you get back is a number.
         *
         * @returns {{ ran: any | null, instructions: number, switched: boolean }}
         */
        runOnce(){
            expire();
            let candidates = ready();
            if (candidates.length === 0)
            {
                // Nothing can run, but something is waiting for a time rather
                // than for another thread. Idling in wall clock would be a real
                // pause for no reason -- the guest's clock is ours to move, and
                // moving it to the soonest deadline is exactly what a machine
                // with nothing to do does.
                const deadline = soonest();
                if (deadline === null)
                {
                    return { ran: null, instructions: 0, switched: false };
                }
                // Nothing to gain from sitting through a wait in real time --
                // and nothing to be had by moving past real time either, which
                // is why the clock, not this, decides how far it goes. When it
                // answers zero the machine really does have to wait.
                if (skipTo(deadline) === 0)
                {
                    return { ran: null, instructions: 0, switched: false };
                }
                expire();
                candidates = ready();
                if (candidates.length === 0)
                {
                    return { ran: null, instructions: 0, switched: false };
                }
            }

            // The highest priority runs; among equals the queue order decides,
            // and a thread that has just run goes behind the others by being
            // moved to the back. A thread passed over for longer than the
            // starvation bound outranks everyone for this one turn, so a busy
            // high-priority thread can never hold the machine for ever.
            let next = candidates[0];
            if (candidates.length > 1)
            {
                const at = now();
                /** @param {any} thread */
                const rank = thread=>(at - thread.readySince >= starvation
                    ? STARVED
                    : absolutePriority(thread.priority));
                let best = rank(next);
                for (let i = 1; i < candidates.length; i++)
                {
                    const contender = rank(candidates[i]);
                    if (contender > best)
                    {
                        best = contender;
                        next = candidates[i];
                    }
                }
                if (best === STARVED)
                {
                    next.boosted = true;
                    next.boosts++;
                    boosts++;
                }
            }

            // A thread that parked was stopped mid-call: put it back where it
            // belongs, carrying whatever its wait produced. Deciding that here
            // and applying it inside the switch means it happens exactly once,
            // after the thread's own state has been saved -- which matters most
            // when the thread coming back is the one already on the CPU.
            let resume = null;
            if (next.parkedReturn !== null && next.parkedReturn !== undefined)
            {
                resume = {
                    eip: next.parkedReturn,
                    esp: next.resumeStack ?? null,
                    returnValue: next.waitResult ?? 0,
                };
                onResume?.(next, next.lastWaitingOn ?? null, resume.returnValue >>> 0);
                next.parkedReturn = null;
                next.resumeStack = null;
                next.waitResult = null;
            }
            // Whatever `current` is, it is the thread whose state is on the CPU,
            // and it has to be saved before another one takes over -- including,
            // especially, a thread that has just blocked. Saving only threads
            // still marked RUNNING loses the state of every thread that parked
            // itself in a wait, which then resumes from wherever it first began.
            const switched = switcher.switchTo(current, next, resume);

            if (current && current.state === ThreadState.RUNNING)
            {
                current.state = ThreadState.READY;
                current.readySince = now();
            }
            current = next;
            next.state = ThreadState.RUNNING;

            // Before the slice, not after: the value on the processor when a
            // slice ends in a fault belongs to the fault stub, and reading that
            // would report every faulting thread as having left its stack.
            watchStack(next);
            const from = cpu.eip?.() ?? 0;
            const began = wall();
            const instructions = cpu.runSlice(quantum);
            const held = wall() - began;
            next.instructions += instructions;
            const slowest = slowSlices[slowSlices.length - 1];
            const kept = slowSlices.length < SLOW_SLICES_KEPT || held > slowest.ms;
            if (held >= SLOW_SLICE_MS && kept)
            {
                slowSlices.push({
                    ms: held, instructions, from, at: cpu.eip?.() ?? 0, thread: next.name ?? null,
                });
                slowSlices.sort((a, b)=>b.ms - a.ms);
                slowSlices.length = Math.min(slowSlices.length, SLOW_SLICES_KEPT);
                if (slowSliceTable)
                {
                    // Rare by definition -- forty milliseconds and up -- so
                    // rewriting the eight rows here costs nothing that matters.
                    for (let row = 0; row < slowSlices.length; row++)
                    {
                        const slice = slowSlices[row];
                        slowSliceTable.set(row, 0, slice.ms);
                        slowSliceTable.set(row, 1, slice.instructions);
                        slowSliceTable.set(row, 2, slice.from);
                        slowSliceTable.set(row, 3, slice.at);
                        slowSliceTable.set(row, 4, intern(slice.thread ?? '?'));
                    }
                    slowSliceTable.used(slowSlices.length);
                }
            }
            creditPage(from, instructions);
            turns++;
            counters[1] = turns;
            // Whether the slice we asked for is the slice we got.
            //
            // A quantum is how long a thread may hold the machine before
            // anything else -- another thread, a message, a frame -- gets a
            // look. Nothing checked that the emulator honoured it, so an
            // emulator that ran four times the instructions asked for would
            // hold the machine four times as long and say nothing, and the only
            // symptom would be a frame rate nobody could account for. Asking is
            // not knowing; this is the knowing.
            if (instructions > quantum)
            {
                overruns++;
                if (instructions > worstSlice)
                {
                    worstSlice = instructions;
                    worstSliceAt = cpu.eip?.() ?? 0;
                    worstSliceFrom = from;
                    worstSliceOn = next.name ?? null;
                }
            }

            next.boosted = false;
            if (next.state === ThreadState.RUNNING)
            {
                next.state = ThreadState.READY;
                next.readySince = now();
                // To the back of the queue, so the next call picks someone else.
                threads.splice(threads.indexOf(next), 1);
                threads.push(next);
            }

            return { ran: next, instructions, switched };
        },

        /**
         * @param {any} thread
         * @param {string} [reason]  What it is waiting for, for diagnostics.
         * @param {Object} [timed]
         * @param {number} [timed.deadline]  Guest time after which it wakes anyway.
         * @param {number} [timed.result]    What the call answers when it does.
         */
        block(thread, reason, timed){
            thread.state = ThreadState.BLOCKED;
            thread.waitingOn = reason ?? null;
            // Kept past the wake, so the resume can still say what was waited
            // for: the wake clears the live reason.
            thread.lastWaitingOn = reason ?? null;
            thread.deadline = timed?.deadline ?? null;
            thread.timeoutResult = timed?.result ?? 0;
            if (thread.deadline !== null
                && (noDeadlineBefore === null || thread.deadline < noDeadlineBefore))
            {
                noDeadlineBefore = thread.deadline;
            }
        },

        /** @param {any} thread */
        wake(thread){
            if (thread.state !== ThreadState.BLOCKED)
            {
                return false;
            }
            thread.state = ThreadState.READY;
            thread.readySince = now();
            thread.waitingOn = null;
            thread.deadline = null;
            return true;
        },

        /**
         * Told when a thread's wait ran out of time, so whoever queued it can
         * take it off whatever it was queued on.
         *
         * @param {(thread: any) => void} handler
         */
        onTimeout(handler){
            onExpiry.push(handler);
        },

        /** Whether any thread is waiting on a time rather than on another thread. */
        nextDeadline: ()=>soonest(),

        /** @param {any} thread @param {number} exitCode */
        terminate(thread, exitCode){
            thread.state = ThreadState.TERMINATED;
            thread.exitCode = exitCode;
            if (current === thread)
            {
                current = null;
            }
        },

        /**
         * How far down its own stack a thread has been, and whether it left it.
         *
         * @param {any} thread
         */
        stackUse(thread){
            return {
                lowest: lowWater.get(thread) ?? null,
                limit: thread.stackLimit ?? null,
                top: thread.stackTop ?? null,
            };
        },

        /**
         * Where the guest ran, by 64 KiB page, weighted by the instructions
         * that slice retired. Addresses rather than names: what a page belongs
         * to is known where the images are mapped, not here.
         *
         * A walk of every page of guest memory, for a caller on this thread
         * that wants the table as an object. A reader elsewhere has the array
         * itself and never asks.
         *
         * @returns {Record<string, number>} page base in hex, to instructions
         */
        pages(){
            /** @type {Record<string, number>} */
            const report = {};
            for (let page = 0; page < pages.length; page++)
            {
                if (pages[page] > 0)
                {
                    report[`0x${(page * PAGE).toString(16)}`] = pages[page];
                }
            }
            return report;
        },

        /**
         * Copies what changes too often to store as it changes -- a thread's
         * state, its instructions, what it waits on -- into the shared
         * tables. Once a frame, a few stores per thread.
         */
        publish(){
            counters[2] = overruns;
            counters[3] = worstSlice;
            counters[4] = worstSliceAt;
            counters[5] = worstSliceFrom;
            counters[6] = slowSlices.length > 0 ? slowSlices[0].ms : 0;
            counters[7] = expiries;
            counters[8] = boosts;
            counters[9] = escaped.length;
            counters[10] = threads.length;
            counters[11] = current ? current.id : -1;
            if (!threadTable)
            {
                return;
            }
            const rows = Math.min(threads.length, threadTable.rows);
            for (let row = 0; row < rows; row++)
            {
                const thread = threads[row];
                threadTable.set(row, 0, thread.id);
                threadTable.set(row, 1, intern(thread.name));
                threadTable.set(row, 2, thread.instructions);
                threadTable.set(row, 3, THREAD_STATES.indexOf(thread.state));
                threadTable.set(row, 4, absolutePriority(thread.priority));
                threadTable.set(row, 5, thread.boosts);
                threadTable.set(row, 6, thread.boosted ? 1 : 0);
                threadTable.set(row, 7, thread.waitingOn ? intern(thread.waitingOn) : -1);
                const low = lowWater.get(thread);
                threadTable.set(row, 8, low !== undefined && thread.stackTop !== undefined
                    ? thread.stackTop - low : 0);
                threadTable.set(row, 9,
                    thread.stackTop !== undefined && thread.stackLimit !== undefined
                        ? thread.stackTop - thread.stackLimit : 0);
            }
            threadTable.used(rows);
        },

        diagnostics(){
            /** @type {Record<string, number>} */
            const byState = {};
            for (const thread of threads)
            {
                byState[thread.state] = (byState[thread.state] ?? 0) + 1;
            }
            return {
                quantum,
                turns,
                // Zero is the answer everyone assumes and nobody had checked.
                overruns,
                worstSlice,
                worstSliceAt,
                worstSliceFrom,
                worstSliceOn,
                worstSliceMs: slowSlices.length > 0 ? Math.round(slowSlices[0].ms) : 0,
                slowSlices: slowSlices.map(s=>`${Math.round(s.ms)}ms ${s.instructions} ${
                    s.thread ?? '?'} 0x${s.from.toString(16)}->0x${s.at.toString(16)}`).join('; '),
                // Timed waits that ran out rather than being satisfied.
                expiries,
                // Turns handed out against priority, to a thread passed over
                // too long. A steady count is a high-priority thread that
                // never yields, which a program does not mean to do.
                boosts,
                // Empty in a healthy run: a thread's stack pointer belongs
                // inside the stack it was given, and anywhere else is memory
                // somebody else owns. Strings rather than a list, because a
                // report keeps the flat metrics and drops the shaped ones.
                stackEscapes: escaped.length,
                stackEscaped: escaped.join('; '),
                deepestStackUse: [...lowWater]
                    .filter(([thread])=>thread.stackTop !== undefined)
                    .map(([thread, low])=>`${thread.name} ${
                        thread.stackTop - low}/${thread.stackTop - thread.stackLimit}`)
                    .join(' '),
                threads: threads.length,
                byState,
                // Which thread the machine actually spent itself on. A run that
                // is too slow at something -- feeding a sound device, drawing --
                // is either a machine running everything slowly or one thread
                // starved by another, and the totals cannot tell those apart.
                // Instructions retired, because that is what a quantum is
                // measured in here and so it is the only currency the scheduler
                // and the thread agree on. Then the absolute priority it runs
                // at and how often it had to be boosted to run at all.
                byThread: threads
                    .map(thread=>`${thread.name} ${thread.instructions} ${thread.state} p${
                        absolutePriority(thread.priority)} b${thread.boosts}${
                        thread.boosted ? '+' : ''}`)
                    .join(' | '),
                current: current ? current.name : null,
                // A thread that has been waiting on the same thing for a long
                // time is the shape of a deadlock, so name what each is waiting on.
                waiting: threads
                    .filter(thread=>thread.state === ThreadState.BLOCKED)
                    .map(thread=>`${thread.name}: ${thread.waitingOn ?? 'unknown'}`),
            };
        },
    };
}
