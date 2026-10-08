/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * JScript's objects (ECMA-262 3rd edition, clause 8.6): a prototype, a class
 * name, and named properties with the three attributes ES3 has. There are no
 * accessors in ES3, so reading and writing a property never runs script --
 * which is what lets these operations be plain functions while everything
 * that may run script is a generator in the interpreter.
 *
 * Arrays, String objects and the arguments object keep some properties
 * computed rather than stored; each overrides `own` and `put` for those.
 */

/** Property attributes. */
export const READONLY = 1;
export const DONTENUM = 2;
export const DONTDELETE = 4;

export class Property
{
    /** @param {any} value @param {number} flags */
    constructor(value, flags){
        this.value = value;
        this.flags = flags;
    }
}

/** A script's `throw`, carrying the value thrown. */
export class ScriptThrow
{
    /**
     * @param {any} value
     * @param {{ source: import('./parser.js').SourceText | null, offset: number }} [where]
     */
    constructor(value, where){
        this.value = value;
        this.where = where ?? null;
    }
}

// The embedder's stop is every engine's, so that it is told apart the same
// way whichever language a host runs.
export { ScriptAbort } from '../script/engine.js';

export class JSObject
{
    /** @param {JSObject | null} proto @param {string} cls */
    constructor(proto, cls){
        this.proto = proto;
        this.cls = cls;
        /** @type {Map<string, Property>} */
        this.props = new Map();
        /** The [[Value]] of a Boolean, Number, String or Date object. */
        /** @type {any} */
        this.value = undefined;
    }

    /** @param {string} key @returns {Property | undefined} */
    own(key){
        return this.props.get(key);
    }

    /**
     * The names a for-in finds on this object itself, in the order they
     * were made, the hidden ones with them so that they hide the
     * prototype's: `[name, enumerable]`.
     *
     * @returns {Iterable<[string, boolean]>}
     */
    *ownNames(){
        for (const [key, property] of this.props)
        {
            yield [key, (property.flags & DONTENUM) === 0];
        }
    }

    /** @param {string} key @returns {Property | undefined} */
    lookup(key){
        /** @type {JSObject | null} */
        let object = this;
        do {
            const property = object.own(key);
            if (property !== undefined)
            {
                return property;
            }
            object = object.proto;
        } while (object !== null);
        return undefined;
    }

    /** @param {string} key @returns {any} */
    get(key){
        const property = this.lookup(key);
        return property === undefined ? undefined : property.value;
    }

    /** @param {string} key @returns {boolean} */
    has(key){
        return this.lookup(key) !== undefined;
    }

    /**
     * [[Put]] (8.6.2.2): a read-only property anywhere on the chain refuses
     * the write without saying so.
     *
     * @param {string} key @param {any} value
     */
    put(key, value){
        const own = this.own(key);
        if (own !== undefined)
        {
            if ((own.flags & READONLY) === 0)
            {
                own.value = value;
            }
            return;
        }
        for (let object = this.proto; object !== null; object = object.proto)
        {
            const inherited = object.own(key);
            if (inherited !== undefined)
            {
                if ((inherited.flags & READONLY) !== 0)
                {
                    return;
                }
                break;
            }
        }
        this.props.set(key, new Property(value, 0));
    }

    /** @param {string} key @param {any} value @param {number} [flags] */
    define(key, value, flags = DONTENUM){
        this.props.set(key, new Property(value, flags));
    }

    /** @param {string} key @returns {boolean} */
    delete(key){
        const own = this.own(key);
        if (own === undefined)
        {
            return true;
        }
        if ((own.flags & DONTDELETE) !== 0)
        {
            return false;
        }
        this.props.delete(key);
        return true;
    }

    /** @returns {boolean} */
    get callable(){
        return false;
    }
}

/** @param {string} key @returns {number} the index, or -1 when not one */
export function arrayIndex(key){
    const length = key.length;
    if (length === 0 || length > 10)
    {
        return -1;
    }
    const first = key.charCodeAt(0);
    if (first < 0x30 || first > 0x39 || (first === 0x30 && length > 1))
    {
        return -1;
    }
    let value = 0;
    for (let i = 0; i < length; i++)
    {
        const c = key.charCodeAt(i);
        if (c < 0x30 || c > 0x39)
        {
            return -1;
        }
        value = value * 10 + (c - 0x30);
    }
    return value < 4294967295 ? value : -1;
}

/** The read-only-to-the-chain, hidden, permanent `length` an array reports. */
const LENGTH_FLAGS = DONTENUM | DONTDELETE;

export class JSArray extends JSObject
{
    /** @param {JSObject | null} proto */
    constructor(proto){
        super(proto, 'Array');
        this.length = 0;
    }

    /** @param {string} key */
    own(key){
        if (key === 'length')
        {
            return new Property(this.length, LENGTH_FLAGS);
        }
        return this.props.get(key);
    }

    /** @returns {Iterable<[string, boolean]>} */
    *ownNames(){
        yield ['length', false];
        yield* super.ownNames();
    }

