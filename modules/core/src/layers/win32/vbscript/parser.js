/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * VBScript's grammar, as the VBScript Language Reference lays it out, read
 * into a tree the interpreter walks.
 *
 * Declarations are gathered as they are read: a text's procedures and
 * classes, and the variables and constants its global code and each
 * procedure declare, exist before any statement runs -- a Dim further down
 * still declares the name for the lines above it, which is what lets
 * Option Explicit code use a variable before the line that declares it.
 *
 * A statement that calls a procedure without Call writes its arguments
 * without parentheses; `Foo (x)` passes one argument, the parenthesised --
 * and so by-value -- x, and `Foo (1) + 2` the sum. Two arguments in
 * parentheses there are compilation error 1044.
 */

import { NOTHING, date, integer, long, negate } from './values.js';
import { MESSAGES, SyntaxFailure } from './errors.js';
import { NAME_KEYWORDS, tokenize } from './lexer.js';
import { dateFromText } from '../oleaut32/vartext.js';

/**
 * @typedef {import('./lexer.js').Token} Token
 * @typedef {import('./errors.js').SourceText} SourceText
 * @typedef {Record<string, any>} Node
 */

/**
 * A declared variable: scalar (`dims` null), dynamic array (`dims` []), or
 * fixed array of these upper bounds.
 *
 * @typedef {{ name: string, key: string, dims: number[] | null, pos: number }} VariableDecl
 */

/**
 * @typedef {Object} Parameter
 * @property {string} name @property {string} key
 * @property {boolean} byVal
 */

/**
 * A Sub, Function or Property procedure.
 *
 * @typedef {Object} ProcDecl
 * @property {'sub' | 'function' | 'get' | 'let' | 'set'} kind
 * @property {string} name @property {string} key
 * @property {Parameter[]} params
 * @property {Node[]} body
 * @property {boolean} isPublic @property {boolean} isDefault
 * @property {VariableDecl[]} dims  Its local variables.
 * @property {{ name: string, key: string, value: any }[]} consts
 * @property {SourceText} source
 * @property {number} pos
 * @property {ClassDecl | null} owner
 */

/**
 * @typedef {Object} ClassDecl
 * @property {string} name @property {string} key
 * @property {(VariableDecl & { isPublic: boolean })[]} fields
 * @property {ProcDecl[]} procs
 * @property {number} pos
 */

/**
 * @typedef {Object} Program
 * @property {Node[]} body
 * @property {ProcDecl[]} procs
 * @property {ClassDecl[]} classes
 * @property {VariableDecl[]} dims
 * @property {{ name: string, key: string, value: any }[]} consts
 * @property {boolean} explicit  Option Explicit.
 * @property {boolean} expression  An expression text, whose value is the answer.
 * @property {SourceText} source
 */

/**
 * @typedef {Object} ParseOptions
 * @property {number} [line]  The line the text starts on.
 * @property {number} [context]  The host's cookie for it.
 * @property {() => number | null} [thisYear]  For a date literal with no year.
 */

/** The operators of each binary level, lowest first. */
const LEVELS = [
    ['imp'], ['eqv'], ['xor'], ['or'], ['and'],
];
const COMPARISONS = new Set(['=', '<>', '<', '>', '<=', '>=', 'is']);

class Parser
{
    /** @param {string} text @param {ParseOptions} options */
    constructor(text, options){
        this.tokens = tokenize(text);
        this.at = 0;
        /** @type {SourceText} */
        this.source = { text, line: options.line ?? 0, context: options.context ?? 0 };
        this.thisYear = options.thisYear ?? (()=>null);
        /** @type {ProcDecl | null} the procedure being read */
        this.proc = null;
        /** @type {ClassDecl | null} */
        this.cls = null;
        /** @type {string[]} the loops around the statement being read */
        this.loops = [];
        /** Inside a one-line If, where Else ends a statement. */
        this.inline = 0;
        /** @type {VariableDecl[]} where a Dim being read declares */
        this.dims = [];
        /** @type {{ name: string, key: string, value: any }[]} */
        this.consts = [];
    }

    /** @returns {Token} */
    get token(){
        return this.tokens[this.at];
    }

    /** @param {number} [ahead] @returns {Token} */
    peek(ahead = 1){
        return this.tokens[Math.min(this.at + ahead, this.tokens.length - 1)];
    }

    /** @returns {Token} */
    next(){
        const token = this.tokens[this.at];
        if (this.at < this.tokens.length - 1)
        {
            this.at++;
        }
        return token;
    }

    /** @param {number} code @param {Token} [token] @returns {never} */
    fail(code, token = this.token){
        throw new SyntaxFailure(code, token.pos);
    }

