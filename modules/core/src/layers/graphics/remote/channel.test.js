/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSender } from './channel.js';
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
