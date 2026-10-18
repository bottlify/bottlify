/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Fails when cork's emitter writes a region's budget other than as a count:
 * the budget is what the run has left, and what it took off since `origin` is
 * what it retired, so every write either takes instructions off it (a charge),
 * takes back what a callee left of it (`CallStack.BUDGET`), or ends it in
 * `endBudget`, which moves the origin by what it gives up.
 *
 * A trap that ended the turn set the budget to zero and nothing else: the exit
 * charged the rest of the quantum as retired, and a thread whose calls ended
 * its turn on another executor's account was counted a third more instructions
 * than it ran.
 *
 *     node tools/check-budget-writes.mjs
 */

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const EMIT = fileURLToPath(new URL('../modules/cork/src/emit/', import.meta.url));
const WRITE = /\.local(?:Set|Tee)\(Local\.budget\)/g;

/**
 * The text of the method `name` in `text`, from its name to its closing brace.
 *
 * @param {string} text @param {string} name
 */
function methodText(text, name){
    const start = text.search(new RegExp(`\\n {4}${name}\\(\\)\\{`));
    const end = text.indexOf('\n    }\n', start);
    return start < 0 || end < 0 ? null : { start, end, text: text.slice(start, end) };
}

/** @type {string[]} */
const problems = [];
let writes = 0;
for (const name of readdirSync(EMIT).filter(file=>file.endsWith('.js')
    && !file.endsWith('.test.js') && !file.endsWith('.itest.js')).sort())
{
    // A checkout with CRLF line ends reads the same as one with LF.
    const text = readFileSync(`${EMIT}${name}`, 'utf8').replace(/\r\n/g, '\n');
    const ending = methodText(text, 'endBudget');
    for (const match of text.matchAll(WRITE))
    {
        writes++;
        const at = /** @type {number} */ (match.index);
        // The statement the write ends: from the last statement's end before it, a
        // `;` or a line that opens or closes a block -- not an object literal's brace.
        const from = Math.max(text.lastIndexOf(';', at), text.lastIndexOf('{\n', at),
            text.lastIndexOf('}\n', at)) + 1;
        const statement = text.slice(from, at + match[0].length).replace(/\s+/g, '');
        const line = text.slice(0, at).split('\n').length;
        const charge = statement.includes('localGet(Local.budget)')
            && statement.endsWith(`.op(I32.sub)${match[0]}`);
        const returned = statement.includes('CallStack.BUDGET');
        const ended = ending !== null && at > ending.start && at < ending.end
            && /store\('i32',\{offset:\/\*\*@type\{number\}\*\/\(this\.layout\.origin\)\}\)/
                .test(ending.text.replace(/\s+/g, ''))
            && ending.text.includes('localSet(Local.origin)');
        if (!charge && !returned && !ended)
        {
            problems.push(`${name}:${line}: the budget written other than as a count:`
                + ` ${statement.slice(0, 120)}`);
        }
    }
}
if (writes < 5)
{
    problems.push(`found ${writes} writes of the budget:`
        + ' the shapes this script reads have changed');
}
if (problems.length > 0)
{
    console.error(problems.join('\n'));
    process.exit(1);
}
console.log(`budget writes: ${writes}, each a count`);
