/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A Direct3D device's calls replayed on a second device of the same build.
 *
 * The device the program talks to keeps its model and answers every call, with
 * no renderer behind it: its state, its return codes, the guest pointers its
 * locks hand out. Every call the program makes on it and on the objects it
 * hands out is recorded (`wire.js`) -- the method, the arguments with the
 * device's objects by number, the guest memory each allocation in the call
 * gave, and after an unlock the bytes the lock let the program write -- and
 * played, in the same order, on a device made with the renderer, wherever
 * that one lives. The two take the same calls, so they hold the same state,
 * and the renderer behind the second draws what the first was told to; the
 * guest memory the second reads is the bytes that were sent to it, as they
 * were when they were sent.
 *
 * What only the renderer can answer -- what a device's diagnostics say, when
 * its frames are done -- is asked of the second device (`answered`).
 */

import { OP, SECTION, SERVICE_REF, WAIT, createReader, createSite } from './wire.js';

/**
 * The calls whose answer the played device holds back while it has too many
 * frames in flight, and the caller with it.
 */
const PACED = new Set(['Present']);

/**
 * Getters that answer with plain values from state the recording device holds
 * as the played one does, and hand out no object and take no reference: made
 * on the recording device alone, not sent. A getter that hands out an object
 * stays recorded, for the reference it takes on the played side too.
 */
const PURE_GETTERS = new Set([
    'GetRenderState', 'GetTransform', 'GetTextureStageState', 'GetSamplerState',
    'GetViewport', 'GetMaterial', 'GetLight', 'GetLightEnable', 'GetClipPlane',
    'GetClipStatus', 'GetScissorRect', 'GetNPatchMode', 'GetFVF',
    'GetSoftwareVertexProcessing', 'GetStreamSourceFreq', 'GetCurrentTexturePalette',
    'GetPaletteEntries', 'GetVertexShaderConstant', 'GetVertexShaderConstantF',
    'GetVertexShaderConstantI', 'GetVertexShaderConstantB', 'GetPixelShaderConstant',
    'GetPixelShaderConstantF', 'GetPixelShaderConstantI', 'GetPixelShaderConstantB',
    'GetDesc', 'GetLevelDesc', 'GetLevelCount', 'GetLOD', 'GetPriority', 'GetType',
    'GetAvailableTextureMem', 'GetCreationParameters', 'GetNumberOfSwapChains',
    'GetPresentParameters', 'GetGammaRamp',
]);

/**
 * Whether a method may hand out one of the device's objects through a
 * structure it is given -- what makes one, gets one or asks for one -- so
 * that the structures are looked through after it. Both sides ask this.
 *
 * @param {string} name
 */
function handsOut(name){
    return name.startsWith('Create') || name.startsWith('Get') || name.startsWith('Query')
        || name === 'EndStateBlock';
}

/** The calls that hand out one of a texture's levels as an object of its own. */
const LEVELS = new Set(['GetSurfaceLevel', 'GetCubeMapSurface', 'GetVolumeLevel']);

/** The calls after which the bytes a lock let the program write are sent. */
const UNLOCKS = new Set(['Unlock', 'UnlockRect', 'UnlockCubeRect', 'UnlockBox', 'ReleaseDC']);

/**
 * Whether a call reads no resource's bytes on the played side -- a state set,
 * a lock -- so that bytes unlocked before it wait for one that may (`readBy`
 * says which): a renderer takes a texture's bytes at the first draw that
 * samples it after the unlock, not at the unlock, and the program's writes
 * between the two are in what it draws. A buffer's are taken at the unlock,
 * there and here.
 *
 * @param {string} name
 */
function readsNothing(name){
    return (name.startsWith('Set') && name !== 'SetCursorProperties')
        || name.startsWith('Lock') || name.startsWith('Unlock')
        || name === 'BeginScene' || name === 'LightEnable' || name === 'AddRef'
        || name === 'addRef';
}

/**
 * Which part of a resource a lock or an unlock names: its leading numbers --
 * a level, a face and a level -- up to the structure the lock answers into.
 * A buffer's unlock names none, and so every lock of it.
 *
 * @param {any[]} args
 */
function partOf(args){
    let end = 0;
    while (end < args.length && typeof args[end] === 'number')
    {
        end++;
    }
    return args.slice(0, end).join(',');
}

/**
 * A lock's address and the bytes from it the program may write, null for the
 * rest of the block it lies in; none for a lock taken to read.
 *
 * @typedef {{ address: number, length: number | null, readOnly?: boolean }} Locked
 */

/** D3DLOCK_READONLY, the same number in both versions of the API. */
const LOCK_READ_ONLY = 0x10;

/** D3DLOCK_NOOVERWRITE and DISCARD, the same in both versions too. */
const D3DLOCK_NOOVERWRITE = 0x1000;
/** D3DQUERYTYPE_OCCLUSION. */
const D3DQUERYTYPE_OCCLUSION = 9;
/** What GetData answers while the count is not back. */
const S_FALSE = 1;
const D3DLOCK_DISCARD = 0x2000;

/**
 * Whether a lock was taken to read only: its flags are its last argument, in
 * every lock of both versions.
 *
 * @param {any[]} args
 */
const readOnlyLock = args=>{
    const flags = args[args.length - 1];
    return typeof flags === 'number' && (flags & LOCK_READ_ONLY) !== 0;
};

/**
 * How many bytes from the address a lock handed out it covers, where its
 * arguments say: a buffer's size (zero is the rest of the buffer), or a
 * rectangle's rows at the pitch the lock answered with. Null where they do
 * not -- a whole level, a box -- and the rest of the block is taken.
 *
 * @param {string} name @param {any[]} args @param {any} out  the structure the lock answered into
 * @returns {number | null}
 */
function lockedLength(name, args, out){
    if (name === 'Lock' && typeof args[1] === 'number')
    {
        return args[1] > 0 ? args[1] : null;
    }
    if (name.startsWith('LockRect') && typeof out.Pitch === 'number' && out.Pitch > 0)
    {
        const rect = args.find(arg=>arg !== null && typeof arg === 'object'
            && typeof arg.top === 'number' && typeof arg.bottom === 'number');
        return rect ? Math.max(0, rect.bottom - rect.top) * out.Pitch : null;
    }
    return null;
}

/**
 * The call a recording sends for a reference taken or given back: the count
 * the object was left with (`countTo` in `createRecording`).
 */
const REFS_TO = '#refsTo';

/**
 * Takes or gives back references on a played object until its count is the
 * recorded one's, through its own AddRef and Release, so that a crossing of
 * zero does here what it did there.
 *
 * @param {any} target @param {number} count
 */