    /** @param {string} key @returns {boolean} whether the token is this keyword or operator */
    is(key){
        const token = this.token;
        return (token.kind === 'kw' || token.kind === 'op') && token.key === key;
    }

    /** @param {string} key @param {number} code */
    expect(key, code){
        if (!this.is(key))
        {
            this.fail(code);
        }
        return this.next();
    }

    /** @param {string} key @returns {boolean} whether it was there, taken */
    accept(key){
        if (this.is(key))
        {
            this.next();
            return true;
        }
        return false;
    }

    /** @param {string} first @param {string} second */
    isPair(first, second){
        const a = this.token;
        const b = this.peek();
        return a.kind === 'kw' && a.key === first && b.kind === 'kw' && b.key === second;
    }

    /** @returns {boolean} whether the token names something */
    isName(){
        const token = this.token;
        return token.kind === 'id' || (token.kind === 'kw' && NAME_KEYWORDS.has(token.key));
    }

    /** @returns {{ name: string, key: string, pos: number }} */
    name(){
        if (!this.isName())
        {
            this.fail(1010);
        }
        const token = this.next();
        return { name: String(token.value), key: token.key, pos: token.pos };
    }

    /** @returns {boolean} whether a statement ends here */
    atEnd(){
        const token = this.token;
        return token.kind === 'nl' || token.kind === 'eof' || token.key === ':'
            || (this.inline > 0 && token.kind === 'kw' && token.key === 'else');
    }

    endStatement(){
        if (!this.atEnd())
        {
            this.fail(1025);
        }
    }

    skipSeparators(){
        while (this.token.kind === 'nl' || this.is(':'))
        {
            this.next();
        }
    }

    /** @returns {Program} */
    program(){
        /** @type {ProcDecl[]} */
        const procs = [];
        /** @type {ClassDecl[]} */
        const classes = [];
        const body = [];
        let explicit = false;
        for (;;)
        {
            this.skipSeparators();
            const token = this.token;
            if (token.kind === 'eof')
            {
                break;
            }
            if (this.isPair('option', 'explicit'))
            {
                this.next();
                this.next();
                explicit = true;
                this.endStatement();
                continue;
            }
            const declared = this.declaration(false);
            if (declared !== null)
            {
                if (declared.kind === 'class')
                {
                    classes.push(declared.decl);
                }
                else if (declared.kind === 'proc')
                {
                    procs.push(declared.decl);
                }
                else
                {
                    body.push(declared.decl);
                }
                continue;
            }
            body.push(this.statement());
            this.endStatement();
        }
        const keys = new Set();
        for (const decl of [...procs, ...classes])
        {
            if (keys.has(decl.key))
            {
                throw new SyntaxFailure(1041, decl.pos);
            }
            keys.add(decl.key);
        }
        return { body, procs, classes, dims: this.dims, consts: this.consts, explicit,
            expression: false, source: this.source };
    }

    /**
     * A declaration at the level of a text or a class: a procedure, a class,
     * or a Public or Private variable or constant. null for anything else,
     * nothing read.
     *
     * @param {boolean} inClass
     * @returns {{ kind: 'proc', decl: ProcDecl } | { kind: 'class', decl: ClassDecl }
     *     | { kind: 'statement', decl: Node } | null}
     */
    declaration(inClass){
        const token = this.token;
        if (token.kind !== 'kw')
        {
            return null;
        }
        let isPublic = true;
        let isDefault = false;
        let scoped = false;
        if (token.key === 'public' || token.key === 'private')
        {
            isPublic = token.key === 'public';
            scoped = true;
            this.next();
            if (this.is('default'))
            {
                const at = this.next();
                if (!isPublic)
                {
                    this.fail(1057, at);
                }
                if (!inClass)
                {
                    this.fail(1048, at);
                }
                isDefault = true;
            }
        }
        const head = this.token;
        if (head.kind === 'kw' && (head.key === 'sub' || head.key === 'function'
            || head.key === 'property'))
        {
            if (head.key === 'property' && !inClass)
            {
                this.fail(1048);
            }
            return { kind: 'proc', decl: this.procedure(isPublic, isDefault) };
        }
        if (isDefault)
        {
            this.fail(1056);
        }
        if (head.kind === 'kw' && head.key === 'class' && !scoped)
        {
            if (inClass)
            {
                this.fail(1024);
            }
            return { kind: 'class', decl: this.classDecl() };
        }
        if (head.kind === 'kw' && head.key === 'const')
        {
            if (inClass)
            {
                this.fail(1024);
            }
            this.next();
            const decl = this.constants();
            this.endStatement();
            return { kind: 'statement', decl };
        }
        if (!scoped)
        {
            return null;
        }
        // Public or Private alone declares variables, as Dim does.
        const decl = this.dimList(inClass ? isPublic : true);
        this.endStatement();
        return { kind: 'statement', decl };
    }

