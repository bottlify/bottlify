/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The texture locks' contract, as a gate: a draw samples the texels its
 * texture held when the program made it, and an update carries what the
 * source held when the program asked for it. A lock and an unlock of a level
 * taken in the guest are remembered and replayed at the host's next entry,
 * and a dirty rectangle or box goes into the command ring with the draws --
 * so the guest path is right only if, whatever the program locked, wrote,
 * marked and drew in between, every answer, every draw and every update is
 * what it would have been with each call made on the host as it came.
 *
 * The program here is generated over a managed texture a draw samples, a
 * texture and a volume texture in system memory each updated into its twin
 * in the default pool: locks of a level through the texture and through its
 * surface, of all of it or a rectangle or box, with and without a dirty
 * update, for reading, refused; dirty rectangles and boxes, refused ones
 * among them; draws, updates, and other calls reaching the host, one while a
 * lock is held. It runs through the guest routines on the processor, with
 * the host's entries made as the seams make them, and with every call made
 * on the device; and again with a device that lends what it sends, where
 * the guest takes no lock of a level whose bytes may be lent.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCorkHost } from '../../cpu/internal/cork-host.js';
import * as cork from '../../../../../cork/src/index.js';
import {
    commandCode, createLevelLocks, createShadow, lockLevelCode, settledAfter, unlockLevelCode,
} from './shadow.js';
import { COMMAND_MIRRORS as MIRRORS_8 } from './d3d8.js';
import { COMMAND_MIRRORS as MIRRORS_9 } from './d3d9.js';
import { D3D8_COMMANDS } from '../d3d8/commands.js';
import * as D3D9_COMMANDS from '../d3d9/commands.js';
import { createDirect3D8 } from '../d3d8/device.js';
import { createDirect3D9 } from '../d3d9/device.js';

const PROGRAM = 0x8000;
/** Each routine, and the halt it leaves for the host through. */
const ROUTINES = 0x9000;
const ROUTINE_BYTES = 0x200;
const TRAPS = 0x8800;
/** The interfaces: a pointer, and the block one word on. */
const INTERFACES = 0xb000;
const OUT = 0xb800;
const BOX = 0xb900;
const HEAP = 0x200000;
const STACK = 0x100000;

const D3D_OK = 0;
const D3DFMT_A8R8G8B8 = 21;
const D3DFMT_X8R8G8B8 = 22;
const D3DFMT_D24S8 = 75;
const D3DPOOL_DEFAULT = 0;
const D3DPOOL_MANAGED = 1;
const D3DPOOL_SYSTEMMEM = 2;
const D3DSWAPEFFECT_DISCARD = 1;
const D3DLOCK_READONLY = 0x10;
const D3DLOCK_NO_DIRTY_UPDATE = 0x8000;
const D3DPT_TRIANGLELIST = 4;
const FVF = 0x042;
const STRIDE = 16;

/** The routines, in the order they are placed. */
const NAMES = /** @type {const} */ (['lockTexture', 'unlockTexture', 'lockSurface',
    'unlockSurface', 'lockVolume', 'unlockVolume', 'dirtyRect', 'dirtyBox', 'draw']);
/** @param {typeof NAMES[number]} name */
const routineAt = name=>ROUTINES + NAMES.indexOf(name) * ROUTINE_BYTES;
/** @param {typeof NAMES[number]} name */
const trapAt = name=>TRAPS + NAMES.indexOf(name) * 16;
/** The objects' interfaces. */
const OBJECTS = /** @type {const} */ (['device', 'managed', 'surface', 'system', 'volume']);
/** @param {typeof OBJECTS[number]} name */
const interfaceOf = name=>INTERFACES + OBJECTS.indexOf(name) * 16;

const MEMORY = 8 * 1024 * 1024;
/** @type {ReturnType<typeof createCorkHost> | null} */
let shared = null;
/** The processor, its memory as new. */
const reused = ()=>{
    if (shared)
    {
        shared.writePhysical(0, new Uint8Array(MEMORY));
        return shared;
    }
    shared = createCorkHost({
        memorySize: MEMORY, trapPort: 0xb077, entryVector: 0x7000,
        initialStack: STACK, engine: cork, cork: {},
    });
    return shared;
};

