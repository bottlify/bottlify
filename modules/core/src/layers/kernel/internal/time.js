/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Time as the guest sees it.
 *
 * The guest's clock cannot simply be the host's. While our own code runs -- a
 * trap being handled, an image being mapped -- the guest executes nothing, and
 * if that interval is not credited to the guest's clock, a program measuring how
 * long its own frame took concludes it took no time and speeds up. Equally, a
 * long host-side operation must not appear to the guest as a single enormous
 * jump, because code that divides by elapsed time will produce something absurd.
 *
 * So virtual time advances with the guest, and host-side intervals are credited
 * with a floor and a ceiling (§12.6).
 */

/**
 * @param {Object} [options]
 * @param {() => number} [options.now]      Host clock, in milliseconds.
 * @param {number} [options.floorMs]        Below this, an interval is not worth crediting.
 * @param {number} [options.ceilingMs]      No single credit exceeds this.
 */
export function createClock({
    now = ()=>Date.now(),
    floorMs = 0.5,
    ceilingMs = 16,
} = {})
{
    const startedAt = now();
    const epochMs = startedAt;
    let virtualMs = 0;
    let creditedMs = 0;
    let capped = 0;
    let ignored = 0;
    let skippedMs = 0;
    let overtaken = 0;
    /** @type {number | null} */
    let suspendedAt = null;
    /**
     * Told after every move of the clock, so whoever mirrors it for the guest
     * to read without a call writes the value a call would have answered.
     *
     * @type {(() => void)[]}
     */
    const moved = [];
    const tell = ()=>{
        for (const listener of moved)
        {
            listener();
        }
    };

    return {
        /**
         * Asks to be told whenever virtual time moves. Every move goes
         * through `advance`, `skipTo` and `resume`, so a mirror kept this way
         * is never stale by more than the call that is moving it.
         *
         * @param {() => void} listener
         */
        whenMoved(listener){
            moved.push(listener);
        },

        /** Milliseconds of guest time since boot. */
        virtualTime: ()=>virtualMs,

        /**
         * The guest's wall clock, in milliseconds since 1970.
         *
         * Anchored at boot and then carried by guest time rather than read from
         * the host: a program that samples the wall clock twice and subtracts
         * must get the same interval its own clock reports, or its notion of how
         * long a frame took disagrees with the one it timed with.
         */
        wallClock: ()=>epochMs + virtualMs,

        /**
         * The guest ran for real: advance its clock by the wall time that passed.
         *
         * @param {number} elapsedMs
         */
        advance(elapsedMs){
            virtualMs += elapsedMs;
            tell();
        },

        /**
         * Moves the clock to a deadline the machine is only waiting for.
         *
         * Every thread is in a timed wait and nothing else can run, so the wait
         * is the only thing that can change the machine's mind and there is
         * nothing to gain by sitting through it in real time.
         *
         * Never past the host's clock, though, and that bound is the whole
         * point: a machine with nothing to do may catch up with real time and
         * must not overtake it. Overtaking is what makes a program's own clock
         * run fast -- animations play at several times their speed, and it asks
         * a real sound device for far more audio than it can drain.
         *
         * @param {number} targetMs  Guest time the machine is waiting for.
         * @returns {number} how far the clock actually moved
         */
        skipTo(targetMs){
            const limit = Math.min(targetMs, now() - startedAt);
            const jump = Math.max(0, limit - virtualMs);
            if (jump === 0)
            {
                overtaken++;
                return 0;
            }
            virtualMs += jump;
            tell();
            skippedMs += jump;
            return jump;
        },

        /** Our code is about to run; the guest is not executing from here. */
        suspend(){
            suspendedAt = now();
        },

        /**
         * Our code is done. Credits the guest for the interval, bounded.
         *
         * @returns {number} the milliseconds actually credited
         */
        resume(){
            if (suspendedAt === null)
            {
                return 0;
            }
            const elapsed = now() - suspendedAt;
            suspendedAt = null;

            // Too short to matter: crediting sub-millisecond noise on every trap
            // would make the guest's clock drift ahead of anything real.
            if (elapsed < floorMs)
            {
                ignored++;
                return 0;
            }

            // Too long to hand over at once. A one-second stall delivered whole
            // would make a frame look a thousand times slower than any real one,
            // and code that scales by elapsed time reacts to that violently.
            const credit = Math.min(elapsed, ceilingMs);
            if (elapsed > ceilingMs)
            {
                capped++;
            }
            virtualMs += credit;
            creditedMs += credit;
            tell();
            return credit;
        },

        diagnostics(){
            return {
                virtualMs: Math.round(virtualMs),
                wallMs: Math.round(now() - startedAt),
                creditedMs: Math.round(creditedMs),
                // Frequent capping means the host is stalling for longer than the
                // guest can be told about, and the two clocks are drifting apart.
                capped,
                ignored,
                // Guest time handed over for a wait nobody had to sit through,
                // and the times that was refused because the clock had already
                // caught up with the host's.
                skippedMs: Math.round(skippedMs),
                overtaken,
            };
        },
    };
}
