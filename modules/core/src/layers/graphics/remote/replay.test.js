/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loopbackDirect3D } from './loopback.js';
import { SWEEP_SLICE, createMirror } from './replay.js';
import { answeredByRenderer, playedDirect3D, recordedDirect3D } from './direct3d.js';
import { createReceiver, createSender } from './channel.js';
import { LEND_LEAST, createBorrower, createLender, createLendingBuffers } from './lending.js';
import { D3DFMT, D3DPOOL, D3DSWAPEFFECT, D3D_OK } from '../d3d9/constants.js';
import { D3DCLEAR, D3DFMT_INDEX, D3DPT, D3DRS, D3DTS } from '../d3d8/constants.js';
import { D3DQUERYTYPE, createDirect3D9 } from '../d3d9/device.js';
import { commandSlot } from '../d3d9/commands.js';
import { createReferenceCount } from '../d3d9/resources.js';
import { createBackend } from '../webgpu/backend.js';
import { createFakeDevice } from '../webgpu/internal/fake-device.js';
import { FVF } from '../webgpu/internal/vertexformat.js';
import v8 from 'node:v8';
import vm from 'node:vm';

const RAM_BASE = 0x40000000;

/**
 * A root of a device's shape, small enough to see through: each side's
 * services and what its objects saw are kept in `sides`, which side each is
 * by `played` (the played one is made first).
 *
 * @param {any[]} sides
 */
function toy(sides){
    return (/** @type {any} */ services)=>{
        const side = { services, played: services.backend !== undefined,
            seen: /** @type {any[]} */ ([]), counted: /** @type {WeakRef<any>[]} */ ([]), looks: 0 };
        sides.push(side);
        return {
            /** @param {{ thing?: any }} out */
            CreateThing(out){
                const base = services.allocate(16);
                out.thing = {
                    base,
                    /** @param {{ pBits?: number }} locked */
                    Lock(locked){
                        locked.pBits = base;
                        return D3D_OK;
                    },
                    Unlock(){
                        side.seen.push([...services.readMemory(base, 4)]);
                        return D3D_OK;
                    },
                    /** @param {{ pBits?: number }} locked @param {any} rect @param {number} flags */
                    LockRect(locked, rect, flags){
                        void rect;
                        void flags;
                        locked.pBits = base;
                        return D3D_OK;
                    },
                    UnlockRect: ()=>D3D_OK,
                    // A lock whose address the played device answers later, as
                    // a render target's does: none is known when it is recorded.
                    /** @param {{ pBits?: number }} locked @param {any} rect @param {number} flags */
                    LockRectAnswered(locked, rect, flags){
                        void locked;
                        void rect;
                        void flags;
                        return D3D_OK;
                    },
                    // What the played device holds there; the recorded one
                    // reads nothing, which would send the bytes itself.
                    Peek(){
                        if (side.played)
                        {
                            side.seen.push([...services.readMemory(base, 4)]);
                        }
                        return D3D_OK;
                    },
                    /** @param {{ create: () => number }} gdi */
                    MakeDc(gdi){
                        side.seen.push(gdi.create());
                        return D3D_OK;
                    },
                };
                return D3D_OK;
            },
            /** @param {{ thing?: any }} out */
            CreateCounted(out, owned = false){
                // One its device owns starts at zero and lives on there, as an
                // implicit swap chain does.
                const count = createReferenceCount({ implicit: owned,
                    onLastRef: ()=>side.seen.push('gone') });
                // Watched, never held: what keeps one alive is the test's question.
                side.counted.push(new WeakRef(count));
                out.thing = {
                    counter: count,
                    get refCount(){
                        return count.value;
                    },
                    get destroyed(){
                        side.looks++;
                        return count.destroyed;
                    },
                    Touch: ()=>D3D_OK,
                    reachable: ()=>!count.destroyed,
                    addRef: ()=>count.addRef(),
                    release: ()=>count.release(),
                };
                return D3D_OK;
            },
            /** @param {number} from @param {number} to */
            Copy(from, to){
                services.writeMemory(to, services.readMemory(from, 4));
                return D3D_OK;
            },
            /** @param {{ value?: number }} out */
            GetData(out){
                out.value = side.played ? 7 : 1;
                return side.played ? 'played' : 'recorded';
            },
            Present(){
                return side.played ? Promise.resolve(D3D_OK) : D3D_OK;
            },
        };
    };
}

/** A toy root through the loopback, over a guest memory of its own. */
function toyLoop(){
    /** @type {any[]} */
    const sides = [];
    const ram = new Uint8Array(1 << 16);
    let next = 0x100;
    const root = loopbackDirect3D(toy(sides), {
        backend: {},
        allocate: (/** @type {number} */ bytes)=>{
            const at = next;
            next += bytes;
            return at;
        },
        readMemory: (/** @type {number} */ at, /** @type {number} */ length)=>ram.slice(at,
            at + length),
        writeMemory: (/** @type {number} */ at, /** @type {Uint8Array} */ bytes)=>ram.set(bytes, at),
    });
    return { root, ram, recorded: sides.find(side=>!side.played),
        played: sides.find(side=>side.played) };
}

/**
 * A toy root whose calls cross a port the test empties itself, over a shared
 * guest memory: with `lend`, what its unlocks let the program write is lent
 * to the played side rather than copied, from an allocation of `least` bytes up.
 *
 * @param {boolean} lend @param {number} [least]
 */
function toyAcross(lend, least = 0){
    /** @type {any[]} */
    const sides = [];
    const ram = new Uint8Array(new SharedArrayBuffer(1 << 16));
    let next = 0x100;
    const services = {
        backend: {},
        allocate: (/** @type {number} */ bytes)=>{
            const at = next;
            next += bytes;
            return at;
        },
        readMemory: (/** @type {number} */ at, /** @type {number} */ length)=>ram.slice(at,
            at + length),
        writeMemory: (/** @type {number} */ at, /** @type {Uint8Array} */ bytes)=>ram.set(bytes, at),
    };
    const buffers = createLendingBuffers();
    const played = playedDirect3D(toy(sides), { ...services,
        borrow: createBorrower({ ...buffers, memory: ram }) });
    /** What the played side said back. @type {any[]} */
    const said = [];
    /** What each batch's read answered: the look at objects at zero it made, if it made one. */
    const swept = /** @type {(number | undefined)[]} */ ([]);
    /**
     * @param {ArrayBuffer} buffer
     * @param {(call: any) => boolean | void} each
     */
    const read = (buffer, each)=>{
        const answered = played.read(buffer, each);
        swept.push(answered);
        return answered;
    };
    const reading = { ...played, read };
    const receiver = createReceiver({ played: reading, post: message=>said.push(message) });
    /** @type {any[]} */
    const sent = [];
    const sender = createSender({ post: message=>sent.push(message), later: ()=>{},
        lending: lend ? { ...buffers, memory: ram, least } : null });
    const root = recordedDirect3D(toy(sides), services, sender);
    return {
        root, ram, sender, said, swept,
        played: sides.find(side=>side.played),
        /** The played side plays what was sent. */
        play(){
            sender.flush();
            for (const message of sent.splice(0))
            {
                receiver.receive(message);
            }
        },
    };
}