function refsTo(target, count){
    for (let guard = 0; target.refCount < count && guard < 0x10000; guard++)
    {
        target.addRef();
    }
    for (let guard = 0; target.refCount > count && guard < 0x10000; guard++)
    {
        target.release();
    }
    return count;
}

/** No arguments to look through. */
const NOTHING = /** @type {readonly unknown[]} */ (Object.freeze([]));

/** The objects found to be a device's: one never stops being one. @type {WeakSet<object>} */
const DEVICE_OBJECTS = new WeakSet();

/**
 * Objects of another model a recording names by number without wrapping
 * them -- a DirectDraw surface a Direct3D 7 device draws into -- which the
 * caller hands back as it got them. @type {WeakSet<object>}
 */
const ADOPTED = new WeakSet();

/**
 * Whether a value is one of a device's objects -- the device, a resource, a
 * swap chain: an object with methods. Descriptors, structures and the objects
 * a call writes its answers into have none.
 *
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
function isDeviceObject(value){
    if (value === null || typeof value !== 'object' || Array.isArray(value)
        || ArrayBuffer.isView(value) || value instanceof Promise)
    {
        return false;
    }
    if (ADOPTED.has(value))
    {
        return false;
    }
    if (DEVICE_OBJECTS.has(value))
    {
        return true;
    }
    // Asked of the same few objects on every call, each with a hundred
    // methods: a walk that stops at the first, and once known, never again.
    for (const key in value)
    {
        if (typeof /** @type {any} */ (value)[key] === 'function')
        {
            DEVICE_OBJECTS.add(value);
            return true;
        }
    }
    return false;
}

/**
 * Numbers every device object a call's answer or arguments reached, in one
 * order on both sides: the answer, then each argument, each with its own
 * members -- where a call puts what it makes, an out-structure's member --
 * and no deeper.
 *
 * @param {unknown} result @param {readonly unknown[]} args
 * @param {(object: Record<string, any>) => void} bind  numbers one not yet numbered
 */
function bindAll(result, args, bind){
    visit(result, bind);
    for (let index = 0; index < args.length; index++)
    {
        visit(args[index], bind);
    }
}

/**
 * @param {unknown} value
 * @param {(object: Record<string, any>) => void} bind
 */
function visit(value, bind){
    if (value === null || typeof value !== 'object' || ArrayBuffer.isView(value)
        || value instanceof Promise)
    {
        return;
    }
    if (isDeviceObject(value))
    {
        bind(value);
        return;
    }
    if (Array.isArray(value))
    {
        for (let index = 0; index < value.length; index++)
        {
            if (isDeviceObject(value[index]))
            {
                bind(value[index]);
            }
        }
        return;
    }
    for (const key in value)
    {
        const member = /** @type {any} */ (value)[key];
        if (isDeviceObject(member))
        {
            bind(member);
        }
    }
}

/**
 * What a played call answers a call the caller waits for: its answer, and the
 * structures it was given as the call left them.
 *
 * @typedef {Object} PlayedAnswer
 * @property {any} answer
 * @property {any[]} outs
 */

/**
 * Where a recording writes its calls, and what it is told of each: the
 * writer's end of `wire.js`, and the carrier that takes what is written.
 *
 * @typedef {Object} Transport
 * @property {ReturnType<typeof import('./wire.js').createWriter>} writer
 * @property {(wait: number, name: string) => any} called
 *     the call just written is whole but for how it is waited for, which this
 *     writes: what it gives back is a waited call's `PlayedAnswer` (or a
 *     promise of one), and for a paced call a promise when the caller is held
 * @property {() => void} recorded  a record that is not a call was written
 * @property {(kind: ShippedKind, bytes: number) => void} [shipped]
 *     bytes of guest memory just copied into the record, by what copied them
 * @property {(name: string, bytes: number) => void} [recordedCall]
 *     a call's record is whole, this many bytes of the batch, copies included
 * @property {import('./lending.js').Lender | null} [lender]
 *     where the played side reads guest memory in place: what an unlock let
 *     the program write is lent rather than copied
 */

/**
 * What copied guest bytes into a record: a buffer's unlock, a texture's or a
 * surface's (a lent one is the lender's to count), what a call read out of
 * the program's memory, or what one wrote into it here.
 *
 * @typedef {'buffers' | 'surfaces' | 'reads' | 'writes'} ShippedKind
 */

/**
 * The recording side: a proxy of the root object the program is given, whose
 * every call -- and every call on what it hands out -- is made on the root and
 * recorded.
 *
 * @param {Object} options
 * @param {Record<string, any>} options.root
 *     the device's root (`IDirect3D9`), made with no renderer behind it
 * @param {(address: number, length: number) => Uint8Array} options.readMemory
 *     the guest memory the locked bytes are read from
 * @param {(address: number, length: number) => Uint8Array} [options.windowMemory]
 *     the same bytes in place, for those copied into the batch before anything
 *     can write them
 * @param {Transport} options.transport
 * @param {(target: any, name: string, args: any[]) => boolean} [options.answered]
 *     whether a call's answer is the other side's: what only its renderer
 *     knows, which the recorded device has no say in. It is given the
 *     device's own objects, so what it asks of them is not recorded.
 * @param {ReadonlySet<string>} [options.answers]  the only methods `answered` is asked about
 * @param {(target: any, name: string, args: any[]) => void} [options.observe]
 *     told every call the recorded device has made, with its own objects, before
 *     `answered` is asked: what the call changed, for a question asked later
 * @returns {{ root: any, allocated: (address: number, bytes: number) => void,
 *     freed: (address: number) => void,
 *     writing: (address: number, length: number) => void,
 *     wrote: (address: number, bytes: Uint8Array) => void,
 *     read: (address: number, bytes: Uint8Array) => void, outward: (value: any) => any,
 *     adopt: (object: object) => void }}
 *     `allocated` and `freed` are told every allocation the recorded device
 *     makes and gives back, `writing` every write it is about to make into guest
 *     memory and `wrote` every one it made,
 *     and `read` -- by a device that reads the program's memory at the call
 *     rather than through its locks -- every read, whose bytes the played
 *     device is sent ahead of the call; `outward` is a value of the device's
 *     as the caller is given it; `adopt` numbers an object of another model,
 *     unwrapped, as the next the played side binds -- what the call just
 *     recorded answered there
 */
