/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * JScript's grammar: ECMA-262 3rd edition, clauses 11 to 14, into a tree the
 * interpreter walks.
 *
 * Where JScript reads a script differently from the standard, it is read as
 * JScript reads it, because a script written for JScript was tested against
 * it:
 *
 * - A function declaration may stand anywhere a statement may, and is
 *   declared when its function starts, whether or not the code around it
 *   runs.
 * - A named function expression also declares its name in the function
 *   around it, as a separate function object made from the same text; the
 *   expression's own value does not see its name.
 * - A trailing comma in an array literal adds an element: `[1, 2,]` has
 *   three.
 * - A call may be assigned to (`Session.Property("X") = "Y"`): that is how a
 *   script sets a property of an automation object that takes arguments.
 *
 * Every node records where it starts (`s`), so that an error can say where
 * it happened, and every function its own text, which is what its
 * `toString` answers.
 */

import { Lexer, T } from './lexer.js';
import { SyntaxFailure } from './errors.js';

/** Node kinds. */
export const N = Object.freeze({
    Program: 1,
    Var: 2,
    Empty: 3,
    Expr: 4,
    If: 5,
    Do: 6,
    While: 7,
    For: 8,
    ForIn: 9,
    Continue: 10,
    Break: 11,
    Return: 12,
    With: 13,
    Switch: 14,
    Labeled: 15,
    Throw: 16,
    Try: 17,
    Block: 18,
    FuncDecl: 19,
    Lit: 30,
    Regex: 31,
    Ident: 32,
    This: 33,
    ArrayLit: 34,
    ObjectLit: 35,
    Func: 36,
    Member: 37,
    Index: 38,
    Call: 39,
    New: 40,
    Update: 41,
    Unary: 42,
    Binary: 43,
    Logical: 44,
    Cond: 45,
    Assign: 46,
    Seq: 47,
});

/**
 * A node of the tree: its kind (an {@link N} value), where it starts in its
 * text, and the kind's own fields, named where the parser makes it.
 *
 * @typedef {{ type: number, s: number, [field: string]: any }} Node
 */

/**
 * What a function, or the whole script, declares: its vars, its functions,
 * and whether its code names `arguments` or calls `eval`.
 *
 * @typedef {Object} FunctionNode
 * @property {number} type  N.Func or N.Program.
 * @property {number} s
 * @property {string | null} name
 * @property {string[]} params
 * @property {Node[]} body
 * @property {string[]} vars
 * @property {FunctionNode[]} funcs  Declared when the function starts, in order.
 * @property {boolean} usesArguments
 * @property {boolean} usesEval
 * @property {string} text  The function's own source: its `toString`.
 * @property {SourceText} source
 * @property {boolean} [expression]
 */

/**
 * One parsed text: where every node's offset points.
 *
 * @typedef {Object} SourceText
 * @property {string} text
 * @property {number} [line]  The line the text starts on in its document.
 * @property {number} [context]  The host's cookie for the text.
 */

const ASSIGN_OPS = new Set(['=', '+=', '-=', '*=', '/=', '%=', '<<=', '>>=', '>>>=', '&=', '|=',
    '^=']);

/** Binary operators, by how tightly they bind. */
const PRECEDENCE = new Map([
    ['||', 1], ['&&', 2], ['|', 3], ['^', 4], ['&', 5],
    ['==', 6], ['!=', 6], ['===', 6], ['!==', 6],
    ['<', 7], ['>', 7], ['<=', 7], ['>=', 7], ['instanceof', 7], ['in', 7],
    ['<<', 8], ['>>', 8], ['>>>', 8],
    ['+', 9], ['-', 9], ['*', 10], ['/', 10], ['%', 10],
]);

/** Words a statement or an expression cannot use as a name. */
const RESERVED = new Set([
    'break', 'case', 'catch', 'continue', 'default', 'delete', 'do', 'else', 'finally', 'for',
    'function', 'if', 'in', 'instanceof', 'new', 'return', 'switch', 'this', 'throw', 'try',
    'typeof', 'var', 'void', 'while', 'with', 'null', 'true', 'false',
    'class', 'const', 'enum', 'export', 'extends', 'import', 'super', 'debugger',
]);

