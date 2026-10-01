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
 * hands out is recorded -- the method, the arguments with the device's objects
 * by number, the guest memory each allocation in the call gave, and after an
 * unlock the bytes the lock let the program write -- and played, in the same
 * order, on a device made with the renderer, wherever that one lives. The two
 * take the same calls, so they hold the same state, and the renderer behind
 * the second draws what the first was told to; the guest memory the second
 * reads is the bytes that were sent to it, as they were when they were sent.
 *
 * What only the renderer can answer -- what a device's diagnostics say, when
 * its frames are done -- is asked of the second device (`answered`).
 */

/**
 * The calls whose answer the played device holds back while it has too many
 * frames in flight, and the caller with it.
 */
const PACED = new Set(['Present']);

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

/** A reference to one of the device's objects, by its number. */
const REF = '\u0000ref';

/**
 * A service of the caller's passed to a call -- the GDI a surface's context
 * is made by: the played side is given a stand-in whose functions answer
 * what the caller's answered.
 */
const SERVICE = '\u0000service';

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
    for (const key of Object.keys(value))
    {
        if (typeof /** @type {any} */ (value)[key] === 'function')
        {
            return true;
        }
    }
    return false;
}

/**
 * Numbers every device object a call's answer or arguments reached, in one
 * order on both sides: the answer, then each argument, depth first; an object
 * already numbered is not entered.
 *
 * @param {unknown[]} values
 * @param {(object: Record<string, any>) => boolean} bind  numbers a new one, false for a known one
 */
function bindAll(values, bind){
    /** @param {unknown} value @param {number} depth */
    const visit = (value, depth)=>{
        if (value === null || typeof value !== 'object' || ArrayBuffer.isView(value)
            || value instanceof Promise || depth > 8)
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
            for (const one of value)
            {
                visit(one, depth + 1);
            }
            return;
        }
        for (const key of Object.keys(value))
        {
            visit(/** @type {any} */ (value)[key], depth + 1);
        }
    };
    for (const value of values)
    {
        visit(value, 0);
    }
}

/**
 * @typedef {Object} RecordedCall
 * @property {number} t           the object called, by number (0, the root)
 * @property {string} [m]         the method
 * @property {any[]} [a]          its arguments, encoded
 * @property {string} [get]       a property read that reached a device object
 * @property {string} [set]       a property written
 * @property {any} [v]            the value written, encoded
 * @property {number[]} [allocs]  the guest addresses the call's allocations gave
 * @property {any[]} [replies]    what the caller's services answered the call, in order
 * @property {{ address: number, bytes: Uint8Array }[]} [ship]
 *     guest memory the program wrote through a lock, put in place before the call is played
 * @property {{ address: number, bytes: Uint8Array }[]} [wrote]
 *     guest memory the recorded call wrote itself -- a copy between two
 *     resources' bytes -- put in place after it is played, over what the
 *     played call wrote there from bytes it was never sent
 * @property {true} [w]           the caller waits for the played call's answer
 * @property {true} [p]           the caller waits for the played call's answer when that
 *     is held: a present past the frames a device may have in flight
 */

/**
 * What a played call answers a call the caller waits for: its answer, and the
 * structures it was given as the call left them.
 *
 * @typedef {Object} PlayedAnswer
 * @property {any} answer
 * @property {any[]} outs
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
 * @param {(call: RecordedCall) => PlayedAnswer | Promise<PlayedAnswer> | undefined} options.send
 *     where each call goes; what it gives back is the answer of a call marked `w`
 * @param {(target: any, name: string, args: any[]) => boolean} [options.answered]
 *     whether a call's answer is the other side's: what only its renderer
 *     knows, which the recorded device has no say in
 * @returns {{ root: any, allocated: (address: number, bytes: number) => void,
 *     wrote: (address: number, bytes: Uint8Array) => void, outward: (value: any) => any }}
 *     `allocated` is told every allocation the recorded device makes, and
 *     `wrote` every write it makes into guest memory; `outward` is a value of
 *     the device's as the caller is given it
 */
