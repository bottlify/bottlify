/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { FIRST_PROCESS_ID } from './process-layout.js';
import { frameDrops } from '../frame-drops.js';
import { createInputRoute } from '../layers/input/route.js';
import { moduleKeyOf, readWholeFile } from './libraries.js';
import { liveDumpOf } from './live-dump.js';
import { jumpBytes, relocatablePrefix } from '../layers/loader/internal/hooks.js';
import { portTranslator } from '../host/pool/pool.js';
import { readProgramImage } from './system-host.js';
import { NOT_MEASURED, withZones } from '../memory-zones.js';
import { captureTrace, formatTrace } from '../trace.js';
import {
    HOST_ANSWER_TICKS, IDLE_LOOK_MS, SOUND_PUMP_MS, answeringWhile, idleWait,
} from './run-waits.js';

/** How many of the hottest sampled addresses a report carries the code around. */
const HOT_CODE_SAMPLES = 64;

/**
 * How long a report waits for the graphics worker's devices to say what they
 * counted: a worker that is far behind, or gone, leaves their tables as they
 * were rather than holding the report.
 */
const REPORT_WAIT_MS = 1000;

/** How many divergences a run's diagnostics list, in the order they were said. */
const DIVERGENCES_KEPT = 128;

/**
 * What a process is to whoever started it (`AppController`): run it, stop
 * it, read what it did, hear its events, look into it while it runs - the
 * object `createApp` hands back, over the machine `app.js` built.
 */

/**
 * @param {Record<string, any>} deps  the process's parts it reads, by the names `app.js`
 *     gives them; `blocks`, `fetched`, `fetching`, `mainModule`, `mountedBlocks` and
 *     `paused` asked for, since they are set as the process runs
 * @returns {any}  the AppController
 */
