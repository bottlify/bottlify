/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Every recorded session in `sessions/`, replayed.
 *
 * This is the file a failure gets written into rather than described in. When a
 * program does something the engine did not expect, the run's recording is
 * saved beside this test with what it is expected to do now, and from then on
 * the failure is a thing that runs in a second with no browser and no game --
 * so a change can be checked against it instead of against a memory of it.
 *
 * A session names its own expectation: `refusals` lists what the bridge should
 * refuse, in order. An empty list means the session must replay cleanly, which
 * is what a session recorded from a fixed failure is turned into.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { replaySession } from './replay.js';

const SESSIONS = join(dirname(fileURLToPath(import.meta.url)), 'sessions');

/** @returns {string[]} */
const sessions = ()=>{
    try
    {
        return readdirSync(SESSIONS).filter(name=>name.endsWith('.json'));
    }
    catch (e){
        void e;
        return [];
    }
};

for (const file of sessions())
{
    const session = JSON.parse(readFileSync(join(SESSIONS, file), 'utf8'));
    test(`recorded session: ${session.about ?? file}`, async()=>{
        const played = await replaySession(session);
        assert.equal(played.events, session.events.length, 'the whole session was replayed');
        assert.deepEqual(
            played.refusals.map((/** @type {string} */ said)=>said.replace(/0x[0-9a-f]+/g, '0x…')),
            session.refusals ?? [],
            `what ${file} expected the bridge to refuse`);
    });
}

test('a session that calls the guest back without naming a thread is caught', async()=>{
    // The shape every recorded crash of this class has: a handler takes a call,
    // parks on something, another thread takes a call of its own, and the first
    // handler wakes up and sends the guest off without saying whose call it is
    // answering. Written as a session rather than as code, because that is how
    // one arrives -- out of a run, not out of a keyboard.
    const played = await replaySession({
        threads: [
            { name: 'main', stackTop: 0x00300000, stackLimit: 0x00200000 },
            { name: 'thread-3', stackTop: 0x00700000, stackLimit: 0x00600000 },
        ],
        events: [
            { t: 'call', name: 'WINMM.dll!waveOutWrite', thread: 'main', freeStack: 0x002ff000 },
            { t: 'park', name: 'WINMM.dll!waveOutWrite', thread: 'main' },
            { t: 'call', name: 'KERNEL32.dll!ReadFile', thread: 'thread-3', freeStack: 0x006ff000 },
            { t: 'park', name: 'KERNEL32.dll!ReadFile', thread: 'thread-3' },
            { t: 'guest', entry: 0x00402000, thread: 'main', named: false },
        ],
    });

    assert.equal(played.refusals.length, 1);
    assert.match(played.refusals[0], /must name the thread whose call it answers/);
});

test('the same session with the thread named replays cleanly', async()=>{
    const played = await replaySession({
        threads: [
            { name: 'main', stackTop: 0x00300000, stackLimit: 0x00200000 },
            { name: 'thread-3', stackTop: 0x00700000, stackLimit: 0x00600000 },
        ],
        events: [
            { t: 'call', name: 'WINMM.dll!waveOutWrite', thread: 'main', freeStack: 0x002ff000 },
            { t: 'park', name: 'WINMM.dll!waveOutWrite', thread: 'main' },
            { t: 'call', name: 'KERNEL32.dll!ReadFile', thread: 'thread-3', freeStack: 0x006ff000 },
            { t: 'park', name: 'KERNEL32.dll!ReadFile', thread: 'thread-3' },
            { t: 'guest', entry: 0x00402000, thread: 'main', named: true },
        ],
    });

    assert.deepEqual(played.refusals, []);
    assert.deepEqual(played.startedGuest.map((/** @type {any} */ one)=>one.thread), ['main']);
});

test('a session that sends the guest to address zero names who sent it', async()=>{
    const played = await replaySession({
        threads: [{ name: 'main', stackTop: 0x00300000, stackLimit: 0x00200000 }],
        events: [
            { t: 'call', name: 'USER32.dll!DispatchMessageA', thread: 'main',
                freeStack: 0x002ff000 },
            { t: 'guest', entry: 0, thread: 'main', named: true },
        ],
    });

    assert.equal(played.refusals.length, 1);
    assert.match(played.refusals[0],
        /USER32.dll!DispatchMessageA asked to run guest code at address zero/);
});
