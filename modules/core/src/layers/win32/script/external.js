/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The external object protocol: how a script reaches an object that is not
 * the language's own.
 *
 * Two kinds of object stand behind it. A host object is written here, on the
 * host -- an installer's Session, a scripting host's WScript -- and answers
 * synchronously or with a promise as it likes. A guest object is a program's
 * IDispatch, reached through `guest-dispatch.js`, whose every answer is a
 * promise because the guest has to run to give it. A script engine treats the
 * two alike, and that is the point: the operations are IDispatch's, by name.
 *
 * - `get(name, args)`  DISPATCH_PROPERTYGET; a property that takes arguments
 *   (Session.Property("X")) has them in `args`.
 * - `put(name, value, args)`  DISPATCH_PROPERTYPUT.
 * - `call(name, args)`  DISPATCH_METHOD, its result wanted.
 * - `has(name)`  whether the object knows the name, as GetIDsOfNames answers.
 * - `keys()`  the names a for-in walks, where the object can list them.
 * - `enumerate()`  the collection's items in order, as DISPID_NEWENUM's
 *   IEnumVARIANT gives them.
 *
 * A null name is the object's default member, DISPID_VALUE: calling the
 * object itself, or reading it as a value.
 *
 * A failure is an {@link ExternalError} carrying the HRESULT the call
 * answered and, for DISP_E_EXCEPTION, the description and source the object
 * filled in; the engine turns it into the language's own error.
 *
 * @typedef {import('./values.js').Value} Value
 */

/** HRESULTs the protocol answers in. */
export const DISP_E_MEMBERNOTFOUND = 0x80020003 | 0;
export const DISP_E_PARAMNOTFOUND = 0x80020004 | 0;
export const DISP_E_TYPEMISMATCH = 0x80020005 | 0;
export const DISP_E_UNKNOWNNAME = 0x80020006 | 0;
export const DISP_E_EXCEPTION = 0x80020009 | 0;
export const DISP_E_BADPARAMCOUNT = 0x8002000e | 0;
export const E_NOTIMPL = 0x80004001 | 0;
export const E_FAIL = 0x80004005 | 0;

/** A call on an external object that failed, with what the object said. */
export class ExternalError extends Error
{
    /**
     * @param {number} number  The HRESULT, or the SCODE out of an EXCEPINFO.
     * @param {string} [description]
     * @param {string} [source]
     */
    constructor(number, description = '', source = ''){
        super(description || `HRESULT 0x${(number >>> 0).toString(16)}`);
        this.name = 'ExternalError';
        this.number = number | 0;
        this.description = description;
        this.source = source;
    }
}

/**
 * The name of the default member, DISPID_VALUE: a call of the object
 * itself, or the object read as a value.
 *
 * @type {null}
 */
export const DEFAULT_MEMBER = null;

/**
 * A member an object does not have, as the failure says it.
 *
 * @param {string} how @param {string | null} name @param {Value[]} args
 * @returns {ExternalError}
 */
function refused(how, name, args){
    return new ExternalError(DISP_E_UNKNOWNNAME,
        `${name ?? 'the default member'} cannot be ${how} with ${args.length} arguments`);
}

/**
 * Walks a collection: `next` answers the following item, or done; `reset`
 * starts over. Either may answer with a promise.
 *
 * @typedef {Object} ExternalEnumerator
 * @property {() => IteratorResult<Value, undefined>
 *     | Promise<IteratorResult<Value, undefined>>} next
 * @property {() => void | Promise<void>} reset
 */

/**
 * The protocol's base: every operation refused as an object without that
 * member refuses it. An implementation overrides what it answers.
 */
export class ExternalObject
{
    /** What the object calls itself in a message, as TypeName would. */
    get typeName(){
        return 'Object';
    }

    /**
     * @param {string | null} name @param {Value[]} args
     * @returns {Value | Promise<Value>}
     */
    get(name, args){
        throw refused('read', name, args);
    }

    /**
     * @param {string | null} name @param {Value} _value @param {Value[]} args
     * @returns {void | Promise<void>}
     */
    put(name, _value, args){
        throw refused('written', name, args);
    }

    /**
     * @param {string | null} name @param {Value[]} args
     * @returns {Value | Promise<Value>}
     */
    call(name, args){
        throw refused('called', name, args);
    }

    /**
     * Whether the object has a member, which an object that lists its
     * names answers from the list.
     *
     * @param {string} name
     * @returns {boolean | Promise<boolean>}
     */
    has(name){
        const names = this.keys();
        return Array.isArray(names) && names.includes(name);
    }

    /** @returns {string[] | Promise<string[]>} */
    keys(){
        return [];
    }

    /** @returns {ExternalEnumerator | Promise<ExternalEnumerator>} */
    enumerate(){
        throw new ExternalError(DISP_E_MEMBERNOTFOUND);
    }
}

/**
 * One member of a host object. A member with `get` and no `call` is called
 * by being read with the call's arguments -- METHOD|PROPERTYGET, which is how
 * a script calls a parameterised property -- and a member with only a `call`
 * is not a property: reading it without calling it is refused.
 *
 * @typedef {Object} HostMember
 * @property {(args: Value[]) => Value | Promise<Value>} [get]
 * @property {(value: Value, args: Value[]) => void | Promise<void>} [put]
 * @property {(args: Value[]) => Value | Promise<Value>} [call]
 */

