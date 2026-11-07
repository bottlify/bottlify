/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The XPath selectNodes and selectSingleNode evaluate, as far as programs
 * query their own configuration with it: location paths, absolute or
 * relative, with `//`, `.` and `..`; the child, descendant, self, parent,
 * ancestor, sibling and attribute axes (`@`); name tests, `*`, `text()`,
 * `node()` and `comment()`; predicates of comparisons (`=`, `!=`, `<`, `>`),
 * `and`, `or`, positions, unions (`|`), and the functions position, last,
 * count, not, true, false, string, number, name, local-name, contains,
 * starts-with and normalize-space. Values compare as XPath 1.0 has them: a
 * node set against a string by each node's string value. MSXML 3's default
 * selection language, XSL Patterns, reads these paths the same way.
 * Anything else is an error, which the DOM reports as E_FAIL.
 */

import { NODE, textOf } from './xml.js';

/** @typedef {import('./xml.js').XmlNode} XmlNode */
/** @typedef {XmlNode[] | string | number | boolean} XValue */
/** @typedef {{ node: XmlNode, position: number, size: number }} Context */
/** @typedef {(context: Context) => XValue} Evaluator */

export class XPathError extends Error {}

const TOKEN = /\s*(\/\/|\.\.|::|!=|<=|>=|[/.@*()[\],|=<>]|"[^"]*"|'[^']*'|\d+(?:\.\d+)?|[A-Za-z_][\w.-]*(?::[A-Za-z_*][\w.-]*)?)/y;

/** @param {string} source */
function tokenize(source){
    /** @type {string[]} */
    const tokens = [];
    TOKEN.lastIndex = 0;
    while (TOKEN.lastIndex < source.length)
    {
        if (/^\s*$/.test(source.slice(TOKEN.lastIndex)))
        {
            break;
        }
        const at = TOKEN.lastIndex;
        const match = TOKEN.exec(source);
        if (!match)
        {
            throw new XPathError(`Unexpected character at ${at} in "${source}"`);
        }
        tokens.push(match[1]);
    }
    return tokens;
}

/** The string value of a node. @param {XmlNode} node */
const stringOf = node=>textOf(node, true);

/** @param {XValue} value */
const toStringValue = value=>(Array.isArray(value) ? value.length ? stringOf(value[0]) : ''
    : typeof value === 'boolean' ? String(value)
        : typeof value === 'number' ? (Number.isInteger(value) ? String(value) : String(value))
            : value);
/** @param {XValue} value */
const toNumber = value=>(typeof value === 'number' ? value : typeof value === 'boolean'
    ? Number(value) : Number(toStringValue(value).trim() || NaN));
/** @param {XValue} value */
const toBoolean = value=>(Array.isArray(value) ? value.length > 0 : typeof value === 'number'
    ? value !== 0 && !Number.isNaN(value) : typeof value === 'string' ? value.length > 0 : value);

/** @param {XmlNode} node */
const rootOf = node=>{
    let at = node.type === NODE.ATTRIBUTE ? /** @type {XmlNode} */ (node.parent) : node;
    while (at.parent)
    {
        at = at.parent;
    }
    return at;
};

/** Every node below `node`, in document order. @param {XmlNode} node @param {XmlNode[]} into */
const descendants = (node, into)=>{
    for (const child of node.children)
    {
        into.push(child);
        descendants(child, into);
    }
    return into;
};

/** Nodes in document order, each once. @param {XmlNode[]} nodes */
const inOrder = nodes=>{
    if (nodes.length < 2)
    {
        return nodes;
    }
    /** @type {Map<XmlNode, number>} */
    const index = new Map();
    let next = 0;
    /** @param {XmlNode} node */
    const number = node=>{
        index.set(node, next++);
        node.attributes.forEach(attribute=>index.set(attribute, next++));
        node.children.forEach(number);
    };
    number(rootOf(nodes[0]));
    return [...new Set(nodes)].sort((one, two)=>(index.get(one) ?? 0) - (index.get(two) ?? 0));
};

/** @param {string} axis @param {XmlNode} node @returns {XmlNode[]} */
function axisOf(axis, node){
    switch (axis)
    {
        case 'child':
            return node.children;
        case 'descendant':
            return descendants(node, []);
        case 'descendant-or-self':
            return descendants(node, [node]);
        case 'self':
            return [node];
        case 'parent':
            return node.parent ? [node.parent] : [];
        case 'ancestor':
        case 'ancestor-or-self': {
            const out = axis === 'ancestor-or-self' ? [node] : [];
            for (let at = node.parent; at; at = at.parent)
            {
                out.push(at);
            }
            return out;
        }
        case 'attribute':
            return node.attributes;
        case 'following-sibling':
        case 'preceding-sibling': {
            const siblings = node.parent && node.type !== NODE.ATTRIBUTE ? node.parent.children
                : [];
            const at = siblings.indexOf(node);
            return axis === 'following-sibling' ? siblings.slice(at + 1)
                : siblings.slice(0, Math.max(0, at)).reverse();
        }
        default:
            throw new XPathError(`The axis ${axis} is not supported`);
    }
}

