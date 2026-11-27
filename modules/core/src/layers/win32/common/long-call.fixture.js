/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A call as the bridge makes it from a 64-bit caller, for a test of a table's
 * own specs: each argument's low dword with its high half beside it in
 * `args.high`, the declared addresses joined again (`wholeAddresses`), and the
 * answer as RAX takes it (`longAnswer`). A handler that is not declared to take
 * an address whole, or not declared to answer one, gives past 4 GiB what the
 * bridge would give the program: a cut.
 */

import { longAnswer, wholeAddresses, zeroExtendsOf } from '../../bridge/internal/dispatch.js';
import { declareAddresses } from './pointers.js';
import { POINTER_ARGUMENTS } from './pointer-arguments.js';

/**
 * The table's functions declared as the win32 layer declares a library's.
 *
 * @template {Record<string, any>} T @param {T} table @returns {T}
 */
export const declaredTable = table=>{
    declareAddresses({ library: table }, POINTER_ARGUMENTS);
    return table;
};

/**
 * @param {any} spec @param {number[]} values  one per dword of the 32-bit signature
 * @returns {Promise<bigint>} RAX
 */
export async function longCall(spec, values){
    const args = values.map(value=>value % 2 ** 32 | 0);
    const high = values.map(value=>Math.floor(value / 2 ** 32) >>> 0);
    wholeAddresses(spec.addresses ?? null, args, high);
    const result = await spec.handler(Object.assign(args, { high }));
    return longAnswer(result ?? 0, null, zeroExtendsOf(spec));
}
