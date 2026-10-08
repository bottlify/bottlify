/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The evaluator: VBScript's statements over the parser's tree, run as
 * generators so that any step may wait on an external object (see
 * `script/drive.js`).
 *
 * Names are looked up as VBScript looks them up: a procedure's own
 * variables and arguments, then -- in a class's procedure -- the members of
 * the instance, then the script's global variables and procedures, the
 * host's named items, the built-in functions, and last the members of the
 * items that lend theirs (SCRIPTITEM_GLOBALMEMBERS).
 *
 * A runtime error stops the statement it happened in. Under On Error Resume
 * Next -- which belongs to the procedure that said it -- the error goes into
 * Err and the next statement runs; an error in an If's or a loop's
 * condition goes on into the body, as VBScript's does. Without it the error
 * leaves the procedure, and the caller's statement is the one that failed.
 *
 * An instance of a script's class is counted by what holds it -- variables,
 * array elements, fields, a call running on it -- and its Class_Terminate
 * runs when the last lets go, at the end of the statement that let go. A
 * value nothing stored (a New that went nowhere) goes at the end of its
 * statement too. What a COM or host object holds the engine cannot count:
 * an instance handed out stays until the engine closes.
 *
 * Runaway scripts are the embedder's to stop: every loop iteration and call
 * counts down, and at zero the embedder's checkpoint runs, which may wait or
 * end the script with ScriptAbort.
 */

import { isThenable } from '../script/drive.js';
import { ScriptAbort } from '../script/engine.js';
import { DEFAULT_MEMBER, ExternalError, ExternalObject } from '../script/external.js';
import { errorValue } from '../script/values.js';
import {
    MESSAGES, SOURCE_COMPILATION, SyntaxFailure, VBRuntimeError, fromExternalError,
} from './errors.js';
import { parseExpressionProgram, parseProgram } from './parser.js';
import {
    EXACT, FAST, FunctionRef, NOTHING, VBArray, VBObject, and, concat, div, eqv,
    fromHost, imp, intDiv, integer, isObject, mod, negate, not, or, power, toBool, toDouble,
    toExternal, toLong, xor,
} from './values.js';

/**
 * @typedef {import('../script/values.js').Value} Value
 * @typedef {import('./parser.js').Node} Node
 * @typedef {import('./parser.js').ProcDecl} ProcDecl
 * @typedef {import('./parser.js').ClassDecl} ClassDecl
 * @typedef {import('./parser.js').Program} Program
 * @typedef {import('./errors.js').SourceText} SourceText
 * @typedef {Generator<unknown, any, unknown>} Steps
 */

/** Completions a statement ends with besides running to its end. */
const EXIT_DO = 1;
const EXIT_FOR = 2;
const EXIT_PROC = 3;

/** Loop iterations and calls between two checkpoints. */
const CHECK_INTERVAL = 4096;

/** How deep procedures may call before the script is out of stack space. */
const MAX_DEPTH = 1000;

/** An expression {@link Interpreter#simple} cannot answer without steps. */
const COMPLEX = Symbol('complex');

/** What a name may be bound to beside a variable. */
const PROC = 1;
const MEMBER = 2;
const ITEM = 3;
const BUILTIN = 4;

/** DISP_E_PARAMNOTFOUND, what an argument left out is to a COM object. */
const MISSING = errorValue(0x80020004);

/** Something a value is stored in: a variable, an argument, an array's element. */
export class Ref
{
    /** @returns {Value} */
    get value(){
        return undefined;
    }

    set value(_value){
        // A reference with nowhere to store has nothing to do.
    }

    /** @returns {boolean} */
    get readOnly(){
        return false;
    }
}

/** A variable: a procedure's, a script's, an instance's field. */
export class Var extends Ref
{
    /** @param {Value} value @param {boolean} [constant] */
    constructor(value, constant = false){
        super();
        this.held = value;
        this.constant = constant;
    }

    get value(){
        return this.held;
    }

    set value(value){
        this.held = value;
    }

    get readOnly(){
        return this.constant;
    }
}

/** An array's element passed by reference. */
class ElementRef extends Ref
{
    /** @param {VBArray} array @param {number} offset */
    constructor(array, offset){
        super();
        this.array = array;
        this.offset = offset;
    }

    get value(){
        return this.array.items[this.offset];
    }

    set value(value){
        this.array.items[this.offset] = value;
    }
}

/**
 * A class's members: each name's method, or its property's Get, Let and
 * Set, or its field.
 *
 * @typedef {Object} Member
 * @property {ProcDecl} [method] @property {ProcDecl} [get]
 * @property {ProcDecl} [let] @property {ProcDecl} [set]
 * @property {boolean} field @property {boolean} isPublic
 */

/** A script's class, ready to make instances of. */
export class ClassDef
{
    /** @param {ClassDecl} decl */
    constructor(decl){
        this.name = decl.name;
        this.key = decl.key;
        this.fields = decl.fields;
        /** @type {Map<string, Member>} */
        this.members = new Map();
        /** @type {string | null} */
        this.defaultKey = null;
        for (const field of decl.fields)
        {
            this.members.set(field.key, { field: true, isPublic: field.isPublic });
        }
        for (const proc of decl.procs)
        {
            const member = this.members.get(proc.key) ?? { field: false, isPublic: proc.isPublic };
            if (proc.kind === 'sub' || proc.kind === 'function')
            {
                member.method = proc;
            }
            else
            {
                member[proc.kind] = proc;
            }
            if (proc.kind === 'get' || proc.kind === 'sub' || proc.kind === 'function')
            {
                member.isPublic = proc.isPublic;
            }
            this.members.set(proc.key, member);
            if (proc.isDefault)
            {
                this.defaultKey = proc.key;
            }
        }
        this.initialize = this.members.get('class_initialize')?.method ?? null;
        this.terminate = this.members.get('class_terminate')?.method ?? null;
    }
}

/** A procedure running, or global code. */
class Frame
{
    /**
     * @param {ProcDecl | null} proc @param {VBObject | null} self
     * @param {number} depth @param {SourceText} source @param {boolean} explicit
     */
    constructor(proc, self, depth, source, explicit){
        this.proc = proc;
        this.self = self;
        /** @type {Map<string, Ref> | null} a procedure's names; null for global code */
        this.locals = proc === null ? null : new Map();
        /** @type {Var[]} the variables this frame made, let go when it ends */
        this.owned = [];
        this.onError = false;
        /** @type {Var | null} a Function's or a Property Get's answer */
        this.ret = null;
        /** @type {Value[]} the objects of the With blocks it is inside */
        this.withs = [];
        this.depth = depth;
        this.source = source;
        this.explicit = explicit;
    }

    /**
     * The same scope running another text: Execute's.
     *
     * @param {SourceText} source @param {boolean} explicit @returns {Frame}
     */
    nested(source, explicit){
        const frame = new Frame(this.proc, this.self, this.depth, source, explicit);
        frame.locals = this.locals;
        frame.owned = this.owned;
        frame.ret = this.ret;
        return frame;
    }
}

/**
 * A built-in function: its argument counts, and its body. A body marked
 * `steps` answers with a generator; `raw` takes objects as they are rather
 * than their default values.
 *
 * @typedef {Object} Builtin
 * @property {string} name
 * @property {number} [min] @property {number} [max]
 * @property {(args: Value[], ctx: CallContext) => any} [fn]
 * @property {Value} [value]  A constant's value.
 * @property {boolean} [steps] @property {boolean} [raw]
 */

/**
 * @typedef {Object} CallContext
 * @property {Interpreter} interp @property {Frame} frame
 */

/**
 * @typedef {Object} InterpreterOptions
 * @property {() => void | Promise<void>} [checkpoint]
 * @property {boolean} [fastPaths]  False evaluates everything through the
 *     generator paths and the automation operator tables alone: the other
 *     arm of the gate that compares them.
 * @property {() => number | null} [thisYear]  For a date literal with no year.
 */

