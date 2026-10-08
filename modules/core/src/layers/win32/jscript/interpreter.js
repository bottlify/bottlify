/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The evaluator: ECMA-262 3rd edition clauses 10 to 13 over the parser's
 * tree, run as generators so that any step may wait on a guest object (see
 * `script/drive.js`).
 *
 * A statement answers its completion: undefined for a normal one, or a
 * break, continue or return record. A `throw` is a host exception carrying
 * the value ({@link ScriptThrow}); nothing else a script can catch is.
 *
 * Runaway scripts are the embedder's to stop: every loop iteration and call
 * counts down, and at zero the embedder's checkpoint runs, which may wait
 * (to let the rest of the machine run) or end the script with
 * {@link ScriptAbort}. The count changes nothing a script can observe.
 */

import { isThenable } from '../script/drive.js';
import { DEFAULT_MEMBER, ExternalObject } from '../script/external.js';
import { ForeignValue } from '../script/values.js';
import { MESSAGES, SyntaxFailure, errorNumber } from './errors.js';
import {
    ArgumentsObject, DONTDELETE, DONTENUM, DeclarativeScope, InvalidLength, JSArray, JSFunction,
    JSObject, ObjectScope, Property, READONLY, ScriptAbort, ScriptThrow, isSteps,
} from './objects.js';
import { N, parseFunctionParts, parseProgram } from './parser.js';
import { isPrimitive, numberToString, toBoolean } from './realm.js';

/** Completion kinds; a normal completion is undefined. */
const BREAK = 1;
const CONTINUE = 2;
const RETURN = 3;

/** Loop iterations and calls between two checkpoints. */
const CHECK_INTERVAL = 4096;

/** A name found on an external object, which only a generator can read. */
const ASYNC = Symbol('async');

/** An expression {@link Interpreter#simple} cannot answer without steps. */
const COMPLEX = Symbol('complex');

/**
 * @typedef {import('./parser.js').Node} Node
 * @typedef {import('./parser.js').FunctionNode} FunctionNode
 * @typedef {import('./objects.js').Scope} Scope
 * @typedef {{ k: number, label?: string | null, value?: any } | undefined} Completion
 * @typedef {Generator<unknown, any, unknown>} Steps
 */

/** The execution context (10.2): its scope chain, `this`, and where vars go. */
export class Context
{
    /**
     * @param {Scope} scope @param {any} thisValue
     * @param {Scope} varScope  Where a var an eval declares is put.
     */
    constructor(scope, thisValue, varScope){
        this.scope = scope;
        this.thisValue = thisValue;
        this.varScope = varScope;
    }
}

/** Whether a host failure is the stack running out, which a script sees as error 28. */
const isStackOverflow = (/** @type {unknown} */ e)=>e instanceof RangeError
    && /call stack/i.test(e.message);

/**
 * @typedef {Object} InterpreterOptions
 * @property {() => void | Promise<void>} [checkpoint]
 *     Called every so many loop iterations and calls; may wait, or throw
 *     {@link ScriptAbort} to end the script.
 * @property {import('./parser.js').ParseOptions} [parse]
 *     How an eval or a Function's text is parsed: the conditional
 *     compilation state the engine keeps.
 * @property {boolean} [fastPaths]  False evaluates everything through the
 *     generator paths: the other arm of the gate that compares them.
 */

export class Interpreter
{
    /**
     * @param {import('./realm.js').Realm} realm
     * @param {InterpreterOptions} [options]
     */
    constructor(realm, options = {}){
        this.realm = realm;
        this.options = options;
        /** Whether the steps-free paths beside the generator ones are taken. */
        this.fast = options.fastPaths !== false;
        realm.runner = this;
        this.budget = CHECK_INTERVAL;
        /** @type {string | null} why the embedder asked the script to stop */
        this.interrupted = null;
        /** The value of the last expression statement, for eval and global code. */
        /** @type {any} */
        this.completion = undefined;
        this.globalScope = new ObjectScope(realm.global, null, false);
        /** @type {WeakMap<Node, JSObject>} each regular expression literal's object */
        this.regexps = new WeakMap();
    }

    /** Asks the running script to stop at its next checkpoint. @param {string} reason */
    interrupt(reason){
        this.interrupted = reason;
        this.budget = 0;
    }

    /** @returns {Steps} */
    *checkpoint(){
        this.budget = CHECK_INTERVAL;
        const check = ()=>{
            if (this.interrupted !== null)
            {
                const reason = this.interrupted;
                this.interrupted = null;
                throw new ScriptAbort(reason);
            }
        };
        check();
        const hook = this.options.checkpoint;
        if (hook)
        {
            const answer = hook();
            if (isThenable(answer))
            {
                yield answer;
            }
            check();
        }
    }

    /**
     * Turns what reached a catch into the value thrown, or lets it through
     * when it is no script's to catch.
     *
     * @param {unknown} e @returns {ScriptThrow}
     */
    catchable(e){
        if (e instanceof ScriptThrow)
        {
            return e;
        }
        if (isStackOverflow(e))
        {
            return this.realm.error('Error', 28);
        }
        if (e instanceof InvalidLength)
        {
            return this.realm.rangeError(5030);
        }
        throw e;
    }

    /**
     * A syntax error in a text an eval or a Function constructor was given,
     * as the SyntaxError a script can catch.
     *
     * @param {unknown} e @returns {unknown}
     */
    syntaxError(e){
        if (e instanceof SyntaxFailure)
        {
            return new ScriptThrow(this.realm.makeError('SyntaxError', errorNumber(e.code),
                MESSAGES[e.code] ?? 'Syntax error'), this.realm.where());
        }
        return e;
    }

    /**
     * Global code: declarations instantiated on the global object, then the
     * statements; answers the value of the last expression statement.
     *
     * @param {FunctionNode} program @returns {Steps}
     */
    *runProgram(program){
        const realm = this.realm;
        const ctx = new Context(this.globalScope, realm.global, this.globalScope);
        const savedSource = realm.source;
        const savedCompletion = this.completion;
        realm.source = program.source;
        this.completion = undefined;
        try
        {
            this.instantiate(program, ctx, false);
            const completion = yield* this.execList(program.body, ctx);
            if (completion !== undefined)
            {
                // A break or continue cannot reach here past the parser; a
                // return cannot either.
                throw new Error(`completion ${completion.k} out of global code`);
            }
            return this.completion;
        }
        finally
        {
            realm.source = savedSource;
            this.completion = savedCompletion;
        }
    }

