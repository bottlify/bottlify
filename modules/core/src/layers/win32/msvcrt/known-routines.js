/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { COMPILED } from './inguest.x86.js';

/**
 * The engine's own C runtime routines a translator may form as the operation
 * they do, as it forms Microsoft's copies of them (cork's `helpersAlso`): a
 * program that imports msvcrt's or MSVCR80's `memcpy` calls this code, written
 * where the export lies as compiled. Told by their whole bytes; a routine that
 * hands a case to the host has its trap's address written into it as placed,
 * so none of those is here.
 *
 * @type {readonly { name: string, does: string, code: number[] }[]}
 */
export const KNOWN_ROUTINES = Object.freeze([
    ['memmove', 'memmove'], ['memset', 'memset'], ['strlen', 'strlen'], ['strcmp', 'strcmp'],
    ['memcmp', 'memcmp'], ['strchr', 'strchr'],
].map(([name, does])=>({ name, does,
    compiled: /** @type {{ code: Uint8Array, host?: number }} */ (
        COMPILED[/** @type {keyof typeof COMPILED} */ (name)]) }))
    .filter(({ compiled })=>compiled.host === undefined)
    .map(({ name, does, compiled })=>Object.freeze({ name: `msvcrt ${name}`, does,
        code: [...compiled.code] })));
