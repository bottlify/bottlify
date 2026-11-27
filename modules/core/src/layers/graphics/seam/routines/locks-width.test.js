/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The lock routines built for a 64-bit process (`X64`) against the same
 * routines' i386: one scene of blocks laid out at the same addresses in
 * cork's 32-bit test machine and its long-mode machine, the same call made
 * on each - stdcall there, the x64 convention here - and what each left
 * compared: where it went (back to the caller, or the trap), its answer, the
 * buffer's, level's and device's blocks, the command ring, the storages, and
 * what it wrote out, a pointer eight bytes wide in a 64-bit process. Every
 * case that reaches the trap in a 64-bit process reaches it with RCX, RDX, R8,
 * R9 and RSP as at the entry, which is what the bridge's 64-bit trap reads.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestMachine } from '../../../../../../cork/src/testing/machine.js';
import { CODE_64, HIGH_64, STACK_64, argumentOf, callLong, longMachine }
    from '../../../../../scripts/guest-code/long.mjs';
import { ifRoom } from '../../../../../../cork/src/testing/memory64.js';
import { X64 } from './assemble.js';
import { lockCode, lockLevelCode, moveCopyCode, unlockCode, unlockLevelCode } from './locks.js';
import {
    BUFFER, COMMAND, D3DLOCK_DISCARD, D3DLOCK_NOOVERWRITE, D3DLOCK_READONLY, FLAG_SLOW_PATH,
    HELD_HOST, LEVEL, SHADOW, SURFACE, TEXTURE,
} from '../block.js';

const TRAP = 0x0e00;
const RETURN = 0x0f00;
const CODE_32 = 0x8000;
const STACK_32 = 0x7fff0;
/** The scene, below the 32-bit machine's megabyte and inside the long one's RAM. */
const THIS = 0x20000;
const BLOCK = 0x21000;
const DEVICE = 0x30000;
const RING = 0x40000;
const RING_BYTES = 0x1000;
const STORAGE = 0x60000;
const SPARE = 0x62000;
const LENGTH = 0x400;
const OUT = 0x70000;
const RECT = 0x70100;
const LEVEL_BLOCK = 0x22000;
const LEVEL_BASE = 0x64000;
const RENAME_SLOT = 37;

/** The words of the scene a routine may change, compared after a call. */
const WATCHED = [[BLOCK, 0x100], [LEVEL_BLOCK, LEVEL.SIZE], [DEVICE, SHADOW.MOVE_COPIED + 8],
    [RING, 0x40], [STORAGE, LENGTH], [SPARE, LENGTH], [LEVEL_BASE, 0x400]];

/**
 * @typedef {Object} Scene  what a case changes of the default scene, on either machine
 * @property {(w: (at: number, words: number[]) => void) => void} [set]
 */

/**
 * Lays the default scene out through `w`: an interface at THIS whose block
 * (the word after its table's, at `word`) is a buffer's, unlocked, on a
 * device whose ring is empty; a second storage free to move onto; a texture's
 * block over the same interface for the level locks, its level 1 a block of
 * its own; a surface's the same way.
 *
 * @param {(at: number, words: number[]) => void} w @param {4 | 8} word
 * @param {'buffer' | 'texture' | 'surface'} kind
 */