    /**
     * Variable instantiation (10.1.3): functions, then vars that are not
     * already there. An eval's are deletable; everyone else's are not.
     *
     * @param {FunctionNode} node @param {Context} ctx @param {boolean} deletable
     */
    instantiate(node, ctx, deletable){
        const flags = deletable ? 0 : DONTDELETE;
        const target = ctx.varScope;
        for (const fn of node.funcs)
        {
            const value = this.makeFunction(fn, ctx.scope);
            const name = /** @type {string} */ (fn.name);
            if (target instanceof DeclarativeScope)
            {
                target.vars.set(name, new Property(value, flags));
            }
            else
            {
                const existing = target.object.own(name);
                if (existing !== undefined && (existing.flags & READONLY) !== 0)
                {
                    continue;
                }
                target.object.props.set(name, new Property(value, flags));
            }
        }
        for (const name of node.vars)
        {
            if (target instanceof DeclarativeScope)
            {
                if (!target.vars.has(name))
                {
                    target.vars.set(name, new Property(undefined, flags));
                }
            }
            else if (!target.object.has(name))
            {
                target.object.props.set(name, new Property(undefined, flags));
            }
        }
    }

    /**
     * A function object for a function's node, closing over `scope`.
     *
     * @param {FunctionNode} node @param {Scope} scope @returns {JSFunction}
     */
    makeFunction(node, scope){
        const realm = this.realm;
        const fn = new JSFunction(realm.functionPrototype);
        fn.node = node;
        fn.scope = scope;
        fn.define('length', node.params.length, READONLY | DONTENUM | DONTDELETE);
        const prototype = realm.newObject();
        prototype.define('constructor', fn, DONTENUM);
        fn.define('prototype', prototype, DONTDELETE);
        return fn;
    }

    /**
     * Calls a script function (13.2.1).
     *
     * @param {JSFunction} fn @param {any} thisValue @param {any[]} args
     * @returns {Steps}
     */
    *callScript(fn, thisValue, args){
        if (--this.budget <= 0)
        {
            yield* this.checkpoint();
        }
        const realm = this.realm;
        const node = /** @type {FunctionNode} */ (fn.node);
        const scope = new DeclarativeScope(fn.scope);
        const params = node.params;
        for (let i = 0; i < params.length; i++)
        {
            scope.vars.set(params[i], new Property(args[i], DONTDELETE));
        }
        if ((node.usesArguments || node.usesEval) && !scope.vars.has('arguments'))
        {
            scope.vars.set('arguments', new Property(this.argumentsObject(fn, node, scope, args),
                DONTDELETE));
        }
        // A this that is not an object is the global object (10.2.3); the
        // caller has already made a primitive one an object where ES3 says so.
        const self = thisValue === null || thisValue === undefined || isPrimitive(thisValue)
            ? realm.global : thisValue;
        const ctx = new Context(scope, self, scope);
        const savedSource = realm.source;
        realm.source = node.source;
        try
        {
            this.instantiate(node, ctx, false);
            const completion = yield* this.execList(node.body, ctx);
            return completion !== undefined && completion.k === RETURN
                ? completion.value : undefined;
        }
        finally
        {
            realm.source = savedSource;
        }
    }

    /**
     * The arguments object (10.1.8).
     *
     * @param {JSFunction} fn @param {FunctionNode} node @param {DeclarativeScope} scope
     * @param {any[]} args @returns {ArgumentsObject}
     */
    argumentsObject(fn, node, scope, args){
        const object = new ArgumentsObject(this.realm.objectPrototype);
        object.define('callee', fn, DONTENUM);
        object.define('length', args.length, DONTENUM);
        for (let i = 0; i < args.length; i++)
        {
            const name = node.params[i];
            // A named parameter shares its property; a later parameter of the
            // same name owns it, so the index is unmapped then.
            const shared = name !== undefined && node.params.lastIndexOf(name) === i
                ? scope.vars.get(name) : undefined;
            object.props.set(String(i), shared ?? new Property(args[i], 0));
        }
        return object;
    }

    /**
     * [[Construct]] of a script function (13.2.2).
     *
     * @param {JSFunction} fn @param {any[]} args @returns {Steps}
     */
    *constructScript(fn, args){
        const realm = this.realm;
        const prototype = fn.get('prototype');
        const object = new JSObject(prototype instanceof JSObject
            ? prototype : realm.objectPrototype, 'Object');
        const answer = yield* this.callScript(fn, object, args);
        return answer instanceof JSObject || answer instanceof ExternalObject ? answer : object;
    }

    /**
     * eval (15.1.2.1): the text parsed and run in the caller's context, or
     * in the global one for an eval not called by that name.
     *
     * @param {string} text @param {Context | null} ctx @returns {Steps}
     */
    *evaluate(text, ctx){
        let program;
        try
        {
            program = parseProgram(text, this.options.parse);
        }
        catch (e){
            throw this.syntaxError(e);
        }
        const context = ctx ?? new Context(this.globalScope, this.realm.global, this.globalScope);
        const savedCompletion = this.completion;
        this.completion = undefined;
        try
        {
            this.instantiate(program, context, true);
            const completion = yield* this.execList(program.body, context);
            if (completion !== undefined)
            {
                throw new Error(`completion ${completion.k} out of eval code`);
            }
            return this.completion;
        }
        finally
        {
            this.completion = savedCompletion;
        }
    }

    /**
     * The Function constructor's function, in the global scope.
     *
     * @param {string} params @param {string} body @returns {JSFunction}
     */
    compileFunction(params, body){
        let node;
        try
        {
            node = parseFunctionParts(params, body, this.options.parse);
        }
        catch (e){
            throw this.syntaxError(e);
        }
        return this.makeFunction(node, this.globalScope);
    }

    /**
     * A condition's value, without starting steps where none are needed.
     *
     * @param {Node} n @param {Context} ctx @returns {Steps}
     */
    *test(n, ctx){
        const value = this.simple(n, ctx);
        return value === COMPLEX ? yield* this.expr(n, ctx) : value;
    }

    /** @param {Node[]} list @param {Context} ctx @returns {Generator<unknown, Completion, unknown>} */
    *execList(list, ctx){
        for (let i = 0; i < list.length; i++)
        {
            const completion = yield* this.exec(list[i], ctx);
            if (completion !== undefined)
            {
                return completion;
            }
        }
        return undefined;
    }

    /**
     * How a loop treats its body's completion: 0 to go on, 1 to stop, 2 to
     * pass it outward.
     *
     * @param {NonNullable<Completion>} completion @param {string[]} labels
     * @returns {number}
     */
    loopExit(completion, labels){
        const { k, label } = completion;
        if (k === CONTINUE && (label === null || labels.includes(/** @type {string} */ (label))))
        {
            return 0;
        }
        if (k === BREAK && (label === null || labels.includes(/** @type {string} */ (label))))
        {
            return 1;
        }
        return 2;
    }

