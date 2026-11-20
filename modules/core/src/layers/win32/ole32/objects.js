/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The COM object model: which class produces what, which interfaces an object
 * answers to, and how long it lives.
 *
 * Nothing here knows about guest memory, HRESULTs or vtables. That is deliberate
 * -- this is the model every DirectX interface will later be handed out through,
 * and the parts of it a program can observe are all here: the count that decides
 * when an object dies, and the identity that decides whether two interface
 * pointers name the same object.
 *
 * Two rules are worth stating because breaking either is invisible until a
 * program misbehaves far away from the cause:
 *
 * - **The order of an interface's methods is its vtable.** It is declared, never
 *   derived from anything. Every COM vtable begins with IUnknown's three slots,
 *   so those are prepended here; a descriptor lists the methods that follow, and
 *   an interface deriving from another names its base's methods again at the
 *   front of its own list, because that is what the guest compiled against.
 * - **QueryInterface for IID_IUnknown answers with one record per object,**
 *   whichever interface it was asked through. Programs compare the two pointers
 *   to decide whether two interfaces belong to the same object, so an object with
 *   two IUnknowns is an object that fails that test.
 */

import { canonicalGuid } from './guid.js';

/** IID_IUnknown. Every object answers to it and answers with the same record. */
export const IID_IUNKNOWN = '{00000000-0000-0000-C000-000000000046}';

/**
 * @typedef {Object} ComMethod
 * @property {string} name
 * @property {number} argBytes
 *           stdcall, counted the way the bridge counts it: every argument
 *           including `this`, so at least 4. `this` arrives in ECX and is not
 *           popped, which is the convention's business and not this file's.
 * @property {'queryInterface' | 'addRef' | 'release'} [builtin]
 *           Set on IUnknown's three slots. Their implementation needs guest
 *           pointers, so whoever publishes the vtable supplies it.
 * @property {(object: ComObject, args: number[]) => number | Promise<number>} [invoke]
 *           A promise is a legitimate answer: the bridge parks the calling
 *           thread until it settles, which is what a method that has to read a
 *           file before it can answer needs.
 * @property {number[]} [quadwords]
 * @property {string} [returns]  The answer is an address (`HostFunction.returns`).
 * @property {Record<number, 'f32' | 'f64'>} [floats]
 * @property {Record<number, number>} [structs]
 *           How a 64-bit caller passes the arguments the 32-bit layout has as
 *           two dwords, a float, or a structure wider than eight bytes, by
 *           their first dword counting `this` (the vtable layer's).
 */

/**
 * @typedef {Object} ComInterfaceDescriptor
 * @property {string} id
 * @property {ComMethod[]} methods  In vtable order, after IUnknown's three.
 * @property {string[]} [also]
 *           Other interface ids the same interface answers to, with the same
 *           pointer: one interface Windows publishes under two names (the item
 *           dialog's IFileDialogCustomize and IFileDialogCustomizeAlt).
 */

/**
 * @typedef {Object} ComClassDefinition
 * @property {ComInterfaceDescriptor[]} interfaces
 * @property {any} [state]        Whatever the implementation hangs off the object.
 * @property {() => void} [destroy]  Called once, when the last reference goes.
 * @property {() => Promise<void> | void} [lastRelease]
 *     Called when the program's Release is about to drop the last reference,
 *     on the program's thread, and waited for before it does: what an object
 *     owes the program's own objects as it goes -- a filter graph telling the
 *     filters in it that it is gone -- happens inside that Release, as on
 *     Windows, rather than after the program has moved on and freed them.
 * @property {boolean} [owned]
 *     The object belongs to something that is no caller -- an apartment's
 *     context -- and lives as long as that does: its count is only its
 *     callers', from zero, and reaching zero again frees nothing.
 * @property {{ address: number, read: () => number, write: (value: number) => void }} [count]
 *     A word of guest memory to keep the count in, for an object the program
 *     counts thousands of times a frame: the guest's AddRef and Release take
 *     every reference but the first and the last there, with no host call.
 * @property {boolean} [aggregatable]
 *     The class may be made inside another object (CoCreateInstance with a
 *     controlling unknown), as COM's aggregation rules have it: see `Aggregation`.
 */

/**
 * An object made inside another, as COM aggregation makes one. Its IUnknown is
 * its own -- the non-delegating unknown the outer object keeps, counting the
 * inner object alone -- and every other interface it hands out belongs to the
 * outer object's identity: QueryInterface, AddRef and Release through them are
 * the outer object's, and a QueryInterface through the inner IUnknown for one
 * of them takes the reference through it, so on the outer object too.
 *
 * @typedef {Object} Aggregation
 * @property {number} outer  The controlling unknown.
 * @property {(slot: number, args: number[]) => Promise<number>} call
 *     Calls the controlling unknown's method in `slot` (0 QueryInterface,
 *     1 AddRef, 2 Release) with `this` and `args`.
 */