    /**
     * Sub, Function or Property, from its keyword to its End.
     *
     * @param {boolean} isPublic @param {boolean} isDefault @returns {ProcDecl}
     */
    procedure(isPublic, isDefault){
        const start = this.next();
        /** @type {ProcDecl['kind']} */
        let kind;
        if (start.key === 'property')
        {
            const which = this.token;
            if (which.kind !== 'kw' || !['get', 'let', 'set'].includes(which.key))
            {
                this.fail(1049);
            }
            this.next();
            kind = /** @type {ProcDecl['kind']} */ (which.key);
            if (isDefault && kind !== 'get')
            {
                this.fail(1058, which);
            }
        }
        else
        {
            kind = start.key === 'sub' ? 'sub' : 'function';
        }
        const { name, key, pos } = this.name();
        /** @type {Parameter[]} */
        const params = [];
        if (this.accept('('))
        {
            if (!this.is(')'))
            {
                for (;;)
                {
                    let byVal = false;
                    if (this.accept('byval'))
                    {
                        byVal = true;
                    }
                    else
                    {
                        this.accept('byref');
                    }
                    const param = this.name();
                    if (this.accept('('))
                    {
                        this.expect(')', 1006);
                    }
                    params.push({ name: param.name, key: param.key, byVal });
                    if (!this.accept(','))
                    {
                        break;
                    }
                }
            }
            this.expect(')', 1006);
        }
        if ((kind === 'let' || kind === 'set') && params.length === 0)
        {
            this.fail(1054);
        }
        if (this.cls !== null && (key === 'class_initialize' || key === 'class_terminate')
            && params.length > 0)
        {
            this.fail(1053);
        }
        /** @type {ProcDecl} */
        const proc = { kind, name, key, params, body: [], isPublic, isDefault, dims: [],
            consts: [], source: this.source, pos, owner: this.cls };
        const outer = { proc: this.proc, loops: this.loops, dims: this.dims,
            consts: this.consts };
        this.proc = proc;
        this.loops = [];
        this.dims = proc.dims;
        this.consts = proc.consts;
        const ending = kind === 'sub' ? 'sub' : kind === 'function' ? 'function' : 'property';
        proc.body = this.block(()=>this.isPair('end', ending), ending === 'sub' ? 1016
            : ending === 'function' ? 1015 : 1050);
        this.next();
        this.next();
        this.proc = outer.proc;
        this.loops = outer.loops;
        this.dims = outer.dims;
        this.consts = outer.consts;
        this.endStatement();
        return proc;
    }

    /** @returns {ClassDecl} */
    classDecl(){
        this.next();
        const { name, key, pos } = this.name();
        this.endStatement();
        /** @type {ClassDecl} */
        const cls = { name, key, fields: [], procs: [], pos };
        this.cls = cls;
        const keys = new Set();
        let defaults = 0;
        for (;;)
        {
            this.skipSeparators();
            if (this.isPair('end', 'class'))
            {
                this.next();
                this.next();
                break;
            }
            if (this.token.kind === 'eof')
            {
                this.fail(1047);
            }
            if (this.is('dim'))
            {
                this.next();
                const decl = this.dimList(true);
                cls.fields.push(...decl.decls.map((/** @type {VariableDecl} */ d)=>
                    ({ ...d, isPublic: true })));
                this.endStatement();
                continue;
            }
            const declared = this.declaration(true);
            if (declared === null)
            {
                this.fail(1024);
            }
            if (declared.kind === 'proc')
            {
                const proc = declared.decl;
                // A property is one name for its Get, Let and Set.
                const slot = `${proc.kind === 'let' || proc.kind === 'set' || proc.kind === 'get'
                    ? proc.kind : 'method'}:${proc.key}`;
                if (keys.has(slot) || keys.has(`field:${proc.key}`)
                    || (slot.startsWith('method') && [...keys].some(k=>k.endsWith(`:${proc.key}`))))
                {
                    throw new SyntaxFailure(1041, proc.pos);
                }
                keys.add(slot);
                defaults += proc.isDefault ? 1 : 0;
                if (defaults > 1)
                {
                    throw new SyntaxFailure(1052, proc.pos);
                }
                cls.procs.push(proc);
            }
            else if (declared.kind === 'statement' && declared.decl.type === 'Dim')
            {
                for (const decl of declared.decl.decls)
                {
                    if (keys.has(`field:${decl.key}`))
                    {
                        throw new SyntaxFailure(1041, decl.pos);
                    }
                    keys.add(`field:${decl.key}`);
                    cls.fields.push(decl);
                }
            }
        }
        this.cls = null;
        this.endStatement();
        return cls;
    }