    /** @param {Node} n @param {Context} ctx @returns {Generator<unknown, Completion, unknown>} */
    *exec(n, ctx){
        const realm = this.realm;
        realm.offset = n.s;
        switch (n.type)
        {
            case N.Expr:
            {
                const value = this.effect(n.expression, ctx);
                this.completion = value === COMPLEX ? yield* this.expr(n.expression, ctx) : value;
                return undefined;
            }
            case N.Var:
                for (const decl of n.decls)
                {
                    if (decl.init !== null)
                    {
                        realm.offset = decl.s;
                        const value = yield* this.expr(decl.init, ctx);
                        yield* this.setName(decl.name, value, ctx.scope);
                    }
                }
                return undefined;
            case N.Empty:
            case N.FuncDecl:
                return undefined;
            case N.Block:
                return yield* this.execList(n.body, ctx);
            case N.If:
                if (toBoolean(yield* this.test(n.test, ctx)))
                {
                    return yield* this.exec(n.consequent, ctx);
                }
                return n.alternate === null ? undefined : yield* this.exec(n.alternate, ctx);
            case N.Do:
                do {
                    if (--this.budget <= 0)
                    {
                        yield* this.checkpoint();
                    }
                    const completion = yield* this.exec(n.body, ctx);
                    if (completion !== undefined)
                    {
                        const exit = this.loopExit(completion, n.labels);
                        if (exit === 1)
                        {
                            break;
                        }
                        if (exit === 2)
                        {
                            return completion;
                        }
                    }
                    realm.offset = n.test.s;
                } while (toBoolean(yield* this.test(n.test, ctx)));
                return undefined;
            case N.While:
                while (toBoolean(yield* this.test(n.test, ctx)))
                {
                    if (--this.budget <= 0)
                    {
                        yield* this.checkpoint();
                    }
                    const completion = yield* this.exec(n.body, ctx);
                    if (completion !== undefined)
                    {
                        const exit = this.loopExit(completion, n.labels);
                        if (exit === 1)
                        {
                            break;
                        }
                        if (exit === 2)
                        {
                            return completion;
                        }
                    }
                    realm.offset = n.test.s;
                }
                return undefined;
            case N.For:
                return yield* this.forStatement(n, ctx);
            case N.ForIn:
                return yield* this.forIn(n, ctx);
            case N.Continue:
            case N.Break:
                return n.completion;
            case N.Return:
                return { k: RETURN, value: n.argument === null
                    ? undefined : yield* this.expr(n.argument, ctx) };
            case N.With:
            {
                const value = yield* this.expr(n.object, ctx);
                const object = realm.toObject(value, describe(n.object) ?? undefined);
                const inner = new Context(new ObjectScope(object, ctx.scope, true), ctx.thisValue,
                    ctx.varScope);
                return yield* this.exec(n.body, inner);
            }
            case N.Switch:
                return yield* this.switchStatement(n, ctx);
            case N.Labeled:
            {
                const completion = yield* this.exec(n.body, ctx);
                if (completion !== undefined && completion.k === BREAK
                    && completion.label === n.label)
                {
                    return undefined;
                }
                return completion;
            }
            case N.Throw:
            {
                const value = yield* this.expr(n.argument, ctx);
                realm.offset = n.s;
                throw new ScriptThrow(value, realm.where());
            }
            case N.Try:
                return yield* this.tryStatement(n, ctx);
            default:
                throw new Error(`statement kind ${n.type}`);
        }
    }

    /** @param {Node} n @param {Context} ctx @returns {Generator<unknown, Completion, unknown>} */
    *forStatement(n, ctx){
        const realm = this.realm;
        if (n.init !== null)
        {
            if (n.init.type === N.Var)
            {
                yield* this.exec(n.init, ctx);
            }
            else
            {
                yield* this.expr(n.init, ctx);
            }
        }
        for (;;)
        {
            if (n.test !== null)
            {
                realm.offset = n.test.s;
                let test = this.simple(n.test, ctx);
                if (test === COMPLEX)
                {
                    test = yield* this.expr(n.test, ctx);
                }
                if (!toBoolean(test))
                {
                    break;
                }
            }
            if (--this.budget <= 0)
            {
                yield* this.checkpoint();
            }
            const completion = yield* this.exec(n.body, ctx);
            if (completion !== undefined)
            {
                const exit = this.loopExit(completion, n.labels);
                if (exit === 1)
                {
                    break;
                }
                if (exit === 2)
                {
                    return completion;
                }
            }
            if (n.update !== null)
            {
                realm.offset = n.update.s;
                if (this.effect(n.update, ctx) === COMPLEX)
                {
                    yield* this.expr(n.update, ctx);
                }
            }
        }
        return undefined;
    }

    /**
     * for-in (12.6.4): the enumerable names of the object and its
     * prototypes, each once, a name deleted before it is reached skipped.
     * An external object lists its own; null and undefined list none.
     *
     * @param {Node} n @param {Context} ctx @returns {Generator<unknown, Completion, unknown>}
     */
    *forIn(n, ctx){
        const realm = this.realm;
        if (n.decl !== null && n.decl.init !== null)
        {
            yield* this.setName(n.decl.name, yield* this.expr(n.decl.init, ctx), ctx.scope);
        }
        const value = yield* this.expr(n.object, ctx);
        if (value === null || value === undefined)
        {
            return undefined;
        }
        const object = realm.toObject(value);
        /** @type {string[]} */
        let names;
        if (object instanceof JSObject)
        {
            names = enumerableNames(object);
        }
        else
        {
            const listed = yield* realm.external(()=>object.keys());
            names = [...listed];
        }
        for (const name of names)
        {
            if (object instanceof JSObject && !object.has(name))
            {
                continue;
            }
            if (--this.budget <= 0)
            {
                yield* this.checkpoint();
            }
            if (n.decl !== null)
            {
                yield* this.setName(n.decl.name, name, ctx.scope);
            }
            else
            {
                yield* this.assignTo(n.target, name, ctx);
            }
            const completion = yield* this.exec(n.body, ctx);
            if (completion !== undefined)
            {
                const exit = this.loopExit(completion, n.labels);
                if (exit === 1)
                {
                    break;
                }
                if (exit === 2)
                {
                    return completion;
                }
            }
        }
        return undefined;
    }

    /** @param {Node} n @param {Context} ctx @returns {Generator<unknown, Completion, unknown>} */
    *switchStatement(n, ctx){
        const value = yield* this.expr(n.discriminant, ctx);
        let start = -1;
        for (let i = 0; i < n.cases.length; i++)
        {
            const clause = n.cases[i];
            if (clause.test !== null && value === (yield* this.expr(clause.test, ctx)))
            {
                start = i;
                break;
            }
        }
        if (start < 0)
        {
            start = n.cases.findIndex((/** @type {any} */ clause)=>clause.test === null);
            if (start < 0)
            {
                return undefined;
            }
        }
        for (let i = start; i < n.cases.length; i++)
        {
            const completion = yield* this.execList(n.cases[i].body, ctx);
            if (completion !== undefined)
            {
                if (completion.k === BREAK && (completion.label === null
                    || n.labels.includes(completion.label)))
                {
                    return undefined;
                }
                return completion;
            }
        }
        return undefined;
    }

