/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * How a process waits while it runs: idle on the event loop or a timer,
 * answering what other threads ask while it waits, and the intervals it looks
 * again after.
 */


/**
 * Microtasks a turn waits for a host call's answer before the next thread is
 * picked: a call that runs guest code chains a few promises before it builds
 * the frame. The limit is not measured yet: `hostTurns` counts the ticks taken and the
 * waits that ran out.
 */
export const HOST_ANSWER_TICKS = 64;

/**
 * The other executors answered while the run loop yields to the event loop,
 * each time their bell rings meanwhile. A trap of theirs is otherwise
 * answered when the next turn begins, and a yield the browser stretched - to
 * compose a frame, run its timers, deliver a worker's message - holds every
 * one asked in it that long: a .NET game's loader on another executor waited
 * over a millisecond for 37% of its answers, while the thread here spent half
 * its time yielding between the frames of a loading screen.
 *
 * Made once a run, not once a yield: the loop yields thousands of times a
 * second, and a promise, a race and closures a yield were 2.5 KB of garbage
 * each (node). The look at the bell is parked across yields - it outlives the
 * yield it was armed in and serves the next one, armed again only once it has
 * ended - and answers in its own callback, made once here, while the loop
 * awaits the yield itself between `begin` and `end`.
 *
 * @param {{ rung: () => number, waitAsync: (seen: number, ms: number) => Promise<unknown> }} bell
 * @param {() => void} answer
 * @returns {{ begin: () => void, end: () => void }}
 */
export function answeringWhile(bell, answer){
    /** A yield is under way: a ring now is answered. */
    let yielding = false;
    /** A look is parked on the bell, from the count `seen`. */
    let looking = false;
    let seen = 0;
    const look = ()=>{
        looking = true;
        seen = bell.rung();
        bell.waitAsync(seen, ANSWERING_LOOK_MS).then(looked);
    };
    const looked = ()=>{
        looking = false;
        // Between yields the look is left unarmed: no turn's answer waits on
        // it, the turn answers as it begins, and the next yield arms it again.
        if (!yielding)
        {
            return;
        }
        if (bell.rung() !== seen)
        {
            answer();
        }
        if (yielding && !looking)
        {
            look();
        }
    };
    return {
        begin(){
            yielding = true;
            if (!looking)
            {
                look();
            }
        },
        end(){
            yielding = false;
        },
    };
}

/**
 * The longest a yield's look at the executors' bell sleeps before it looks
 * again, ms: a look outlives the yield it was for, and one asleep on the bell
 * has each executor's turn wake it.
 */
const ANSWERING_LOOK_MS = 2;

/**
 * Consecutive turns retiring no guest instruction at all before the run loop
 * stops spinning on the event loop and waits on a timer instead.
 *
 * Both waits are needed and neither will do alone. A machine whose threads are
 * running while one of its calls is parked has to come back at once, because
 * the turn after this one is real work -- and a zero timeout is clamped to four
 * milliseconds, and to more once they nest, which is that much wall clock per
 * turn for nothing. A machine where nothing ran at all has nothing to come back
 * to: only the host can change its mind, and spinning until it does burns a
 * processor to arrive no sooner while starving the very I/O it is waiting on.
 *
 * So the loop spins while the guest is still getting work done and backs off
 * once it stops. The count is small because of which way it is worse to be
 * wrong: a few spare turns cost microseconds and one turn too many on a timer
 * costs milliseconds.
 */
const IDLE_SPINS_BEFORE_TIMER = 4;

/**
 * How long the run loop sleeps between looks when nothing can run, unless
 * something wakes it sooner.
 *
 * Not zero. A zero timeout is no longer clamped by a browser that is not
 * nesting them, and the loop breaks the nesting every few turns by yielding
 * through a message port -- so a zero timeout here came round fifty thousand
 * times a second. That is a busy loop with extra steps, and it starved the
 * very thing the machine was waiting for: a decoder on the same thread whose
 * output took a second to be delivered instead of a millisecond, while every
 * guest thread sat blocked behind the one waiting on it.
 *
 * The sleep is short because it is not what ends the wait -- a host call
 * answering does, and that wakes the loop at once. It only bounds how long
 * the guest's own deadlines and the sound ring go unattended: the ring holds
 * two hundred milliseconds and the pump runs on every look.
 */
export const IDLE_LOOK_MS = 4;

/**
 * How often the run loop pumps the sound at most: what the pump does --
 * position notifications, a buffer's volume and pan carried over, a queue
 * track topped up -- waits a millisecond at most, against a device that
 * reads on its own clock and a ring that holds 200 ms.
 */
export const SOUND_PUMP_MS = 1;

/**
 * What the run loop is waiting on when it cannot go straight on, and how.
 *
 * A range request, a message queue with nothing in it, and some other host call
 * that has not answered are one condition from inside the loop and three
 * different costs. Named apart, a profile says which of the three a run went
 * into; named together it can only say that the machine waited.
 *
 * @param {Object} state
 * @param {number} state.fetching   Range requests outstanding.
 * @param {number} state.idlers     Callers parked on an empty message queue.
 * @param {number} state.suspended  Host calls suspended on the host, the
 *     callers parked on the guest's own queue left out.
 * @param {number} state.spun       Turns in a row that retired no instruction.
 * @param {boolean} [state.others]  The process's other executors still run its
 *     threads, the last turn having left without waiting for them.
 * @returns {{ phase: string, timer: boolean } | null} null to go straight on.
 */
export function idleWait({ fetching, idlers, suspended, spun, others = false }){
    if (idlers === 0 && suspended === 0)
    {
        return null;
    }
    // A caller parked on the guest's own queue has had its look this turn, and
    // while the guest still retires instructions its next turn is work: only an
    // answer that has to come from the host is worth handing the thread over.
    if (spun === 0 && suspended === 0 && fetching === 0)
    {
        return null;
    }
    // A turn the others ran retired nothing here and still resets the count:
    // with a call waiting on the host, the loop would come straight back for
    // as long as they run. Their bell ends the wait as the answer does.
    const timer = spun >= IDLE_SPINS_BEFORE_TIMER || others && suspended > 0;
    const on = fetching > 0 ? 0 : idlers > 0 ? 2 : 4;
    return IDLE_WAITS[on + (timer ? 1 : 0)];
}

/**
 * The waits `idleWait` answers, made once: it is asked at every turn that
 * waits, and a record and a phase's name a time were garbage.
 */
const IDLE_WAITS = Object.freeze(['fetch', 'message', 'host'].flatMap(on=>[false, true]
    .map(timer=>Object.freeze({ phase: `idle-${on}${timer ? '-wait' : ''}`, timer }))));