    /**
     * Statements up to the one `done` recognises, which is not read.
     *
     * @param {() => boolean} done @param {number} missing  The error when the text ends first.
     * @returns {Node[]}
     */
    block(done, missing){
        const body = [];
        for (;;)
        {
            this.skipSeparators();
            if (done())
            {
                return body;
            }
            if (this.token.kind === 'eof')
            {
                this.fail(missing);
            }
            body.push(this.statement());
            this.endStatement();
        }
    }

    /** @returns {Node} */
    statement(){
        const token = this.token;
        const pos = token.pos;
        if (token.kind === 'kw')
        {
            switch (token.key)
            {
                case 'dim':
                    this.next();
                    return this.dimList(true);
                case 'public': case 'private':
                case 'sub': case 'function': case 'property': case 'class':
                    // Not inside a procedure or a block.
                    return this.fail(1024);
                case 'const':
                    this.next();
                    return this.constants();
                case 'redim': return this.redim();
                case 'erase': {
                    this.next();
                    const targets = [];
                    for (;;)
                    {
                        targets.push(this.postfix(this.primaryName()));
                        if (!this.accept(','))
                        {
                            break;
                        }
                    }
                    return { type: 'Erase', targets, pos };
                }
                case 'if': return this.ifStatement();
                case 'select': return this.selectStatement();
                case 'for': return this.forStatement();
                case 'do': return this.doStatement();
                case 'while': {
                    this.next();
                    const test = this.expression();
                    this.loops.push('while');
                    const body = this.block(()=>this.is('wend'), 1018);
                    this.loops.pop();
                    this.next();
                    return { type: 'While', test, body, pos };
                }
                case 'exit': return this.exitStatement();
                case 'with': {
                    this.next();
                    const object = this.expression();
                    const body = this.block(()=>this.isPair('end', 'with'), 1029);
                    this.next();
                    this.next();
                    return { type: 'With', object, body, pos };
                }
                case 'on': {
                    this.next();
                    this.expect('error', 1002);
                    if (this.accept('resume'))
                    {
                        this.expect('next', 1002);
                        return { type: 'OnError', resume: true, pos };
                    }
                    this.expect('goto', 1002);
                    const zero = this.token;
                    if (zero.kind !== 'num' || zero.value.value !== 0)
                    {
                        this.fail(1002);
                    }
                    this.next();
                    return { type: 'OnError', resume: false, pos };
                }
                case 'set': case 'let': {
                    this.next();
                    const target = this.postfix(this.primaryName());
                    this.expect('=', 1011);
                    return { type: 'Assign', target, value: this.expression(),
                        set: token.key === 'set', pos };
                }
                case 'call': {
                    this.next();
                    const target = this.postfix(this.primaryName());
                    if (target.type === 'Index')
                    {
                        return { type: 'Call', target: target.target, args: target.args, pos };
                    }
                    return { type: 'Call', target, args: [], pos };
                }
                case 'stop':
                    this.next();
                    return { type: 'Stop', pos };
                case 'option':
                    return this.fail(1042);
                case 'loop':
                    return this.fail(1038);
                case 'next':
                    return this.fail(1055);
                case 'me':
                    break;
                default:
                    if (!NAME_KEYWORDS.has(token.key))
                    {
                        return this.fail(1024);
                    }
            }
        }
        if (token.kind !== 'id' && !(token.kind === 'kw') && !this.is('.'))
        {
            return this.fail(1024);
        }
        return this.callOrAssign();
    }

