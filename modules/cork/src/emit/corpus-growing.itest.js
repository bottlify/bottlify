/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The corpus on translated code over a memory that grows: the RAM at 0, the
 * engine's tables inside it, the mask of the wrap word in place of the RAM's
 * size. The same cases as `corpus-N.itest.js`, which judge the fixed layout.
 */

import { testTranslatedCorpus } from '../testing/translated-corpus.js';

for (let part = 0; part < 6; part++)
{
    testTranslatedCorpus(part, 6, { growing: true });
}