    /** @param {Node} n @param {Context} ctx @returns {Generator<unknown, Completion, unknown>} */
    *tryStatement(n, ctx){
        /** @type {Completion} */
        let completion;
        /** @type {unknown} */
        let pending = null;
        let failed = false;
        try
        {
            completion = yield* this.exec(n.block, ctx);
        }
        catch (e){
            const thrown = this.catchable(e);
            if (n.handler !== null)
            {
                const scope = new DeclarativeScope(ctx.scope);
                scope.vars.set(n.param, new Property(thrown.value, DONTDELETE));
                try
                {
                    completion = yield* this.exec(n.handler,
                        new Context(scope, ctx.thisValue, ctx.varScope));
                }
                catch (_e){
                    if (n.finalizer === null || _e instanceof ScriptAbort)
                    {
                        throw _e;
                    }
                    pending = _e;
                    failed = true;
                }
            }
            else
            {
                pending = thrown;
                failed = true;
            }
        }
        if (n.finalizer !== null)
        {
            const finished = yield* this.exec(n.finalizer, ctx);
            if (finished !== undefined)
            {
                return finished;
            }
        }
        if (failed)
        {
            throw pending;
        }
        return completion;
    }

    /**
     * The binding of a name, found without running anything: a property, or
     * undefined when no scope has it, or {@link ASYNC} when an external
     * object on the chain has to be asked.
     *
     * @param {string} name @param {Scope | null} scope
     * @returns {Property | undefined | typeof ASYNC}
     */
    binding(name, scope){
        for (let s = scope; s !== null; s = s.parent)
        {
            if (s instanceof DeclarativeScope)
            {
                const found = s.vars.get(name);
                if (found !== undefined)
                {
                    return found;
                }
            }
            else
            {
                const object = s.object;
                if (!(object instanceof JSObject))
                {
                    return ASYNC;
                }
                const found = object.lookup(name);
                if (found !== undefined)
                {
                    return found;
                }
            }
        }
        return undefined;
    }

    /**
     * Resolves a name along the scope chain (10.1.4), asking external
     * objects and then the host's named items. Answers where it was found:
     * a value, with the object a call through it has as `this` -- a `with`
     * object's, or null -- or an external object that has it as a member,
     * which is read, or called, by name.
     *
     * @param {string} name @param {Scope} scope
     * @returns {Generator<unknown, { value: any, base: any, member: boolean } | null, unknown>}
     */
    *resolve(name, scope){
        const realm = this.realm;
        for (let s = /** @type {Scope | null} */ (scope); s !== null; s = s.parent)
        {
            if (s instanceof DeclarativeScope)
            {
                const found = s.vars.get(name);
                if (found !== undefined)
                {
                    return { value: found.value, base: null, member: false };
                }
                continue;
            }
            const object = s.object;
            if (object instanceof JSObject)
            {
                const found = object.lookup(name);
                if (found !== undefined)
                {
                    return { value: found.value, base: s.isWith ? object : null, member: false };
                }
                continue;
            }
            const known = yield* realm.external(()=>object.has(name));
            if (known)
            {
                return { value: undefined, base: object, member: true };
            }
        }
        if (realm.globalFallback !== null)
        {
            const found = yield* realm.globalFallback(name);
            if (found !== null)
            {
                return { value: found.value, base: null, member: false };
            }
        }
        return null;
    }

    /**
     * The value of what {@link resolve} found.
     *
     * @param {string} name @param {{ value: any, base: any, member: boolean }} found
     * @returns {Steps}
     */
    *valueOf(name, found){
        if (!found.member)
        {
            return found.value;
        }
        const base = found.base;
        return yield* this.realm.external(()=>base.get(name, []));
    }

    /** @param {string} name @param {Scope} scope @returns {Steps} */
    *getName(name, scope){
        const found = yield* this.resolve(name, scope);
        if (found === null)
        {
            throw this.realm.typeError(5009, `'${name}' is undefined`);
        }
        return yield* this.valueOf(name, found);
    }

    /**
     * PutValue on a name: the binding that has it, or a new property of the
     * global object.
     *
     * @param {string} name @param {any} value @param {Scope} scope @returns {Steps}
     */
    *setName(name, value, scope){
        const realm = this.realm;
        for (let s = /** @type {Scope | null} */ (scope); s !== null; s = s.parent)
        {
            if (s instanceof DeclarativeScope)
            {
                const found = s.vars.get(name);
                if (found !== undefined)
                {
                    if ((found.flags & READONLY) === 0)
                    {
                        found.value = value;
                    }
                    return;
                }
                continue;
            }
            const object = s.object;
            if (object instanceof JSObject)
            {
                if (object.has(name))
                {
                    yield* this.putMember(object, name, value);
                    return;
                }
                continue;
            }
            const known = yield* realm.external(()=>object.has(name));
            if (known)
            {
                yield* realm.external(()=>object.put(name, value, []));
                return;
            }
        }
        realm.global.put(name, value);
    }

    /**
     * [[Get]] through a value of any kind: a primitive's prototype answers
     * for it, an external object is asked.
     *
     * @param {any} base @param {string} key @param {Node} [objectNode]
     *     The expression the base came from, named in the error.
     * @returns {Steps}
     */
    *getMember(base, key, objectNode){
        if (base instanceof JSObject)
        {
            return base.get(key);
        }
        const realm = this.realm;
        switch (typeof base)
        {
            case 'string':
                return key === 'length' ? base.length : realm.stringPrototype.get(key);
            case 'number':
                return realm.numberPrototype.get(key);
            case 'boolean':
                return realm.booleanPrototype.get(key);
            default:
                break;
        }
        if (base instanceof ExternalObject)
        {
            return yield* realm.external(()=>base.get(key, []));
        }
        throw this.notAnObject(base, objectNode);
    }

    /**
     * The error for a member of something that has none.
     *
     * @param {any} base @param {Node} [objectNode] @returns {ScriptThrow}
     */
    notAnObject(base, objectNode){
        if (base instanceof ForeignValue)
        {
            return this.realm.typeError(438);
        }
        const text = objectNode === undefined ? null : describe(objectNode);
        return this.realm.typeError(5007, text === null
            ? undefined : `'${text}' is null or not an object`);
    }

    /**
     * [[Put]] through a value of any kind. A primitive's member is set on a
     * wrapper no one keeps, which is to say not at all.
     *
     * @param {any} base @param {string} key @param {any} value @param {Node} [objectNode]
     * @returns {Steps}
     */
    *putMember(base, key, value, objectNode){
        const realm = this.realm;
        if (base instanceof JSObject)
        {
            if (base instanceof JSArray && key === 'length')
            {
                const length = typeof value === 'number' ? value : yield* realm.toNumber(value);
                if ((length >>> 0) !== length)
                {
                    throw realm.rangeError(5030);
                }
                base.setLength(length);
                return;
            }
            base.put(key, value);
            return;
        }
        if (base instanceof ExternalObject)
        {
            yield* realm.external(()=>base.put(key, value, []));
            return;
        }
        if (base === null || base === undefined || base instanceof ForeignValue)
        {
            throw this.notAnObject(base, objectNode);
        }
    }

