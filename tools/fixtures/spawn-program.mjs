/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A parent process built by `make-pe.mjs`, for the tests that start a child
 * and look at what the child did: it starts C:\\a.exe, waits for it and exits
 * with its exit code.
 *
 * Dev tooling, like `make-pe.mjs`: never imported by a package.
 */

import { buildExe } from './make-pe.mjs';

/** @param {number} value */
const u32 = value=>[0, 8, 16, 24].map(at=>(value >>> at) & 0xff);

/** @param {string} [command]  the child it starts */
export function waitingParent(command = 'C:\\a.exe'){
    return buildExe({
        imports: { 'KERNEL32.dll': ['CreateProcessA', 'WaitForSingleObject',
            'GetExitCodeProcess', 'ExitProcess'] },
        data: {
            command: [...Buffer.from(command), 0],
            startup: [...u32(68), ...new Array(64).fill(0)],
            info: new Array(16).fill(0),
            code: u32(0),
        },
        codeSize: 0x80,
        code: ({ iat, at })=>[
            0x68, ...u32(at('info')), 0x68, ...u32(at('startup')),
            0x6a, 0, 0x6a, 0, 0x6a, 0, 0x6a, 0, 0x6a, 0, 0x6a, 0,
            0x68, ...u32(at('command')), 0x6a, 0,
            0xff, 0x15, ...u32(iat('CreateProcessA')),
            0x6a, 0xff, 0xff, 0x35, ...u32(at('info')),
            0xff, 0x15, ...u32(iat('WaitForSingleObject')),
            0x68, ...u32(at('code')), 0xff, 0x35, ...u32(at('info')),
            0xff, 0x15, ...u32(iat('GetExitCodeProcess')),
            0xff, 0x35, ...u32(at('code')),
            0xff, 0x15, ...u32(iat('ExitProcess')),
        ],
    });
}
