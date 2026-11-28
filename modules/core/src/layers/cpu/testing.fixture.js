/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The run's account as a test makes it: the run's own (`createRunAccount`), in
 * memory, of no limit unless the test names the machine's memory, so a host a
 * test builds takes and gives back as every host of a run does.
 */

import { BLOCKS, createRunAccount } from '../cache/account.js';

/** @param {{ machineMemory?: number, cacheBytes?: number, blocksBytes?: number }} [sizes] */
export const testAccount = (sizes = {})=>createRunAccount(sizes);

/**
 * What an executor a test opens asks of the account across its link
 * (`createRemoteExecutor`'s `account`): no cache to make room, and a refusal
 * the test did not expect fails it.
 */
export const testAccountCalls = Object.freeze({
    room: null,
    refused: (/** @type {any} */ refusal)=>{
        throw new Error(`cpu: the test's account refused ${JSON.stringify(refusal)}`);
    },
});

/**
 * A bundle's block cache's place in a test's account (`createBlockCache`'s
 * `account` and `kind`): its blocks at most `bytes`.
 *
 * @param {number} [bytes]
 */
export const testBlocks = bytes=>({ account: testAccount({ blocksBytes: bytes }), kind: BLOCKS });
