/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STILL_ACTIVE, createProcessTable } from './processes.js';

test('a record holds everything a child needs before it exists', ()=>{
    const table = createProcessTable();
    const child = table.create({
        imagePath: 'C:\\App\\setup.exe',
        commandLine: '"C:\\App\\setup.exe" /S',
    });

    assert.equal(child.imagePath, 'C:\\App\\setup.exe');
    assert.equal(child.commandLine, '"C:\\App\\setup.exe" /S');
    assert.equal(child.suspended, false);
    assert.deepEqual(child.patches, []);
    assert.equal(child.exitCode, STILL_ACTIVE,
        'nobody can ever observe a child as finished, so it is always running');
    assert.equal(child.handle, 0, 'a handle is the caller\'s to open');
});

test('a process id is never a thread id and never repeats', ()=>{
    const table = createProcessTable();
    const first = table.create({ imagePath: 'a.exe', commandLine: 'a' });
    const second = table.create({ imagePath: 'b.exe', commandLine: 'b' });

    const ids = [first.id, first.threadId, second.id, second.threadId];
    assert.equal(new Set(ids).size, 4, 'four distinct ids for two processes');
});

test('a suspended child is not the one that replaces this process', ()=>{
    // CREATE_SUSPENDED is the parent saying it has not finished with the child:
    // it is about to write into it. Honouring the request before ResumeThread
    // would start a child the parent had only half-built.
    const table = createProcessTable();
    const child = table.create({
        imagePath: 'C:\\App\\child.exe', commandLine: 'child', suspended: true,
    });

    assert.equal(table.pending(), null);

    child.suspended = false;
    assert.equal(table.pending(), child);
});

test('the first child asked for is the one that takes over', ()=>{
    const table = createProcessTable();
    const first = table.create({ imagePath: 'first.exe', commandLine: 'first' });
    table.create({ imagePath: 'second.exe', commandLine: 'second' });

    assert.equal(table.pending(), first);
});

test('diagnostics name what is waiting to run', ()=>{
    const table = createProcessTable();
    table.create({ imagePath: 'held.exe', commandLine: 'held', suspended: true });
    table.create({ imagePath: 'ready.exe', commandLine: 'ready' });

    assert.deepEqual(table.diagnostics(),
        { created: 2, suspended: 1, pending: 'ready.exe' });
});