/**
 * @typedef {Object} ParseOptions
 * @property {Map<string, number | boolean>} [conditional]
 * @property {{ ccOn: boolean }} [ccState]  Whether `@cc_on` was seen, carried between texts.
 * @property {number} [line]
 * @property {number} [context]
 */

class Parser
{
    /** @param {string} text @param {ParseOptions} options */
    constructor(text, options){
        /** @type {SourceText} */
        this.source = { text, line: options.line ?? 0, context: options.context ?? 0 };
        this.lexer = new Lexer(text, {
            conditional: options.conditional, ccOn: options.ccState?.ccOn,
        });
        this.ccState = options.ccState;
        /** @type {import('./lexer.js').Token} */
        this.tok = this.lexer.next();
        this.lastEnd = 0;
        /** @type {FunctionNode | null} */
        this.fn = null;
        this.inFunction = false;
        /** @type {{ name: string, loop: boolean }[]} */
        this.labels = [];
        this.loops = 0;
        this.breakables = 0;
    }

    /** @param {number} code @param {number} [at] @returns {never} */
    fail(code, at = this.tok.s){
        throw new SyntaxFailure(code, at);
    }

    next(){
        this.lastEnd = this.tok.e;
        this.tok = this.lexer.next();
    }

    /** @param {string} p @returns {boolean} */
    is(p){
        return this.tok.t === T.PUNCT && this.tok.v === p;
    }

    /** @param {string} word @returns {boolean} */
    isWord(word){
        return this.tok.t === T.NAME && this.tok.v === word && !this.tok.escaped;
    }

    /** @param {string} p @param {number} code */
    expect(p, code){
        if (!this.is(p))
        {
            this.fail(code);
        }
        this.next();
    }

    /** @returns {string} */
    identifier(){
        const tok = this.tok;
        if (tok.t !== T.NAME || (RESERVED.has(tok.v) && !tok.escaped))
        {
            this.fail(1010);
        }
        this.next();
        return tok.v;
    }

    /** A statement's end: a semicolon, or where one is inserted (7.9). */
    semicolon(){
        if (this.is(';'))
        {
            this.next();
            return;
        }
        if (this.is('}') || this.tok.t === T.EOF || this.tok.nl)
        {
            return;
        }
        this.fail(1004);
    }

    /** @returns {FunctionNode} */
    program(){
        /** @type {FunctionNode} */
        const program = {
            type: N.Program, s: 0, name: null, params: [], body: [], vars: [], funcs: [],
            usesArguments: false, usesEval: false, text: this.source.text, source: this.source,
        };
        this.fn = program;
        while (this.tok.t !== T.EOF)
        {
            program.body.push(this.statement());
        }
        if (this.ccState)
        {
            this.ccState.ccOn = this.lexer.ccOn;
        }
        return program;
    }

    /** @param {string} name */
    declareVar(name){
        const fn = /** @type {FunctionNode} */ (this.fn);
        if (!fn.vars.includes(name))
        {
            fn.vars.push(name);
        }
    }

