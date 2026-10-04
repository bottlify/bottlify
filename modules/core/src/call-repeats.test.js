/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCallRepeats, SAY_EVERY, WINDOW } from './call-repeats.js';

/**
 * The calls as the journal would show them: those written, and a line for
 * each loop said.
 *
 * @param {[string, string][]} calls  thread and key
 */
function journal(calls){
    const repeats = createCallRepeats();
    /** @type {string[]} */
    const lines = [];
    for (const [thread, key] of calls)
    {
        const { write, said } = repeats.note(thread, key);
        if (said)
        {
            lines.push(`${thread} ${said.ended ? 'ended' : 'runs'} ${said.period}x${said.calls}`);
        }
        if (write)
        {
            lines.push(`${thread} ${key}`);
        }
    }
    return lines;
}

/** @param {string[]} keys @param {number} times */
const turns = (keys, times)=>Array.from({ length: times }, ()=>keys).flat();

test('a polling loop is written until it has repeated, then counted, then said when it ends',
    ()=>{
        const loop = ['Peek=0', 'GetKeyState(10)=0', 'Sleep(0)', 'Sleep(0)'];
        const lines = journal([...turns(loop, 100), 'Lock=0'].map(key=>['main', key]));
        assert.deepEqual(lines, [
            ...turns(loop, 2).map(key=>`main ${key}`),
            `main ended 4x${100 * 4 - WINDOW}`,
            'main Lock=0',
        ]);
    });

test('calls that do not repeat are all written, and the same call twice is not a loop', ()=>{
    const keys = ['A', 'B', 'B', 'C', 'A', 'B', 'D', 'D', 'E', 'F', 'G', 'H', 'A'];
    assert.deepEqual(journal(keys.map(key=>['main', key])), keys.map(key=>`main ${key}`));
});

test('an argument or an answer that differs breaks the loop', ()=>{
    const lines = journal([...turns(['Wait(1)=0x102'], 20), 'Wait(1)=0x0']
        .map(key=>['main', key]));
    assert.deepEqual(lines.slice(-2), [`main ended 1x${20 - WINDOW}`, 'main Wait(1)=0x0']);
});

test('each thread\'s loop is its own, however the threads interleave', ()=>{
    /** @type {[string, string][]} */
    const calls = [];
    for (let turn = 0; turn < 50; turn++)
    {
        calls.push(['main', 'Sleep(0)'], ['main', 'Peek=0']);
        // The other thread's calls change every turn: none is a loop.
        calls.push(['sound', `GetPosition=${turn}`]);
    }
    const lines = journal(calls);
    assert.equal(lines.filter(line=>line.startsWith('main ')).length, WINDOW);
    assert.equal(lines.filter(line=>line.startsWith('sound ')).length, 50);
});

test('a loop that never ends says it still runs, every so many calls', ()=>{
    const lines = journal(turns(['Sleep(0)'], WINDOW + SAY_EVERY * 2).map(key=>['main', key]));
    assert.deepEqual(lines.slice(WINDOW),
        [`main runs 1x${SAY_EVERY}`, `main runs 1x${SAY_EVERY * 2}`]);
});