    /** @param {Node} n @param {Context} ctx @returns {Generator<unknown, string, unknown>} */
    *key(n, ctx){
        const value = n.type === N.Lit ? n.value : yield* this.expr(n, ctx);
        if (typeof value === 'string')
        {
            return value;
        }
        if (typeof value === 'number')
        {
            return numberToString(value);
        }
        return yield* this.realm.toString(value);
    }

    /** @param {Node[]} nodes @param {Context} ctx @returns {Generator<unknown, any[], unknown>} */
    *args(nodes, ctx){
        const values = new Array(nodes.length);
        for (let i = 0; i < nodes.length; i++)
        {
            const value = this.simple(nodes[i], ctx);
            values[i] = value === COMPLEX ? yield* this.expr(nodes[i], ctx) : value;
        }
        return values;
    }

    /**
     * The value of an expression that needs no step to find -- a literal,
     * `this`, a name bound in a variable or a plain object -- or
     * {@link COMPLEX} for one that does. The hot paths try this before
     * starting a generator for the expression.
     *
     * @param {Node} n @param {Context} ctx @returns {any}
     */
    simple(n, ctx){
        if (!this.fast)
        {
            return COMPLEX;
        }
        switch (n.type)
        {
            case N.Lit:
                return n.value;
            case N.This:
                return ctx.thisValue;
            case N.Ident:
            {
                const found = this.binding(n.name, ctx.scope);
                return found !== undefined && found !== ASYNC ? found.value : COMPLEX;
            }
            case N.Binary:
            {
                n.pure ??= isPure(n);
                if (!n.pure)
                {
                    return COMPLEX;
                }
                const left = this.simple(n.left, ctx);
                if (left === COMPLEX)
                {
                    return COMPLEX;
                }
                const right = this.simple(n.right, ctx);
                return right === COMPLEX ? COMPLEX : this.primitiveBinary(n.op, left, right);
            }
            default:
                return COMPLEX;
        }
    }

    /**
     * An expression statement's or a loop update's expression done without
     * steps where it can be -- an increment or an assignment of a simple
     * value to a variable -- or {@link COMPLEX}, with nothing done, when
     * it cannot.
     *
     * @param {Node} n @param {Context} ctx @returns {any}
     */
    effect(n, ctx){
        if (!this.fast)
        {
            return COMPLEX;
        }
        if (n.type === N.Update && n.target.type === N.Ident)
        {
            const found = this.writableBinding(n.target.name, ctx.scope);
            if (found === null || typeof found.value !== 'number')
            {
                return COMPLEX;
            }
            const old = found.value;
            found.value = n.op === '++' ? old + 1 : old - 1;
            return n.prefix ? found.value : old;
        }
        if (n.type === N.Assign && n.target.type === N.Ident)
        {
            const found = this.writableBinding(n.target.name, ctx.scope);
            if (found === null)
            {
                return COMPLEX;
            }
            const right = this.simple(n.value, ctx);
            if (right === COMPLEX)
            {
                return COMPLEX;
            }
            const value = n.op === '' ? right : this.primitiveBinary(n.op, found.value, right);
            if (value !== COMPLEX)
            {
                found.value = value;
            }
            return value;
        }
        return this.simple(n, ctx);
    }

    /**
     * A binary operator on two primitives, which runs no script: its answer,
     * or {@link COMPLEX} when an operand is an object.
     *
     * @param {string} op @param {any} a @param {any} b @returns {any}
     */
    primitiveBinary(op, a, b){
        if (typeof a === 'number' && typeof b === 'number')
        {
            return numericBinary(op, a, b) ?? COMPLEX;
        }
        if (!isPrimitive(a) || !isPrimitive(b))
        {
            return COMPLEX;
        }
        const realm = this.realm;
        switch (op)
        {
            case '+':
                return typeof a === 'string' || typeof b === 'string'
                    ? realm.primitiveString(a) + realm.primitiveString(b)
                    : realm.primitiveNumber(a) + realm.primitiveNumber(b);
            case '===':
                return a === b;
            case '!==':
                return a !== b;
            case '==':
                return primitiveEquals(realm, a, b);
            case '!=':
                return !primitiveEquals(realm, a, b);
            case '<': case '>': case '<=': case '>=':
                if (typeof a === 'string' && typeof b === 'string')
                {
                    return numericBinary(op, a < b ? 0 : a > b ? 2 : 1, 1);
                }
                return numericBinary(op, realm.primitiveNumber(a), realm.primitiveNumber(b));
            case 'in': case 'instanceof':
                return COMPLEX;
            default:
                return numericBinary(op, realm.primitiveNumber(a), realm.primitiveNumber(b))
                    ?? COMPLEX;
        }
    }

    /**
     * Evaluates an expression to its value.
     *
     * @param {Node} n @param {Context} ctx @returns {Steps}
     */
    *expr(n, ctx){
        const realm = this.realm;
        switch (n.type)
        {
            case N.Lit:
                return n.value;
            case N.Ident:
            {
                const found = this.binding(n.name, ctx.scope);
                if (found !== undefined && found !== ASYNC)
                {
                    return found.value;
                }
                return yield* this.getName(n.name, ctx.scope);
            }
            case N.This:
                return ctx.thisValue;
            case N.Member:
            {
                let base = this.simple(n.object, ctx);
                if (base === COMPLEX)
                {
                    base = yield* this.expr(n.object, ctx);
                }
                if (base instanceof JSObject)
                {
                    return base.get(n.name);
                }
                return yield* this.getMember(base, n.name, n.object);
            }
            case N.Index:
            {
                const base = yield* this.expr(n.object, ctx);
                const key = yield* this.key(n.property, ctx);
                return yield* this.getMember(base, key, n.object);
            }
            case N.Call:
                return yield* this.call(n, ctx);
            case N.New:
            {
                const callee = yield* this.expr(n.callee, ctx);
                const args = yield* this.args(n.args, ctx);
                return yield* realm.construct(callee, args);
            }
            case N.Func:
                return this.makeFunction(n.fn, ctx.scope);
            case N.ArrayLit:
            {
                const array = realm.newArray();
                const elements = n.elements;
                for (let i = 0; i < elements.length; i++)
                {
                    if (elements[i] !== null)
                    {
                        array.props.set(String(i),
                            new Property(yield* this.expr(elements[i], ctx), 0));
                    }
                }
                array.length = elements.length;
                return array;
            }
            case N.ObjectLit:
            {
                const object = realm.newObject();
                for (const property of n.properties)
                {
                    object.put(property.key, yield* this.expr(property.value, ctx));
                }
                return object;
            }
            case N.Regex:
            {
                let regexp = this.regexps.get(n);
                if (regexp === undefined)
                {
                    const factory = /** @type {NonNullable<typeof realm.regexpFactory>} */ (
                        realm.regexpFactory);
                    regexp = factory(n.pattern, n.flags);
                    this.regexps.set(n, regexp);
                }
                return regexp;
            }
            case N.Unary:
                return yield* this.unary(n, ctx);
            case N.Update:
            {
                if (this.fast && n.target.type === N.Ident)
                {
                    const found = this.writableBinding(n.target.name, ctx.scope);
                    if (found !== null && typeof found.value === 'number')
                    {
                        const old = found.value;
                        found.value = n.op === '++' ? old + 1 : old - 1;
                        return n.prefix ? found.value : old;
                    }
                }
                return yield* this.update(n, ctx);
            }
            case N.Binary:
            {
                let left = this.simple(n.left, ctx);
                if (left === COMPLEX)
                {
                    left = yield* this.expr(n.left, ctx);
                }
                let right = this.simple(n.right, ctx);
                if (right === COMPLEX)
                {
                    right = yield* this.expr(n.right, ctx);
                }
                if (typeof left === 'number' && typeof right === 'number')
                {
                    const answer = numericBinary(n.op, left, right);
                    if (answer !== undefined)
                    {
                        return answer;
                    }
                }
                return yield* this.binary(n.op, left, right);
            }
            case N.Logical:
            {
                const left = yield* this.expr(n.left, ctx);
                if (n.op === '&&' ? !toBoolean(left) : toBoolean(left))
                {
                    return left;
                }
                return yield* this.expr(n.right, ctx);
            }
            case N.Cond:
                return toBoolean(yield* this.expr(n.test, ctx))
                    ? yield* this.expr(n.consequent, ctx)
                    : yield* this.expr(n.alternate, ctx);
            case N.Assign:
                return yield* this.assign(n, ctx);
            case N.Seq:
            {
                let value;
                for (const expression of n.expressions)
                {
                    value = yield* this.expr(expression, ctx);
                }
                return value;
            }
            default:
                throw new Error(`expression kind ${n.type}`);
        }
    }