const lay = (w, word, kind)=>{
    w(THIS, [0x7000, 0]);
    w(THIS + word, [BLOCK, 0]);
    if (kind === 'buffer')
    {
        w(BLOCK + BUFFER.BASE, [STORAGE, LENGTH]);
        w(BLOCK + BUFFER.DEVICE, [DEVICE]);
        w(BLOCK + BUFFER.SPARES, [SPARE, 0, 1, 0]);
    }
    else if (kind === 'texture')
    {
        w(BLOCK + TEXTURE.LEVEL_COUNT, [3]);
        w(BLOCK + TEXTURE.LOCKS + 4, [LEVEL_BLOCK]);
    }
    else
    {
        w(BLOCK + SURFACE.LEVEL, [LEVEL_BLOCK]);
    }
    w(LEVEL_BLOCK + LEVEL.BASE, [LEVEL_BASE]);
    w(LEVEL_BLOCK + LEVEL.ROW_PITCH, [64]);
    w(LEVEL_BLOCK + LEVEL.DEVICE, [DEVICE]);
    w(LEVEL_BLOCK + LEVEL.SLICE_PITCH, [256]);
    w(LEVEL_BLOCK + LEVEL.WIDTH, [16, 4, 4, 4]);
    w(DEVICE + SHADOW.COMMANDS, [RING, RING_BYTES, 0]);
    // What a routine writes out lands over a pattern, so a pointer written
    // four bytes wide where it is eight shows.
    w(OUT, [0xa5a5a5a5, 0xa5a5a5a5, 0xa5a5a5a5, 0xa5a5a5a5]);
    for (let i = 0; i < LENGTH; i += 4)
    {
        w(STORAGE + i, [0x11000000 + i]);
        w(SPARE + i, [0x22000000 + i]);
    }
};

/**
 * @typedef {Object} Outcome
 * @property {'returned' | 'trap'} went
 * @property {number} answer
 * @property {number[][]} watched
 * @property {Uint8Array} out
 * @property {ReturnType<typeof longMachine>} [machine]  the long-mode one, after the call
 */

/** @param {Uint8Array} bytes */
const words = bytes=>Array.from({ length: bytes.length >>> 2 },
    (_, i)=>new DataView(bytes.buffer, bytes.byteOffset).getUint32(i * 4, true));

/** @param {(at: number, length: number) => Uint8Array} read */
const watch = read=>WATCHED.map(([at, length])=>words(read(at, length)));

/**
 * One call on the 32-bit machine: `code` at CODE_32 (and the copy beside it).
 *
 * @param {(at: number) => Uint8Array} build @param {'buffer' | 'texture' | 'surface'} kind
 * @param {number[]} args  after `this` @param {Scene} scene
 * @returns {Outcome}
 */
const run32 = (build, kind, args, scene)=>{
    const m = createTestMachine();
    /** @type {(at: number, list: number[]) => void} */
    const w = (at, list)=>list.forEach((v, i)=>m.writeU32(at + i * 4, v));
    lay(w, 4, kind);
    scene.set?.(w);
    m.write(TRAP, [0xf4]);
    m.write(RETURN, [0xf4]);
    m.write(CODE_32, Array.from(build(CODE_32)));
    m.write(CODE_32 + 0x1000, Array.from(moveCopyCode()));
    m.writeU32(STACK_32, RETURN);
    [THIS, ...args].forEach((v, i)=>m.writeU32(STACK_32 + 4 + i * 4, v));
    m.setReg('esp', STACK_32);
    m.setEflags(2);
    m.runProgram(CODE_32);
    const went = m.eip() === RETURN + 1 ? 'returned' : m.eip() === TRAP + 1 ? 'trap' : 'lost';
    assert.notEqual(went, 'lost', `the i386 stopped at 0x${m.eip().toString(16)}`);
    if (went === 'trap')
    {
        assert.equal(m.reg('esp'), STACK_32, 'esp at the trap');
    }
    return { went: /** @type {'returned' | 'trap'} */ (went), answer: m.reg('eax') >>> 0,
        watched: watch((at, length)=>m.read(at, length)), out: m.read(OUT, 16) };
};

/**
 * The same call on the long-mode machine, the routine built for X64; a
 * pointer argument (`pointers`) passed as it is, every other one with a
 * pattern in its upper half, which the convention leaves undefined.
 *
 * @param {(at: number) => Uint8Array} build @param {'buffer' | 'texture' | 'surface'} kind
 * @param {number[]} args @param {Scene} scene @param {Set<number>} pointers
 * @param {Record<number, bigint>} [raw]  arguments passed exactly as given
 * @param {number[]} [high]  pointer arguments moved past 4 GiB, on a machine whose window
 *     reaches there (on the interpreter: the translator's wide window has its own gate),
 *     what they point at copied with them; the out-structure read there too
 * @returns {Outcome}
 */