test('bytes lent to the played side are what the program wrote before the unlock, though it'
    + ' locks and writes them again before they are played', ()=>{
    for (const lend of [false, true])
    {
        const { root, ram, sender, played, play } = toyAcross(lend);
        /** @type {{ thing?: any }} */
        const out = {};
        root.CreateThing(out);
        const thing = out.thing;
        /** @type {{ pBits?: number }} */
        const locked = {};
        thing.LockRect(locked, null, 0);
        const at = /** @type {number} */ (locked.pBits);
        ram.set([1, 2, 3, 4], at);
        thing.UnlockRect();
        thing.Peek();
        thing.LockRect(locked, null, 0);
        ram.set([5, 6, 7, 8], at);
        thing.UnlockRect();
        thing.Peek();
        play();
        assert.deepEqual(played.seen, [[1, 2, 3, 4], [5, 6, 7, 8]], `lent: ${lend}`);
        assert.deepEqual(sender.lender?.diagnostics() ?? null, lend ? { lent: 2, lentBytes: 32,
            stashed: 1, stashedBytes: 16, waited: 0, waitedMs: 0 } : null);
    }
});

test('the bytes sent to the played side are counted by what sent them: a buffer\'s unlock, a'
    + ' surface\'s, what the device wrote in guest memory', ()=>{
    for (const lend of [false, true])
    {
        const { root, ram, sender, play } = toyAcross(lend);
        /** @type {{ thing?: any }} */
        const out = {};
        root.CreateThing(out);
        /** @type {{ thing?: any }} */
        const source = {};
        root.CreateThing(source);
        /** @type {{ pBits?: number }} */
        const locked = {};
        out.thing.Lock(locked);
        ram.set([1, 2, 3, 4], /** @type {number} */ (locked.pBits));
        out.thing.Unlock();
        source.thing.LockRect(locked, null, 0);
        ram.set([5, 6, 7, 8], /** @type {number} */ (locked.pBits));
        source.thing.UnlockRect();
        source.thing.Peek();
        root.Copy(source.thing.base, out.thing.base);
        play();
        // A lent surface goes as its address; its bytes are the lender's count.
        assert.deepEqual(sender.shippedBytes(), { buffers: 16, surfaces: lend ? 0 : 16, reads: 0,
            writes: 4, dynamic: 0, compared: 0 }, `lent: ${lend}`);
    }
});

test('a played object the program no longer counts is not held by the player', async()=>{
    // A program that makes and drops buffers by the ten thousand while it
    // loads had every one held by the played side for the rest of the run.
    const { root, played, play } = toyAcross(false);
    for (let made = 0; made < 32; made++)
    {
        /** @type {{ thing?: any }} */
        const out = {};
        root.CreateCounted(out);
        assert.equal(out.thing.release(), 0);
    }
    /** @type {{ thing?: any }} */
    const kept = {};
    root.CreateCounted(kept);
    // At a count of zero and not destroyed -- a level its texture owns -- the
    // program may still call it through the pointer it kept.
    /** @type {{ thing?: any }} */
    const owned = {};
    root.CreateCounted(owned, true);
    owned.thing.Touch();
    play();
    await new Promise(resolve=>setImmediate(resolve));
    v8.setFlagsFromString('--expose-gc');
    /** @type {() => void} */ (vm.runInNewContext('gc'))();
    const alive = played.counted.filter((/** @type {WeakRef<object>} */ one)=>one.deref());
    assert.equal(alive.length, 2, 'only the one still counted and the one still owned');
    kept.thing.addRef();
    owned.thing.addRef();
    play();
    assert.deepEqual(alive.map((/** @type {WeakRef<any>} */ one)=>one.deref().value), [2, 1], 'and calls still reach them');
});

test('a frame\'s look at the objects at a count of zero takes up a slice of them, the next '
    + 'going on where it stopped', ()=>{
    // A texture's levels sit at zero for as long as it lives: a program
    // holding thousands had the worker look at every one, every frame.
    const { root, played, play } = toyAcross(false);
    for (let made = 0; made < 3 * SWEEP_SLICE; made++)
    {
        /** @type {{ thing?: any }} */
        const out = {};
        root.CreateCounted(out, true);
        out.thing.Touch();
    }
    play();
    played.looks = 0;
    root.Present();
    play();
    assert.ok(played.looks <= SWEEP_SLICE + 1,
        `one look took up ${played.looks} of ${3 * SWEEP_SLICE}`);
    assert.ok(played.looks >= SWEEP_SLICE, 'and a whole slice');
});

test('a played object collected after it was destroyed is answered as unreachable', async()=>{
    // The bridge asks again whether an interface it held at a count of zero
    // can still be called; asked of a slot the player had emptied, the call
    // stopped the played device.
    const { root, played, play, said } = toyAcross(false);
    /** @type {{ thing?: any }} */
    const out = {};
    root.CreateCounted(out);
    assert.equal(out.thing.release(), 0);
    play();
    await new Promise(resolve=>setImmediate(resolve));
    v8.setFlagsFromString('--expose-gc');
    /** @type {() => void} */ (vm.runInNewContext('gc'))();
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(played.counted[0].deref(), undefined, 'collected on the played side');
    out.thing.reachable();
    play();
    assert.deepEqual(said.filter(message=>message.type === 'failed'), []);
});

test('one method called on many objects of a kind defines its structures\' shapes once', ()=>{
    // Kept per object, every buffer a level made sent its Lock's shape again,
    // and both sides' tables of shapes grew with every buffer.
    const { root, sender, play } = toyAcross(false);
    const make = ()=>{
        /** @type {{ thing?: any }} */
        const out = {};
        root.CreateThing(out);
        play();
        return out.thing;
    };
    /** @param {any} thing */
    const lockCost = thing=>{
        // A structure with members, as the seam's are when they cross.
        /** @type {{ pBits?: number }} */
        const locked = { pBits: 0 };
        const before = sender.sent().bytes;
        thing.Lock(locked);
        play();
        return sender.sent().bytes - before;
    };
    const first = make();
    lockCost(first);
    const again = lockCost(first);
    assert.equal(lockCost(make()), again, 'a new object\'s lock costs what a known one\'s does');
});

test('the bytes of the batches are counted by the method whose record they are', ()=>{
    const { root, ram, sender, play } = toyAcross(false);
    /** @type {{ thing?: any }} */
    const out = {};
    root.CreateThing(out);
    /** @type {{ pBits?: number }} */
    const locked = {};
    for (let round = 0; round < 3; round++)
    {
        out.thing.Lock(locked);
        ram.set([1, 2, 3, 4], /** @type {number} */ (locked.pBits));
        out.thing.Unlock();
    }
    play();
    const counted = Object.fromEntries(sender.methodBytes().map(({ name, count, bytes })=>[name,
        { count, carries: bytes > 0 }]));
    assert.deepEqual(counted.Unlock, { count: 3, carries: true });
    assert.deepEqual(counted.Lock, { count: 3, carries: true });
    const unlock = /** @type {any} */ (sender.methodBytes().find(entry=>entry.name === 'Unlock'));
    assert.ok(unlock.bytes >= 3 * 16, 'its records hold the bytes the unlocks sent');
});

