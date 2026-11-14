/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * live.mjs: every command and mode names a module that is there, and the
 * profile command's views read a profile as DevTools writes one.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { COMMANDS, help } from './live.mjs';
import { callersView, timeView } from './commands/profile.mjs';

test('every command and mode of live.mjs is a module of commands/, and help lists them', ()=>{
    for (const [name, command] of Object.entries(COMMANDS))
    {
        for (const file of command.modes ? Object.values(command.modes) : [command.module])
        {
            assert.ok(existsSync(new URL(`commands/${file}`, import.meta.url)), `${name}: ${file}`);
        }
        assert.match(help(), new RegExp(`\\n  ${name} `));
    }
});

/** A profile of three functions: main calls work, which calls now; idle beside. */
const PROFILE = {
    nodes: [
        { id: 1, callFrame: { functionName: '(root)', url: '', lineNumber: -1 }, children: [2, 5] },
        { id: 2, callFrame: { functionName: 'main', url: 'x/a.js', lineNumber: 0 }, children: [3] },
        { id: 3, callFrame: { functionName: 'work', url: 'x/a.js', lineNumber: 9 }, children: [4] },
        { id: 4, callFrame: { functionName: 'now', url: '', lineNumber: -1 } },
        { id: 5, callFrame: { functionName: '(idle)', url: '', lineNumber: -1 } },
    ],
    samples: [3, 4, 4, 5],
    timeDeltas: [10_000, 30_000, 30_000, 30_000],
};

test('the time view weighs functions by their time, and finds a stretch outside guest code', ()=>{
    const lines = timeView(PROFILE, { minMs: 50 });
    assert.ok(lines[0].startsWith('100 ms sampled: idle  30.0%'));
    assert.ok(lines.includes('   60.0%  now :0'));
    assert.ok(lines.includes('   70.0%  main a.js:1'));
    assert.match(lines.at(-1) ?? '', /70 ms: now :0=60, work a.js:10=10/);
});

test('the callers view names who calls a function, by the time under it', ()=>{
    const lines = callersView(PROFILE, /^now /, { depth: 2 });
    assert.equal(lines[0], '^now : 60 of 100 ms (60.0%)');
    assert.equal(lines[1], '   60.0%  work a.js:10  <  main a.js:1');
});
