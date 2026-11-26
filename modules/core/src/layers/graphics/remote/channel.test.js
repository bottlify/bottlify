/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReceiver, createSender } from './channel.js';
import { createPlayer } from './replay.js';
import { KIND, createRingMemory, openRingIn, openRingOut } from './ring.js';
import { OP, WAIT, createReader } from './wire.js';

/** What a value said back is read with: nothing in it is a device's object. */
const NONE = ()=>undefined;

/**
 * A sender over a clock and a timer the test moves, the turns' ends run when
 * the test says, the length of every batch it sent read off its ring, and
 * what the played side says put in that side's ring by `tell`.
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
    const sent = [];
    const rings = { calls: createRingMemory(64 << 10), replies: createRingMemory(64 << 10) };
    const made = createSender({
        rings,
        serve: false,
        later: send=>turnEnds.push(send),
        now: ()=>clock,
        gapMs,
        timer: (send, ms)=>timers.push({ send, at: clock + ms }),
    });
    const calls = openRingIn(rings.calls, (kind, buffer, start, length)=>{
        if (kind === KIND.BATCH)
        {
            sent.push(length);
        }
    });
    const back = openRingOut(rings.replies, { intern: false });
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
        made, timers, turn,
        /** The batches sent so far, by their lengths. */
        get batches(){
            calls.drain();
            return sent;
        },
        /**
         * What the played side says, as its receiver says it, read at once.
         *
         * @param {any} message
         */
        tell(message){
            back.writer.value(message, NONE);
            back.publish(KIND.VALUE, 0);
            made.take();
        },
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

/**
 * A receiver of a played side the test makes up, batches sent to it by
 * `batch` and played at once, and everything it says read off its ring.
 *
 * @param {any} played @param {any} [options]  the receiver's own
 */
function receiverOf(played, options = {}){
    const rings = { calls: createRingMemory(64 << 10), replies: createRingMemory(64 << 10) };
    const receiver = createReceiver({ played, rings, serve: false, ...options });
    const calls = openRingOut(rings.calls);
    /** @type {any[]} */
    const said = [];
    const reader = createReader({ ref: NONE, service: NONE, owned: true });
    const back = openRingIn(rings.replies, (kind, buffer, start, length)=>{
        said.push(reader.value(buffer, length, start));
    });
    return {
        receiver, said,
        /** A batch, played; then what was said read. */
        batch(){
            calls.put(KIND.BATCH, new Uint8Array(8), 0);
            receiver.take();
            back.drain();
        },
        /** What was said since, read. */
        hear: ()=>back.drain(),
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
    s.tell({ type: 'diagnostics', diagnostics: { frames: 1 } });
    await waiting;
    assert.deepEqual(seen, ['nothing asked', 'first'], 'the second ask is not answered yet');
    s.tell({ type: 'diagnostics', diagnostics: { frames: 2 } });
    await both;
    assert.deepEqual(seen, ['nothing asked', 'first', 'second']);
    s.made.writer.u8(0x55);
    assert.deepEqual(s.made.called(WAIT.ANSWER, 'diagnostics').answer, { frames: 2 });
    const stopped = settled('stopped');
    s.tell({ type: 'failed', message: 'gone' });
    await stopped;
    assert.equal(seen.at(-1), 'stopped', 'a played side that stopped answers nothing more');
});

test('the played side counts its batches\' time and says it with its diagnostics', ()=>{
    // The worker has no phase profiler: where its thread went comes back with
    // the answer to a diagnostics ask, as the batches' read time and the
    // look at objects at zero a batch made inside it.
    /** What each batch's read answers: no look, a look of three milliseconds, no look. */
    const swept = [undefined, 3, undefined];
    let batch = 0;
    const played = {
        spent: (/** @type {any} */ _buffer, /** @type {() => void} */ give)=>give(),
        /** @param {ArrayBuffer} buffer @param {(call: any) => void} each */
        read: (buffer, each)=>{
            each({ m: batch === 2 ? 'diagnostics' : 'Draw', wait: batch === 2 ? WAIT.ANSWER : 0 });
            return swept[batch++];
        },
        play: (/** @type {any} */ call)=>(call.m === 'diagnostics' ? { frames: 1 } : 0),
    };
    const across = receiverOf(played);
    for (let at = 0; at < 3; at++)
    {
        across.batch();
    }
    const [told] = across.said.filter(message=>message.type === 'diagnostics');
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
    s.tell(told);
    assert.deepEqual(s.made.phases(), told.phases);
});