    /**
     * @param {string[]} [labels]  The label set the statement is led by.
     * @returns {Node}
     */
    statement(labels = []){
        const tok = this.tok;
        const s = tok.s;
        if (tok.t === T.PUNCT)
        {
            if (tok.v === '{')
            {
                return this.block();
            }
            if (tok.v === ';')
            {
                this.next();
                return { type: N.Empty, s };
            }
        }
        if (tok.t === T.NAME && !tok.escaped)
        {
            switch (tok.v)
            {
                case 'var':
                {
                    this.next();
                    const node = { type: N.Var, s, decls: this.declarations(false) };
                    this.semicolon();
                    return node;
                }
                case 'if': return this.ifStatement();
                case 'do': return this.doStatement([]);
                case 'while': return this.whileStatement([]);
                case 'for': return this.forStatement([]);
                case 'continue': case 'break': return this.jump(tok.v === 'break');
                case 'return':
                {
                    if (!this.inFunction)
                    {
                        this.fail(1018);
                    }
                    this.next();
                    let argument = null;
                    if (!this.is(';') && !this.is('}') && this.tok.t !== T.EOF && !this.tok.nl)
                    {
                        argument = this.expression(false);
                    }
                    this.semicolon();
                    return { type: N.Return, s, argument };
                }
                case 'with':
                {
                    this.next();
                    this.expect('(', 1005);
                    const object = this.expression(false);
                    this.expect(')', 1006);
                    return { type: N.With, s, object, body: this.statement() };
                }
                case 'switch': return this.switchStatement(labels);
                case 'throw':
                {
                    this.next();
                    if (this.tok.nl)
                    {
                        this.fail(1035);
                    }
                    const argument = this.expression(false);
                    this.semicolon();
                    return { type: N.Throw, s, argument };
                }
                case 'try': return this.tryStatement();
                case 'function':
                {
                    const fn = this.functionNode(false);
                    /** @type {FunctionNode} */ (this.fn).funcs.push(fn);
                    return { type: N.FuncDecl, s, fn };
                }
                case 'debugger':
                    this.next();
                    this.semicolon();
                    return { type: N.Empty, s };
                default:
                    break;
            }
        }
        const expression = this.expression(false);
        if (expression.type === N.Ident && this.is(':'))
        {
            return this.labelled(expression.name, s, labels);
        }
        this.semicolon();
        return { type: N.Expr, s, expression };
    }

    /**
     * A labelled statement. A run of labels is one label set: a loop they
     * lead to answers `continue` with any of them, so each label is passed
     * on to the statement it labels.
     *
     * @param {string} name @param {number} s @param {string[]} outer
     *     The labels already read before this one.
     * @returns {Node}
     */
    labelled(name, s, outer){
        if (this.labels.some(label=>label.name === name))
        {
            this.fail(1025, s);
        }
        this.next();
        const names = [...outer, name];
        const isLoop = this.tok.t === T.NAME && !this.tok.escaped
            && ['do', 'while', 'for'].includes(this.tok.v);
        if (isLoop)
        {
            for (const label of this.labels)
            {
                if (outer.includes(label.name))
                {
                    label.loop = true;
                }
            }
        }
        this.labels.push({ name, loop: isLoop });
        try
        {
            const body = !isLoop ? this.statement(names)
                : this.tok.v === 'do' ? this.doStatement(names)
                    : this.tok.v === 'while' ? this.whileStatement(names)
                        : this.forStatement(names);
            return { type: N.Labeled, s, label: name, body };
        }
        finally
        {
            this.labels.pop();
        }
    }

    /** @param {boolean} isBreak @returns {Node} */
    jump(isBreak){
        const s = this.tok.s;
        this.next();
        /** @type {string | null} */
        let label = null;
        if (this.tok.t === T.NAME && !this.tok.nl && !RESERVED.has(this.tok.v))
        {
            label = this.tok.v;
            const known = this.labels.find(entry=>entry.name === label);
            if (!known || (!isBreak && !known.loop))
            {
                this.fail(1026);
            }
            this.next();
        }
        else if (isBreak ? this.breakables === 0 : this.loops === 0)
        {
            this.fail(isBreak ? 1019 : 1020, s);
        }
        this.semicolon();
        return { type: isBreak ? N.Break : N.Continue, s, label,
            completion: { k: isBreak ? 1 : 2, label } };
    }

    /** @returns {Node} */
    block(){
        const s = this.tok.s;
        this.next();
        const body = [];
        while (!this.is('}'))
        {
            if (this.tok.t === T.EOF)
            {
                this.fail(1009);
            }
            body.push(this.statement());
        }
        this.next();
        return { type: N.Block, s, body };
    }

    /** @param {boolean} noIn @returns {{ name: string, init: Node | null, s: number }[]} */
    declarations(noIn){
        const decls = [];
        for (;;)
        {
            const s = this.tok.s;
            const name = this.identifier();
            this.declareVar(name);
            let init = null;
            if (this.is('='))
            {
                this.next();
                init = this.assignment(noIn);
            }
            decls.push({ name, init, s });
            if (!this.is(','))
            {
                return decls;
            }
            this.next();
        }
    }

