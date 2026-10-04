/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loopbackDirect3D } from './loopback.js';
import { createMirror } from './replay.js';
import { answeredByRenderer, playedDirect3D, recordedDirect3D } from './direct3d.js';
import { createReceiver, createSender } from './channel.js';
import { createBorrower, createLendingBuffers } from './lending.js';
import { D3DFMT, D3DPOOL, D3DSWAPEFFECT, D3D_OK } from '../d3d9/constants.js';
import { D3DCLEAR, D3DFMT_INDEX, D3DPT, D3DRS, D3DTS } from '../d3d8/constants.js';
import { D3DQUERYTYPE, createDirect3D9 } from '../d3d9/device.js';
import { commandSlot } from '../d3d9/commands.js';
import { createReferenceCount } from '../d3d9/resources.js';
import { createBackend } from '../webgpu/backend.js';
import { createFakeDevice } from '../webgpu/internal/fake-device.js';
import { FVF } from '../webgpu/internal/vertexformat.js';

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
        const side = { services, played: services.backend !== undefined, seen: /** @type {any[]} */ ([]) };
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
            CreateCounted(out){
                const count = createReferenceCount({ onLastRef: ()=>side.seen.push('gone') });
                out.thing = {
                    counter: count,
                    get refCount(){
                        return count.value;
                    },
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
 * to the played side rather than copied.
 *
 * @param {boolean} lend
 */
function toyAcross(lend){
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
    const receiver = createReceiver({ played, post: ()=>{} });
    /** @type {any[]} */
    const sent = [];
    const sender = createSender({ post: message=>sent.push(message), later: ()=>{},
        lending: lend ? { ...buffers, memory: ram } : null });
    const root = recordedDirect3D(toy(sides), services, sender);
    return {
        root, ram, sender,
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
            writes: 4 }, `lent: ${lend}`);
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

test('a lock taken to read sends nothing back at its unlock; one taken to write does', ()=>{
    const { root, ram, played } = toyLoop();
    /** @type {{ thing?: any }} */
    const out = {};
    root.CreateThing(out);
    const thing = out.thing;
    /** @type {{ pBits?: number }} */
    const locked = {};
    const D3DLOCK_READONLY = 0x10;
    assert.equal(thing.LockRect(locked, null, D3DLOCK_READONLY | 0x800), D3D_OK);
    ram.set([5, 6, 7, 8], /** @type {number} */ (locked.pBits));
    assert.equal(thing.UnlockRect(), D3D_OK);
    thing.Peek();
    assert.deepEqual(played.seen, [[0, 0, 0, 0]], 'read, not written: nothing went');
    assert.equal(thing.LockRect(locked, null, 0), D3D_OK);
    assert.equal(thing.UnlockRect(), D3D_OK);
    thing.Peek();
    assert.deepEqual(played.seen[1], [5, 6, 7, 8], 'written: the bytes went');

    ram.set([9, 9, 9, 9], /** @type {number} */ (locked.pBits));
    assert.equal(thing.LockRectAnswered(locked, null, D3DLOCK_READONLY), D3D_OK);
    assert.equal(thing.UnlockRect(), D3D_OK);
    thing.Peek();
    assert.deepEqual(played.seen[2], [5, 6, 7, 8],
        'read, with no address on record: still nothing went');
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
