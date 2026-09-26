/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The repository commits no symbolic link. A worktree points its ignored
 * artifact directories (the prebuilt emulator, the corpus) at the main
 * checkout's with a link, and a commit that takes the link in stores an
 * absolute path of the machine that made it: a checkout of that commit in the
 * main checkout replaces the directory with a link to itself and the fetched
 * files are gone, the suites that need them skipping rather than failing.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

/** The index's entries as `mode path`, or null outside a git checkout. */
function indexed(){
    try
    {
        return execFileSync('git', ['ls-files', '--stage'],
            { cwd: new URL('../../..', import.meta.url), encoding: 'utf8', maxBuffer: 1 << 28 })
            .split('\n').filter(Boolean)
            .map(line=>`${line.slice(0, 6)} ${line.slice(line.indexOf('\t') + 1)}`);
    }
    catch {
        return null;
    }
}

test('no symbolic link is committed', t=>{
    const entries = indexed();
    if (entries === null)
    {
        t.skip('not a git checkout');
        return;
    }
    assert.ok(entries.length > 0, 'the index lists the tree');
    assert.deepEqual(entries.filter(entry=>entry.startsWith('120000 ')), [],
        'a link is a directory of the machine that committed it');
});