/** @param {number} value @returns {number[]} */
const u32 = value=>[
    value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff,
];

/** A small seeded generator, so a failure names the seed that makes it. @param {number} seed */
const random = seed=>{
    let state = seed >>> 0 || 1;
    return (/** @type {number} */ below)=>{
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        return (state >>> 0) % below;
    };
};

/** FNV-1a of some bytes, as hex: what a draw or an update saw, told apart. @param {Uint8Array} bytes */
const digest = bytes=>{
    let hash = 0x811c9dc5;
    for (const byte of bytes)
    {
        hash = Math.imul(hash ^ byte, 0x01000193);
    }
    return (hash >>> 0).toString(16);
};

/**
 * @typedef {{ left: number, top: number, right: number, bottom: number,
 *     front: number, back: number }} Box
 * @typedef {'managed' | 'surface' | 'system' | 'volume'} Target
 * @typedef {{ kind: 'lock', on: Target, level: number, box: Box | null, flags: number,
 *         fill: number, entry: boolean }
 *     | { kind: 'dirty', on: 'system' | 'volume', box: Box | null }
 *     | { kind: 'update', on: 'system' | 'volume' }
 *     | { kind: 'draw' } | { kind: 'entry' }} Step
 */

/** The top levels' extents: two levels each. */
const EXTENT = { managed: [16, 16, 1], surface: [16, 16, 1], system: [16, 16, 1],
    volume: [8, 8, 4] };

/**
 * A box of a level of this extent: within it, mostly; all of it as none; and
 * now and then one empty or past an edge, which the guest leaves to the host.
 *
 * @param {(below: number) => number} next @param {number[]} extent @param {number} level
 * @returns {Box | null}
 */
const boxOf = (next, extent, level)=>{
    const [width, height, depth] = extent.map(side=>Math.max(1, side >> level));
    const roll = next(10);
    if (roll === 0)
    {
        return null;
    }
    /** @param {number} side */
    const span = side=>{
        const from = next(side);
        return [from, from + 1 + next(side - from)];
    };
    const [left, right] = span(width);
    const [top, bottom] = span(height);
    const [front, back] = depth > 1 ? span(depth) : [0, 1];
    if (roll === 1)
    {
        return { left, top, right: right + 1 + next(2), bottom, front, back };
    }
    if (roll === 2)
    {
        return { left: right, top, right, bottom, front, back };
    }
    return { left, top, right, bottom, front, back };
};

/** @param {number} seed @param {number} count @returns {Step[]} */
function generate(seed, count){
    const next = random(seed);
    /** @type {Step[]} */
    const steps = [];
    const targets = /** @type {Target[]} */ (['managed', 'surface', 'system', 'volume']);
    while (steps.length < count)
    {
        const roll = next(12);
        if (roll < 5)
        {
            const on = targets[next(4)];
            // A surface is the managed texture's top level, reached as itself.
            const level = on === 'surface' ? 0 : next(2);
            steps.push({ kind: 'lock', on, level, box: boxOf(next, EXTENT[on], level),
                flags: [0, 0, D3DLOCK_NO_DIRTY_UPDATE, D3DLOCK_NO_DIRTY_UPDATE,
                    D3DLOCK_READONLY][next(5)],
                fill: 1 + next(250), entry: next(6) === 0 });
        }
        else if (roll < 7)
        {
            const on = next(2) === 0 ? 'system' : 'volume';
            steps.push({ kind: 'dirty', on, box: boxOf(next, EXTENT[on], 0) });
        }
        else if (roll < 9)
        {
            steps.push({ kind: 'draw' });
        }
        else if (roll < 11)
        {
            steps.push({ kind: 'update', on: next(2) === 0 ? 'system' : 'volume' });
        }
        else
        {
            steps.push({ kind: 'entry' });
        }
    }
    return steps;
}

/**
 * @typedef {{ name: string, create: (services: object) => any,
 *     bind: (device: any, buffer: any) => void, commands: any,
 *     mirrors: Record<string, any[]>, twinCopies: boolean }} Version
 */

