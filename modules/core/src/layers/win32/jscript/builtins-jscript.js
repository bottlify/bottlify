/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What JScript has beyond ES3, from the JScript Language Reference:
 * ActiveXObject and GetObject, which reach automation objects; Enumerator,
 * which walks a collection; VBArray, which reads a SAFEARRAY; and the
 * functions that say which engine this is.
 *
 * ActiveXObject asks the embedder for the class's object (through
 * CoCreateInstance and IDispatch, when a program's script asks). A class it
 * cannot make is error 429, "Automation server can't create object", as
 * JScript reports any failure to create one. GetObject binds a moniker --
 * a file's or a running object's -- which the embedder may do; without that,
 * it is refused with the same error.
 */

import { isThenable } from '../script/drive.js';
import { ExternalError, ExternalObject } from '../script/external.js';
import { ForeignValue } from '../script/values.js';
import { JSObject } from './objects.js';
import { toInteger } from './realm.js';

/**
 * @typedef {import('./realm.js').Realm} Realm
 * @typedef {import('../script/external.js').ExternalEnumerator} ExternalEnumerator
 * @typedef {import('../script/values.js').SafeArrayValue} SafeArrayValue
 */

/** An Enumerator: the collection's own enumerator and the item it is on. */
export class EnumeratorObject extends JSObject
{
    /** @param {JSObject} proto */
    constructor(proto){
        super(proto, 'Object');
        /** @type {ExternalEnumerator | null} */
        this.source = null;
        /** @type {any} */
        this.current = undefined;
        this.atEnd = true;
    }
}

/** A VBArray: the SAFEARRAY's contents, read when it was made. */
export class VBArrayObject extends JSObject
{
    /** @param {JSObject} proto @param {ForeignValue} array */
    constructor(proto, array){
        super(proto, 'Object');
        this.array = array;
    }

    /** @returns {SafeArrayValue} */
    get contents(){
        return this.array.value;
    }
}

/** @param {Realm} realm */
export function installJScript(realm){
    const global = realm.global;
    const { version } = realm.options;

    realm.methods(global, [
        ['ScriptEngine', 0, ()=>'JScript'],
        ['ScriptEngineMajorVersion', 0, ()=>version.major],
        ['ScriptEngineMinorVersion', 0, ()=>version.minor],
        ['ScriptEngineBuildVersion', 0, ()=>version.build],
        ['CollectGarbage', 0, ()=>undefined],
        ['GetObject', 2, function*(_this, args){
            const path = args[0] === undefined ? '' : yield* realm.toString(args[0]);
            const progId = args[1] === undefined ? undefined : yield* realm.toString(args[1]);
            const bind = realm.options.getObject;
            if (!bind)
            {
                realm.options.divergence?.('JScript GetObject',
                    `"${path}"${progId === undefined ? '' : ` as ${progId}`}: no binding offered`);
                throw realm.error('Error', 429);
            }
            return yield* create(()=>bind(path, progId));
        }],
    ]);

    /**
     * An automation object the embedder makes; its failure to is error 429,
     * as JScript reports any.
     *
     * @param {() => any} make @returns {Generator<unknown, any, unknown>}
     */
    const create = function*(make){
        /** @param {unknown} e @returns {unknown} */
        const failure = e=>(e instanceof ExternalError ? realm.error('Error', 429) : e);
        let answer;
        try
        {
            answer = make();
        }
        catch (e){
            throw failure(e);
        }
        if (isThenable(answer))
        {
            try
            {
                answer = yield answer;
            }
            catch (e){
                throw failure(e);
            }
        }
        return answer;
    };

    /** @param {any[]} args @returns {Generator<unknown, any, unknown>} */
    const activeX = function*(args){
        const progId = yield* realm.toString(args[0]);
        const location = args[1] === undefined ? undefined : yield* realm.toString(args[1]);
        const make = realm.options.createObject;
        if (!make)
        {
            realm.options.divergence?.('JScript ActiveXObject', `${progId}: no classes offered`);
            throw realm.error('Error', 429);
        }
        return yield* create(()=>make(progId, location));
    };
    const activeXPrototype = realm.newObject();
    realm.defineConstructor('ActiveXObject', 1, activeXPrototype, (_this, args)=>activeX(args),
        (_this, args)=>activeX(args));

    installEnumerator(realm);
    installVBArray(realm);
}