    /** @returns {Node} */
    ifStatement(){
        const s = this.tok.s;
        this.next();
        this.expect('(', 1005);
        const test = this.expression(false);
        this.expect(')', 1006);
        const consequent = this.statement();
        let alternate = null;
        if (this.isWord('else'))
        {
            this.next();
            alternate = this.statement();
        }
        return { type: N.If, s, test, consequent, alternate };
    }

    /** @returns {Node} */
    loopBody(){
        this.loops++;
        this.breakables++;
        try
        {
            return this.statement();
        }
        finally
        {
            this.loops--;
            this.breakables--;
        }
    }

    /** @param {string[]} labels @returns {Node} */
    doStatement(labels){
        const s = this.tok.s;
        this.next();
        const body = this.loopBody();
        if (!this.isWord('while'))
        {
            this.fail(1024);
        }
        this.next();
        this.expect('(', 1005);
        const test = this.expression(false);
        this.expect(')', 1006);
        // The semicolon after a do-while may be left out, on one line or not.
        if (this.is(';'))
        {
            this.next();
        }
        return { type: N.Do, s, body, test, labels };
    }

    /** @param {string[]} labels @returns {Node} */
    whileStatement(labels){
        const s = this.tok.s;
        this.next();
        this.expect('(', 1005);
        const test = this.expression(false);
        this.expect(')', 1006);
        return { type: N.While, s, test, body: this.loopBody(), labels };
    }

    /** @param {string[]} labels @returns {Node} */
    forStatement(labels){
        const s = this.tok.s;
        this.next();
        this.expect('(', 1005);
        /** @type {any} */
        let init = null;
        if (this.isWord('var'))
        {
            const vs = this.tok.s;
            this.next();
            const decls = this.declarations(true);
            if (decls.length === 1 && this.isWord('in'))
            {
                this.next();
                const object = this.expression(false);
                this.expect(')', 1006);
                return { type: N.ForIn, s, decl: decls[0], target: null, object,
                    body: this.loopBody(), labels };
            }
            init = { type: N.Var, s: vs, decls };
        }
        else if (!this.is(';'))
        {
            const expression = this.expression(true);
            if (this.isWord('in'))
            {
                this.next();
                const object = this.expression(false);
                this.expect(')', 1006);
                return { type: N.ForIn, s, decl: null, target: expression, object,
                    body: this.loopBody(), labels };
            }
            init = expression;
        }
        this.expect(';', 1004);
        const test = this.is(';') ? null : this.expression(false);
        this.expect(';', 1004);
        const update = this.is(')') ? null : this.expression(false);
        this.expect(')', 1006);
        return { type: N.For, s, init, test, update, body: this.loopBody(), labels };
    }

    /** @param {string[]} labels @returns {Node} */
    switchStatement(labels){
        const s = this.tok.s;
        this.next();
        this.expect('(', 1005);
        const discriminant = this.expression(false);
        this.expect(')', 1006);
        this.expect('{', 1008);
        const cases = [];
        let sawDefault = false;
        this.breakables++;
        try
        {
            while (!this.is('}'))
            {
                let test = null;
                if (this.isWord('case'))
                {
                    this.next();
                    test = this.expression(false);
                }
                else if (this.isWord('default'))
                {
                    if (sawDefault)
                    {
                        this.fail(1027);
                    }
                    sawDefault = true;
                    this.next();
                }
                else
                {
                    this.fail(1009);
                }
                this.expect(':', 1003);
                const body = [];
                while (!this.is('}') && !this.isWord('case') && !this.isWord('default'))
                {
                    if (this.tok.t === T.EOF)
                    {
                        this.fail(1009);
                    }
                    body.push(this.statement());
                }
                cases.push({ test, body });
            }
        }
        finally
        {
            this.breakables--;
        }
        this.next();
        return { type: N.Switch, s, discriminant, cases, labels };
    }