/** @type {Version[]} */
const VERSIONS = [
    {
        name: 'Direct3D 8',
        create: services=>createDirect3D8(services),
        bind: (device, buffer)=>{
            assert.equal(device.SetStreamSource(0, buffer, STRIDE), D3D_OK);
            assert.equal(device.SetVertexShader(FVF), D3D_OK);
        },
        commands: D3D8_COMMANDS,
        mirrors: MIRRORS_8,
        twinCopies: true,
    },
    {
        name: 'Direct3D 9',
        create: services=>createDirect3D9(services),
        bind: (device, buffer)=>{
            assert.equal(device.SetStreamSource(0, buffer, 0, STRIDE), D3D_OK);
            assert.equal(device.SetFVF(FVF), D3D_OK);
        },
        commands: D3D9_COMMANDS,
        mirrors: MIRRORS_9,
        twinCopies: false,
    },
];

/**
 * A device over the processor's memory, its textures, and what was seen:
 * each draw the managed texture's levels as the renderer holds them -- copied
 * out of guest memory at each unlock that may have written -- and each
 * update the levels it carried into.
 *
 * @param {Version} version @param {boolean} [processor]  memory a processor runs on
 */
function machine(version, processor = true){
    // Every call on the device needs memory and no processor; the routines one
    // processor, its memory cleared for each run -- one made for each, hundreds
    // of them, is more than a run of the tests can hold at once.
    const plain = new Uint8Array(processor ? 0 : MEMORY);
    const host = processor
        ? reused()
        : {
            /** @param {number} at @param {number} length */
            readPhysical: (at, length)=>plain.subarray(at, at + length),
            /** @param {number} at @param {Uint8Array} bytes */
            writePhysical: (at, bytes)=>plain.set(bytes, at),
        };
    host.writePhysical(0x7000, new Uint8Array(u32(PROGRAM)));
    let heap = HEAP;
    /** @param {number} bytes */
    const allocate = bytes=>{
        const at = heap;
        heap += (bytes + 0xfff) & ~0xfff;
        host.writePhysical(at, new Uint8Array(bytes));
        return at;
    };
    /** @param {number} at @param {number} length */
    const readMemory = (at, length)=>host.readPhysical(at, length);
    /** @param {number} at @param {Uint8Array} bytes */
    const writeMemory = (at, bytes)=>host.writePhysical(at, bytes);
    /** @param {number} at */
    const readU32 = at=>new DataView(host.readPhysical(at, 4).slice().buffer).getUint32(0, true);
    const d3d = version.create({ allocate, free: ()=>{}, readMemory, writeMemory,
        windowMemory: readMemory });
    /** @type {{ device?: any }} */
    const made = {};
    assert.equal(d3d.CreateDevice({
        swapEffect: D3DSWAPEFFECT_DISCARD, backBufferCount: 1, backBufferWidth: 64,
        backBufferHeight: 64, backBufferFormat: D3DFMT_X8R8G8B8, enableAutoDepthStencil: true,
        autoDepthStencilFormat: D3DFMT_D24S8,
    }, made, 0), D3D_OK);
    const device = made.device;
    /** @param {number} pool */
    const texture = pool=>{
        /** @type {{ texture?: any }} */
        const out = {};
        assert.equal(device.CreateTexture(16, 16, 2, 0, D3DFMT_A8R8G8B8, pool, out), D3D_OK);
        return out.texture;
    };
    /** @param {number} pool */
    const volumeTexture = pool=>{
        /** @type {{ texture?: any }} */
        const out = {};
        assert.equal(device.CreateVolumeTexture(8, 8, 4, 2, 0, D3DFMT_A8R8G8B8, pool, out),
            D3D_OK);
        return out.texture;
    };
    const textures = {
        managed: texture(D3DPOOL_MANAGED),
        system: texture(D3DPOOL_SYSTEMMEM),
        target: texture(D3DPOOL_DEFAULT),
        volume: volumeTexture(D3DPOOL_SYSTEMMEM),
        volumeTarget: volumeTexture(D3DPOOL_DEFAULT),
    };
    /** A texture's level, as GetSurfaceLevel or GetVolumeLevel hands it. @param {any} owner @param {number} index */
    const levelOf = (owner, index)=>{
        /** @type {{ surface?: any, volume?: any }} */
        const out = {};
        assert.equal(owner.volume ? owner.GetVolumeLevel(index, out)
            : owner.GetSurfaceLevel(index, out), D3D_OK);
        const level = out.surface ?? out.volume;
        level.release();
        return level;
    };
    /** A level's bytes in guest memory. @param {any} level */
    const bytesOf = level=>{
        /** @type {{ desc?: any }} */
        const held = {};
        level.GetDesc(held);
        const { Width, Height, Depth = 1 } = held.desc;
        return readMemory(level.base, Width * 4 * Height * Depth).slice();
    };
    /** @param {any} owner */
    const levelsDigest = owner=>[0, 1].map(index=>digest(bytesOf(levelOf(owner, index))))
        .join(':');

    // What the renderer holds of the managed texture: each unlock but a
    // read-only one copies the level out of guest memory.
    const held = [0, 1].map(index=>bytesOf(levelOf(textures.managed, index)));
    for (const index of [0, 1])
    {
        const level = levelOf(textures.managed, index);
        const unlock = level.UnlockRect.bind(level);
        level.UnlockRect = ()=>{
            const writes = (level.lockFlags & D3DLOCK_READONLY) === 0;
            const hr = unlock();
            if (hr === D3D_OK && writes)
            {
                held[index] = bytesOf(level);
            }
            return hr;
        };
    }
    /** What each draw sampled. @type {string[]} */
    const draws = [];
    const draw = device.DrawPrimitive.bind(device);
    /** @param {number} type @param {number} start @param {number} count */
    device.DrawPrimitive = (type, start, count)=>{
        const hr = draw(type, start, count);
        if (hr === D3D_OK)
        {
            draws.push(held.map(digest).join(':'));
        }
        return hr;
    };
    /** @type {{ buffer?: any }} */
    const vertices = {};
    assert.equal(device.CreateVertexBuffer(3 * STRIDE, 0, FVF, D3DPOOL_MANAGED, vertices),
        D3D_OK);
    version.bind(device, vertices.buffer);
    assert.equal(device.SetTexture(0, textures.managed), D3D_OK);
    assert.equal(device.BeginScene(), D3D_OK);

    /**
     * An update, its copies made as the seam makes Direct3D 8's (and as
     * Direct3D 9's device has made them already), and what it carried.
     *
     * @param {'system' | 'volume'} on
     */
    const update = on=>{
        const [source, target] = on === 'system' ? [textures.system, textures.target]
            : [textures.volume, textures.volumeTarget];
        /** @type {{ moves?: any[] }} */
        const out = {};
        const hr = device.UpdateTexture(source, target, out);
        for (const move of hr === D3D_OK ? out.moves ?? [] : [])
        {
            for (let row = 0; row < move.rows; row++)
            {
                writeMemory(move.to + row * move.toPitch,
                    readMemory(move.from + row * move.fromPitch, move.rowBytes).slice());
            }
        }
        return `${hr} ${levelsDigest(target)}`;
    };
    return { host, allocate, readMemory, writeMemory, readU32, device, textures, levelOf,
        levelsDigest, draws, update };
}