test('every present carries what the played device and its thread did, unasked', async()=>{
    // A live view reads these once a second through the log; nobody asks the
    // worker for them, so they ride on the message a present sends anyway.
    const figures = { draws: 30, gpuFrames: 1, gpuMs: 4, last: null };
    const played = {
        spent: (/** @type {any} */ _buffer, /** @type {() => void} */ give)=>give(),
        /** @param {ArrayBuffer} buffer @param {(call: any) => void} each */
        read: (buffer, each)=>{
            each({ m: 'Present', wait: WAIT.PACED });
            return undefined;
        },
        play: ()=>undefined,
        figures: ()=>figures,
    };
    const across = receiverOf(played);
    across.batch();
    await new Promise(resolve=>setImmediate(resolve));
    across.hear();
    const presented = across.said.find(message=>message.type === 'presented');
    assert.deepEqual(presented.figures, figures);
    assert.equal(presented.phases['batch-read'].count, 1);

    const s = sender(0);
    assert.equal(s.made.figures(), null, 'nothing presented yet: not measured, never zero');
    s.tell(presented);
    assert.deepEqual(s.made.figures(), figures);
    assert.deepEqual(s.made.phases(), presented.phases);
});

test('the played side says how far its GPU ran behind with its diagnostics', ()=>{
    // A present that queued a frame past the bound waited for the GPU, which
    // the program's side sees as a wait on the worker like any other: the
    // bound's own account of the presents it held comes with the diagnostics.
    const bound = { limit: 3, counting: true, inFlight: 2, peak: 4, frames: 120, held: 7,
        heldMs: 35, waiting: 0 };
    const played = {
        spent: (/** @type {any} */ _buffer, /** @type {() => void} */ give)=>give(),
        /** @param {ArrayBuffer} buffer @param {(call: any) => void} each */
        read: (buffer, each)=>{
            each({ m: 'diagnostics', wait: WAIT.ANSWER });
            return undefined;
        },
        play: ()=>({ frames: 1 }),
    };
    /** @param {(() => any) | undefined} latency */
    const toldBy = latency=>{
        const across = receiverOf(played, { latency });
        across.batch();
        return across.said.find(message=>message.type === 'diagnostics');
    };

    const told = toldBy(()=>({ ...bound }));
    assert.deepEqual(told.latency, bound);
    const s = sender(0);
    assert.equal(s.made.latency(), null, 'nothing said yet: not measured, never zero');
    s.tell(told);
    assert.deepEqual(s.made.latency(), bound);

    const unbounded = sender(0);
    unbounded.tell(toldBy(undefined));
    assert.equal(unbounded.made.latency(), null, 'a played side with no bound says none');
});

test('the sender counts everything the played side said back, by type', ()=>{
    const s = sender(0);
    assert.deepEqual(s.made.received(), {});
    s.tell({ type: 'presented', count: 1 });
    s.tell({ type: 'presented', count: 2 });
    s.tell({ type: 'counts', counts: [] });
    assert.deepEqual(s.made.received(), { presented: 2, counts: 1 });
});

/** Turns of the event loop: what crosses a ring is read on one. */
const turns = async(count = 4)=>{
    for (let turn = 0; turn < count; turn++)
    {
        await new Promise(resolve=>setImmediate(resolve));
    }
};

/**
 * A root's two rings, a small one each way, with a sender writing calls on
 * a played root's `methods` and its receiver playing them as they come.
 *
 * @param {import('node:test').TestContext} t
 * @param {Record<string, (...args: any[]) => any>} methods
 */