    /**
     * A call (11.2.3): `this` is the base of a member call -- an external
     * object's member is called by name -- the object of a `with` the
     * name was found on, or nothing. `eval` called by that name runs in the
     * caller's context.
     *
     * @param {Node} n @param {Context} ctx @returns {Steps}
     */
    *call(n, ctx){
        const realm = this.realm;
        const callee = n.callee;
        let fn;
        let thisValue = null;
        switch (callee.type)
        {
            case N.Member:
            case N.Index:
            {
                const base = yield* this.expr(callee.object, ctx);
                const key = callee.type === N.Member
                    ? callee.name : yield* this.key(callee.property, ctx);
                if (base instanceof ExternalObject)
                {
                    const args = yield* this.args(n.args, ctx);
                    return yield* realm.external(()=>base.call(key, args));
                }
                fn = yield* this.getMember(base, key, callee.object);
                thisValue = base;
                break;
            }
            case N.Ident:
            {
                const found = this.binding(callee.name, ctx.scope);
                if (found !== undefined && found !== ASYNC && !this.inWith(ctx.scope))
                {
                    fn = found.value;
                }
                else
                {
                    const resolved = yield* this.resolve(callee.name, ctx.scope);
                    if (resolved === null)
                    {
                        throw realm.typeError(5009, `'${callee.name}' is undefined`);
                    }
                    if (resolved.member)
                    {
                        const base = resolved.base;
                        const args = yield* this.args(n.args, ctx);
                        return yield* realm.external(()=>base.call(callee.name, args));
                    }
                    fn = resolved.value;
                    thisValue = resolved.base;
                }
                break;
            }
            default:
                fn = yield* this.expr(callee, ctx);
                break;
        }
        const args = yield* this.args(n.args, ctx);
        if (fn instanceof JSFunction)
        {
            if (fn === realm.evalFunction && callee.type === N.Ident && callee.name === 'eval')
            {
                return typeof args[0] === 'string' ? yield* this.evaluate(args[0], ctx) : args[0];
            }
            if (fn.native !== null)
            {
                const answer = fn.native(thisValue === null ? undefined : thisValue, args, fn);
                return isSteps(answer) ? yield* answer : answer;
            }
            if (thisValue !== null && isPrimitive(thisValue))
            {
                thisValue = realm.toObject(thisValue);
            }
            return yield* this.callScript(fn, thisValue, args);
        }
        if (fn instanceof ExternalObject)
        {
            return yield* realm.external(()=>fn.call(DEFAULT_MEMBER, args));
        }
        const text = describe(callee);
        throw realm.typeError(5002, text === null ? undefined : `'${text}' is not a function`);
    }

    /** @param {Scope | null} scope @returns {boolean} whether a `with` is on the chain */
    inWith(scope){
        for (let s = scope; s !== null; s = s.parent)
        {
            if (s instanceof ObjectScope && s.isWith)
            {
                return true;
            }
        }
        return false;
    }

    /**
     * The operand of a typeof, delete, ++ or assignment, as a reference
     * read: a name, a member, or -- for an external object -- a call whose
     * arguments a property takes.
     *
     * @param {Node} target @param {Context} ctx
     * @returns {Generator<unknown, { base: any, key: string | null, args: any[] | null }, unknown>}
     */
    *reference(target, ctx){
        switch (target.type)
        {
            case N.Ident:
                return { base: undefined, key: target.name, args: null };
            case N.Member:
                return { base: yield* this.expr(target.object, ctx), key: target.name, args: null };
            case N.Index:
            {
                const base = yield* this.expr(target.object, ctx);
                return { base, key: yield* this.key(target.property, ctx), args: null };
            }
            case N.Call:
            {
                const callee = target.callee;
                let base;
                /** @type {string | null} */
                let key = null;
                if (callee.type === N.Member || callee.type === N.Index)
                {
                    base = yield* this.expr(callee.object, ctx);
                    key = callee.type === N.Member
                        ? callee.name : yield* this.key(callee.property, ctx);
                }
                else
                {
                    base = yield* this.expr(callee, ctx);
                }
                const args = yield* this.args(target.args, ctx);
                if (!(base instanceof ExternalObject))
                {
                    throw this.realm.error('ReferenceError', 5003);
                }
                return { base, key, args };
            }
            case N.This:
                throw this.realm.error('ReferenceError', 5000);
            default:
                throw this.realm.error('ReferenceError', 5008);
        }
    }

    /**
     * @param {Node} target
     * @param {{ base: any, key: string | null, args: any[] | null }} ref
     * @param {Context} ctx @returns {Steps}
     */
    *readReference(target, ref, ctx){
        if (target.type === N.Ident)
        {
            return yield* this.getName(/** @type {string} */ (ref.key), ctx.scope);
        }
        if (ref.args !== null)
        {
            const { base, key, args } = ref;
            return yield* this.realm.external(()=>base.get(key, args));
        }
        return yield* this.getMember(ref.base, /** @type {string} */ (ref.key), target.object);
    }

