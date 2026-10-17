/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A part of the corpus on code translated for the process's shared layout
 * (`sharedLayout`) and run on the third executor of a memory, whose state and
 * tables lie past the first's: every field the code reads or writes is an
 * offset from the bases the instance is given (`emit/bases.js`), so an access
 * left at the first executor's address reads another executor's state and the
 * case fails. The gate beside `corpus-executor.itest.js`, which runs the same
 * part on code translated for that executor's own layout.
 */

import { testTranslatedCorpus } from '../testing/translated-corpus.js';

testTranslatedCorpus(2, 6, { executor: 2, shared: true });