export function createRecording(options){
    const { root, readMemory, transport, answered = ()=>false, answers = new Set(),
        observe = null } = options;
    const windowMemory = options.windowMemory ?? readMemory;
    const { writer } = transport;
    const lender = transport.lender ?? null;
    /** @param {ShippedKind} kind @param {{ bytes: Uint8Array }[]} ranges */
    const shippedAs = (kind, ranges)=>{
        if (transport.shipped && ranges.length > 0)
        {
            transport.shipped(kind, ranges.reduce((sum, range)=>sum + range.bytes.length, 0));
        }
    };
    /** @type {WeakMap<object, number>} */
    const numbers = new WeakMap([[root, 0]]);
    let next = 1;
    /** @type {WeakMap<object, any>} */
    const proxies = new WeakMap();
    /** @type {WeakMap<object, object>} */
    const raws = new WeakMap();
    /**
     * The guest address each lock of an object handed out and that is not
     * yet unlocked, by the part of it the lock named, with the bytes from it
     * the lock covers where its arguments say -- null for the rest of the
     * block it lies in.
     *
     * @type {WeakMap<object, Map<string, Locked>>}
     */
    const lockedAt = new WeakMap();
    /**
     * A texture's levels handed out as surfaces or volumes, by the part a
     * lock on the texture names: a level is one lock, whichever of the two
     * takes it and whichever gives it back.
     *
     * @type {WeakMap<object, Map<string, object>>}
     */
    const levelsOf = new WeakMap();
    /** And the other way: the texture a level, a face or a volume is part of. @type {WeakMap<object, object>} */
    const containerOf = new WeakMap();
    /** The stand-ins of the caller's services, passed where the services were. @type {WeakSet<object>} */
    const services = new WeakSet();
    /** The functions the caller put on the device's objects, its own. @type {WeakMap<object, Set<string>>} */
    const owned = new WeakMap();
    /** The allocations held, by address, for the extent of a locked block. */
    const blocks = { starts: /** @type {number[]} */ ([]), ends: /** @type {number[]} */ ([]) };
    /** The current call's allocations. @type {number[] | null} */
    let allocs = null;
    /** What the current call wrote into guest memory. @type {{ address: number, bytes: Uint8Array }[] | null} */
    let writes = null;
    /** What the current call read of guest memory. @type {{ address: number, bytes: Uint8Array }[] | null} */
    let reads = null;
    /** How deep in calls the program is: a call the device makes back through the caller is part of its own. */
    let depth = 0;

    /**
     * Numbers an object, under itself and under its proxy, so that either is
     * found by one look.
     *
     * @param {object} object
     */
    const bind = object=>{
        const own = raws.get(object) ?? object;
        if (!numbers.has(own) && !services.has(own))
        {
            const number = next++;
            numbers.set(own, number);
            const proxy = proxies.get(own);
            if (proxy)
            {
                numbers.set(proxy, number);
            }
        }
    };

    /**
     * What one of the values a call is given is on the wire.
     *
     * @type {import('./wire.js').RefOf}
     */
    const refOf = value=>numbers.get(value) ?? (services.has(value) ? SERVICE_REF : undefined);

    /**
     * An argument as the recorded device takes it: its own objects rather than
     * their proxies, one level into an array.
     *
     * @param {any} value @returns {any}
     */
    const unwrap = value=>{
        const object = raws.get(value);
        if (object)
        {
            return object;
        }
        if (Array.isArray(value) && value.some(one=>raws.has(one)))
        {
            return value.map(one=>raws.get(one) ?? one);
        }
        return value;
    };
    /**
     * After a call: what it wrote into a structure the caller passed, the
     * device's objects in it given as their proxies.
     *
     * @param {any} value
     */
    const wrapInto = value=>{
        if (ArrayBuffer.isView(value) || isDeviceObject(value) || raws.has(value))
        {
            return;
        }
        for (const key in value)
        {
            const member = value[key];
            if (!raws.has(member) && isDeviceObject(member))
            {
                value[key] = proxyOf(member);
            }
        }
    };

    /**
     * The bytes the locks an unlock ends let the program write -- all of the
     * object's locks, when it names no part -- each from the address its lock
     * handed out, for as many bytes as it covered; the object's own bytes when
     * no lock handed any out, as a context over a surface writes them.
     *
     * @param {object} object @param {string} part
     * @returns {Locked[]}
     */
    const lockedRanges = (object, part)=>{
        const locks = lockedAt.get(object);
        /** @type {Locked[]} */
        const ranges = [];
        for (const [named, locked] of locks ?? [])
        {
            if (part === '' || named === part)
            {
                ranges.push(locked);
                locks?.delete(named);
            }
        }
        if (ranges.length === 0)
        {
            for (const [named, level] of levelsOf.get(object) ?? [])
            {
                if (part === '' || named === part)
                {
                    ranges.push(...lockedAt.get(level)?.values() ?? []);
                    lockedAt.delete(level);
                }
            }
        }
        if (ranges.length === 0 && typeof (/** @type {any} */ (object).base) === 'number')
        {
            ranges.push({ address: /** @type {any} */ (object).base, length: null });
        }
        return ranges;
    };

    /**
     * Textures' and surfaces' bytes unlocked and not yet sent, by where they
     * begin, and what each waits on: the texture, for a level's bytes as for
     * its own, or the surface. Sent with the next call that may read them, or
     * that is made on what they belong to.
     */
    const pending = { addresses: /** @type {Map<number, number | null>} */ (new Map()),
        owners: /** @type {Map<number, object>} */ (new Map()) };

    /** What an object's unlocked bytes wait on. @param {object} object */
    const keyOf = object=>containerOf.get(object) ?? object;

    /**
     * Whether bytes waiting on this are a texture's, which the device that
     * draws itself reads at the first draw that samples the texture -- the
     * program's writes up to there are in what it draws -- rather than at the
     * next call that may read anything, as it does a surface's.
     *
     * @param {object} key
     */
    const isTexture = key=>typeof (/** @type {any} */ (key).base) !== 'number';

    /** @param {object} key @returns {(locked: Locked) => void} */
    const pendFor = key=>({ address, length })=>{
        const held = pending.addresses.get(address);
        pending.addresses.set(address, held === undefined ? length
            : held === null || length === null ? null : Math.max(held, length));
        pending.owners.set(address, key);
    };

    /**
     * Which pending bytes a call may read before it answers: a surface's
     * always; a texture's when the call names it, or one of its levels; when
     * it draws, those of the textures bound to the device then; when it is a
     * run of the command ring, those bound before it and those its records
     * name -- all of them when a record applies a state block, whose bindings
     * the run does not name.
     *
     * @param {any} target @param {string} name @param {any[]} args
     * @returns {(key: object) => boolean}
     */
    const readBy = (target, name, args)=>{
        /** @type {Set<object>} */
        const named = new Set([keyOf(target)]);
        let applies = false;
        /** @param {any} value */
        const note = value=>{
            const raw = raws.get(value) ?? value;
            if (raw !== null && typeof raw === 'object')
            {
                named.add(keyOf(raw));
                applies ||= typeof raw.Apply === 'function';
            }
        };
        for (const arg of args)
        {
            if (Array.isArray(arg))
            {
                arg.forEach(note);
            }
            else
            {
                note(arg);
            }
        }
        const run = name === 'commands';
        if (!run && !name.startsWith('Draw'))
        {
            return key=>!isTexture(key) || named.has(key);
        }
        const bound = target.boundTextures;
        if (!bound || (run && applies))
        {
            return ()=>true;
        }
        const sampled = new Set(bound);
        return key=>!isTexture(key) || named.has(key) || sampled.has(key);
    };

    /**
     * The pending bytes a call may read, as a record of their own ahead of
     * it: copied into the batch now, out of the guest's memory in place,
     * before the call can write over them. The rest wait on.
     *
     * @param {(key: object) => boolean} [which]
     */
    const shipPending = (which = ()=>true)=>{
        /** @type {{ address: number, length: number, slot: number }[]} */
        const lent = [];
        /** @type {{ address: number, bytes: Uint8Array }[]} */
        const taken = [];
        for (const [address, length] of pending.addresses)
        {
            if (!which(/** @type {object} */ (pending.owners.get(address))))
            {
                continue;
            }
            pending.addresses.delete(address);
            pending.owners.delete(address);
            const extent = extentOf(address, length);
            const slot = extent > 0 && lender ? lender.lend(address, extent) : -1;
            if (slot >= 0)
            {
                lent.push({ address, length: extent, slot });
            }
            else
            {
                taken.push(...rangeFrom({ address, length }, windowMemory));
            }
        }
        if (lent.length > 0)
        {
            writer.u8(OP.LENT);
            writer.u32(lent.length);
            for (const { address, length, slot } of lent)
            {
                writer.u32(address);
                writer.u32(length);
                writer.u32(slot);
            }
        }
        if (taken.length > 0)
        {
            writer.u8(OP.WROTE);
            writeMemory(taken);
            shippedAs('surfaces', taken);
        }
        if (lent.length > 0 || taken.length > 0)
        {
            transport.recorded();
        }
    };

    /**
     * Before something on this side lets the program, or the device, write a
     * range: a lend of it the played side has not read yet keeps its bytes.
     *
     * @param {number} address @param {number | null} length  null to its block's end
     */
    const claim = (address, length)=>{
        if (lender)
        {
            const extent = extentOf(address, length);
            if (extent > 0)
            {
                lender.claim(address, extent);
            }
        }
    };

    /**
     * What a call let be written that is not a lock's: a surface's bytes a
     * context draws on until it is released, and the copies the caller makes
     * in guest memory after a call that described them.
     *
     * @param {any} target @param {string} name @param {any[]} args
     */
    const claimWritten = (target, name, args)=>{
        if (name === 'GetDC' && typeof target.base === 'number')
        {
            claim(target.base, null);
        }
        for (const arg of args)
        {
            for (const move of Array.isArray(arg?.moves) ? arg.moves : [])
            {
                if (move.rows > 0)
                {
                    claim(move.to, (move.rows - 1) * move.toPitch + move.rowBytes);
                }
            }
        }
    };

    /**
     * How many bytes from an address a range covers: to the end of the
     * allocation it lies in, and never past that; none outside every one.
     *
     * @param {number} address @param {number | null} length
     */
    const extentOf = (address, length)=>{
        const found = blockAt(address);
        if (found < 0)
        {
            return 0;
        }
        const rest = blocks.ends[found] - address;
        return length === null ? rest : Math.min(length, rest);
    };

    /**
     * Where an address's block lies among those held: its index, or -1.
     *
     * @param {number} address
     */
    const blockAt = address=>{
        let lo = 0;
        let hi = blocks.starts.length - 1;
        let found = -1;
        while (lo <= hi)
        {
            const mid = (lo + hi) >> 1;
            if (blocks.starts[mid] <= address)
            {
                found = mid;
                lo = mid + 1;
            }
            else
            {
                hi = mid - 1;
            }
        }
        return found >= 0 && address < blocks.ends[found] ? found : -1;
    };

    /**
     * A locked range's bytes: as many as the lock covered, or from its
     * address to the end of the allocation it lies in, and never past that.
     *
     * @param {Locked} locked
     * @param {(address: number, length: number) => Uint8Array} [read]
     * @returns {{ address: number, bytes: Uint8Array }[]}
     */
    const rangeFrom = ({ address, length }, read = readMemory)=>{
        const extent = extentOf(address, length);
        return extent > 0 ? [{ address, bytes: read(address, extent) }] : [];
    };

    /**
     * A call's answer as the caller is given it: one of the device's objects
     * as its proxy, and a structure holding some as a copy holding theirs --
     * the device's own is left as it is, since it may be its state.
     *
     * @param {any} result
     */
    const answerOf = result=>{
        if (result === null || typeof result !== 'object' || ArrayBuffer.isView(result)
            || result instanceof Promise || Array.isArray(result))
        {
            return result;
        }
        if (isDeviceObject(result))
        {
            return proxyOf(result);
        }
        /** @type {Record<string, any> | null} */
        let copy = null;
        for (const key in result)
        {
            if (isDeviceObject(result[key]))
            {
                /** @type {Record<string, any>} */
                const held = copy ?? { ...result };
                held[key] = proxyOf(result[key]);
                copy = held;
            }
        }
        return copy ?? result;
    };

    /**
     * Each occlusion query's count as the renderer answers it, asked once its
     * end is issued and taken when it comes: a driver answers S_FALSE until the
     * GPU has counted, and a program polls. Waiting for the answer instead held
     * the program for the replay of everything recorded before the ask, every
     * frame -- tens of milliseconds, a quarter of a second at worst.
     *
     * @type {WeakMap<object, { reply: PlayedAnswer | null, frame: number,
     *     asked: Promise<void> }>}
     */
    const counts = new WeakMap();
    /**
     * Presents recorded so far. A count asked in one frame and polled in a
     * later one is waited for: hardware has counted by then, and a program
     * that asks every frame and reads the frame after never saw a count when
     * the renderer answered later than that -- a sun it thought hidden, a
     * world drawn without its light.
     */
    let framesRecorded = 0;

    /**
     * The system-memory surfaces a GetRenderTargetData is still filling, each
     * with when it will have: the copy is queued as a driver queues it, and
     * only reading the surface waits for its pixels. Waiting at the copy held
     * the program for every frame the renderer had still to play, a quarter of
     * a second at worst, though it read the pixels frames later.
     *
     * @type {WeakMap<object, Promise<void>>}
     */
    const readbacks = new WeakMap();

    /**
     * What a played call wrote into a structure the caller passed, into the
     * caller's: its plain values, the device's objects left as the recorded
     * call gave them.
     *
     * @param {any} into @param {any} from
     */
    const copyOut = (into, from)=>{
        if (into === null || typeof into !== 'object' || from === null || typeof from !== 'object'
            || ArrayBuffer.isView(into) || raws.has(into) || isDeviceObject(into)
            || services.has(into) || ADOPTED.has(into))
        {
            return;
        }
        for (const key of Object.keys(from))
        {
            const value = from[key];
            if (value === null || typeof value !== 'object')
            {
                if (value !== undefined)
                {
                    into[key] = value;
                }
            }
            else if (ArrayBuffer.isView(value))
            {
                into[key] = /** @type {any} */ (value).slice();
            }
            else if (!isDeviceObject(value) && !isDeviceObject(into[key]))
            {
                if (into[key] === null || typeof into[key] !== 'object')
                {
                    into[key] = Array.isArray(value) ? [] : {};
                }
                copyOut(into[key], value);
            }
        }
    };

    /**
     * A service of the caller's as a call is given it: each of its functions
     * the service's own, what it answers kept for the played side.
     *
     * @param {Record<string, any>} service @param {any[]} replies
     */
    const serviceOf = (service, replies)=>{
        /** @type {Record<string, any>} */
        const standIn = {};
        for (const key of Object.keys(service))
        {
            const value = service[key];
            standIn[key] = typeof value === 'function'
                ? (/** @type {any[]} */ ...args)=>{
                    const answer = value.apply(service, args);
                    replies.push(answer);
                    return answer;
                }
                : value;
        }
        services.add(standIn);
        return standIn;
    };

    /**
     * `applied` with the argument at `index` as the device takes it, copied
     * from `args` the first time one differs.
     *
     * @param {any[]} applied @param {any[]} args @param {number} index
     */
    const unwrapInto = (applied, args, index)=>{
        const arg = args[index];
        if (arg === null || typeof arg !== 'object')
        {
            return applied;
        }
        const own = unwrap(arg);
        if (own === arg)
        {
            return applied;
        }
        const copy = applied === args ? args.slice() : applied;
        copy[index] = own;
        return copy;
    };

    /** @param {{ address: number, bytes: Uint8Array }[]} list */
    const writeMemory = list=>{
        writer.u32(list.length);
        for (let index = 0; index < list.length; index++)
        {
            writer.memory(list[index].address, list[index].bytes);
        }
    };

    /** The number `refsTo` has in the writer's table, once it has one. */
    let refsToId = -1;
    const countSite = createSite();

    /**
     * A reference taken or given back here, sent as the count it left. The
     * guest takes and gives back references the host never sees -- every one
     * that is not a zero crossing (`bridge/internal/vtable.js`) -- so the
     * played object's count follows them only by being told what this one's
     * is whenever it comes through here; a last Release then ends it there
     * too, however many references the guest took and gave back on the way.
     *
     * @param {object} target @param {number} number @param {Function} method
     * @param {any[]} applied
     */
    const countTo = (target, number, method, applied)=>{
        depth++;
        let result;
        try
        {
            result = method.apply(target, applied);
        }
        finally
        {
            depth--;
        }
        if (refsToId < 0)
        {
            writer.u8(OP.CALL);
            writer.u32(number);
            refsToId = writer.string(REFS_TO);
            writer.u8(1);
        }
        else
        {
            writer.call(number, refsToId, 1);
        }
        writer.value(result >>> 0, refOf, 0, countSite);
        writer.u8(0);
        transport.called(WAIT.NONE, REFS_TO);
        return result;
    };

    /**
     * A method of one of the device's objects as the caller calls it: made on
     * the object, recorded and sent.
     *
     * @param {object} target @param {string} name @param {Function} method
     * @returns {(...args: any[]) => any}
     */
    const methodOf = (target, name, method)=>{
        const unlocking = UNLOCKS.has(name);
        // A buffer's bytes go with its unlock; a texture's or a surface's
        // wait (`readsNothing`).
        const deferring = unlocking && name !== 'Unlock';
        const quiet = readsNothing(name);
        const locking = name.startsWith('Lock');
        const paced = PACED.has(name);
        const mayAnswer = answers.has(name);
        const making = handsOut(name);
        const pure = PURE_GETTERS.has(name);
        const counting = name === 'addRef' || name === 'release';
        /** The method's number in the writer's table, once it has one. */
        let nameId = -1;
        /** @type {number | undefined} */
        let number;
        /** Each argument's place, for the shapes of the structures passed there. */
        /** @type {import('./wire.js').Site[]} */
        const sites = [];
        /** @type {(...args: any[]) => any} */
        const call = (...args)=>{
            const count = args.length;
            // A read of a surface a copy back from the GPU is still filling
            // waits for it, then is made.
            const filling = name === 'LockRect' || name === 'GetDC' ? readbacks.get(target)
                : undefined;
            if (filling)
            {
                return filling.then(()=>call(...args));
            }
            /** What the device is given: its own objects rather than their proxies. */
            let applied = args;
            if (depth > 0 || pure)
            {
                for (let index = 0; index < count; index++)
                {
                    applied = unwrapInto(applied, args, index);
                }
                return method.apply(target, applied);
            }
            // A poll of an occlusion count already asked is answered here and
            // recorded nowhere: the played side has nothing to do with it, and
            // a program polls hundreds of thousands of times a minute.
            if (name === 'Present')
            {
                framesRecorded++;
            }
            const known = name === 'GetData' ? counts.get(target) : undefined;
            if (known)
            {
                if (!known.reply)
                {
                    return framesRecorded > known.frame
                        ? known.asked.then(()=>call(...args)) : S_FALSE;
                }
                for (let index = 0; index < count; index++)
                {
                    copyOut(args[index], known.reply.outs[index]);
                }
                return known.reply.answer;
            }
            if (pending.addresses.size > 0 && !quiet)
            {
                shipPending(readBy(target, name, args));
            }
            else if (pending.addresses.size > 0 && !unlocking
                && [...pending.owners.values()].includes(keyOf(target)))
            {
                shipPending();
            }
            number ??= /** @type {number} */ (numbers.get(target));
            if (counting && typeof (/** @type {any} */ (target)).refCount === 'number')
            {
                return countTo(target, number, method, applied);
            }
            /** @type {any[] | null} */
            let replies = null;
            const start = writer.size();
            if (nameId < 0)
            {
                writer.u8(OP.CALL);
                writer.u32(number);
                nameId = writer.string(name);
                writer.u8(count);
            }
            else
            {
                writer.call(number, nameId, count);
            }
            for (let index = 0; index < count; index++)
            {
                const arg = args[index];
                if (writer.value(arg, refOf, 0, sites[index] ??= createSite()))
                {
                    // A service of the caller's: the device is given one that
                    // keeps what it answers.
                    replies ??= [];
                    args[index] = serviceOf(arg, replies);
                }
                applied = unwrapInto(applied, args, index);
            }
            /** @type {{ address: number, bytes: Uint8Array }[] | null} */
            let shipped = null;
            if (unlocking)
            {
                // What a lock taken to read let the program see is the device's
                // own, and goes nowhere: a program that reads its back buffer
                // every frame would otherwise send the whole frame back.
                const ranges = lockedRanges(target, name === 'ReleaseDC' ? '' : partOf(args))
                    .filter(range=>!range.readOnly);
                if (deferring)
                {
                    ranges.forEach(pendFor(keyOf(target)));
                }
                else
                {
                    const unlocked = ranges.flatMap(range=>rangeFrom(range));
                    shippedAs('buffers', unlocked);
                    shipped = [...shipped ?? [], ...unlocked];
                }
            }
            allocs = null;
            writes = null;
            reads = null;
            depth++;
            let result;
            let failed = true;
            try
            {
                result = method.apply(target, applied);
                failed = false;
            }
            finally
            {
                depth--;
                // What the call set, which the checker cannot follow into it.
                const made = /** @type {number[] | null} */ (allocs);
                const wrote = /** @type {{ address: number, bytes: Uint8Array }[] | null} */ (writes);
                const read = /** @type {{ address: number, bytes: Uint8Array }[] | null} */ (reads);
                allocs = null;
                writes = null;
                reads = null;
                if (read)
                {
                    shippedAs('reads', read);
                    shipped = shipped ? [...shipped, ...read] : read;
                }
                // Whatever the call did, the record is finished, so the next
                // one starts where it should.
                const shipping = shipped !== null && shipped.length > 0;
                writer.u8((made ? SECTION.ALLOCS : 0) | (replies ? SECTION.REPLIES : 0)
                    | (shipping ? SECTION.SHIP : 0) | (wrote ? SECTION.WROTE : 0));
                if (made)
                {
                    writer.u32(made.length);
                    for (let index = 0; index < made.length; index++)
                    {
                        writer.u32(made[index]);
                    }
                }
                if (replies)
                {
                    writer.u32(replies.length);
                    for (let index = 0; index < replies.length; index++)
                    {
                        writer.value(replies[index], refOf, 1);
                    }
                }
                if (shipping)
                {
                    writeMemory(/** @type {{ address: number, bytes: Uint8Array }[]} */ (shipped));
                }
                if (wrote)
                {
                    writeMemory(wrote);
                    shippedAs('writes', wrote);
                }
                // Which calls the batches are made of, for a report; a batch
                // sent while the record was written leaves it uncounted.
                if (import.meta.BOTTLIFY_DIAGNOSTICS !== false && writer.size() >= start)
                {
                    transport.recordedCall?.(name, writer.size() - start);
                }
                if (failed)
                {
                    // The record is sent as it is, and what the played device
                    // makes of it is its own failure, not this one's.
                    try
                    {
                        transport.called(WAIT.NONE, name);
                    }
                    catch {
                        // The caller is told of the recorded call's failure.
                    }
                }
            }
            bindAll(result, making ? args : NOTHING, bind);
            if (LEVELS.has(name))
            {
                const out = args[count - 1];
                const level = out?.surface ?? out?.volume;
                if (level)
                {
                    const levels = levelsOf.get(target) ?? new Map();
                    levels.set(partOf(args), raws.get(level) ?? level);
                    levelsOf.set(target, levels);
                    containerOf.set(raws.get(level) ?? level, target);
                }
            }
            // A lock taken to read is marked so whatever the answer: a render
            // target's comes from the played device later, and an unlock with
            // no lock on record sends the whole surface.
            const readOnly = locking && readOnlyLock(args);
            if (readOnly)
            {
                const locks = lockedAt.get(target) ?? new Map();
                locks.set(partOf(args), { address: 0, length: 0, readOnly });
                lockedAt.set(target, locks);
            }
            if (making || (locking && !readOnly))
            {
                for (let index = 0; index < count; index++)
                {
                    const arg = args[index];
                    if (arg === null || typeof arg !== 'object')
                    {
                        continue;
                    }
                    if (making)
                    {
                        wrapInto(arg);
                    }
                    const bits = arg.pBits;
                    if (locking && typeof bits === 'number')
                    {
                        const length = lockedLength(name, args, arg);
                        const locks = lockedAt.get(target) ?? new Map();
                        locks.set(partOf(args), { address: bits, length });
                        lockedAt.set(target, locks);
                        if (name === 'Lock' && ((args[3] ?? 0)
                            & (D3DLOCK_NOOVERWRITE | D3DLOCK_DISCARD)) !== D3DLOCK_NOOVERWRITE)
                        {
                            // A buffer's lock but NOOVERWRITE alone lets the program write
                            // anywhere in it afterwards -- DISCARD's fresh storage, or a
                            // plain lock's wait for the GPU -- under NOOVERWRITE locks
                            // the guest takes itself (`seam/shadow.js`): all of it is
                            // claimed now.
                            claim(bits - (args[0] ?? 0), null);
                        }
                        else
                        {
                            claim(bits, length);
                        }
                    }
                }
            }
            if (lender)
            {
                claimWritten(target, name, args);
            }
            if (!failed)
            {
                observe?.(target, name, applied);
            }
            if (paced)
            {
                const held = transport.called(WAIT.PACED, name);
                return held instanceof Promise ? held.then(()=>result) : result;
            }
            if (name === 'Issue')
            {
                // A new measurement: what was counted before is not its count.
                counts.delete(target);
            }
            if (!mayAnswer || !answered(target, name, applied))
            {
                transport.called(WAIT.NONE, name);
                return typeof result === 'object' ? answerOf(result) : result;
            }
            if (name === 'GetRenderTargetData' && applied[1])
            {
                const into = applied[1];
                const filled = Promise.resolve(transport.called(WAIT.ANSWER, name))
                    .then(()=>{}, ()=>{});
                readbacks.set(into, filled);
                filled.then(()=>{
                    if (readbacks.get(into) === filled)
                    {
                        readbacks.delete(into);
                    }
                });
                return typeof result === 'object' ? answerOf(result) : result;
            }
            if (name === 'GetData' && /** @type {any} */ (target)?.type === D3DQUERYTYPE_OCCLUSION)
            {
                const asking = { reply: /** @type {PlayedAnswer | null} */ (null),
                    frame: framesRecorded, asked: Promise.resolve() };
                counts.set(target, asking);
                asking.asked = Promise.resolve(transport.called(WAIT.ANSWER, name)).then(played=>{
                    // Still this measurement's; an answer that is not a count
                    // yet is asked again at the next poll.
                    if (counts.get(target) === asking)
                    {
                        if (played.answer === 0)
                        {
                            asking.reply = played;
                        }
                        else
                        {
                            counts.delete(target);
                        }
                    }
                }, ()=>{
                    counts.delete(target);
                });
                return S_FALSE;
            }
            /** @param {PlayedAnswer} played */
            const take = played=>{
                for (let index = 0; index < args.length; index++)
                {
                    copyOut(args[index], played.outs[index]);
                }
                return played.answer;
            };
            const reply = /** @type {PlayedAnswer | Promise<PlayedAnswer>} */ (
                transport.called(WAIT.ANSWER, name));
            return reply instanceof Promise ? reply.then(take) : take(reply);
        };
        return call;
    };

    /**
     * A proxy's handler, its own: what the proxy's methods are as the caller
     * calls them is kept in it, found without a look-up by object.
     *
     * @returns {ProxyHandler<any>}
     */
    const handlerOf = ()=>{
        /**
         * Each method as the caller calls it, made once for each method the
         * object has under that name.
         *
         * @type {Map<string, { of: Function, as: Function }>}
         */
        const made = new Map();
        return {
            get(target, key){
                if (key === 'lendsMemory')
                {
                    // Asked by the seam's guest routines (`seam/shadow.js`):
                    // what is unlocked is read later, and a lock in the
                    // guest must come here to claim it first.
                    return lender !== null;
                }
                const value = Reflect.get(target, key);
                if (typeof value === 'function' && typeof key === 'string')
                {
                    const known = made.get(key);
                    if (known !== undefined && known.of === value)
                    {
                        return known.as;
                    }
                    if (owned.get(target)?.has(key))
                    {
                        return value;
                    }
                    const method = methodOf(target, key, value);
                    made.set(key, { of: value, as: method });
                    return method;
                }
                return typeof key === 'string' ? reached(target, key, value) : value;
            },
            set,
        };
    };

    /**
     * A property read that is not a method: one of the device's objects is
     * given as its proxy, and numbered on both sides the first time.
     *
     * @param {object} target @param {string} key @param {any} value
     */
    const reached = (target, key, value)=>{
        // An object's count is this side's bookkeeping, kept where the guest
        // moves it: the played object is told what it comes to (`countTo`).
        if (key === 'counter' || !isDeviceObject(value))
        {
            return value;
        }
        if (!numbers.has(value))
        {
            bind(value);
            writer.u8(OP.GET);
            writer.u32(/** @type {number} */ (numbers.get(target)));
            writer.string(key);
            transport.recorded();
        }
        return proxyOf(value);
    };

    /** @type {NonNullable<ProxyHandler<any>['set']>} */
    const set = (target, key, value)=>{
        if (typeof key === 'string' && typeof value === 'function')
        {
            // The caller's own wrapping of a method, on its side alone:
            // what it calls through is recorded as it is called.
            const keys = owned.get(target) ?? new Set();
            keys.add(key);
            owned.set(target, keys);
            return Reflect.set(target, key, value);
        }
        if (typeof key === 'string')
        {
            writer.u8(OP.SET);
            writer.u32(/** @type {number} */ (numbers.get(target)));
            writer.string(key);
            writer.value(value, refOf);
            transport.recorded();
        }
        return Reflect.set(target, key, unwrap(value));
    };
    /** @param {object} given */
    const proxyOf = given=>{
        const object = raws.get(given) ?? given;
        let proxy = proxies.get(object);
        if (!proxy)
        {
            proxy = new Proxy(object, handlerOf());
            proxies.set(object, proxy);
            raws.set(proxy, object);
            const number = numbers.get(object);
            if (number !== undefined)
            {
                numbers.set(proxy, number);
            }
        }
        return proxy;
    };

    return {
        root: proxyOf(root),
        outward: answerOf,
        allocated(address, bytes){
            if (depth > 0)
            {
                (allocs ??= []).push(address);
            }
            let at = blocks.starts.length;
            while (at > 0 && blocks.starts[at - 1] > address)
            {
                at--;
            }
            blocks.starts.splice(at, 0, address);
            blocks.ends.splice(at, 0, address + bytes);
        },
        freed(address){
            const found = blockAt(address);
            if (found >= 0 && blocks.starts[found] === address)
            {
                claim(address, null);
                blocks.starts.splice(found, 1);
                blocks.ends.splice(found, 1);
            }
        },
        writing: (address, length)=>claim(address, length),
        wrote(address, bytes){
            if (depth > 0)
            {
                (writes ??= []).push({ address, bytes: bytes.slice() });
                return;
            }
            writer.u8(OP.WROTE);
            writer.u32(1);
            writer.memory(address, bytes);
            shippedAs('writes', [{ bytes }]);
            transport.recorded();
        },
        adopt(object){
            ADOPTED.add(object);
            numbers.set(object, next++);
        },
        read(address, bytes){
            // Written into the record when the call is finished, before the
            // program runs again: a window the read handed out still holds
            // the bytes it read, since no call writes what it read.
            if (depth > 0)
            {
                (reads ??= []).push({ address, bytes });
                return;
            }
            writer.u8(OP.WROTE);
            writer.u32(1);
            writer.memory(address, bytes);
            shippedAs('reads', [{ bytes }]);
            transport.recorded();
        },
    };
}

