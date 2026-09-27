/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The x87's model of a `@guestCode` module, for the tests: what its
 * functions compute under the precision control a program set, where
 * JavaScript computes in doubles whatever the control word says.
 *
 * The model is the module's own source, with every double's `+`, `-`, `*`
 * and `/` and every square root the compiler emitted as an instruction the
 * precision control rounds wrapped in `$.r(...)`, which rounds to 24 bits
 * when the control word in `$.control` says single -- as the x87 rounds,
 * and as the translator rounds its f64 x87 (`roundSingle`, in cork's
 * emitter: the significand rounded to nearest even in the double's own
 * bits, the double's exponent range kept). Under the double or extended
 * control words the model is the source itself: the engines keep an x87
 * register as a double, and the x87's instructions the compiler takes are
 * JavaScript's own there. Everything else a double meets -- a load, a store,
 * a conversion, a comparison, `fchs`, `fabs`, the transcendentals, `fprem`,
 * `fscale`, `frndint` -- the precision control does not touch.
 *
 * For the tests only: it imports the rewritten module from a data: URL.
 */

import * as espree from 'espree';
import { compileModule } from './compile.mjs';

/**
 * @typedef {Object} Model
 * @property {Record<string, unknown>} module  The rewritten module's exports.
 * @property {{ control: number }} $            The control word the model computes under.
 */

/**
 * @param {string} text  The module's source.
 * @param {{ file: string, url: string, values: Record<string, unknown> }} options
 *     url: the module's own, which its relative imports are resolved against
 * @returns {Promise<Model>}
 */
export async function loadModel(text, { file, url, values }){
    /** @type {Map<any, Set<string>>} */
    const arithmetic = new Map();
    compileModule(text, { file, values, arithmetic });
    /** @type {{ at: number, text: string, order: number }[]} */
    const edits = [];
    for (const [node, kinds] of arithmetic)
    {
        if (kinds.size > 1)
        {
            throw new Error(`${file}:${node.loc.start.line}:${node.loc.start.column + 1}: `
                + 'compiled both as a double\'s arithmetic and an integer\'s: the model cannot '
                + 'tell which to round');
        }
        if (kinds.has('rounds'))
        {
            // An outer node opens before and closes after an inner one that
            // starts or ends where it does.
            const length = node.range[1] - node.range[0];
            edits.push({ at: node.range[0], text: '$.r(', order: -length });
            edits.push({ at: node.range[1], text: ')', order: length });
        }
    }
    const ast = /** @type {any} */ (espree.parse(text, {
        ecmaVersion: 2022, sourceType: 'module', range: true,
    }));
    for (const statement of ast.body)
    {
        if (statement.type === 'ImportDeclaration' && statement.source.value.startsWith('.'))
        {
            edits.push({ at: statement.source.range[0], order: 0,
                text: `${JSON.stringify(new URL(statement.source.value, url).href)}/*` });
            edits.push({ at: statement.source.range[1], text: '*/', order: 0 });
        }
    }
    edits.sort((left, right)=>left.at - right.at || left.order - right.order);
    let out = '';
    let at = 0;
    for (const edit of edits)
    {
        out += text.slice(at, edit.at) + edit.text;
        at = edit.at;
    }
    out += text.slice(at);
    const module = await import(`data:text/javascript;base64,${Buffer.from(`${PRELUDE}\n${out}`)
        .toString('base64')}`);
    return { module, $: module.$ };
}

/** The model's rounding, prepended to the rewritten module. */
const PRELUDE = `
const $view = new DataView(new ArrayBuffer(8));
export const $ = {
    control: 0x27f,
    r(x){
        if ((this.control & 0x300) !== 0)
        {
            return x;
        }
        $view.setFloat64(0, x);
        const bits = $view.getBigUint64(0);
        if ((bits & 0x7ff0000000000000n) === 0x7ff0000000000000n)
        {
            return x;
        }
        $view.setBigUint64(0, (bits + (bits >> 29n & 1n) + 0x0fffffffn) & ~0x1fffffffn);
        return $view.getFloat64(0);
    },
};
`;
