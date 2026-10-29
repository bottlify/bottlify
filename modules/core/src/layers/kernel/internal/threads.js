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
import { Placement, createPlacement } from './placement.js';

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
 * The host ms a thread's blocking waits lasted until another thread woke it,
 * counted below each bound and past the last (`blockedFor`): whether a wait
 * that looked at its object a little longer in the guest would have found it
 * signalled rather than leaving its executor and waiting for the process's.
 */
const BLOCKED_BOUNDS = [0.02, 0.05, 0.1, 0.2, 0.5, 1, 5, 20];

/**
 * Calls into the host an instruction past which a thread runs on the process's
 * own executor (`keptHere`): one every 30 000 instructions, 10 to 100 us of
 * translated code, against 5 us a call from another executor took to be
 * answered at best and half a millisecond on average in a browser, where this
 * executor is also the one waiting on the graphics worker and the event loop.
 * Threads that compute and call the host once in 2 300 instructions ran 0.58 to
 * 0.74 times as fast on two and four executors as on one, once in 9 200 0.91 to
 * 1.18 times, once in 37 000 1.04 to 1.28 times (`tools/executor-sweep.mjs`).
 */
const HOST_BOUND = 1 / 30_000;

/**
 * The instructions over which a thread's calls into the host are counted
 * (`crossRate`), as a half-life: the rate is calls an instruction over about
 * the last million, however many slices cut them. Taken a slice at a time, a
 * thread that woke, ran a few dozen instructions and called the host again to
 * wait counted as a call every few dozen: x264's frame threads, a call in a
 * million instructions, rated a call in 34 to 80 and were kept on this
 * executor, the other three idle three quarters of the run.
 */
const CROSS_HALF = 1_000_000;

/**
 * The share of a thread's last runs on another executor that ended with this
 * one called it back, nothing of its own to run, past which it runs here
 * (`coupled`): it and this executor's threads take turns rather than run at
 * once -- a game's sound thread, placed there whenever it was ready beside the
 * renderer, was called back 1 312 times of 1 319 and ran 3% of the
 * instructions there. The share halves every `COUPLED_HALF_MS` it is not
 * renewed, so such a thread tries the other executor again now and then.
 */
const COUPLED = 0.5;
const COUPLED_HALF_MS = 1000;

/**
 * The share of what this executor retired meanwhile below which a run called
 * back counts towards `coupled`: past it, the thread did as much beside this
 * executor's as that one did, and taking turns with it would give that up. A
 * game's render thread, its main thread waiting on it some 1 400 times a second
 * while both computed between, was called back at each wait and kept here, the
 * two taking turns at full slices while four executors idled; a worker and the
 * main thread each computing as much a round and meeting at an event ran 1.66
 * times as fast on its own executor as kept here.
 */
const COUPLED_WORK = 0.5;

/** How many turns of `turnMs` a deadline must be beyond for a turn to take one. */
const TURN_CLEAR = 4;

/**
 * The half-life, in host ms, of the time this executor spends in each
 * thread's calls into the host (`hostTime`): a second, so tens of a game's
 * frames are in it and a load's long past ones are not.
 */
const HOST_HALF_MS = 1000;

/**
 * A pinned thread's processor is tried played here (`playPinned`) once this
 * executor spends at least this share of its time in the thread's calls, and
 * `PLAY_MARGIN` times what it spends in those of the thread pinned to its
 * own processor: that one's calls would cross from the other executor instead.
 */
const PLAY_FLOOR = 0.02;
const PLAY_MARGIN = 2;

/**
 * The share of the process's executor a move must leave free by the scheduler's
 * reckoning (`gains`): what it does not see -- the cost of a turn taken there, a
 * call answered later for the executor's being busier -- is taken from it.
 */
const ROOM = 0.1;

/** What an answer to another executor's call is taken to cost it, ms, until one is measured. */
const ANSWER_MS = 0.2;

/** Each kind of move by the kind that takes it back (`placement.js`, `move`). */
const OPPOSITE = new Map([['in', 'out'], ['out', 'in'], ['trade', 'untrade'],
    ['untrade', 'trade']]);

/** Turns kept to say what held the processor through a late thread's gap. */
const RECENT_TURNS = 256;

/**
 * The longest this executor waits, in host ms, for the others with nothing of its
 * own to run before its turn ends: they keep their threads while nothing waits for
 * one, and the turn's caller moves the guest's clock and looks at the event loop.
 */
const EXECUTORS_WAIT_MS = 4;

/**
 * Crossings into the host inside one slice between two moves of the guest's
 * clock (`refreshClock`). The clock is otherwise moved between slices, and a
 * slice of a program that calls the host in a loop lasts many milliseconds:
 * one waiting for its next frame by reading the clock between calls saw it
 * stand still for the whole slice, and drew its frames only at slice ends.
 */
const CROSSINGS_PER_CLOCK = 64;

/**
 * The longest a turn waits, in host ms, for an executor whose thread an answer
 * parked to give its slice back: it ends at its next instruction, a park loop's.
 */
const ENDING_WAIT_MS = 1000;

/**
 * How long, in host ms, this executor goes with nothing of its own to run
 * while another keeps a thread it could run before that one lets the thread go
 * to come here: at once. Waited for 2 ms, a game's renderer waited on its
 * sound thread elsewhere 3.9 s of 80 in such waits (12.2 against 11.1 to 11.8
 * frames a second at once); a thread moved over and back so is one that takes
 * turns with this executor's, and stays here (`COUPLED`).
 */
const RECALL_MS = 0;

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
 * How a slice that ended inside an unbroken routine runs on: a step at a time,
 * each ending at the first place translated code looks at its budget -- a back
 * edge, a region's exit -- so it stops at the routine's `ret` rather than run
 * past it into the next call to one, a program's setters coming one after
 * another; as many steps as the longest such routine's loop takes, a bound
 * should one ever wait. The process's other executors step the same way (the
 * cpu's `unbroken.js`).
 */
const ATOMIC_STEP = 1;
const ATOMIC_STEPS = 4096;

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
 * @param {number} [options.turnMs]  Host ms a turn among ready threads lasts at least, as
 *        the instructions the executor retires a ms make it: no fewer than a quantum, no more
 *        than a solo one. Unset, every such turn is a quantum.
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
 * @param {() => void} [options.refreshClock]  Brings the guest's clock up to the host's: called
 *        every `CROSSINGS_PER_CLOCK` crossings of a slice, as between slices.
 * @param {() => boolean} [options.hostAnswering]  Whether a host call is still to answer
 *        through the event loop: then a turn with nothing to run here leaves at once rather
 *        than wait for the other executors, its caller waiting for both.
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
 * @param {'spread' | 'concentrate' | 'auto' | null} [options.placement]  One way of
 *        placing the threads of a process with executors of its own; none or 'auto':
 *        each moved on its gains (`placement.js`).
 * @param {Partial<import('./placement.js').PlacementOptions>} [options.placementTiming]
 *        The moves' windows, threshold and check, where a test shortens them.
 * @param {(count: number) => void} [options.readyChanged]  Told how many threads are
 *        ready to run with no executor running them, as that changes (`readyCount`).
 * @param {boolean} [options.playPinned]  Whether this executor may play the processor
 *        of a pinned thread whose calls into the host cost it most, where that saves
 *        the waits it adds (`playPinned`); on unless false.
 * @param {boolean} [options.freeHost]  Whether this executor keeps itself for the host's
 *        answers while a thread is pinned to its processor, playing one nothing is pinned
 *        to (`freeHost`); on unless false, and then the threads spread unless the run names
 *        a placement, and no processor is traded on its gains.
 */