/**
 * The playing side: the calls a recording wrote, made in their order on a
 * root of the same build, with the same objects by the same numbers.
 *
 * @param {Object} options
 * @param {Record<string, any>} options.root
 * @param {(address: number, bytes: Uint8Array) => void} options.ship
 *     where the bytes a lock let the program write are put: the guest memory
 *     this side reads
 * @param {(address: number, length: number) => Uint8Array} options.read
 *     that memory read, for the copies a call describes and its caller makes
 * @param {ReturnType<typeof import('./lending.js').createBorrower>} [options.borrow]
 *     the guest memory a recording lent, read in place
 * @returns {{ play: (call: import('./wire.js').ReadCall) => any, allocate: () => number,
 *     object: (number: number) => any,
 *     read: (buffer: ArrayBuffer, each: (call: import('./wire.js').ReadCall) => boolean | void)
 *         => void }}
 *     `play` answers a waited call with its `PlayedAnswer` (or a promise of
 *     one), a paced one with the promise its device holds the caller on, and
 *     any other with what the call answered;
 *     `allocate` is the played device's, the next address its recorded call
 *     was given; `read` reads a batch of calls
 */
export function createPlayer({ root, ship, read, borrow }){
    /** @type {object[]} */
    const objects = [root];
    /** @type {WeakSet<object>} */
    const known = new WeakSet([root]);
    /** @type {number[]} */
    let allocs = [];
    /** The call being played, for what a failure says. @type {string} */
    let playing = '';
    /** @type {any[]} */
    let replies = [];
    /**
     * Every service of the caller's, played: whatever is asked of it, the
     * answer the caller's gave in the recorded call.
     */
    const standIn = new Proxy({}, {
        get: (_, key)=>(typeof key === 'string' ? ()=>replies.shift() : undefined),
    });
    const reader = createReader({ ref: number=>objects[number], service: ()=>standIn });

    /** @param {object} object */
    const bind = object=>{
        if (!known.has(object))
        {
            known.add(object);
            objects.push(object);
        }
    };

    /**
     * The copies a call described in a structure it was given, made in the
     * memory this side reads as the caller makes them in the guest's.
     *
     * @param {any[]} args
     */
    const move = args=>{
        for (const arg of args)
        {
            for (const one of Array.isArray(arg?.moves) ? arg.moves : [])
            {
                for (let row = 0; row < one.rows; row++)
                {
                    ship(one.to + row * one.toPitch,
                        read(one.from + row * one.fromPitch, one.rowBytes));
                }
            }
        }
    };

    return {
        play(call){
            const target = /** @type {any} */ (objects[call.t]);
            if (call.op === OP.GET)
            {
                bindAll(target[/** @type {string} */ (call.m)], [], bind);
                return undefined;
            }
            if (call.op === OP.SET)
            {
                target[/** @type {string} */ (call.m)] = call.v;
                return undefined;
            }
            if (call.op === OP.LENT)
            {
                if (!borrow)
                {
                    throw new Error('remote: guest memory lent to a side that cannot read it');
                }
                for (const { address, length, slot } of call.lent ?? [])
                {
                    borrow(slot, address, length, bytes=>ship(address, bytes));
                }
                return undefined;
            }
            if (call.op !== OP.CALL)
            {
                for (const { address, bytes } of call.wrote ?? [])
                {
                    ship(address, bytes);
                }
                return undefined;
            }
            for (const { address, bytes } of call.ship ?? [])
            {
                ship(address, bytes);
            }
            allocs = call.allocs ?? [];
            replies = call.replies ?? [];
            playing = /** @type {string} */ (call.m);
            const args = /** @type {any[]} */ (call.a);
            if (playing === REFS_TO)
            {
                return refsTo(target, args[0]);
            }
            // A Reset the recording answered is played as answered: what the
            // program holds is the recording's count, not this side's.
            const answer = playing === 'Reset' ? target.Reset(...args, allocs.length > 0)
                : target[playing](...args);
            bindAll(answer, handsOut(playing) ? args : NOTHING, bind);
            if (allocs.length > 0)
            {
                // What the played device answered says which way it went: a
                // refusal (a Reset the device took as lost, with resources it
                // still counts live) or a call that made fewer objects.
                const said = typeof answer === 'number' ? `0x${(answer >>> 0).toString(16)}`
                    : answer instanceof Promise ? 'a promise' : typeof answer;
                throw new Error(`remote: ${playing} allocated less on the played device: it`
                    + ` answered ${said}, ${allocs.length} of the recording's objects not made`);
            }
            const later = answer instanceof Promise;
            if (!later)
            {
                move(args);
            }
            for (const { address, bytes } of call.wrote ?? [])
            {
                ship(address, bytes);
            }
            if (later)
            {
                const settled = answer.then(value=>{
                    move(args);
                    return { answer: value, outs: args };
                });
                if (call.wait === WAIT.ANSWER)
                {
                    return settled;
                }
                return call.wait === WAIT.PACED ? answer : undefined;
            }
            // An unwaited call's answer is what a carrier that is asked for
            // it after the call -- what a device says of itself -- passes on.
            return call.wait === WAIT.ANSWER ? { answer, outs: args } : answer;
        },
        object: number=>objects[number],
        allocate(){
            const address = allocs.shift();
            if (address === undefined)
            {
                throw new Error('remote: the played device allocated more than the recorded one'
                    + ` in ${playing}`);
            }
            return address;
        },
        read: (buffer, each)=>reader.read(buffer, each),
    };
}