/**
 * @param {string} test  a name, '*', or 'text()' and the like
 * @param {string} axis
 * @returns {(node: XmlNode) => boolean}
 */
function nodeTest(test, axis){
    const principal = axis === 'attribute' ? NODE.ATTRIBUTE : NODE.ELEMENT;
    switch (test)
    {
        case 'node()':
            return ()=>true;
        case 'text()':
            return node=>node.type === NODE.TEXT || node.type === NODE.CDATA;
        case 'comment()':
            return node=>node.type === NODE.COMMENT;
        case 'processing-instruction()':
            return node=>node.type === NODE.PROCESSING_INSTRUCTION;
        case '*':
            return node=>node.type === principal;
        default:
            if (test.endsWith(':*'))
            {
                const prefix = test.slice(0, -1);
                return node=>node.type === principal && node.name.startsWith(prefix);
            }
            return node=>node.type === principal && node.name === test;
    }
}

/**
 * Compiles an expression.
 *
 * @param {string} source
 * @returns {Evaluator}
 */
export function compileXPath(source){
    const tokens = tokenize(source);
    let at = 0;
    const peek = (offset = 0)=>tokens[at + offset];
    /** @param {string} token */
    const take = token=>{
        if (tokens[at] !== token)
        {
            throw new XPathError(`Expected '${token}' in "${source}"`);
        }
        at++;
    };

    /** @returns {Evaluator} */
    const expression = ()=>binary(['or'], ()=>binary(['and'], ()=>binary(['=', '!='],
        ()=>binary(['<', '>', '<=', '>='], union))));

    /**
     * @param {string[]} operators @param {() => Evaluator} operand
     * @returns {Evaluator}
     */
    const binary = (operators, operand)=>{
        let left = operand();
        while (operators.includes(peek()))
        {
            const operator = /** @type {string} */ (tokens[at++]);
            const first = left;
            const second = operand();
            left = context=>combine(operator, first(context), second(context));
        }
        return left;
    };

    /** @returns {Evaluator} */
    const union = ()=>{
        let left = primary();
        while (peek() === '|')
        {
            at++;
            const first = left;
            const second = primary();
            left = context=>inOrder([.../** @type {XmlNode[]} */ (first(context)),
                .../** @type {XmlNode[]} */ (second(context))]);
        }
        return left;
    };

    /** @returns {Evaluator} */
    const primary = ()=>{
        const token = peek();
        if (token === undefined)
        {
            throw new XPathError(`Unexpected end of "${source}"`);
        }
        if (token[0] === '"' || token[0] === '\'')
        {
            at++;
            const text = token.slice(1, -1);
            return ()=>text;
        }
        if (/^\d/.test(token))
        {
            at++;
            const value = Number(token);
            return ()=>value;
        }
        if (token === '(')
        {
            at++;
            const inner = expression();
            take(')');
            return inner;
        }
        if (/^[A-Za-z_]/.test(token) && peek(1) === '(' && !['text', 'node', 'comment',
            'processing-instruction'].includes(token))
        {
            return call();
        }
        return path();
    };

    /** @returns {Evaluator} */
    const call = ()=>{
        const name = /** @type {string} */ (tokens[at++]);
        take('(');
        /** @type {Evaluator[]} */
        const args = [];
        while (peek() !== ')')
        {
            args.push(expression());
            if (peek() === ',')
            {
                at++;
            }
        }
        take(')');
        /** @param {Context} context @param {number} i */
        const arg = (context, i)=>(args[i] ? args[i](context) : [context.node]);
        switch (name)
        {
            case 'position': return context=>context.position;
            case 'last': return context=>context.size;
            case 'count': return context=>/** @type {XmlNode[]} */ (arg(context, 0)).length;
            case 'not': return context=>!toBoolean(arg(context, 0));
            case 'true': return ()=>true;
            case 'false': return ()=>false;
            case 'string': return context=>toStringValue(arg(context, 0));
            case 'number': return context=>toNumber(arg(context, 0));
            case 'name':
            case 'local-name':
                return context=>{
                    const nodes = /** @type {XmlNode[]} */ (arg(context, 0));
                    const full = nodes.length ? nodes[0].name : '';
                    return name === 'name' ? full : full.slice(full.indexOf(':') + 1);
                };
            case 'contains':
                return context=>toStringValue(arg(context, 0))
                    .includes(toStringValue(arg(context, 1)));
            case 'starts-with':
                return context=>toStringValue(arg(context, 0))
                    .startsWith(toStringValue(arg(context, 1)));
            case 'normalize-space':
                return context=>toStringValue(arg(context, 0)).trim().replace(/\s+/g, ' ');
            default:
                throw new XPathError(`The function ${name}() is not supported`);
        }
    };

    /** @returns {Evaluator} */
    const path = ()=>{
        /** @type {((nodes: XmlNode[]) => XmlNode[])[]} */
        const steps = [];
        let absolute = false;
        if (peek() === '/' || peek() === '//')
        {
            absolute = true;
            const token = tokens[at++];
            if (token === '//')
            {
                steps.push(nodes=>inOrder(nodes.flatMap(node=>axisOf('descendant-or-self', node))));
                steps.push(step());
            }
            else if (peek() !== undefined && !['|', ']', ')', '=', '!=', 'and', 'or', ',']
                .includes(/** @type {string} */ (peek())))
            {
                steps.push(step());
            }
        }
        else
        {
            steps.push(step());
        }
        while (peek() === '/' || peek() === '//')
        {
            const token = tokens[at++];
            if (token === '//')
            {
                steps.push(nodes=>inOrder(nodes.flatMap(node=>axisOf('descendant-or-self', node))));
            }
            steps.push(step());
        }
        return context=>{
            let nodes = absolute ? [rootOf(context.node)] : [context.node];
            for (const one of steps)
            {
                nodes = one(nodes);
            }
            return nodes;
        };
    };

    /** @returns {(nodes: XmlNode[]) => XmlNode[]} */
    const step = ()=>{
        if (peek() === '.')
        {
            at++;
            return nodes=>nodes;
        }
        if (peek() === '..')
        {
            at++;
            return nodes=>inOrder(nodes.flatMap(node=>axisOf('parent', node)));
        }
        let axis = 'child';
        if (peek() === '@')
        {
            at++;
            axis = 'attribute';
        }
        else if (peek(1) === '::')
        {
            axis = /** @type {string} */ (tokens[at]);
            at += 2;
        }
        let test = tokens[at++];
        if (test === undefined)
        {
            throw new XPathError(`A step is missing in "${source}"`);
        }
        if (peek() === '(' && peek(1) === ')')
        {
            at += 2;
            test = `${test}()`;
        }
        const matches = nodeTest(test, axis);
        /** @type {Evaluator[]} */
        const predicates = [];
        while (peek() === '[')
        {
            at++;
            predicates.push(expression());
            take(']');
        }
        const reverse = axis.startsWith('ancestor') || axis === 'preceding-sibling';
        return nodes=>{
            /** @type {XmlNode[]} */
            const out = [];
            for (const node of nodes)
            {
                let found = axisOf(axis, node).filter(matches);
                for (const predicate of predicates)
                {
                    found = found.filter((candidate, index)=>{
                        const value = predicate({ node: candidate, position: index + 1,
                            size: found.length });
                        return typeof value === 'number' ? value === index + 1 : toBoolean(value);
                    });
                }
                out.push(...(reverse ? found.reverse() : found));
            }
            return inOrder(out);
        };
    };

    const compiled = expression();
    if (at !== tokens.length)
    {
        throw new XPathError(`Unexpected '${tokens[at]}' in "${source}"`);
    }
    return compiled;
}

