/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The page file a volume a test builds is handed, as a run hands its volume
 * one (`app.js` `openRunPageFile`): its writable layers keep what is written
 * in a cache of its own, with a disk in memory. Made out here, beside what
 * assembles a run, because it stands on two layers (`filesystem` and
 * `cache`), and neither of them reaches the other.
 */

import { createPageFile } from '../layers/filesystem/internal/page-file.js';
import { pieceSpace } from '../layers/filesystem/internal/page-space.fixture.js';
import { cacheSpace } from '../layers/cache/module.js';

export async function testPageFile(){
    return createPageFile((await pieceSpace(cacheSpace, { budget: 256 << 20 })).space);
}