/**
 * @typedef {Object} ComInterface
 * @property {ComObject} object
 * @property {string} id
 * @property {readonly ComMethod[]} methods  IUnknown's three, then the declared ones.
 * @property {string} [sharedWith]  The interface whose pointer this one is: another
 *           name of it (ComInterfaceDescriptor's `also`).
 */

/**
 * @typedef {Object} ComObject
 * @property {string} clsid
 * @property {any} state
 * @property {number} refCount
 * @property {() => number} [countCell]  The guest word the count is kept in, 0 for none.
 * @property {boolean} destroyed
 * @property {(id: string) => ComInterface | null} interfaceFor
 * @property {(id: string) => ComInterface | null} queryInterface
 * @property {(id?: string) => number | Promise<number>} addRef
 *     A promise only for an aggregated object's reference on an interface
 *     other than its own IUnknown, which is the controlling unknown's.
 * @property {() => number} release
 * @property {Aggregation | null} [aggregation]
 * @property {(id: string) => boolean} [reachable]
 *     For an object something else owns: its pointers stay good at a count
 *     of zero, as the bridge asks of an object that can be called again.
 * @property {() => Promise<void> | void} [lastRelease]  As the definition's.
 */

/** The head of every COM vtable, in the only order it is ever in. */
export const IUNKNOWN_METHODS = Object.freeze([
    Object.freeze({ name: 'QueryInterface', argBytes: 12, builtin: 'queryInterface' }),
    Object.freeze({ name: 'AddRef', argBytes: 4, builtin: 'addRef' }),
    Object.freeze({ name: 'Release', argBytes: 4, builtin: 'release' }),
]);

/** IID_IUnknown adds nothing of its own. */
const IUNKNOWN_DESCRIPTOR = Object.freeze({ id: IID_IUNKNOWN, methods: [] });

/**
 * @param {string} text
 * @param {string} what  Names the value in the error, since both are GUIDs.
 * @returns {string}
 */
function requireGuid(text, what){
    const guid = canonicalGuid(text);
    if (guid === null)
    {
        throw new Error(`${what} is not a GUID: "${text}"`);
    }
    return guid;
}

/**
 * @param {ComInterfaceDescriptor} descriptor
 * @returns {[string, ComInterfaceDescriptor]}
 */
function checkDescriptor(descriptor){
    const id = requireGuid(descriptor.id, 'interface id');
    for (const method of descriptor.methods)
    {
        // A method whose argBytes forgot `this` builds a vtable slot that pops
        // four bytes too few, and the caller's stack is wrong from there on.
        if (!Number.isInteger(method.argBytes) || method.argBytes < 4
            || method.argBytes % 4 !== 0)
        {
            throw new Error(
                `${id}::${method.name} argBytes must count \`this\`, got ${method.argBytes}`);
        }
    }
    return [id, descriptor];
}

/**
 * Each interface description's methods behind IUnknown's, made once: every
 * object of one description hands the same list to the bridge, which builds a
 * table -- stubs, and guest code for methods that have it -- once per list. A
 * list made per object built all of that again for every object, and a
 * program that made a few thousand objects of an interface with guest code
 * ran the stub table out.
 *
 * @type {WeakMap<object, readonly any[]>}
 */
const fullMethods = new WeakMap();

/** @param {ComInterfaceDescriptor} descriptor @returns {readonly any[]} */
function methodsOf(descriptor){
    let methods = fullMethods.get(descriptor);
    if (!methods)
    {
        methods = Object.freeze([...IUNKNOWN_METHODS, ...descriptor.methods]);
        fullMethods.set(descriptor, methods);
    }
    return methods;
}

/**
 * The same methods for an aggregated object: IUnknown's three are the
 * controlling unknown's, called through it, rather than this object's own.
 *
 * @type {WeakMap<object, readonly any[]>}
 */
const delegatingMethods = new WeakMap();

/** IUnknown's three as an aggregated object's interfaces have them. */
const DELEGATING_UNKNOWN = Object.freeze([
    Object.freeze({ name: 'QueryInterface', argBytes: 12,
        invoke: (/** @type {ComObject} */ object, /** @type {number[]} */ args)=>
            /** @type {Aggregation} */ (object.aggregation).call(0, args) }),
    Object.freeze({ name: 'AddRef', argBytes: 4,
        invoke: (/** @type {ComObject} */ object)=>
            /** @type {Aggregation} */ (object.aggregation).call(1, []) }),
    Object.freeze({ name: 'Release', argBytes: 4,
        invoke: (/** @type {ComObject} */ object)=>
            /** @type {Aggregation} */ (object.aggregation).call(2, []) }),
]);

