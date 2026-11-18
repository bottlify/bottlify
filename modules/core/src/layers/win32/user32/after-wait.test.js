/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { afterWait } from './after-wait.js';

/** A host whose caller is `running` unless a call is being answered for a named thread. */
function fakeHost(){
    /** @type {{ running: string, named: string | null }} */
    const state = { running: 'main', named: null };
    return {
        state,
        callerThread: ()=>state.named ?? state.running,
        /** @template T @param {any} thread @param {() => T} fn */
        answering: (thread, fn)=>{
            const before = state.named;
            state.named = thread;
            try
            {
                return fn();
            }
            finally
            {
                state.named = before;
            }
        },
    };
}

test('with no wait the step runs at once, with the answer', ()=>{
    const host = fakeHost();
    assert.equal(afterWait(host)(5, answer=>answer + 1), 6);
});

test('after a wait the step runs as the call of the thread it began for', async()=>{
    const host = fakeHost();
    const andThen = afterWait(host);
    /** @type {(value: number) => void} */
    let settle = ()=>{};
    const waited = new Promise(resolve=>{
        settle = resolve;
    });
    // A step that waits again inside: its own continuation names the thread too.
    const answer = andThen(waited, first=>andThen(Promise.resolve(first + 1),
        second=>`${host.callerThread()}:${second}`));
    // Another thread has the processor by the time the wait ends.
    host.state.running = 'worker';
    settle(1);
    assert.equal(await answer, 'main:2');
    assert.equal(host.callerThread(), 'worker', 'and the name is given back after');
});

test('a host with no way to name a thread runs the step as it stands', async()=>{
    assert.equal(await afterWait({})(Promise.resolve(2), answer=>answer * 2), 4);
});