/**
 * The texels a lock's box covers written -- each byte a function of the fill
 * and its place, so a stale byte differs -- from the address and pitches the
 * lock handed back.
 *
 * @param {(at: number, bytes: Uint8Array) => void} writeMemory
 * @param {{ pBits: number, pitch: number, slice: number }} locked
 * @param {Box} box @param {number} fill
 */
const write = (writeMemory, locked, box, fill)=>{
    const row = (box.right - box.left) * 4;
    for (let z = 0; z < box.back - box.front; z++)
    {
        for (let y = 0; y < box.bottom - box.top; y++)
        {
            const seed = fill + (z * 31 + y) * 7;
            writeMemory(locked.pBits + z * locked.slice + y * locked.pitch,
                Uint8Array.from({ length: row }, (unused, i)=>(seed + i) & 0xff));
        }
    }
};

/**
 * A lock's box as the level has it: the box asked for, or all of it.
 *
 * @param {any} level @param {Box | null} box
 * @returns {Box}
 */
const coveredBy = (level, box)=>{
    /** @type {{ desc?: any }} */
    const held = {};
    level.GetDesc(held);
    return box ?? { left: 0, top: 0, right: held.desc.Width, bottom: held.desc.Height, front: 0,
        back: held.desc.Depth ?? 1 };
};

