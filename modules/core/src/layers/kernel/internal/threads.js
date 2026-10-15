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

import { signalledNow } from './sync.js';
import { takeId } from './processes.js';

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
    // Which of the program's threads the machine was spent on since these
    // were last published, and where its heaviest single slice began. Every
    // other figure here is the run's; these three are the interval's, because
    // the question they answer -- which thread and which module made this
    // frame slow -- has no answer averaged over a run.
    'frameThread', 'frameThreadInstructions', 'frameAt',
];
export const THREAD_COLUMNS = [
    'id', 'name', 'instructions', 'state', 'priority', 'boosts', 'boosted', 'waitingOn',
    'stackUsed', 'stackSize',
];
export const THREAD_ROWS = 512;
export const SLOW_SLICE_COLUMNS = ['ms', 'instructions', 'from', 'at', 'thread'];
/** A thread's state as the table stores it. */
export const THREAD_STATES = ['ready', 'running', 'blocked', 'terminated'];

/** How many seconds back the busy time by thread is kept. */
const BUSY_SECONDS = 10;

/** How far off, in guest ms, the soonest deadline must be for a turn to be a solo one. */
const SOLO_CLEAR_MS = 16;

/** A wait this short or shorter, in guest ms, is a thread working in short periods. */
const SHORT_WAIT_MS = 20;

/** A short-period thread kept off the processor this long, in host ms, is counted late. */
const LATE_GAP_MS = 40;

/**
 * The longest this executor waits, in host ms, for the others with nothing of its
 * own to run before its turn ends: they keep their threads while nothing waits for
 * one, and the turn's caller moves the guest's clock and looks at the event loop.
 */
const EXECUTORS_WAIT_MS = 4;

/**
 * The longest a turn waits, in host ms, for an executor whose thread an answer
 * parked to give its slice back: it ends at its next instruction, a park loop's.
 */
const ENDING_WAIT_MS = 1000;

/** The base of the normal priority class, and the two relative values pinned outside it. */
const NORMAL_BASE = 8;
const THREAD_PRIORITY_IDLE = -15;
const THREAD_PRIORITY_TIME_CRITICAL = 15;
/** Above anything a thread can ask for: what a starved thread is raised to for one turn. */
const STARVED = 16;
/** MAXIMUM_SUSPEND_COUNT: how many suspensions a thread can carry at once. */
const MAXIMUM_SUSPEND_COUNT = 127;

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
 * How far a slice that ended inside an unbroken routine runs on: steps of a
 * few hundred instructions, a handful of them -- more than the longest such
 * routine with the most it copies, and a bound should one ever wait.
 */
const ATOMIC_STEP = 512;
const ATOMIC_STEPS = 16;

/**
 * What a blocked thread is queued on that it could take now. Nothing, for a
 * thread waiting as it should; anything else is a wake that never reached it,
 * a defect of ours, and the one thing the report of a stalled machine has to
 * show -- the wait's own words were written when it began.
 *
 * @param {any} thread
 * @returns {string | null}
 */
const readyNow = thread=>{
    if (thread.state !== ThreadState.BLOCKED)
    {
        return null;
    }
    const ready = (thread.queuedOn ?? []).filter((/** @type {any} */ one)=>
        one.waiters?.includes(thread) && signalledNow(one));
    return ready.length > 0
        ? `yet ${ready.map((/** @type {any} */ one)=>`${one.kind} "${one.name}"`).join(', ')} is ready`
        : null;
};

/**
 * @param {Object} options
 * @param {any} options.cpu        The cpu layer's API.
 * @param {any} options.switcher   The single switch primitive.
 * @param {number} [options.quantum]  Retired instructions per turn.
 * @param {number} [options.soloQuantum]  Retired instructions per turn of a thread no other
 *        is ready beside, with no other executor and no deadline near (`SOLO_CLEAR_MS`); ten
 *        quanta unless given.
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
 * @param {{ thread: number }} [options.ids]  The run's next thread id, shared with
 *        the schedulers of the processes beside or after this one.
 */