    /**
     * A statement that starts with a name: an assignment, or a call whose
     * arguments are not in parentheses.
     *
     * @returns {Node}
     */
    callOrAssign(){
        const pos = this.token.pos;
        const head = this.primaryName();
        let target = head;
        /** where the last group of parentheses opened, and what it followed */
        let lastGroup = -1;
        /** @type {Node | null} */
        let beforeGroup = null;
        for (;;)
        {
            if (this.is('.') && !this.token.space)
            {
                this.next();
                const member = this.memberName();
                target = { type: 'Member', object: target, ...member };
                lastGroup = -1;
                continue;
            }
            if (this.is('('))
            {
                lastGroup = this.at;
                beforeGroup = target;
                const args = this.argumentGroup();
                target = { type: 'Index', target, args, pos: target.pos };
                continue;
            }
            break;
        }
        if (this.is('='))
        {
            this.next();
            return { type: 'Assign', target, value: this.expression(), set: false, pos };
        }
        if (this.atEnd())
        {
            if (lastGroup >= 0 && target.type === 'Index')
            {
                // Foo(x) alone: one argument, parenthesised; more is an error.
                if (target.args.length > 1)
                {
                    throw new SyntaxFailure(1044, this.tokens[lastGroup].pos);
                }
                const args = target.args.length === 0 ? []
                    : [target.args[0] === null ? null
                        : { type: 'Paren', expr: target.args[0], pos: target.args[0].pos }];
                return { type: 'Call', target: target.target, args, pos };
            }
            return { type: 'Call', target, args: [], pos };
        }
        if (lastGroup >= 0 && target.type === 'Index')
        {
            // Foo (1) + 2, Foo (1), 2: the parentheses open the first argument.
            this.at = lastGroup;
            target = /** @type {Node} */ (beforeGroup);
        }
        return { type: 'Call', target, args: this.bareArguments(), pos };
    }

    /** @returns {(Node | null)[]} arguments up to the end of the statement */
    bareArguments(){
        const args = [];
        for (;;)
        {
            if (this.is(','))
            {
                args.push(null);
                this.next();
                continue;
            }
            args.push(this.expression());
            if (!this.accept(','))
            {
                break;
            }
            if (this.atEnd())
            {
                args.push(null);
                break;
            }
        }
        return args;
    }

    /** @returns {(Node | null)[]} the arguments in parentheses, an empty slot null */
    argumentGroup(){
        this.expect('(', 1005);
        /** @type {(Node | null)[]} */
        const args = [];
        if (this.accept(')'))
        {
            return args;
        }
        for (;;)
        {
            if (this.is(',') || this.is(')'))
            {
                args.push(null);
            }
            else
            {
                args.push(this.expression());
            }
            if (this.accept(')'))
            {
                return args;
            }
            this.expect(',', 1006);
        }
    }

    /** @returns {Node} a name, Me, or a With block's .member, to start a target */
    primaryName(){
        const token = this.token;
        if (token.kind === 'kw' && token.key === 'me')
        {
            this.next();
            if (this.proc === null || this.proc.owner === null)
            {
                this.fail(1037, token);
            }
            return { type: 'Me', pos: token.pos };
        }
        if (this.is('.'))
        {
            this.next();
            return { type: 'Member', object: null, ...this.memberName() };
        }
        const { name, key, pos } = this.name();
        return { type: 'Name', name, key, pos };
    }

    /** @returns {{ name: string, key: string, pos: number }} the name after a "." */
    memberName(){
        const token = this.token;
        if (token.kind !== 'id' && token.kind !== 'kw')
        {
            this.fail(1010);
        }
        this.next();
        return { name: String(token.value), key: token.key, pos: token.pos };
    }

    /**
     * The .name and (arguments) after a start.
     *
     * @param {Node} start @returns {Node}
     */
    postfix(start){
        let node = start;
        for (;;)
        {
            if (this.is('.') && !this.token.space)
            {
                this.next();
                node = { type: 'Member', object: node, ...this.memberName() };
                continue;
            }
            if (this.is('('))
            {
                node = { type: 'Index', target: node, args: this.argumentGroup(), pos: node.pos };
                continue;
            }
            return node;
        }
    }

    /**
     * Dim's list, also a Public or Private one's.
     *
     * @param {boolean} isPublic @returns {Node}
     */
    dimList(isPublic){
        const pos = this.token.pos;
        const decls = [];
        for (;;)
        {
            const { name, key, pos: at } = this.name();
            /** @type {number[] | null} */
            let dims = null;
            if (this.accept('('))
            {
                dims = [];
                if (!this.is(')'))
                {
                    for (;;)
                    {
                        const token = this.token;
                        if (token.kind !== 'num' || token.value.type === 'double'
                            || token.value.value < 0)
                        {
                            this.fail(1026);
                        }
                        this.next();
                        dims.push(token.value.value);
                        if (!this.accept(','))
                        {
                            break;
                        }
                    }
                }
                this.expect(')', 1006);
            }
            const decl = { name, key, dims, pos: at, isPublic };
            decls.push(decl);
            if (this.cls === null || this.proc !== null)
            {
                this.dims.push(decl);
            }
            if (!this.accept(','))
            {
                break;
            }
        }
        return { type: 'Dim', decls, pos };
    }