/** A box as a rectangle, for a surface's lock. @param {Box | null} box */
const rectOf = box=>box && { left: box.left, top: box.top, right: box.right, bottom: box.bottom };

/**
 * Whether a box is one the level takes as the guest checks one: within it
 * and not empty. Only those are written.
 *
 * @param {any} level @param {Box | null} box
 */
const fits = (level, box)=>{
    const whole = coveredBy(level, null);
    return box === null || (box.left < box.right && box.top < box.bottom
        && box.front < box.back && box.right <= whole.right && box.bottom <= whole.bottom
        && box.back <= whole.back);
};

/**
 * Every call made on the device as it comes.
 *
 * @param {Version} version @param {Step[]} steps
 */
function direct(version, steps){
    const m = machine(version, false);
    /** @type {string[]} */
    const answers = [];
    /** @type {string[]} */
    const updates = [];
    for (const step of steps)
    {
        if (step.kind === 'lock')
        {
            const owner = step.on === 'surface' ? m.textures.managed : m.textures[step.on];
            const level = m.levelOf(owner, step.level);
            /** @type {any} */
            const out = {};
            const hr = step.on === 'volume'
                ? owner.LockBox(step.level, out, step.box, step.flags)
                : step.on === 'surface' ? level.LockRect(out, rectOf(step.box), step.flags)
                    : owner.LockRect(step.level, out, rectOf(step.box), step.flags);
            const locked = { pBits: out.pBits ?? 0, pitch: out.Pitch ?? out.RowPitch ?? 0,
                slice: out.SlicePitch ?? 0 };
            answers.push(`lock ${hr} ${locked.pitch} ${locked.slice} ${locked.pBits - level.base}`);
            if (hr !== D3D_OK)
            {
                continue;
            }
            if ((step.flags & D3DLOCK_READONLY) === 0 && fits(level, step.box))
            {
                write(m.writeMemory, locked, coveredBy(level, step.box), step.fill);
            }
            if (step.entry)
            {
                // A second lock while the first is held, which the level refuses.
                answers.push(`again ${step.on === 'volume'
                    ? owner.LockBox(step.level, {}, step.box, step.flags)
                    : step.on === 'surface' ? level.LockRect({}, rectOf(step.box), step.flags)
                        : owner.LockRect(step.level, {}, rectOf(step.box), step.flags)}`);
            }
            answers.push(`unlock ${step.on === 'volume' ? owner.UnlockBox(step.level)
                : step.on === 'surface' ? level.UnlockRect() : owner.UnlockRect(step.level)}`);
        }
        else if (step.kind === 'dirty')
        {
            answers.push(`dirty ${step.on === 'volume'
                ? m.textures.volume.AddDirtyBox(step.box)
                : m.textures.system.AddDirtyRect(rectOf(step.box))}`);
        }
        else if (step.kind === 'draw')
        {
            answers.push(`draw ${m.device.DrawPrimitive(D3DPT_TRIANGLELIST, 0, 1)}`);
        }
        else if (step.kind === 'update')
        {
            updates.push(m.update(step.on));
        }
    }
    return { answers, draws: m.draws, updates, end: ['managed', 'system', 'target', 'volume',
        'volumeTarget'].map(name=>m.levelsDigest(/** @type {any} */ (m.textures)[name])) };
}

/**
 * The same calls through the guest routines, with the host's entries made as
 * the seams make them: a resource's method on the host plays the ring first
 * (`describeResource`), a level's lock or unlock it made is told to the
 * level's block after (`createLevelLocks`), and a device call brings the block
 * to the device after (`settledAfter`).
 *
 * @param {Version} version @param {Step[]} steps @param {boolean} [lent]
 */