    /** @returns {Node} */
    tryStatement(){
        const s = this.tok.s;
        this.next();
        if (!this.is('{'))
        {
            this.fail(1008);
        }
        const block = this.block();
        let param = null;
        let handler = null;
        let finalizer = null;
        if (this.isWord('catch'))
        {
            this.next();
            this.expect('(', 1005);
            param = this.identifier();
            this.expect(')', 1006);
            if (!this.is('{'))
            {
                this.fail(1008);
            }
            handler = this.block();
        }
        if (this.isWord('finally'))
        {
            this.next();
            if (!this.is('{'))
            {
                this.fail(1008);
            }
            finalizer = this.block();
        }
        if (!handler && !finalizer)
        {
            this.fail(1033);
        }
        return { type: N.Try, s, block, param, handler, finalizer };
    }

    /**
     * A function, declared or as an expression, with everything its body
     * declares gathered into it.
     *
     * @param {boolean} expression @returns {FunctionNode}
     */
    functionNode(expression){
        const s = this.tok.s;
        this.next();
        let name = null;
        if (!expression || !this.is('('))
        {
            name = this.identifier();
        }
        this.expect('(', 1005);
        const params = [];
        while (!this.is(')'))
        {
            params.push(this.identifier());
            if (!this.is(','))
            {
                break;
            }
            this.next();
        }
        this.expect(')', 1006);
        if (!this.is('{'))
        {
            this.fail(1008);
        }
        this.next();
        /** @type {FunctionNode} */
        const fn = {
            type: N.Func, s, name, params, body: [], vars: [], funcs: [],
            usesArguments: false, usesEval: false, text: '', source: this.source, expression,
        };
        const saved = {
            fn: this.fn, inFunction: this.inFunction, labels: this.labels,
            loops: this.loops, breakables: this.breakables,
        };
        this.fn = fn;
        this.inFunction = true;
        this.labels = [];
        this.loops = 0;
        this.breakables = 0;
        try
        {
            while (!this.is('}'))
            {
                if (this.tok.t === T.EOF)
                {
                    this.fail(1009);
                }
                fn.body.push(this.statement());
            }
        }
        finally
        {
            Object.assign(this, saved);
        }
        fn.text = this.source.text.slice(s, this.tok.e);
        this.next();
        return fn;
    }

    /** @param {boolean} noIn @returns {Node} */
    expression(noIn){
        const s = this.tok.s;
        const first = this.assignment(noIn);
        if (!this.is(','))
        {
            return first;
        }
        const expressions = [first];
        while (this.is(','))
        {
            this.next();
            expressions.push(this.assignment(noIn));
        }
        return { type: N.Seq, s, expressions };
    }

    /** @param {boolean} noIn @returns {Node} */
    assignment(noIn){
        const s = this.tok.s;
        const target = this.conditional(noIn);
        if (this.tok.t === T.PUNCT && ASSIGN_OPS.has(this.tok.v))
        {
            const op = this.tok.v;
            this.next();
            const value = this.assignment(noIn);
            return { type: N.Assign, s, op: op === '=' ? '' : op.slice(0, -1), target, value };
        }
        return target;
    }

    /** @param {boolean} noIn @returns {Node} */
    conditional(noIn){
        const s = this.tok.s;
        const test = this.binary(0, noIn);
        if (!this.is('?'))
        {
            return test;
        }
        this.next();
        const consequent = this.assignment(false);
        this.expect(':', 1003);
        const alternate = this.assignment(noIn);
        return { type: N.Cond, s, test, consequent, alternate };
    }

    /** @param {number} loosest @param {boolean} noIn @returns {Node} */
    binary(loosest, noIn){
        const s = this.tok.s;
        let left = this.unary();
        for (;;)
        {
            const tok = this.tok;
            const op = tok.t === T.PUNCT || (tok.t === T.NAME && !tok.escaped) ? tok.v : null;
            const precedence = op === null ? undefined : PRECEDENCE.get(op);
            if (precedence === undefined || precedence <= loosest || (noIn && op === 'in'))
            {
                return left;
            }
            this.next();
            const right = this.binary(precedence, noIn);
            left = op === '&&' || op === '||'
                ? { type: N.Logical, s, op, left, right }
                : { type: N.Binary, s, op, left, right };
        }
    }