test('an allocation smaller than the lender\'s least is copied, not lent, and the guest\'s routines'
    + ' are told so', ()=>{
    // A level's lock is the host's while its bytes may be lent: Call of Duty
    // 4's 32x32 levels, locked every frame, crossed to the host each time to
    // save a copy of 1.3 KB.
    assert.equal(createLender({ ...createLendingBuffers(), memory: new Uint8Array(16) }).least,
        LEND_LEAST, 'the least by default');
    for (const [least, lends] of /** @type {const} */ ([[16, true], [17, false]]))
    {
        const { root, ram, sender, played, play } = toyAcross(true, least);
        /** @type {{ thing?: any }} */
        const out = {};
        root.CreateThing(out);
        const at = out.thing.base;
        assert.equal(root.lendsAt(at), lends, `least ${least}: the routines are told`);
        /** @type {{ pBits?: number }} */
        const locked = {};
        out.thing.LockRect(locked, null, 0);
        ram.set([1, 2, 3, 4], at);
        out.thing.UnlockRect();
        out.thing.Peek();
        play();
        assert.deepEqual(played.seen, [[1, 2, 3, 4]], `least ${least}: the bytes arrive`);
        assert.equal(sender.lender?.diagnostics().lent, lends ? 1 : 0, `least ${least}`);
    }
});

test('a lend the played side read before the program locks again is not stashed', ()=>{
    const { root, ram, sender, played, play } = toyAcross(true);
    /** @type {{ thing?: any }} */
    const out = {};
    root.CreateThing(out);
    /** @type {{ pBits?: number }} */
    const locked = {};
    out.thing.LockRect(locked, null, 0);
    ram.set([1, 2, 3, 4], /** @type {number} */ (locked.pBits));
    out.thing.UnlockRect();
    out.thing.Peek();
    play();
    out.thing.LockRect(locked, null, 0);
    assert.deepEqual(played.seen, [[1, 2, 3, 4]]);
    assert.equal(sender.lender?.diagnostics().stashed, 0);
    assert.equal(sender.lender?.diagnostics().lent, 1);
});

test('what the recorded device writes over lent bytes waits until the played side has them',
    ()=>{
        const { root, ram, sender, played, play } = toyAcross(true);
        /** @type {{ thing?: any }} */
        const out = {};
        root.CreateThing(out);
        /** @type {{ thing?: any }} */
        const source = {};
        root.CreateThing(source);
        /** @type {{ pBits?: number }} */
        const locked = {};
        out.thing.LockRect(locked, null, 0);
        const at = /** @type {number} */ (locked.pBits);
        ram.set([1, 2, 3, 4], at);
        out.thing.UnlockRect();
        out.thing.Peek();
        ram.set([6, 6, 6, 6], source.thing.base);
        root.Copy(source.thing.base, at);
        out.thing.Peek();
        play();
        assert.deepEqual(played.seen, [[1, 2, 3, 4], [6, 6, 6, 6]]);
        assert.equal(sender.lender?.diagnostics().stashed, 1);
    });

test('what a lock let the program write is the played device\'s at the unlock', ()=>{
    const { root, ram, played } = toyLoop();
    /** @type {{ thing?: any }} */
    const out = {};
    assert.equal(root.CreateThing(out), D3D_OK);
    /** @type {{ pBits?: number }} */
    const locked = {};
    assert.equal(out.thing.Lock(locked), D3D_OK);
    ram.set([1, 2, 3, 4], /** @type {number} */ (locked.pBits));
    assert.equal(out.thing.Unlock(), D3D_OK);
    assert.deepEqual(played.seen, [[1, 2, 3, 4]]);
});

test('a lock taken to read sends nothing back at its unlock once the part was sent; one taken '
    + 'to write does', ()=>{
    const { root, ram, played } = toyLoop();
    /** @type {{ thing?: any }} */
    const out = {};
    root.CreateThing(out);
    const thing = out.thing;
    /** @type {{ pBits?: number }} */
    const locked = {};
    const D3DLOCK_READONLY = 0x10;
    assert.equal(thing.LockRect(locked, null, 0), D3D_OK);
    ram.set([1, 2, 3, 4], /** @type {number} */ (locked.pBits));
    assert.equal(thing.UnlockRect(), D3D_OK);
    thing.Peek();
    assert.deepEqual(played.seen, [[1, 2, 3, 4]], 'written: the bytes went');

    assert.equal(thing.LockRect(locked, null, D3DLOCK_READONLY | 0x800), D3D_OK);
    ram.set([5, 6, 7, 8], /** @type {number} */ (locked.pBits));
    assert.equal(thing.UnlockRect(), D3D_OK);
    thing.Peek();
    assert.deepEqual(played.seen[1], [1, 2, 3, 4], 'read, not written: nothing went');

    ram.set([9, 9, 9, 9], /** @type {number} */ (locked.pBits));
    assert.equal(thing.LockRectAnswered(locked, null, D3DLOCK_READONLY), D3D_OK);
    assert.equal(thing.UnlockRect(), D3D_OK);
    thing.Peek();
    assert.deepEqual(played.seen[2], [1, 2, 3, 4],
        'read, with no address on record: still nothing went');
});

test('a part the played side was never sent goes at its first unlock, even of a lock taken to '
    + 'read: a managed level filled under D3DLOCK_READONLY is drawn with what was written', ()=>{
    const { root, ram, played } = toyLoop();
    /** @type {{ thing?: any }} */
    const out = {};
    root.CreateThing(out);
    const thing = out.thing;
    /** @type {{ pBits?: number }} */
    const locked = {};
    const D3DLOCK_READONLY = 0x10;
    assert.equal(thing.LockRect(locked, null, D3DLOCK_READONLY), D3D_OK);
    ram.set([5, 6, 7, 8], /** @type {number} */ (locked.pBits));
    assert.equal(thing.UnlockRect(), D3D_OK);
    thing.Peek();
    assert.deepEqual(played.seen, [[5, 6, 7, 8]], 'never sent: the bytes went');

    assert.equal(thing.LockRect(locked, null, D3DLOCK_READONLY), D3D_OK);
    ram.set([7, 7, 7, 7], /** @type {number} */ (locked.pBits));
    assert.equal(thing.UnlockRect(), D3D_OK);
    thing.Peek();
    assert.deepEqual(played.seen[1], [5, 6, 7, 8], 'sent once: a read sends nothing again');
});

test('a method the caller wraps is its own: what it calls through is played once', ()=>{
    const { root, recorded, played } = toyLoop();
    /** @type {{ thing?: any }} */
    const out = {};
    root.CreateThing(out);
    const thing = out.thing;
    const unlock = thing.Unlock;
    let wrapped = 0;
    thing.Unlock = ()=>{
        wrapped++;
        return unlock();
    };
    assert.equal(thing.Unlock(), D3D_OK);
    assert.equal(wrapped, 1);
    assert.equal(recorded.seen.length, 1);
    assert.equal(played.seen.length, 1);
});

test('a service the caller passes answers the played device as it answered the recorded', ()=>{
    const { root, recorded, played } = toyLoop();
    /** @type {{ thing?: any }} */
    const out = {};
    root.CreateThing(out);
    let made = 0x40;
    assert.equal(out.thing.MakeDc({ create: ()=>++made }), D3D_OK);
    assert.equal(made, 0x41, 'the caller\'s service is asked once');
    assert.deepEqual(recorded.seen, [0x41]);
    assert.deepEqual(played.seen, [0x41]);
});

test('a call the renderer answers is answered, out-structure and all, by the played device', ()=>{
    const { root } = toyLoop();
    /** @type {{ value?: number }} */
    const out = {};
    assert.equal(root.GetData(out), 'played');
    assert.equal(out.value, 7);
});

