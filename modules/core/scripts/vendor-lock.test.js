/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The emulator's source and its prebuilt build are one version: the submodule
 * pins the commit `build-v86.mjs` builds from, and the lock names the release
 * `fetch-v86.mjs` downloads, whose tag carries the commit it was built from.
 * Two that drift apart give a reproducible build a different engine from the
 * one every test ran on.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** The commit the submodule is pinned to, or null outside a git checkout. */
function pinned(){
    try
    {
        return execFileSync('git', ['rev-parse', ':modules/core/vendor/v86'],
            { cwd: new URL('../../..', import.meta.url), encoding: 'utf8' }).trim();
    }
    catch {
        return null;
    }
}

test('the submodule pins the commit the locked prebuilt release was built from', t=>{
    const commit = pinned();
    if (commit === null)
    {
        t.skip('not a git checkout');
        return;
    }
    const { tag } = JSON.parse(readFileSync(`${ROOT}/vendor-lock.json`, 'utf8'));
    const built = /^build-([0-9a-f]{7,40})$/.exec(tag);
    assert.ok(built, `the lock's tag names its commit: ${tag}`);
    assert.ok(commit.startsWith(built[1]),
        `the submodule is at ${commit.slice(0, 7)}, the prebuilt was built from ${built[1]}`);
});