    /** @returns {Node} Const's list, after the keyword */
    constants(){
        const pos = this.token.pos;
        const items = [];
        for (;;)
        {
            const { name, key } = this.name();
            this.expect('=', 1011);
            const item = { name, key, value: this.literal() };
            items.push(item);
            this.consts.push(item);
            if (!this.accept(','))
            {
                break;
            }
        }
        return { type: 'Const', items, pos };
    }

    /** @returns {any} a literal constant's value, a sign in front allowed */
    literal(){
        let sign = 1;
        let signed = false;
        while (this.is('-') || this.is('+'))
        {
            sign *= this.next().key === '-' ? -1 : 1;
            signed = true;
        }
        if (this.is('('))
        {
            this.next();
            const value = this.literal();
            this.expect(')', 1006);
            return value;
        }
        const token = this.token;
        const node = this.primary();
        if (node.type !== 'Lit' || (signed && token.kind !== 'num'))
        {
            this.fail(1045, token);
        }
        return sign < 0 ? negate(node.value) : node.value;
    }

    /** @returns {Node} */
    redim(){
        const pos = this.next().pos;
        const preserve = this.accept('preserve');
        const items = [];
        for (;;)
        {
            const { name, key, pos: at } = this.name();
            const args = this.argumentGroup();
            if (args.length === 0 || args.includes(null))
            {
                this.fail(1023);
            }
            items.push({ name, key, dims: args, pos: at });
            if (!this.accept(','))
            {
                break;
            }
        }
        return { type: 'ReDim', preserve, items, pos };
    }

    /** @returns {Node} */
    ifStatement(){
        const pos = this.next().pos;
        const test = this.expression();
        this.expect('then', 1017);
        if (this.token.kind !== 'nl' && this.token.kind !== 'eof')
        {
            return this.inlineIf(test, pos);
        }
        const branches = [];
        /** @type {Node[] | null} */
        let otherwise = null;
        let current = { test, body: /** @type {Node[]} */ ([]) };
        const done = ()=>this.is('elseif') || this.is('else') || this.isPair('end', 'if');
        for (;;)
        {
            current.body = this.block(done, 1014);
            branches.push(current);
            if (this.accept('elseif'))
            {
                const next = this.expression();
                this.expect('then', 1017);
                current = { test: next, body: [] };
                continue;
            }
            if (this.accept('else'))
            {
                otherwise = this.block(()=>this.isPair('end', 'if'), 1014);
            }
            this.next();
            this.next();
            return { type: 'If', branches, otherwise, pos };
        }
    }

    /**
     * If ... Then statements [Else statements], on one line.
     *
     * @param {Node} test @param {number} pos @returns {Node}
     */
    inlineIf(test, pos){
        this.inline++;
        const body = this.inlineStatements();
        /** @type {Node[] | null} */
        let otherwise = null;
        if (this.accept('else'))
        {
            otherwise = this.inlineStatements();
        }
        this.inline--;
        // One-line Ifs nest, and the outer one's Else may follow.
        if (this.token.kind !== 'nl' && this.token.kind !== 'eof'
            && !(this.inline > 0 && this.is('else')))
        {
            this.fail(1025);
        }
        return { type: 'If', branches: [{ test, body }], otherwise, pos };
    }

    /** @returns {Node[]} statements separated by ":", to the line's end or an Else */
    inlineStatements(){
        const body = [];
        for (;;)
        {
            if (this.token.kind === 'nl' || this.token.kind === 'eof' || this.is('else'))
            {
                return body;
            }
            if (this.accept(':'))
            {
                continue;
            }
            body.push(this.statement());
            this.endStatement();
        }
    }

    /** @returns {Node} */
    selectStatement(){
        const pos = this.next().pos;
        this.expect('case', 1021);
        const subject = this.expression();
        this.endStatement();
        const cases = [];
        /** @type {Node[] | null} */
        let otherwise = null;
        this.skipSeparators();
        while (!this.isPair('end', 'select'))
        {
            if (!this.is('case'))
            {
                this.fail(this.token.kind === 'eof' ? 1022 : 1021);
            }
            this.next();
            const done = ()=>this.is('case') || this.isPair('end', 'select');
            if (this.accept('else'))
            {
                otherwise = this.block(done, 1022);
                continue;
            }
            const tests = [];
            for (;;)
            {
                if (this.accept('is'))
                {
                    const op = this.token;
                    if (op.kind !== 'op' || !COMPARISONS.has(op.key))
                    {
                        this.fail(1023);
                    }
                    this.next();
                    tests.push({ kind: 'is', op: op.key, expr: this.concatenation() });
                }
                else
                {
                    const from = this.expression();
                    tests.push(this.accept('to') ? { kind: 'range', from, to: this.expression() }
                        : { kind: 'value', expr: from });
                }
                if (!this.accept(','))
                {
                    break;
                }
            }
            cases.push({ tests, body: this.block(done, 1022) });
        }
        this.next();
        this.next();
        return { type: 'Select', subject, cases, otherwise, pos };
    }

