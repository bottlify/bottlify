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
 * @property {(object: ComObject, args: number[]) => number} [invoke]
 */

/**
 * @typedef {Object} ComInterfaceDescriptor
 * @property {string} id
 * @property {ComMethod[]} methods  In vtable order, after IUnknown's three.
 */

/**
 * @typedef {Object} ComClassDefinition
 * @property {ComInterfaceDescriptor[]} interfaces
 * @property {any} [state]        Whatever the implementation hangs off the object.
 * @property {() => void} [destroy]  Called once, when the last reference goes.
 */

/**
 * @typedef {Object} ComInterface
 * @property {ComObject} object
 * @property {string} id
 * @property {readonly ComMethod[]} methods  IUnknown's three, then the declared ones.
 */

/**
 * @typedef {Object} ComObject
 * @property {string} clsid
 * @property {any} state
 * @property {number} refCount
 * @property {boolean} destroyed
 * @property {(id: string) => ComInterface | null} interfaceFor
 * @property {(id: string) => ComInterface | null} queryInterface
 * @property {() => number} addRef
 * @property {() => number} release
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
 * @param {string} clsid
 * @param {ComClassDefinition} definition
 * @returns {ComObject}
 */
function createComObject(clsid, definition){
    const declared = new Map(definition.interfaces.map(checkDescriptor));
    /** @type {Map<string, ComInterface>} */
    const published = new Map();
    // One reference, held by whoever asked for the object: a class factory hands
    // back an object that is already alive, and the caller releases it.
    let refCount = 1;
    let destroyed = false;

    /** @type {ComObject} */
    const object = {
        clsid,
        state: definition.state ?? null,
        get refCount(){
            return refCount;
        },
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
            const key = canonicalGuid(id);
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
                methods: Object.freeze([...IUNKNOWN_METHODS, ...descriptor.methods]),
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

        addRef(){
            if (destroyed)
            {
                // Nothing legitimate resurrects an object: the reference that
                // would have kept it alive was released before this call.
                throw new Error(`AddRef on a released object of class ${clsid}`);
            }
            refCount++;
            return refCount;
        },

        release(){
            if (destroyed)
            {
                return 0;
            }
            refCount--;
            if (refCount > 0)
            {
                return refCount;
            }
            destroyed = true;
            published.clear();
            definition.destroy?.();
            return 0;
        },
    };
    return object;
}

/**
 * @typedef {Object} ComRegistry
 * @property {(clsid: string, factory: () => ComClassDefinition | null) => void} registerClass
 * @property {(clsid: string) => boolean} isRegistered
 * @property {(clsid: string) => ComObject | null} create
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

    return {
        /**
         * @param {string} clsid
         * @param {() => ComClassDefinition | null} factory
         *        Null from a factory means the class is known but cannot produce
         *        an object right now, which is a different failure from an
         *        unregistered CLSID and is reported as one.
         */
        registerClass(clsid, factory){
            classes.set(requireGuid(clsid, 'class id'), factory);
        },

        /** @param {string} clsid @returns {boolean} */
        isRegistered(clsid){
            const key = canonicalGuid(clsid);
            return key !== null && classes.has(key);
        },

        /**
         * @param {string} clsid
         * @returns {ComObject | null} an object with one reference, or null
         */
        create(clsid){
            const key = canonicalGuid(clsid);
            const factory = key === null ? undefined : classes.get(key);
            if (!factory)
            {
                return null;
            }
            const definition = factory();
            return definition ? createComObject(/** @type {string} */ (key), definition) : null;
        },
    };
}
