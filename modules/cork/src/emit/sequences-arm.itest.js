/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A part of the sequence corpus translated as an arm64 host's translator makes it, whose
 * default NaN is positive, with the NaN's sign fixed up (`exactNaN`): the float arithmetic
 * carries the fix-ups that make an invalid operation's NaN x86's, and the scalar SSE forms
 * work on their low lane alone, code an x86 host never makes for itself. Run here, it is
 * held to the instruction model as the host's own translation is; see
 * `testing/sequences-judge.js`. A second part as such a host translates it by default, the
 * NaN's sign left as the host makes it (`exactNaN` off): the scalar forms on their low lane
 * with no fix-up, whose NaNs this x64 host makes x86's own.
 */

import { testSequences } from '../testing/sequences-judge.js';
import { features } from '../wasm/features.js';

testSequences(1, 4, { ...features(), defaultNaNNegative: false }, { exactNaN: true });
testSequences(2, 4, { ...features(), defaultNaNNegative: true, armHost: true });