    /** @returns {Node} */
    unary(){
        const tok = this.tok;
        const s = tok.s;
        if (tok.t === T.PUNCT)
        {
            switch (tok.v)
            {
                case '++': case '--':
                    this.next();
                    return { type: N.Update, s, op: tok.v, prefix: true, target: this.unary() };
                case '+': case '-': case '~': case '!':
                    this.next();
                    return { type: N.Unary, s, op: tok.v, argument: this.unary() };
                default:
                    break;
            }
        }
        else if (tok.t === T.NAME && !tok.escaped
            && (tok.v === 'delete' || tok.v === 'void' || tok.v === 'typeof'))
        {
            this.next();
            return { type: N.Unary, s, op: tok.v, argument: this.unary() };
        }
        const expression = this.member(true);
        if ((this.is('++') || this.is('--')) && !this.tok.nl)
        {
            const op = this.tok.v;
            this.next();
            return { type: N.Update, s, op, prefix: false, target: expression };
        }
        return expression;
    }

    /** @returns {Node[]} */
    arguments(){
        this.next();
        const args = [];
        while (!this.is(')'))
        {
            args.push(this.assignment(false));
            if (!this.is(','))
            {
                break;
            }
            this.next();
        }
        this.expect(')', 1006);
        return args;
    }

    /**
     * A member expression, with calls where `calls` allows them: `new`
     * takes the member expression after it without its calls, and its own
     * argument list.
     *
     * @param {boolean} calls @returns {Node}
     */
    member(calls){
        const s = this.tok.s;
        /** @type {Node} */
        let expression;
        if (this.isWord('new'))
        {
            this.next();
            const callee = this.member(false);
            const args = this.is('(') ? this.arguments() : [];
            expression = { type: N.New, s, callee, args };
        }
        else
        {
            expression = this.primary();
        }
        for (;;)
        {
            if (this.is('.'))
            {
                this.next();
                if (this.tok.t !== T.NAME)
                {
                    this.fail(1010);
                }
                const name = this.tok.v;
                this.next();
                expression = { type: N.Member, s, object: expression, name };
            }
            else if (this.is('['))
            {
                this.next();
                const property = this.expression(false);
                this.expect(']', 1007);
                expression = { type: N.Index, s, object: expression, property };
            }
            else if (calls && this.is('('))
            {
                expression = { type: N.Call, s, callee: expression, args: this.arguments() };
            }
            else
            {
                return expression;
            }
        }
    }

    /** @returns {Node} */
    primary(){
        let tok = this.tok;
        const s = tok.s;
        switch (tok.t)
        {
            case T.NUMBER: case T.STRING:
                this.next();
                return { type: N.Lit, s, value: tok.v };
            case T.PUNCT:
                if (tok.v === '/' || tok.v === '/=')
                {
                    tok = this.lexer.regex(tok);
                    this.tok = tok;
                    this.next();
                    return { type: N.Regex, s, pattern: tok.v.pattern, flags: tok.v.flags };
                }
                if (tok.v === '(')
                {
                    this.next();
                    const expression = this.expression(false);
                    this.expect(')', 1006);
                    return expression;
                }
                if (tok.v === '[')
                {
                    return this.arrayLiteral();
                }
                if (tok.v === '{')
                {
                    return this.objectLiteral();
                }
                break;
            case T.NAME:
                if (!tok.escaped)
                {
                    switch (tok.v)
                    {
                        case 'this':
                            this.next();
                            return { type: N.This, s };
                        case 'null':
                            this.next();
                            return { type: N.Lit, s, value: null };
                        case 'true': case 'false':
                            this.next();
                            return { type: N.Lit, s, value: tok.v === 'true' };
                        case 'function':
                        {
                            const fn = this.functionNode(true);
                            if (fn.name !== null)
                            {
                                /** @type {FunctionNode} */ (this.fn).funcs.push(fn);
                            }
                            return { type: N.Func, s, fn };
                        }
                        default:
                            break;
                    }
                }
                {
                    const name = this.identifier();
                    const fn = /** @type {FunctionNode} */ (this.fn);
                    if (name === 'arguments')
                    {
                        fn.usesArguments = true;
                    }
                    else if (name === 'eval')
                    {
                        fn.usesEval = true;
                    }
                    return { type: N.Ident, s, name };
                }
            default:
                break;
        }
        if (tok.t === T.EOF)
        {
            this.fail(1002);
        }
        return this.fail(tok.t === T.PUNCT ? 1002 : 1010);
    }