/**
 * A guest memory of only the bytes sent to it, in 64 KiB pages made as they
 * are written: what a renderer behind a played device reads.
 */
export function createMirror(){
    const SHIFT = 16;
    const SIZE = 1 << SHIFT;
    /** @type {Map<number, Uint8Array>} */
    const pages = new Map();
    /** @param {number} page */
    const pageOf = page=>{
        let bytes = pages.get(page);
        if (!bytes)
        {
            bytes = new Uint8Array(SIZE);
            pages.set(page, bytes);
        }
        return bytes;
    };
    return {
        /** @param {number} address @param {Uint8Array} bytes */
        write(address, bytes){
            let done = 0;
            while (done < bytes.length)
            {
                const at = (address + done) >>> 0;
                const offset = at & (SIZE - 1);
                const take = Math.min(SIZE - offset, bytes.length - done);
                pageOf(at >>> SHIFT).set(bytes.subarray(done, done + take), offset);
                done += take;
            }
        },
        /** @param {number} address @param {number} length @returns {Uint8Array} */
        read(address, length){
            const out = new Uint8Array(length);
            let done = 0;
            while (done < length)
            {
                const at = (address + done) >>> 0;
                const offset = at & (SIZE - 1);
                const take = Math.min(SIZE - offset, length - done);
                const page = pages.get(at >>> SHIFT);
                if (page)
                {
                    out.set(page.subarray(offset, offset + take), done);
                }
                done += take;
            }
            return out;
        },
        /**
         * The bytes in place when they lie in one page that holds them, a
         * copy otherwise: a window, which its reader copies from before the
         * next call writes the mirror again.
         *
         * @param {number} address @param {number} length @returns {Uint8Array}
         */
        window(address, length){
            const at = address >>> 0;
            const offset = at & (SIZE - 1);
            const page = offset + length <= SIZE ? pages.get(at >>> SHIFT) : undefined;
            return page ? page.subarray(offset, offset + length) : this.read(address, length);
        },
    };
}