function ringed(t, methods){
    const rings = { calls: createRingMemory(16 << 10), replies: createRingMemory(16 << 10) };
    const player = createPlayer({ root: { refCount: 1, ...methods }, ship: ()=>{},
        read: ()=>new Uint8Array(0) });
    const sent = createSender({ rings, later: ()=>{} });
    const receiver = createReceiver({ played: /** @type {any} */ (player), rings });
    // Open rings keep their waits, and the process, alive: closed however the test ends.
    t.after(()=>{
        sent.close();
        receiver.close();
    });
    /**
     * A call on the root with one argument, sent at once.
     *
     * @param {string} name @param {any} arg @param {number} wait
     */
    const call = (name, arg, wait)=>{
        const { writer } = sent;
        writer.u8(OP.CALL);
        writer.u32(0);
        writer.string(name);
        writer.u8(1);
        writer.value(arg, ()=>undefined);
        writer.u8(0);
        const answer = sent.called(wait, name);
        sent.flush();
        return answer;
    };
    return { sent, receiver, call };
}

test('a waited call answered later fills a copy of its arguments, and the batches after it are'
    + ' played meanwhile as they were sent', async t=>{
    /** @type {(() => void)[]} */
    const settles = [];
    /** @type {any[]} */
    const taken = [];
    const { sent, receiver, call } = ringed(t, {
        /** @param {Uint8Array} out */
        Fill: out=>new Promise(resolve=>settles.push(()=>{
            out.fill(0xee);
            resolve(0);
        })),
        /** @param {Uint8Array} bytes */
        Take: bytes=>{
            taken.push(bytes.every(byte=>byte === bytes[0]) ? bytes[0] : 'torn');
            return 0;
        },
    });
    const answered = call('Fill', new Uint8Array(1024), WAIT.ANSWER);
    await turns();
    // More than the ring holds while the answer is still to come: the ring
    // goes round over the bytes the waited call came in.
    for (let batch = 1; batch <= 12; batch++)
    {
        call('Take', new Uint8Array(1500).fill(batch), WAIT.NONE);
        await turns(2);
    }
    assert.deepEqual(taken, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
        'a waited answer still to come stops no batch after it');
    settles[0]();
    const reply = await answered;
    assert.equal(reply.answer, 0);
    assert.deepEqual([...new Set(reply.outs[0])], [0xee], 'its argument filled whole');
    call('Take', new Uint8Array(100).fill(13), WAIT.NONE);
    await turns();
    assert.deepEqual(taken.at(-1), 13, 'and nothing it filled landed on a batch after it');
    sent.close();
    receiver.close();
    await receiver.served();
});

test('an unwaited call answered later holds its batch, read where it lies, and the reading after it'
    + ' until it settles', async t=>{
    /** @type {(() => void)[]} */
    const settles = [];
    /** @type {any[]} */
    const seen = [];
    const { sent, receiver, call } = ringed(t, {
        /** @param {Uint8Array} bytes */
        Later: bytes=>new Promise(resolve=>settles.push(()=>{
            seen.push(`later ${[...new Set(bytes)].join(',')}`);
            resolve(0);
        })),
        /** @param {Uint8Array} bytes */
        Take: bytes=>{
            seen.push(`take ${bytes[0]}`);
            return 0;
        },
    });
    call('Later', new Uint8Array(3000).fill(0x5a), WAIT.NONE);
    await turns();
    for (let batch = 1; batch <= 8; batch++)
    {
        call('Take', new Uint8Array(1500).fill(batch), WAIT.NONE);
    }
    await turns();
    assert.deepEqual(seen, [], 'nothing after the held batch is played');
    settles[0]();
    await turns(40);
    assert.deepEqual(seen, ['later 90', 'take 1', 'take 2', 'take 3', 'take 4', 'take 5', 'take 6',
        'take 7', 'take 8'], 'its bytes were as sent when it settled, and the rest came after');
    sent.close();
    receiver.close();
    await receiver.served();
});