test('what the recorded device copies in guest memory is the played device\'s too', ()=>{
    const { root, ram, played } = toyLoop();
    /** @type {{ thing?: any }} */
    const out = {};
    root.CreateThing(out);
    // Written with no lock: the played device was never sent these bytes,
    // and its own copy of them copies nothing.
    ram.set([9, 8, 7, 6], 0x800);
    assert.equal(root.Copy(0x800, out.thing.base), D3D_OK);
    assert.deepEqual([...ram.subarray(out.thing.base, out.thing.base + 4)], [9, 8, 7, 6]);
    /** @type {{ pBits?: number }} */
    const locked = {};
    out.thing.Lock(locked);
    out.thing.Unlock();
    assert.deepEqual(played.seen, [[9, 8, 7, 6]]);
});

test('references the guest took and gave back unseen leave the played count where the'
    + ' recorded one is', ()=>{
    const { root, recorded, played } = toyLoop();
    /** @type {{ thing?: any }} */
    const out = {};
    root.CreateCounted(out);
    const thing = out.thing;
    // The recorded object's count kept in a word the guest moves itself, as
    // the guest's AddRef and Release do, never across zero.
    let word = 0;
    thing.counter.place({ address: 4, read: ()=>word, write: (/** @type {number} */ value)=>{
        word = value;
    } });
    word += 3;
    assert.equal(thing.addRef(), 5, 'a reference taken through the host');
    word -= 4;
    assert.equal(thing.release(), 0, 'the last one, given back through the host');
    assert.deepEqual(recorded.seen, ['gone']);
    assert.deepEqual(played.seen, ['gone'], 'the played object ended with it');
});

test('a present the played device holds is held for the caller too', async()=>{
    const { root } = toyLoop();
    const answer = root.Present();
    assert.equal(typeof answer?.then, 'function');
    assert.equal(await answer, D3D_OK);
});

test('a structure that held another device\'s object reads as holding none', ()=>{
    const one = toyLoop();
    const other = toyLoop();
    /** @type {{ thing?: any }} */
    const out = {};
    one.root.CreateThing(out);
    assert.equal(other.root.CreateThing(out), D3D_OK);
    assert.notEqual(out.thing, undefined);
});

test('the mirror keeps what is written to it across its pages, and zero elsewhere', ()=>{
    const mirror = createMirror();
    const bytes = Uint8Array.from({ length: 300 }, (_, index)=>index & 0xff);
    mirror.write(0x1ff80, bytes);
    assert.deepEqual([...mirror.read(0x1ff80, 300)], [...bytes]);
    assert.deepEqual([...mirror.read(0x1ff70, 0x10)], new Array(0x10).fill(0));
});

/**
 * The mirror's watches as they were before a 64 KiB page could be passed
 * over: every 4 KiB page of a take asked of a map of stamps. The reference
 * the watch is held to.
 */
const watchesAskingEachPage = ()=>{
    /** @type {Map<number, number>} */
    const stamps = new Map();
    let stamp = 0;
    return {
        /** @param {number} address @param {number} length */
        write(address, length){
            stamp++;
            const last = (address + length - 1) >>> 12;
            for (let page = address >>> 12; page <= last; page++)
            {
                stamps.set(page, stamp);
            }
        },
        /** @param {number} address @param {number} length */
        watch(address, length){
            /** @type {Map<number, number>} */
            const seen = new Map();
            const first = address >>> 12;
            const end = (address + Math.max(length, 1) - 1) >>> 12;
            return {
                /** @param {number} from @param {number} bytes */
                take(from, bytes){
                    const taken = [];
                    const last = Math.min(end, (from + Math.max(bytes, 1) - 1) >>> 12);
                    for (let page = Math.max(first, from >>> 12); page <= last; page++)
                    {
                        const at = stamps.get(page);
                        if (at !== undefined && at !== seen.get(page))
                        {
                            seen.set(page, at);
                            taken.push(page);
                        }
                    }
                    return taken;
                },
            };
        },
    };
};

test('the mirror\'s watches take what watches asking each page take, over seeded writes', ()=>{
    for (let seed = 1; seed <= 40; seed++)
    {
        let state = seed;
        const below = (/** @type {number} */ n)=>{
            state = (Math.imul(state, 1103515245) + 12345) >>> 0;
            return (state >>> 8) % n;
        };
        const mirror = createMirror();
        const reference = watchesAskingEachPage();
        /** @type {{ base: number, length: number, one: any, two: any }[]} */
        const watches = [];
        for (let step = 0; step < 300; step++)
        {
            const kind = below(4);
            if (kind === 0 || watches.length === 0)
            {
                // A buffer of a few pages to a few hundred, on or off a page.
                const base = below(1 << 12) * 4096 + (below(2) === 0 ? 0 : below(4096));
                const length = 1 + below(below(2) === 0 ? 1 << 14 : 3 << 20);
                watches.push({ base, length, one: mirror.watch(base, length),
                    two: reference.watch(base, length) });
            }
            else if (kind === 1)
            {
                const address = below(1 << 12) * 4096 + below(4096);
                const length = 1 + below(below(3) === 0 ? 1 << 18 : 300);
                mirror.write(address, new Uint8Array(length));
                reference.write(address, length);
            }
            else
            {
                const { base, length, one, two } = watches[below(watches.length)];
                const whole = below(3) === 0;
                const from = whole ? base : base + below(length);
                const bytes = whole ? length : 1 + below(base + length - from);
                assert.deepEqual(one.take(from, bytes), two.take(from, bytes),
                    `seed ${seed} step ${step}: ${bytes} bytes from ${from}`);
            }
        }
    }
});

/**
 * What a frame asked of the GPU, as text: an object the double made by its
 * id, bytes by their exact bits.
 *
 * @param {any} value @param {number} depth @returns {any}
 */
function plain(value, depth = 0){
    if (value === null || typeof value !== 'object')
    {
        return value;
    }
    if (ArrayBuffer.isView(value))
    {
        return [...new Uint8Array(value.buffer, value.byteOffset, value.byteLength)].join(',');
    }
    if (typeof value.id === 'string' && typeof value.kind === 'string' && depth > 0)
    {
        return value.id;
    }
    if (depth > 6)
    {
        return '...';
    }
    if (Array.isArray(value))
    {
        return value.map(item=>plain(item, depth + 1));
    }
    /** @type {Record<string, any>} */
    const out = {};
    for (const key of Object.keys(value).sort())
    {
        if (typeof value[key] !== 'function')
        {
            out[key] = plain(value[key], depth + 1);
        }
    }
    return out;
}

/**
 * Two frames of lit, textured draws through Direct3D 9 -- buffers and
 * textures written through their locks, one texture written again between
 * the frames -- and every call they asked of the GPU. `late` writes the
 * texture again after its unlock, through the pointer the lock gave, before
 * the draws that sample it.
 *
 * @param {(services: any) => any} make @param {boolean} [late]
 */