    /**
     * @param {Node} target
     * @param {{ base: any, key: string | null, args: any[] | null }} ref
     * @param {any} value @param {Context} ctx @returns {Steps}
     */
    *writeReference(target, ref, value, ctx){
        if (target.type === N.Ident)
        {
            yield* this.setName(/** @type {string} */ (ref.key), value, ctx.scope);
            return;
        }
        if (ref.args !== null)
        {
            const { base, key, args } = ref;
            yield* this.realm.external(()=>base.put(key, value, args));
            return;
        }
        yield* this.putMember(ref.base, /** @type {string} */ (ref.key), value, target.object);
    }

    /** @param {Node} target @param {any} value @param {Context} ctx @returns {Steps} */
    *assignTo(target, value, ctx){
        const ref = yield* this.reference(target, ctx);
        yield* this.writeReference(target, ref, value, ctx);
    }

    /** @param {Node} n @param {Context} ctx @returns {Steps} */
    *assign(n, ctx){
        const target = n.target;
        if (target.type === N.Ident)
        {
            const found = this.fast ? this.writableBinding(target.name, ctx.scope) : null;
            if (found !== null && (n.op === '' || isPrimitive(found.value)))
            {
                const old = found.value;
                let right = this.simple(n.value, ctx);
                if (right === COMPLEX)
                {
                    right = yield* this.expr(n.value, ctx);
                }
                // The right side may have run script that changed the binding
                // or removed it: the fast write is only for one still there.
                const still = this.writableBinding(target.name, ctx.scope);
                const value = n.op === '' ? right : yield* this.binary(n.op, old, right);
                if (still === found)
                {
                    found.value = value;
                }
                else
                {
                    yield* this.setName(target.name, value, ctx.scope);
                }
                return value;
            }
            if (n.op === '')
            {
                const value = yield* this.expr(n.value, ctx);
                yield* this.setName(target.name, value, ctx.scope);
                return value;
            }
        }
        const ref = yield* this.reference(target, ctx);
        let value;
        if (n.op === '')
        {
            value = yield* this.expr(n.value, ctx);
        }
        else
        {
            const old = yield* this.readReference(target, ref, ctx);
            const right = yield* this.expr(n.value, ctx);
            value = yield* this.binary(n.op, old, right);
        }
        yield* this.writeReference(target, ref, value, ctx);
        return value;
    }

    /**
     * The property an assignment to a name writes directly, when that is
     * all [[Put]] would do: a variable, or the global object's own writable
     * property. Null when the full PutValue has to run.
     *
     * @param {string} name @param {Scope | null} scope @returns {Property | null}
     */
    writableBinding(name, scope){
        for (let s = scope; s !== null; s = s.parent)
        {
            if (s instanceof DeclarativeScope)
            {
                const found = s.vars.get(name);
                if (found !== undefined)
                {
                    return (found.flags & READONLY) === 0 ? found : null;
                }
                continue;
            }
            if (s.object !== this.realm.global)
            {
                return null;
            }
            const own = s.object.props.get(name);
            return own !== undefined && (own.flags & READONLY) === 0 ? own : null;
        }
        return null;
    }

    /** @param {Node} n @param {Context} ctx @returns {Steps} */
    *update(n, ctx){
        const ref = yield* this.reference(n.target, ctx);
        const old = yield* this.readReference(n.target, ref, ctx);
        const number = typeof old === 'number' ? old : yield* this.realm.toNumber(old);
        const value = n.op === '++' ? number + 1 : number - 1;
        yield* this.writeReference(n.target, ref, value, ctx);
        return n.prefix ? value : number;
    }

    /** @param {Node} n @param {Context} ctx @returns {Steps} */
    *unary(n, ctx){
        const realm = this.realm;
        const argument = n.argument;
        switch (n.op)
        {
            case 'typeof':
            {
                if (argument.type === N.Ident)
                {
                    const found = yield* this.resolve(argument.name, ctx.scope);
                    return found === null
                        ? 'undefined' : realm.typeOf(yield* this.valueOf(argument.name, found));
                }
                return realm.typeOf(yield* this.expr(argument, ctx));
            }
            case 'delete':
                return yield* this.delete(argument, ctx);
            case 'void':
                yield* this.expr(argument, ctx);
                return undefined;
            case '!':
                return !toBoolean(yield* this.expr(argument, ctx));
            default:
                break;
        }
        const value = yield* this.expr(argument, ctx);
        const number = typeof value === 'number' ? value : yield* realm.toNumber(value);
        switch (n.op)
        {
            case '+': return number;
            case '-': return -number;
            default: return ~number;
        }
    }

    /** @param {Node} argument @param {Context} ctx @returns {Steps} */
    *delete(argument, ctx){
        switch (argument.type)
        {
            case N.Ident:
            {
                for (let s = /** @type {Scope | null} */ (ctx.scope); s !== null; s = s.parent)
                {
                    if (s instanceof DeclarativeScope)
                    {
                        const found = s.vars.get(argument.name);
                        if (found !== undefined)
                        {
                            if ((found.flags & DONTDELETE) !== 0)
                            {
                                return false;
                            }
                            s.vars.delete(argument.name);
                            return true;
                        }
                    }
                    else if (s.object instanceof JSObject)
                    {
                        if (s.object.has(argument.name))
                        {
                            return s.object.delete(argument.name);
                        }
                    }
                }
                return true;
            }
            case N.Member:
            case N.Index:
            {
                const base = yield* this.expr(argument.object, ctx);
                const key = argument.type === N.Member
                    ? argument.name : yield* this.key(argument.property, ctx);
                if (base instanceof JSObject)
                {
                    return base.delete(key);
                }
                if (base === null || base === undefined)
                {
                    throw this.notAnObject(base, argument.object);
                }
                return true;
            }
            default:
                yield* this.expr(argument, ctx);
                return true;
        }
    }

    /**
     * A binary operator on two values (11.5 to 11.10).
     *
     * @param {string} op @param {any} left @param {any} right @returns {Steps}
     */
    *binary(op, left, right){
        const realm = this.realm;
        if (typeof left === 'number' && typeof right === 'number')
        {
            const answer = numericBinary(op, left, right);
            if (answer !== undefined)
            {
                return answer;
            }
        }
        switch (op)
        {
            case '+':
            {
                if (typeof left === 'string' && typeof right === 'string')
                {
                    return left + right;
                }
                const a = isPrimitive(left) ? left : yield* realm.toPrimitive(left);
                const b = isPrimitive(right) ? right : yield* realm.toPrimitive(right);
                if (typeof a === 'string' || typeof b === 'string')
                {
                    return realm.primitiveString(a) + realm.primitiveString(b);
                }
                return realm.primitiveNumber(a) + realm.primitiveNumber(b);
            }
            case '==':
                return yield* this.looseEquals(left, right);
            case '!=':
                return !(yield* this.looseEquals(left, right));
            case '===':
                return left === right;
            case '!==':
                return left !== right;
            case '<':
                return (yield* this.lessThan(left, right)) === true;
            case '>':
                return (yield* this.lessThan(right, left)) === true;
            case '<=':
                return (yield* this.lessThan(right, left)) === false;
            case '>=':
                return (yield* this.lessThan(left, right)) === false;
            case 'instanceof':
                return this.instanceOf(left, right);
            case 'in':
            {
                const key = typeof left === 'string' ? left : yield* realm.toString(left);
                if (right instanceof JSObject)
                {
                    return right.has(key);
                }
                if (right instanceof ExternalObject)
                {
                    return Boolean(yield* realm.external(()=>right.has(key)));
                }
                throw realm.typeError(5007);
            }
            default:
            {
                const a = typeof left === 'number' ? left : yield* realm.toNumber(left);
                const b = typeof right === 'number' ? right : yield* realm.toNumber(right);
                return numericBinary(op, a, b);
            }
        }
    }

