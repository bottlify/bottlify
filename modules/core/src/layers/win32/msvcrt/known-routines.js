/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { COMPILED } from './inguest.x86.js';
import { COMPILED as COMPILED_LONG } from './inguest.x64.js';

/**
 * The engine's own C runtime routines a translator may form as the operation
 * they do, as it forms Microsoft's copies of them (cork's `helpersAlso`): a
 * program that imports msvcrt's or MSVCR80's `memcpy` calls this code, written
 * where the export lies as compiled. Told by their whole bytes; a routine that
 * hands a case to the host has its trap's address written into it as placed,
 * so none of those is here. The x86-64 builds' too, for a 64-bit program.
 *
 * @type {readonly { name: string, does: string, code: number[], bits?: 64 }[]}
 */
export const KNOWN_ROUTINES = Object.freeze([COMPILED, COMPILED_LONG].flatMap((compiled, long)=>[
    ['memmove', 'memmove'], ['memset', 'memset'], ['strlen', 'strlen'], ['strcmp', 'strcmp'],
    ['memcmp', 'memcmp'], ['strchr', 'strchr'],
].map(([name, does])=>({ name, does,
    record: /** @type {{ code: Uint8Array, host?: number } | undefined} */ (
        compiled[/** @type {keyof typeof compiled} */ (name)]) }))
    .filter(({ record })=>record !== undefined && record.host === undefined)
    .map(({ name, does, record })=>Object.freeze({ name: `msvcrt ${name}`, does,
        code: [.../** @type {{ code: Uint8Array }} */ (record).code],
        ...long === 1 ? { bits: /** @type {64} */ (64) } : {} }))));
