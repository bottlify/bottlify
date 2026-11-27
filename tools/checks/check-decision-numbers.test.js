/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { citedDecisions, decisionHeadings } from './check-decision-numbers.mjs';

test('a number two headings carry is found with both lines; a revisit is not a number', ()=>{
    const text = [
        '**A1. First.** text', '', '**A2. Second.** text', '**A2 revisited: again.** text',
        '**A2. Taken again.** text',
    ].join('\n');
    const headings = decisionHeadings(text);
    assert.deepEqual(headings.get(1), [1]);
    assert.deepEqual(headings.get(2), [3, 5]);
});

test('a citation is found on one line and across a comment\'s break, with its line', ()=>{
    const text = [
        'refused as Windows does (decisions.md A79).',
        ' * a connection holds two buffers (decisions.md',
        ' * A251): a send waits',
        'see decisions A12 and roadmap/decisions.md, A13',
        'A14 alone is no citation',
    ].join('\n');
    assert.deepEqual(citedDecisions(text), [
        { number: 79, line: 1 }, { number: 251, line: 2 }, { number: 12, line: 4 },
        { number: 13, line: 4 },
    ]);
});