/**
 * @typedef {Object} HostObjectSpec
 * @property {string} [typeName]
 * @property {Record<string, HostMember>} members  By name; matched without case.
 * @property {HostMember} [value]  The default member.
 * @property {() => Value[] | Promise<Value[]>} [items]  What `enumerate` walks.
 */

/** A host object made from a table of members. */
class HostObject extends ExternalObject
{
    /** @param {HostObjectSpec} spec */
    constructor(spec){
        super();
        this.spec = spec;
        /** @type {Map<string, HostMember>} */
        this.members = new Map(Object.entries(spec.members)
            .map(([name, member])=>[name.toLowerCase(), member]));
        this.names = Object.keys(spec.members);
    }

    get typeName(){
        return this.spec.typeName ?? 'Object';
    }

    /** @param {string | null} name @returns {HostMember} */
    member(name){
        const member = name === null ? this.spec.value : this.members.get(name.toLowerCase());
        if (!member)
        {
            throw new ExternalError(name === null ? DISP_E_MEMBERNOTFOUND : DISP_E_UNKNOWNNAME);
        }
        return member;
    }

    /** @param {string | null} name @param {Value[]} args */
    get(name, args){
        const member = this.member(name);
        if (!member.get)
        {
            throw new ExternalError(DISP_E_MEMBERNOTFOUND);
        }
        return member.get(args);
    }

    /** @param {string | null} name @param {Value} value @param {Value[]} args */
    put(name, value, args){
        const member = this.member(name);
        if (!member.put)
        {
            throw new ExternalError(DISP_E_MEMBERNOTFOUND);
        }
        return member.put(value, args);
    }

    /** @param {string | null} name @param {Value[]} args */
    call(name, args){
        const member = this.member(name);
        const answer = member.call ?? member.get;
        if (!answer)
        {
            throw new ExternalError(DISP_E_MEMBERNOTFOUND);
        }
        return answer(args);
    }

    /** @param {string} name */
    has(name){
        return this.members.has(name.toLowerCase());
    }

    keys(){
        return [...this.names];
    }

    enumerate(){
        const items = this.spec.items;
        if (!items)
        {
            throw new ExternalError(DISP_E_MEMBERNOTFOUND);
        }
        return listEnumerator(items);
    }
}

/**
 * An enumerator over a list a function gives, read again at each reset.
 *
 * @param {() => Value[] | Promise<Value[]>} items
 * @returns {Promise<ExternalEnumerator> | ExternalEnumerator}
 */
function listEnumerator(items){
    /** @param {Value[]} list @returns {ExternalEnumerator} */
    const over = list=>{
        let at = 0;
        let current = list;
        return {
            next: ()=>(at < current.length
                ? { done: false, value: current[at++] }
                : { done: true, value: undefined }),
            reset: ()=>{
                at = 0;
                const again = items();
                if (Array.isArray(again))
                {
                    current = again;
                    return undefined;
                }
                return again.then(fresh=>{
                    current = fresh;
                });
            },
        };
    };
    const first = items();
    return Array.isArray(first) ? over(first) : first.then(over);
}

/**
 * An external object from a table of members: how a host-side object such as
 * an installer's Session is handed to a script.
 *
 * @param {HostObjectSpec} spec
 * @returns {ExternalObject}
 */
export function hostObject(spec){
    return new HostObject(spec);
}

/**
 * An external object made only when first used: an active script's named
 * item, which its site is asked for the first time a script names it.
 * Every operation waits for the object and is then the object's own; a
 * load that answers anything but an external object is an object with no
 * members.
 *
 * @param {() => Promise<Value> | Value} load  Called once.
 * @returns {ExternalObject}
 */
export function deferredExternal(load){
    /** @type {Promise<ExternalObject | null> | null} */
    let loading = null;
    const target = ()=>{
        loading ??= Promise.resolve(load()).then(value=>(value instanceof ExternalObject
            ? value : null));
        return loading;
    };
    /** @returns {Promise<ExternalObject>} */
    const object = async()=>{
        const found = await target();
        if (found === null)
        {
            throw new ExternalError(DISP_E_UNKNOWNNAME);
        }
        return found;
    };
    return new class extends ExternalObject
    {
        /** @param {string | null} name @param {Value[]} args */
        async get(name, args){
            return (await object()).get(name, args);
        }

        /** @param {string | null} name @param {Value} value @param {Value[]} args */
        async put(name, value, args){
            return (await object()).put(name, value, args);
        }

        /** @param {string | null} name @param {Value[]} args */
        async call(name, args){
            return (await object()).call(name, args);
        }

        /** @param {string} name */
        async has(name){
            const found = await target();
            return found !== null && Boolean(await found.has(name));
        }

        async keys(){
            const found = await target();
            return found === null ? [] : found.keys();
        }

        async enumerate(){
            return (await object()).enumerate();
        }
    }();
}
