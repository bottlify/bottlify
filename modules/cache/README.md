# `@bottlify/cache`

One cache for every thread of a page. Bodies live in shared memory and are read in place by name,
from any worker, without a message. One keeper thread places them under one budget, moves idle
bodies to the disk (the Origin Private File System) and brings them back when asked. Part of
[Bottlify](https://github.com/bottlify/bottlify).

Status: the core and its concurrency gate; not yet published.

## Install

```sh
npm install @bottlify/cache
```

## Use

The keeper runs in one thread. It hands out the index and the segments every thread reads:

```js
import { openKeeper } from '@bottlify/cache';

const keeper = await openKeeper({
    budget: 256 << 20,           // bytes of shared memory for hot bodies, at most
    disk,                        // OPFS sync handles, or null for memory only
    announce: message=>workers.forEach(worker=>worker.postMessage(message)),
});
// Each worker gets keeper.shared and keeper.segmentBuffers(); the keeper sweeps idle bodies.
setInterval(()=>keeper.sweep(), 1000);
```

Each thread reads through a reader. It reaches the keeper only for room to write and for a body
to be brought back from the disk, through whatever blocking call its threads already have:

```js
import { createReader } from '@bottlify/cache';

const cache = createReader({ shared, segments, keeper: calls });
self.onmessage = event=>cache.adopt(event.data);   // segments made and let go

const sum = cache.with('blocks/42', body=>checksum(body));   // undefined on a miss
const into = cache.reserve('blocks/43', length);              // write in place
into?.set(bytes);
cache.commit('blocks/43');
```

A body is read only inside `with`: the keeper never takes a body a reader is in. A body that can
be made again goes away when there is no room and no disk; one marked `onlyCopy` never does.

## Requirements

`SharedArrayBuffer` (a cross-origin isolated page), growable shared buffers and
`Atomics.waitAsync`. The disk is optional.