const run64 = (build, kind, args, scene, pointers, raw = {}, high = [])=>{
    const m = longMachine(high.length > 0 ? { window: 2 ** 33, config: { translate: false } } : {});
    /** @type {(at: number, list: number[]) => void} */
    const w = (at, list)=>list.forEach((v, i)=>m.write(at + i * 4,
        [v & 0xff, v >>> 8 & 0xff, v >>> 16 & 0xff, v >>> 24 & 0xff]));
    lay(w, 8, kind);
    scene.set?.(w);
    m.write(TRAP, [0xf4]);
    m.write(RETURN, [0xf4]);
    m.write(CODE_64, build(CODE_64));
    m.write(CODE_64 + 0x1000, moveCopyCode(X64));
    for (const index of high)
    {
        m.write(HIGH_64 + args[index], m.read(args[index], 0x20));
    }
    const given = [BigInt(THIS), ...args.map((v, i)=>raw[i] ?? (high.includes(i)
        ? BigInt(HIGH_64 + v) : pointers.has(i) ? BigInt(v >>> 0) : argumentOf(v, i + 1)))];
    const call = callLong(m, CODE_64, { args: given, returnTo: RETURN });
    const went = m.rip() === RETURN + 1 ? 'returned' : m.rip() === TRAP + 1 ? 'trap' : 'lost';
    assert.notEqual(went, 'lost', `the x86-64 stopped at 0x${m.rip().toString(16)}`);
    if (went === 'trap')
    {
        for (const name of ['rcx', 'rdx', 'r8', 'r9', 'rsp'])
        {
            assert.equal(m.reg(name), call.entry[name], `${name} at the trap`);
        }
    }
    else
    {
        assert.equal(m.reg('rsp'), BigInt(STACK_64 + 8), 'rsp after the return');
        for (const name of ['rbx', 'rbp', 'rsi', 'rdi', 'r12', 'r13', 'r14', 'r15'])
        {
            assert.equal(m.reg(name), call.entry[name], `${name} kept`);
        }
    }
    const outHigh = high.some(index=>args[index] === OUT);
    if (outHigh)
    {
        assert.deepEqual(words(m.read(OUT, 16)), [0xa5a5a5a5, 0xa5a5a5a5, 0xa5a5a5a5, 0xa5a5a5a5],
            'nothing written at the out-pointer\'s low half');
    }
    return { went: /** @type {'returned' | 'trap'} */ (went),
        answer: Number(m.reg('rax') & 0xffffffffn),
        watched: watch((at, length)=>m.read(at, length)),
        out: m.read(outHigh ? HIGH_64 + OUT : OUT, 16), machine: m };
};

/**
 * A call with pointer arguments `high` past 4 GiB answers as with them below:
 * where it went, the answer, the scene's words and the out-structure.
 *
 * @param {(at: number) => Uint8Array} build @param {'buffer' | 'texture' | 'surface'} kind
 * @param {number[]} args @param {Scene} scene @param {number[]} pointers @param {number[]} high
 */
const sameHigh = (build, kind, args, scene, pointers, high)=>{
    const low = run64(build, kind, args, scene, new Set(pointers));
    const far = run64(build, kind, args, scene, new Set(pointers), {}, high);
    assert.equal(far.went, low.went, 'where the call went');
    assert.equal(far.answer, low.answer, 'the answer');
    low.watched.forEach((list, i)=>assert.deepEqual(far.watched[i], list,
        `the words at 0x${WATCHED[i][0].toString(16)}`));
    assert.deepEqual(words(far.out), words(low.out), 'the out-structure past 4 GiB');
    return low;
};

/**
 * Both, compared; `outs` says how the out-structure's layout differs: the
 * i386's words and the x86-64's at their places.
 *
 * @param {{ build: (width?: any) => (at: number) => Uint8Array,
 *     kind: 'buffer' | 'texture' | 'surface', args: number[], pointers: number[],
 *     scene?: Scene, outs?: (o32: number[], o64: number[]) => void }} c
 */
