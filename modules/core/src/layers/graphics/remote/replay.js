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

/** The calls after which the bytes a lock let the program write are sent. */
const UNLOCKS = new Set(['Unlock', 'UnlockRect', 'UnlockCubeRect', 'UnlockBox', 'ReleaseDC']);

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

/** No arguments to look through. */
const NOTHING = /** @type {readonly unknown[]} */ (Object.freeze([]));

/** The objects found to be a device's: one never stops being one. @type {WeakSet<object>} */
const DEVICE_OBJECTS = new WeakSet();

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
 * @param {Transport} options.transport
 * @param {(target: any, name: string, args: any[]) => boolean} [options.answered]
 *     whether a call's answer is the other side's: what only its renderer
 *     knows, which the recorded device has no say in. It is given the
 *     device's own objects, so what it asks of them is not recorded.
 * @param {ReadonlySet<string>} [options.answers]  the only methods `answered` is asked about
 * @returns {{ root: any, allocated: (address: number, bytes: number) => void,
 *     freed: (address: number) => void,
 *     wrote: (address: number, bytes: Uint8Array) => void, outward: (value: any) => any }}
 *     `allocated` and `freed` are told every allocation the recorded device
 *     makes and gives back, and `wrote` every write it makes into guest
 *     memory; `outward` is a value of the device's as the caller is given it
 */
export function createRecording(options){
    const { root, readMemory, transport, answered = ()=>false, answers = new Set() } = options;
    const { writer } = transport;
    /** @type {WeakMap<object, number>} */
    const numbers = new WeakMap([[root, 0]]);
    let next = 1;
    /** @type {WeakMap<object, any>} */
    const proxies = new WeakMap();
    /** @type {WeakMap<object, object>} */
    const raws = new WeakMap();
    /**
     * The guest address each lock of an object handed out and that is not
     * yet unlocked, by the part of it the lock named.
     *
     * @type {WeakMap<object, Map<string, number>>}
     */
    const lockedAt = new WeakMap();
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
     * The guest bytes the locks an unlock ends let the program write -- all of
     * the object's, when it names no part -- each from the address its lock
     * handed out to the end of the block that lies in; the object's own bytes
     * when no lock handed any out, as a context over a surface writes them.
     *
     * @param {object} object @param {string} part
     * @returns {{ address: number, bytes: Uint8Array }[]}
     */
    const lockedBytes = (object, part)=>{
        const locks = lockedAt.get(object);
        /** @type {number[]} */
        const addresses = [];
        for (const [named, address] of locks ?? [])
        {
            if (part === '' || named === part)
            {
                addresses.push(address);
                locks?.delete(named);
            }
        }
        if (addresses.length === 0 && typeof (/** @type {any} */ (object).base) === 'number')
        {
            addresses.push(/** @type {any} */ (object).base);
        }
        return addresses.flatMap(blockFrom);
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
     * From an address to the end of the allocation it lies in.
     *
     * @param {number} address
     * @returns {{ address: number, bytes: Uint8Array }[]}
     */
    const blockFrom = address=>{
        const found = blockAt(address);
        return found < 0 ? []
            : [{ address, bytes: readMemory(address, blocks.ends[found] - address) }];
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
     * What a played call wrote into a structure the caller passed, into the
     * caller's: its plain values, the device's objects left as the recorded
     * call gave them.
     *
     * @param {any} into @param {any} from
     */
    const copyOut = (into, from)=>{
        if (into === null || typeof into !== 'object' || from === null || typeof from !== 'object'
            || ArrayBuffer.isView(into) || raws.has(into) || isDeviceObject(into)
            || services.has(into))
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

    /**
     * A method of one of the device's objects as the caller calls it: made on
     * the object, recorded and sent.
     *
     * @param {object} target @param {string} name @param {Function} method
     * @returns {(...args: any[]) => any}
     */
    const methodOf = (target, name, method)=>{
        const unlocking = UNLOCKS.has(name);
        const locking = name.startsWith('Lock');
        const paced = PACED.has(name);
        const mayAnswer = answers.has(name);
        const making = handsOut(name);
        /** The method's number in the writer's table, once it has one. */
        let nameId = -1;
        /** @type {number | undefined} */
        let number;
        /** Each argument's place, for the shapes of the structures passed there. */
        /** @type {import('./wire.js').Site[]} */
        const sites = [];
        return (/** @type {any[]} */ ...args)=>{
            const count = args.length;
            /** What the device is given: its own objects rather than their proxies. */
            let applied = args;
            if (depth > 0)
            {
                for (let index = 0; index < count; index++)
                {
                    applied = unwrapInto(applied, args, index);
                }
                return method.apply(target, applied);
            }
            /** @type {any[] | null} */
            let replies = null;
            number ??= /** @type {number} */ (numbers.get(target));
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
            const shipped = unlocking
                ? lockedBytes(target, name === 'ReleaseDC' ? '' : partOf(args))
                : null;
            allocs = null;
            writes = null;
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
                allocs = null;
                writes = null;
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
            if (making || locking)
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
                        const locks = lockedAt.get(target) ?? new Map();
                        locks.set(partOf(args), bits);
                        lockedAt.set(target, locks);
                    }
                }
            }
            if (paced)
            {
                const held = transport.called(WAIT.PACED, name);
                return held instanceof Promise ? held.then(()=>result) : result;
            }
            if (!mayAnswer || !answered(target, name, applied))
            {
                transport.called(WAIT.NONE, name);
                return typeof result === 'object' ? answerOf(result) : result;
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
        if (!isDeviceObject(value))
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
                blocks.starts.splice(found, 1);
                blocks.ends.splice(found, 1);
            }
        },
        wrote(address, bytes){
            if (depth > 0)
            {
                (writes ??= []).push({ address, bytes: bytes.slice() });
                return;
            }
            writer.u8(OP.WROTE);
            writer.u32(1);
            writer.memory(address, bytes);
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
 * @returns {{ play: (call: import('./wire.js').ReadCall) => any, allocate: () => number,
 *     object: (number: number) => any,
 *     read: (buffer: ArrayBuffer, each: (call: import('./wire.js').ReadCall) => boolean | void)
 *         => void }}
 *     `play` answers a waited call with its `PlayedAnswer` (or a promise of
 *     one), and a paced one with the promise its device holds the caller on;
 *     `allocate` is the played device's, the next address its recorded call
 *     was given; `read` reads a batch of calls
 */
export function createPlayer({ root, ship, read }){
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
            const answer = target[playing](...args);
            bindAll(answer, handsOut(playing) ? args : NOTHING, bind);
            if (allocs.length > 0)
            {
                throw new Error(`remote: ${playing} allocated less on the played device`);
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
            return call.wait === WAIT.ANSWER ? { answer, outs: args } : undefined;
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
    };
}