    /** @returns {Node} */
    forStatement(){
        const pos = this.next().pos;
        if (this.accept('each'))
        {
            const variable = this.primaryName();
            this.expect('in', 1046);
            const collection = this.expression();
            this.loops.push('for');
            const body = this.block(()=>this.is('next'), 1020);
            this.loops.pop();
            this.next();
            this.nextName();
            return { type: 'ForEach', variable, collection, body, pos };
        }
        const variable = this.primaryName();
        if (variable.type !== 'Name')
        {
            this.fail(1040);
        }
        this.expect('=', 1011);
        const from = this.expression();
        this.expect('to', 1013);
        const to = this.expression();
        const step = this.accept('step') ? this.expression() : null;
        this.loops.push('for');
        const body = this.block(()=>this.is('next'), 1020);
        this.loops.pop();
        this.next();
        this.nextName();
        return { type: 'For', variable, from, to, step, body, pos };
    }

    /** The loop variable Next may repeat. */
    nextName(){
        if (this.isName())
        {
            this.next();
        }
    }

    /** @returns {Node} */
    doStatement(){
        const pos = this.next().pos;
        /** @type {{ until: boolean, test: Node } | null} */
        let pre = null;
        if (this.is('while') || this.is('until'))
        {
            const until = this.next().key === 'until';
            pre = { until, test: this.expression() };
        }
        this.endStatement();
        this.loops.push('do');
        const body = this.block(()=>this.is('loop'), 1019);
        this.loops.pop();
        this.next();
        /** @type {{ until: boolean, test: Node } | null} */
        let post = null;
        if (this.is('while') || this.is('until'))
        {
            if (pre !== null)
            {
                this.fail(1025);
            }
            const until = this.next().key === 'until';
            post = { until, test: this.expression() };
        }
        return { type: 'Do', pre, post, body, pos };
    }

    /** @returns {Node} */
    exitStatement(){
        const pos = this.next().pos;
        const what = this.token;
        if (what.kind !== 'kw')
        {
            this.fail(1039);
        }
        this.next();
        const kind = this.proc?.kind;
        switch (what.key)
        {
            case 'do':
                if (!this.loops.includes('do'))
                {
                    this.fail(1039, what);
                }
                return { type: 'Exit', what: 'do', pos };
            case 'for':
                if (!this.loops.includes('for'))
                {
                    this.fail(1039, what);
                }
                return { type: 'Exit', what: 'for', pos };
            case 'sub': case 'function': case 'property':
                if (kind === undefined || (what.key === 'property'
                    ? !['get', 'let', 'set'].includes(kind) : kind !== what.key))
                {
                    this.fail(1039, what);
                }
                return { type: 'Exit', what: 'proc', pos };
            default:
                return this.fail(1039, what);
        }
    }

    /** @returns {Node} */
    expression(){
        return this.binaryLevel(0);
    }

    /** @param {number} level @returns {Node} */
    binaryLevel(level){
        if (level >= LEVELS.length)
        {
            return this.notLevel();
        }
        let left = this.binaryLevel(level + 1);
        while (this.token.kind === 'kw' && LEVELS[level].includes(this.token.key))
        {
            const op = this.next();
            left = { type: 'Binary', op: op.key, left, right: this.binaryLevel(level + 1),
                pos: op.pos };
        }
        return left;
    }

    /** @returns {Node} */
    notLevel(){
        if (this.is('not'))
        {
            const op = this.next();
            return { type: 'Unary', op: 'not', operand: this.notLevel(), pos: op.pos };
        }
        return this.comparison();
    }

    /** @returns {Node} */
    comparison(){
        let left = this.concatenation();
        while ((this.token.kind === 'op' || this.token.kind === 'kw')
            && COMPARISONS.has(this.token.key))
        {
            const op = this.next();
            left = { type: 'Binary', op: op.key, left, right: this.concatenation(), pos: op.pos };
        }
        return left;
    }

    /** @returns {Node} */
    concatenation(){
        let left = this.additive();
        while (this.is('&'))
        {
            const op = this.next();
            left = { type: 'Binary', op: '&', left, right: this.additive(), pos: op.pos };
        }
        return left;
    }

    /** @returns {Node} */
    additive(){
        let left = this.modulus();
        while (this.is('+') || this.is('-'))
        {
            const op = this.next();
            left = { type: 'Binary', op: op.key, left, right: this.modulus(), pos: op.pos };
        }
        return left;
    }

