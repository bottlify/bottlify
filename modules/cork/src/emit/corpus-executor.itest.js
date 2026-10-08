/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A part of the corpus on translated code on the third executor of a memory:
 * every field of its state and its tables lie past the first's, at addresses
 * its translations carry as constants (`executorLayout`). The executors' gate
 * beside the sequences' (`runtime/executors.test.js`); see
 * `testing/translated-corpus.js`.
 */

import { testTranslatedCorpus } from '../testing/translated-corpus.js';

testTranslatedCorpus(2, 6, { executor: 2 });