function guest(version, steps, lent = false){
    const m = machine(version);
    const { device, textures } = m;
    const host = /** @type {ReturnType<typeof createCorkHost>} */ (m.host);
    device.lendsMemory = lent;
    const surface = m.levelOf(textures.managed, 0);
    /** @type {Map<number, any>} */
    const objects = new Map([['managed', textures.managed], ['surface', surface],
        ['system', textures.system], ['volume', textures.volume]].map(([name, object])=>
        [interfaceOf(/** @type {typeof OBJECTS[number]} */ (name)), object]));
    const shadow = createShadow({
        allocate: m.allocate, readMemory: m.readMemory, readU32: m.readU32,
        writeMemory: m.writeMemory, device,
        commands: { take: records=>device.commands(records,
            version.commands.commandObjects(records, (/** @type {number} */ pointer)=>
                objects.get(pointer) ?? null)) },
    });
    const levelLocks = createLevelLocks({ shadowOf: ()=>shadow, twinCopies: version.twinCopies });
    /** @param {typeof OBJECTS[number]} name @param {number} block */
    const place = (name, block)=>host.writePhysical(interfaceOf(name) + 4,
        new Uint8Array(u32(block)));
    place('device', shadow.address());
    place('managed', shadow.attachTexture(textures.managed, 0, EXTENT.managed));
    place('system', shadow.attachTexture(textures.system, 0, EXTENT.system));
    place('volume', shadow.attachTexture(textures.volume, 0, EXTENT.volume));
    place('surface', shadow.attachSurface(surface, ()=>{}));
    /** @param {string} name */
    const command = name=>({ ...version.commands.COMMANDS[name],
        slot: version.commands.commandSlot(name), mirror: version.mirrors[name] });
    /** @type {Record<typeof NAMES[number], (at: number, trap: number) => Uint8Array>} */
    const code = {
        lockTexture: (at, trap)=>lockLevelCode(at, trap, { find: 'texture' }),
        unlockTexture: (at, trap)=>unlockLevelCode(at, trap, { find: 'texture' }),
        lockSurface: (at, trap)=>lockLevelCode(at, trap, { find: 'surface' }),
        unlockSurface: (at, trap)=>unlockLevelCode(at, trap, { find: 'surface' }),
        lockVolume: (at, trap)=>lockLevelCode(at, trap, { find: 'texture', box: true }),
        unlockVolume: (at, trap)=>unlockLevelCode(at, trap, { find: 'texture' }),
        dirtyRect: (at, trap)=>commandCode(at, trap, command('Texture.AddDirtyRect')),
        dirtyBox: (at, trap)=>commandCode(at, trap, command('VolumeTexture.AddDirtyBox')),
        draw: (at, trap)=>commandCode(at, trap, command('DrawPrimitive')),
    };
    for (const name of NAMES)
    {
        const bytes = code[name](routineAt(name), trapAt(name));
        assert.ok(bytes.length <= ROUTINE_BYTES, `${name} fits its room`);
        host.writePhysical(routineAt(name), bytes);
        host.writePhysical(trapAt(name), new Uint8Array([0xf4]));
    }

    /**
     * Calls a routine: its answer, or which trap it left for.
     *
     * @param {typeof NAMES[number]} name @param {number} object @param {number[]} args
     * @returns {{ trap: true } | { hr: number }}
     */
    const run = (name, object, args)=>{
        /** @type {number[]} */
        const bytes = [];
        for (const value of [...args].reverse())
        {
            bytes.push(0x68, ...u32(value));
        }
        bytes.push(0x68, ...u32(object));
        bytes.push(0xe8, ...u32((routineAt(name) - (PROGRAM + bytes.length + 5)) | 0), 0xf4);
        host.writePhysical(PROGRAM, new Uint8Array(bytes));
        host.writeReg32('eip', PROGRAM);
        host.writeReg32('esp', STACK);
        const halts = [PROGRAM + bytes.length, ...NAMES.map(other=>trapAt(other) + 1)];
        for (let slices = 0; slices < 16 && !halts.includes(host.readReg32('eip')); slices++)
        {
            host.runSlice(10000);
        }
        const eip = host.readReg32('eip');
        assert.ok(halts.includes(eip), `${name} ran to a halt`);
        if (eip !== PROGRAM + bytes.length)
        {
            assert.equal(eip, trapAt(name) + 1, `${name} left through its own trap`);
            return { trap: true };
        }
        assert.equal(host.readReg32('esp') >>> 0, STACK, `${name} popped its arguments`);
        return { hr: host.readReg32('eax') | 0 };
    };
    /** A box where the routines read one: zero for none. @param {Box | null} box @param {boolean} volume */
    const boxAt = (box, volume)=>{
        if (!box)
        {
            return 0;
        }
        const words = volume ? [box.left, box.top, box.right, box.bottom, box.front, box.back]
            : [box.left, box.top, box.right, box.bottom];
        host.writePhysical(BOX, new Uint8Array(new Uint32Array(words).buffer));
        return BOX;
    };

    /** @type {string[]} */
    const answers = [];
    /** @type {string[]} */
    const updates = [];
    /** Locks and dirty regions the guest answered, by target. @type {Record<string, number>} */
    const inGuest = {};
    /** @param {string} key @param {{ trap: true } | { hr: number }} result */
    const took = (key, result)=>{
        if (!('trap' in result))
        {
            inGuest[key] = (inGuest[key] ?? 0) + 1;
        }
    };
    for (const step of steps)
    {
        if (step.kind === 'lock')
        {
            const volume = step.on === 'volume';
            const owner = step.on === 'surface' ? textures.managed : textures[step.on];
            const level = m.levelOf(owner, step.level);
            const pointer = interfaceOf(step.on);
            const lockName = volume ? 'lockVolume' : step.on === 'surface' ? 'lockSurface'
                : 'lockTexture';
            const unlockName = volume ? 'unlockVolume' : step.on === 'surface' ? 'unlockSurface'
                : 'unlockTexture';
            const rect = boxAt(step.box, volume);
            host.writePhysical(OUT, new Uint8Array(12));
            const index = step.on === 'surface' ? null : step.level;
            const lockArgs = index === null ? [OUT, rect, step.flags]
                : [index, OUT, rect, step.flags];
            const tried = run(lockName, pointer, lockArgs);
            took(`lock ${step.on}`, tried);
            /** @type {any} */
            const out = {};
            let hr = 'hr' in tried ? tried.hr : D3D_OK;
            if ('trap' in tried)
            {
                shadow.sync();
                hr = volume ? owner.LockBox(step.level, out, step.box, step.flags)
                    : index === null ? level.LockRect(out, rectOf(step.box), step.flags)
                        : owner.LockRect(step.level, out, rectOf(step.box), step.flags);
                if (hr === D3D_OK)
                {
                    levelLocks.locked(device, step.on === 'surface' ? level : owner, index, true);
                }
            }
            else
            {
                const words = [0, 4, 8].map(offset=>m.readU32(OUT + offset));
                Object.assign(out, volume
                    ? { RowPitch: words[0], SlicePitch: words[1], pBits: words[2] }
                    : { Pitch: words[0], pBits: words[1] });
            }
            const locked = { pBits: out.pBits ?? 0, pitch: out.Pitch ?? out.RowPitch ?? 0,
                slice: out.SlicePitch ?? 0 };
            answers.push(`lock ${hr} ${locked.pitch} ${locked.slice} ${locked.pBits - level.base}`);
            if (hr !== D3D_OK)
            {
                continue;
            }
            if ((step.flags & D3DLOCK_READONLY) === 0 && fits(level, step.box))
            {
                write(m.writeMemory, locked, coveredBy(level, step.box), step.fill);
            }
            if (step.entry)
            {
                // Another call reaches the host while the lock is held, then a
                // second lock, which the level refuses: the host has to know
                // of the first.
                settledAfter(shadow, ()=>D3D_OK);
                const again = run(lockName, pointer, lockArgs);
                let second = 'hr' in again ? again.hr : D3D_OK;
                if ('trap' in again)
                {
                    shadow.sync();
                    second = volume ? owner.LockBox(step.level, {}, step.box, step.flags)
                        : index === null ? level.LockRect({}, rectOf(step.box), step.flags)
                            : owner.LockRect(step.level, {}, rectOf(step.box), step.flags);
                }
                answers.push(`again ${second}`);
            }
            const released = run(unlockName, pointer, index === null ? [] : [index]);
            took(`unlock ${step.on}`, released);
            let unlocked = 'hr' in released ? released.hr : D3D_OK;
            if ('trap' in released)
            {
                shadow.sync();
                unlocked = volume ? owner.UnlockBox(step.level)
                    : index === null ? level.UnlockRect() : owner.UnlockRect(step.level);
                if (unlocked === D3D_OK)
                {
                    levelLocks.locked(device, step.on === 'surface' ? level : owner, index,
                        false);
                }
            }
            answers.push(`unlock ${unlocked}`);
        }
        else if (step.kind === 'dirty')
        {
            const volume = step.on === 'volume';
            const tried = run(volume ? 'dirtyBox' : 'dirtyRect', interfaceOf(step.on),
                [boxAt(step.box, volume)]);
            took(`dirty ${step.on}`, tried);
            if ('trap' in tried)
            {
                shadow.sync();
                answers.push(`dirty ${volume ? textures.volume.AddDirtyBox(step.box)
                    : textures.system.AddDirtyRect(rectOf(step.box))}`);
            }
            else
            {
                answers.push(`dirty ${tried.hr}`);
            }
        }
        else if (step.kind === 'draw')
        {
            const drawn = run('draw', interfaceOf('device'), [D3DPT_TRIANGLELIST, 0, 1]);
            answers.push(`draw ${'hr' in drawn ? drawn.hr
                : settledAfter(shadow, ()=>device.DrawPrimitive(D3DPT_TRIANGLELIST, 0, 1))}`);
        }
        else if (step.kind === 'update')
        {
            updates.push(settledAfter(shadow, ()=>m.update(step.on)));
        }
        else
        {
            settledAfter(shadow, ()=>D3D_OK);
        }
    }
    // A present, or any call at the end of the frame, plays what is left.
    shadow.sync();
    return { answers, draws: m.draws, updates, inGuest, end: ['managed', 'system', 'target',
        'volume', 'volumeTarget'].map(name=>m.levelsDigest(/** @type {any} */ (textures)[name])) };
}