export function createRecording({ root, readMemory, send, answered = ()=>false }){
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
    /** The allocations so far, by address, for the extent of a locked block. */
    const blocks = { starts: /** @type {number[]} */ ([]), ends: /** @type {number[]} */ ([]) };
    /** The current call's allocations. @type {number[] | null} */
    let allocs = null;
    /** What the current call wrote into guest memory. @type {{ address: number, bytes: Uint8Array }[] | null} */
    let writes = null;
    /** How deep in calls the program is: a call the device makes back through the caller is part of its own. */
    let depth = 0;

    /** @param {object} object */
    const bind = object=>{
        const own = raws.get(object) ?? object;
        if (numbers.has(own) || services.has(own))
        {
            return false;
        }
        numbers.set(own, next++);
        return true;
    };

    /** @param {any} value */
    const raw = value=>(value !== null && typeof value === 'object' ? raws.get(value) ?? value
        : value);

    /**
     * An argument as it is sent: a device object by its number, bytes copied,
     * structures and arrays member by member.
     *
     * @param {any} value @returns {any}
     */
    const encode = value=>{
        if (typeof value === 'function')
        {
            throw new TypeError('remote: a call passed a function, which cannot be replayed');
        }
        if (value === null || typeof value !== 'object')
        {
            return value;
        }
        const object = raw(value);
        const number = numbers.get(object);
        if (number !== undefined)
        {
            return { [REF]: number };
        }
        if (services.has(object))
        {
            return { [SERVICE]: true };
        }
        if (ArrayBuffer.isView(object))
        {
            return /** @type {any} */ (object).slice();
        }
        if (Array.isArray(object))
        {
            return object.map(encode);
        }
        if (isDeviceObject(object))
        {
            // Not this device's: what a structure the call writes its answer
            // into held before, from another. The call reads nothing of it.
            return null;
        }
        /** @type {Record<string, any>} */
        const out = {};
        for (const key of Object.keys(object))
        {
            out[key] = encode(object[key]);
        }
        return out;
    };
    /**
     * An argument as the recorded device takes it: its own objects rather than
     * their proxies, one level into a structure or an array.
     *
     * @param {any} value @returns {any}
     */
    const unwrap = value=>{
        if (value === null || typeof value !== 'object')
        {
            return value;
        }
        const object = raws.get(value);
        if (object)
        {
            return object;
        }
        if (Array.isArray(value))
        {
            return value.some(one=>raws.has(one)) ? value.map(one=>raws.get(one) ?? one) : value;
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
        if (value === null || typeof value !== 'object' || ArrayBuffer.isView(value)
            || isDeviceObject(value) || raws.has(value))
        {
            return;
        }
        for (const key of Object.keys(value))
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
     * From an address to the end of the allocation it lies in.
     *
     * @param {number} address
     * @returns {{ address: number, bytes: Uint8Array }[]}
     */
    const blockFrom = address=>{
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
        if (found < 0 || address >= blocks.ends[found])
        {
            return [];
        }
        return [{ address, bytes: readMemory(address, blocks.ends[found] - address) }];
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
        for (const key of Object.keys(result))
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
                into[key] = value;
            }
            else if (ArrayBuffer.isView(value))
            {
                into[key] = /** @type {any} */ (value).slice();
            }
            else if (!isDeviceObject(value) && !(REF in value))
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
     * @param {object} target @param {string} name @param {Function} method
     * @returns {(...args: any[]) => any}
     */
    const methodOf = (target, name, method)=>(...given)=>{
        if (depth > 0)
        {
            return method.apply(target, given.map(unwrap));
        }
        /** @type {any[]} */
        const replies = [];
        const args = given.map(arg=>(isDeviceObject(arg) && !numbers.has(raw(arg))
            ? serviceOf(arg, replies) : arg));
        /** @type {RecordedCall} */
        const call = { t: /** @type {number} */ (numbers.get(target)), m: name,
            a: args.map(encode) };
        if (UNLOCKS.has(name))
        {
            call.ship = lockedBytes(target, name === 'ReleaseDC' ? '' : partOf(args));
        }
        allocs = [];
        writes = [];
        depth++;
        let result;
        try
        {
            result = method.apply(target, args.map(unwrap));
        }
        finally
        {
            depth--;
            if (allocs.length > 0)
            {
                call.allocs = allocs;
            }
            if (writes.length > 0)
            {
                call.wrote = writes;
            }
            allocs = null;
            writes = null;
        }
        if (replies.length > 0)
        {
            call.replies = replies.map(encode);
        }
        bindAll([result, ...args], bind);
        for (const arg of args)
        {
            wrapInto(arg);
            const bits = arg?.pBits;
            if (name.startsWith('Lock') && typeof bits === 'number')
            {
                const locks = lockedAt.get(target) ?? new Map();
                locks.set(partOf(args), bits);
                lockedAt.set(target, locks);
            }
        }
        if (PACED.has(name))
        {
            call.p = true;
            const held = send(call);
            return held instanceof Promise ? held : result;
        }
        if (!answered(target, name, args))
        {
            send(call);
            return answerOf(result);
        }
        call.w = true;
        /** @param {PlayedAnswer} played */
        const take = played=>{
            for (let index = 0; index < args.length; index++)
            {
                copyOut(args[index], played.outs[index]);
            }
            return played.answer;
        };
        const reply = /** @type {PlayedAnswer | Promise<PlayedAnswer>} */ (send(call));
        return reply instanceof Promise ? reply.then(take) : take(reply);
    };

    /** @type {ProxyHandler<any>} */
    const handler = {
        get(target, key){
            const value = Reflect.get(target, key);
            if (typeof key !== 'string')
            {
                return value;
            }
            if (typeof value === 'function')
            {
                return owned.get(target)?.has(key) ? value : methodOf(target, key, value);
            }
            if (isDeviceObject(value))
            {
                if (bind(value))
                {
                    send({ t: /** @type {number} */ (numbers.get(target)), get: key });
                }
                return proxyOf(value);
            }
            return value;
        },
        set(target, key, value){
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
                send({ t: /** @type {number} */ (numbers.get(target)), set: key,
                    v: encode(value) });
            }
            return Reflect.set(target, key, unwrap(value));
        },
    };
    /** @param {object} given */
    const proxyOf = given=>{
        const object = raws.get(given) ?? given;
        let proxy = proxies.get(object);
        if (!proxy)
        {
            proxy = new Proxy(object, handler);
            proxies.set(object, proxy);
            raws.set(proxy, object);
        }
        return proxy;
    };

    return {
        root: proxyOf(root),
        outward: answerOf,
        allocated(address, bytes){
            allocs?.push(address);
            let at = blocks.starts.length;
            while (at > 0 && blocks.starts[at - 1] > address)
            {
                at--;
            }
            blocks.starts.splice(at, 0, address);
            blocks.ends.splice(at, 0, address + bytes);
        },
        wrote(address, bytes){
            if (writes)
            {
                writes.push({ address, bytes: bytes.slice() });
            }
            else
            {
                send({ t: 0, wrote: [{ address, bytes: bytes.slice() }] });
            }
        },
    };
}

/**
 * The playing side: the calls a recording sent, made in their order on a
 * root of the same build, with the same objects by the same numbers.
 *
 * @param {Object} options
 * @param {Record<string, any>} options.root
 * @param {(address: number, bytes: Uint8Array) => void} options.ship
 *     where the bytes a lock let the program write are put: the guest memory
 *     this side reads
 * @param {(address: number, length: number) => Uint8Array} options.read
 *     that memory read, for the copies a call describes and its caller makes
 * @returns {{ play: (call: RecordedCall) => PlayedAnswer | Promise<PlayedAnswer> | undefined,
 *     allocate: () => number }}
 *     `allocate` is the played device's: the next address its recorded call
 *     was given
 */
export function createPlayer({ root, ship, read }){
    /** @type {object[]} */
    const objects = [root];
    /** @type {WeakSet<object>} */
    const known = new WeakSet([root]);
    /** @type {number[]} */
    let allocs = [];
    /** The call being played, for what a failure says. @type {RecordedCall | null} */
    let playing = null;
    /** @type {any[]} */
    let replies = [];
    /**
     * Every service of the caller's, played: whatever is asked of it, the
     * answer the caller's gave in the recorded call.
     */
    const standIn = new Proxy({}, {
        get: (_, key)=>(typeof key === 'string' ? ()=>replies.shift() : undefined),
    });

    /** @param {object} object */
    const bind = object=>{
        if (known.has(object))
        {
            return false;
        }
        known.add(object);
        objects.push(object);
        return true;
    };
    /** @param {any} value @returns {any} */
    const decode = value=>{
        if (value === null || typeof value !== 'object' || ArrayBuffer.isView(value))
        {
            return value;
        }
        if (Array.isArray(value))
        {
            return value.map(decode);
        }
        if (REF in value)
        {
            return objects[value[REF]];
        }
        if (SERVICE in value)
        {
            return standIn;
        }
        /** @type {Record<string, any>} */
        const out = {};
        for (const key of Object.keys(value))
        {
            out[key] = decode(value[key]);
        }
        return out;
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
            for (const { address, bytes } of call.ship ?? [])
            {
                ship(address, bytes);
            }
            allocs = call.allocs ? [...call.allocs] : [];
            replies = call.replies ? call.replies.map(decode) : [];
            playing = call;
            const target = /** @type {any} */ (objects[call.t]);
            if (call.get !== undefined)
            {
                bindAll([target[call.get]], bind);
            }
            else if (call.set !== undefined)
            {
                target[call.set] = decode(call.v);
            }
            else if (call.m !== undefined)
            {
                const args = (call.a ?? []).map(decode);
                const answer = target[call.m](...args);
                bindAll([answer, ...args], bind);
                if (allocs.length > 0)
                {
                    throw new Error(`remote: ${call.m} allocated less on the played device`);
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
                    if (call.w)
                    {
                        return settled;
                    }
                    return call.p ? answer : undefined;
                }
                return call.w ? { answer, outs: args } : undefined;
            }
            for (const { address, bytes } of call.wrote ?? [])
            {
                ship(address, bytes);
            }
            return undefined;
        },
        allocate(){
            const address = allocs.shift();
            if (address === undefined)
            {
                throw new Error('remote: the played device allocated more than the recorded one'
                    + ` in ${playing?.m ?? playing?.get ?? playing?.set}`);
            }
            return address;
        },
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
