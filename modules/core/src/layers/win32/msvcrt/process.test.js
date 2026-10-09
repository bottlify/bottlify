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

test('_spawnl checks its arguments as the runtime does; with no launcher it starts nothing', ()=>{
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

/**
 * A process table with an image `C:\\Game\\bf.exe` and strings in memory.
 *
 * @param {Record<number, string>} strings
 * @param {Record<number, number>} [words]
 */
const launching = (strings, words = {})=>{
    /** @type {Array<{ named: string, line: string }>} */
    const launched = [];
    /** @type {number[]} */
    const closed = [];
    /** @type {number[]} */
    const exited = [];
    /** @type {number[]} */
    const errno = [];
    const fns = /** @type {Record<string, any>} */ (createProcessFunctions({
        errno: code=>void errno.push(code),
        readCString: at=>strings[at] ?? '',
        readU32: at=>words[at] ?? 0,
        launch: (named, line)=>{
            if (!/bf\.exe$/i.test(named))
            {
                return null;
            }
            launched.push({ named, line });
            return { handle: 0x40, threadHandle: 0x44 };
        },
        closeHandle: handle=>void closed.push(handle),
        exitProcess: code=>void exited.push(code),
    }));
    return { fns, launched, closed, exited, errno };
};

const STRINGS = {
    0x1000: 'C:\\Game\\bf.exe', 0x1100: 'bf.exe',
    0x1200: '+restart', 0x1300: '7648' };

test('_spawnl starts the image with its arguments joined by spaces, as the runtime joins them',
    ()=>{
        const { fns, launched, closed } = launching(STRINGS);
        const P_NOWAIT = 1;
        assert.equal(fns._spawnl.handler([P_NOWAIT, 0x1000, 0x1100, 0x1200, 0x1300, 0, 0x9999]),
            0x40, 'the process handle');
        assert.deepEqual(launched, [{ named: 'C:\\Game\\bf.exe', line: 'bf.exe +restart 7648' }]);
        assert.deepEqual(closed, [0x44], 'the thread handle is the runtime\'s to close');
    });

test('_spawnl: _P_NOWAITO and _P_DETACH answer zero; _P_OVERLAY ends the caller',
    ()=>{
        const { fns, closed, exited } = launching(STRINGS);
        assert.equal(fns._spawnl.handler([3, 0x1000, 0x1100, 0]), 0, '_P_NOWAITO');
        assert.equal(fns._spawnl.handler([4, 0x1000, 0x1100, 0]), 0, '_P_DETACH');
        assert.deepEqual(closed, [0x44, 0x40, 0x44, 0x40]);
        fns._spawnl.handler([2, 0x1000, 0x1100, 0]);
        assert.deepEqual(exited, [0], '_P_OVERLAY');
    });

test('_spawnl: an image that is not there is ENOENT, and _P_WAIT is refused', ()=>{
    const { fns, launched, errno } = launching({ ...STRINGS, 0x1400: 'C:\\nothing.exe' });
    assert.equal(fns._spawnl.handler([1, 0x1400, 0x1400, 0]), 0xffffffff);
    assert.equal(fns._spawnl.handler([0, 0x1000, 0x1100, 0]), 0xffffffff, '_P_WAIT');
    assert.deepEqual(errno, [ENOENT, ENOENT]);
    assert.deepEqual(launched, []);
});

test('_spawnv reads argv up to its NULL', ()=>{
    const { fns, launched } = launching(STRINGS,
        { 0x2000: 0x1100, 0x2004: 0x1200, 0x2008: 0, 0x200c: 0x1300 });
    assert.equal(fns._spawnv.handler([1, 0x1000, 0x2000]), 0x40);
    assert.deepEqual(launched, [{ named: 'C:\\Game\\bf.exe', line: 'bf.exe +restart' }]);
});

test('raise ignores, ends the process by default, or runs the handler set', async()=>{
    /** @type {number[]} */
    const errno = [];
    /** @type {Array<[number, number[]]>} */
    const called = [];
    /** @type {number[]} */
    const exited = [];
    const fns = /** @type {Record<string, any>} */ (createProcessFunctions({
        errno: code=>void errno.push(code),
        callGuest: async(entry, args)=>{
            called.push([entry, args]);
            return 0;
        },
        exitProcess: code=>void exited.push(code),
    }));
    const SIGINT = 2;
    const SIGFPE = 8;
    const SIGTERM = 15;
    assert.equal(fns.raise.convention, 'cdecl');
    assert.equal(fns.raise.argBytes, 4);

    assert.equal(await fns.raise.handler([5]), 0xffffffff, 'a signal the runtime does not know');
    assert.deepEqual(errno, [EINVAL]);

    fns.signal.handler([SIGINT, 1]);
    assert.equal(await fns.raise.handler([SIGINT]), 0, 'SIG_IGN');
    assert.deepEqual(called, []);
    assert.deepEqual(exited, []);

    fns.signal.handler([SIGFPE, 0x401000]);
    assert.equal(await fns.raise.handler([SIGFPE]), 0);
    assert.deepEqual(called, [[0x401000, [SIGFPE, 0x8c]]], 'SIGFPE is given _FPE_EXPLICITGEN');
    assert.equal(fns.signal.handler([SIGFPE, 0]), 0,
        'the handler was put back to SIG_DFL before it ran');

    fns.signal.handler([SIGINT, 0x402000]);
    await fns.raise.handler([SIGINT]);
    assert.deepEqual(called[1], [0x402000, [SIGINT]]);

    await fns.raise.handler([SIGTERM]);
    assert.deepEqual(exited, [3], 'SIG_DFL is _exit(3)');
});
