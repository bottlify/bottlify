/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * cabinet.dll's exports by number. A setup engine links the cabinet library by
 * ordinal alone (WiX's Burn imports FDICreate, FDICopy and FDIDestroy as #20,
 * #22 and #23, with no names in its import table), so the numbers are the
 * system library's own, as its export table has them: the compression side
 * from 10, the decompression side from 20.
 *
 * @type {Readonly<Record<number, string>>}
 */
export const CABINET_ORDINALS = Object.freeze({
    10: 'FCICreate', 11: 'FCIAddFile', 12: 'FCIFlushFolder', 13: 'FCIFlushCabinet',
    14: 'FCIDestroy',
    20: 'FDICreate', 21: 'FDIIsCabinet', 22: 'FDICopy', 23: 'FDIDestroy',
    24: 'FDITruncateCabinet',
});
