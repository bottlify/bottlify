/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Fails when two decisions in roadmap/decisions.md carry one number, or when
 * the tree cites a decision number nothing carries.
 *
 * Streams of work that each take "the next number" in their own branch meet
 * with two entries under it: on one night A249 and A250 were each taken twice
 * and renumbered by hand at the merge, and a comment citing the old number
 * would point at another decision. A revisit of a decision is a heading of its
 * own ("**A247 revisited: ...") and is not a second number.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT, isMain } from '../lib/common.mjs';

/**
 * The numbers the headings carry, each with the lines it heads.
 *
 * @param {string} text
 * @returns {Map<number, number[]>}
 */
export function decisionHeadings(text){
    /** @type {Map<number, number[]>} */
    const headings = new Map();
    text.split('\n').forEach((line, at)=>{
        const heading = /^\*\*A(\d+)\. /.exec(line);
        if (heading)
        {
            const number = Number(heading[1]);
            headings.set(number, [...headings.get(number) ?? [], at + 1]);
        }
    });
    return headings;
}

/**
 * The decision numbers a file cites as `decisions.md A<n>`, `decisions A<n>`
 * or `decisions.md, A<n>`, a line break and a comment's star between them included.
 *
 * @param {string} text
 * @returns {{ number: number, line: number }[]}
 */
export function citedDecisions(text){
    /** @type {{ number: number, line: number }[]} */
    const cited = [];
    // A citation may break across a comment's lines: "(decisions.md\n * A251)".
    for (const match of text.matchAll(/decisions(?:\.md)?[,:]?(?:[\s*/#]|-(?=\s))+(?:entry\s+)?A(\d+)\b/g))
    {
        cited.push({ number: Number(match[1]),
            line: text.slice(0, match.index).split('\n').length });
    }
    return cited;
}

if (isMain(import.meta.url))
{
    const decisions = readFileSync(join(REPO_ROOT, 'roadmap/decisions.md'), 'utf8');
    const headings = decisionHeadings(decisions);
    const found = [...headings].filter(([, lines])=>lines.length > 1)
        .map(([number, lines])=>`roadmap/decisions.md: A${number} heads lines ${lines.join(', ')}`);
    const files = execFileSync('git', ['ls-files', 'modules', 'tools', 'docs', 'roadmap'],
        { cwd: REPO_ROOT, encoding: 'utf8' }).split('\n')
        .filter(file=>/\.(m?js|md)$/.test(file) && file !== 'roadmap/decisions.md');
    for (const file of files)
    {
        for (const { number, line } of citedDecisions(readFileSync(join(REPO_ROOT, file), 'utf8')))
        {
            if (!headings.has(number))
            {
                found.push(`${file}:${line}: cites decisions A${number}, which no heading carries`);
            }
        }
    }
    if (found.length > 0)
    {
        console.error('decision numbers are not one each:');
        for (const line of found)
        {
            console.error(`  ${line}`);
        }
        process.exit(1);
    }
    console.log(`check-decision-numbers: ${headings.size} decisions, each number once,`
        + ` every citation in ${files.length} files carried`);
}