const both = c=>{
    const scene = c.scene ?? {};
    const a = run32(c.build(), c.kind, c.args, scene);
    const b = run64(c.build(X64), c.kind, c.args, scene, new Set(c.pointers));
    assert.equal(b.went, a.went, 'where the call went');
    if (a.went === 'returned')
    {
        assert.equal(b.answer, a.answer, 'the answer');
    }
    a.watched.forEach((list, i)=>assert.deepEqual(b.watched[i], list,
        `the words at 0x${WATCHED[i][0].toString(16)}`));
    // What a call left to the host wrote nothing out, on either machine.
    const outs = a.went === 'returned' && c.outs ? c.outs
        : (/** @type {number[]} */ o32, /** @type {number[]} */ o64)=>assert.deepEqual(o64, o32);
    outs(words(a.out), words(b.out));
    return { a, b };
};

/** Lock's out-pointer: a dword in the i386, a quadword with its upper half zero here. */
const pointerOut = (/** @type {number[]} */ o32, /** @type {number[]} */ o64)=>{
    assert.equal(o64[0], o32[0]);
    assert.equal(o64[1], 0, 'the pointer\'s upper half');
};

const lock = (/** @type {any} */ width)=>(/** @type {number} */ at)=>lockCode(at, TRAP,
    RENAME_SLOT, (at === CODE_32 ? CODE_32 : CODE_64) + 0x1000, width);

/** A draw in the device's ring the host has not made. @param {any} w */
const pending = w=>w(DEVICE + SHADOW.DRAWS_PENDING, [1]);

/** Buffer Lock(this, offset, size, out, flags): the cases. */
const LOCKS = /** @type {[string, number[], Scene?][]} */ ([
    ['a range', [0x10, 0x20, OUT, 0]],
    ['to the end, NOOVERWRITE, widening a pending range', [0x40, 0, OUT, D3DLOCK_NOOVERWRITE],
        { set: w=>w(BLOCK + BUFFER.FROM, [0x80, 0x100]) }],
    ['DISCARD with NOOVERWRITE: a NOOVERWRITE', [0, 0x10, OUT,
        D3DLOCK_DISCARD | D3DLOCK_NOOVERWRITE]],
    ['for reading', [0, 0x10, OUT, D3DLOCK_READONLY]],
    ['already locked', [0, 0x10, OUT, 0], { set: w=>w(BLOCK + BUFFER.LOCKED, [1]) }],
    ['a null out-pointer', [0, 0x10, 0, 0]],
    ['past the end', [0x3f0, 0x20, OUT, 0]],
    ['empty at the end', [LENGTH, 0, OUT, 0]],
    ['the device\'s lock held by the host', [0, 0x10, OUT, 0],
        { set: w=>w(DEVICE + SHADOW.HELD, [HELD_HOST]) }],
    ['the host\'s flag', [0, 0x10, OUT, 0], { set: w=>w(BLOCK, [FLAG_SLOW_PATH]) }],
    ['under a pending draw, no flags', [0, 0x10, OUT, 0],
        { set: pending }],
    ['under a pending draw, NOOVERWRITE', [0x20, 0x10, OUT, D3DLOCK_NOOVERWRITE],
        { set: w=>w(DEVICE + SHADOW.DRAWS_PENDING, [1]) }],
    ['under a pending draw, DISCARD: a move and its copy', [0x100, 0x40, OUT, D3DLOCK_DISCARD],
        { set: w=>w(DEVICE + SHADOW.DRAWS_PENDING, [1]) }],
    ['DISCARD of all of it over lent bytes: a move with nothing to copy',
        [0, 0, OUT, D3DLOCK_DISCARD], { set: w=>w(BLOCK + BUFFER.LENT, [1]) }],
    ['DISCARD under a draw, the second spare free', [0x10, 0x10, OUT, D3DLOCK_DISCARD],
        { set: w=>{
            pending(w);
            w(BLOCK + BUFFER.SPARES, [0, SPARE, 0, 1]);
        } }],
    ['DISCARD under a draw, no spare free', [0x10, 0x10, OUT, D3DLOCK_DISCARD],
        { set: w=>{
            pending(w);
            w(BLOCK + BUFFER.SPARES + 8, [0]);
        } }],
    ['DISCARD under a draw, a lock in place pending', [0x10, 0x10, OUT, D3DLOCK_DISCARD],
        { set: w=>{
            pending(w);
            w(BLOCK + BUFFER.LOCK_FLAGS, [0x80000000]);
        } }],
    ['DISCARD under a draw, the ring full', [0x10, 0x10, OUT, D3DLOCK_DISCARD],
        { set: w=>{
            pending(w);
            w(DEVICE + SHADOW.COMMAND_HEAD, [RING_BYTES - 8]);
        } }],
]);