    /** @returns {Node} */
    arrayLiteral(){
        const s = this.tok.s;
        this.next();
        /** @type {(Node | null)[]} */
        const elements = [];
        let afterComma = false;
        while (!this.is(']'))
        {
            if (this.is(','))
            {
                elements.push(null);
                this.next();
                afterComma = true;
                continue;
            }
            elements.push(this.assignment(false));
            afterComma = false;
            if (!this.is(','))
            {
                break;
            }
            this.next();
            afterComma = true;
        }
        if (afterComma)
        {
            // JScript counts the element after a trailing comma.
            elements.push(null);
        }
        this.expect(']', 1007);
        return { type: N.ArrayLit, s, elements };
    }

    /** @returns {Node} */
    objectLiteral(){
        const s = this.tok.s;
        this.next();
        const properties = [];
        while (!this.is('}'))
        {
            const tok = this.tok;
            let key;
            if (tok.t === T.NAME || tok.t === T.STRING)
            {
                key = String(tok.v);
            }
            else if (tok.t === T.NUMBER)
            {
                key = String(tok.v);
            }
            else
            {
                this.fail(1028);
            }
            this.next();
            this.expect(':', 1003);
            properties.push({ key, value: this.assignment(false) });
            if (!this.is(','))
            {
                break;
            }
            this.next();
        }
        this.expect('}', 1009);
        return { type: N.ObjectLit, s, properties };
    }
}

/**
 * Parses a whole script, or the text an `eval` is given.
 *
 * @param {string} text @param {ParseOptions} [options]
 * @returns {FunctionNode}
 * @throws {SyntaxFailure}
 */
export function parseProgram(text, options = {}){
    return new Parser(text, options).program();
}

/**
 * Parses what the Function constructor is given: the parameter list and the
 * body, each on its own, so that neither can close the other early.
 *
 * @param {string} params @param {string} body @param {ParseOptions} [options]
 * @returns {FunctionNode}
 * @throws {SyntaxFailure}
 */
export function parseFunctionParts(params, body, options = {}){
    const names = [];
    if (params.trim() !== '')
    {
        const parser = new Parser(params, options);
        for (;;)
        {
            names.push(parser.identifier());
            if (parser.tok.t === T.EOF)
            {
                break;
            }
            parser.expect(',', 1006);
        }
    }
    const text = `function anonymous(${params}) {\n${body}\n}`;
    const parser = new Parser(body, options);
    /** @type {FunctionNode} */
    const fn = {
        type: N.Func, s: 0, name: 'anonymous', params: names, body: [], vars: [], funcs: [],
        usesArguments: false, usesEval: false, text, source: parser.source, expression: true,
    };
    parser.fn = fn;
    parser.inFunction = true;
    while (parser.tok.t !== T.EOF)
    {
        fn.body.push(parser.statement());
    }
    return fn;
}

/**
 * Parses a text that is one expression, as a host asks for one with
 * SCRIPTTEXT_ISEXPRESSION: a program whose value is that expression's.
 *
 * @param {string} text @param {ParseOptions} [options]
 * @returns {FunctionNode}
 */
export function parseExpressionProgram(text, options = {}){
    const parser = new Parser(text, options);
    /** @type {FunctionNode} */
    const program = {
        type: N.Program, s: 0, name: null, params: [], body: [], vars: [], funcs: [],
        usesArguments: false, usesEval: false, text, source: parser.source,
    };
    parser.fn = program;
    if (parser.tok.t !== T.EOF)
    {
        const expression = parser.expression(false);
        if (parser.is(';'))
        {
            parser.next();
        }
        if (parser.tok.t !== T.EOF)
        {
            parser.fail(1004);
        }
        program.body.push({ type: N.Expr, s: 0, expression });
    }
    return program;
}