    /**
     * The abstract relational comparison (11.8.5), its operands converted
     * in the order given: true, false, or undefined when either is NaN.
     *
     * @param {any} x @param {any} y @returns {Generator<unknown, boolean | undefined, unknown>}
     */
    *lessThan(x, y){
        const realm = this.realm;
        const a = isPrimitive(x) ? x : yield* realm.toPrimitive(x, 'number');
        const b = isPrimitive(y) ? y : yield* realm.toPrimitive(y, 'number');
        if (typeof a === 'string' && typeof b === 'string')
        {
            return a < b;
        }
        const m = realm.primitiveNumber(a);
        const n = realm.primitiveNumber(b);
        if (Number.isNaN(m) || Number.isNaN(n))
        {
            return undefined;
        }
        return m < n;
    }

    /**
     * The abstract equality comparison (11.9.3).
     *
     * @param {any} x @param {any} y @returns {Generator<unknown, boolean, unknown>}
     */
    *looseEquals(x, y){
        const realm = this.realm;
        for (;;)
        {
            const tx = x === null ? 'null' : typeof x;
            const ty = y === null ? 'null' : typeof y;
            if (tx === ty)
            {
                return x === y;
            }
            if ((tx === 'null' && ty === 'undefined') || (tx === 'undefined' && ty === 'null'))
            {
                return true;
            }
            if (tx === 'number' && ty === 'string')
            {
                return x === realm.primitiveNumber(y);
            }
            if (tx === 'string' && ty === 'number')
            {
                return realm.primitiveNumber(x) === y;
            }
            if (tx === 'boolean')
            {
                x = x ? 1 : 0;
                continue;
            }
            if (ty === 'boolean')
            {
                y = y ? 1 : 0;
                continue;
            }
            if ((tx === 'string' || tx === 'number') && ty === 'object')
            {
                y = yield* realm.toPrimitive(y);
                continue;
            }
            if (tx === 'object' && (ty === 'string' || ty === 'number'))
            {
                x = yield* realm.toPrimitive(x);
                continue;
            }
            return false;
        }
    }

    /**
     * instanceof (11.8.6, 15.3.5.3).
     *
     * @param {any} value @param {any} fn @returns {boolean}
     */
    instanceOf(value, fn){
        const realm = this.realm;
        if (!(fn instanceof JSFunction))
        {
            throw realm.typeError(5002);
        }
        if (!(value instanceof JSObject))
        {
            return false;
        }
        const prototype = fn.get('prototype');
        if (!(prototype instanceof JSObject))
        {
            throw realm.typeError(5023);
        }
        for (let object = value.proto; object !== null; object = object.proto)
        {
            if (object === prototype)
            {
                return true;
            }
        }
        return false;
    }
}

/**
 * The operators whose operands are numbers, on numbers already converted:
 * undefined for one that is not among them.
 *
 * @param {string} op @param {number} a @param {number} b
 * @returns {number | boolean | undefined}
 */
function numericBinary(op, a, b){
    switch (op)
    {
        case '+': return a + b;
        case '-': return a - b;
        case '*': return a * b;
        case '/': return a / b;
        case '%': return a % b;
        case '<<': return a << (b & 31);
        case '>>': return a >> (b & 31);
        case '>>>': return a >>> (b & 31);
        case '&': return a & b;
        case '|': return a | b;
        case '^': return a ^ b;
        case '<': return a < b;
        case '>': return a > b;
        case '<=': return a <= b;
        case '>=': return a >= b;
        case '==': case '===': return a === b;
        case '!=': case '!==': return a !== b;
        default: return undefined;
    }
}

/**
 * The names for-in visits on an object: enumerable ones of it and of its
 * prototypes, each once, a name hidden on a nearer object hiding it.
 *
 * @param {JSObject} object @returns {string[]}
 */
export function enumerableNames(object){
    /** @type {Set<string>} */
    const seen = new Set();
    /** @type {string[]} */
    const names = [];
    for (let o = /** @type {JSObject | null} */ (object); o !== null; o = o.proto)
    {
        for (const [name, enumerable] of o.ownNames())
        {
            if (seen.has(name))
            {
                continue;
            }
            seen.add(name);
            if (enumerable)
            {
                names.push(name);
            }
        }
    }
    return names;
}

/**
 * An expression as an error message spells it, where it is a name or a
 * chain of members; null for anything else.
 *
 * @param {Node} n @returns {string | null}
 */
function describe(n){
    switch (n.type)
    {
        case N.Ident: return n.name;
        case N.This: return 'this';
        case N.Member:
        {
            const object = describe(n.object);
            return object === null ? null : `${object}.${n.name}`;
        }
        case N.Index:
        {
            const object = describe(n.object);
            return object === null ? null : `${object}[...]`;
        }
        case N.Call:
        {
            const callee = describe(n.callee);
            return callee === null ? null : `${callee}(...)`;
        }
        default:
            return null;
    }
}

/**
 * Whether an expression can be evaluated with no effect but its value:
 * literals, `this`, names and operators over them -- so that one tried
 * without steps and found to need them can be evaluated again with them.
 *
 * @param {Node} n @returns {boolean}
 */
function isPure(n){
    switch (n.type)
    {
        case N.Lit: case N.This: case N.Ident:
            return true;
        case N.Binary:
            return n.op !== 'in' && n.op !== 'instanceof' && isPure(n.left) && isPure(n.right);
        default:
            return false;
    }
}

/**
 * The abstract equality comparison (11.9.3) of two primitives.
 *
 * @param {import('./realm.js').Realm} realm @param {any} a @param {any} b
 * @returns {boolean}
 */
function primitiveEquals(realm, a, b){
    if (a === null || a === undefined || b === null || b === undefined)
    {
        return (a === null || a === undefined) && (b === null || b === undefined);
    }
    if (typeof a === typeof b)
    {
        return a === b;
    }
    return realm.primitiveNumber(a) === realm.primitiveNumber(b);
}