    /** @returns {Node} */
    modulus(){
        let left = this.integerDivision();
        while (this.is('mod'))
        {
            const op = this.next();
            left = { type: 'Binary', op: 'mod', left, right: this.integerDivision(),
                pos: op.pos };
        }
        return left;
    }

    /** @returns {Node} */
    integerDivision(){
        let left = this.multiplicative();
        while (this.is('\\'))
        {
            const op = this.next();
            left = { type: 'Binary', op: '\\', left, right: this.multiplicative(), pos: op.pos };
        }
        return left;
    }

    /** @returns {Node} */
    multiplicative(){
        let left = this.unary();
        while (this.is('*') || this.is('/'))
        {
            const op = this.next();
            left = { type: 'Binary', op: op.key, left, right: this.unary(), pos: op.pos };
        }
        return left;
    }

    /** @returns {Node} */
    unary(){
        if (this.is('-') || this.is('+'))
        {
            const op = this.next();
            const operand = this.unary();
            if (op.key === '+')
            {
                return { type: 'Unary', op: '+', operand, pos: op.pos };
            }
            return { type: 'Unary', op: '-', operand, pos: op.pos };
        }
        return this.exponent();
    }

    /** @returns {Node} */
    exponent(){
        let left = this.postfix(this.primary());
        while (this.is('^'))
        {
            const op = this.next();
            left = { type: 'Binary', op: '^', left, right: this.exponentOperand(), pos: op.pos };
        }
        return left;
    }

    /** @returns {Node} what ^ raises to: a sign may come first, as in 2 ^ -1 */
    exponentOperand(){
        if (this.is('-') || this.is('+'))
        {
            const op = this.next();
            return { type: 'Unary', op: op.key, operand: this.exponentOperand(), pos: op.pos };
        }
        return this.postfix(this.primary());
    }

    /** @returns {Node} */
    primary(){
        const token = this.token;
        const pos = token.pos;
        switch (token.kind)
        {
            case 'num': {
                this.next();
                const { value, type } = token.value;
                return { type: 'Lit', value: type === 'integer' ? integer(value)
                    : type === 'long' ? long(value) : value, pos };
            }
            case 'str':
                this.next();
                return { type: 'Lit', value: token.value, pos };
            case 'date': {
                this.next();
                const day = dateFromText(token.value, 0, this.thisYear);
                if (day === null)
                {
                    this.fail(1002, token);
                }
                return { type: 'Lit', value: date(day), pos };
            }
            case 'kw':
                switch (token.key)
                {
                    case 'true': this.next(); return { type: 'Lit', value: true, pos };
                    case 'false': this.next(); return { type: 'Lit', value: false, pos };
                    case 'empty': this.next(); return { type: 'Lit', value: undefined, pos };
                    case 'null': this.next(); return { type: 'Lit', value: null, pos };
                    case 'nothing': this.next(); return { type: 'Lit', value: NOTHING, pos };
                    case 'me': return this.primaryName();
                    case 'new': {
                        this.next();
                        const { name, key } = this.name();
                        return { type: 'New', name, key, pos };
                    }
                    default:
                        if (NAME_KEYWORDS.has(token.key))
                        {
                            return this.primaryName();
                        }
                        return this.fail(1023);
                }
            case 'id':
                return this.primaryName();
            case 'op':
                if (token.key === '(')
                {
                    this.next();
                    const expr = this.expression();
                    this.expect(')', 1006);
                    return { type: 'Paren', expr, pos };
                }
                if (token.key === '.')
                {
                    return this.primaryName();
                }
                return this.fail(1023);
            default:
                return this.fail(1023);
        }
    }
}

/**
 * Parses a script's text.
 *
 * @param {string} text @param {ParseOptions} [options] @returns {Program}
 */
export function parseProgram(text, options = {}){
    return new Parser(text, options).program();
}

/**
 * Parses a text that is one expression: Eval's, or an active script's
 * SCRIPTTEXT_ISEXPRESSION.
 *
 * @param {string} text @param {ParseOptions} [options] @returns {Program}
 */
export function parseExpressionProgram(text, options = {}){
    const parser = new Parser(text, options);
    parser.skipSeparators();
    const expr = parser.expression();
    parser.skipSeparators();
    if (parser.token.kind !== 'eof')
    {
        parser.fail(1025);
    }
    return { body: [{ type: 'Value', expr, pos: expr.pos }], procs: [], classes: [], dims: [],
        consts: [], explicit: false, expression: true, source: parser.source };
}

export { MESSAGES };