/** @param {ComInterfaceDescriptor} descriptor @returns {readonly any[]} */
function delegatingMethodsOf(descriptor){
    let methods = delegatingMethods.get(descriptor);
    if (!methods)
    {
        methods = Object.freeze([...DELEGATING_UNKNOWN, ...descriptor.methods]);
        delegatingMethods.set(descriptor, methods);
    }
    return methods;
}

/**
 * @param {string} clsid
 * @param {ComClassDefinition} definition
 * @param {Aggregation | null} [aggregation]  Made inside a controlling unknown.
 * @returns {ComObject}
 */
export function createComObject(clsid, definition, aggregation = null){
    const declared = new Map(definition.interfaces.map(checkDescriptor));
    // An interface's other names lead to its record, so they are one pointer.
    /** @type {Map<string, string>} */
    const aliases = new Map(definition.interfaces.flatMap(descriptor=>(descriptor.also ?? [])
        .map(other=>[requireGuid(other, 'interface id'),
            requireGuid(descriptor.id, 'interface id')])));
    /** @type {Map<string, ComInterface>} */
    const published = new Map();
    // One reference, held by whoever asked for the object: a class factory hands
    // back an object that is already alive, and the caller releases it. Kept
    // in a word of guest memory where the definition gives one, so that the
    // guest's AddRef and Release (`bridge/internal/vtable.js`) count without
    // coming here but for the first reference and the last.
    const cell = definition.count ?? null;
    let held = definition.owned ? 0 : 1;
    cell?.write(held);
    const count = ()=>(cell ? cell.read() : held);
    /** @param {number} value */
    const setCount = value=>{
        if (cell)
        {
            cell.write(value);
        }
        else
        {
            held = value;
        }
    };
    let destroyed = false;

    /** @type {ComObject} */
    const object = {
        clsid,
        aggregation,
        state: definition.state ?? null,
        get refCount(){
            return count();
        },
        countCell: ()=>(cell && !destroyed ? cell.address : 0),
        get destroyed(){
            return destroyed;
        },

        /**
         * The interface record, without taking a reference. Publishing a vtable
         * needs the method list and must not change the count while doing it.
         *
         * @param {string} id
         */
        interfaceFor(id){
            const asked = canonicalGuid(id);
            const primary = asked === null ? undefined : aliases.get(asked);
            if (primary !== undefined && !destroyed)
            {
                // Another name of an interface: its record, sharing its
                // pointer (`sharedWith`, as the bridge publishes one).
                const known = published.get(/** @type {string} */ (asked));
                if (known)
                {
                    return known;
                }
                const main = object.interfaceFor(primary);
                if (!main)
                {
                    return null;
                }
                const named = Object.freeze({ ...main, id: /** @type {string} */ (asked),
                    sharedWith: primary });
                published.set(/** @type {string} */ (asked), named);
                return named;
            }
            const key = asked;
            if (key === null || destroyed)
            {
                return null;
            }
            const existing = published.get(key);
            if (existing)
            {
                return existing;
            }
            const descriptor = key === IID_IUNKNOWN
                ? IUNKNOWN_DESCRIPTOR
                : declared.get(key);
            if (!descriptor)
            {
                return null;
            }
            const record = Object.freeze({
                object,
                id: key,
                methods: aggregation && key !== IID_IUNKNOWN
                    ? delegatingMethodsOf(descriptor) : methodsOf(descriptor),
            });
            // Memoised, so the record -- and therefore the pointer published for
            // it -- is the same one every time this object is asked for this
            // interface. That is what COM identity is.
            published.set(key, record);
            return record;
        },

        /** @param {string} id */
        queryInterface(id){
            const record = object.interfaceFor(id);
            if (record)
            {
                object.addRef();
            }
            return record;
        },

        /** @param {string} [id] */
        addRef(id){
            // A reference on an aggregated object's other faces is the
            // controlling unknown's: its own count is its IUnknown's alone.
            if (aggregation && id !== undefined && canonicalGuid(id) !== IID_IUNKNOWN)
            {
                return aggregation.call(1, []);
            }
            if (destroyed)
            {
                // Nothing legitimate resurrects an object: the reference that
                // would have kept it alive was released before this call.
                throw new Error(`AddRef on a released object of class ${clsid}`);
            }
            const next = count() + 1;
            setCount(next);
            return next;
        },

        release(){
            if (destroyed || (definition.owned && count() === 0))
            {
                return 0;
            }
            const left = count() - 1;
            setCount(left);
            if (definition.owned)
            {
                return left;
            }
            if (left > 0)
            {
                return left;
            }
            destroyed = true;
            published.clear();
            definition.destroy?.();
            return 0;
        },
    };
    if (definition.owned)
    {
        object.reachable = ()=>true;
    }
    if (definition.lastRelease)
    {
        object.lastRelease = definition.lastRelease;
    }
    return object;
}

