/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The stand's promise: on the guest's own clock a workload's work is the same
 * run after run, and the record (`expected.json`) is what the translator does
 * now -- a change to what cork forms records it again
 * (`node tools/bench/stand.mjs --write`). The page in Chromium is held to the
 * same record by `npm run cdp:bench`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createCorkHost } from '../../modules/core/src/layers/cpu/internal/cork-host.js';
import * as engine from '../../modules/cork/src/index.js';
import { quantile, sameWork, workOf } from './stand.js';

const expected = JSON.parse(readFileSync(new URL('expected.json', import.meta.url), 'utf8'));
const arm = { createCorkHost, engine };

/** @param {string} name */
const workloadOf = name=>{
    const { bits } = expected.workloads[name];
    const image = readFileSync(new URL(`../../modules/cork/bench/micro/${bits === 64 ? 'images64'
        : 'images'}/${name}.bin`, import.meta.url));
    return { name, bits, image: new Uint8Array(image) };
};

for (const name of ['vcall-x87', 'calls512-scatter-x87', 'vcall-x64'])
{
    test(`${name}: the work is the record's, and the same again`, async()=>{
        const first = await workOf(arm, workloadOf(name), expected.warm);
        assert.deepEqual(first, expected.workloads[name].work,
            'cork forms otherwise than recorded: node tools/bench/stand.mjs --write');
        assert.ok(sameWork(first, await workOf(arm, workloadOf(name), expected.warm)));
    });
}

test('a different count is different work', ()=>{
    const work = expected.workloads['vcall-x87'].work;
    assert.ok(!sameWork(work, { ...work, mechanisms: { ...work.mechanisms, TRANSFER: 1 } }));
    assert.equal(quantile([3, 1, 2], 0.5), 2);
    assert.equal(quantile([1, 2, 3, 4], 0.25), 1.75);
});
