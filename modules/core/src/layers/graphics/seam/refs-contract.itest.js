/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The reference counts kept in the guest, as a gate: a Direct3D 8 or 9
 * object's count lives in a word of guest memory, the guest's AddRef, Release
 * and GetSurfaceLevel change it there, and the host hears of the object only
 * when the count crosses zero. A program must not be able to tell: every
 * answer, every pointer it is handed, the moment the host lets the object go
 * and what the command ring names when it is played must be what they are
 * with every call a trap.
 *
 * Two machines run the same program side by side, call by call, each the
 * real processor with the bridge's tables and the seam's own trap handlers
 * over it: one with the guest code off (graphics `guestCode: false`, which
 * leaves the bridge's count routines in place with no word to count in), one
 * with it on. The program is drawn from a seed out of what a program may do
 * with what it holds -- make textures, their levels, volumes, cube maps,
 * buffers, targets and state blocks; take and give back references through
 * any of their interfaces; ask for levels, containers, the device and what is
 * bound; bind and unbind them in the ring while it lets go of its own
 * references -- and at the end it gives back everything, the device last.
 * The programs each difference found came down to are kept written out.
 *
 * Checked after every call: the answer in EAX, the pointer written to the
 * out-parameter (by identity: the first pointer each machine hands out is
 * the same object as the other's first), the stack the callee left; which
 * objects the host has let go of -- never one before the trap machine does,
 * and the same ones whenever the command ring is empty, since a call waiting
 * in it may be the binding that keeps an object; and, whenever the ring is
 * played, that no record in it names an object the host has let go of. What
 * the host throws on with every call a trap is said, not failed: it is the
 * host's own, whatever the guest does.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IID_IUNKNOWN } from '../../win32/ole32/objects.js';
import {
    IID_IDirect3DBaseTexture8, IID_IDirect3DCubeTexture8, IID_IDirect3DDevice8,
    IID_IDirect3DResource8, IID_IDirect3DTexture8, IID_IDirect3DVolumeTexture8,
} from './iids.js';
import {
    IID_IDirect3DBaseTexture9, IID_IDirect3DCubeTexture9, IID_IDirect3DDevice9,
    IID_IDirect3DResource9, IID_IDirect3DTexture9, IID_IDirect3DVolumeTexture9,
} from '../d3d9/interfaces.js';
import {
    D3D8, D3D9, D3DSBT_ALL, HWND, SOFTWARE_VERTEXPROCESSING, machine, random,
} from './guest-machine.itest.js';

/** @typedef {import('./guest-machine.itest.js').Version} Version */
/** @typedef {import('./guest-machine.itest.js').Call} Call */
/** @typedef {import('./guest-machine.itest.js').Answer} Answer */

/**
 * The program's own book of what it holds: per object -- a texture and its
 * levels being one, as their count is -- the references it owns and the
 * pointers it may call through, each with the kind of interface it is.
 *
 * @typedef {{ kind: string, refs: number, pointers: Map<string, string>,
 *     primary: string, levels: number }} Held
 */

/** The kind of interface a query answers with, when it is a pointer not seen before. */
const queriedKind = (/** @type {string} */ iid, /** @type {string} */ through)=>{
    if (iid === IID_IUNKNOWN || iid === IID_IDirect3DResource9 || iid === IID_IDirect3DResource8)
    {
        return 'unknown';
    }
    if (iid === IID_IDirect3DBaseTexture9 || iid === IID_IDirect3DBaseTexture8)
    {
        return 'base';
    }
    return through;
};

/** The kinds a level, a face or a volume is: what GetContainer is asked of. */
const PARTS = new Set(['level', 'face', 'volume', 'surface', 'target', 'depth',
    'depthSurface']);
/** The kinds with a GetDevice. */
const RESOURCES = new Set(['texture', 'level', 'cube', 'face', 'volumeTexture', 'volume',
    'vertices', 'indices', 'block', 'surface', 'target', 'depth', 'depthSurface', 'base']);

/**
 * The two machines, the guest code off and on, and a call made on both with
 * everything the program can see of it compared.
 *
 * @param {Version} version @param {string} label  what a difference says it is from
 */
function pair(version, label){
    const trap = machine(version, false);
    const guest = machine(version, true);
    /** @type {string[]} */
    const differences = [];
    /** @type {string[]} */
    const transcript = [];
    /** What the host threw on with every call a trap, which the bridge would end the run on. */
    const threw = new Set();
    let traps = 0;
    let saved = 0;
    /** @param {string} shown */
    const where = shown=>`${label}, call ${transcript.length}: ${shown}\n      `
        + transcript.slice(-16).join('\n      ');

    /**
     * Makes `call` on both machines and compares what the program sees.
     *
     * @param {Call} call
     * @returns {Answer}
     */
    const both = call=>{
        const shown = `${call.on}(${call.kind}).${call.method}(${call.args.map(arg=>
            (typeof arg === 'object' ? 'guid' in arg ? `${arg.guid.slice(0, 9)}}` : '{...}'
                : arg)).join(', ')})`;
        const expected = trap.run(call);
        const answered = guest.run(call);
        transcript.push(`${shown} = 0x${expected.eax.toString(16)} ${expected.out}`
            + `${answered.traps.length === 0 ? ' (guest)' : ''}`);
        if (typeof expected.out === 'string' && expected.out.includes(' threw: '))
        {
            threw.add(expected.out);
        }
        for (const field of /** @type {const} */ (['eax', 'out', 'out2', 'out3']))
        {
            if (expected[field] !== answered[field])
            {
                differences.push(`${call.method}'s ${field} is ${answered[field]} with the guest`
                    + ` code and ${expected[field]} without: ${where(shown)}`);
            }
        }
        traps += expected.traps.length;
        saved += expected.traps.length - answered.traps.length;
        const endedTrap = trap.ended();
        const endedGuest = guest.ended();
        const early = endedGuest.filter(key=>!endedTrap.includes(key));
        if (early.length > 0)
        {
            differences.push(`the host let go of ${early} with the guest code and not without:`
                + ` ${where(shown)}`);
        }
        else if (guest.pending() === 0 && endedGuest.length !== endedTrap.length)
        {
            differences.push(`the ring empty, the host has let go of [${endedGuest}] with the`
                + ` guest code and [${endedTrap}] without: ${where(shown)}`);
        }
        if (guest.gone.length > 0)
        {
            differences.push(`${guest.gone.splice(0).join('; ')}: ${where(shown)}`);
        }
        return expected;
    };

    return {
        trap,
        both,
        differences,
        transcript,
        threw,
        /** The traps the trap machine took, and how many of them the guest code answered. */
        counts: ()=>({ traps, saved }),
        /** With nothing more to come, the host has let go of the same objects on both. */
        finish(){
            const endedTrap = trap.ended();
            const endedGuest = guest.ended();
            if (endedGuest.join() !== endedTrap.join())
            {
                differences.push(`at the end, the host has let go of [${endedGuest}] with the`
                    + ` guest code and [${endedTrap}] without, ${label}:\n      `
                    + transcript.slice(-24).join('\n      '));
            }
        },
    };
}

/** The device, as a program makes it. */
const DEVICE = '#1';
/** @param {Version} version @returns {Call} */
const createDevice = version=>({ on: '#0', kind: 'root', method: 'CreateDevice', args: [0, 1,
    HWND, SOFTWARE_VERTEXPROCESSING, { words: version.presentParameters }, 'out'] });

/**
 * Runs `steps` calls drawn from `seed` on both machines, then gives back
 * everything, and says every way the guest's machine answered or ended
 * differently.
 *
 * @param {Version} version @param {number} seed @param {number} steps
 */
function compare(version, seed, steps){
    const machines = pair(version, `seed ${seed}`);
    const { trap, both, transcript } = machines;
    const pick = random(seed);
    /** By the object whose count it is. @type {Map<any, Held>} */
    const held = new Map();
    /** Which object each pointer reaches, kept past its last reference. @type {Map<string, Held>} */
    const ownerOf = new Map();

    /**
     * The program holds one more reference, through a pointer it may have
     * been handed for the first time, as the interface `kind` is.
     *
     * @param {string} pointer @param {string} kind @param {number} [levels]
     */
    const took = (pointer, kind, levels = 0)=>{
        let owner = ownerOf.get(pointer);
        if (!owner)
        {
            const count = trap.countOf(pointer);
            owner = held.get(count);
            if (!owner)
            {
                owner = { kind, refs: 0, pointers: new Map(), primary: pointer, levels };
                held.set(count, owner);
            }
            ownerOf.set(pointer, owner);
            owner.pointers.set(pointer, kind);
        }
        owner.refs++;
        return owner;
    };

    /**
     * What the answer to AddRef or Release must be by the program's book:
     * the object's references, which for anything but the device -- whose
     * count its resources' references are in too -- is all it has.
     *
     * @param {Held} owner @param {Answer} answer
     */
    const counted = (owner, answer)=>{
        if (owner.kind !== 'device')
        {
            assert.equal(answer.eax, owner.refs, `the book keeps ${owner.primary}'s count:\n      `
                + transcript.slice(-16).join('\n      '));
        }
    };

    /**
     * The program gave back a reference: at the last, it lets go of every
     * pointer it had to the object, which the bridge may hand out afresh.
     *
     * @param {Held} owner
     */
    const gaveBack = owner=>{
        owner.refs--;
        if (owner.refs === 0)
        {
            for (const pointer of owner.pointers.keys())
            {
                ownerOf.delete(pointer);
            }
            owner.pointers.clear();
        }
    };

    /** @param {Answer} answer */
    const handed = answer=>(answer.eax === 0 && typeof answer.out === 'string'
        && answer.out !== 'untouched' ? answer.out : null);

    /** @param {(owner: Held) => boolean} [which] */
    const live = (which = ()=>true)=>[...held.values()].filter(owner=>owner.refs > 0
        && which(owner));
    /** @param {Held} owner @param {(kind: string) => boolean} [which] */
    const pointerOf = (owner, which = ()=>true)=>{
        const choices = [...owner.pointers].filter(([, kind])=>which(kind));
        return choices.length === 0 ? null : pick.pick(choices);
    };
    /**
     * A pointer to the object as the interface it was made as, which is
     * what a method taking one is handed; null while the program holds it
     * only through others.
     *
     * @param {Held} owner
     */
    const own = owner=>pointerOf(owner, kind=>kind === owner.kind)?.[0] ?? null;
    /** Something of one of `kinds` to bind, or now and then nothing. @param {string[]} kinds */
    const primaryOf = kinds=>{
        const choices = live(owner=>kinds.includes(owner.kind) && own(owner) !== null);
        return choices.length === 0 || pick.below(4) === 0 ? 0
            : /** @type {string} */ (own(pick.pick(choices)));
    };
    /** @type {number[]} Direct3D 8's state blocks */
    const tokens = [];
    /** @param {string} method @param {Call['args']} args */
    const onDevice = (method, args)=>both({ on: DEVICE, kind: 'device', method, args });

    const made = both(createDevice(version));
    assert.equal(made.eax, 0, 'the device is made');
    assert.equal(made.out, DEVICE);
    took(DEVICE, 'device');

    /** @type {(() => boolean)[]} each makes a call when the program can, and says whether it did */
    const moves = [
        // A resource of a kind this version makes.
        ()=>{
            if (live(owner=>owner.kind !== 'device').length >= 6)
            {
                return false;
            }
            const kind = pick.pick(Object.keys(version.creates));
            const levels = 1 + pick.below(3);
            const { method, args } = version.creates[kind];
            const answer = onDevice(method, args.map(arg=>(arg === 'levels' ? levels : arg)));
            const pointer = handed(answer);
            if (pointer)
            {
                took(pointer, kind, kind === 'texture' ? levels : 2);
            }
            return true;
        },
        // A reference taken, through any interface of anything held.
        ()=>{
            const owner = pick.pick(live());
            const [pointer, kind] = /** @type {[string, string]} */ (pointerOf(owner));
            const answer = both({ on: pointer, kind, method: 'AddRef', args: [] });
            owner.refs++;
            counted(owner, answer);
            return true;
        },
        // One given back, the device's last kept for the end.
        ()=>{
            const choices = live(owner=>owner.kind !== 'device' || owner.refs > 1);
            if (choices.length === 0)
            {
                return false;
            }
            const owner = pick.pick(choices);
            const [pointer, kind] = /** @type {[string, string]} */ (pointerOf(owner));
            const answer = both({ on: pointer, kind, method: 'Release', args: [] });
            gaveBack(owner);
            counted(owner, answer);
            return true;
        },
        // A level of a texture, one past the last now and then, or nowhere to put it.
        ()=>{
            const choices = live(owner=>owner.kind === 'texture');
            if (choices.length === 0)
            {
                return false;
            }
            const owner = pick.pick(choices);
            const [pointer, kind] = /** @type {[string, string]} */ (pointerOf(owner,
                one=>one === 'texture'));
            const answer = both({ on: pointer, kind, method: 'GetSurfaceLevel',
                args: [pick.below(owner.levels + 1), 'out'] });
            const level = handed(answer);
            if (level)
            {
                took(level, 'level');
            }
            return true;
        },
        // A face of a cube map, or a level of a volume.
        ()=>{
            const choices = live(owner=>(owner.kind === 'cube' || owner.kind === 'volumeTexture')
                && own(owner) !== null);
            if (choices.length === 0)
            {
                return false;
            }
            const owner = pick.pick(choices);
            const cube = owner.kind === 'cube';
            const answer = both({ on: /** @type {string} */ (own(owner)), kind: owner.kind,
                method: cube ? 'GetCubeMapSurface' : 'GetVolumeLevel',
                args: cube ? [pick.below(6), pick.below(3), 'out'] : [pick.below(3), 'out'] });
            const part = handed(answer);
            if (part)
            {
                took(part, cube ? 'face' : 'volume');
            }
            return true;
        },
        // A query, for an interface the object has or one it has not.
        ()=>{
            const owner = pick.pick(live());
            const [pointer, kind] = /** @type {[string, string]} */ (pointerOf(owner));
            const iid = pick.pick(version.queries[kind] ?? [IID_IUNKNOWN]);
            const answer = both({ on: pointer, kind, method: 'QueryInterface',
                args: [{ guid: iid }, 'out'] });
            const got = handed(answer);
            if (got)
            {
                took(got, queriedKind(iid, kind));
            }
            return true;
        },
        // What holds a level, a face or a volume.
        ()=>{
            const choices = live(owner=>[...owner.pointers.values()].some(kind=>PARTS.has(kind)));
            if (choices.length === 0)
            {
                return false;
            }
            const owner = pick.pick(choices);
            const [pointer, kind] = /** @type {[string, string]} */ (pointerOf(owner,
                one=>PARTS.has(one)));
            const iid = pick.pick([IID_IUNKNOWN, ...version === D3D9
                ? [IID_IDirect3DTexture9, IID_IDirect3DCubeTexture9, IID_IDirect3DVolumeTexture9,
                    IID_IDirect3DBaseTexture9, IID_IDirect3DDevice9]
                : [IID_IDirect3DTexture8, IID_IDirect3DCubeTexture8, IID_IDirect3DVolumeTexture8,
                    IID_IDirect3DBaseTexture8, IID_IDirect3DDevice8]]);
            const answer = both({ on: pointer, kind, method: 'GetContainer',
                args: [{ guid: iid }, 'out'] });
            const got = handed(answer);
            if (got)
            {
                const device = iid === IID_IDirect3DDevice9 || iid === IID_IDirect3DDevice8;
                took(got, queriedKind(iid, device ? 'device' : owner.kind));
            }
            return true;
        },
        // The device, asked of a resource.
        ()=>{
            const choices = live(owner=>[...owner.pointers.values()].some(kind=>
                RESOURCES.has(kind)));
            if (choices.length === 0)
            {
                return false;
            }
            const owner = pick.pick(choices);
            const [pointer, kind] = /** @type {[string, string]} */ (pointerOf(owner,
                one=>RESOURCES.has(one)));
            const got = handed(both({ on: pointer, kind, method: 'GetDevice', args: ['out'] }));
            if (got)
            {
                took(got, 'device');
            }
            return true;
        },
        // A texture bound or unbound in the ring.
        ()=>{
            onDevice('SetTexture', [pick.below(2), primaryOf(version.textureKinds)]);
            return true;
        },
        ()=>{
            onDevice('SetStreamSource', version.setStream(pick.below(2),
                primaryOf(['vertices'])));
            return true;
        },
        ()=>{
            onDevice('SetIndices', version.setIndices(primaryOf(['indices'])));
            return true;
        },
        // What is bound, handed back with a reference -- perhaps to something
        // the program let go of while it was bound.
        ()=>{
            const answer = onDevice('GetTexture', [pick.below(2), 'out']);
            const got = handed(answer);
            if (got)
            {
                took(got, 'texture');
            }
            return true;
        },
        ()=>{
            const streams = pick.below(2) === 0;
            const answer = onDevice(streams ? 'GetStreamSource' : 'GetIndices',
                streams ? version.getStream : version.getIndices);
            const got = handed(answer);
            if (got)
            {
                took(got, streams ? 'vertices' : 'indices');
            }
            return true;
        },
        // The device's own surfaces, whose first reference is one on the device.
        ()=>{
            const which = pick.below(3);
            const answer = which === 0 ? onDevice('GetBackBuffer', version.getBackBuffer)
                : which === 1 ? onDevice('GetRenderTarget', version.getRenderTarget)
                    : onDevice('GetDepthStencilSurface', ['out']);
            const got = handed(answer);
            if (got)
            {
                took(got, which === 2 ? 'depthSurface' : 'surface');
            }
            return true;
        },
        // A target and a depth surface set in the ring: the device holds what
        // it draws to, whatever the program gives back.
        ()=>{
            const targets = live(owner=>(owner.kind === 'target' || owner.kind === 'surface')
                && own(owner) !== null);
            if (targets.length === 0)
            {
                return false;
            }
            const target = /** @type {string} */ (own(pick.pick(targets)));
            const depth = primaryOf(['depth', 'depthSurface']);
            for (const [method, args] of version.setTargets(target, depth))
            {
                onDevice(method, args);
            }
            return true;
        },
        // A Direct3D 8 state block, which is a token rather than an object.
        ()=>{
            if (version !== D3D8)
            {
                return false;
            }
            if (tokens.length < 3 && (tokens.length === 0 || pick.below(3) === 0))
            {
                const answer = onDevice('CreateStateBlock', [D3DSBT_ALL, 'out2']);
                if (answer.eax === 0)
                {
                    tokens.push(answer.out2);
                }
                return true;
            }
            const token = pick.pick(tokens);
            const method = pick.pick(['ApplyStateBlock', 'CaptureStateBlock', 'ApplyStateBlock',
                'DeleteStateBlock']);
            onDevice(method, [token]);
            if (method === 'DeleteStateBlock')
            {
                tokens.splice(tokens.indexOf(token), 1);
            }
            return true;
        },
        // A state block captured or applied, in the ring.
        ()=>{
            const choices = live(owner=>owner.kind === 'block' && own(owner) !== null);
            if (choices.length === 0)
            {
                return false;
            }
            both({ on: /** @type {string} */ (own(pick.pick(choices))), kind: 'block',
                method: pick.pick(['Capture', 'Apply']), args: [] });
            return true;
        },
    ];

    for (let step = 0; step < steps;)
    {
        if (pick.pick(moves)())
        {
            step++;
        }
    }
    // Everything given back, the device last.
    for (const owner of live(one=>one.kind !== 'device'))
    {
        while (owner.refs > 0)
        {
            const [pointer, kind] = /** @type {[string, string]} */ (pointerOf(owner));
            const answer = both({ on: pointer, kind, method: 'Release', args: [] });
            gaveBack(owner);
            counted(owner, answer);
        }
    }
    const device = /** @type {Held} */ (ownerOf.get(DEVICE));
    while (device.refs > 0)
    {
        const [pointer, kind] = /** @type {[string, string]} */ (pointerOf(device));
        both({ on: pointer, kind, method: 'Release', args: [] });
        gaveBack(device);
    }
    machines.finish();
    return machines;
}

/**
 * Many programs, each from its own seed: every difference any of them shows,
 * the first few of each, and what the host threw on with every call a trap.
 *
 * @param {Version} version @param {number} programs @param {number} steps
 */
function gate(version, programs, steps){
    /** @type {string[]} */
    const differences = [];
    const threw = new Set();
    let traps = 0;
    let saved = 0;
    for (let seed = 1; seed <= programs; seed++)
    {
        const result = compare(version, seed, steps);
        differences.push(...result.differences.slice(0, 3));
        result.threw.forEach(what=>threw.add(what));
        traps += result.counts().traps;
        saved += result.counts().saved;
    }
    assert.ok(saved > traps / 10, `the guest code answered ${saved} of ${traps} calls the`
        + ' trap machine took to the host, so it was exercised');
    return { differences, threw: [...threw] };
}

const PROGRAMS = 150;
const STEPS = 100;

test('Direct3D 9: references kept in the guest answer and end as they do with every call a trap',
    { timeout: 300000 }, t=>{
        const { differences, threw } = gate(D3D9, PROGRAMS, STEPS);
        threw.forEach(what=>t.diagnostic(`the host threw with every call a trap: ${what}`));
        assert.deepEqual(differences, []);
    });

test('Direct3D 8: references kept in the guest answer and end as they do with every call a trap',
    { timeout: 300000 }, t=>{
        const { differences, threw } = gate(D3D8, PROGRAMS, STEPS);
        threw.forEach(what=>t.diagnostic(`the host threw with every call a trap: ${what}`));
        assert.deepEqual(differences, []);
    });

/**
 * One program written out, made on both machines after the device: each step
 * names the pointer it calls through, its kind and the method, and may read
 * what the trap machine answered an earlier step.
 *
 * @param {Version} version @param {string} label
 * @param {(call: (on: string, kind: string, method: string, args: Call['args']) => Answer)
 *     => void} program
 */
function scripted(version, label, program){
    const machines = pair(version, label);
    assert.equal(machines.both(createDevice(version)).out, DEVICE);
    program((on, kind, method, args)=>machines.both({ on, kind, method, args }));
    machines.finish();
    return machines.differences;
}

/**
 * The programs each difference the random ones found comes down to, kept so
 * that each stays found: a part's last Release, the device's own count, a
 * state block of everything -- with the controls that already agree.
 *
 * @type {{ label: string, version: Version,
 *     program: Parameters<typeof scripted>[2] }[]}
 */
const PROGRAMS_WRITTEN = [
    ...[
        { label: 'a texture\'s level', kind: 'level', version: D3D9 },
        { label: 'a cube map\'s face', kind: 'face', version: D3D9 },
        { label: 'a volume', kind: 'volume', version: D3D9 },
        { label: 'a texture\'s level', kind: 'level', version: D3D8 },
        { label: 'a cube map\'s face', kind: 'face', version: D3D8 },
        { label: 'a volume', kind: 'volume', version: D3D8 },
    ].map(({ label, kind, version })=>({
        label: `the last reference, given back through ${label}, after a SetTexture in the ring`,
        version,
        /** @type {Parameters<typeof scripted>[2]} */
        program: call=>{
            const container = kind === 'level' ? 'texture' : kind === 'face' ? 'cube'
                : 'volumeTexture';
            const { method, args } = version.creates[container];
            call(DEVICE, 'device', method, args.map(arg=>(arg === 'levels' ? 2 : arg)));
            call('#2', container, kind === 'level' ? 'GetSurfaceLevel'
                : kind === 'face' ? 'GetCubeMapSurface' : 'GetVolumeLevel',
            kind === 'face' ? [1, 0, 'out'] : [0, 'out']);
            call(DEVICE, 'device', 'SetTexture', [0, '#2']);
            call('#2', container, 'Release', []);
            call('#3', kind, 'Release', []);
            call(DEVICE, 'device', 'GetTexture', [0, 'out']);
            call(DEVICE, 'device', 'Release', []);
        },
    })),
    ...[D3D9, D3D8].map(version=>({
        label: 'the device\'s count, with an index buffer released while bound and unbound in'
            + ' the ring',
        version,
        /** @type {Parameters<typeof scripted>[2]} */
        program: call=>{
            const { method, args } = version.creates.indices;
            call(DEVICE, 'device', method, args);
            call(DEVICE, 'device', 'SetIndices', version.setIndices('#2'));
            call('#2', 'indices', 'Release', []);
            call(DEVICE, 'device', 'SetIndices', version.setIndices(0));
            call(DEVICE, 'device', 'AddRef', []);
            call(DEVICE, 'device', 'Release', []);
            call(DEVICE, 'device', 'Release', []);
        },
    })),
    {
        label: 'a state block of everything, made after a call the host answered, applied over'
            + ' a stream set since',
        version: D3D9,
        program: call=>{
            const { method, args } = D3D9.creates.vertices;
            call(DEVICE, 'device', method, args);
            call(DEVICE, 'device', 'CreateStateBlock', [D3DSBT_ALL, 'out']);
            call(DEVICE, 'device', 'SetStreamSource', [0, '#2', 0, 16]);
            call('#3', 'block', 'Apply', []);
            const bound = call(DEVICE, 'device', 'GetStreamSource', [0, 'out', 'out2', 'out3']);
            call(DEVICE, 'device', 'SetStreamSource', [0, 0, 0, 0]);
            for (let refs = bound.out === '#2' ? 2 : 1; refs > 0; refs--)
            {
                call('#2', 'vertices', 'Release', []);
            }
            call('#3', 'block', 'Release', []);
            call(DEVICE, 'device', 'Release', []);
        },
    },
    {
        label: 'a state block of everything, made after a call the host answered, applied over'
            + ' a stream set since',
        version: D3D8,
        program: call=>{
            const { method, args } = D3D8.creates.vertices;
            call(DEVICE, 'device', method, args);
            const token = call(DEVICE, 'device', 'CreateStateBlock', [D3DSBT_ALL, 'out2']).out2;
            call(DEVICE, 'device', 'SetStreamSource', [0, '#2', 16]);
            call(DEVICE, 'device', 'ApplyStateBlock', [token]);
            const bound = call(DEVICE, 'device', 'GetStreamSource', [0, 'out', 'out2']);
            call(DEVICE, 'device', 'SetStreamSource', [0, 0, 0]);
            for (let refs = bound.out === '#2' ? 2 : 1; refs > 0; refs--)
            {
                call('#2', 'vertices', 'Release', []);
            }
            call(DEVICE, 'device', 'DeleteStateBlock', [token]);
            call(DEVICE, 'device', 'Release', []);
        },
    },
];

for (const { label, version, program } of PROGRAMS_WRITTEN)
{
    test(`${version === D3D9 ? 'Direct3D 9' : 'Direct3D 8'}: ${label}`, ()=>{
        assert.deepEqual(scripted(version, label, program), []);
    });
}