export function createScheduler(options){
    const { cpu, switcher, quantum = 100_000, now = ()=>0, skipTo = ()=>0 } = options;
    const soloQuantum = options.soloQuantum ?? quantum * 10;
    // A gigabyte's worth of pages when nobody says: what a machine is given
    // by default, and small enough to make for every scheduler a test builds.
    const pages = options.pages ?? new Float64Array(1024 * 1024 * 1024 / PAGE + 1);
    const counters = options.counters ?? new Float64Array(SCHEDULER_COUNTERS.length);
    /** The routines a slice does not end inside, as sorted, disjoint [start, end) spans. */
    const atomic = { starts: /** @type {number[]} */ ([]), ends: /** @type {number[]} */ ([]) };
    /** @param {number} eip */
    const insideAtomic = eip=>{
        let low = 0;
        let high = atomic.starts.length;
        while (low < high)
        {
            const middle = (low + high) >>> 1;
            if (atomic.starts[middle] <= eip)
            {
                low = middle + 1;
            }
            else
            {
                high = middle;
            }
        }
        return low > 0 && eip < atomic.ends[low - 1];
    };
    const threadTable = options.threadTable ?? null;
    const slowSliceTable = options.slowSliceTable ?? null;
    const intern = options.intern ?? (()=>-1);
    counters[0] = quantum;
    const starvation = options.starvation ?? 4000;
    /** Turns given to a thread because it had been passed over too long. */
    let boosts = 0;
    /** Slices ended early for a thread of higher priority that came due. */
    let preemptions = 0;
    /** What became of turns a host call's answer could have continued (`pick`). */
    const hostTurns = { continued: 0, outranked: 0, starved: 0, late: 0, waits: 0, ticks: 0,
        unanswered: 0 };
    /** What the last slice retired, for a thread's account of whom it followed. */
    let lastSlice = 0;
    /** Whether a slice is running: a wake outside one has no slice to end. */
    let inSlice = false;
    /**
     * The last wakes of a thread that outranks the one that woke it, newest
     * last, and whether the waker gave way: what a hand-over between threads
     * of different priority is read by.
     *
     * @type {string[]}
     */
    const recentWakes = [];
    /**
     * What a thread did last, newest last, kept on the thread: a thread that
     * has stopped for good is read by its own last steps, which a ring shared
     * with a busy pair of threads loses within a millisecond.
     *
     * @param {any} thread @param {string} step
     */
    const note = (thread, step)=>{
        const recent = thread.recent ??= [];
        if (recent.length > 0 && recent[recent.length - 1] === step)
        {
            return;
        }
        recent.push(step);
        if (recent.length > 12)
        {
            recent.shift();
        }
    };
    /** The last long gaps a short-period thread went without the processor. @type {string[]} */
    const lateGaps = [];
    /**
     * The last turns: whose, host ms in the slice, when it ended, ms since the one before.
     * @type {{ thread: string, ms: number, end: number, outside: number }[]}
     */
    const recentTurns = [];
    let lastEnd = 0;
    /**
     * Host ms each thread held the machine, and ms between slices, by second
     * of the last BUSY_SECONDS: how much of the machine's time each thread
     * is, over a window short enough to be the scene in front of it rather
     * than the loading before. What would be left of that time with each
     * thread on a processor of its own is the most a second executor buys.
     * @type {Map<string, number[]>}
     */
    const busyByThread = new Map();
    /** @type {number[]} */
    const between = new Array(BUSY_SECONDS).fill(0);
    let busySecond = -1;
    /** @param {number} at  host ms @returns {number} the slot of `at`'s second */
    const busySlot = at=>{
        const second = Math.floor(at / 1000);
        if (second !== busySecond)
        {
            // Every second skipped since the last slice is an empty one.
            const passed = busySecond < 0 ? BUSY_SECONDS
                : Math.min(second - busySecond, BUSY_SECONDS);
            for (let step = 1; step <= passed; step++)
            {
                const slot = (busySecond + step) % BUSY_SECONDS;
                between[slot] = 0;
                for (const seconds of busyByThread.values())
                {
                    seconds[slot] = 0;
                }
            }
            busySecond = second;
        }
        return second % BUSY_SECONDS;
    };
    // Read in every build: two reads a slice, a few thousand slices a second,
    // and without them a report of a production run says nothing of which
    // thread the machine was spent on.
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
    /**
     * The heaviest single slice since the figures were last published, and
     * where it began.
     */
    let heaviestSlice = 0;
    let heaviestFrom = 0;
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
    /** This scheduler, as its threads hold it. @type {any} */
    let self = null;
    // Thread ids are the run's, as a machine's are: a process started beside
    // or after this one numbers its threads on from where this one got to,
    // so no two threads of the run answer GetCurrentThreadId alike.
    const ids = options.ids ?? { thread: 1 };
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
    //
    // Nor is a suspended one. Suspension is a count beside the state rather
    // than a state of its own: a thread suspended in the middle of a wait is
    // still in that wait, with its deadline, and has to come back to it.
    const ready = ()=>threads.filter(thread=>
        thread.state === ThreadState.READY && !thread.awaitingHost
        && !(thread.suspendCount > 0));

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

    /**
     * The threads that were ready when the running slice began: a thread
     * among them was passed over by the choice that started it, and does not
     * take the processor back mid-slice (see `preemptionDue`).
     *
     * @type {Set<any>}
     */
    const readyAtSlice = new Set();
    /**
     * How parallel the process's threads are: the host milliseconds and the
     * instructions of every slice, by how many threads could have run during
     * it -- the one running and those ready beside it, 1, 2, 3, 4 or more.
     * What a second executor would have had to run is the share past the
     * first column (roadmap/v2, stage 3).
     */
    const parallel = { ms: [0, 0, 0, 0], instructions: [0, 0, 0, 0] };

    /**
     * A due time the clock honours whether or not a thread is waiting for it.
     *
     * A waitable timer is not a property of the wait that happens to arrive
     * after it is armed: the object becomes signalled when its due time comes
     * round, releasing whoever is already parked on it, and a periodic one
     * re-arms on its own clock with no thread present. So the due time is
     * registered here, with the same clock the scheduler already moves for
     * timed waits, and the callback is what signals the object.
     *
     * A callback that re-arms itself for the next period is `period`
     * milliseconds on; zero means fire once.
     *
     * @type {Map<number, { deadline: number, period: number,
     *     fire: (nextDue: number) => void }>}
     */
    const timers = new Map();
    let nextTimerToken = 1;

    /** The soonest deadline any blocked thread or armed timer is waiting on, or null. */
    const soonest = ()=>{
        /** @type {number | null} */
        let best = null;
        for (const thread of threads)
        {
            if (thread.state === ThreadState.BLOCKED
                && thread.deadline !== null && thread.deadline !== undefined
                && (best === null || thread.deadline < best))
            {
                best = thread.deadline;
            }
        }
        for (const timer of timers.values())
        {
            if (best === null || timer.deadline < best)
            {
                best = timer.deadline;
            }
        }
        return best;
    };

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
        // Timers first: one of them may signal an object and wake a waiter,
        // and that wake has to be visible to the selection this turn makes.
        // A timer that was cancelled from inside another's callback is skipped
        // by the lookup; the snapshot is only of the keys.
        for (const token of [...timers.keys()])
        {
            const timer = timers.get(token);
            if (!timer || timer.deadline > at)
            {
                continue;
            }
            if (timer.period > 0)
            {
                // The next period boundary after now: a timer nobody waited on
                // for a while signalled once, not once per period missed.
                const missed = Math.floor((at - timer.deadline) / timer.period) + 1;
                timer.deadline += missed * timer.period;
            }
            else
            {
                timers.delete(token);
            }
            timer.fire(timer.deadline);
        }
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

    /**
     * The thread to run of the ready `candidates`: the highest priority, the
     * queue's order among equals, one passed over too long first of all.
     *
     * @param {any[]} candidates
     */
    const pick = candidates=>{
        // The highest priority runs; among equals the queue order decides,
        // and a thread that has just run goes behind the others by being
        // moved to the back. A thread passed over for longer than the
        // starvation bound outranks everyone for this one turn, so a busy
        // high-priority thread can never hold the machine for ever.
        let next = candidates[0];
        if (candidates.length > 1)
        {
            const at = now();
            // A thread whose slice ended on a host call that has answered goes
            // on, as a call into the host and back is one call on Windows, not
            // a wait: a host call that runs guest code -- D3DX applying a pass
            // through the device's methods -- otherwise handed the processor
            // to every other ready thread for a whole slice each, per call.
            // Unless someone has starved or outranks it.
            const resumed = candidates.find(thread=>thread.hostContinues);
            if (resumed)
            {
                resumed.hostContinues = false;
                const others = candidates.filter(thread=>thread !== resumed);
                if (others.some(thread=>at - thread.readySince >= starvation))
                {
                    hostTurns.starved++;
                }
                else if (others.some(thread=>absolutePriority(thread.priority)
                    > absolutePriority(resumed.priority)))
                {
                    hostTurns.outranked++;
                }
                else
                {
                    hostTurns.continued++;
                    return resumed;
                }
            }
            else if (threads.some(thread=>thread.hostContinues && thread.awaitingHost))
            {
                hostTurns.late++;
            }
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

        return next;
    };

    /**
     * Where a thread continues when it is not where it stopped: a parked one
     * goes back with what its wait produced, applied by the switch.
     *
     * @param {any} next
     */
    const resumeOf = next=>{
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
                // Only a thread sent into code that reads more than its
                // stack carries these: an exception handler's block.
                ...next.resumeRegisters ? { registers: next.resumeRegisters } : {},
            };
            onResume?.(next, next.lastWaitingOn ?? null, resume.returnValue >>> 0);
            next.parkedReturn = null;
            next.resumeStack = null;
            next.waitResult = null;
            next.resumeRegisters = null;
        }
        return resume;
    };

    /** @param {any} next */
    const noteGap = next=>{
        // Whatever `current` is, it is the thread whose state is on the CPU,
        // and it has to be saved before another one takes over -- including,
        // especially, a thread that has just blocked. Saving only threads
        // still marked RUNNING loses the state of every thread that parked
        // itself in a wait, which then resumes from wherever it first began.
        // How long, on the host clock, a thread that waits in short
        // periods -- a mixer feeding a sound device every few milliseconds
        // -- went without the processor, and what had it instead: the
        // slices run meanwhile by thread, and the time spent outside any.
        // A gap longer than what it keeps written ahead is heard.
        if (next.shortWait
            && next.lastRanAt !== undefined)
        {
            const t = wall();
            const gap = t - next.lastRanAt;
            next.worstGap = Math.max(next.worstGap ?? 0, gap);
            if (gap >= LATE_GAP_MS)
            {
                next.lateGaps = (next.lateGaps ?? 0) + 1;
                /** @type {Map<string, number>} */
                const held = new Map();
                let outside = 0;
                for (const turn of recentTurns)
                {
                    if (turn.end > next.lastRanAt)
                    {
                        held.set(turn.thread, (held.get(turn.thread) ?? 0) + turn.ms);
                        outside += turn.outside;
                    }
                }
                const by = [...held].map(([name, ms])=>`${name}:${Math.round(ms)}`).join(',');
                lateGaps.push(`${next.name}@${Math.round(t)}+${Math.round(gap)} ${by} out:${
                    Math.round(outside)}`);
                if (lateGaps.length > 32)
                {
                    lateGaps.shift();
                }
            }
        }
    };

    /**
     * What a slice of `next` came to: the thread's account and the machine's,
     * and the thread to the back of the queue if it is still runnable.
     *
     * @param {any} next @param {number} instructions @param {number} began  host ms
     * @param {number} from  where the slice began @param {number} at  where it ended
     * @param {number} [asked]  the instructions the slice was given
     */
    const account = (next, instructions, began, from, at, asked = quantum)=>{
        const held = wall() - began;
        const could = Math.min(readyAtSlice.size, 3);
        parallel.ms[could] += held;
        parallel.instructions[could] += instructions;
        recentTurns.push({ thread: next.name ?? '?', ms: held, end: began + held,
            outside: lastEnd === 0 ? 0 : Math.max(0, began - lastEnd) });
        const slot = busySlot(began);
        const name = next.name ?? '?';
        let seconds = busyByThread.get(name);
        if (seconds === undefined)
        {
            seconds = new Array(BUSY_SECONDS).fill(0);
            busyByThread.set(name, seconds);
        }
        seconds[slot] += held;
        // Only the part of the gap inside the window.
        const windowStart = (Math.floor(began / 1000) - BUSY_SECONDS + 1) * 1000;
        // Slices on several executors overlap: none of that is time between them.
        between[slot] += lastEnd === 0 ? 0 : Math.max(0, began - Math.max(lastEnd, windowStart));
        if (recentTurns.length > 256)
        {
            recentTurns.shift();
        }
        lastEnd = Math.max(lastEnd, began + held);
        next.lastRanAt = lastEnd;
        next.instructions += instructions;
        // The processor time Windows reports (GetThreadTimes, GetProcessTimes):
        // a slice's own, so the process's adds up past the wall clock when its
        // threads run on several executors at once.
        next.cpuMs = (next.cpuMs ?? 0) + held;
        cpuMs += held;
        next.sincePublished += instructions;
        // Where the heaviest slice of the interval began: one page names
        // the module, and a slice weighs what it retired, so this is the
        // code the machine was actually in rather than the code it was in
        // most often.
        if (instructions > heaviestSlice)
        {
            heaviestSlice = instructions;
            heaviestFrom = from;
        }
        const slowest = slowSlices[slowSlices.length - 1];
        const kept = slowSlices.length < SLOW_SLICES_KEPT || held > slowest.ms;
        if (held >= SLOW_SLICE_MS && kept)
        {
            slowSlices.push({
                ms: held, instructions, from, at, thread: next.name ?? null,
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
        if (instructions > asked)
        {
            overruns++;
            if (instructions > worstSlice)
            {
                worstSlice = instructions;
                worstSliceAt = at;
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

    };

    /**
     * The thread each of the process's other executors is running, and when and
     * where its slice began.
     *
     * @type {Map<any, { thread: any, began: number, from: number }>}
     */
    const placed = new Map();
    /** The processor time every slice of the process has taken, in milliseconds. */
    let cpuMs = 0;
    /** Slices run on the other executors, and the most threads running at once, this one's included. */
    let executorSlices = 0;
    let mostAtOnce = 0;
    /**
     * Where this thread's time went while the process had other executors, in
     * milliseconds: its own slices (`hereMs`, which hold the answers given at
     * its crossings), answering the others (`answerMs`), waiting for them with
     * nothing to run here (`waitMs`), and its caller's between turns
     * (`betweenMs`). And the others' side of it: from each of their slices'
     * start to its end taken here (`heldMs`, against the time the executor
     * itself reports in its slices), and from that to its next start (`gapMs`).
     */
    const sharedTime = { hereMs: 0, answerMs: 0, waitMs: 0, answers: 0, turns: 0,
        betweenMs: 0, heldMs: 0, gapMs: 0, gaps: 0,
        // Counts by bound in ms: the gaps before another executor's next slice,
        // and this executor's own turns.
        gapsUnder: { '0.05': 0, '0.2': 0, '1': 0, '5': 0, '20': 0, more: 0 },
        hereUnder: { '0.05': 0, '0.2': 0, '1': 0, '5': 0, '20': 0, more: 0 } };
    /** @param {Record<string, number>} buckets @param {number} ms */
    const bucket = (buckets, ms)=>{
        const key = ms < 0.05 ? '0.05' : ms < 0.2 ? '0.2' : ms < 1 ? '1' : ms < 5 ? '5'
            : ms < 20 ? '20' : 'more';
        buckets[key]++;
    };
    /** When each other executor's last slice was taken, for the gap before its next. @type {Map<any, number>} */
    const takenAt = new Map();
    /** When the last shared turn returned, for the time the caller kept between turns. */
    let sharedTurnEnd = -1;

    /** Set while they are answered: an answer's own trap does not answer again. */
    let answering = false;
    /** Set while this executor's thread runs a long turn with the others free (`runHere`). */
    let soloShared = false;

    /**
     * A thread made ready during a long turn here that one of the other
     * executors is free to run ends the turn, so it starts there now rather
     * than at the turn's end.
     *
     * @param {any} thread
     */
    const noteReady = thread=>{
        if (!soloShared || !inSlice || answering || thread === current
            || thread.state !== ThreadState.READY || thread.suspendCount > 0)
        {
            return;
        }
        if ((cpu.executors?.() ?? []).some((/** @type {any} */ remote)=>!remote.busy()
            && allowedOn(thread, remote.index)))
        {
            soloShared = false;
            cpu.stop?.();
        }
    };
    /** The bell's count when they were last answered. */
    let answeredAt = -1;

    /**
     * Whether `thread` may run on executor `index`: the processor of that
     * number is in its affinity mask (SetThreadAffinityMask), or it has none.
     *
     * @param {any} thread @param {number} index
     */
    const allowedOn = (thread, index)=>thread.affinityMask === undefined
        || (thread.affinityMask >>> index & 1) === 1;

    /**
     * The executor a thread runs on: where its translations are, made there
     * the first time it ran. The process's first thread is this executor's;
     * each later one goes to the executor fewest live threads call theirs,
     * one of the others before this one, which also answers their crossings.
     * Only executors its affinity mask allows count, and a thread whose mask
     * no longer allows its own is given another -- a program that pins a
     * thread to each processor in turn reads each one's APIC id there.
     *
     * @param {any} thread @param {any[]} remotes
     * @returns {number} the executor's index, 0 for this one
     */
    const homeOf = (thread, remotes)=>{
        if (thread.home !== undefined && allowedOn(thread, thread.home))
        {
            return thread.home;
        }
        // This one counts a thread more than it holds: it answers the others' crossings.
        /** @type {Map<number, number>} */
        const homed = new Map();
        if (allowedOn(thread, 0))
        {
            homed.set(0, 1);
        }
        for (const remote of remotes)
        {
            if (allowedOn(thread, remote.index))
            {
                homed.set(remote.index, 0);
            }
        }
        if (homed.size === 0)
        {
            // A mask is checked against the processors when it is set; one
            // naming none of these leaves the thread where every thread may run.
            homed.set(0, 1);
        }
        let any = false;
        for (const other of threads)
        {
            if (other !== thread && other.home !== undefined
                && other.state !== ThreadState.TERMINATED && homed.has(other.home))
            {
                homed.set(other.home, /** @type {number} */ (homed.get(other.home)) + 1);
                any = true;
            }
        }
        let home = /** @type {number} */ (homed.keys().next().value);
        if (any)
        {
            for (const [index, count] of homed)
            {
                if (count < /** @type {number} */ (homed.get(home)))
                {
                    home = index;
                }
            }
        }
        thread.home = home;
        return home;
    };

    /**
     * The ready threads no executor is running. A thread that waits on another
     * executor is made ready by its wake before that executor's slice has
     * ended -- it spins in the park loop until the slice is taken -- and must
     * not start a second time elsewhere meanwhile.
     */
    const runnable = ()=>{
        const elsewhere = new Set([...placed.values()].map(on=>on.thread));
        return elsewhere.size === 0 ? ready() : ready().filter(thread=>!elsewhere.has(thread));
    };

    /**
     * A thread started on a second executor while one runs it diverges in ways
     * found much later -- a lock taken twice, a count lost -- so the start
     * itself fails.
     *
     * @param {any} next
     */
    const runsOnce = next=>{
        for (const [remote, on] of placed)
        {
            if (on.thread === next)
            {
                throw new Error(`${next.name} started while executor ${remote.index} runs it`);
            }
        }
    };

    /**
     * Puts `next` on executor `remote` and starts its slice. A thread whose
     * state is on the process's own executor is taken off it first.
     *
     * @param {any} remote @param {any} next
     */
    const place = (remote, next)=>{
        runsOnce(next);
        if (next === current)
        {
            current.context = cpu.captureContext();
            current = null;
        }
        const resume = resumeOf(next);
        noteGap(next);
        let from = 0;
        cpu.onExecutor(remote.index, ()=>{
            switcher.switchTo(null, next, resume);
            watchStack(next);
            from = cpu.eip?.() ?? 0;
        });
        note(next, `runs on executor ${remote.index}`);
        next.state = ThreadState.RUNNING;
        const began = wall();
        const taken = takenAt.get(remote);
        if (taken !== undefined)
        {
            sharedTime.gapMs += began - taken;
            sharedTime.gaps++;
            bucket(sharedTime.gapsUnder, began - taken);
        }
        placed.set(remote, { thread: next, began, from });
        remote.start(quantum);
        executorSlices++;
        mostAtOnce = Math.max(mostAtOnce, placed.size + (inSlice ? 1 : 0));
    };

    /**
     * Answers what the other executors raised -- with the raising thread as
     * the current one, so a wait blocks it, a wake that outranks it ends its
     * slice and an exit ends it -- and takes the slices that ended, accounted
     * as a slice here is. Called between turns and on every crossing of the
     * process's own thread, so a trap on another executor waits at most for
     * the next of those.
     *
     * @returns {{ ran: any | null, instructions: number }} the last thread whose slice ended
     */
    const answerExecutors = ()=>{
        if (answering || placed.size === 0)
        {
            return { ran: null, instructions: 0 };
        }
        answering = true;
        let ran = null;
        let instructions = 0;
        const from = wall();
        try
        {
            for (const [remote, on] of placed)
            {
                const ended = remote.step((/** @type {() => void} */ reply)=>{
                    const was = current;
                    const wasInSlice = inSlice;
                    current = on.thread;
                    inSlice = true;
                    try
                    {
                        reply();
                    }
                    finally
                    {
                        inSlice = wasInSlice;
                        current = was;
                    }
                });
                if (ended === null)
                {
                    continue;
                }
                placed.delete(remote);
                takenAt.set(remote, wall());
                sharedTime.heldMs += wall() - on.began;
                let at = 0;
                cpu.onExecutor(remote.index, ()=>{
                    on.thread.context = cpu.captureContext();
                    at = cpu.eip?.() ?? 0;
                });
                if (ended.fault !== null)
                {
                    cpu.remoteFault?.(ended.fault);
                }
                account(on.thread, ended.instructions, on.began, on.from, at);
                ran = on.thread;
                instructions += ended.instructions;
            }
        }
        finally
        {
            answering = false;
            sharedTime.answerMs += wall() - from;
            sharedTime.answers++;
        }
        return { ran, instructions };
    };

    /**
     * Gives the CPU of the process's own executor to `next` for a quantum,
     * answering the other executors at each of its crossings.
     *
     * @param {any} next
     * @param {boolean} [shared]  whether the process has other executors
     * @returns {{ ran: any | null, instructions: number, switched: boolean }}
     */
    const runHere = (next, shared = false)=>{
        runsOnce(next);
        const resume = resumeOf(next);
        noteGap(next);
        if (next !== current)
        {
            note(next, `runs after ${current?.name ?? '-'} (${lastSlice})`);
        }
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
        readyAtSlice.clear();
        for (const thread of threads)
        {
            if (thread !== next && thread.state === ThreadState.READY)
            {
                readyAtSlice.add(thread);
            }
        }
        inSlice = true;
        mostAtOnce = Math.max(mostAtOnce, placed.size + 1);
        // A thread nobody else is ready beside has nobody to be fair to: its
        // turn is longer, as the turn itself -- the host's account, the next
        // choice, the event loop's look -- was a quarter of the time of a
        // workload translated code ran at three billion instructions a second,
        // for whom a quantum is 30 microseconds. A deadline coming near keeps
        // the quantum, so a timed wait ends no later than it did. So does a
        // process whose other executors run a thread: their calls into the
        // host are answered here between turns. With none placed, a thread
        // readied mid-turn that one of them could take ends the turn at once
        // (`noteReady`) -- on two executors 7-Zip's single-threaded benchmark
        // ran a fifth slower in turns of a quantum.
        const asked = (!shared || placed.size === 0) && readyAtSlice.size === 0
            && (noDeadlineBefore === null || noDeadlineBefore - now() > SOLO_CLEAR_MS)
            ? soloQuantum : quantum;
        soloShared = shared && asked === soloQuantum;
        let instructions = cpu.runSlice(asked);
        soloShared = false;
        inSlice = false;
        lastSlice = instructions;
        // A slice that ran out inside a routine the host placed to run
        // unbroken -- one writing a record another thread's entry into the
        // host reads -- runs on to the routine's end: none of them waits,
        // so the end is a few instructions away.
        for (let more = 0; more < ATOMIC_STEPS && atomic.starts.length !== 0
            && next.state === ThreadState.RUNNING && insideAtomic(cpu.eip?.() ?? 0); more++)
        {
            instructions += cpu.runSlice(ATOMIC_STEP);
        }
        account(next, instructions, began, from, cpu.eip?.() ?? 0, asked);
        // A slice that ended on a host call still answering: the answer is the
        // thread's own call, and once it comes the thread goes on (`pick`).
        next.hostContinues = next.awaitingHost === true;
        return { ran: next, instructions, switched };
    };

    /**
     * The ready threads in the usual order, each to its own executor while
     * that one is free. A thread whose own is taken then goes to an executor
     * left free -- this one first, its translations made there too -- rather
     * than leave a processor idle while it waits; it keeps its own for the
     * next turn. Starts the others' slices and answers the thread for this
     * one, if any.
     *
     * @param {any[]} remotes @param {any} bell
     * @returns {any | null}
     */
    const choose = (remotes, bell)=>{
        let candidates = runnable();
        const free = remotes.filter(remote=>!remote.busy());
        let here = null;
        /** @type {any[]} */
        const waiting = [];
        while (candidates.length > 0 && (here === null || free.length > 0))
        {
            const next = pick(candidates);
            candidates = candidates.filter(thread=>thread !== next);
            const home = homeOf(next, remotes);
            const remote = free.find(one=>one.index === home);
            if (home === 0 && here === null)
            {
                here = next;
            }
            else if (remote !== undefined)
            {
                free.splice(free.indexOf(remote), 1);
                place(remote, next);
            }
            else
            {
                waiting.push(next);
            }
        }
        for (const next of waiting)
        {
            if (here === null && allowedOn(next, 0))
            {
                here = next;
                continue;
            }
            const at = free.findIndex(one=>allowedOn(next, one.index));
            if (at >= 0)
            {
                place(free.splice(at, 1)[0], next);
            }
            else if (here !== null && free.length === 0)
            {
                break;
            }
        }
        // A thread left without an executor waits for one to give its thread up.
        // The one taken here is not left: it runs this turn, still ready until it does.
        // So does an executor whose thread is wanted back -- suspended, ended
        // by another -- as it keeps one it is let go on with past its slice.
        bell.goOn?.(candidates.length === 0
            && waiting.every(thread=>thread === here || thread.state !== ThreadState.READY)
            && [...placed.values()].every(on=>on.thread.state === ThreadState.RUNNING
                && !(on.thread.suspendCount > 0)));
        return here;
    };

    /**
     * A turn of a process with executors in workers of their own
     * (`cpu.executors`): the ready threads, chosen as ever, each on its own
     * executor (`homeOf`) while that one is free. The others' traps are
     * answered on this executor's crossings and between its turns; with
     * nothing to run here, the turn waits for them.
     *
     * @param {any[]} remotes
     * @returns {{ ran: any | null, instructions: number, switched: boolean,
     *     elsewhere?: boolean }}  elsewhere: nothing ran here, the others still run
     */
    const runShared = remotes=>{
        const turnFrom = wall();
        if (sharedTurnEnd >= 0)
        {
            sharedTime.betweenMs += turnFrom - sharedTurnEnd;
        }
        sharedTime.turns++;
        try
        {
            return takeEnding(runSharedTurn(remotes));
        }
        finally
        {
            sharedTurnEnd = wall();
        }
    };

    /**
     * The turn's result once every other executor whose thread waits for a
     * host call's later answer (`awaitingHost`), or which an answer halted or
     * stopped, has given it back: it is parked, so its slice ends at once. The
     * answer goes on after the turn -- a promise or two on, it sends the
     * thread into a callback or back to its caller -- and until the slice is
     * taken the thread's state is the executor's, so what the answer set
     * was lost when it was: a library loaded by a thread on another executor
     * had its entry point's frame dropped and the thread returned to 0.
     *
     * @param {{ ran: any | null, instructions: number, switched: boolean,
     *     elsewhere?: boolean }} turn
     */
    const takeEnding = turn=>{
        const bell = cpu.executorBell();
        const from = wall();
        while ([...placed].some(([remote, on])=>remote.ending?.()
            || on.thread.awaitingHost === true) && wall() - from < ENDING_WAIT_MS)
        {
            const seen = bell.rung();
            const taken = answerExecutors();
            if (taken.ran !== null)
            {
                turn = { ran: turn.ran ?? taken.ran, instructions: turn.instructions
                    + taken.instructions, switched: turn.switched || turn.ran === null };
                continue;
            }
            bell.wait(seen, EXECUTORS_WAIT_MS);
        }
        return turn;
    };

    /**
     * @param {any[]} remotes
     * @returns {{ ran: any | null, instructions: number, switched: boolean, elsewhere?: boolean }}
     */
    const runSharedTurn = remotes=>{
        expire();
        let { ran, instructions } = answerExecutors();
        const bell = cpu.executorBell();
        for (;;)
        {
            const here = choose(remotes, bell);
            if (here !== null)
            {
                const hereFrom = wall();
                const turn = runHere(here, true);
                sharedTime.hereMs += wall() - hereFrom;
                bucket(sharedTime.hereUnder, wall() - hereFrom);
                const after = answerExecutors();
                return { ran: turn.ran, instructions: turn.instructions + instructions
                    + after.instructions, switched: turn.switched };
            }
            if (placed.size === 0)
            {
                // Nothing runs anywhere: the clock to the soonest deadline, as with
                // one executor, and a thread that woke there runs in this turn --
                // a turn that ran nothing reads to the caller as an idle machine.
                const deadline = soonest();
                if (deadline !== null && skipTo(deadline) !== 0)
                {
                    expire();
                    if (runnable().length > 0)
                    {
                        continue;
                    }
                }
                return { ran, instructions, switched: false };
            }
            // Nothing to run here: the others' words are waited for -- a slice's
            // end, or a trap whose answer makes a thread ready that can run now.
            const seen = bell.rung();
            const taken = answerExecutors();
            instructions += taken.instructions;
            ran = taken.ran ?? ran;
            if (ran !== null)
            {
                return { ran, instructions, switched: true };
            }
            // A thread made ready runs here next round: this executor is free.
            if (runnable().length === 0)
            {
                // Until the soonest deadline at most: an executor keeps its thread
                // while nothing waits for one, so no word may come before a timed
                // wait here runs out. A wait that saw none ends the turn as one
                // the others ran (`elsewhere`), not an idle machine's: no thread
                // of this executor's is the turn's, theirs still being run.
                const deadline = soonest();
                const waitFrom = wall();
                bell.wait(seen, Math.max(0, Math.min(EXECUTORS_WAIT_MS,
                    deadline === null ? Infinity : deadline - now())));
                sharedTime.waitMs += wall() - waitFrom;
                if (bell.rung() === seen)
                {
                    return { ran: null, instructions, switched: false, elsewhere: true };
                }
            }
        }
    };

    /** The other executors' traps, answered at a crossing of this executor's thread. */
    cpu.beforeTrap?.(()=>{
        if (placed.size === 0)
        {
            return;
        }
        const rung = cpu.executorBell().rung();
        if (rung !== answeredAt)
        {
            answeredAt = rung;
            answerExecutors();
        }
    });

    const api = {
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
         * @param {number} [options.id]  the id it was already given: the one a
         *     parent was told its child's first thread has
         * @returns {any} the thread
         */
        create({ entry, stackTop, stackLimit, tebAddress, name, id }){
            const made = id ?? takeId(ids, 'thread', 1);
            const thread = {
                id: made,
                name: name ?? `thread-${made}`,
                // What wakes it: a named object another process of the run
                // shares is signalled by that process, whose scheduler is not
                // this one (`sync.js`).
                scheduler: self,
                state: ThreadState.READY,
                tebAddress,
                stackTop,
                // Both ends, so anything writing on this thread's behalf can
                // check that what it wrote landed on this thread's stack.
                stackLimit,
                entry,
                context: cpu.newContext({ entry, stackTop }),
                instructions: 0,
                /**
                 * The same since the figures were last published. Kept on the
                 * thread so a slice costs one add, and reset where they are
                 * published, which is once a frame.
                 */
                sincePublished: 0,
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
            noteReady(thread);
            return thread;
        },

        /** @returns {any} the thread on the CPU, or null */
        current: ()=>current,

        /**
         * Code a slice is not to end inside: a routine of the host's that
         * other threads must never see half done, and that never waits.
         *
         * @param {number} address @param {number} length
         */
        atomicCode(address, length){
            const start = address >>> 0;
            let at = 0;
            while (at < atomic.starts.length && atomic.starts[at] < start)
            {
                at++;
            }
            atomic.starts.splice(at, 0, start);
            atomic.ends.splice(at, 0, start + (length >>> 0));
        },

        /**
         * Whether the running thread should give the processor up at the host
         * call it is in: a thread of higher priority became ready during this
         * slice -- its timed wait came due, or the running thread set what it
         * waited on. Windows preempts such a thread at once; a slice here is
         * guest instructions, and one full of host calls ran 40-120 ms while a
         * sound mixer woken every 10 ms waited for it to end. A thread that was
         * already ready when the slice began does not count: it was passed over
         * by the choice that started the slice.
         *
         * The guest's clock is moved on by the turn, so within a slice no wait
         * comes due by itself: `refresh` brings it up to the host's first --
         * only when a thread of higher priority is waiting at all, which keeps
         * the look free for the many machines that have none.
         *
         * @param {() => void} [refresh]
         * @returns {boolean}
         */
        preemptionDue(refresh){
            if (current === null || current.state !== ThreadState.RUNNING)
            {
                return false;
            }
            const mine = absolutePriority(current.priority);
            let waiting = false;
            for (const thread of threads)
            {
                if (thread !== current && absolutePriority(thread.priority) > mine
                    && !readyAtSlice.has(thread))
                {
                    waiting = true;
                    break;
                }
            }
            if (!waiting)
            {
                return false;
            }
            refresh?.();
            expire();
            for (const thread of threads)
            {
                if (thread !== current && thread.state === ThreadState.READY
                    && !thread.awaitingHost && !(thread.suspendCount > 0)
                    && absolutePriority(thread.priority) > mine && !readyAtSlice.has(thread))
                {
                    preemptions++;
                    return true;
                }
            }
            return false;
        },

        /** @returns {any[]} */
        all: ()=>[...threads],

        /** The processor time the process's threads have taken, in milliseconds. */
        cpuMs: ()=>cpuMs,

        /**
         * The executor `thread` runs on now -- the processor it would read
         * as its own: another executor's index while that one holds it,
         * this one's, 0, otherwise.
         *
         * @param {any} thread
         * @returns {number}
         */
        processorOf(thread){
            for (const [remote, on] of placed)
            {
                if (on.thread === thread)
                {
                    return remote.index;
                }
            }
            return 0;
        },

        /**
         * Gives the CPU to the next ready thread and lets it run a quantum.
         *
         * Returns what happened, so a caller driving the machine can tell the
         * difference between progress, an idle system and a finished one --
         * three states that look identical if all you get back is a number.
         *
         * @returns {{ ran: any | null, instructions: number, switched: boolean,
         *     elsewhere?: boolean }}  elsewhere: nothing ran here, the others still run
         */
        /**
         * How a turn's wait for its thread's host answer went (the run loop's):
         * the microtasks it took, or that none came in the ones allowed.
         *
         * @param {number} ticks @param {boolean} answered
         */
        noteHostAnswer(ticks, answered){
            hostTurns.waits++;
            hostTurns.ticks += ticks;
            if (!answered)
            {
                hostTurns.unanswered++;
            }
        },

        runOnce(){
            const remotes = cpu.executors?.() ?? [];
            if (remotes.length > 0)
            {
                return runShared(remotes);
            }
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

            return runHere(pick(candidates));
        },

        /**
         * @param {any} thread
         * @param {string} [reason]  What it is waiting for, for diagnostics.
         * @param {Object} [timed]
         * @param {number} [timed.deadline]  Guest time after which it wakes anyway.
         * @param {number} [timed.result]    What the call answers when it does.
         */
        block(thread, reason, timed){
            note(thread, `waits ${reason ?? '?'}`);
            thread.state = ThreadState.BLOCKED;
            thread.waitingOn = reason ?? null;
            // Kept past the wake, so the resume can still say what was waited
            // for: the wake clears the live reason.
            thread.lastWaitingOn = reason ?? null;
            thread.deadline = timed?.deadline ?? null;
            thread.timeoutResult = timed?.result ?? 0;
            thread.shortWait = thread.deadline !== null && thread.deadline - now() <= SHORT_WAIT_MS;
            // Whether a queued APC may end this wait early. Set for the one
            // block made inside an alertable call and no other, and gone again
            // at the wake: a later wait that is not alertable must not be
            // interrupted by an APC queued during it.
            thread.alertable = thread.enteringAlertable === true;
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
            thread.alertable = false;
            // Woken by the running thread -- an event it set, a mutex or a
            // semaphore it released -- a thread of higher priority takes the
            // processor at once on Windows, before the next instruction of the
            // thread that woke it. A program relies on that: one hands a read
            // to its I/O worker, takes it back and hands over another, and the
            // worker it woke has taken the first by then; run on, the waker
            // takes back a job still queued and the worker, finding it there
            // first, sleeps on the rest. So the slice ends at the call.
            const outranks = current !== null && current !== thread
                && absolutePriority(thread.priority) > absolutePriority(current.priority);
            const preempts = outranks && inSlice && current.state === ThreadState.RUNNING
                && !thread.awaitingHost && !(thread.suspendCount > 0);
            if (preempts)
            {
                preemptions++;
                cpu.stop?.();
            }
            else
            {
                noteReady(thread);
            }
            note(thread, `woken by ${current?.name ?? '-'}${preempts ? ' at once' : ''}`);
            if (outranks)
            {
                recentWakes.push(`${thread.name} by ${current.name} (${current.state})`
                    + `${preempts ? ' preempting' : ''}`
                    + `${thread.awaitingHost ? ' awaitingHost' : ''}`
                    + `${thread.suspendCount > 0 ? ' suspended' : ''}`);
                if (recentWakes.length > 32)
                {
                    recentWakes.shift();
                }
            }
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

        /**
         * Registers a due time the clock must reach, whether or not any thread
         * is waiting: the callback runs on the guest's clock, and a positive
         * period re-arms it for the next boundary. Returns the token
         * `removeTimer` needs to disarm it.
         *
         * @param {number} deadline @param {number} period
         * @param {(nextDue: number) => void} fire
         * @returns {number}
         */
        addTimer(deadline, period, fire){
            const token = nextTimerToken++;
            timers.set(token, { deadline, period: Math.max(0, period), fire });
            if (noDeadlineBefore === null || deadline < noDeadlineBefore)
            {
                noDeadlineBefore = deadline;
            }
            return token;
        },

        /**
         * Disarms a timer. The earliest deadline may be left behind, which
         * costs one empty scan and nothing else, exactly as a wait that ends
         * early does.
         *
         * @param {number} token
         */
        removeTimer(token){
            timers.delete(token);
        },

        /** Whether any thread is waiting on a time rather than on another thread. */
        nextDeadline: ()=>soonest(),

        /**
         * Adds one to a thread's suspend count. Past the most a thread can
         * carry the count is left as it was and the call refused.
         *
         * @param {any} thread
         * @returns {number | null} the count before, or null when refused
         */
        suspend(thread){
            const previous = thread.suspendCount ?? 0;
            if (previous >= MAXIMUM_SUSPEND_COUNT)
            {
                return null;
            }
            thread.suspendCount = previous + 1;
            return previous;
        },

        /**
         * Takes one from a thread's suspend count; nothing below zero.
         *
         * @param {any} thread
         * @returns {number} the count before
         */
        resume(thread){
            const previous = thread.suspendCount ?? 0;
            if (previous > 0)
            {
                thread.suspendCount = previous - 1;
                // Measured from here: time spent suspended is not time spent
                // passed over, and counting it would boost the thread over
                // every other on its first turn back.
                thread.readySince = now();
                noteReady(thread);
            }
            return previous;
        },

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
            counters[14] = heaviestFrom;
            heaviestSlice = 0;
            heaviestFrom = 0;
            /** The busiest thread's name and what it retired, kept as numbers:
             * its own tally is cleared in the same walk. */
            let busiest = -1;
            let busiestRetired = 0;
            const table = threadTable;
            const rows = table ? Math.min(threads.length, table.rows) : 0;
            for (let row = 0; row < threads.length; row++)
            {
                const thread = threads[row];
                // Which thread the machine was spent on since the last
                // publish, found and cleared in the walk that was happening
                // anyway: no second pass and nothing to allocate.
                if (thread.sincePublished > busiestRetired || busiest < 0)
                {
                    busiest = intern(thread.name);
                    busiestRetired = thread.sincePublished;
                }
                if (!table || row >= rows)
                {
                    thread.sincePublished = 0;
                    continue;
                }
                table.set(row, 0, thread.id);
                table.set(row, 1, intern(thread.name));
                table.set(row, 2, thread.instructions);
                table.set(row, 3, THREAD_STATES.indexOf(thread.state));
                table.set(row, 4, absolutePriority(thread.priority));
                table.set(row, 5, thread.boosts);
                table.set(row, 6, thread.boosted ? 1 : 0);
                table.set(row, 7, thread.waitingOn ? intern(thread.waitingOn) : -1);
                const low = lowWater.get(thread);
                table.set(row, 8, low !== undefined && thread.stackTop !== undefined
                    ? thread.stackTop - low : 0);
                table.set(row, 9,
                    thread.stackTop !== undefined && thread.stackLimit !== undefined
                        ? thread.stackTop - thread.stackLimit : 0);
                thread.sincePublished = 0;
            }
            counters[12] = busiest;
            counters[13] = busiestRetired;
            table?.used(rows);
        },

        diagnostics(){
            /** The busy time by thread over the window, and what it says of more executors. */
            const busyReport = ()=>{
                const totals = [...busyByThread]
                    .map(([name, seconds])=>({ name, ms: seconds.reduce((a, b)=>a + b, 0) }))
                    .filter(one=>one.ms > 0)
                    .sort((a, b)=>b.ms - a.ms);
                const inSlices = totals.reduce((sum, one)=>sum + one.ms, 0);
                const outside = between.reduce((a, b)=>a + b, 0);
                return {
                    // Each thread's host ms in its own slices -- its code and
                    // the host calls it made -- over the last ten seconds.
                    busyByThread: totals.map(one=>`${one.name} ${Math.round(one.ms)}ms ${
                        inSlices > 0 ? Math.round(one.ms / inSlices * 100) : 0}%`).join(' | '),
                    busyInSlicesMs: Math.round(inSlices),
                    // The loop's own work between slices, and its waits.
                    busyBetweenSlicesMs: Math.round(outside),
                    // The slices' time over the busiest thread's: how many
                    // times shorter they could be with every thread on its
                    // own executor, and nothing to wait for between them.
                    parallelBound: totals.length > 0
                        ? Math.round(inSlices / totals[0].ms * 100) / 100 : 1,
                };
            };
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
                parallel: { ms: parallel.ms.map(Math.round),
                    instructions: [...parallel.instructions] },
                slowSlices: slowSlices.map(s=>`${Math.round(s.ms)}ms ${s.instructions} ${
                    s.thread ?? '?'} 0x${s.from.toString(16)}->0x${s.at.toString(16)}`).join('; '),
                // Timed waits that ran out rather than being satisfied.
                expiries,
                // Due times the clock owes an object rather than a thread.
                timers: timers.size,
                // Turns handed out against priority, to a thread passed over
                // too long. A steady count is a high-priority thread that
                // never yields, which a program does not mean to do.
                boosts,
                preemptions,
                hostTurns: { ...hostTurns },
                // Slices given to the process's other executors, and the most
                // that ran at once: zero and zero where it has one.
                executorSlices,
                mostAtOnce,
                sharedTime: JSON.stringify(sharedTime),
                recentWakes: recentWakes.slice(),
                recentByThread: threads.filter(thread=>thread.state !== ThreadState.TERMINATED)
                    .map(thread=>`${thread.name}: ${(thread.recent ?? []).join(' > ')}`),
                // The last gaps past LATE_GAP_MS a short-period thread went
                // without the processor, and what held the machine meanwhile.
                lateGaps: lateGaps.join(' | '),
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
                ...busyReport(),
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
                        thread.boosted ? '+' : ''}${thread.worstGap === undefined ? ''
                        : ` g${Math.round(thread.worstGap)}/${thread.lateGaps ?? 0}`}`)
                    .join(' | '),
                current: current ? current.name : null,
                // A thread that has been waiting on the same thing for a long
                // time is the shape of a deadlock, so name what each is waiting on.
                // A suspended thread is stopped too, whatever its state says.
                waiting: threads
                    .filter(thread=>thread.state === ThreadState.BLOCKED || thread.suspendCount > 0)
                    .map(thread=>`${thread.name}: ${[
                        thread.state === ThreadState.BLOCKED ? thread.waitingOn ?? 'unknown' : null,
                        thread.suspendCount > 0 ? `suspended ${thread.suspendCount}` : null,
                        readyNow(thread),
                    ].filter(Boolean).join(', ')}`),
            };
        },
    };
    self = api;
    return api;
}
