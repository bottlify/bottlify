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
 * case fails. The gate beside `corpus-executor.itest.js`, which runs another
 * part on code translated for that executor's own layout: both in the atomic
 * variant, as a process with more than one executor translates, so between
 * them two parts of the corpus are judged in it.
 */

import { testTranslatedCorpus } from '../testing/translated-corpus.js';

testTranslatedCorpus(3, 6, { executor: 2, shared: true, atomic: true });