for (const [name, args, scene] of LOCKS)
{
    test(`buffer Lock at 64 bits as at 32: ${name}`, ()=>{
        both({ build: lock, kind: 'buffer', args, pointers: [2], scene, outs: pointerOut });
    });
}

test('the move at 64 bits writes the record the host makes and copies what lies outside', ()=>{
    const { b } = both({ build: lock, kind: 'buffer', args: [0x100, 0x40, OUT, D3DLOCK_DISCARD],
        pointers: [2], scene: { set: w=>w(DEVICE + SHADOW.DRAWS_PENDING, [1]) },
        outs: pointerOut });
    assert.equal(b.went, 'returned');
    const ring = b.watched[3];
    assert.deepEqual(ring.slice(0, 4), [RENAME_SLOT, COMMAND.ARGS + 8, THIS, SPARE]);
    assert.equal(b.watched[0][BUFFER.BASE / 4], SPARE, 'the buffer on the spare');
    assert.equal(words(b.out)[0], SPARE + 0x100);
    assert.equal(b.watched[5][0], 0x11000000, 'the bytes before the lock came along');
    assert.equal(b.watched[5][0x140 / 4], 0x11000140, 'and after it');
});

test('a 64-bit out-pointer past 4 GiB: the lock, and the move under a draw, as below it',
    ifRoom(()=>{
        for (const draws of [0, 1])
        {
            const scene = { set: (/** @type {any} */ w)=>w(DEVICE + SHADOW.DRAWS_PENDING, [draws]) };
            const args = [0x10, 0x10, OUT, D3DLOCK_DISCARD];
            const low = sameHigh(lock(X64), 'buffer', args, scene, [2], [2]);
            assert.equal(low.went, 'returned');
            assert.equal(low.watched[0][BUFFER.BASE / 4], draws ? SPARE : STORAGE);
        }
    }));

test('a 64-bit out-pointer at 4 GiB exactly, its low half zero, is no null pointer', ifRoom(()=>{
    // An address of the program's at the window's 4 GiB: `0` moved past 4 GiB (`high`).
    const b = run64(lock(X64), 'buffer', [0x10, 0x10, 0, 0], {}, new Set([2]), {}, [2]);
    assert.equal(b.went, 'returned');
    assert.equal(b.machine?.quad(HIGH_64), BigInt(STORAGE + 0x10), 'written at 4 GiB');
}));

const unlock = (/** @type {any} */ width)=>(/** @type {number} */ at)=>unlockCode(at, TRAP,
    width);
for (const [name, scene] of /** @type {[string, Scene][]} */ ([
    ['a lock', { set: w=>w(BLOCK + BUFFER.LOCKED, [1]) }],
    ['a lock already queued', { set: w=>w(BLOCK + BUFFER.LOCKED, [1, 0, 0, 0, 0, 0, 0, 1]) }],
    ['no lock', {}],
    ['the ring of blocks full', { set: w=>{
        w(BLOCK + BUFFER.LOCKED, [1]);
        w(DEVICE + SHADOW.RING_HEAD, [SHADOW.RING_CAPACITY]);
    } }],
]))
{
    test(`buffer Unlock at 64 bits as at 32: ${name}`, ()=>{
        both({ build: unlock, kind: 'buffer', args: [], pointers: [], scene });
    });
}

