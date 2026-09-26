/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Running a recorded session again, in code.
 *
 * A program does something we did not expect, the engine falls over, and the
 * only way to see it again is for a person to click through a menu for a minute
 * -- which cannot be a test, cannot be run after a change, and cannot be handed
 * to anybody else. What makes it repeatable is not a smaller game or a faster
 * browser: it is a record of the order things happened in, replayed here.
 *
 * The order is the whole content. Failures at this seam are almost never a
 * wrong value; they are a handler that awaited, a turn that went to another
 * thread, and a frame built on what that turn left behind. A value can be
 * reasoned about from a report. An order cannot, so it is recorded (see the
 * bridge's `record` option) and replayed.
 *
 * Replaying does not run guest code and does not need any: it drives the real
 * bridge with the recorded interleaving against a machine of stubs, and the
 * bridge's own invariants -- a frame must land on its thread's stack, a
 * callback after an await must name its thread, an entry must not be zero --
 * are what decide whether the session still fails. A session that once crashed
 * a game is then a test that either throws or does not.
 */

import { createBridgeModule } from './module.js';

/**
 * @typedef {Object} SessionEvent
 * @property {string} t         call | park | guest | returned | finish
 * @property {string} [name]    Which host function, for call/park/finish.
 * @property {string} [thread]  Whose it was.
 * @property {number} [freeStack]
 * @property {number} [restingStack]
 * @property {number} [entry]   For guest: where the guest was sent.
 * @property {string | null} [by]
 * @property {boolean} [named]  Whether the caller said which thread it meant.
 */

/**
 * @typedef {Object} ReplayThread
 * @property {string} name
 * @property {number} stackTop
 * @property {number} stackLimit
 */

/**
 * @typedef {Object} Session
 * @property {ReplayThread[]} threads
 * @property {SessionEvent[]} events
 */

/**
 * The threads a session mentions, with a stack each.
 *
 * A recording carries the stack addresses it saw; where it does not, threads
 * are given stacks far enough apart that a frame landing on the wrong one is
 * caught rather than merely odd.
 *
 * @param {Session} session
 * @returns {Map<string, any>}
 */
function threadsOf(session){
    /** @type {Map<string, any>} */
    const known = new Map();
    for (const declared of session.threads ?? [])
    {
        known.set(declared.name, { ...declared });
    }
    let issued = 0;
    for (const event of session.events)
    {
        const name = event.thread;
        if (name === undefined || known.has(name))
        {
            continue;
        }
        const top = 0x10000000 + issued * 0x00200000;
        known.set(name, { name, stackTop: top, stackLimit: top - 0x00100000 });
        issued++;
    }
    return known;
}

/**
 * Replays a recorded session and answers with what it did.
 *
 * @param {Session} session
 * @returns {Promise<{ events: number, refusals: string[], startedGuest: any[] }>}
 *   `refusals` is what the bridge refused to do, in order -- which for a
 *   session recorded from a failure is the failure itself, named.
 */
export async function replaySession(session){
    const threads = threadsOf(session);
    /** @type {Record<string, number>} */
    const regs = { esp: 0, ecx: 0, eax: 0 };
    /** @type {Map<number, number>} */
    const cells = new Map();
    /** @type {((id: number) => void) | null} */
    let onTrap = null;
    let nextTrap = 1;
    /** @type {any} */
    let running = threads.values().next().value ?? null;

    /** @type {any} */
    const apis = {
        cpu: {
            /** @param {string} which */
            readReg32: which=>regs[which] ?? 0,
            /** @param {string} which @param {number} value */
            writeReg32: (which, value)=>{
                regs[which] = value >>> 0;
            },
            registerTrap: ()=>{
                const id = nextTrap++;
                return { id, address: 0x00900000 + id * 16 };
            },
            /** @param {any} fn */
            onTrap: fn=>{
                onTrap = fn;
            },
        },
        kernel: {
            currentThread: ()=>running,
            threads: ()=>[...threads.values()],
            holdThread: ()=>{},
            parkThread: ()=>{},
            scheduleResume: ()=>{},
        },
        memory: {
            /** @param {number} at */
            readU32: at=>cells.get(at >>> 0) ?? 0,
            /** @param {number} at @param {number} value */
            writeU32: (at, value)=>cells.set(at >>> 0, value >>> 0),
            readBytes: ()=>new Uint8Array(0),
        },
        log: { begin: ()=>{}, end: ()=>{} },
    };

    const bridge = await createBridgeModule().create({}, /** @type {any} */ ({
        /** @param {string} name */
        requireApi: name=>apis[name],
    }));

    /**
     * One trap per recorded function name. The handler does nothing on its own:
     * what it does is driven from the event list, because that is what was
     * recorded and reproducing the handler's own logic would be reproducing the
     * program rather than the failure.
     *
     * @type {Map<string, number>}
     */
    const traps = new Map();
    /** @type {Map<string, { settle: (value: number) => void }>} */
    const parked = new Map();
    /**
     * What the handler about to run should do before it parks.
     *
     * A recorded `guest` that follows a `call` with nothing in between happened
     * *inside* that handler, while it still held the processor -- which is a
     * different situation from one that happened after an await, and the
     * difference is exactly what these sessions are about. So it is replayed
     * from inside the handler rather than from the loop below.
     *
     * @type {SessionEvent[]}
     */
    let inline = [];

    /** @type {string[]} */
    const refusals = [];

    /** @param {SessionEvent} event */
    const sendGuest = event=>{
        bridge.callGuest({
            entry: event.entry ?? 0,
            args: [],
            // Faithful to what was recorded: a caller that did not name a
            // thread is replayed as one that does not, because that is the
            // thing being tested.
            thread: event.named === false
                ? undefined
                : threads.get(event.thread ?? '') ?? running,
        });
    };

    /** @param {string} name */
    const trapFor = name=>{
        const already = traps.get(name);
        if (already !== undefined)
        {
            return already;
        }
        bridge.register(name, {
            argBytes: 0,
            handler: ()=>{
                const doing = inline;
                inline = [];
                for (const event of doing)
                {
                    try
                    {
                        sendGuest(event);
                    }
                    catch (e){
                        refusals.push(`guest ${event.entry}: `
                            + `${/** @type {Error} */ (e).message}`);
                    }
                }
                return new Promise(resolve=>{
                    parked.set(name, { settle: resolve });
                });
            },
        });
        traps.set(name, nextTrap - 1);
        return nextTrap - 1;
    };

    let replayed = 0;

    for (let at = 0; at < session.events.length; at++)
    {
        const event = session.events[at];
        const on = event.thread === undefined ? running : threads.get(event.thread) ?? running;
        replayed++;
        try
        {
            if (event.t === 'call')
            {
                running = on;
                // Everything the recording shows happening inside this call,
                // before it parked or answered.
                inline = [];
                while (at + 1 < session.events.length
                    && session.events[at + 1].t === 'guest')
                {
                    inline.push(session.events[++at]);
                    replayed++;
                }
                // The stack the recording saw, when it saw one; otherwise a
                // point well inside this thread's own stack.
                regs.esp = event.freeStack ?? (on.stackTop - 0x1000);
                cells.set(regs.esp, 0x00401000);
                /** @type {any} */ (onTrap)(trapFor(event.name ?? 'unknown'));
                // A handler that parks is what the recording says happened, and
                // the promise above is what makes this one park.
                await Promise.resolve();
            }
            else if (event.t === 'guest')
            {
                running = on;
                sendGuest(event);
            }
            else if (event.t === 'returned')
            {
                running = on;
                regs.ecx = 0;
                /** @type {any} */ (onTrap)(/** @type {number} */ (bridge.sentinelTrap()));
            }
            else if (event.t === 'finish')
            {
                parked.get(event.name ?? '')?.settle(0);
                parked.delete(event.name ?? '');
                await Promise.resolve();
            }
        }
        catch (e){
            refusals.push(`${event.t} ${event.name ?? event.entry ?? ''}: `
                + `${/** @type {Error} */ (e).message}`);
        }
    }

    // A refusal raised inside a suspended handler has nowhere to go but the
    // bridge's own record of it, so it is collected here too.
    const held = bridge.failure?.();
    if (held)
    {
        refusals.push(String(held.message ?? held));
    }

    return { events: replayed, refusals, startedGuest: bridge.recentlyStarted() };
}
