/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProcessFunctions } from './process.js';

const EINVAL = 22;
const ENOENT = 2;

const build = ()=>{
    /** @type {number[]} */
    const errno = [];
    /** @type {string[]} */
    const said = [];
    const fns = /** @type {Record<string, any>} */ (createProcessFunctions({
        errno: code=>void errno.push(code),
        divergence: api=>void said.push(api),
    }));
    return { fns, errno, said };
};

test('signal answers the handler a signal had, SIG_DFL to begin with', ()=>{
    const { fns, errno } = build();
    const SIGINT = 2;
    const SIGFPE = 8;
    assert.equal(fns.signal.handler([SIGINT, 0x401000]), 0, 'SIG_DFL');
    assert.equal(fns.signal.handler([SIGINT, 1]), 0x401000, 'the one set before');
    assert.equal(fns.signal.handler([SIGINT, 0]), 1, 'SIG_IGN');
    assert.equal(fns.signal.handler([SIGFPE, 0x402000]), 0, 'each signal its own');
    assert.deepEqual(errno, []);
    assert.equal(fns.signal.convention, 'cdecl');
    assert.equal(fns.signal.argBytes, 8);
});

test('signal refuses a number it does not know, and the runtime\'s own actions', ()=>{
    const { fns, errno } = build();
    assert.equal(fns.signal.handler([9, 0]), 0xffffffff, 'SIGKILL is no signal here');
    assert.equal(fns.signal.handler([0xffffffff, 0]), 0xffffffff);
    assert.equal(fns.signal.handler([2, 3]), 0xffffffff, 'SIG_SGE');
    assert.equal(fns.signal.handler([2, 4]), 0xffffffff, 'SIG_ACK');
    assert.deepEqual(errno, [EINVAL, EINVAL, EINVAL, EINVAL]);
    assert.equal(fns.signal.handler([2, 0]), 0, 'and a refused one changed nothing');
    for (const known of [4, 11, 15, 21, 22])
    {
        assert.equal(fns.signal.handler([known, 0]), 0, `signal ${known}`);
    }
});

test('system: there is no interpreter, and a command is ENOENT', ()=>{
    const { fns, errno, said } = build();
    assert.equal(fns.system.handler([0]), 0, 'system(NULL): no command interpreter');
    assert.deepEqual(errno, []);
    assert.equal(fns.system.handler([0x1000]), 0xffffffff);
    assert.equal(fns.system.handler([0x1000]), 0xffffffff);
    assert.deepEqual(errno, [ENOENT, ENOENT]);
    assert.deepEqual(said, ['system'], 'said once');
    assert.equal(fns.system.convention, 'cdecl');
});

test('_spawnl checks its arguments as the runtime does, then starts nothing', ()=>{
    const { fns, errno, said } = build();
    assert.equal(fns._spawnl.handler([5, 0x1000, 0x1000, 0]), 0xffffffff, 'no such mode');
    assert.equal(fns._spawnl.handler([0, 0, 0]), 0xffffffff, 'no image');
    assert.deepEqual(errno, [EINVAL, EINVAL]);
    assert.equal(fns._spawnl.handler([0, 0x1000, 0x1000, 0]), 0xffffffff);
    assert.deepEqual(errno, [EINVAL, EINVAL, ENOENT]);
    assert.deepEqual(said, ['_spawnl']);
    assert.equal(fns._spawnl.convention, 'cdecl');
});

test('_spawnv answers as _spawnl does, its arguments in an array', ()=>{
    const { fns, errno } = build();
    assert.equal(fns._spawnv.handler([5, 0x1000, 0x2000]), 0xffffffff, 'no such mode');
    assert.equal(fns._spawnv.handler([0, 0, 0x2000]), 0xffffffff, 'no image');
    assert.equal(fns._spawnv.handler([0, 0x1000, 0x2000]), 0xffffffff);
    assert.deepEqual(errno, [EINVAL, EINVAL, ENOENT]);
    assert.equal(fns._spawnv.argBytes, 12);
});