/** LockRect / LockBox's out-structure: pBits at 4 in the i386's, at 8 here. */
/**
 * @param {boolean} box
 * @returns {(o32: number[], o64: number[]) => void}
 */
const lockedOut = box=>(o32, o64)=>{
    assert.equal(o64[0], o32[0], 'the pitch');
    if (box)
    {
        assert.equal(o64[1], o32[1], 'the slice pitch');
        assert.deepEqual(o64.slice(2, 4), [o32[2], 0], 'pBits at 8');
        return;
    }
    assert.deepEqual(o64.slice(2, 4), [o32[1], 0], 'pBits at 8');
};

for (const [kind, box] of /** @type {['texture' | 'surface', boolean][]} */ ([
    ['texture', false], ['texture', true], ['surface', false]]))
{
    const levelArgs = kind === 'texture' ? [1] : [];
    const build = (/** @type {any} */ width)=>(/** @type {number} */ at)=>lockLevelCode(at, TRAP,
        { find: kind, box }, width);
    const shape = `${kind}${box ? ' box' : ''}`;
    for (const [name, rest, scene] of /** @type {[string, number[], Scene?][]} */ ([
        ['all of it', [OUT, 0, 0]],
        ['a rectangle', [OUT, RECT, D3DLOCK_NOOVERWRITE], { set: w=>w(RECT, [1, 1, 3, 2, 0, 1]) }],
        ['an empty rectangle', [OUT, RECT, 0], { set: w=>w(RECT, [2, 1, 2, 2, 0, 1]) }],
        ['a rectangle past the edge', [OUT, RECT, 0], { set: w=>w(RECT, [0, 0, 5, 2, 0, 1]) }],
        ['a null out-pointer', [0, 0, 0]],
        ['already locked', [OUT, 0, 0], { set: w=>w(LEVEL_BLOCK + LEVEL.LOCKED, [1]) }],
        ['sampled under a pending draw', [OUT, 0, 0], { set: w=>{
            w(LEVEL_BLOCK + LEVEL.SAMPLED, [1]);
            pending(w);
        } }],
        ['the level\'s host flag', [OUT, 0, 0], { set: w=>w(LEVEL_BLOCK, [FLAG_SLOW_PATH]) }],
    ]))
    {
        test(`${shape} lock at 64 bits as at 32: ${name}`, ()=>{
            both({ build, kind, args: [...levelArgs, ...rest],
                pointers: [levelArgs.length, levelArgs.length + 1], scene, outs: lockedOut(box) });
        });
    }
    test(`${shape} lock at 64 bits through an out-pointer or a rectangle past 4 GiB`, ifRoom(()=>{
        const out = levelArgs.length;
        for (const high of [[out], [out + 1], [out, out + 1]])
        {
            const low = sameHigh(build(X64), kind, [...levelArgs, OUT, RECT, 0],
                { set: w=>w(RECT, [1, 1, 3, 2, 0, 1]) }, [out, out + 1], high);
            assert.equal(low.went, 'returned');
        }
    }));
    const unlockBuild = (/** @type {any} */ width)=>(/** @type {number} */ at)=>unlockLevelCode(
        at, TRAP, { find: kind }, width);
    for (const [name, scene] of /** @type {[string, Scene][]} */ ([
        ['a lock', { set: w=>w(LEVEL_BLOCK + LEVEL.LOCKED, [1]) }],
        ['no lock', {}],
    ]))
    {
        test(`${shape} unlock at 64 bits as at 32: ${name}`, ()=>{
            both({ build: unlockBuild, kind, args: levelArgs, pointers: [], scene });
        });
    }
}

test('a texture\'s level out of range is the host\'s at 64 bits as at 32', ()=>{
    both({ build: width=>at=>lockLevelCode(at, TRAP, { find: 'texture' }, width),
        kind: 'texture', args: [3, OUT, 0, 0], pointers: [1, 2] });
});
