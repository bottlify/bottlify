/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as cork from '@bottlify/cork';
import { ENGINE_CONTRACT, engineContractProblem } from './engine.js';

test('the cork core depends on implements the contract this core needs', ()=>{
    assert.equal(cork.contract, ENGINE_CONTRACT);
    assert.equal(engineContractProblem(cork, 'cork'), null);
});

test('an engine of another contract, or of none, is refused with a reason', ()=>{
    assert.match(engineContractProblem({ contract: ENGINE_CONTRACT + 1 }, '/x.js') ?? '',
        /implements contract 2, this core needs 1/);
    assert.match(engineContractProblem({}, '/x.js') ?? '', /implements contract none/);
});
