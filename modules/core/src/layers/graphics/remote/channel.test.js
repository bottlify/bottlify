/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReceiver, createSender } from './channel.js';
import { WAIT } from './wire.js';

/**
 * A sender over a clock and a timer the test moves, the turns' ends run when
 * the test says, and every batch posted kept.
 *
 * @param {number} gapMs
 */
function sender(gapMs){
    let clock = 0;
    /** @type {(() => void)[]} */
    const turnEnds = [];
    /** @type {{ send: () => void, at: number }[]} */
    const timers = [];
    /** @type {number[]} */
    const batches = [];
    const made = createSender({
        post: message=>batches.push(message.buffer.byteLength),
        later: send=>turnEnds.push(send),
        now: ()=>clock,
        gapMs,
        timer: (send, ms)=>timers.push({ send, at: clock + ms }),
    });
    /** A call nobody waits for, in a turn of its own that then ends. */
    const turn = ()=>{
        made.writer.u8(0x55);
        made.called(WAIT.NONE, 'SetRenderState');
        for (const end of turnEnds.splice(0))
        {
            end();
        }
    };
    return {
        made, batches, timers, turn,
        /** @param {number} ms */
        pass: ms=>{
            clock += ms;
            for (const due of timers.filter(one=>one.at <= clock))
            {
                timers.splice(timers.indexOf(due), 1);
                due.send();
            }
        },
    };
}

test('with no gap every turn that recorded something sends it', ()=>{
    const s = sender(0);
    s.turn();
    s.turn();
    s.turn();
    assert.equal(s.batches.length, 3);
    assert.equal(s.timers.length, 0);
});

test('turns closer than the gap are sent together, by the timer the first of them set', ()=>{
    const s = sender(1);
    s.turn();
    assert.equal(s.batches.length, 1, 'the first turn after a quiet spell goes at once');
    s.pass(0.2);
    s.turn();
    s.pass(0.2);
    s.turn();
    s.pass(0.2);
    s.turn();
    assert.equal(s.batches.length, 1, 'the next turns wait');
    assert.equal(s.timers.length, 1, 'on one timer');
    s.pass(1);
    assert.equal(s.batches.length, 2, 'which sends what they recorded');
    assert.equal(s.batches[1], 6, 'three calls of two bytes each, in one batch');
    s.pass(5);
    s.turn();
    assert.equal(s.batches.length, 3, 'a turn past the gap goes at once again');
});

test('a call that waits for its answer goes at once, with what the turns before it left', ()=>{
    const s = sender(1);
    s.turn();
    s.pass(0.1);
    s.turn();
    assert.equal(s.batches.length, 1);
    s.made.writer.u8(0x55);
    const answer = s.made.called(WAIT.ANSWER, 'GetData');
    assert.ok(answer instanceof Promise);
    assert.equal(s.batches.length, 2, 'sent without waiting for the gap');
    assert.equal(s.batches[1], 2 + 2 + 4, 'the waiting turn\'s call, and the asking one');
    s.pass(1);
    assert.equal(s.batches.length, 2, 'and the timer finds nothing left to send');
});

test('a diagnostics ask settles once the played side has answered it, the first one too', async()=>{
    const s = sender(1);
    /** @type {string[]} */
    const seen = [];
    const settled = (/** @type {string} */ label)=>s.made.answered().then(()=>seen.push(label));
    await settled('nothing asked');
    assert.deepEqual(seen, ['nothing asked'],
        'with no ask outstanding there is nothing to wait for');
    s.made.writer.u8(0x55);
    const first = s.made.called(WAIT.ANSWER, 'diagnostics');
    assert.equal(first.answer, null, 'the first ask has nothing to say yet');
    const waiting = settled('first');
    assert.equal(s.batches.length, 1, 'waiting sends the ask rather than leave it for the gap');
    s.made.writer.u8(0x55);
    s.made.called(WAIT.ANSWER, 'diagnostics');
    const both = settled('second');
    s.made.receive({ type: 'diagnostics', diagnostics: { frames: 1 } });
    await waiting;
    assert.deepEqual(seen, ['nothing asked', 'first'], 'the second ask is not answered yet');
    s.made.receive({ type: 'diagnostics', diagnostics: { frames: 2 } });
    await both;
    assert.deepEqual(seen, ['nothing asked', 'first', 'second']);
    s.made.writer.u8(0x55);
    assert.deepEqual(s.made.called(WAIT.ANSWER, 'diagnostics').answer, { frames: 2 });
    const stopped = settled('stopped');
    s.made.receive({ type: 'failed', message: 'gone' });
    await stopped;
    assert.equal(seen.at(-1), 'stopped', 'a played side that stopped answers nothing more');
});

test('the played side counts its batches\' time and says it with its diagnostics', ()=>{
    // The worker has no phase profiler: where its thread went comes back with
    // the answer to a diagnostics ask, as the batches' read time and the
    // look at objects at zero a batch made inside it.
    /** @type {any[]} */
    const said = [];
    /** What each batch's read answers: no look, a look of three milliseconds, no look. */
    const swept = [undefined, 3, undefined];
    let batch = 0;
    const played = {
        /** @param {ArrayBuffer} buffer @param {(call: any) => void} each */
        read: (buffer, each)=>{
            each({ m: batch === 2 ? 'diagnostics' : 'Draw', wait: batch === 2 ? WAIT.ANSWER : 0 });
            return swept[batch++];
        },
        play: (/** @type {any} */ call)=>(call.m === 'diagnostics' ? { frames: 1 } : 0),
    };
    const receiver = createReceiver({ played: /** @type {any} */ (played),
        post: message=>said.push(message) });
    for (let at = 0; at < 3; at++)
    {
        receiver.receive({ type: 'calls', buffer: new ArrayBuffer(4) });
    }
    const [told] = said.filter(message=>message.type === 'diagnostics');
    assert.deepEqual(told.diagnostics, { frames: 1 });
    // Asked during the third batch: the two before it are in.
    const read = told.phases['batch-read'];
    assert.equal(read.count, 2);
    assert.ok(read.ms >= 0);
    assert.ok(Math.abs(read.selfMs - (read.ms - 3)) < 1e-9,
        'the batches\' own time leaves out the look they made');
    assert.deepEqual(told.phases['batch-sweep'], { count: 1, ms: 3 });

    const s = sender(0);
    assert.equal(s.made.phases(), null, 'nothing said yet: not measured, never zero');
    s.made.receive(told);
    assert.deepEqual(s.made.phases(), told.phases);
});