/**
 * @typedef {Object} ComRegistry
 * @property {(clsid: string, factory: () => ComClassDefinition | null,
 *     options?: { single?: boolean }) => void} registerClass
 * @property {(clsid: string) => boolean} isRegistered
 * @property {(clsid: string) => ComObject | null} create
 * @property {(clsid: string, aggregation: Aggregation) =>
 *     ComObject | null | false} createAggregated
 *           Made inside a controlling unknown; false where the class may not be.
 * @property {() => number} count  How many classes are registered.
 * @property {(provide: () => void) => void} whenMissing
 *           What is asked once a CLSID is not found: the libraries whose
 *           factories register classes are made then, not at the start, and the
 *           search goes on - as Windows loads a class's server only when asked.
 * @property {{ enter: () => void, leave: () => void, readonly users: number }} mtaUsage
 *           Holds the multithreaded apartment open with no thread in it, as
 *           CoIncrementMTAUsage does -- and as a system object with worker
 *           threads of its own does, which is how a thread that entered no
 *           apartment finds itself in it implicitly.
 */

/**
 * The class registry: a CLSID and the factory that answers for it.
 *
 * Registration is ours, not the guest's -- a class exists because a layer here
 * implements it -- so a malformed GUID or a miscounted argument list is a
 * programming error and throws rather than becoming a lookup that never matches.
 *
 * @returns {ComRegistry}
 */
export function createComRegistry(){
    /** @type {Map<string, () => ComClassDefinition | null>} */
    const classes = new Map();
    /** @type {(() => void) | null} */
    let provide = null;
    /**
     * The factory of a canonical CLSID, the providers asked once when it is
     * not known yet.
     *
     * @param {string | null} key
     */
    const factoryOf = key=>{
        if (key === null)
        {
            return undefined;
        }
        if (!classes.has(key) && provide)
        {
            const asked = provide;
            provide = null;
            asked();
        }
        return classes.get(key);
    };
    /**
     * The one object of a class that has one per process: made the first time
     * it is asked for, holding a reference of its own for good, every later
     * caller handed the same object with a reference of theirs (MMDevAPI's
     * device enumerator, whose count after CoCreateInstance is two).
     *
     * @type {Map<string, ComObject | null>}
     */
    const singles = new Map();
    let mtaUsers = 0;

    return {
        /**
         * @param {string} clsid
         * @param {() => ComClassDefinition | null} factory
         *        Null from a factory means the class is known but cannot produce
         *        an object right now, which is a different failure from an
         *        unregistered CLSID and is reported as one.
         * @param {{ single?: boolean }} [options]  `single`: one object per
         *        process, which keeps a reference of its own (`singles`).
         */
        registerClass(clsid, factory, options = {}){
            const key = requireGuid(clsid, 'class id');
            classes.set(key, factory);
            if (options.single)
            {
                singles.set(key, null);
            }
            else
            {
                singles.delete(key);
            }
        },

        count: ()=>classes.size,

        whenMissing(asked){
            provide = asked;
        },

        mtaUsage: {
            enter(){
                mtaUsers++;
            },
            leave(){
                mtaUsers = Math.max(0, mtaUsers - 1);
            },
            get users(){
                return mtaUsers;
            },
        },

        /** @param {string} clsid @returns {boolean} */
        isRegistered(clsid){
            const key = canonicalGuid(clsid);
            return factoryOf(key) !== undefined;
        },

        /**
         * @param {string} clsid
         * @returns {ComObject | null} an object with one reference, or null
         */
        create(clsid){
            const key = canonicalGuid(clsid);
            const factory = factoryOf(key);
            if (!factory)
            {
                return null;
            }
            if (singles.has(/** @type {string} */ (key)))
            {
                let single = singles.get(/** @type {string} */ (key)) ?? null;
                if (!single)
                {
                    const definition = factory();
                    if (!definition)
                    {
                        return null;
                    }
                    single = createComObject(/** @type {string} */ (key), definition);
                    singles.set(/** @type {string} */ (key), single);
                }
                single.addRef();
                return single;
            }
            const definition = factory();
            return definition ? createComObject(/** @type {string} */ (key), definition) : null;
        },

        /**
         * @param {string} clsid
         * @param {Aggregation} aggregation  The controlling unknown it is made inside.
         * @returns {ComObject | null | false} an object with one reference, null
         *     where there is none, false where the class may not be aggregated
         */
        createAggregated(clsid, aggregation){
            const key = canonicalGuid(clsid);
            if (key !== null && singles.has(key))
            {
                // The one object of the process is nobody's inner object.
                return false;
            }
            const factory = factoryOf(key);
            const definition = factory?.();
            if (!definition)
            {
                return null;
            }
            if (!definition.aggregatable)
            {
                definition.destroy?.();
                return false;
            }
            return createComObject(/** @type {string} */ (key), definition, aggregation);
        },
    };
}