test('a draw samples, and an update carries, what the program\'s texture held when it made'
    + ' them, however its levels were locked and marked dirty in between', ()=>{
    for (const version of VERSIONS)
    {
        /** @type {Record<string, number>} */
        const total = {};
        for (let seed = 1; seed <= 40; seed++)
        {
            const steps = generate(seed, 200);
            const expected = direct(version, steps);
            for (const lent of [false, true])
            {
                const actual = guest(version, steps, lent);
                const label = `${version.name}, seed ${seed}${lent ? ', lent' : ''}`;
                for (const part of /** @type {const} */ (['answers', 'draws', 'updates']))
                {
                    const first = expected[part].findIndex((entry, i)=>entry !== actual[part][i]);
                    assert.equal(first, -1, `${label}: ${part} ${first} is what the host gives`);
                    assert.equal(actual[part].length, expected[part].length, `${label}: ${part}`);
                }
                assert.deepEqual(actual.end, expected.end, `${label}: the levels at the end`);
                for (const [key, count] of Object.entries(actual.inGuest))
                {
                    if (lent)
                    {
                        // A level a draw may read, or whose update a twin copies
                        // out of what was sent, may be lent: its locks are the host's.
                        assert.ok(!key.startsWith('lock ') || !(key === 'lock managed'
                            || key === 'lock surface' || version.twinCopies),
                        `${label}: ${key} taken in the guest`);
                    }
                    else
                    {
                        total[key] = (total[key] ?? 0) + count;
                    }
                }
            }
        }
        // Each path of the guest's is taken, so the gate holds it to something.
        assert.deepEqual(Object.keys(total).sort(), ['dirty system', 'dirty volume',
            'lock managed', 'lock surface', 'lock system', 'lock volume', 'unlock managed',
            'unlock surface', 'unlock system', 'unlock volume'], version.name);
    }
});