/** @param {Realm} realm */
function installEnumerator(realm){
    const prototype = realm.newObject();

    /** @param {EnumeratorObject} enumerator @returns {Generator<unknown, void, unknown>} */
    const fetch = function*(enumerator){
        const source = enumerator.source;
        if (source === null)
        {
            enumerator.atEnd = true;
            enumerator.current = undefined;
            return;
        }
        const step = yield* realm.external(()=>source.next());
        enumerator.atEnd = Boolean(step.done);
        enumerator.current = step.done ? undefined : step.value;
    };

    /** @param {any[]} args @returns {Generator<unknown, EnumeratorObject, unknown>} */
    const make = function*(args){
        const enumerator = new EnumeratorObject(prototype);
        const collection = args[0];
        if (collection === undefined)
        {
            return enumerator;
        }
        if (!(collection instanceof ExternalObject))
        {
            throw realm.typeError(451);
        }
        enumerator.source = yield* realm.external(()=>collection.enumerate());
        yield* fetch(enumerator);
        return enumerator;
    };
    realm.defineConstructor('Enumerator', 1, prototype, (_this, args)=>make(args),
        (_this, args)=>make(args));

    /** @param {any} self @returns {EnumeratorObject} */
    const thisEnumerator = self=>{
        if (!(self instanceof EnumeratorObject))
        {
            throw realm.typeError(5015);
        }
        return self;
    };
    realm.methods(prototype, [
        ['atEnd', 0, self=>thisEnumerator(self).atEnd],
        ['item', 0, self=>{
            const enumerator = thisEnumerator(self);
            return enumerator.atEnd ? undefined : enumerator.current;
        }],
        ['moveFirst', 0, function*(self){
            const enumerator = thisEnumerator(self);
            const source = enumerator.source;
            if (source !== null)
            {
                yield* realm.external(()=>source.reset());
            }
            yield* fetch(enumerator);
            return undefined;
        }],
        ['moveNext', 0, function*(self){
            const enumerator = thisEnumerator(self);
            if (!enumerator.atEnd)
            {
                yield* fetch(enumerator);
            }
            return undefined;
        }],
    ]);
}

/** @param {Realm} realm */
function installVBArray(realm){
    const prototype = realm.newObject();

    /** @param {any[]} args @returns {VBArrayObject} */
    const make = args=>{
        const value = args[0];
        if (value instanceof VBArrayObject)
        {
            return new VBArrayObject(prototype, value.array);
        }
        if (!(value instanceof ForeignValue) || !value.isArray)
        {
            throw realm.typeError(5013);
        }
        return new VBArrayObject(prototype, value);
    };
    realm.defineConstructor('VBArray', 1, prototype, (_this, args)=>make(args),
        (_this, args)=>make(args));

    /** @param {any} self @returns {SafeArrayValue} */
    const thisArray = self=>{
        if (!(self instanceof VBArrayObject))
        {
            throw realm.typeError(5013);
        }
        return self.contents;
    };
    /**
     * A dimension a script names, counted from 1, as its bounds.
     *
     * @param {SafeArrayValue} array @param {any} which
     * @returns {Generator<unknown, { lower: number, count: number }, unknown>}
     */
    const dimension = function*(array, which){
        const n = which === undefined ? 1 : toInteger(yield* realm.toNumber(which));
        const bounds = array.bounds[n - 1];
        if (n < 1 || bounds === undefined)
        {
            throw realm.rangeError(9);
        }
        return bounds;
    };
    realm.methods(prototype, [
        ['dimensions', 0, self=>thisArray(self).bounds.length],
        ['lbound', 1, function*(self, args){
            return (yield* dimension(thisArray(self), args[0])).lower;
        }],
        ['ubound', 1, function*(self, args){
            const bounds = yield* dimension(thisArray(self), args[0]);
            return bounds.lower + bounds.count - 1;
        }],
        // The first index varies fastest, as the array stores its elements.
        ['getItem', 1, function*(self, args){
            const array = thisArray(self);
            if (args.length !== array.bounds.length)
            {
                throw realm.rangeError(9);
            }
            let offset = 0;
            let stride = 1;
            for (let d = 0; d < array.bounds.length; d++)
            {
                const { lower, count } = array.bounds[d];
                const index = toInteger(yield* realm.toNumber(args[d])) - lower;
                if (index < 0 || index >= count)
                {
                    throw realm.rangeError(9);
                }
                offset += index * stride;
                stride *= count;
            }
            return array.items[offset];
        }],
        ['toArray', 0, self=>realm.newArray([...thisArray(self).items])],
        ['valueOf', 0, self=>{
            if (!(self instanceof VBArrayObject))
            {
                throw realm.typeError(5013);
            }
            return self.array;
        }],
    ]);
}
