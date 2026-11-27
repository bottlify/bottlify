/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Fails when a process's side of its link to the engine thread keeps what a
 * machine registers in one slot.
 *
 * A worker's link is shared: a child the run has no worker for runs beside its
 * parent in the parent's worker, on the same link, so whatever each machine
 * registers there - a listener for its waits' wakes, the endpoint that answers
 * for its windows - is one of several. Kept in one slot, the machine made last
 * took every word: ngen's wait on the event its worker process set was woken
 * in the worker process, and ngen timed out and started the next one, forever.
 *
 * In the files that build that side (`FILES`), an assignment to a slot of the
 * link's handlers (`handlers.name = `) or to a single listener
 * (`listener = `) passes only with `once per link` in a comment on its line
 * or right above it: said of a slot the worker's one app fills once, for every
 * machine on the link.
 *
 *     node tools/checks/check-link-slots.mjs
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from '../lib/common.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** The files that build a process's side of its link, from the repository's root. */
const FILES = ['modules/core/src/system-link.js', 'modules/core/src/com-link.js'];

/** A slot filled by plain assignment: the link's handlers, or a single listener. */
const SLOT = /(?:\bhandlers\.\w+|\bhandlers\[[^\]]+\]|\blistener)\s*(?:\?\?)?=(?!=)/;
const MARK = /once per link/i;

/**
 * The lines of `code` that fill a slot without saying it is filled once per link.
 *
 * @param {string} code
 * @returns {number[]} their numbers, from 1
 */
export function findSlots(code){
    const lines = code.split('\n');
    /** @type {number[]} */
    const found = [];
    lines.forEach((line, at)=>{
        if (!SLOT.test(line) || MARK.test(line))
        {
            return;
        }
        // The comment right above it, every line of it.
        for (let above = at - 1; above >= 0 && /^\s*\/\//.test(lines[above]); above--)
        {
            if (MARK.test(lines[above]))
            {
                return;
            }
        }
        found.push(at + 1);
    });
    return found;
}

if (isMain(import.meta.url))
{
    let failed = 0;
    for (const file of FILES)
    {
        for (const line of findSlots(readFileSync(join(ROOT, file), 'utf8')))
        {
            console.error(`${file}:${line}: a slot of the link one machine fills, where several`
                + ' share the link: keep one per machine, or say it is filled once per link');
            failed++;
        }
    }
    if (failed > 0)
    {
        process.exit(1);
    }
    console.log(`check-link-slots: ${FILES.length} files, every slot kept per machine`);
}