async function framesThrough(make, late = false){
    const gpu = createFakeDevice();
    const backend = createBackend({ device: gpu.device, queue: gpu.queue, presentTo: ()=>{},
        now: ()=>0 });
    const ram = new Uint8Array(4 << 20);
    let next = RAM_BASE + (2 << 20);
    const d3d = make({
        backend,
        readMemory: (/** @type {number} */ at, /** @type {number} */ length)=>
            ram.slice(at - RAM_BASE, at - RAM_BASE + length),
        writeMemory: (/** @type {number} */ at, /** @type {Uint8Array} */ bytes)=>
            ram.set(bytes, at - RAM_BASE),
        createSampler: (/** @type {any} */ descriptor)=>({ kind: 'sampler',
            id: `sampler-${JSON.stringify(descriptor)}`, descriptor }),
        allocate: (/** @type {number} */ bytes)=>{
            const at = next;
            next += bytes + 0x100;
            return at;
        },
    });
    /** @param {number} value */
    const ok = value=>assert.equal(value, D3D_OK);
    /** @type {{ device?: any }} */
    const out = {};
    ok(d3d.CreateDevice({
        swapEffect: D3DSWAPEFFECT.DISCARD, backBufferCount: 1, backBufferWidth: 32,
        backBufferHeight: 32, backBufferFormat: D3DFMT.X8R8G8B8, enableAutoDepthStencil: true,
        autoDepthStencilFormat: D3DFMT.D24S8,
    }, out));
    const device = out.device;
    const stride = 24;
    const fvf = FVF.XYZ | FVF.DIFFUSE | (1 << FVF.TEXCOUNT_SHIFT);
    /** @type {{ buffer?: any }} */
    const vertices = {};
    /** @type {{ buffer?: any }} */
    const indices = {};
    ok(device.CreateVertexBuffer(4 * stride, 0, fvf, D3DPOOL.MANAGED, vertices));
    ok(device.CreateIndexBuffer(12, 0, D3DFMT_INDEX.INDEX16, D3DPOOL.MANAGED, indices));
    /** @type {{ pBits?: number }} */
    const locked = {};
    ok(vertices.buffer.Lock(0, 0, locked, 0));
    const view = new DataView(ram.buffer, /** @type {number} */ (locked.pBits) - RAM_BASE);
    [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(([x, y], corner)=>{
        view.setFloat32(corner * stride, x, true);
        view.setFloat32(corner * stride + 4, y, true);
        view.setFloat32(corner * stride + 8, 0.5, true);
        view.setUint32(corner * stride + 12, 0xff8040c0 + corner, true);
        view.setFloat32(corner * stride + 16, corner & 1, true);
        view.setFloat32(corner * stride + 20, corner >> 1, true);
    });
    ok(vertices.buffer.Unlock());
    ok(indices.buffer.Lock(0, 0, locked, 0));
    new Uint16Array(ram.buffer, /** @type {number} */ (locked.pBits) - RAM_BASE, 6)
        .set([0, 1, 2, 2, 1, 3]);
    ok(indices.buffer.Unlock());
    /** @type {{ texture?: any }} */
    const texture = {};
    ok(device.CreateTexture(4, 4, 2, 0, D3DFMT.A8R8G8B8, D3DPOOL.MANAGED, texture));
    /** @param {number} level @param {number} value */
    const fill = (level, value)=>{
        /** @type {{ pBits?: number }} */
        const rect = {};
        ok(texture.texture.LockRect(level, rect, null, 0));
        const at = /** @type {number} */ (rect.pBits) - RAM_BASE;
        ram.fill(value, at, at + (64 >> (2 * level)));
        ok(texture.texture.UnlockRect(level));
        if (late)
        {
            ram.fill(value ^ 0xff, at, at + 16);
        }
    };
    fill(0, 0x30);
    fill(1, 0x60);
    ok(device.SetStreamSource(0, vertices.buffer, 0, stride));
    ok(device.SetIndices(indices.buffer));
    ok(device.SetFVF(fvf));
    ok(device.SetRenderState(D3DRS.LIGHTING, 0));
    ok(device.SetTexture(0, texture.texture));
    /** @type {string[]} */
    const frames = [];
    for (let frame = 0; frame < 2; frame++)
    {
        ok(device.BeginScene());
        ok(device.Clear(0, null, D3DCLEAR.TARGET | D3DCLEAR.ZBUFFER, 0xff000000 + frame, 1, 0));
        for (let index = 0; index < 4; index++)
        {
            const world = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
            world[12] = index / 4 - frame / 8;
            ok(device.SetTransform(D3DTS.WORLD, world));
            ok(device.DrawIndexedPrimitive(D3DPT.TRIANGLELIST, 0, 0, 4, 0, 2));
        }
        ok(device.EndScene());
        await device.Present();
        await device.idle();
        frames.push(JSON.stringify(plain(gpu.calls)));
        gpu.reset();
        fill(0, 0x90);
    }
    texture.texture.release();
    vertices.buffer.release();
    indices.buffer.release();
    assert.equal(device.release(), 0);
    return frames;
}

test('frames played from a record ask of the GPU what the device itself asked', async()=>{
    const direct = await framesThrough(createDirect3D9);
    const played = await framesThrough(services=>loopbackDirect3D(createDirect3D9, services));
    assert.equal(played.length, direct.length);
    played.forEach((frame, index)=>assert.ok(frame === direct[index],
        `frame ${index} asked the same`));
});

/**
 * A Direct3D 9 root whose calls cross a port to their played twin, as they
 * cross to a worker.
 *
 * @param {any} services
 */
function acrossAPort(services){
    const { port1, port2 } = new MessageChannel();
    const played = playedDirect3D(createDirect3D9, {
        ...services,
        writeMemory: (/** @type {number} */ address, /** @type {Uint8Array} */ bytes)=>
            port2.postMessage({ type: 'wrote', writes: [{ address, bytes: bytes.slice() }] }),
    });
    const receiver = createReceiver({
        played,
        post: (message, transfer)=>port2.postMessage(message, transfer ?? []),
    });
    port2.onmessage = event=>receiver.receive(event.data);
    const sender = createSender({
        post: (message, transfer)=>port1.postMessage(message, transfer),
        on: { wrote: services.writeMemory },
    });
    port1.onmessage = event=>sender.receive(event.data);
    const root = recordedDirect3D(createDirect3D9, services, sender);
    return Object.assign(root, { close: ()=>{
        port1.close();
        port2.close();
    } });
}

test('frames whose calls cross a port ask of the GPU what the device itself asked', async()=>{
    const direct = await framesThrough(createDirect3D9);
    /** @type {any} */
    let made = null;
    const played = await framesThrough(services=>(made = acrossAPort(services)));
    made.close();
    assert.equal(played.length, direct.length);
    played.forEach((frame, index)=>assert.ok(frame === direct[index],
        `frame ${index} asked the same`));
});

test('a texture written after its unlock, before a draw samples it, is drawn as written', async()=>{
    const direct = await framesThrough(createDirect3D9, true);
    const played = await framesThrough(services=>loopbackDirect3D(createDirect3D9, services), true);
    played.forEach((frame, index)=>assert.ok(frame === direct[index],
        `frame ${index} asked the same`));
});

test('a buffer locked a few bytes at a time sends those bytes at each unlock, not the rest of it',
    ()=>{
        // A dynamic vertex buffer a program fills a draw's worth at a time: an
        // unlock sent everything from the lock's address to the buffer's end.
        const ram = new Uint8Array(4 << 20);
        let next = RAM_BASE + (1 << 20);
        const services = {
            readMemory: (/** @type {number} */ at, /** @type {number} */ length)=>
                ram.slice(at - RAM_BASE, at - RAM_BASE + length),
            allocate: (/** @type {number} */ bytes)=>{
                const at = next;
                next += bytes + 0x100;
                return at;
            },
        };
        let sent = 0;
        const played = playedDirect3D(createDirect3D9, { ...services, readMemory: true });
        const sender = createSender({
            post: message=>{
                sent += message.buffer.byteLength;
                played.read(message.buffer, call=>{
                    played.play(call);
                });
            },
            later: flush=>flush(),
        });
        const d3d = recordedDirect3D(createDirect3D9, services, sender);
        /** @type {{ device?: any }} */
        const out = {};
        assert.equal(d3d.CreateDevice({ swapEffect: D3DSWAPEFFECT.DISCARD, backBufferCount: 1,
            backBufferWidth: 8, backBufferHeight: 8, backBufferFormat: D3DFMT.X8R8G8B8 }, out),
        D3D_OK);
        /** @type {{ buffer?: any }} */
        const made = {};
        assert.equal(out.device.CreateVertexBuffer(1 << 20, 0x200, 0, D3DPOOL.DEFAULT, made),
            D3D_OK);
        const before = sent;
        for (let lock = 0; lock < 50; lock++)
        {
            /** @type {{ pBits?: number }} */
            const locked = {};
            assert.equal(made.buffer.Lock(lock * 256, 256, locked, 0), D3D_OK);
            ram.fill(lock + 1, /** @type {number} */ (locked.pBits) - RAM_BASE,
                /** @type {number} */ (locked.pBits) - RAM_BASE + 256);
            assert.equal(made.buffer.Unlock(), D3D_OK);
        }
        assert.ok(sent - before < 50 * 256 * 2,
            `${sent - before} bytes sent for 50 locks of 256`);
    });

test('a dynamic buffer unlocked and drawn from in one pause is compared once; apart, at both',
    ()=>{
        // A host entry settles the buffers the guest let go of and then plays
        // the ring's draws, the program stopped between them: the draws found
        // again what the unlock had just compared.
        const ram = new Uint8Array(4 << 20);
        let next = RAM_BASE + (1 << 20);
        const services = {
            readMemory: (/** @type {number} */ at, /** @type {number} */ length)=>
                ram.slice(at - RAM_BASE, at - RAM_BASE + length),
            allocate: (/** @type {number} */ bytes)=>{
                const at = next;
                next += bytes + 0x100;
                return at;
            },
        };
        const played = playedDirect3D(createDirect3D9, { ...services, readMemory: true });
        const sender = createSender({
            post: message=>{
                played.read(message.buffer, call=>{
                    played.play(call);
                });
            },
            later: flush=>flush(),
        });
        const d3d = recordedDirect3D(createDirect3D9, services, sender);
        /** @param {number} value */
        const ok = value=>assert.equal(value, D3D_OK);
        /** @type {{ device?: any }} */
        const out = {};
        ok(d3d.CreateDevice({ swapEffect: D3DSWAPEFFECT.DISCARD, backBufferCount: 1,
            backBufferWidth: 8, backBufferHeight: 8, backBufferFormat: D3DFMT.X8R8G8B8 }, out));
        const device = out.device;
        const stride = 16;
        /** @type {{ buffer?: any }} */
        const made = {};
        ok(device.CreateVertexBuffer(64 * stride, 0x200, FVF.XYZ | FVF.DIFFUSE, D3DPOOL.DEFAULT,
            made));
        ok(device.SetStreamSource(0, made.buffer, 0, stride));
        ok(device.SetFVF(FVF.XYZ | FVF.DIFFUSE));
        ok(device.BeginScene());
        /** @param {number} value */
        const write = value=>{
            /** @type {{ pBits?: number }} */
            const locked = {};
            ok(made.buffer.Lock(0, 0, locked, 0));
            const at = /** @type {number} */ (locked.pBits) - RAM_BASE;
            ram.fill(value, at, at + 3 * stride);
            ok(made.buffer.Unlock());
        };
        const draw = ()=>ok(device.DrawPrimitive(D3DPT.TRIANGLELIST, 0, 1));
        // The first draw sends the buffer whole; from then on what differs.
        write(1);
        draw();
        const compared = ()=>sender.shippedBytes().compared;
        const unlocked = ()=>sender.shippedBytes().buffers;
        let before = compared();
        const sentBefore = unlocked();
        write(2);
        // The last call's draw compared these bytes before the program wrote them.
        assert.equal(unlocked() - sentBefore, 3 * stride, 'apart: the unlock sends what it wrote');
        draw();
        assert.equal(compared() - before, 3 * stride, 'apart: the draw compares again');
        before = compared();
        device.whileStill(()=>{
            write(3);
            draw();
        });
        assert.equal(compared() - before, 0, 'in a pause: once, at the unlock');
        // What the draw reads arrived all the same.
        before = compared();
        write(4);
        draw();
        assert.equal(compared() - before, 3 * stride, 'and apart again after it');
    });

test('an event query answers on the program\'s side; an occlusion query asks the renderer', ()=>{
    // An event is signalled once its end is issued, as the device without a
    // renderer signals it: a round trip only made the program wait for the
    // played side to catch up.
    let posts = 0;
    const played = playedDirect3D(createDirect3D9, {});
    const sender = createSender({
        post: message=>{
            posts++;
            played.read(message.buffer, call=>{
                played.play(call);
            });
        },
        later: flush=>flush(),
    });
    const d3d = recordedDirect3D(createDirect3D9, {}, sender);
    /** @type {{ device?: any }} */
    const out = {};
    assert.equal(d3d.CreateDevice({ swapEffect: D3DSWAPEFFECT.DISCARD, backBufferCount: 1,
        backBufferWidth: 8, backBufferHeight: 8, backBufferFormat: D3DFMT.X8R8G8B8 }, out),
    D3D_OK);
    /** @type {{ query?: any }} */
    const made = {};
    assert.equal(out.device.CreateQuery(D3DQUERYTYPE.EVENT, made), D3D_OK);
    assert.equal(made.query.Issue(1), D3D_OK);
    /** @type {{ value?: number }} */
    const signalled = {};
    const answer = made.query.GetData(signalled, 4, 1);
    assert.equal(answer, D3D_OK, 'answered at once, not a promise');
    assert.equal(signalled.value, 1);
    assert.equal(sender.waits().GetData, undefined, 'nothing waited for');
    assert.ok(posts > 0);
    assert.equal(answeredByRenderer({ type: D3DQUERYTYPE.EVENT }, 'GetData', []), false);
    assert.equal(answeredByRenderer({ type: D3DQUERYTYPE.OCCLUSION }, 'GetData', []), true);
    assert.equal(answeredByRenderer({}, 'GetRenderTargetData', []), true);
});

test('a getter of plain state answers on the program\'s side and sends nothing', ()=>{
    // The shadow block reads states back after a state block is applied, a
    // getter a state: each was recorded and played for an answer the recording
    // device already had.
    let sent = 0;
    const played = playedDirect3D(createDirect3D9, {});
    const sender = createSender({
        post: message=>{
            sent += message.buffer.byteLength;
            played.read(message.buffer, call=>{
                played.play(call);
            });
        },
        later: flush=>flush(),
    });
    const d3d = recordedDirect3D(createDirect3D9, {}, sender);
    /** @type {{ device?: any }} */
    const out = {};
    assert.equal(d3d.CreateDevice({ swapEffect: D3DSWAPEFFECT.DISCARD, backBufferCount: 1,
        backBufferWidth: 8, backBufferHeight: 8, backBufferFormat: D3DFMT.X8R8G8B8 }, out),
    D3D_OK);
    const device = out.device;
    assert.equal(device.SetRenderState(D3DRS.LIGHTING, 0), D3D_OK);
    const before = sent;
    assert.ok(before > 0);
    /** @type {{ value?: number }} */
    const value = {};
    for (let read = 0; read < 10; read++)
    {
        assert.equal(device.GetRenderState(D3DRS.LIGHTING, value), D3D_OK);
    }
    assert.equal(value.value, 0, 'the state as set');
    /** @type {{ matrix?: ArrayLike<number> }} */
    const matrix = {};
    assert.equal(device.GetTransform(D3DTS.WORLD, matrix), D3D_OK);
    // What the shadow block mirrors after every entry of the host's.
    assert.equal(typeof device.ringState().drawable, 'number');
    assert.equal(sent, before, 'nothing sent for the reads');
    assert.equal(device.SetRenderState(D3DRS.LIGHTING, 1), D3D_OK);
    assert.ok(sent > before, 'a set still is');
});

test('a run of the command ring is one call recorded, and the played device makes every call in it',
    ()=>{
        /** @type {any[]} */
        const playedDevices = [];
        const played = playedDirect3D((/** @type {any} */ services)=>{
            const root = createDirect3D9(services);
            const create = root.CreateDevice.bind(root);
            /** @param {any} parameters @param {{ device?: any }} out @param {any[]} rest */
            root.CreateDevice = (parameters, out, ...rest)=>{
                const hr = create(parameters, out, ...rest);
                playedDevices.push(out.device);
                return hr;
            };
            return root;
        }, {});
        /** @type {string[]} */
        const names = [];
        const sender = createSender({
            post: message=>{
                played.read(message.buffer, call=>{
                    names.push(String(call.m));
                    played.play(call);
                });
            },
            later: flush=>flush(),
        });
        const d3d = recordedDirect3D(createDirect3D9, {}, sender);
        /** @type {{ device?: any }} */
        const out = {};
        assert.equal(d3d.CreateDevice({ swapEffect: D3DSWAPEFFECT.DISCARD, backBufferCount: 1,
            backBufferWidth: 8, backBufferHeight: 8, backBufferFormat: D3DFMT.X8R8G8B8 }, out),
        D3D_OK);
        const one = new Uint32Array(new Float32Array([1]).buffer)[0];
        const records = new Uint32Array([
            commandSlot('SetViewport'), 36, 0, 1, 2, 4, 5, 0, one,
            commandSlot('LightEnable'), 16, 3, 1,
        ]);
        names.length = 0;
        assert.equal(out.device.commands(new Uint8Array(records.buffer)), 2);
        out.device.BeginScene();
        /** @type {{ viewport?: any }} */
        const viewport = {};
        assert.equal(playedDevices[0].GetViewport(viewport), D3D_OK);
        assert.deepEqual(viewport.viewport, { X: 1, Y: 2, Width: 4, Height: 5, MinZ: 0, MaxZ: 1 });
        /** @type {{ enabled?: number }} */
        const enabled = {};
        assert.equal(playedDevices[0].GetLightEnable(3, enabled), D3D_OK);
        assert.ok(enabled.enabled);
        assert.deepEqual(names.filter(name=>name !== 'BeginScene'), ['commands'],
            'one call crossed for the two');
        // The program's side made them too: its answers are its own.
        assert.equal(out.device.GetViewport(viewport), D3D_OK);
        assert.equal(viewport.viewport.Width, 4);
    });

test('an occlusion count is asked of the renderer without waiting, and taken when it comes',
    async t=>{
        // A driver answers S_FALSE until the GPU has counted and the program
        // polls; waiting for the renderer instead held the program for the
        // replay of everything before the ask, every frame.
        const d3d = acrossAPort({ writeMemory: ()=>{} });
        t.after(()=>d3d.close());
        /** @type {{ device?: any }} */
        const out = {};
        assert.equal(d3d.CreateDevice({ swapEffect: D3DSWAPEFFECT.DISCARD, backBufferCount: 1,
            backBufferWidth: 8, backBufferHeight: 8, backBufferFormat: D3DFMT.X8R8G8B8 }, out),
        D3D_OK);
        /** @type {{ query?: any }} */
        const made = {};
        assert.equal(out.device.CreateQuery(D3DQUERYTYPE.OCCLUSION, made), D3D_OK);
        const D3DISSUE_END = 1;
        const D3DISSUE_BEGIN = 2;
        const S_FALSE = 1;
        assert.equal(made.query.Issue(D3DISSUE_BEGIN), D3D_OK);
        assert.equal(made.query.Issue(D3DISSUE_END), D3D_OK);
        /** @type {{ value?: number }} */
        const count = {};
        assert.equal(made.query.GetData(count, 4, 0), S_FALSE, 'asked, not waited for');
        assert.equal(made.query.GetData(count, 4, 0), S_FALSE, 'still on its way');
        let answer = S_FALSE;
        for (let tries = 0; tries < 50 && answer === S_FALSE; tries++)
        {
            await new Promise(resolve=>setTimeout(resolve, 5));
            answer = made.query.GetData(count, 4, 0);
        }
        assert.equal(answer, D3D_OK, 'the count, once the renderer has answered');
        assert.equal(count.value, 0);
        assert.equal(made.query.Issue(D3DISSUE_END), D3D_OK);
        assert.equal(made.query.GetData(count, 4, 0), S_FALSE, 'a new measurement is asked anew');
    });

test('a caller is told an occlusion count as it comes, its own and those beside it, so the guest'
    + ' may answer the polls till then', async t=>{
    const d3d = acrossAPort({ writeMemory: ()=>{} });
    t.after(()=>d3d.close());
    /** @type {{ device?: any }} */
    const out = {};
    assert.equal(d3d.CreateDevice({ swapEffect: D3DSWAPEFFECT.DISCARD, backBufferCount: 1,
        backBufferWidth: 8, backBufferHeight: 8, backBufferFormat: D3DFMT.X8R8G8B8 }, out),
    D3D_OK);
    const D3DISSUE_END = 1;
    const D3DISSUE_BEGIN = 2;
    const S_FALSE = 1;
    /** @type {(number | null)[][]} */
    const told = [[], []];
    const queries = [0, 1].map(index=>{
        /** @type {{ query?: any }} */
        const made = {};
        assert.equal(out.device.CreateQuery(D3DQUERYTYPE.OCCLUSION, made), D3D_OK);
        made.query.whenCounted = (/** @type {number | null} */ count)=>told[index].push(count);
        assert.equal(made.query.Issue(D3DISSUE_BEGIN), D3D_OK);
        assert.equal(made.query.Issue(D3DISSUE_END), D3D_OK);
        return made.query;
    });
    /** @type {{ value?: number }} */
    const count = {};
    assert.equal(queries[0].countsLater, undefined, 'nothing asked yet');
    assert.equal(queries[0].GetData(count, 4, 0), S_FALSE);
    assert.equal(queries[0].countsLater, true, 'asked: its count will be told');
    for (let tries = 0; tries < 50 && told[0].length === 0; tries++)
    {
        await new Promise(resolve=>setTimeout(resolve, 5));
    }
    assert.deepEqual(told, [[0], [0]], 'the asked one\'s and the one beside it, once each');
});

test('the counts the renderer holds come beside one query\'s answer, each for its own measurement',
    async t=>{
        // A program that waits on its queries one after another crossed to the
        // played side and back for each, where the GPU had counted them all
        // in one read: two hundred round trips a frame.
        const d3d = acrossAPort({ writeMemory: ()=>{} });
        t.after(()=>d3d.close());
        /** @type {{ device?: any }} */
        const out = {};
        assert.equal(d3d.CreateDevice({ swapEffect: D3DSWAPEFFECT.DISCARD, backBufferCount: 1,
            backBufferWidth: 8, backBufferHeight: 8, backBufferFormat: D3DFMT.X8R8G8B8 }, out),
        D3D_OK);
        const D3DISSUE_END = 1;
        const D3DISSUE_BEGIN = 2;
        const S_FALSE = 1;
        const queries = [0, 1, 2].map(()=>{
            /** @type {{ query?: any }} */
            const made = {};
            assert.equal(out.device.CreateQuery(D3DQUERYTYPE.OCCLUSION, made), D3D_OK);
            assert.equal(made.query.Issue(D3DISSUE_BEGIN), D3D_OK);
            assert.equal(made.query.Issue(D3DISSUE_END), D3D_OK);
            return made.query;
        });
        /** @type {{ value?: number }} */
        const count = {};
        assert.equal(queries[0].GetData(count, 4, 0), S_FALSE, 'asked');
        // The third's measurement closed again after the ask: the count the
        // answer brings for it is of the one before.
        assert.equal(queries[2].Issue(D3DISSUE_END), D3D_OK);
        let answer = S_FALSE;
        for (let tries = 0; tries < 50 && answer === S_FALSE; tries++)
        {
            await new Promise(resolve=>setTimeout(resolve, 5));
            answer = queries[0].GetData(count, 4, 0);
        }
        assert.equal(answer, D3D_OK);
        /** @type {{ value?: number }} */
        const beside = {};
        assert.equal(queries[1].GetData(beside, 4, 0), D3D_OK, 'came beside the first');
        assert.equal(beside.value, 0);
        assert.equal(queries[2].GetData(beside, 4, 0), S_FALSE,
            'a count of a measurement closed since is not this one\'s');
    });

test('the counts the renderer holds come beside one query\'s answer, each for its own measurement',
    async t=>{
        // A program that waits on its queries one after another crossed to the
        // played side and back for each, where the GPU had counted them all
        // in one read: two hundred round trips a frame.
        const d3d = acrossAPort({ writeMemory: ()=>{} });
        t.after(()=>d3d.close());
        /** @type {{ device?: any }} */
        const out = {};
        assert.equal(d3d.CreateDevice({ swapEffect: D3DSWAPEFFECT.DISCARD, backBufferCount: 1,
            backBufferWidth: 8, backBufferHeight: 8, backBufferFormat: D3DFMT.X8R8G8B8 }, out),
        D3D_OK);
        const D3DISSUE_END = 1;
        const D3DISSUE_BEGIN = 2;
        const S_FALSE = 1;
        const queries = [0, 1, 2].map(()=>{
            /** @type {{ query?: any }} */
            const made = {};
            assert.equal(out.device.CreateQuery(D3DQUERYTYPE.OCCLUSION, made), D3D_OK);
            assert.equal(made.query.Issue(D3DISSUE_BEGIN), D3D_OK);
            assert.equal(made.query.Issue(D3DISSUE_END), D3D_OK);
            return made.query;
        });
        /** @type {{ value?: number }} */
        const count = {};
        assert.equal(queries[0].GetData(count, 4, 0), S_FALSE, 'asked');
        // The third's measurement closed again after the ask: the count the
        // answer brings for it is of the one before.
        assert.equal(queries[2].Issue(D3DISSUE_END), D3D_OK);
        let answer = S_FALSE;
        for (let tries = 0; tries < 50 && answer === S_FALSE; tries++)
        {
            await new Promise(resolve=>setTimeout(resolve, 5));
            answer = queries[0].GetData(count, 4, 0);
        }
        assert.equal(answer, D3D_OK);
        /** @type {{ value?: number }} */
        const beside = {};
        assert.equal(queries[1].GetData(beside, 4, 0), D3D_OK, 'came beside the first');
        assert.equal(beside.value, 0);
        assert.equal(queries[2].GetData(beside, 4, 0), S_FALSE,
            'a count of a measurement closed since is not this one\'s');
    });

test('a surface a read-back is still filling keeps its memory until the pixels have landed',
    async()=>{
        // The program let go of a system-memory surface right after asking
        // for a target's pixels in it: given back at once, the heap handed the
        // span on before the played side's pixels came, which wrote them over
        // whatever had it by then.
        const ram = new Uint8Array(1 << 20);
        let next = RAM_BASE;
        /** @type {Map<number, number>} */
        const live = new Map();
        /** @type {string[]} */
        const strays = [];
        const gpu = createFakeDevice();
        const services = {
            // A renderer that reads back, so the pixels come from the played side.
            backend: createBackend({ device: gpu.device, queue: gpu.queue, presentTo: ()=>{},
                now: ()=>0 }),
            createSampler: (/** @type {any} */ descriptor)=>({ kind: 'sampler',
                id: `sampler-${JSON.stringify(descriptor)}`, descriptor }),
            readMemory: (/** @type {number} */ at, /** @type {number} */ length)=>
                ram.slice(at - RAM_BASE, at - RAM_BASE + length),
            writeMemory: (/** @type {number} */ at, /** @type {Uint8Array} */ bytes)=>{
                const owned = [...live].some(([base, size])=>at >= base
                    && at + bytes.length <= base + size);
                if (!owned)
                {
                    strays.push(`0x${at.toString(16)}+${bytes.length}`);
                }
                ram.set(bytes, at - RAM_BASE);
            },
            allocate: (/** @type {number} */ bytes)=>{
                const at = next;
                next += (bytes + 0xfff) & ~0xfff;
                live.set(at, bytes);
                return at;
            },
            free: (/** @type {number} */ at)=>{
                live.delete(at);
            },
        };
        const d3d = acrossAPort(services);
        try
        {
            /** @type {{ device?: any }} */
            const out = {};
            assert.equal(d3d.CreateDevice({ swapEffect: D3DSWAPEFFECT.DISCARD, backBufferCount: 1,
                backBufferWidth: 8, backBufferHeight: 8, backBufferFormat: D3DFMT.X8R8G8B8 }, out),
            D3D_OK);
            const device = out.device;
            /** @type {{ surface?: any }} */
            const back = {};
            assert.equal(device.GetBackBuffer(0, 0, 0, back), D3D_OK);
            const before = new Set(live.keys());
            /** @type {{ surface?: any }} */
            const offscreen = {};
            assert.equal(device.CreateOffscreenPlainSurface(8, 8, D3DFMT.X8R8G8B8,
                D3DPOOL.SYSTEMMEM, offscreen), D3D_OK);
            const base = [...live.keys()].find(at=>!before.has(at));
            assert.ok(base !== undefined, 'the surface has memory of its own');
            assert.equal(await device.GetRenderTargetData(back.surface, offscreen.surface), D3D_OK);
            assert.equal(offscreen.surface.release(), 0);
            assert.ok(live.has(base), 'still the surface\'s while its pixels are on the way');
            // The played side's renderer reads back when it gets to it.
            for (let waited = 0; waited < 200 && live.has(base); waited++)
            {
                await new Promise(resolve=>setTimeout(resolve, 10));
            }
            assert.equal(live.has(base), false, 'given back once they have come');
            assert.deepEqual(strays, [], 'nothing written where nothing is held');
        }
        finally
        {
            d3d.close();
        }
    });

test('a batch that looks at the objects at zero says how long the look took', ()=>{
    // The look is timed for the worker's account of its time: without a
    // present it comes every sixty-fourth batch, and only that batch answers.
    const { root, play, swept } = toyAcross(false);
    for (let batch = 0; batch < 64; batch++)
    {
        /** @type {{ thing?: any }} */
        const out = {};
        root.CreateThing(out);
        play();
    }
    assert.equal(swept.length, 64);
    assert.deepEqual(swept.slice(0, 63), new Array(63).fill(undefined));
    assert.equal(typeof swept[63], 'number');
    assert.ok(/** @type {number} */ (swept[63]) >= 0);
});