export function processController(deps){
    const {
        HEAP_BASE, STACK_POOL_BASE, allocateFromHeap, blocksSeen, breathe, bridge, bundleReads,
        clock, clockSource, core, cpu, creditClock, disposed, events, fail, filesystem, film,
        filmSoundOwedMs, findModule, foreground, glCounters, gone, guestHeld, idlers, image,
        input, installWatch, journal, jsSampler, kernel, layerTraces, leftOutAt64,
        lentTranslators, logSinks, mainThread, memory, missingCalls, modules, nextDeadlineMs,
        options, ownsTranslationStore, pacing, pauseRun, reportDivergence, resumeRun, saver,
        showVideoFrame, sound, spare, stopSavingRegistry, systemLibraries, translationStore,
        wasDisposed, watches, win32, windowsLibraries, machine,
    } = deps;
    // Asked for: set after this controller is made.
    const { blocks, fetched, fetching, mainModule, mountedBlocks, paused } = deps;
    /**
     * The volume as the embedder sees it from outside: through no process's
     * view of it (a 32-bit process's file system redirection on a 64-bit
     * Windows), and a child's image at the path its parent resolved.
     *
     * @template T @param {() => T} fn @returns {T}
     */
    const outside = fn=>(filesystem.unredirected ? filesystem.unredirected(fn) : fn());
    return {
        /** Where the program was mapped and where it starts. */
        image,

        /**
         * Runs the program to completion, one scheduler turn at a time.
         *
         * Turns rather than a free-running machine: a turn is where a thread
         * can be preempted, where a blocked one is put back on the road, and
         * where "nothing can run" becomes visible instead of looking like work.
         *
         * @param {Object} [runOptions]
         * @param {number} [runOptions.maxTurns]
         *     Turns in which the guest ran something. A turn that ran nothing
         *     is the machine waiting -- on a fetch, on a timer -- and waiting
         *     is not the work this bounds: with a yield every turn, a wait of
         *     a few seconds is tens of thousands of such turns.
         * @param {number | null} [runOptions.timeoutMs]
         *     Wall milliseconds the run may take, whatever it did with them.
         *     The bound for a program that only waits: the turn budget never
         *     runs out on a machine that does nothing, so a caller that needs
         *     a windowed program with an empty queue to come back at all
         *     bounds it here.
         * @returns {Promise<number>} the guest's exit code
         */
        async run({ maxTurns = 200000, timeoutMs = null } = {}){
            let worked = 0;
            const startedAt = clockSource();
            // Read at the top of a turn, where a bounded wait has just
            // returned: a machine sleeping between looks overruns by one
            // look at most.
            const expired = ()=>timeoutMs !== null && clockSource() - startedAt >= timeoutMs;
            // How many turns in a row have retired nothing. This is what tells
            // a machine waiting on its own next instruction from one waiting on
            // the host, which are the same shape from here and want opposite
            // waits.
            let spun = 0;
            const sharedViews = options.system?.sharedViews ?? null;
            const turnProcess = options.processId ?? FIRST_PROCESS_ID;
            /**
             * The process's other executors' bell as the last turn left it
             * without waiting for them, a call waiting on the host: the idle
             * wait ends on its ring too. Null otherwise.
             * @type {number | null}
             */
            let othersRung = null;
            /** When the sound was last pumped (`SOUND_PUMP_MS`). */
            let pumpedAt = -Infinity;
            while (worked < maxTurns && !expired() && !wasDisposed())
            {
                if (paused())
                {
                    await paused().gate;
                }

                // A turn is a phase, and everything inside it is a phase of its
                // own. Not decoration: a region nobody opened a phase around
                // measures nothing, so unaccounted time reads as no cost at all
                // and the largest item in a run can be the one item nobody
                // bracketed. `turn` is what the rest is checked against -- the
                // sum of its occurrences is the run -- and its own self time is
                // the loop's overhead and nothing else.
                journal.begin('turn', journal.PhaseKind.HOST);
                // The views this process shares with another are brought up
                // to what the other wrote in its turns.
                sharedViews?.enter(turnProcess);
                try
                {
                    // What passed since the last slice ended -- the yield, the
                    // pump, the cursors, the polls -- is the program's time as
                    // much as the slice was, and it is credited before the
                    // sound is pumped so that a cursor read there is current.
                    creditClock();

                    // One yield per turn, so a host function suspended on a
                    // guest callback can make progress between them. Without it
                    // the loop never returns to the event loop on its normal
                    // path and such a handler would be resumed exactly never.
                    //
                    // Bracketed because that handler runs here: whatever a
                    // resumed host call then does is this turn's cost, and it is
                    // charged to nothing if nobody opened a phase around it.
                    journal.begin('microtasks', journal.PhaseKind.HOST);
                    await Promise.resolve();
                    journal.end('microtasks');

                    // And a real one when the host says so, because that one
                    // is a microtask and microtasks do not let anything else
                    // happen. A program running hot never leaves the microtask
                    // queue, so nothing outside gets a turn: a click on a pause
                    // button is not delivered, a timer does not fire, a
                    // presented frame is not composed, and a page looks hung
                    // while the guest is working perfectly. When is the host's
                    // call -- by what is pending and by a clock, never by turn:
                    // a trip round the event loop is paid for whatever the
                    // browser runs in the gap, and one per turn was the largest
                    // host phase of a run.
                    //
                    // Sound is written ahead before the turn yields to the
                    // browser, not after: the device reads on a thread of its
                    // own, and a yield is where the browser may take the thread
                    // to compose a frame or collect its garbage. Topping the
                    // ring up first is what keeps it from draining empty in that
                    // gap -- heard as a click in otherwise steady sound.
                    //
                    // Once a SOUND_PUMP_MS, though, not once a turn: a ring
                    // topped up a millisecond ago is as full as it gets, and
                    // a machine whose threads wait out a deadline turns --
                    // and yields -- tens of thousands of times a second, a
                    // pump each, 8 % of a game's thread, all doing nothing.
                    //
                    // A caller parked on a queue of the guest's own is a
                    // suspended call too, but the guest answers it, at the look
                    // every turn gives it below: what is left waits on the
                    // host. Counted before the look, when every such caller is
                    // parked rather than halfway through looking.
                    const queued = idlers.value.length;
                    // A call running guest code it called back -- a window procedure,
                    // a COM method a server's message window dispatches -- is not
                    // one: counted, a server compiling under such a call went to
                    // the event loop every turn and waited there longer than it ran.
                    const onHost = Math.max(0, bridge.waitingOnHost() - queued);
                    const turnYield = pacing.yield({
                        suspended: onHost, fetching: fetching(), idlers: queued, spun,
                    });
                    const pumpAt = pacing.now?.() ?? performance.now();
                    if (sound && pumpAt - pumpedAt >= SOUND_PUMP_MS)
                    {
                        pumpedAt = pumpAt;
                        journal.begin('pump', journal.PhaseKind.HOST);
                        sound.pump();
                        journal.end('pump');
                    }
                    if (turnYield)
                    {
                        journal.begin('yield', journal.PhaseKind.HOST);
                        await answeringWhile(turnYield, cpu.executorBell?.(),
                            ()=>kernel.answerExecutors?.());
                        journal.end('yield');
                    }

                    // And devices that keep a cursor are moved on, whether or not
                    // the guest asked anything. A program is entitled to hand a
                    // buffer to a device and then spin on the flag the device sets
                    // in it -- the flag is the contract, and a real device honours
                    // it from its own clock. A cursor advanced only when the guest
                    // calls in is a cursor that never advances for such a program,
                    // and the spin is then forever: the machine is running, the
                    // clock is running, and the one thing that would end it is
                    // waiting for a call that will not come.
                    journal.begin('waveTick', journal.PhaseKind.HOST);
                    win32.waveTick?.();
                    journal.end('waveTick');

                    // And a film, for the same reason: nothing inside the guest
                    // advances one. A program that plays a cinematic hands the
                    // graph a file and then sits in its message loop until it is
                    // told the film ended.
                    journal.begin('videoTick', journal.PhaseKind.HOST);
                    showVideoFrame(win32.videoTick?.(clockSource(), filmSoundOwedMs()));
                    journal.end('videoTick');

                    // And a turn is also when anything waiting for something to
                    // arrive -- a message loop with an empty queue -- gets to look
                    // again. Taken as a batch: a waiter that goes back to waiting
                    // must not be released twice by its own turn.
                    if (idlers.value.length > 0)
                    {
                        journal.begin('idlers', journal.PhaseKind.HOST);
                        const waiting = idlers.value;
                        idlers.value = [];
                        for (const release of waiting)
                        {
                            release();
                        }
                        await Promise.resolve();
                        journal.end('idlers');
                    }

                    // Still waiting after being let look, or a host call
                    // suspended on something outside the microtask queue -- a
                    // fetch, a file read -- means the machine has nothing to do
                    // until the host gets a turn. A microtask does not give it
                    // one, so this is the one place the loop hands it back.
                    //
                    // Through the unclamped yield while the guest is still
                    // getting work done, and on a timer once it has stopped.
                    // A program sitting in its own message loop takes this
                    // branch on most turns while running perfectly well, and a
                    // zero timeout is clamped to four milliseconds and more once
                    // they nest -- so this branch, the one for a machine with
                    // nothing to do, was the largest cost in a run by far,
                    // bigger than every host call and all the emulation
                    // together. The timer is kept for the case it is right for,
                    // which is a machine that really can do nothing until the
                    // host answers.
                    const wait = idleWait({ fetching: fetching(), idlers: queued,
                        suspended: onHost, spun,
                        others: othersRung !== null });
                    if (wait)
                    {
                        journal.begin(wait.phase, journal.PhaseKind.HOST);
                        creditClock();
                        // A caller sitting on an empty message queue is waiting
                        // for two things: something posted from outside, which
                        // nobody can predict, and a timer of its own, whose due
                        // time is written down in the queue. Moving the clock to
                        // it -- never past the host's, as everywhere else -- is
                        // the difference between finding out and looking to see.
                        // Looking cost several thousand clamped timeouts a run.
                        const due = wait.timer && fetching() === 0
                            ? win32.queue?.()?.nextTimerDue?.() ?? null
                            : null;
                        if (due !== null && clock.skipTo(due) > 0)
                        {
                            journal.end(wait.phase);
                            continue;
                        }
                        // Whichever comes first: the range request answering,
                        // or the timer coming round again.
                        //
                        // Not the request alone, however much cheaper that
                        // reads. A thread waiting on the network is not the
                        // only thread there is, and waiting for the answer
                        // stops the machine for the whole of a request that can
                        // take four seconds -- measured at two and a half times
                        // the wall clock of looking again and finding work.
                        //
                        // And a host call answering ends the wait at once:
                        // when every thread is parked on the host, that is
                        // the only event that can put one back on the
                        // processor, and sleeping through it costs the whole
                        // of the look interval for every call the guest makes.
                        /** @type {Promise<void>[]} */
                        const wakes = [];
                        if (fetched() && wait.timer)
                        {
                            wakes.push(fetched());
                        }
                        if (wait.timer && bridge.suspended() > 0)
                        {
                            wakes.push(bridge.answered());
                        }
                        if (wait.timer && othersRung !== null)
                        {
                            wakes.push(cpu.executorBell().waitAsync(othersRung, IDLE_LOOK_MS));
                        }
                        await pacing.wait({
                            timer: wait.timer, sleep: wait.timer,
                            deadlineMs: nextDeadlineMs(), wakes,
                        });
                        // This time passed for the guest too, and it is the only
                        // time nothing credits. A thread suspended on a host call
                        // is parked on `hlt` and still counts as runnable, so the
                        // scheduler never reaches the branch that moves the clock
                        // to the next deadline -- and the clock is otherwise
                        // credited only for turns the guest actually ran. A
                        // machine that idles for most of its wall time then holds
                        // its own clock nearly still, and every timed wait in the
                        // guest waits far longer than it asked for: a sleep, a
                        // timeout, a WM_TIMER, a wave cursor. The wait that would
                        // end the idling is itself the thing the idling stops
                        // from expiring. In full: a wait this long was asked
                        // for, and a cap here would make it end early.
                        creditClock(Infinity);
                        const waitedMs = journal.end(wait.phase);
                        // The frame's idle time by what it waited on: a call on
                        // the host by name, the process's other executors.
                        if (import.meta.BOTTLIFY_DIAGNOSTICS !== false)
                        {
                            const call = onHost > 0 ? ` ${bridge.lastSuspended()}` : '';
                            journal.note(`${wait.phase}${call}${othersRung !== null
                                ? ' others' : ''}`, waitedMs);
                        }
                    }

                    // What the machine's state says before it is given another
                    // slice: a failed host call, a pending replacement, an exit,
                    // a fault. Each is a call across a layer boundary and there
                    // are four of them per turn, so they are worth a phase of
                    // their own rather than an unmeasured constant.
                    journal.begin('poll', journal.PhaseKind.HOST);
                    const failure = bridge.failure();
                    const code = win32.exitCode();
                    const fault = cpu.fault();
                    journal.end('poll');

                    if (failure)
                    {
                        throw fail('host-call', failure);
                    }

                    if (code !== null)
                    {
                        events.emit('exit', { code });
                        return code;
                    }

                    // A processor exception stops the machine rather than raising
                    // anything: the report cannot be thrown from where it is
                    // noticed, so it is left here to be found. Checked before the
                    // next turn, because from outside a halted processor and a
                    // program that finished look exactly alike.
                    if (fault)
                    {
                        const error = new Error(fault.text);
                        Object.assign(error, { code: 'GUEST_FAULT', fault });
                        throw fail('guest-fault', error);
                    }

                    let step;
                    try
                    {
                        // The one measurement that separates emulation from our
                        // own code. Host calls trap out from inside this and open
                        // their own phase, so what is left as this phase's self
                        // time is the guest actually executing -- which is the
                        // number every question about speed starts from.
                        journal.begin('guest', journal.PhaseKind.GUEST);
                        const compiledBefore = import.meta.BOTTLIFY_DIAGNOSTICS !== false
                            ? cpu.compiledModules() : 0;
                        step = kernel.runOnce();
                        // Compiling happens inside the slice, on the way to a
                        // hot page, and is the guest's time only by position.
                        if (import.meta.BOTTLIFY_DIAGNOSTICS !== false)
                        {
                            journal.compiled(cpu.compiledModules() - compiledBefore);
                        }
                        // Where the guest stood when its slice ran out. Sampled
                        // here because this is the only boundary the host owns: a
                        // program that decides something inside its own code makes
                        // no call to record, and the instruction pointer is the
                        // only thing that says which code that was.
                        if (options.sample && step.ran)
                        {
                            // With what the turn actually retired. A sample per
                            // turn weights every thread the same, and a parked
                            // one retires two instructions and a busy one a
                            // hundred thousand -- so an unweighted profile
                            // reads as though the machine spends its life in
                            // the park loop.
                            options.sample(cpu.eip(), step.instructions ?? 1);
                        }
                    }
                    catch (e){
                        // A fault inside the guest, or inside a host function
                        // answering it. Either way the program cannot be told, and
                        // the state that explains it is about to be lost.
                        journal.end('guest');
                        throw fail('guest', e);
                    }
                    journal.end('guest', { instructions: step.instructions ?? 0 });

                    // A slice that ended on a host call: an answer due in a few
                    // microtasks -- a host call running guest code builds its
                    // frame a promise or two later -- is let arrive now. The loop
                    // otherwise awaits only when nothing is ready, and a thread
                    // parked on an answer already made waited until every other
                    // thread had nothing to do.
                    if (step.ran?.awaitingHost)
                    {
                        let tick = 0;
                        while (tick < HOST_ANSWER_TICKS && step.ran.awaitingHost)
                        {
                            await null;
                            tick++;
                        }
                        kernel.noteHostAnswer?.(tick, !step.ran.awaitingHost);
                    }

                    // A turn spent waiting on the process's other executors is
                    // the guest at work there, not a machine with nothing to do:
                    // counted as a spin, every one went round the event loop and,
                    // with a thread in GetMessage, slept on a timer while the
                    // others waited for their traps to be answered.
                    spun = step.instructions === 0 && !step.elsewhere ? spun + 1 : 0;
                    othersRung = step.elsewhere && step.rung !== undefined ? step.rung : null;

                    // The guest ran for real, so its clock moves. Nothing else in
                    // the engine does this, and without it the clock only ever
                    // advanced when a program waited -- so a program that does not
                    // wait sees no time pass at all. That is not a small error: a
                    // frame loop concludes its frame took no time, a timed wait
                    // never expires, and a device whose cursor runs on the clock
                    // never finishes a buffer, which strands a program spinning on
                    // the flag that buffer would have set.
                    //
                    // Credited from the host's wall clock rather than from retired
                    // instructions, because what a program is measuring is how long
                    // its own work took, and on a machine this slow that really is
                    // the wall time. A slow machine is a slow machine; a machine
                    // where no time passes is a broken one.
                    creditClock();

                    if (step.ran)
                    {
                        worked++;
                    }
                    // A turn whose threads all ran on the process's other
                    // executors is no idle machine: it came back for the clock
                    // and the event loop, theirs still running.
                    if (!step.ran && !step.elsewhere)
                    {
                        // Nothing ready is not the same as nothing to wait
                        // for. A thread parked on a host call that has not
                        // answered is deliberately not a candidate -- that is
                        // what lets the scheduler move the clock -- so a turn
                        // where only such threads exist means the machine is
                        // waiting on us, and the wait above is where that is
                        // paid for.
                        if (bridge.waitingOnHost() > 0 || fetching() > 0 || idlers.value.length > 0)
                        {
                            continue;
                        }
                        // A call whose guest code runs and waits in the kernel
                        // -- a ServiceMain under StartServiceCtrlDispatcher, a
                        // callback that waits on an event -- waits as its
                        // thread does, and the wait above does not count it:
                        // passed over here too, the loop turned round the
                        // event loop without sleeping for as long as it waited.
                        const nested = bridge.suspended() > 0;
                        // Or every thread is in a timed wait and the clock has
                        // caught up with the host's, so the only thing left to
                        // do is let real time reach the deadline. That is a
                        // machine waiting, not a machine stuck, and the two look
                        // identical from here without asking.
                        const waitingOnTime = kernel.nextDeadline() !== null
                            || (win32.queue?.()?.nextTimerDue?.() ?? null) !== null;
                        if (waitingOnTime)
                        {
                            journal.begin('idle-deadline', journal.PhaseKind.HOST);
                            await pacing.wait({
                                timer: false, sleep: true,
                                deadlineMs: nextDeadlineMs(), wakes: [],
                            });
                            const waitedMs = journal.end('idle-deadline');
                            if (import.meta.BOTTLIFY_DIAGNOSTICS !== false)
                            {
                                journal.note(`idle-deadline ${kernel.nextDeadlineOn?.()
                                    ?? 'timer'}`, waitedMs);
                            }
                            continue;
                        }
                        // Or another process of the run is running beside this
                        // one, and what every thread here waits on -- a child's
                        // exit, an object it sets -- is its to answer; or a
                        // thread waits inside a call, on what whoever sets
                        // its object answers.
                        if (options.othersRunning?.() || nested)
                        {
                            journal.begin('idle-host-wait', journal.PhaseKind.HOST);
                            await pacing.wait({
                                timer: true, sleep: true, deadlineMs: null, wakes: [],
                            });
                            journal.note(nested ? 'idle-host-wait inside a call'
                                : 'idle-host-wait other process', journal.end('idle-host-wait'));
                            continue;
                        }
                        // Either everything finished without the program exiting,
                        // or every thread is waiting on something no one will
                        // signal -- and the diagnostics name what.
                        const waiting = kernel.diagnosticsSnapshot().waiting;
                        if (waiting.length > 0)
                        {
                            throw fail('deadlock',
                                new Error(`deadlock: ${waiting.join('; ')}`));
                        }
                        throw fail('no-threads',
                            new Error('every thread ended without the process exiting'));
                    }
                }
                finally
                {
                    sharedViews?.leave(turnProcess);
                    // A process that ended shares nothing from here on.
                    if (sharedViews && (win32.exitCode() !== null || cpu.fault()))
                    {
                        sharedViews.forget(turnProcess);
                    }
                    journal.end('turn');
                }
            }
            if (disposed.value)
            {
                throw gone();
            }
            throw fail('runaway', new Error(worked < maxTurns
                ? `program did not finish within ${timeoutMs} ms`
                : `program did not finish within ${maxTurns} turns`));
        },

        /** The program's first thread. */
        mainThread,

        /**
         * The run as a session that can be replayed, when one was recorded.
         *
         * Everything `replaySession` needs and nothing else: the order of
         * events at the bridge, and the threads with the stacks they were
         * given. Written to a file, this is a failure that took a person a
         * minute of clicking turned into a test that runs in a second.
         */
        /** @returns {{ threads: any[], events: any[] }} */
        recordedSession(){
            const recorded = bridge.recorded();
            const named = new Set(recorded.map((/** @type {any} */ one)=>one.thread));
            return {
                threads: kernel.threads()
                    .filter((/** @type {any} */ one)=>named.has(one.name))
                    .map((/** @type {any} */ one)=>({
                        name: one.name, stackTop: one.stackTop, stackLimit: one.stackLimit,
                    })),
                events: recorded,
            };
        },

        /**
         * Stops handing out turns without ending anything; `resume` continues
         * from the same place, since no thread's state was touched.
         */
        pause: pauseRun,
        resume: resumeRun,
        stop: ()=>cpu.stop(),

        /**
         * Answers a message box the page was shown. A program's own boxes are
         * dialogs on its desktop, answered there as a person answers them, and
         * the engine's own notice waits on nothing -- so no box is ever
         * standing here to be answered.
         *
         * @param {number} id   The id the `message-box` event carried.
         * @param {number} button
         * @returns {boolean} Whether a box was standing under that id: never.
         */
        answerMessageBox(id, button){
            void id;
            void button;
            return false;
        },

        /**
         * Watches, answers, or swallows something the program did.
         *
         * Handlers run in registration order and the first to return anything
         * other than `undefined` decides and stops the rest -- so observing and
         * intercepting are the same mechanism, and a handler that returns
         * nothing has not intervened.
         *
         * What is emitted today: `output` ({ handle, text }) for a write to a
         * standard handle, `debug` ({ text }) for the program's own tracing,
         * `error` ({ reason, error }) for a failure the program cannot see,
         * and `exit` ({ code }) when it ends.
         *
         * @param {string} name
         * @param {(payload: any) => any} handler
         * @returns {() => void} stops this handler
         */
        on: (name, handler)=>events.on(name, handler),
        /** @param {string} name @param {(payload: any) => any} handler */
        off: (name, handler)=>events.off(name, handler),

        /**
         * An engine's own account of where the guest ran, by address, weighted
         * by the instructions retired there, for an engine that keeps one.
         * Cork keeps none here (`available` answers false): its block profile
         * (`cork.blockProfile`) is a diagnostic run's.
         */
        guestProfile: {
            /**
             * An engine's event counters by name and retired instructions by
             * opcode since it started; null where it keeps none.
             */
            instructionStats: ()=>core.api('cpu').profile?.instructionStats() ?? null,
            available: ()=>Boolean(core.api('cpu').profile?.available()),
            /** @param {{ keepCode?: boolean }} [how] Kept code makes
             * the account the interpreter's own instructions. */
            start: how=>Boolean(core.api('cpu').profile?.start(how)),
            stop: ()=>core.api('cpu').profile?.stop(),
            /**
             * @returns {{ entries: { address: number, instructions: number, hits: number }[],
             *     dropped: number } | null}
             */
            read: ()=>core.api('cpu').profile?.read() ?? null,
        },

        /**
         * The journal: everything the engine reported, in one ordered stream.
         *
         * Every event the engine emits is written here as it happens, under its
         * own name as the category, so a reader that wants the whole story does
         * not have to know the names in advance and subscribe to each. That is
         * the point of it: a program's behaviour is the interleaving, and three
         * separate views of three kinds of event cannot be interleaved after
         * the fact.
         *
         * `drain(since, limit)` reads forward and says where to resume, which
         * is what a live view polls with; `recent(count)` reads the tail
         * without moving anything, which is what a snapshot of a failure wants.
         * `setLevel` decides how much is kept, per category.
         */
        log: {
            /**
             * A record from outside the engine, into the same journal: what
             * the host's own GPU device reported about a frame, which a reader
             * of the run's log must see beside the frame it dropped.
             *
             * @param {'error' | 'warn' | 'info'} level
             * @param {string} category @param {string} text
             */
            write: (level, category, text)=>core.api('log').write(level, category, '{0}', text),
            /** @param {number} [since] @param {number} [limit] */
            drain: (since, limit)=>core.api('log').drain(since, limit),
            /** @param {number} [count] */
            recent: count=>core.api('log').recent(count),
            /** The journal this machine writes into, for the next process of the run to share. */
            journal: ()=>core.api('log').journal?.() ?? null,
            profiler: ()=>core.api('log').profiler?.() ?? null,
            /** @param {string} category @param {string | number} level */
            setLevel: (category, level)=>core.api('log').setLevel(category, level),
            /** @param {string | number} level */
            setDefaultLevel: level=>core.api('log').setDefaultLevel(level),
            /**
             * The topics a reader can switch on, for one offering a filter.
             * Named here rather than discovered from what has been logged, so a
             * filter can offer a topic before anything in it has happened.
             *
             * Most are the areas a host call is filed under; `input.press` is
             * not a call at all but the other end of the same question -- what
             * arrived from outside, as against what the program asked.
             */
            areas: ()=>[
                ...['cpu', 'gpu', 'audio', 'video', 'input', 'net', 'com', 'hook']
                    .map(area=>`call.${area}`),
                'input.press',
                'input.message',
            ],

            /**
             * Where a frame's time went: every phase by self time, the slowest
             * frames, and the share of each that was ours rather than the
             * guest's.
             *
             * @param {number} [worst] How many of the slowest frames to name.
             */
            profile: worst=>core.api('log').profile(worst),

            /** @param {number} [count] The most recent frames, one row each. */
            frames: count=>core.api('log').frames(count),

            /**
             * The last `count` frames' drops, each told why, and the rates of
             * the slowest frames (`frame-drops.js`).
             *
             * @param {number} [count]
             */
            drops: count=>frameDrops(core.api('log').frames(count ?? 1000)),

            /**
             * The journal's block and every layer's tables, for a reader on
             * another thread. Handed over once: everything above is then read
             * there, out of this memory, and this thread is never asked for a
             * record, a frame or a counter again.
             *
             * @returns {import('../layers/log/internal/reader.js').LogMemory}
             */
            memory: ()=>core.api('log').memory(),
        },

        /** @param {(handle: number, text: string) => void} sink */
        attachLog(sink){
            /** @param {any} payload */
            const handler = payload=>{
                sink(payload.handle, payload.text);
            };
            logSinks.set(sink, handler);
            events.on('output', handler);
        },
        /** @param {(handle: number, text: string) => void} sink */
        detachLog(sink){
            const handler = logSinks.get(sink);
            if (handler)
            {
                events.off('output', handler);
                logSinks.delete(sink);
            }
        },

        /**
         * Puts a message in the guest's queue: a keystroke, a mouse move, a
         * request to close. This is the seam the input layer will post through,
         * and the way a test drives a program that is waiting for a user.
         *
         * @param {{ hwnd?: number, message: number, wParam?: number, lParam?: number }} message
         */
        post(message){
            win32.queue().post({
                hwnd: message.hwnd ?? foreground(),
                message: message.message,
                wParam: message.wParam ?? 0,
                lParam: message.lParam ?? 0,
            });
        },

        /**
         * Input, which a program reads two ways at once: `attach` listens to
         * the viewport the game draws into and turns what happens there into
         * both a window message and a change of DirectInput state.
         *
         * `send` is the same road without a browser on it, for a test or a
         * recorded session; `poll` reads what has no events of its own -- a
         * gamepad -- and belongs on whatever already runs once a frame, since
         * a scheduler turn is far too often to ask.
         */
        input: {
            /** @param {any} canvas @param {{ pointerLock?: boolean }} [inputOptions] */
            attach: (canvas, inputOptions)=>input.attach(canvas, inputOptions),
            detach: ()=>input.detach(),
            /** @param {any} event */
            send: event=>input.send(event),
            poll: ()=>input.poll(),
            showKeyboard: ()=>input.showKeyboard?.() ?? false,
            hideKeyboard: ()=>input.hideKeyboard?.(),
            keyboardShown: ()=>input.keyboardShown?.() ?? false,
            route: ()=>createInputRoute(event=>input.send(event)),
            // Where the cursor is: where a locked pointer points
            // (`inputRecipient`), which no event of the page says.
            cursor: ()=>input.cursor?.() ?? null,
        },

        /**
         * A window on the running machine, for a tool that has to look at it.
         *
         * Deliberately narrow and read-only: what a diagnostic needs is to see
         * what a program was given, and everything else it might ask for is
         * already an event or a diagnostics counter.
         */
        debug: {
            /** @param {number} address @param {number} length */
            read: (address, length)=>memory.readBytes(address >>> 0, length),
            /**
             * A program of the volume started beside this one, as its
             * CreateProcess would start it: the child's process id, or null.
             *
             * @param {string} commandLine
             */
            start: commandLine=>core.api('win32').launch(String(commandLine)),
            /**
             * The calls the guest made through Direct3D's command rings, which
             * no call log shows: kept from now on for the last `count` of them,
             * 0 to stop; answers what was kept.
             *
             * @param {number} [count]
             */
            ringTrace: count=>core.api('graphics').ringTrace?.(count) ?? [],
            /**
             * The draw check (`graphics.checkDraws`) switched on or off as the
             * program runs: from the moment it is on, each draw recorded for
             * the graphics worker from a buffer compares the bytes it reads
             * with what the worker was sent of them; the report's
             * `drawChecks` has an entry for each time it was turned on.
             * Answers whether it is on.
             *
             * @param {boolean} on
             */
            checkDraws: on=>core.api('graphics').checkDraws?.(on === true) ?? false,
            /**
             * Whether the guest answers waits on events, mutexes and semaphores,
             * SetEvent, ResetEvent, ReleaseMutex and ReleaseSemaphore by itself
             * (`win32.handleWords`),
             * switched as the program runs: off, every one crosses into the
             * host. Answers whether the guest answers them.
             *
             * @param {boolean} on
             */
            handleWords: on=>core.api('kernel').handleWords?.(on !== false) ?? false,
            /**
             * Keeps the functions named -- `'ShowWindow,PeekMessage'`, '' none --
             * out of the bridge's ring of recent calls from now on, so that what
             * a program did around one moment is still there to read when an
             * idle loop of a few calls would have pushed it out. Answers the
             * functions it matched.
             *
             * @param {string} [names]
             */
            callRingSkip: (names = '')=>bridge.skipInRing?.(String(names).split(',')) ?? [],
            /**
             * Whether a system library this build makes exports a name, or a
             * number when there is no name: what an import table is checked
             * against without running the program (tools/bundles/import-audit.mjs).
             * Null for a library this build does not make.
             *
             * @param {string} dll @param {string | null} name @param {number | null} [ordinal]
             */
            exported: (dll, name, ordinal = null)=>{
                const module = systemLibraries.has(moduleKeyOf(dll)) ? findModule(dll) : null;
                if (!module)
                {
                    return null;
                }
                return (name !== null ? module.addressOf(name)
                    : module.addressOfOrdinal(ordinal ?? -1)) !== null;
            },
            /**
             * The desktop the window manager paints into, or null before any
             * window has drawn: for a tool that writes the screen to a file.
             *
             * @returns {{ width: number, height: number, pitch: number,
             *     bytes: Uint8Array } | null}
             */
            desktop: ()=>{
                const surface = core.api('graphics').gdiDrawing().desktop();
                return surface
                    ? { width: surface.width, height: surface.height, pitch: surface.pitch,
                        bytes: surface.bytes.subarray(surface.offset,
                            surface.offset + surface.pitch * surface.height) }
                    : null;
            },
            /** Every live window, children included, as the window manager lists them. */
            windows: ()=>win32.windows(),
            ...liveDumpOf(options.device?.worker, {
                pause: pauseRun,
                resume: resumeRun,
                paused: ()=>paused() !== null,
            }),
            /** @param {string} name */
            register: name=>cpu.readReg32(name),
            eip: ()=>cpu.eip(),
            /**
             * Every image mapped so far and where: for a tool that watches a
             * routine in a library the program imported, which was mapped
             * before the run and so never announced itself as loaded.
             *
             * @returns {{ name: string, base: number, size: number }[]}
             */
            modules: ()=>[...modules.nameHolders()].map(module=>({
                // The program's own image by its file, which is the name a
                // tool asks for it by; its record's own name is a stand-in.
                name: module === mainModule()
                    ? String(mainModule().path).split(/[\\/]/).pop() ?? module.name
                    : module.name,
                base: module.base,
                size: module.size ?? 0,
                // A system module laid out whose bytes nothing asked for yet.
                placed: module.placed !== false,
            })),
            /**
             * Which image an address belongs to, or null: a stack of return
             * addresses is a list of numbers until each is given its module.
             *
             * @param {number} address
             */
            moduleAt: address=>{
                const at = address >>> 0;
                for (const module of modules.nameHolders())
                {
                    if (at >= module.base && at < module.base + (module.size ?? 0))
                    {
                        return { name: module.name, base: module.base, offset: at - module.base };
                    }
                }
                return null;
            },
            /**
             * A watch in front of a routine nothing imports, so a call the
             * program makes into its own code appears in the trace with its
             * arguments and its answer.
             *
             * The routine's opening instructions, whose lengths the caller
             * read off a disassembly, move to a trampoline that ends in a
             * jump back, and the entry becomes a jump into a watch stub whose
             * target is the trampoline. They must hold no relative branch. A
             * diagnostic, and a rewrite of the program's code: for a run
             * under observation, never for one that is meant to be faithful.
             *
             * @param {number} address
             * @param {{ label: string, argBytes: number, lengths: number[],
             *     strings?: (number | string)[] }} how
             */
            hook: (address, { label, argBytes, lengths, strings = [] })=>{
                const displaced = lengths.reduce((sum, n)=>sum + n, 0);
                const at = address >>> 0;
                const region = memory.find(at);
                if (!region)
                {
                    throw new Error(`hook: nothing is mapped at 0x${at.toString(16)}`);
                }
                const moved = memory.readBytes(at, displaced).slice();
                if (!relocatablePrefix(moved, lengths))
                {
                    throw new Error(`hook: the first ${displaced} bytes at 0x${at.toString(16)}`
                        + ' cannot be moved (too few, or a relative branch among them)');
                }
                const trampoline = allocateFromHeap(displaced + 5);
                memory.writeBytes(trampoline, moved);
                memory.writeBytes(trampoline + displaced,
                    jumpBytes(trampoline + displaced, at + displaced));
                const stub = installWatch(label, argBytes, trampoline, strings);
                const patch = new Uint8Array(displaced).fill(0x90);
                patch.set(jumpBytes(at, stub));
                // Opened for the write and put back exactly as it was: an image
                // whose data the program writes is mapped writable, and leaving
                // it read-only would fault the program's next store.
                const before = region.access;
                memory.protect(region.name, memory.Access.READ_WRITE_EXECUTE);
                memory.writeBytes(at, patch);
                memory.protect(region.name, before);
                return { stub, trampoline };
            },
        },

        /**
         * The sound this process is making, for whoever is playing it.
         *
         * `memory()` is what goes to an audio worklet: shared memory, so the
         * two sides never wait for each other -- `{ table }` when this
         * process has a shared table, `{ control, samples }` when it has the
         * engine backend's ring instead. `ring()`/`table()` are the live
         * object itself, for a caller on this same thread (this process's own
         * `run` below calls `pump` once a scheduler turn; a test harness
         * without shared memory reads `ring()` directly).
         */
        audio: {
            /** A span of the output's arena for a process beside this one. @param {number} bytes */
            lend: bytes=>core.api('audio').output().lend?.(bytes) ?? -1,
            /** @param {number} offset @param {number} bytes */
            takeBack: (offset, bytes)=>core.api('audio').output().takeBack?.(offset, bytes),
            /**
             * The output for a process beside this one where it has no arena
             * to lend (`mixer.js` borrow); null where it cannot be borrowed.
             *
             * @param {{ fill?: () => void }} asked
             */
            borrow: asked=>core.api('audio').output().borrow?.(asked) ?? null,
            ring: ()=>core.api('audio').output().ring,
            table: ()=>core.api('audio').output().table,
            memory: ()=>core.api('audio').output().memory,
            format: ()=>{
                const mixer = core.api('audio').output();
                return { sampleRate: mixer.sampleRate, channels: mixer.channels };
            },
        },

        /**
         * The decoder this machine uses, for the process that takes its place.
         *
         * A machine is a process; the decoder is not. Handed on, the rebuilt
         * machine's first cinematic does not wait for a second instantiation
         * of the same binary, and nothing outside the machine that wants one
         * decoder for the run has to reach into a module to find it.
         */
        media: {
            instance: ()=>core.api('media').instance?.() ?? null,
        },

        /** The registry the program reads and writes; it outlives the process. */
        registry: ()=>win32.registry(),

        /**
         * The libraries this build synthesises as Windows' own, by file name
         * (`windowsLibraries`): what a bottle does not carry out of system32.
         *
         * @returns {string[]}
         */
        systemLibraries: ()=>[...windowsLibraries],

        /**
         * The session: everything the program has written, and the way to put
         * files in from outside.
         */
        session: {
            /**
             * Every file, a file with more than one name under each of them:
             * what a reader that keeps no links -- a bottle -- takes.
             *
             * @returns {{ path: string, bytes: Uint8Array }[]}
             */
            export: ()=>filesystem.export(undefined, { everyName: true }),
            /** @returns {string[]} The empty directories it made, which `export` cannot carry. */
            directories: ()=>filesystem.exportDirectories(),
            /**
             * @param {{ path: string, bytes?: Uint8Array, delete?: boolean }[]} changes
             * @param {{ quiet?: boolean }} [how]
             */
            apply: (changes, how)=>filesystem.apply(changes, how),
            /** @returns {number} */
            generation: ()=>filesystem.generation(),
            /** @param {number} mark */
            changesSince: mark=>filesystem.changesSince(mark),
            /**
             * Whether another process's session is on the same drives as this
             * one's: the run's, where what one writes the other reads.
             *
             * @param {any} other
             */
            shares: other=>filesystem.runVolume() !== null
                && other?.runVolume?.() === filesystem.runVolume(),
            /** The run's drives this session is on, or null for this process's own. */
            runVolume: ()=>filesystem.runVolume(),
        },

        /**
         * The volume as the program sees it, read from outside while it runs:
         * a directory's entries and a file's bytes, the bundle, the system
         * volume and what the program wrote alike.
         */
        files: {
            /**
             * @param {string} path
             * @returns {{ name: string, path: string, directory: boolean, size: number,
             *     modified: number }[]}
             */
            list: path=>outside(()=>filesystem.list(path)).map((/** @type {any} */ entry)=>({
                name: entry.name, path: entry.path, directory: entry.directory === true,
                size: entry.size ?? 0, modified: entry.modified ?? 0 })),
            /**
             * The whole file, the bundle's blocks not fetched yet fetched first
             * (`readWholeFile`): read directly, a file of a lazily read bundle
             * threw on its first missing block. Null for no file.
             *
             * @param {string} path
             * @returns {Promise<Uint8Array | null>}
             */
            // Opened before its first wait, so through no view.
            read: path=>outside(()=>readWholeFile(filesystem, blocks(), path)),
            /**
             * A directory made from outside, as a person makes one in Explorer
             * beside the running program: what an installer expects to find
             * and a disc or an earlier step did not leave.
             *
             * @param {string} path
             * @returns {boolean} true when it was made, false when it was there.
             */
            createDirectory: path=>outside(()=>filesystem.createDirectory(path)),
            /**
             * A file or a directory with everything in it, removed from outside: a
             * setting the program saved and would read back, taken away so it asks
             * again.
             *
             * @param {string} path
             * @returns {boolean} true when there was something to remove.
             */
            remove: path=>outside(function remove(at = path){
                const entry = filesystem.stat(at);
                if (!entry)
                {
                    return false;
                }
                if (entry.directory)
                {
                    for (const child of filesystem.list(at))
                    {
                        remove(child.path);
                    }
                    filesystem.removeDirectory(at);
                }
                else
                {
                    filesystem.deleteFile(at);
                }
                return true;
            }),
            /**
             * A file written whole from outside, replacing one of that name.
             *
             * @param {string} path @param {Uint8Array} bytes
             */
            write: (path, bytes)=>{
                const handle = outside(()=>filesystem.open(path,
                    { read: false, write: true, disposition: 'create-always' }));
                if (!handle)
                {
                    throw new Error(`${path} could not be created`);
                }
                try
                {
                    filesystem.write(handle, bytes);
                }
                finally
                {
                    filesystem.close(handle);
                }
            },
        },

        /**
         * What the translator has made of this bundle's code, as the seed a
         * bundle carries (`attachTranslations`); null without a translating
         * engine or a store. Asked before `dispose`, which takes the
         * translator away.
         *
         * @returns {Promise<Uint8Array | null>}
         */
        exportTranslations: ()=>cpu.exportTranslations(),

        /**
         * A worker of the run's translation pool, lent to this process: the
         * port is the process's end of the worker's, and the token names it
         * when the pool asks for it back (`recallTranslator`). A machine whose
         * engine takes none tells the worker so at once.
         *
         * @param {MessagePort} port @param {number} token
         */
        lendTranslator(port, token){
            const adapter = portTranslator(port);
            if (cpu.attachTranslator(adapter))
            {
                lentTranslators.set(token, adapter);
            }
            else
            {
                adapter.terminate();
            }
        },

        /**
         * The milliseconds the translator emitted on this process's own
         * thread, ever: what it did with no worker to send a batch to.
         */
        translatedHere: ()=>cpu.translatedHere?.() ?? 0,

        /** @param {number} token */
        recallTranslator(token){
            const adapter = lentTranslators.get(token);
            if (adapter !== undefined)
            {
                lentTranslators.delete(token);
                cpu.detachTranslator(adapter);
            }
        },

        exitCode: ()=>win32.exitCode(),

        /**
         * A child that ran beside this process has exited with this code: the
         * threads waiting on it wake. The screen is the run's presenter's to
         * compose again, from the pictures of the processes left.
         *
         * @param {any} request @param {number} code
         */
        childExited(/** @type {any} */ request, /** @type {number} */ code){
            win32.childExited(request, code);
        },

        /**
         * An event a child this process debugs reported, answered once the
         * debugger continues it (`debug-events.js`).
         *
         * @param {any} request
         * @param {import('../layers/win32/kernel32/debug-events.js').DebugReport} report
         * @returns {Promise<number>}
         */
        debugEvent: (/** @type {any} */ request, /** @type {any} */ report)=>
            win32.debugEvent(request, report),

        /**
         * Ends this process from outside, as its parent's TerminateProcess
         * does: the run sees the code at the machine's next turn.
         *
         * @param {number} code
         */
        terminate: (/** @type {number} */ code)=>win32.terminate(code),

        /**
         * A call its parent makes in this process, between its turns.
         *
         * @param {import('../layers/win32/kernel32/cross-process.js').CrossCall} call
         */
        answerCall: (/** @type {any} */ call)=>win32.answerCall(call),

        /**
         * A file off this process's volume, waited for if it is not here yet.
         * How the caller reads a child's image before this process -- and the
         * volume with it -- is torn down.
         *
         * @param {string} path
         */
        readImage: path=>outside(()=>readProgramImage(filesystem, blocks(), path, machine)),

        // The zones' sums last (`memory-zones.js`), over what this thread holds.
        // One layer asked for builds that table alone, the zones excepted, which
        // sum every other: a launcher reading a layer's counters every second
        // while a program loaded built every layer's, a twenty-fifth of the
        // thread the program ran on.
        diagnostics: (/** @type {string | undefined} */ layer)=>{
            const only = layer === undefined || layer === 'zones' ? null : layer;
            const asked = (/** @type {string} */ name)=>only === null || only === name;
            const tables = [
                ...core.diagnostics(only),
                // The run's windows, where this thread keeps them (`manager.js`).
                ...options.system?.windows?.manager && asked('windows') ? [{ name: 'windows',
                    status: 'ready', metrics: options.system.windows.manager.diagnostics() }]
                    : [],
                ...asked('js') ? [{
                    name: 'js',
                    version: '0.1.0',
                    status: 'ready',
                    metrics: jsSampler?.snapshot()
                    ?? { measured: false, reason: 'off: the sampleJs option' },
                }] : [],
                ...asked('app') ? [{
                    name: 'app',
                    version: '0.1.0',
                    status: 'ready',
                    metrics: {
                        ...events.diagnostics(),
                        bundle: {
                            ...bundleReads, distinct: blocksSeen.size,
                            ahead: blocks()?.ahead() ?? 0,
                            refetched: blocks()?.refetched().blocks ?? 0,
                            refetchedBytes: blocks()?.refetched().bytes ?? 0,
                            ranges: blocks()?.ranges().requests ?? 0,
                            rangeBytes: blocks()?.ranges().bytes ?? 0,
                            // zstd blocks decoded for guest reads, and the time it took:
                            // a bundle mounted on this thread's; one a process in a
                            // worker reads across its link decodes on the system's.
                            decoded: blocks()?.decoded?.().blocks ?? 0,
                            decodedBytes: blocks()?.decoded?.().bytes ?? 0,
                            decodeMs: Math.round(blocks()?.decoded?.().ms ?? 0),
                        },
                        film: { ...film },
                        // Which of the program's own code the machine is spent on
                        // is not here: the kernel publishes its page counts and the
                        // memory layer its regions, and whoever reads them sums and
                        // sorts on their own thread. A table computed on this one
                        // is a reader's work done by the program.
                        unimplementedCalls: Object.fromEntries(missingCalls),
                        // What was said as a divergence, the first of them: a
                        // consumer that listened for none has no other record of
                        // what this build accepted and did not do, and the journal
                        // has long since let go of a line said once.
                        divergences: [...reportDivergence.divergences].slice(0, DIVERGENCES_KEPT),
                        // And every loss -- a draw, a frame, data that did not
                        // happen -- with how many times it came: an error the
                        // journal let go of is still here.
                        losses: Object.fromEntries([...reportDivergence.losses]
                            .slice(0, DIVERGENCES_KEPT)),
                        // The system exports a 64-bit process has no x86-64 of.
                        leftOutAt64,
                        // The guest-to-guest calls a watch was put in front of, by label.
                        watches: [...watches.keys()],
                        // How many calls a site kernel issued through `frame.gl`,
                        // read beside the bridge's own per-hook rows: these calls
                        // never cross the bridge, so they are not in `hooks` at all.
                        kernelGlCalls: glCounters.calls,
                        // Whether the guest's memory is shared with other threads, and
                        // how many processes run at once (`mode.js`).
                        mode: options.mode ?? null,
                        concurrency: options.concurrency ?? 1,
                        // What was asked for and not had, when the run fell back.
                        fallback: options.fallback ?? null,
                        // What a pacing that counts said of the run: in the workers
                        // mode, the page's messages read between turns, the yields
                        // to the event loop, and the sleeps on the doorbell.
                        pacing: /** @type {any} */ (pacing).counts?.() ?? null,
                        // What the program holds of its RAM, the bundle's pools,
                        // where this process mounted it (a bundle the run's system
                        // mounted is the system's to report), and its volume's
                        // ranges kept for a read again.
                        bytesHeld: {
                            guest: guestHeld(),
                            heaps: {
                                ...mountedBlocks() ? blocks()?.held?.() ?? {} : {},
                                ...core.api('win32')?.volumeHeld?.()
                                    ?? { keptReads: NOT_MEASURED },
                            },
                        },
                    },
                }] : []];
            return only === null ? withZones(tables) : tables;
        },

        /**
         * Where the machine is standing, right now, asked from outside.
         *
         * The same report a failure carries, except that nothing has failed. A
         * run that stops without stopping -- a call that never answers, a
         * window procedure that never returns -- produces no error to attach a
         * trace to, and the call log is no help either: a call is written when
         * it returns, so the one holding everything is the one call absent from
         * it. This is the only way to see it.
         *
         * @returns {string}
         */
        trace: ()=>formatTrace(captureTrace({ cpu, memory, kernel, bridge,
            traced: ()=>layerTraces.slice() })),

        /**
         * Everything the engine can say about the run in one answer, for a
         * report a person saves with one click: every layer's diagnostics,
         * the phase profile and the last frames, where the machine stands, and
         * the guest's code around the addresses it spent itself at -- the bytes
         * a question about the translator's code for them is answered from.
         * A request, not for polling: it reads guest memory and describes
         * every layer.
         *
         * The devices drawing in the graphics worker answer what they are
         * asked a message later, so they are asked once and waited for --
         * no longer than `REPORT_WAIT_MS` -- before the tables are read: read
         * at once, the first report of a run would say nothing of them.
         */
        async report(){
            // A build without the graphics layer, or with its stub, has no
            // worker to wait for.
            const answeredByGraphics = async()=>{
                try
                {
                    await core.api('graphics').answered();
                }
                catch {
                    // Nothing was asked of anything that could answer.
                }
            };
            this.diagnostics();
            /** @type {ReturnType<typeof setTimeout> | undefined} */
            let timer;
            await Promise.race([
                answeredByGraphics(),
                new Promise(resolve=>{
                    timer = setTimeout(resolve, REPORT_WAIT_MS);
                }),
            ]);
            clearTimeout(timer);
            const diagnostics = this.diagnostics();
            const cpuTable = diagnostics.find((/** @type {any} */ table)=>table.name === 'cpu');
            /** @type {{ address: number, instructions: number }[]} */
            const top = cpuTable?.metrics?.samples?.top ?? [];
            /** @type {Set<number>} */
            const pages = new Set();
            for (const sample of top.slice(0, HOT_CODE_SAMPLES))
            {
                // The page the address is on and the one after: a region the
                // translator formed there runs on past the page's end.
                pages.add((sample.address & ~0xfff) >>> 0);
                pages.add(((sample.address & ~0xfff) + 0x1000) >>> 0);
            }
            /** @type {{ address: number, base64: string }[]} */
            const hotCode = [];
            for (const page of [...pages].sort((left, right)=>left - right))
            {
                try
                {
                    const bytes = memory.readBytes(page, 0x1000);
                    let text = '';
                    for (let at = 0; at < bytes.length; at++)
                    {
                        text += String.fromCharCode(bytes[at]);
                    }
                    hotCode.push({ address: page, base64: btoa(text) });
                }
                catch {
                    // A page nothing is mapped at: the sample was in code the
                    // program has since let go of.
                }
            }
            const log = core.api('log');
            return {
                diagnostics,
                profile: log.profile(20),
                frames: log.frames(240),
                trace: this.trace(),
                hotCode,
            };
        },
        /**
         * This process's memory for the next one to take, once it has gone,
         * with how much of it the guest may have written; null before then
         * and under an engine that keeps none.
         *
         * @returns {import('../app-options.js').SpareMemory | null}
         */
        spareMemory: ()=>spare.value,
        dispose(){
            disposed.value = true;
            // Read while the machine stands: the arena's mark is the last
            // thing that says where the guest wrote.
            const memoryLeft = cpu.wasmMemory?.() ?? null;
            const heapLeft = win32.heap?.();
            const handedTo = heapLeft?.handedTo?.();
            // Below it the guest may have written: everything it was given, the
            // heap a gone process's bytes reached in it, the heap handed out.
            const guestEnd = typeof handedTo === 'number' ? Math.max(handedTo,
                heapLeft?.dirtyTo?.() ?? 0, cpu.ramHeld?.() ?? 0) : undefined;
            const executorsTouched = cpu.executorsTouched?.() ?? null;
            const engineLeft = cpu.engineLeft?.() ?? null;
            const stacksReached = kernel.stacksReached?.();
            // What the program wrote last is saved now rather than after it
            // settles: the machine it was written on is about to go.
            saver?.flush();
            stopSavingRegistry();
            // Before the graph goes: the background filler would otherwise go
            // on asking for blocks nobody can put anywhere. A run's bundle is
            // the run's to stop, after its last process.
            if (!options.system)
            {
                blocks()?.stop();
            }
            breathe.close();
            jsSampler?.stop();
            return core.dispose().then(()=>{
                if (ownsTranslationStore)
                {
                    translationStore?.close?.();
                }
                spare.value = memoryLeft && typeof guestEnd === 'number'
                    ? { memory: memoryLeft, guestEnd, heapFrom: HEAP_BASE,
                        ...executorsTouched === null ? {} : { executors: executorsTouched },
                        ...engineLeft === null ? {} : { engine: engineLeft },
                        ...typeof stacksReached === 'number'
                            ? { stacks: { from: STACK_POOL_BASE, to: stacksReached } } : {} }
                    : null;
            });
        },
    };
}