/** The Err object's fields. */
class ErrState
{
    constructor(){
        this.number = 0;
        this.description = '';
        this.source = '';
        this.helpFile = '';
        this.helpContext = 0;
    }

    clear(){
        this.number = 0;
        this.description = '';
        this.source = '';
        this.helpFile = '';
        this.helpContext = 0;
    }
}

export class Interpreter
{
    /** @param {InterpreterOptions} [options] */
    constructor(options = {}){
        this.options = options;
        this.fast = options.fastPaths !== false;
        this.ops = this.fast ? FAST : EXACT;
        /** @type {Map<string, Var>} the script's variables and constants */
        this.globals = new Map();
        /** @type {Map<string, ProcDecl>} */
        this.procs = new Map();
        /** @type {Map<string, ClassDef>} */
        this.classes = new Map();
        /** @type {Map<string, { name: string, value: Value }>} the host's names */
        this.items = new Map();
        /** @type {ExternalObject[]} items whose members are global names */
        this.globalMembers = [];
        /** @type {Map<string, Builtin>} */
        this.builtins = new Map();
        /** @type {Map<string, (interp: Interpreter) => Value>} built-in classes, for New */
        this.builtinClasses = new Map();
        /** @type {((name: string) => Value | Promise<Value> | undefined) | null} */
        this.resolver = null;
        /** @type {Set<string>} names the resolver said it does not have */
        this.unresolved = new Set();
        this.err = new ErrState();
        this.budget = CHECK_INTERVAL;
        /** @type {string | null} why the embedder asked the script to stop */
        this.interrupted = null;
        /** @type {{ object: VBObject, depth: number }[]} instances that may have no holder left */
        this.pending = [];
        /** @type {Set<VBObject>} every instance not yet terminated, for closing */
        this.live = new Set();
        this.depth = 0;
        /** The value of an expression text. */
        /** @type {Value} */
        this.completion = undefined;
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
     * Waits on what an external object answered, its failure turned into
     * the error VBScript reports at the point the script made the call.
     *
     * @param {() => any} operation @returns {Steps}
     */
    *external(operation){
        try
        {
            let answer = operation();
            if (isThenable(answer))
            {
                answer = yield answer;
            }
            return answer;
        }
        catch (e){
            throw e instanceof ExternalError ? fromExternalError(e) : e;
        }
    }

    /**
     * What reached a statement's end as an error a script can catch, or the
     * failure let through when it is no script's to catch.
     *
     * @param {unknown} e @returns {VBRuntimeError}
     */
    catchable(e){
        if (e instanceof VBRuntimeError)
        {
            return e;
        }
        if (e instanceof ExternalError)
        {
            return fromExternalError(e);
        }
        if (e instanceof RangeError && e.message.includes('call stack'))
        {
            return new VBRuntimeError(28);
        }
        throw e;
    }

    /** @param {VBRuntimeError} error */
    setErr(error){
        const err = this.err;
        err.number = error.number;
        err.description = error.description;
        err.source = error.source;
        err.helpFile = '';
        err.helpContext = 0;
    }

    // ---- declarations -------------------------------------------------

    /**
     * A text's procedures and classes, made global; its variables and
     * constants made where `frame` declares them.
     *
     * @param {Program} program @param {Frame} frame
     */
    declare(program, frame){
        for (const cls of program.classes)
        {
            this.classes.set(cls.key, new ClassDef(cls));
        }
        for (const proc of program.procs)
        {
            /** @type {any} */ (proc).explicit = program.explicit;
            this.procs.set(proc.key, proc);
        }
        for (const decl of program.dims)
        {
            this.declareVariable(frame, decl.key, decl.dims);
        }
        for (const item of program.consts)
        {
            this.declareConstant(frame, item.key, item.value);
        }
    }

    /**
     * @param {Frame} frame @param {string} key @param {number[] | null} dims
     */
    declareVariable(frame, key, dims){
        const scope = frame.locals ?? this.globals;
        if (scope.has(key))
        {
            return;
        }
        const variable = new Var(newVariableValue(dims));
        scope.set(key, variable);
        if (frame.locals !== null)
        {
            frame.owned.push(variable);
        }
    }

    /** @param {Frame} frame @param {string} key @param {Value} value */
    declareConstant(frame, key, value){
        (frame.locals ?? this.globals).set(key, new Var(value, true));
    }

    /**
     * Global code: a text's declarations, then its statements. Answers an
     * expression text's value.
     *
     * @param {Program} program @returns {Steps}
     */
    *runProgram(program){
        const frame = new Frame(null, null, 0, program.source, program.explicit);
        this.declare(program, frame);
        const saved = this.completion;
        this.completion = undefined;
        try
        {
            yield* this.execBlock(program.body, frame);
            yield* this.flush(0);
            return this.completion;
        }
        finally
        {
            this.completion = saved;
        }
    }

    // ---- names ----------------------------------------------------------

    /**
     * What a name is bound to, where finding it needs no steps: a
     * reference for a variable, a binding for anything else, null for a
     * name none of these has.
     *
     * @param {string} key @param {Frame} frame
     * @returns {Ref | { kind: number, proc?: ProcDecl, object?: VBObject,
     *     member?: Member, value?: Value, builtin?: Builtin } | null}
     */
    resolve(key, frame){
        const locals = frame.locals;
        if (locals !== null)
        {
            const local = locals.get(key);
            if (local !== undefined)
            {
                return local;
            }
            if (frame.ret !== null && key === /** @type {ProcDecl} */ (frame.proc).key)
            {
                return frame.ret;
            }
        }
        const self = frame.self;
        if (self !== null)
        {
            const field = self.fields.get(key);
            if (field !== undefined)
            {
                return /** @type {Var} */ (field);
            }
            const member = self.cls.members.get(key);
            if (member !== undefined)
            {
                return { kind: MEMBER, object: self, member };
            }
        }
        const global = this.globals.get(key);
        if (global !== undefined)
        {
            return global;
        }
        const proc = this.procs.get(key);
        if (proc !== undefined)
        {
            return { kind: PROC, proc };
        }
        const item = this.items.get(key);
        if (item !== undefined)
        {
            return { kind: ITEM, value: item.value };
        }
        const builtin = this.builtins.get(key);
        if (builtin !== undefined)
        {
            return { kind: BUILTIN, builtin };
        }
        return null;
    }

    /**
     * A name nothing in the script defines, asked of the items that lend
     * their members and then of the host: the item whose member it is, or
     * the host's object, or null.
     *
     * @param {string} name @returns {Steps}
     */
    *resolveOutside(name){
        for (const object of this.globalMembers)
        {
            const has = yield* this.external(()=>object.has(name));
            if (has === true)
            {
                return { object };
            }
        }
        const key = name.toLowerCase();
        if (this.resolver !== null && !this.unresolved.has(key))
        {
            const resolver = this.resolver;
            const found = yield* this.external(()=>resolver(name));
            if (found !== undefined)
            {
                this.items.set(key, { name, value: found });
                return { value: found };
            }
            this.unresolved.add(key);
        }
        return null;
    }

    /**
     * A variable to assign a name to that has none: declared where the
     * code runs, unless Option Explicit asks for every name declared.
     *
     * @param {string} key @param {Frame} frame @returns {Var}
     */
    implicit(key, frame){
        if (frame.explicit)
        {
            throw new VBRuntimeError(500);
        }
        const variable = new Var(undefined);
        if (frame.locals !== null)
        {
            frame.locals.set(key, variable);
            frame.owned.push(variable);
        }
        else
        {
            this.globals.set(key, variable);
        }
        return variable;
    }

    // ---- counting what holds an instance ----------------------------------

    /** @param {Value} value */
    retain(value){
        if (value instanceof VBObject)
        {
            value.refs++;
        }
        else if (value instanceof VBArray)
        {
            for (const item of value.items)
            {
                if (item instanceof VBObject || item instanceof VBArray)
                {
                    this.retain(item);
                }
            }
        }
    }

    /** @param {Value} value */
    release(value){
        if (value instanceof VBObject)
        {
            value.refs--;
            if (value.refs <= 0 && !value.terminated)
            {
                this.pending.push({ object: value, depth: this.depth });
            }
        }
        else if (value instanceof VBArray)
        {
            for (const item of value.items)
            {
                if (item instanceof VBObject || item instanceof VBArray)
                {
                    this.release(item);
                }
            }
        }
    }

    /**
     * An instance no longer counted -- a COM or host object holds it --
     * and so never terminated before the engine closes.
     *
     * @param {Value} value
     */
    pin(value){
        if (value instanceof VBObject)
        {
            value.pinned = true;
        }
        else if (value instanceof VBArray)
        {
            value.items.forEach(item=>this.pin(item));
        }
    }

    /**
     * Stores a value where a reference points, the old one let go; an array
     * is copied, as an assignment copies one.
     *
     * @param {Ref} ref @param {Value} given
     */
    assignRef(ref, given){
        const value = given instanceof VBArray ? given.copy() : given;
        const old = ref.value;
        ref.value = value;
        this.retain(value);
        this.release(old);
    }

    /**
     * Terminates the instances nothing holds any more that the statements
     * at this depth or deeper let go.
     *
     * @param {number} depth @returns {Steps}
     */
    *flush(depth){
        while (this.pending.length > 0)
        {
            const index = this.pending.findIndex(entry=>entry.depth >= depth);
            if (index < 0)
            {
                return;
            }
            const [{ object }] = this.pending.splice(index, 1);
            if (object.refs <= 0 && !object.terminated && !object.pinned)
            {
                yield* this.terminate(object);
            }
        }
    }

    /**
     * Class_Terminate, then the instance's fields let go.
     *
     * @param {VBObject} object @returns {Steps}
     */
    *terminate(object){
        object.terminated = true;
        this.live.delete(object);
        const terminate = object.cls.terminate;
        if (terminate !== null)
        {
            try
            {
                yield* this.callProc(terminate, object, []);
            }
            catch (e){
                // An error in Class_Terminate goes nowhere a script sees.
                this.catchable(e);
            }
        }
        for (const field of object.fields.values())
        {
            const value = field.value;
            field.value = undefined;
            this.release(value);
        }
    }

    /**
     * What closing the engine does to the script's objects: every global
     * variable let go, and every instance still alive terminated.
     *
     * @returns {Steps}
     */
    *close(){
        for (const variable of this.globals.values())
        {
            const value = variable.value;
            variable.held = undefined;
            this.release(value);
        }
        yield* this.flush(0);
        for (const object of [...this.live])
        {
            if (!object.terminated)
            {
                yield* this.terminate(object);
            }
        }
    }

    // ---- statements ---------------------------------------------------------

    /**
     * @param {Node[]} statements @param {Frame} frame
     * @returns {Steps} a completion: undefined, or one of the EXIT_ codes
     */
    *execBlock(statements, frame){
        for (const statement of statements)
        {
            let completion;
            try
            {
                completion = yield* this.exec(statement, frame);
            }
            catch (e){
                const error = this.catchable(e);
                error.where ??= { source: frame.source, offset: statement.pos };
                if (!frame.onError)
                {
                    throw error;
                }
                this.setErr(error);
                completion = undefined;
            }
            if (this.pending.length > 0)
            {
                yield* this.flush(frame.depth);
            }
            if (completion !== undefined)
            {
                return completion;
            }
        }
        return undefined;
    }

    /** @param {Node} n @param {Frame} frame @returns {Steps} */
    *exec(n, frame){
        switch (n.type)
        {
            case 'Assign':
                if (!n.set && n.target.type === 'Name' && this.fast)
                {
                    const value = this.simple(n.value, frame);
                    if (value !== COMPLEX)
                    {
                        const ref = this.resolve(n.target.key, frame);
                        if (ref instanceof Ref && !ref.readOnly)
                        {
                            this.assignRef(ref, value);
                            return undefined;
                        }
                    }
                }
                yield* this.assign(n, frame);
                return undefined;
            case 'Call':
                yield* this.callStatement(n, frame);
                return undefined;
            case 'Dim': case 'Const': case 'Stop':
                return undefined;
            case 'If':
                for (const branch of n.branches)
                {
                    if (yield* this.test(branch.test, frame))
                    {
                        return yield* this.execBlock(branch.body, frame);
                    }
                }
                return n.otherwise === null ? undefined : yield* this.execBlock(n.otherwise, frame);
            case 'Select':
                return yield* this.select(n, frame);
            case 'For':
                return yield* this.forLoop(n, frame);
            case 'ForEach':
                return yield* this.forEach(n, frame);
            case 'Do':
                return yield* this.doLoop(n, frame);
            case 'While':
                for (;;)
                {
                    if (--this.budget <= 0)
                    {
                        yield* this.checkpoint();
                    }
                    if (!(yield* this.test(n.test, frame)))
                    {
                        return undefined;
                    }
                    const completion = yield* this.execBlock(n.body, frame);
                    if (completion !== undefined)
                    {
                        return completion;
                    }
                }
            case 'Exit':
                return n.what === 'do' ? EXIT_DO : n.what === 'for' ? EXIT_FOR : EXIT_PROC;
            case 'With': {
                const object = yield* this.eval(n.object, frame);
                this.retain(object);
                frame.withs.push(object);
                try
                {
                    return yield* this.execBlock(n.body, frame);
                }
                finally
                {
                    frame.withs.pop();
                    this.release(object);
                }
            }
            case 'OnError':
                frame.onError = n.resume;
                this.err.clear();
                return undefined;
            case 'ReDim':
                yield* this.redim(n, frame);
                return undefined;
            case 'Erase':
                yield* this.erase(n, frame);
                return undefined;
            case 'Value':
                this.completion = yield* this.eval(n.expr, frame);
                return undefined;
            default:
                throw new Error(`no statement ${n.type}`);
        }
    }

    /**
     * A condition: its value as a Boolean, Null as False. Under On Error
     * Resume Next a condition that fails is taken as true, so the next
     * statement -- the first of the body -- runs, as VBScript's does.
     *
     * @param {Node} n @param {Frame} frame @returns {Steps}
     */
    *test(n, frame){
        try
        {
            let value = this.simple(n, frame);
            if (value === COMPLEX)
            {
                value = yield* this.value(n, frame);
            }
            return value === null ? false : toBool(value);
        }
        catch (e){
            const error = this.catchable(e);
            if (!frame.onError)
            {
                throw error;
            }
            error.where ??= { source: frame.source, offset: n.pos };
            this.setErr(error);
            return true;
        }
    }

    /** @param {Node} n @param {Frame} frame @returns {Steps} */
    *select(n, frame){
        const subject = yield* this.value(n.subject, frame);
        for (const branch of n.cases)
        {
            for (const t of branch.tests)
            {
                let match;
                if (t.kind === 'value')
                {
                    match = this.ops.compare(subject, yield* this.value(t.expr, frame)) === 0;
                }
                else if (t.kind === 'range')
                {
                    const from = yield* this.value(t.from, frame);
                    const to = yield* this.value(t.to, frame);
                    const low = this.ops.compare(subject, from);
                    const high = this.ops.compare(subject, to);
                    match = low !== null && high !== null && low >= 0 && high <= 0;
                }
                else
                {
                    const order = this.ops.compare(subject, yield* this.value(t.expr, frame));
                    match = order !== null && compared(t.op, order);
                }
                if (match)
                {
                    return yield* this.execBlock(branch.body, frame);
                }
            }
        }
        return n.otherwise === null ? undefined : yield* this.execBlock(n.otherwise, frame);
    }

    /**
     * For ... To ... Step: the bounds read once, the counter stepped with +
     * so that its type follows VarAdd, and tested against the end each time
     * round, the way the step's sign says.
     *
     * @param {Node} n @param {Frame} frame @returns {Steps}
     */
    *forLoop(n, frame){
        const from = numericBound(yield* this.value(n.from, frame));
        const to = numericBound(yield* this.value(n.to, frame));
        const step = n.step === null ? integer(1) : numericBound(yield* this.value(n.step, frame));
        const ref = this.targetRef(n.variable, frame);
        this.assignRef(ref, from);
        const upward = toDouble(step) >= 0;
        for (;;)
        {
            if (--this.budget <= 0)
            {
                yield* this.checkpoint();
            }
            const order = this.ops.compare(ref.value, to);
            if (order === null || (upward ? order > 0 : order < 0))
            {
                return undefined;
            }
            const completion = yield* this.execBlock(n.body, frame);
            if (completion === EXIT_FOR)
            {
                return undefined;
            }
            if (completion !== undefined)
            {
                return completion;
            }
            this.assignRef(ref, this.ops.add(ref.value, step));
        }
    }

    /**
     * For Each over an array's elements, as they were when the loop began,
     * or over an external collection's enumeration.
     *
     * @param {Node} n @param {Frame} frame @returns {Steps}
     */
    *forEach(n, frame){
        const collection = yield* this.eval(n.collection, frame);
        if (collection instanceof VBArray)
        {
            for (const item of collection.items.slice())
            {
                const completion = yield* this.eachItem(n, item, frame);
                if (completion !== undefined)
                {
                    return completion === EXIT_FOR ? undefined : completion;
                }
            }
            return undefined;
        }
        if (collection instanceof ExternalObject)
        {
            const enumerator = yield* this.external(()=>collection.enumerate());
            for (;;)
            {
                const step = yield* this.external(()=>enumerator.next());
                if (step.done)
                {
                    return undefined;
                }
                const completion = yield* this.eachItem(n, fromHost(step.value), frame);
                if (completion !== undefined)
                {
                    return completion === EXIT_FOR ? undefined : completion;
                }
            }
        }
        throw new VBRuntimeError(collection === NOTHING ? 91 : 451);
    }

    /**
     * One time round a For Each: the element in the loop's variable, then
     * the body.
     *
     * @param {Node} n @param {Value} item @param {Frame} frame @returns {Steps}
     */
    *eachItem(n, item, frame){
        if (--this.budget <= 0)
        {
            yield* this.checkpoint();
        }
        yield* this.store(n.variable, item, isObject(item), frame);
        return yield* this.execBlock(n.body, frame);
    }

    /** @param {Node} n @param {Frame} frame @returns {Steps} */
    *doLoop(n, frame){
        for (;;)
        {
            if (--this.budget <= 0)
            {
                yield* this.checkpoint();
            }
            if (n.pre !== null && (yield* this.test(n.pre.test, frame)) === n.pre.until)
            {
                return undefined;
            }
            const completion = yield* this.execBlock(n.body, frame);
            if (completion === EXIT_DO)
            {
                return undefined;
            }
            if (completion !== undefined)
            {
                return completion;
            }
            if (n.post !== null && (yield* this.test(n.post.test, frame)) === n.post.until)
            {
                return undefined;
            }
        }
    }

    /**
     * ReDim: a new array of the bounds given; with Preserve the elements
     * that are still inside it kept, which only the last dimension may
     * change for.
     *
     * @param {Node} n @param {Frame} frame @returns {Steps}
     */
    *redim(n, frame){
        for (const item of n.items)
        {
            const uppers = [];
            for (const dim of item.dims)
            {
                const upper = toLong(yield* this.value(dim, frame));
                if (upper < -1)
                {
                    throw new VBRuntimeError(9);
                }
                uppers.push(upper);
            }
            let ref = this.resolve(item.key, frame);
            if (!(ref instanceof Ref))
            {
                if (ref !== null)
                {
                    throw new VBRuntimeError(501);
                }
                // ReDim declares the name where it is not declared.
                ref = new Var(undefined);
                if (frame.locals !== null)
                {
                    frame.locals.set(item.key, ref);
                    frame.owned.push(/** @type {Var} */ (ref));
                }
                else
                {
                    this.globals.set(item.key, /** @type {Var} */ (ref));
                }
            }
            const old = ref.value;
            if (old instanceof VBArray && (old.fixed || old.locked > 0))
            {
                throw new VBRuntimeError(10);
            }
            const array = VBArray.sized(uppers);
            if (n.preserve && old instanceof VBArray && old.bounds.length > 0)
            {
                preserveInto(old, array);
            }
            ref.value = array;
            this.retain(array);
            this.release(old);
        }
    }

    /**
     * Erase: a fixed array's elements emptied, a dynamic one's taken away.
     *
     * @param {Node} n @param {Frame} frame @returns {Steps}
     */
    *erase(n, frame){
        for (const target of n.targets)
        {
            const ref = yield* this.reference(target, frame);
            const array = ref?.value;
            if (!(array instanceof VBArray))
            {
                throw new VBRuntimeError(13);
            }
            if (array.locked > 0)
            {
                throw new VBRuntimeError(10);
            }
            this.release(array);
            if (array.fixed)
            {
                array.items.fill(undefined);
            }
            else
            {
                const emptied = new VBArray([], []);
                /** @type {Ref} */ (ref).value = emptied;
            }
        }
    }

    // ---- assignment ---------------------------------------------------------

    /** @param {Node} n @param {Frame} frame @returns {Steps} */
    *assign(n, frame){
        let value = yield* this.eval(n.value, frame);
        if (n.set)
        {
            if (!isObject(value))
            {
                throw new VBRuntimeError(424);
            }
        }
        else if (isObject(value))
        {
            value = yield* this.scalar(value);
        }
        yield* this.store(n.target, value, n.set, frame);
    }

    /**
     * Where a For loop's counter lives: a variable, declared if it is not.
     *
     * @param {Node} target @param {Frame} frame @returns {Ref}
     */
    targetRef(target, frame){
        const ref = this.resolve(target.key, frame);
        if (ref instanceof Ref)
        {
            if (ref.readOnly)
            {
                throw new VBRuntimeError(501);
            }
            return ref;
        }
        if (ref !== null)
        {
            throw new VBRuntimeError(501);
        }
        return this.implicit(target.key, frame);
    }

    /**
     * Stores a value into what an assignment names: a variable, an array's
     * element, a field or property of an instance, an external object's
     * property, or an object's default property.
     *
     * @param {Node} target @param {Value} value @param {boolean} set
     * @param {Frame} frame @returns {Steps}
     */
    *store(target, value, set, frame){
        switch (target.type)
        {
            case 'Name': {
                const bound = this.resolve(target.key, frame);
                if (bound instanceof Ref)
                {
                    if (bound.readOnly)
                    {
                        throw new VBRuntimeError(501);
                    }
                    this.assignRef(bound, value);
                    return;
                }
                if (bound !== null)
                {
                    if (bound.kind === MEMBER && !bound.member?.field)
                    {
                        yield* this.putProperty(/** @type {VBObject} */ (bound.object),
                            /** @type {Member} */ (bound.member), [], value, set);
                        return;
                    }
                    throw new VBRuntimeError(501);
                }
                const outside = yield* this.resolveOutside(target.name);
                if (outside?.object)
                {
                    yield* this.putExternal(outside.object, target.name, [], value, set);
                    return;
                }
                if (outside !== null)
                {
                    throw new VBRuntimeError(501);
                }
                this.assignRef(this.implicit(target.key, frame), value);
                return;
            }
            case 'Member': {
                const object = yield* this.memberBase(target, frame);
                yield* this.storeMember(object, target.name, target.key, [], value, set, frame);
                return;
            }
            case 'Index': {
                const args = yield* this.argumentValues(target.args, frame);
                const inner = target.target;
                if (inner.type === 'Name')
                {
                    const bound = this.resolve(inner.key, frame);
                    if (bound instanceof Ref)
                    {
                        yield* this.storeIndexed(bound.value, args, value, set);
                        return;
                    }
                    if (bound !== null && bound.kind === MEMBER && !bound.member?.field)
                    {
                        yield* this.putProperty(/** @type {VBObject} */ (bound.object),
                            /** @type {Member} */ (bound.member), args, value, set);
                        return;
                    }
                    if (bound === null)
                    {
                        const outside = yield* this.resolveOutside(inner.name);
                        if (outside?.object)
                        {
                            yield* this.putExternal(outside.object, inner.name, args, value, set);
                            return;
                        }
                        if (outside !== null)
                        {
                            yield* this.storeIndexed(outside.value, args, value, set);
                            return;
                        }
                        throw new VBRuntimeError(frame.explicit ? 500 : 13);
                    }
                    if (bound.kind === ITEM)
                    {
                        yield* this.storeIndexed(bound.value, args, value, set);
                        return;
                    }
                    throw new VBRuntimeError(501);
                }
                if (inner.type === 'Member')
                {
                    const object = yield* this.memberBase(inner, frame);
                    yield* this.storeMember(object, inner.name, inner.key, args, value, set, frame);
                    return;
                }
                yield* this.storeIndexed(yield* this.eval(inner, frame), args, value, set);
                return;
            }
            case 'Me':
                throw new VBRuntimeError(501);
            default:
                throw new VBRuntimeError(424);
        }
    }

    /**
     * Stores into an array's element, or an object's default property with
     * arguments.
     *
     * @param {Value} holder @param {Value[]} args @param {Value} value @param {boolean} set
     * @returns {Steps}
     */
    *storeIndexed(holder, args, value, set){
        if (holder instanceof VBArray)
        {
            const offset = holder.offset(args.map(toLong));
            this.assignRef(new ElementRef(holder, offset), value);
            return;
        }
        if (holder instanceof VBObject)
        {
            const key = holder.cls.defaultKey;
            const member = key === null ? undefined : holder.cls.members.get(key);
            if (member === undefined)
            {
                throw new VBRuntimeError(438);
            }
            yield* this.putProperty(holder, member, args, value, set);
            return;
        }
        if (holder instanceof ExternalObject)
        {
            yield* this.putExternal(holder, null, args, value, set);
            return;
        }
        if (holder === NOTHING)
        {
            throw new VBRuntimeError(91);
        }
        throw new VBRuntimeError(13);
    }

    /**
     * Stores into an object's member.
     *
     * @param {Value} object @param {string} name @param {string} key @param {Value[]} args
     * @param {Value} value @param {boolean} set @param {Frame} frame @returns {Steps}
     */
    *storeMember(object, name, key, args, value, set, frame){
        if (object instanceof VBObject)
        {
            const member = this.visibleMember(object, key, frame);
            if (member.field)
            {
                const field = /** @type {Var} */ (object.fields.get(key));
                if (args.length > 0)
                {
                    yield* this.storeIndexed(field.value, args, value, set);
                    return;
                }
                this.assignRef(field, value);
                return;
            }
            yield* this.putProperty(object, member, args, value, set);
            return;
        }
        if (object instanceof ExternalObject)
        {
            yield* this.putExternal(object, name, args, value, set);
            return;
        }
        throw new VBRuntimeError(object === NOTHING ? 91 : 424);
    }

    /**
     * Property Let or Set with its arguments and the value last.
     *
     * @param {VBObject} object @param {Member} member @param {Value[]} args
     * @param {Value} value @param {boolean} set @returns {Steps}
     */
    *putProperty(object, member, args, value, set){
        const proc = set ? member.set : member.let;
        if (proc === undefined)
        {
            throw new VBRuntimeError(member.get || member.let || member.set ? 450 : 438);
        }
        yield* this.callProc(proc, object, [...args, value]);
    }

    /**
     * @param {ExternalObject} object @param {string | null} name @param {Value[]} args
     * @param {Value} value @param {boolean} set @returns {Steps}
     */
    *putExternal(object, name, args, value, set){
        this.pin(value);
        const outbound = args.map(toExternal);
        yield* this.external(()=>(set ? object.putRef(name, value, outbound)
            : object.put(name, toExternal(value), outbound)));
    }

    // ---- expressions --------------------------------------------------------

    /**
     * An expression's value as it is: an object stays the object.
     *
     * @param {Node} n @param {Frame} frame @returns {Steps}
     */
    *eval(n, frame){
        const fast = this.simple(n, frame);
        if (fast !== COMPLEX)
        {
            return fast;
        }
        switch (n.type)
        {
            case 'Lit':
                return n.value;
            case 'Paren':
                return yield* this.eval(n.expr, frame);
            case 'Me':
                if (frame.self === null)
                {
                    throw new VBRuntimeError(424);
                }
                return frame.self;
            case 'New':
                return yield* this.construct(n.key);
            case 'Name':
                return yield* this.readName(n, frame);
            case 'Member': {
                const object = yield* this.memberBase(n, frame);
                return yield* this.callMember(object, n.name, n.key, [], frame);
            }
            case 'Index':
                return yield* this.callIndex(n, frame);
            case 'Binary': {
                const left = yield* this.eval(n.left, frame);
                const right = yield* this.eval(n.right, frame);
                if (n.op === 'is')
                {
                    if (!isObject(left) || !isObject(right))
                    {
                        throw new VBRuntimeError(424);
                    }
                    return left === right;
                }
                return this.binary(n.op, isObject(left) ? yield* this.scalar(left) : left,
                    isObject(right) ? yield* this.scalar(right) : right);
            }
            case 'Unary': {
                const operand = yield* this.eval(n.operand, frame);
                return this.unary(n.op, isObject(operand) ? yield* this.scalar(operand) : operand);
            }
            default:
                throw new Error(`no expression ${n.type}`);
        }
    }

    /**
     * An expression's value with an object read for its default value, as
     * an operator or a Let assignment reads one.
     *
     * @param {Node} n @param {Frame} frame @returns {Steps}
     */
    *value(n, frame){
        const value = yield* this.eval(n, frame);
        return isObject(value) ? yield* this.scalar(value) : value;
    }

    /**
     * The value of an expression that needs no steps -- a literal, a
     * variable that holds no object, an operator over those -- or
     * {@link COMPLEX}, with nothing done, for one that does.
     *
     * @param {Node} n @param {Frame} frame @returns {Value | typeof COMPLEX}
     */
    simple(n, frame){
        if (!this.fast)
        {
            return COMPLEX;
        }
        switch (n.type)
        {
            case 'Lit':
                // Nothing is an object: what reads it for a value has steps.
                return n.value === NOTHING ? COMPLEX : n.value;
            case 'Paren':
                return this.simple(n.expr, frame);
            case 'Name': {
                const ref = this.resolve(n.key, frame);
                if (ref instanceof Ref)
                {
                    const value = ref.value;
                    return isObject(value) ? COMPLEX : value;
                }
                return COMPLEX;
            }
            case 'Binary': {
                if (n.op === 'is')
                {
                    return COMPLEX;
                }
                const left = this.simple(n.left, frame);
                if (left === COMPLEX || isObject(left))
                {
                    return COMPLEX;
                }
                const right = this.simple(n.right, frame);
                if (right === COMPLEX || isObject(right))
                {
                    return COMPLEX;
                }
                return this.binary(n.op, left, right);
            }
            case 'Unary': {
                const operand = this.simple(n.operand, frame);
                return operand === COMPLEX || isObject(operand)
                    ? COMPLEX : this.unary(n.op, operand);
            }
            default:
                return COMPLEX;
        }
    }

    /**
     * @param {string} op @param {Value} a @param {Value} b @returns {Value}
     */
    binary(op, a, b){
        const ops = this.ops;
        switch (op)
        {
            case '+': return ops.add(a, b);
            case '-': return ops.sub(a, b);
            case '*': return ops.mul(a, b);
            case '/': return div(a, b);
            case '\\': return intDiv(a, b);
            case 'mod': return mod(a, b);
            case '^': return power(a, b);
            case '&': return concat(a, b);
            case 'and': return and(a, b);
            case 'or': return or(a, b);
            case 'xor': return xor(a, b);
            case 'eqv': return eqv(a, b);
            case 'imp': return imp(a, b);
            default: {
                const order = ops.compare(a, b);
                return order === null ? null : compared(op, order);
            }
        }
    }

    /**
     * Negation, Not, or unary plus, which leaves a value as it is.
     *
     * @param {string} op @param {Value} a @returns {Value}
     */
    unary(op, a){
        switch (op)
        {
            case '-': return negate(a);
            case 'not': return not(a);
            default: return a;
        }
    }

    /**
     * An object's default value: a class's default member, an external
     * object's DISPID_VALUE, a GetRef's procedure called.
     *
     * @param {Value} object @returns {Steps}
     */
    *scalar(object){
        let value = object;
        for (let depth = 0; isObject(value); depth++)
        {
            if (depth > 8 || value === NOTHING)
            {
                throw new VBRuntimeError(value === NOTHING ? 91 : 438);
            }
            value = yield* this.callDefault(value, []);
        }
        return value;
    }

    /**
     * A name read as a value: a variable's, a procedure's or a built-in's
     * answer called with no arguments, a host's object.
     *
     * @param {Node} n @param {Frame} frame @returns {Steps}
     */
    *readName(n, frame){
        const bound = this.resolve(n.key, frame);
        if (bound instanceof Ref)
        {
            return bound.value;
        }
        if (bound !== null)
        {
            switch (bound.kind)
            {
                case PROC:
                    return yield* this.callProc(/** @type {ProcDecl} */ (bound.proc), null, []);
                case MEMBER:
                    return yield* this.callClassMember(/** @type {VBObject} */ (bound.object),
                        /** @type {Member} */ (bound.member), [], frame);
                case ITEM:
                    return bound.value;
                default:
                    return yield* this.callBuiltin(/** @type {Builtin} */ (bound.builtin), [],
                        frame);
            }
        }
        const outside = yield* this.resolveOutside(n.name);
        if (outside?.object)
        {
            const object = outside.object;
            return fromHost(yield* this.external(()=>object.call(n.name, [])));
        }
        if (outside !== null)
        {
            return outside.value;
        }
        if (frame.explicit)
        {
            throw new VBRuntimeError(500);
        }
        return undefined;
    }

    /**
     * The object a member is read from: the expression before the ".", or
     * the innermost With block's.
     *
     * @param {Node} n @param {Frame} frame @returns {Steps}
     */
    *memberBase(n, frame){
        if (n.object === null)
        {
            if (frame.withs.length === 0)
            {
                throw new VBRuntimeError(424);
            }
            return frame.withs[frame.withs.length - 1];
        }
        return yield* this.eval(n.object, frame);
    }

    /**
     * name(arguments): a procedure called, an array indexed, an object's
     * member or default member called.
     *
     * @param {Node} n @param {Frame} frame @returns {Steps}
     */
    *callIndex(n, frame){
        const target = n.target;
        const args = n.args;
        if (target.type === 'Name')
        {
            const bound = this.resolve(target.key, frame);
            if (bound instanceof Ref)
            {
                if (bound === frame.ret)
                {
                    // A function's own name with arguments calls it again.
                    return yield* this.invoke(/** @type {ProcDecl} */ (frame.proc), frame.self,
                        args, frame);
                }
                return yield* this.applyArgs(bound.value, args, frame);
            }
            if (bound !== null)
            {
                return yield* this.callBound(bound, args, frame);
            }
            const outside = yield* this.resolveOutside(target.name);
            if (outside?.object)
            {
                return yield* this.callExternal(outside.object, target.name, args, frame);
            }
            if (outside !== null)
            {
                return yield* this.applyArgs(outside.value, args, frame);
            }
            throw new VBRuntimeError(frame.explicit ? 500 : 13);
        }
        if (target.type === 'Member')
        {
            const object = yield* this.memberBase(target, frame);
            return yield* this.callMember(object, target.name, target.key, args, frame);
        }
        return yield* this.applyArgs(yield* this.eval(target, frame), args, frame);
    }

    /**
     * A procedure, member, item or built-in a name is bound to, called.
     *
     * @param {{ kind: number, proc?: ProcDecl, object?: VBObject, member?: Member,
     *     value?: Value, builtin?: Builtin }} bound
     * @param {(Node | null)[]} args @param {Frame} frame @returns {Steps}
     */
    *callBound(bound, args, frame){
        switch (bound.kind)
        {
            case PROC:
                return yield* this.invoke(/** @type {ProcDecl} */ (bound.proc), null, args, frame);
            case MEMBER:
                return yield* this.callClassMember(/** @type {VBObject} */ (bound.object),
                    /** @type {Member} */ (bound.member), args, frame);
            case ITEM:
                return yield* this.applyArgs(bound.value, args, frame);
            default: {
                const builtin = /** @type {Builtin} */ (bound.builtin);
                const values = yield* this.argumentValues(args, frame, builtin.raw);
                return yield* this.callBuiltin(builtin, values, frame);
            }
        }
    }

    /**
     * Arguments applied to a value: an array indexed, an object's default
     * member called; a value that is neither takes none.
     *
     * @param {Value} value @param {(Node | null)[]} args @param {Frame} frame
     * @returns {Steps}
     */
    *applyArgs(value, args, frame){
        if (value instanceof VBArray)
        {
            const indices = yield* this.argumentValues(args, frame);
            return value.items[value.offset(indices.map(toLong))];
        }
        if (isObject(value))
        {
            if (value === NOTHING)
            {
                throw new VBRuntimeError(91);
            }
            return yield* this.callDefault(value, args, frame);
        }
        if (args.length === 0)
        {
            return value;
        }
        throw new VBRuntimeError(13);
    }

    /**
     * Arguments' values applied to a value, as a COM caller applies them:
     * an array indexed, an object's default member called.
     *
     * @param {Value} value @param {Value[]} args @returns {Steps}
     */
    *applyValues(value, args){
        if (value instanceof VBArray)
        {
            return value.items[value.offset(args.map(toLong))];
        }
        if (isObject(value))
        {
            return yield* this.callDefault(value, args);
        }
        if (args.length === 0)
        {
            return value;
        }
        throw new VBRuntimeError(13);
    }

    /**
     * An object's default member called: a class's Default procedure, an
     * external object's DISPID_VALUE, a GetRef's procedure. Arguments are
     * nodes when a script passes them and values when a caller has them.
     *
     * @param {Value} object @param {(Node | null)[] | Value[]} args @param {Frame} [frame]
     * @returns {Steps}
     */
    *callDefault(object, args, frame){
        if (object instanceof VBObject)
        {
            const key = object.cls.defaultKey;
            const member = key === null ? undefined : object.cls.members.get(key);
            if (member === undefined)
            {
                throw new VBRuntimeError(438);
            }
            return yield* this.callClassMember(object, member, args, frame);
        }
        if (object instanceof FunctionRef)
        {
            return frame === undefined ? yield* this.callProc(object.proc, null, args)
                : yield* this.invoke(object.proc, null, /** @type {(Node | null)[]} */ (args),
                    frame);
        }
        if (object instanceof ExternalObject)
        {
            return frame === undefined
                ? fromHost(yield* this.external(()=>object.call(DEFAULT_MEMBER,
                    args.map(toExternal))))
                : yield* this.callExternal(object, null, /** @type {(Node | null)[]} */ (args),
                    frame);
        }
        throw new VBRuntimeError(object === NOTHING ? 91 : 424);
    }

    /**
     * object.name(arguments) read as a value.
     *
     * @param {Value} object @param {string} name @param {string} key
     * @param {(Node | null)[]} args @param {Frame} frame @returns {Steps}
     */
    *callMember(object, name, key, args, frame){
        if (object instanceof VBObject)
        {
            const member = this.visibleMember(object, key, frame);
            if (member.field)
            {
                const value = /** @type {Var} */ (object.fields.get(key)).value;
                return args.length === 0 ? value : yield* this.applyArgs(value, args, frame);
            }
            return yield* this.callClassMember(object, member, args, frame);
        }
        if (object instanceof ExternalObject)
        {
            return yield* this.callExternal(object, name, args, frame);
        }
        if (object === NOTHING)
        {
            throw new VBRuntimeError(91);
        }
        throw new VBRuntimeError(object instanceof FunctionRef ? 438 : 424);
    }

    /**
     * A member of an instance the code may reach: a Private one only from
     * the instance's own procedures.
     *
     * @param {VBObject} object @param {string} key @param {Frame} frame @returns {Member}
     */
    visibleMember(object, key, frame){
        const member = object.cls.members.get(key);
        if (member === undefined || (!member.isPublic && frame?.self !== object))
        {
            throw new VBRuntimeError(438);
        }
        return member;
    }

    /**
     * A class member called: its method, or its property's Get.
     *
     * @param {VBObject} object @param {Member} member @param {(Node | null)[] | Value[]} args
     * @param {Frame} [frame] @returns {Steps}
     */
    *callClassMember(object, member, args, frame){
        const proc = member.method ?? member.get;
        if (proc === undefined)
        {
            throw new VBRuntimeError(member.let || member.set ? 450 : 438);
        }
        return frame === undefined ? yield* this.callProc(proc, object, args)
            : yield* this.invoke(proc, object, /** @type {(Node | null)[]} */ (args), frame);
    }

    /**
     * A call on an external object. An argument that is a variable or an
     * array's element is passed by reference: what the object leaves in it
     * goes back.
     *
     * @param {ExternalObject} object @param {string | null} name
     * @param {(Node | null)[]} args @param {Frame} frame @returns {Steps}
     */
    *callExternal(object, name, args, frame){
        /** @type {Value[]} */
        const values = [];
        /** @type {(Ref | null)[]} */
        const refs = [];
        for (const arg of args)
        {
            if (arg === null)
            {
                values.push(MISSING);
                refs.push(null);
                continue;
            }
            const ref = yield* this.reference(arg, frame);
            const value = ref === null ? yield* this.eval(arg, frame) : ref.value;
            this.pin(value);
            values.push(toExternal(value));
            refs.push(ref);
        }
        const passed = [...values];
        const flags = refs.map(ref=>ref !== null);
        const answer = yield* this.external(()=>object.call(name, values,
            flags.includes(true) ? flags : undefined));
        refs.forEach((ref, i)=>{
            if (ref !== null && values[i] !== passed[i])
            {
                this.assignRef(ref, fromHost(values[i]));
            }
        });
        return fromHost(answer);
    }

    /**
     * The argument as something to pass by reference: a variable named
     * alone, or an element of an array a variable holds; null for any
     * other expression, which is passed by value.
     *
     * @param {Node} n @param {Frame} frame @returns {Steps}
     */
    *reference(n, frame){
        if (n.type === 'Name')
        {
            const bound = this.resolve(n.key, frame);
            return bound instanceof Ref && !bound.readOnly ? bound : null;
        }
        if (n.type === 'Index' && n.target.type === 'Name')
        {
            const bound = this.resolve(n.target.key, frame);
            if (bound instanceof Ref && bound !== frame.ret && bound.value instanceof VBArray)
            {
                const array = bound.value;
                const indices = yield* this.argumentValues(n.args, frame);
                return new ElementRef(array, array.offset(indices.map(toLong)));
            }
        }
        return null;
    }

    /**
     * Arguments' values: an object's default value unless `raw`, a left-out
     * argument as Empty.
     *
     * @param {(Node | null)[]} args @param {Frame} frame @param {boolean} [raw]
     * @returns {Steps}
     */
    *argumentValues(args, frame, raw = false){
        const values = [];
        for (const arg of args)
        {
            if (arg === null)
            {
                values.push(undefined);
                continue;
            }
            values.push(raw ? yield* this.eval(arg, frame) : yield* this.value(arg, frame));
        }
        return values;
    }

    /**
     * A built-in called with its arguments' values.
     *
     * @param {Builtin} builtin @param {Value[]} args @param {Frame} frame @returns {Steps}
     */
    *callBuiltin(builtin, args, frame){
        if (builtin.fn === undefined)
        {
            if (args.length > 0)
            {
                throw new VBRuntimeError(13);
            }
            return builtin.value;
        }
        if (args.length < (builtin.min ?? 0) || args.length > (builtin.max ?? builtin.min ?? 0))
        {
            throw new VBRuntimeError(450);
        }
        const answer = builtin.fn(args, { interp: this, frame });
        return builtin.steps ? yield* answer : answer;
    }

    /**
     * A statement that calls: a procedure, a built-in, a member, an
     * object's default member; whatever it answers is dropped.
     *
     * @param {Node} n @param {Frame} frame @returns {Steps}
     */
    *callStatement(n, frame){
        const target = n.target;
        if (target.type === 'Name')
        {
            const bound = this.resolve(target.key, frame);
            if (bound instanceof Ref)
            {
                if (bound === frame.ret)
                {
                    yield* this.invoke(/** @type {ProcDecl} */ (frame.proc), frame.self, n.args,
                        frame);
                    return;
                }
                const value = bound.value;
                if (!isObject(value))
                {
                    throw new VBRuntimeError(13);
                }
                yield* this.callDefault(value, n.args, frame);
                return;
            }
            if (bound !== null)
            {
                if (bound.kind === ITEM)
                {
                    yield* this.callDefault(bound.value, n.args, frame);
                    return;
                }
                yield* this.callBound(bound, n.args, frame);
                return;
            }
            const outside = yield* this.resolveOutside(target.name);
            if (outside?.object)
            {
                yield* this.callExternal(outside.object, target.name, n.args, frame);
                return;
            }
            if (outside !== null)
            {
                yield* this.callDefault(outside.value, n.args, frame);
                return;
            }
            throw new VBRuntimeError(frame.explicit ? 500 : 13);
        }
        if (target.type === 'Member')
        {
            const object = yield* this.memberBase(target, frame);
            yield* this.callMember(object, target.name, target.key, n.args, frame);
            return;
        }
        const value = yield* this.eval(target, frame);
        if (!isObject(value))
        {
            throw new VBRuntimeError(13);
        }
        yield* this.callDefault(value, n.args, frame);
    }

    // ---- procedures ---------------------------------------------------------

    /**
     * A script's call of a procedure: by reference an argument that is a
     * variable or an array's element, unless the parameter is ByVal or the
     * argument is in parentheses.
     *
     * @param {ProcDecl} proc @param {VBObject | null} self @param {(Node | null)[]} args
     * @param {Frame} frame @returns {Steps}
     */
    *invoke(proc, self, args, frame){
        if (args.length !== proc.params.length)
        {
            throw new VBRuntimeError(450);
        }
        /** @type {Map<string, Ref>} */
        const bindings = new Map();
        /** @type {Var[]} */
        const owned = [];
        try
        {
            for (let i = 0; i < args.length; i++)
            {
                const param = proc.params[i];
                const arg = args[i];
                if (arg === null)
                {
                    throw new VBRuntimeError(450);
                }
                const ref = param.byVal ? null : yield* this.reference(arg, frame);
                if (ref !== null)
                {
                    bindings.set(param.key, ref);
                    continue;
                }
                const variable = new Var(undefined);
                this.assignRef(variable, yield* this.eval(arg, frame));
                bindings.set(param.key, variable);
                owned.push(variable);
            }
        }
        catch (e){
            owned.forEach(variable=>this.release(variable.value));
            throw e;
        }
        return yield* this.run(proc, self, bindings, owned);
    }

    /**
     * A procedure called with values, every one by value: from the host,
     * a COM caller, an object's property assignment.
     *
     * @param {ProcDecl} proc @param {VBObject | null} self @param {Value[]} args
     * @returns {Steps}
     */
    *callProc(proc, self, args){
        if (args.length !== proc.params.length)
        {
            throw new VBRuntimeError(450);
        }
        /** @type {Map<string, Ref>} */
        const bindings = new Map();
        /** @type {Var[]} */
        const owned = [];
        proc.params.forEach((param, i)=>{
            const variable = new Var(undefined);
            this.assignRef(variable, args[i]);
            bindings.set(param.key, variable);
            owned.push(variable);
        });
        return yield* this.run(proc, self, bindings, owned);
    }

    /**
     * Runs a procedure's body in a frame of its own.
     *
     * @param {ProcDecl} proc @param {VBObject | null} self @param {Map<string, Ref>} bindings
     * @param {Var[]} owned @returns {Steps}
     */
    *run(proc, self, bindings, owned){
        if (--this.budget <= 0)
        {
            yield* this.checkpoint();
        }
        if (this.depth >= MAX_DEPTH)
        {
            owned.forEach(variable=>this.release(variable.value));
            throw new VBRuntimeError(28);
        }
        const caller = this.depth;
        this.depth++;
        const frame = new Frame(proc, self, this.depth, proc.source,
            /** @type {any} */ (proc).explicit === true);
        frame.locals = bindings;
        frame.owned = owned;
        for (const decl of proc.dims)
        {
            this.declareVariable(frame, decl.key, decl.dims);
        }
        for (const item of proc.consts)
        {
            this.declareConstant(frame, item.key, item.value);
        }
        if (proc.kind === 'function' || proc.kind === 'get')
        {
            frame.ret = new Var(undefined);
        }
        this.retain(self);
        try
        {
            yield* this.execBlock(proc.body, frame);
            return frame.ret === null ? undefined : frame.ret.value;
        }
        finally
        {
            for (const variable of frame.owned)
            {
                this.release(variable.value);
            }
            if (frame.ret !== null)
            {
                this.release(frame.ret.value);
            }
            this.release(self);
            this.depth = caller;
            // What the procedure let go and nothing holds now -- its answer
            // among them -- goes at the end of the caller's statement.
            for (const entry of this.pending)
            {
                if (entry.depth > caller)
                {
                    entry.depth = caller;
                }
            }
        }
    }

    /**
     * New: an instance of a script's class, its fields made and its
     * Class_Initialize run, or of a built-in class.
     *
     * @param {string} key @returns {Steps}
     */
    *construct(key){
        const cls = this.classes.get(key);
        if (cls === undefined)
        {
            const builtin = this.builtinClasses.get(key);
            if (builtin === undefined)
            {
                throw new VBRuntimeError(506);
            }
            return builtin(this);
        }
        const object = new VBObject(cls);
        for (const field of cls.fields)
        {
            object.fields.set(field.key, new Var(newVariableValue(field.dims)));
        }
        this.live.add(object);
        this.pending.push({ object, depth: this.depth });
        if (cls.initialize !== null)
        {
            yield* this.callProc(cls.initialize, object, []);
        }
        return object;
    }

    // ---- Eval, Execute, ExecuteGlobal ---------------------------------------

    /**
     * Parses a text a script handed over, a syntax error in it as the
     * runtime error the script sees.
     *
     * @param {() => Program} parse @returns {Program}
     */
    parseText(parse){
        try
        {
            return parse();
        }
        catch (e){
            if (e instanceof SyntaxFailure)
            {
                throw new VBRuntimeError(e.code, MESSAGES[e.code], SOURCE_COMPILATION);
            }
            throw e;
        }
    }

    /**
     * Eval: an expression evaluated where the call is.
     *
     * @param {string} text @param {Frame} frame @returns {Steps}
     */
    *evaluate(text, frame){
        const program = this.parseText(()=>parseExpressionProgram(text,
            { thisYear: this.options.thisYear }));
        return yield* this.eval(program.body[0].expr, frame);
    }

    /**
     * Execute and ExecuteGlobal: statements run where the call is, or in
     * the global scope; their procedures and classes are global either way.
     *
     * @param {string} text @param {Frame} frame @param {boolean} global @returns {Steps}
     */
    *execute(text, frame, global){
        const program = this.parseText(()=>parseProgram(text,
            { thisYear: this.options.thisYear }));
        const explicit = program.explicit || frame.explicit;
        const scope = global ? new Frame(null, null, frame.depth, program.source, explicit)
            : frame.nested(program.source, explicit);
        this.declare(program, scope);
        const completion = yield* this.execBlock(program.body, scope);
        if (completion !== undefined)
        {
            throw new VBRuntimeError(1039, MESSAGES[1039], SOURCE_COMPILATION);
        }
        return undefined;
    }
}

/**
 * A declared variable's first value: Empty, or an array of the declared
 * size -- fixed when the size was given.
 *
 * @param {number[] | null} dims @returns {Value}
 */
function newVariableValue(dims){
    if (dims === null)
    {
        return undefined;
    }
    if (dims.length === 0)
    {
        return new VBArray([], []);
    }
    const array = VBArray.sized(dims);
    array.fixed = true;
    return array;
}

/**
 * A comparison operator's answer from VarCmp's order.
 *
 * @param {string} op @param {number} order @returns {boolean}
 */
function compared(op, order){
    switch (op)
    {
        case '=': return order === 0;
        case '<>': return order !== 0;
        case '<': return order < 0;
        case '>': return order > 0;
        case '<=': return order <= 0;
        default: return order >= 0;
    }
}

/**
 * A For loop's bound: a number as it is, text read as a Double.
 *
 * @param {Value} value @returns {Value}
 */
function numericBound(value){
    if (typeof value === 'string' || value === undefined || typeof value === 'boolean')
    {
        return toDouble(value);
    }
    if (value === null)
    {
        throw new VBRuntimeError(94);
    }
    toDouble(value);
    return value;
}

/**
 * ReDim Preserve: the elements of the old array copied into the new one
 * where their indices are inside it. Only the last dimension may change.
 *
 * @param {VBArray} old @param {VBArray} array
 */
function preserveInto(old, array){
    if (old.bounds.length !== array.bounds.length)
    {
        throw new VBRuntimeError(9);
    }
    for (let d = 0; d < old.bounds.length - 1; d++)
    {
        if (old.bounds[d].count !== array.bounds[d].count)
        {
            throw new VBRuntimeError(9);
        }
    }
    // The last dimension varies slowest, so what is kept is a prefix.
    const kept = Math.min(old.items.length, array.items.length);
    for (let i = 0; i < kept; i++)
    {
        array.items[i] = old.items[i];
    }
    for (let d = 0; d < old.bounds.length; d++)
    {
        array.bounds[d].lower = old.bounds[d].lower;
    }
}