/**
 * A comparison or a logical operator, as XPath 1.0 applies it.
 *
 * @param {string} operator @param {XValue} left @param {XValue} right
 * @returns {boolean}
 */
function combine(operator, left, right){
    if (operator === 'or')
    {
        return toBoolean(left) || toBoolean(right);
    }
    if (operator === 'and')
    {
        return toBoolean(left) && toBoolean(right);
    }
    /** @param {XValue} value @returns {XValue[]} */
    const each = value=>(Array.isArray(value) ? value.map(stringOf) : [value]);
    for (const one of each(left))
    {
        for (const two of each(right))
        {
            if (compareOne(operator, one, two))
            {
                return true;
            }
        }
    }
    return false;
}

/** @param {string} operator @param {XValue} left @param {XValue} right */
function compareOne(operator, left, right){
    if (operator === '=' || operator === '!=')
    {
        const equal = typeof left === 'number' || typeof right === 'number'
            ? toNumber(left) === toNumber(right)
            : typeof left === 'boolean' || typeof right === 'boolean'
                ? toBoolean(left) === toBoolean(right)
                : toStringValue(left) === toStringValue(right);
        return operator === '=' ? equal : !equal;
    }
    const a = toNumber(left);
    const b = toNumber(right);
    return operator === '<' ? a < b : operator === '>' ? a > b : operator === '<=' ? a <= b
        : a >= b;
}

/**
 * The nodes an expression selects from `node`, in document order.
 *
 * @param {XmlNode} node @param {string} source
 * @returns {XmlNode[]}
 */
export function selectNodes(node, source){
    const value = compileXPath(source)({ node, position: 1, size: 1 });
    if (!Array.isArray(value))
    {
        throw new XPathError(`"${source}" is not a node set`);
    }
    return value;
}