export function createScheduler(options){
    const { cpu, switcher, quantum = 100_000, now = ()=>0, skipTo = ()=>0 } = options;
    const soloQuantum = options.soloQuantum ?? quantum * 10;
    const turnMs = options.turnMs ?? 0;
    const hostAnswering = options.hostAnswering ?? (()=>false);
    /**
     * Instructions this executor retires a host ms, from its turns that ran
     * their whole budget -- host calls inside them included, so code that
     * calls out a lot is slower by it -- averaged over the last few.
     */
    let perMs = 0;
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
     * A ring of records written over in turn, not pushed and shifted: a turn
     * is a few microseconds when threads take turns on one executor.
     * @type {{ thread: string, ms: number, end: number, outside: number }[]}
     */
    const recentTurns = Array.from({ length: RECENT_TURNS },
        ()=>({ thread: '', ms: 0, end: -Infinity, outside: 0 }));
    let recentAt = 0;
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
    /** Whether this executor keeps itself for the host's answers (`freeHost`). */
    const freeHost = options.freeHost !== false;
    /** How the threads are placed: as the run names, spread beside a free host, or on gains. */
    const placementWay = options.placement ?? (freeHost ? Placement.SPREAD : Placement.AUTO);
    /** Whether this executor may play a pinned thread's processor on its gains (`playPinned`). */
    const trading = options.playPinned !== false && !freeHost;
    /**
     * The moves the threads' gains propose (`gains`), made one at a time
     * (`placement.js`): a thread taking turns on this executor or not, this
     * executor playing a pinned thread's processor or its own.
     */
    const placement = createPlacement({ now: wall, apply: key=>move(key),
        opposite: key=>OPPOSITE.get(key.slice(0, key.indexOf(':')))
            ?.concat(key.slice(key.indexOf(':'))) ?? null,
        ...options.placementTiming });
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
     * How many threads are ready to run with no executor running them, as last
     * told (`readyChanged`): what Sleep(0) gives its turn to, read by the
     * guest's Sleep, which returns at once while it is zero and crosses into
     * the host otherwise. Told at each slice's start, as a turn chooses, and as
     * a thread is woken, made, suspended or resumed -- a host call's answer
     * coming back counts at the next turn, at most a slice late.
     */
    let readyTold = -1;
    const publishReady = ()=>{
        if (!options.readyChanged)
        {
            return;
        }
        const count = ready().length;
        if (count !== readyTold)
        {
            readyTold = count;
            options.readyChanged(count);
        }
    };

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
     * first column.
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
                ...next.parkedInStub === true ? { inStub: true } : {},
                // Only a thread sent into code that reads more than its
                // stack carries these: an exception handler's block.
                ...next.resumeRegisters ? { registers: next.resumeRegisters } : {},
            };
            onResume?.(next, next.lastWaitingOn ?? null, resume.returnValue >>> 0);
            next.parkedReturn = null;
            next.parkedInStub = false;
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
        const crossed = next.crossings - next.crossingsAt;
        if (instructions > 0 || crossed > 0)
        {
            // Each call adds its share of the window, the slice's instructions
            // age what was there: a steady rate stays itself, and a short slice
            // ending in a call weighs as little as its few instructions.
            const kept = 0.5 ** (instructions / CROSS_HALF);
            const each = instructions > 0 ? (1 - kept) / instructions : Math.LN2 / CROSS_HALF;
            next.crossRate = next.crossRate * kept + crossed * each;
            next.crossSeen = true;
        }
        next.crossingsAt = next.crossings;
        const could = Math.min(readyAtSlice.size, 3);
        parallel.ms[could] += held;
        parallel.instructions[could] += instructions;
        const turn = recentTurns[recentAt];
        recentAt = (recentAt + 1) % RECENT_TURNS;
        turn.thread = next.name ?? '?';
        turn.ms = held;
        turn.end = began + held;
        turn.outside = lastEnd === 0 ? 0 : Math.max(0, began - lastEnd);
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
     * The thread each of the process's other executors is running, when and
     * where its slice began, what this executor had retired by then
     * (`hereFrom`), and whether this executor, left nothing to run, has called
     * it back (`recalled`).
     *
     * @type {Map<any, { thread: any, began: number, from: number, hereFrom: number,
     *     recalled?: boolean, waitedFrom: number | null }>}
     */
    const placed = new Map();
    /** Whether `thread` runs on one of the other executors now. @param {any} thread */
    const placedElsewhere = thread=>[...placed.values()].some(on=>on.thread === thread);
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
     * And the instructions retired on this one (`hereRetired`) and on the
     * others (`elsewhereRetired`), whichever threads they were, and the calls
     * into the host the others' threads made (`crossings`), each answered here
     * (`answers` counts the passes that answered them), those of them answered
     * inside a slice of this one's (`crossingsInTurn`).
     */
    const sharedTime = { hereMs: 0, answerMs: 0, waitMs: 0, answers: 0, crossings: 0,
        crossingsInTurn: 0, turns: 0,
        betweenMs: 0, heldMs: 0, gapMs: 0, gaps: 0, hereRetired: 0, elsewhereRetired: 0,
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

    /**
     * The last threads placed on another executor, each with its calls into the
     * host a hundred thousand instructions when it went (`?`: not yet measured).
     *
     * @type {string[]}
     */
    const recentPlacements = [];
    /** Set while they are answered: an answer's own trap does not answer again. */
    let answering = false;
    /** Set while this executor's thread runs a long turn with the others free (`runHere`). */
    let soloShared = false;
    /** Set while a turn among ready threads runs past a quantum (`turnMs`). */
    let longTurn = false;
    /** Set when another executor's call, answered inside this one's slice, made a thread ready. */
    let readiedInAnswer = false;

    /**
     * A thread made ready during a long turn here that one of the other
     * executors is free to run ends the turn, so it starts there now rather
     * than at the turn's end. One made ready during a turn among ready threads
     * that runs past a quantum ends it too, at the running thread's next call
     * into the host, as Windows' boost of a thread its wait let go puts it
     * ahead of the one that let it go: the turn is long for threads that only
     * compute, and a thread woken by another -- a loader's event for the
     * thread that draws -- waited out a quarter of a millisecond, the loading
     * screen of a game a fifth slower in frames.
     *
     * @param {any} thread
     */
    const noteReady = thread=>{
        publishReady();
        if (inSlice && answering)
        {
            // Made ready by another executor's call answered inside this one's
            // slice: weighed once the answers are given (`answerExecutors`).
            readiedInAnswer = true;
            return;
        }
        if (!inSlice || thread === current
            || thread.state !== ThreadState.READY || thread.suspendCount > 0)
        {
            return;
        }
        if (longTurn)
        {
            longTurn = false;
            cpu.stop?.();
            return;
        }
        /** @type {any[]} */
        const free = (cpu.executors?.() ?? []).filter((/** @type {any} */ remote)=>!remote.busy());
        if (soloShared && free.some(remote=>allowedOn(thread, remote.index)))
        {
            soloShared = false;
            cpu.stop?.();
            return;
        }
        // One that may run only here, readied in the slice of one that may run
        // on an executor left free: the slice ends, and the turn's choice puts
        // the two each where it may run (`choose`). A game's main thread,
        // pinned to the first processor, woke a worker and waited for it; the
        // worker, running here, woke it in turn and went on, and the main
        // thread waited out the worker's turn with the other executor idle.
        if (current !== null && allowedOn(thread, 0) && !keptHere(current)
            && !free.some(remote=>allowedOn(thread, remote.index))
            && free.some(remote=>allowedOn(current, remote.index)))
        {
            soloShared = false;
            cpu.stop?.();
        }
    };
    /** The bell's count when they were last answered. */
    let answeredAt = -1;
    /** Their asks inside a slice here put off to the next back edge (`beforeTrap`). */
    let putOff = 0;
    /** Since when this executor has had nothing of its own while another ran a thread it could run (`RECALL_MS`). */
    let idleSince = -1;
    /**
     * Whether a ready thread was left this turn for the executor its mask
     * names to open (`waitsForExecutor`): a turn that ran nothing then is the
     * machine waiting for it, not a machine with nothing to do.
     */
    let awaitingExecutor = false;

    /**
     * The processor each executor plays, by its index: its own number, or,
     * while a trade is played (`playPinned`), this executor and the one whose
     * processor it plays have each other's.
     *
     * @type {number[]}
     */
    const played = [];
    /** @param {number} index */
    const playedBy = index=>played[index] ?? index;
    /** Trades made, either way. */
    let trades = 0;
    /** The processor this executor is to play (`move`): its own, 0, unless traded. */
    let tradeTarget = 0;
    /**
     * The executor this one is to trade with, running a thread still: it
     * gives the thread up at its slice's end (`choose`), and the trade is made
     * at the next turn, before a thread pinned to either processor runs where
     * its mask does not name.
     */
    let tradeWanted = -1;

    /**
     * The time, in host ms halved every `HOST_HALF_MS`, this executor spent
     * in a thread's calls into the host (`trapTimed`), wherever the thread
     * ran: the call alone, not the switch to another executor's state and
     * back, so a thread weighs the same played here or there.
     *
     * @param {any} thread @param {number} at
     */
    const hostTime = (thread, at)=>(thread.hostMs === undefined ? 0
        : thread.hostMs * 0.5 ** ((at - thread.hostAt) / HOST_HALF_MS));
    /** @param {any} thread @param {number} ms */
    const addHostTime = (thread, ms)=>{
        const at = wall();
        thread.hostMs = hostTime(thread, at) + ms;
        thread.hostAt = at;
        thread.hostTotal = (thread.hostTotal ?? 0) + ms;
    };

    /**
     * Whether `thread` may run on executor `index`: the processor that
     * executor plays is in its affinity mask (SetThreadAffinityMask), or it
     * has none.
     *
     * @param {any} thread @param {number} index
     */
    const allowedOn = (thread, index)=>thread.affinityMask === undefined
        || (thread.affinityMask >>> playedBy(index) & 1) === 1;

    /**
     * The one processor a thread's mask names, or -1.
     *
     * @param {any} thread
     */
    const pinnedTo = thread=>{
        const mask = thread.affinityMask;
        return mask === undefined || mask === 0 || (mask & (mask - 1)) !== 0 ? -1
            : 31 - Math.clz32(mask);
    };

    /**
     * Trades the processor this executor plays with the one executor `index`
     * plays; false while that one still runs a thread, which then gives it
     * up at its slice's end and takes nothing new (`tradeWanted`).
     *
     * @param {any[]} remotes @param {number} index
     */
    const trade = (remotes, index)=>{
        if (remotes.some(remote=>remote.index === index && remote.busy()))
        {
            tradeWanted = index;
            return false;
        }
        const here = playedBy(0);
        played[0] = playedBy(index);
        played[index] = here;
        // What `cpuid` names on each, as GetCurrentProcessorNumber answers
        // (`processorOf`): a thread pinned to a processor reads its number there.
        cpu.playProcessor?.(played[0] === 0 ? undefined : played[0]);
        remotes.find(remote=>remote.index === index)?.playProcessor?.(
            played[index] === index ? undefined : played[index]);
        tradeWanted = -1;
        trades++;
        recentPlacements.push(`processor ${played[0]} here, ${here} on e${index}`);
        if (recentPlacements.length > 16)
        {
            recentPlacements.shift();
        }
        return true;
    };

    /**
     * The processor of the thread pinned to one processor whose calls into the
     * host this executor spends most in (`hostTime`), when that is a share of
     * its time (`PLAY_FLOOR`) and `PLAY_MARGIN` times what it spends in those
     * of the thread pinned to its own processor; -1 where there is none.
     */
    const proposed = ()=>{
        const at = wall();
        let best = -1;
        let bestTime = 0;
        let own = 0;
        for (const thread of threads)
        {
            const processor = pinnedTo(thread);
            if (processor < 0 || thread.state === ThreadState.TERMINATED)
            {
                continue;
            }
            const spent = hostTime(thread, at);
            if (processor === 0)
            {
                own = Math.max(own, spent);
            }
            else if (spent > bestTime)
            {
                best = processor;
                bestTime = spent;
            }
        }
        // The halved sum of a steady share is that share of HOST_HALF_MS / ln 2.
        return bestTime >= PLAY_FLOOR * HOST_HALF_MS / Math.LN2 && bestTime >= PLAY_MARGIN * own
            ? best : -1;
    };

    /**
     * A thread that starts running: the time it waited ready for a turn is
     * counted (`readyMs`), what a move off this executor would give back to it.
     *
     * @param {any} thread
     */
    const startsRunning = thread=>{
        if (thread.state === ThreadState.READY && thread.readySince !== undefined)
        {
            thread.readyMs = (thread.readyMs ?? 0) + Math.max(0, now() - thread.readySince);
        }
        thread.state = ThreadState.RUNNING;
    };

    /**
     * Makes a move the gains proposed (`gains`): a thread taking turns here
     * (`in:` its id) or no longer (`out:`), this executor playing a pinned
     * thread's processor (`trade:` it) or its own again (`untrade:` the one
     * it played).
     *
     * @param {string} key
     */
    const move = key=>{
        const [kind, value] = key.split(':');
        const target = Number(value);
        if (kind === 'in' || kind === 'out')
        {
            const thread = threads.find(one=>one.id === target);
            if (thread !== undefined)
            {
                thread.placedHere = kind === 'in';
                note(thread, thread.placedHere ? 'placed here' : 'placed apart');
            }
        }
        else
        {
            tradeTarget = kind === 'trade' ? target : 0;
        }
    };

    /**
     * What each thread had done at the last read of the gains (`gains`), and
     * this executor's own: its slices and answers, what it retired in them.
     * @type {Map<any, { instructions: number, waited: number, ready: number }>}
     */
    const lastRead = new Map();
    let readAt = wall();
    let readHere = { ms: 0, answers: 0, retired: 0 };
    /** Instructions this executor retires a millisecond of its own slices. */
    let hereRate = 0;
    /** What an answer costs the thread elsewhere that waits for it, ms, as measured. */
    let answerCost = ANSWER_MS;

    /**
     * Each move's gain over the window since the last read, as a share of it:
     * the scheduler's reckoning of what the program would get done the other
     * way, from what its threads did in the window. With, for each thread,
     * its own work `c` (its instructions at this executor's rate), its waits
     * for answers on another executor `w`, its waits for a turn `r` and its
     * calls `x`, and this executor's busy share `E`:
     *
     *   in (to take turns here):  min(1 - ROOM - (E + c/dt), w/dt)
     *       here must have room for its work; it gains the waits it no longer makes;
     *   out (no longer here):     (min(r, c) - x*a)/dt - ROOM*c/dt
     *       it gains the turns it waited for, less the answers it will wait for;
     *   trade (play Q's processor, M -- pinned to this one's -- going apart):
     *       (w_Q - x_M*a)/dt  where E + (c_Q - c_M)/dt < 1 - ROOM, else -1;
     *
     * and `untrade` the same with Q and M the other way about. `a` is what an
     * answer costs, measured: the waits of the threads elsewhere over their calls.
     *
     * @returns {Map<string, number>}
     */
    const gains = ()=>{
        const began = performance.now();
        try
        {
            return reckon();
        }
        finally
        {
            reckonMs += performance.now() - began;
        }
    };
    /** The time spent reckoning the gains, all told: the price of the placement's math. */
    let reckonMs = 0;
    /** @returns {Map<string, number>} */
    const reckon = ()=>{
        const at = wall();
        const dt = at - readAt;
        /** @type {Map<string, number>} */
        const offered = new Map();
        const ownMs = sharedTime.hereMs - readHere.ms;
        const ownRetired = sharedTime.hereRetired - readHere.retired;
        if (ownMs > 1 && ownRetired > 0)
        {
            hereRate = ownRetired / ownMs;
        }
        const busy = (ownMs + sharedTime.answerMs - readHere.answers) / Math.max(dt, 1);
        // A slice elsewhere runs on for as long as nothing else wants its
        // executor: what its thread has waited and retired in it so far counts now.
        /** @type {Map<any, number>} */
        const inFlight = new Map();
        for (const [remote, on] of placed)
        {
            if (on.waitedFrom !== null)
            {
                const waited = remote.waitedUs();
                on.thread.waitedMs = (on.thread.waitedMs ?? 0)
                    + ((waited - on.waitedFrom) >>> 0) / 1000;
                on.waitedFrom = waited;
            }
            inFlight.set(on.thread, remote.retiredSoFar?.() ?? 0);
        }
        /** @type {Map<any, { c: number, w: number, r: number, x: number }>} */
        const did = new Map();
        let waits = 0;
        let calls = 0;
        for (const thread of threads)
        {
            if (thread.state === ThreadState.TERMINATED)
            {
                lastRead.delete(thread);
                continue;
            }
            const retired = thread.instructions + (inFlight.get(thread) ?? 0);
            const was = lastRead.get(thread) ?? { instructions: retired,
                waited: thread.waitedMs ?? 0, ready: thread.readyMs ?? 0 };
            const instructions = Math.max(0, retired - was.instructions);
            const one = { c: hereRate > 0 ? instructions / hereRate : 0,
                w: (thread.waitedMs ?? 0) - was.waited, r: (thread.readyMs ?? 0) - was.ready,
                x: thread.crossSeen === true ? thread.crossRate * instructions : 0 };
            did.set(thread, one);
            lastRead.set(thread, { instructions: retired,
                waited: thread.waitedMs ?? 0, ready: thread.readyMs ?? 0 });
            if (one.w > 0)
            {
                waits += one.w;
                calls += one.x;
            }
        }
        readAt = at;
        readHere = { ms: sharedTime.hereMs, answers: sharedTime.answerMs,
            retired: sharedTime.hereRetired };
        if (calls >= 16)
        {
            answerCost = answerCost * 0.8 + 0.2 * (waits / calls);
        }
        if (dt < 1 || hereRate === 0)
        {
            return offered;
        }
        for (const [thread, one] of placementWay === Placement.AUTO ? did : [])
        {
            if (!allowedOn(thread, 0) || one.c + one.w + one.r === 0)
            {
                continue;
            }
            if (thread.placedHere === true)
            {
                offered.set(`out:${thread.id}`, (Math.min(one.r, one.c) - one.x * answerCost) / dt
                    - ROOM * one.c / dt);
            }
            else if (!keptHere(thread))
            {
                offered.set(`in:${thread.id}`,
                    Math.min(1 - ROOM - (busy + one.c / dt), one.w / dt));
            }
        }
        if (trading)
        {
            const weighed = tradeTarget > 0 ? tradeTarget : proposed();
            const pinned = (/** @type {number} */ processor)=>[...did].filter(([thread])=>
                pinnedTo(thread) === processor).map(([, one])=>one);
            /** @param {{ c: number, w: number, x: number }[]} group */
            const sum = group=>group.reduce((all, one)=>({ c: all.c + one.c, w: all.w + one.w,
                x: all.x + one.x }), { c: 0, w: 0, x: 0 });
            if (weighed > 0)
            {
                // Q: the pinned thread whose processor is played or would be; M: those pinned here.
                const q = sum(pinned(weighed));
                const m = sum(pinned(0));
                const [comes, goes] = tradeTarget > 0 ? [m, q] : [q, m];
                offered.set(tradeTarget > 0 ? `untrade:${weighed}` : `trade:${weighed}`,
                    busy + (comes.c - goes.c) / dt < 1 - ROOM
                        ? (comes.w - goes.x * answerCost) / dt : -1);
            }
        }
        return offered;
    };

    /**
     * This executor plays the processor of the pinned thread whose calls cost
     * it most (`proposed`), the executor that played it taking this one's,
     * once its gains say so (`gains`, `tradeTarget`). A game
     * pins its render thread to its last processor and its main thread to its
     * first: the renderer's every Present and Lock, each a few hundred
     * microseconds of this executor's, crossed to it from the other while the
     * main thread ran here, and Call of Duty 4's render thread waited on
     * answers 112 s of its 119 in slices on eight executors. A count of calls
     * does not say it: the main thread's are many and cheap, the renderer's
     * few and dear. Played here, the renderer's calls are answered between its
     * own slices and the main thread computes on the other. Whether that gains
     * is reckoned as any move is (`gains`): the waits the renderer's calls no
     * longer make against those the main thread's will, where this executor
     * has the room. A program asking which processor it is on is told the one
     * played (`processorOf`), within its mask as before; `cpuid`'s APIC id
     * stays the executor's own.
     *
     * @param {any[]} remotes
     */
    const playPinned = (/** @type {any[]} */ remotes)=>{
        const want = freeHost ? freeTarget(remotes) : tradeTarget;
        const here = playedBy(0);
        if (here === want)
        {
            tradeWanted = -1;
            return;
        }
        // One pair traded at a time: back to its own first, then to the one wanted.
        trade(remotes, here !== 0 ? here : want);
    };

    /**
     * The processor this executor plays to keep itself for the host's answers
     * (`freeHost`), while a live thread is pinned to its own -- a game's main
     * thread, pinned to the first processor, whose guest code took four tenths
     * of this executor while the render thread on another waited for its
     * answers half of its time: the one of an open executor that the fewest
     * live threads' masks name, kept while no thread is pinned to it. 0 where
     * no thread is pinned to the first processor, or none is open.
     *
     * @param {any[]} remotes
     */
    const freeTarget = remotes=>{
        const live = threads.filter(thread=>thread.state !== ThreadState.TERMINATED);
        if (!live.some(thread=>pinnedTo(thread) === 0))
        {
            return 0;
        }
        const here = playedBy(0);
        if (here !== 0 && remotes.some(remote=>remote.index === here)
            && !live.some(thread=>pinnedTo(thread) === here))
        {
            return here;
        }
        let best = 0;
        let named = Infinity;
        for (const remote of remotes)
        {
            const count = live.filter(thread=>thread.affinityMask !== undefined
                && (thread.affinityMask >>> remote.index & 1) === 1).length;
            if (count < named)
            {
                best = remote.index;
                named = count;
            }
        }
        return best;
    };

    /**
     * Whether `thread` waits for an executor its mask names to open: it names
     * neither this one nor any open (`remotes`), and the first it names that
     * the cpu layer can open is opening (`wantExecutor`). A mask naming only
     * executors that cannot open leaves the thread where every thread may run.
     *
     * @param {any} thread @param {any[]} remotes
     */
    const waitsForExecutor = (thread, remotes)=>{
        if (thread.affinityMask === undefined || allowedOn(thread, 0)
            || remotes.some(remote=>allowedOn(thread, remote.index)))
        {
            return false;
        }
        for (let index = 1; index < 32; index++)
        {
            if (allowedOn(thread, index) && cpu.wantExecutor?.(index))
            {
                return true;
            }
        }
        return false;
    };

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
        if (thread.home !== undefined && allowedOn(thread, thread.home)
            && (thread.home === 0 || remotes.some(remote=>remote.index === thread.home)))
        {
            return thread.home;
        }
        if (waitsForExecutor(thread, remotes))
        {
            awaitingExecutor = true;
            return -1;
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
            current.context = cpu.captureContext(current.context);
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
        const began = wall();
        const taken = takenAt.get(remote);
        if (taken !== undefined)
        {
            sharedTime.gapMs += began - taken;
            sharedTime.gaps++;
            bucket(sharedTime.gapsUnder, began - taken);
        }
        startsRunning(next);
        placed.set(remote, { thread: next, began, from, hereFrom: sharedTime.hereRetired,
            waitedFrom: remote.waitedUs?.() ?? null });
        recentPlacements.push(`${next.name}>${remote.index} x${(next.crossRate * 100_000)
            .toFixed(1)}${next.crossSeen ? '' : '?'}`);
        if (recentPlacements.length > 16)
        {
            recentPlacements.shift();
        }
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
        // What is said from here on is owed an answer (`awaitedBy`).
        answeredAt = cpu.executorBell().rung();
        const inTurn = inSlice;
        readiedInAnswer = false;
        let heldInAnswer = false;
        let ran = null;
        let instructions = 0;
        const from = wall();
        try
        {
            for (const [remote, on] of placed)
            {
                const ended = remote.step((/** @type {() => void} */ reply)=>{
                    sharedTime.crossings++;
                    on.thread.crossings++;
                    const was = current;
                    const wasInSlice = inSlice;
                    if (wasInSlice)
                    {
                        sharedTime.crossingsInTurn++;
                    }
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
                    on.thread.context = cpu.captureContext(on.thread.context);
                    at = cpu.eip?.() ?? 0;
                });
                if (ended.fault !== null)
                {
                    cpu.remoteFault?.(ended.fault);
                }
                account(on.thread, ended.instructions, on.began, on.from, at);
                if (on.waitedFrom !== null)
                {
                    on.thread.waitedMs = (on.thread.waitedMs ?? 0)
                        + ((remote.waitedUs() - on.waitedFrom) >>> 0) / 1000;
                }
                // Called back after little beside what this executor did
                // meanwhile, or nothing: the two take turns. Called back after
                // as much, the two ran at once and are to go on doing so.
                const beside = sharedTime.hereRetired - on.hereFrom;
                const tookTurns = on.recalled === true
                    && (beside === 0 || ended.instructions < COUPLED_WORK * beside);
                on.thread.coupled = coupledNow(on.thread) * 0.75 + (tookTurns ? 0.25 : 0);
                on.thread.coupledAt = wall();
                sharedTime.elsewhereRetired += ended.instructions;
                ran = on.thread;
                instructions += ended.instructions;
                if (on.thread.awaitingHost === true)
                {
                    heldInAnswer = true;
                }
            }
        }
        finally
        {
            answering = false;
            sharedTime.answerMs += wall() - from;
            sharedTime.answers++;
        }
        // Inside this executor's turn (a crossing of its thread, or the others'
        // word at a back edge): a thread an answer made ready, or one whose
        // slice there was taken, is weighed as a wake during the turn -- a
        // long one ends, so the next choice places it (`noteReady`).
        // A thread whose call the host answers later goes on only once the
        // answer's promise settles, and that waits for this executor's event
        // loop: run to the turn's end, a solo turn of a thread spinning on the
        // other's exit code held it a million instructions per call (a thread
        // that loads a library and leaves: 590 ms a round, 2 ms between turns).
        if (inTurn && heldInAnswer)
        {
            cpu.stop?.();
        }
        else if (inTurn && (readiedInAnswer || ran !== null))
        {
            for (const thread of runnable())
            {
                if (thread !== current)
                {
                    noteReady(thread);
                }
            }
        }
        return { ran, instructions };
    };

    /**
     * The ready threads this executor may run while it is the only one open,
     * the others' executors asked for: one for every ready thread past the
     * one that runs (`wantExecutors`), and a thread whose mask names another
     * waiting for it to open.
     */
    const hereNow = ()=>{
        const candidates = ready();
        if (cpu.wantExecutors === undefined)
        {
            return candidates;
        }
        const here = candidates.filter(thread=>!waitsForExecutor(thread, []));
        awaitingExecutor = here.length < candidates.length;
        if (here.length > 1)
        {
            cpu.wantExecutors(here.length - 1);
        }
        return here;
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
        startsRunning(next);

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
        // Among ready threads a turn is a quantum, or as many instructions as
        // `turnMs` takes at this executor's rate when that is more: a quantum
        // is 30 us of translated code at its fastest, and a turn's own cost
        // about 9 us, so threads taking turns on one executor lost a fifth to
        // turning where a lone thread lost nothing; code that runs slower
        // keeps the quantum, and no ready thread waits longer than it did for
        // a quantum of it. Not with a deadline within a few such turns, nor
        // with other executors' threads running where their calls are
        // answered only between turns and at this one's crossings: where they
        // interrupt this one's slice (`interruptible`), at its next back edge,
        // its turns are as long with them running as without.
        const clear = noDeadlineBefore === null ? Infinity : noDeadlineBefore - now();
        const others = placed.size === 0 || cpu.interruptible?.() === true;
        const solo = (!shared || others) && readyAtSlice.size === 0
            && clear > SOLO_CLEAR_MS;
        const asked = solo ? soloQuantum
            : turnMs > 0 && others && clear > turnMs * TURN_CLEAR
                ? Math.min(soloQuantum, Math.max(quantum, Math.floor(perMs * turnMs)))
                : quantum;
        soloShared = shared && solo;
        longTurn = !solo && asked > quantum;
        publishReady();
        let instructions = cpu.runSlice(asked);
        soloShared = false;
        longTurn = false;
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
        const held = wall() - began;
        if (instructions >= asked && held > 0)
        {
            perMs = perMs === 0 ? instructions / held : perMs * 0.75 + instructions / held * 0.25;
        }
        account(next, instructions, began, from, cpu.eip?.() ?? 0, asked);
        // A slice that ended on a host call still answering: the answer is the
        // thread's own call, and once it comes the thread goes on (`pick`).
        next.hostContinues = next.awaitingHost === true && !next.answeredElsewhere;
        next.answeredElsewhere = false;
        return { ran: next, instructions, switched };
    };

    /** A thread's `coupled` share as it stands now. @param {any} thread */
    const coupledNow = thread=>(thread.coupled === 0 ? 0
        : thread.coupled * 0.5 ** ((wall() - thread.coupledAt) / COUPLED_HALF_MS));

    /**
     * Whether `thread` runs on this executor and no other, where it may run
     * here: it calls into the host more often than `HOST_BOUND` over its last
     * million or so instructions (`crossRate`) -- elsewhere every such call is a round trip back
     * here, and the thread waits on its calls longer than it computes: a
     * game's renderer, a call every hundred instructions, was put on the other
     * executor when its sound thread took this one's turn, and drew a fifth
     * fewer frames -- or its runs elsewhere have ended with this executor
     * calling it back (`COUPLED`), the two taking turns rather than running
     * at once. Such threads take turns here, as on one processor.
     *
     * @param {any} thread
     */
    const keptHere = thread=>allowedOn(thread, 0)
        && (placementWay === Placement.CONCENTRATE || thread.placedHere === true
        || coupledNow(thread) > COUPLED
        || thread.crossSeen === true && thread.crossRate > HOST_BOUND);

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
        awaitingExecutor = false;
        let candidates = runnable();
        // One whose processor this executor is about to play takes nothing new.
        const free = remotes.filter(remote=>!remote.busy() && remote.index !== tradeWanted);
        /** @type {any} */
        let here = null;
        /** @type {any[]} */
        const waiting = [];
        /** Threads going to their own executors this turn, placed once the turn is decided. @type {[any, any][]} */
        const going = [];
        while (candidates.length > 0 && (here === null || free.length > 0))
        {
            const next = pick(candidates);
            candidates = candidates.filter(thread=>thread !== next);
            const home = keptHere(next) ? 0 : homeOf(next, remotes);
            const remote = free.find(one=>one.index === home);
            if (home === 0 && here === null)
            {
                here = next;
            }
            else if (remote !== undefined)
            {
                free.splice(free.indexOf(remote), 1);
                going.push([remote, next]);
            }
            else
            {
                waiting.push(next);
            }
        }
        // This executor left with nothing of its own: it runs the first thread
        // bound for another rather than wait for it -- a program whose one
        // working thread had a home elsewhere ran it there, its calls into the
        // host crossing over, while this one waited (a tenth slower on two).
        if (here === null && waiting.length === 0)
        {
            const at = going.findIndex(([, thread])=>allowedOn(thread, 0));
            if (at >= 0)
            {
                here = going[at][1];
                free.push(going[at][0]);
                going.splice(at, 1);
            }
        }
        for (const [remote, next] of going)
        {
            place(remote, next);
        }
        for (const next of waiting)
        {
            if (here === null && allowedOn(next, 0))
            {
                here = next;
                continue;
            }
            // One bound to the host takes this executor's turn from one that
            // computes, which goes where it would have, or waits for its turn here.
            if (keptHere(next))
            {
                const at = here === null || keptHere(here) ? -1
                    : free.findIndex(one=>allowedOn(here, one.index));
                if (at >= 0)
                {
                    place(free.splice(at, 1)[0], here);
                    here = next;
                }
                continue;
            }
            const at = free.findIndex(one=>allowedOn(next, one.index));
            if (at >= 0)
            {
                place(free.splice(at, 1)[0], next);
                continue;
            }
            // One that may run only here takes this executor's turn from one
            // that may run on an executor left free, which runs there: a game's
            // main thread, pinned to the first processor, waited for a thread
            // at priority 15 to end its turn here while the other executor idled.
            const there = here === null || keptHere(here) || !allowedOn(next, 0) ? -1
                : free.findIndex(one=>allowedOn(here, one.index));
            if (there >= 0)
            {
                place(free.splice(there, 1)[0], here);
                here = next;
            }
            else if (here !== null && free.length === 0)
            {
                break;
            }
        }
        // Ready threads left without an executor: as many more opened, as the
        // process has (`wantExecutors`); until they open they take turns. One
        // bound to the host waits for this executor and wants no other.
        const unplaced = candidates.filter(thread=>!keptHere(thread)).length
            + waiting.filter(thread=>thread !== here && !keptHere(thread)
                && thread.state === ThreadState.READY
                && !placedElsewhere(thread)).length;
        if (unplaced > 0)
        {
            cpu.wantExecutors?.(remotes.length + unplaced);
        }
        // This executor with nothing to run while another keeps a thread it
        // could run: past RECALL_MS that one lets it go at its slice's end and
        // it comes here (above) -- a program whose one working thread was
        // started while its first still ran had it run elsewhere, its code
        // translated for the layout every other executor shares (a fifth
        // slower than this one's own) and its calls into the host crossing over.
        let recall = false;
        if (here === null && [...placed.values()].some(on=>allowedOn(on.thread, 0)))
        {
            idleSince = idleSince < 0 ? wall() : idleSince;
            recall = wall() - idleSince >= RECALL_MS;
            if (recall)
            {
                for (const on of placed.values())
                {
                    on.recalled = true;
                }
            }
        }
        else
        {
            idleSince = -1;
        }
        // An executor whose thread is wanted back -- suspended, ended by
        // another, called back here, bound to the host since it was placed --
        // gives it up at its slice's end, as it keeps one it is let go on with
        // past its slice. One left without an executor waits for one to give
        // its thread up at its turn's end (`hold`): the one taken here is not
        // left, it runs this turn, still ready until it does; one bound to the
        // host waits for this executor, not for them.
        const wanted = recall || tradeWanted >= 0 || [...placed.values()].some(on=>
            on.thread.state !== ThreadState.RUNNING || on.thread.suspendCount > 0
            || keptHere(on.thread));
        const left = candidates.some(thread=>!keptHere(thread))
            || waiting.some(thread=>thread !== here && !keptHere(thread)
                && thread.state === ThreadState.READY);
        if (wanted || left && bell.hold === undefined)
        {
            bell.goOn?.(false);
        }
        else if (left)
        {
            bell.hold();
        }
        else
        {
            bell.goOn?.(true);
        }
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
     *     elsewhere?: boolean, rung?: number }}  elsewhere: nothing ran here, the others
     *     still run; rung: the others' bell as the turn last looked, when the turn left
     *     without waiting for it
     */
    const runShared = remotes=>{
        const turnFrom = wall();
        if (sharedTurnEnd >= 0)
        {
            sharedTime.betweenMs += turnFrom - sharedTurnEnd;
        }
        sharedTime.turns++;
        if (placementWay === Placement.AUTO || trading)
        {
            placement.tick(gains);
        }
        playPinned(remotes);
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
     *     elsewhere?: boolean, rung?: number }} turn
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
     * @returns {{ ran: any | null, instructions: number, switched: boolean,
     *     elsewhere?: boolean, rung?: number }}
     */
    const runSharedTurn = remotes=>{
        expire();
        let { ran, instructions } = answerExecutors();
        const bell = cpu.executorBell();
        for (;;)
        {
            const here = choose(remotes, bell);
            publishReady();
            if (here !== null)
            {
                const hereFrom = wall();
                const turn = runHere(here, true);
                sharedTime.hereMs += wall() - hereFrom;
                sharedTime.hereRetired += turn.instructions;
                bucket(sharedTime.hereUnder, wall() - hereFrom);
                const after = answerExecutors();
                return { ran: turn.ran, instructions: turn.instructions + instructions
                    + after.instructions, switched: turn.switched };
            }
            if (placed.size === 0 && awaitingExecutor)
            {
                return { ran, instructions, switched: false, elsewhere: true };
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
                // A host call still to answer through the event loop, which a
                // wait here holds back: its caller waits for the answer and the
                // others' bell together (`rung`). A caller parked on the guest's
                // own message queue is not one -- its look is the next turn's.
                if (hostAnswering())
                {
                    return { ran: null, instructions, switched: false, elsewhere: true,
                        rung: seen };
                }
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

    // Something the other executors said since they were last answered: the
    // translator forming regions here stops at the next one to let it be.
    cpu.awaitedBy?.(()=>placed.size > 0 && cpu.executorBell().rung() !== answeredAt);

    // Another executor's crossing is answered here with its thread made
    // current (`answerExecutors`): its call is timed as one of this one's.
    /** @param {number} ms */
    const timeCall = ms=>{
        if (current !== null)
        {
            addHostTime(current, ms);
        }
    };
    // Calls are timed only while the process has other executors: the time is
    // what a processor trade weighs (`proposed`), and with one executor there
    // is nothing to trade -- the three clock reads a call cost were a sixth of
    // a single executor's time in a program that calls the host in a loop.
    let callsTimed = false;
    /** @param {boolean} on */
    const timeCalls = on=>{
        if (on !== callsTimed)
        {
            callsTimed = on;
            cpu.trapTimed?.(on ? timeCall : null);
        }
    };

    /**
     * The other executors' traps, answered at a crossing of this executor's
     * thread or at their ask inside its slice (`crossing` false). A trap of
     * theirs answered here comes through too, counted where it is answered.
     * An ask inside an unbroken routine is put off (false) to the guest's next
     * back edge: the routine may hold a lock the answer takes -- a Direct3D
     * device's, which the host waits 200 ms for and then breaks, every time a
     * renderer here met another thread's call there.
     */
    let crossingsUnclocked = 0;
    cpu.beforeTrap?.((/** @type {boolean | undefined} */ crossing)=>{
        if (current !== null && crossing !== false && !answering)
        {
            current.crossings++;
            if (++crossingsUnclocked >= CROSSINGS_PER_CLOCK)
            {
                crossingsUnclocked = 0;
                options.refreshClock?.();
            }
        }
        if (placed.size === 0)
        {
            return true;
        }
        if (crossing === false && atomic.starts.length !== 0 && insideAtomic(cpu.eip?.() ?? 0))
        {
            putOff++;
            return false;
        }
        const rung = cpu.executorBell().rung();
        if (rung !== answeredAt)
        {
            answeredAt = rung;
            answerExecutors();
        }
        return true;
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
                // The process's first thread is this executor's from the start
                // (`homeOf`): with the others opened as threads want them, the
                // first thread asked about once one opened could be a later
                // one, and the first went to the other executor, each of its
                // host calls crossing back -- an effect's renderer took 5223
                // turns for 31 while the thread spinning beside it waiting for
                // it ran 520 M instructions for 1.9 M.
                home: threads.length === 0 ? 0 : undefined,
                /**
                 * Its calls into the host, wherever it ran, and how many an
                 * instruction it made over its last million or so instructions
                 * (`crossRate`, `account`): what running it on another executor
                 * costs in crossings, for the report.
                 */
                crossings: 0,
                crossingsAt: 0,
                crossRate: 0,
                crossSeen: false,
                /**
                 * How often its runs on another executor ended with this one
                 * left nothing to run and calling it back (`coupled`).
                 */
                coupled: 0,
                coupledAt: 0,
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
                /**
                 * Set while the host call it waits on is answered by another
                 * process: a wait on that process, not part of one call, so
                 * the answer does not let it go on ahead of the others.
                 */
                answeredElsewhere: false,
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
         * Runs `fn` between turns with no thread on the CPU: the one there is
         * switched away from as a turn's end would, its registers saved, and
         * whichever runs next is put back from its own. A call another process
         * makes in this one (`cross-process.js`) is no thread's call, and a
         * thread it suspends or whose registers it reads or replaces is one
         * that stopped where its saved state says.
         *
         * @template T
         * @param {() => T} fn
         * @returns {T}
         */
        outside(fn){
            if (current)
            {
                current.context = cpu.captureContext(current.context);
                if (current.state === ThreadState.RUNNING)
                {
                    current.state = ThreadState.READY;
                    current.readySince = now();
                }
                current = null;
            }
            return fn();
        },

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
            // And the process's other executors, which end their threads' runs
            // where they will, are told too.
            cpu.noteUnbroken?.(start, length >>> 0);
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

        /** How many threads are ready to run with no executor running them. */
        readyCount: ()=>ready().length,

        /**
         * The processor `thread` reads as its own: the one played by the
         * executor it runs on now -- another executor while that one holds it,
         * this one otherwise (`playPinned`).
         *
         * @param {any} thread
         * @returns {number}
         */
        processorOf(thread){
            for (const [remote, on] of placed)
            {
                if (on.thread === thread)
                {
                    return playedBy(remote.index);
                }
            }
            return playedBy(0);
        },

        /**
         * The host call `thread` is making is answered by another process of
         * the run: on Windows a wait on that process, during which every other
         * ready thread runs. So its answer puts it among the ready threads
         * rather than straight back on the processor.
         *
         * @param {any} thread
         */
        answeredElsewhere(thread){
            if (thread)
            {
                thread.answeredElsewhere = true;
            }
        },

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

        /**
         * Gives the CPU to the next ready thread and lets it run a quantum.
         *
         * Returns what happened, so a caller driving the machine can tell the
         * difference between progress, an idle system and a finished one --
         * three states that look identical if all you get back is a number.
         *
         * @returns {{ ran: any | null, instructions: number, switched: boolean,
         *     elsewhere?: boolean, rung?: number }}  elsewhere: nothing ran here, the
         *     others still run; rung: the others' bell as the turn last looked, when it
         *     left without waiting for them
         */
        runOnce(){
            const remotes = cpu.executors?.() ?? [];
            timeCalls(remotes.length > 0);
            if (remotes.length > 0)
            {
                return runShared(remotes);
            }
            expire();
            let candidates = hereNow();
            if (candidates.length === 0 && awaitingExecutor)
            {
                return { ran: null, instructions: 0, switched: false, elsewhere: true };
            }
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
                candidates = hereNow();
                if (candidates.length === 0)
                {
                    // One the deadline woke may want an executor that is
                    // still opening: a machine waiting for it, not one idle.
                    return awaitingExecutor
                        ? { ran: null, instructions: 0, switched: false, elsewhere: true }
                        : { ran: null, instructions: 0, switched: false };
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
            thread.blockedAt = wall();
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
            if (thread.blockedAt !== undefined)
            {
                const ms = wall() - thread.blockedAt;
                thread.blockedFor ??= new Array(BLOCKED_BOUNDS.length + 1).fill(0);
                const under = BLOCKED_BOUNDS.findIndex(bound=>ms < bound);
                thread.blockedFor[under < 0 ? BLOCKED_BOUNDS.length : under]++;
            }
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
            publishReady();
            // Running on another executor, the thread stops at that one's next
            // slice end rather than at whatever turn of this one comes next.
            if (placedElsewhere(thread))
            {
                cpu.executorBell?.()?.goOn?.(false);
            }
            return previous;
        },

        /**
         * Brings a thread running on another executor back, its slice ended
         * there and its registers saved, as a processor stops a thread before
         * its context is read: GetThreadContext of a thread SuspendThread asked
         * to stop answers where it stopped, not where it was last placed.
         * Answered from the process's own executor; inside the answer to
         * another executor's call the others cannot be waited for, and the
         * thread is left where it runs.
         *
         * @param {any} thread
         * @returns {boolean} whether the thread runs nowhere now
         */
        settle(thread){
            const runs = ()=>placedElsewhere(thread);
            if (!runs())
            {
                return true;
            }
            if (answering)
            {
                return false;
            }
            const bell = cpu.executorBell();
            bell.goOn?.(false);
            const from = wall();
            while (runs() && wall() - from < ENDING_WAIT_MS)
            {
                const seen = bell.rung();
                answerExecutors();
                if (runs())
                {
                    bell.wait(seen, EXECUTORS_WAIT_MS);
                }
            }
            return !runs();
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
            // Ended by another while it runs on another executor, it stops at
            // that one's next slice end, as a suspended one does: until then it
            // still runs, on the stack and the blocks it was given.
            if (placedElsewhere(thread))
            {
                cpu.executorBell?.()?.goOn?.(false);
            }
        },

        /**
         * Whether `thread` is on an executor now: this one's, or another it
         * was placed on. A thread that has ended is done with what it was
         * given only once it is on none.
         *
         * @param {any} thread
         */
        running: thread=>thread === current || placedElsewhere(thread),

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
                recentPlacements: [...recentPlacements],
                mostAtOnce,
                sharedTime: JSON.stringify(sharedTime),
                placement: JSON.stringify({ way: placementWay, ...placement.diagnostics(),
                    reckonMs: Number(reckonMs.toFixed(1)),
                    here: threads.filter(thread=>thread.placedHere === true)
                        .map(thread=>thread.name).join(',') }),
                // The processor each executor plays, where a trade moved one
                // (`playPinned`), and how many trades.
                played: trades === 0 ? '' : `${Array.from({ length: Math.max(played.length, 1) },
                    (_, index)=>playedBy(index)).join(',')} after ${trades}`,
                // The other executors' asks met inside an unbroken routine here.
                asksPutOff: putOff,
                recentWakes: recentWakes.slice(),
                // Each thread's waits another thread ended, by how long they
                // lasted: counts below 0.02, 0.05, ... 20 ms and past it.
                blockedFor: threads.filter(thread=>thread.blockedFor !== undefined)
                    .map(thread=>`${thread.name} ${thread.blockedFor.join('/')}`).join(' | '),
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
                // at and how often it had to be boosted to run at all, its calls
                // into the host a hundred thousand instructions (`crossRate`),
                // the ms this executor spent answering them (`hostTime`, where
                // timed), and the processors its affinity mask allows, where it
                // has one: a thread pinned elsewhere is never kept on this executor.
                byThread: threads
                    .map(thread=>`${thread.name} ${thread.instructions} ${thread.state} p${
                        absolutePriority(thread.priority)} b${thread.boosts}${
                        thread.boosted ? '+' : ''}${thread.worstGap === undefined ? ''
                        : ` g${Math.round(thread.worstGap)}/${thread.lateGaps ?? 0}`}`
                        + ` x${(thread.crossRate * 100_000).toFixed(1)}`
                        + (thread.hostTotal === undefined ? ''
                            : ` h${Math.round(thread.hostTotal)}`)
                        + (thread.affinityMask === undefined ? ''
                            : ` a${(thread.affinityMask >>> 0).toString(16)}`))
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