    /**
     * 15.4.5.1. A length is set by the caller only after it has checked the
     * value is one (`setLength`); here a number that is not is refused by
     * throwing `RangeError`'s marker.
     *
     * @param {string} key @param {any} value
     */
    put(key, value){
        if (key === 'length')
        {
            const length = typeof value === 'number' ? value >>> 0 : NaN;
            if (length !== value)
            {
                throw new InvalidLength();
            }
            this.setLength(length);
            return;
        }
        const existing = this.props.get(key);
        if (existing !== undefined)
        {
            if ((existing.flags & READONLY) === 0)
            {
                existing.value = value;
            }
            return;
        }
        super.put(key, value);
        const index = arrayIndex(key);
        if (index >= this.length)
        {
            this.length = index + 1;
        }
    }

    /** @param {number} length */
    setLength(length){
        if (length < this.length)
        {
            if (this.length - length > this.props.size)
            {
                for (const key of [...this.props.keys()])
                {
                    const index = arrayIndex(key);
                    if (index >= length)
                    {
                        this.props.delete(key);
                    }
                }
            }
            else
            {
                for (let index = length; index < this.length; index++)
                {
                    this.props.delete(String(index));
                }
            }
        }
        this.length = length;
    }

    /** @param {string} key */
    delete(key){
        return key === 'length' ? false : super.delete(key);
    }
}

/** An array length that is not a whole number from 0 to 2^32 - 1. */
export class InvalidLength extends Error
{
    constructor(){
        super('invalid array length');
        this.name = 'InvalidLength';
    }
}

/**
 * A String object. JScript before version 9 has no index properties on one:
 * `"abc"[0]` is undefined, and only `length` is its own.
 */
export class StringObject extends JSObject
{
    /** @param {JSObject | null} proto @param {string} value */
    constructor(proto, value){
        super(proto, 'String');
        this.value = value;
    }

    /** @param {string} key */
    own(key){
        if (key === 'length')
        {
            return new Property(this.value.length, READONLY | DONTENUM | DONTDELETE);
        }
        return this.props.get(key);
    }

    /** @param {string} key @param {any} value */
    put(key, value){
        if (key !== 'length')
        {
            super.put(key, value);
        }
    }

    /** @param {string} key */
    delete(key){
        return key === 'length' ? false : super.delete(key);
    }
}

/**
 * An environment record: a function's activation, a catch clause's name,
 * or -- for the global code and a `with` -- an object's properties.
 */
export class DeclarativeScope
{
    /** @param {Scope | null} parent */
    constructor(parent){
        this.parent = parent;
        /** @type {Map<string, Property>} */
        this.vars = new Map();
    }
}

export class ObjectScope
{
    /**
     * @param {any} object  A JSObject, or an external object for a `with`.
     * @param {Scope | null} parent
     * @param {boolean} isWith  Whether a call through a name found here has
     *     the object as its `this`.
     */
    constructor(object, parent, isWith){
        this.object = object;
        this.parent = parent;
        this.isWith = isWith;
    }
}

/** @typedef {DeclarativeScope | ObjectScope} Scope */

/**
 * A function: the script's own, closing over the scope it was made in, or
 * the engine's, implemented here. A built-in that may run script answers
 * with a generator over its steps ({@link isSteps}); one that cannot simply
 * answers its value.
 *
 * @typedef {(thisValue: any, args: any[], self: JSFunction) => any} NativeCall
 */

/** %GeneratorPrototype%, which every generator object inherits from. */
const GENERATOR = Object.getPrototypeOf(Object.getPrototypeOf((function*(){
    yield 0;
})()));

/**
 * Whether a built-in answered with steps still to run rather than a value.
 * No script value is a generator, so the two cannot be mistaken.
 *
 * @param {any} value @returns {value is Generator<unknown, any, unknown>}
 */
export function isSteps(value){
    return value !== null && typeof value === 'object'
        && Object.prototype.isPrototypeOf.call(GENERATOR, value);
}
export class JSFunction extends JSObject
{
    /** @param {JSObject | null} proto */
    constructor(proto){
        super(proto, 'Function');
        /** @type {import('./parser.js').FunctionNode | null} */
        this.node = null;
        /** @type {Scope | null} */
        this.scope = null;
        /** @type {NativeCall | null} */
        this.native = null;
        /** @type {NativeCall | null} */
        this.construct = null;
        this.nativeName = '';
    }

    get callable(){
        return true;
    }
}

/**
 * The arguments object (10.1.8): its indices below the number of named
 * parameters passed are the parameters themselves, sharing their property.
 */
export class ArgumentsObject extends JSObject
{
    /** @param {JSObject | null} proto */
    constructor(proto){
        super(proto, 'Object');
    }

    /** @param {string} key */
    delete(key){
        if (arrayIndex(key) >= 0)
        {
            this.props.delete(key);
            return true;
        }
        return super.delete(key);
    }
}
