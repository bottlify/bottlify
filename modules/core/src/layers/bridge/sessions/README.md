# Recorded sessions

Each file here is a run that went wrong, saved so it can be run again.

A session is the order things happened in at the bridge — a host call taken, a
handler parked, guest code started, a callback returned — as the engine recorded
it with the `record` option on. `replay.test.js` plays every file in this
directory through the real bridge with a machine of stubs under it, and checks
that what the bridge refuses is exactly what the file says it should.

Recording one: run with `record` set to the number of events to keep, and write
`bridge.recorded()` out with the threads it mentions.

```json
{
  "about": "the campaign crash, before the wave notifier named its thread",
  "threads": [{ "name": "main", "stackTop": 3145728, "stackLimit": 2097152 }],
  "events": [
    { "t": "call", "name": "WINMM.dll!waveOutWrite", "thread": "main", "freeStack": 3141632 },
    { "t": "park", "name": "WINMM.dll!waveOutWrite", "thread": "main" },
    { "t": "guest", "entry": 4202496, "thread": "main", "named": false }
  ],
  "refusals": ["guest 4202496: bridge: a guest callback made after an await must name the thread whose call it answers"]
}
```

`refusals` is the expectation. An empty list means the session must replay
cleanly, which is what a session recorded from a failure becomes once the
failure is fixed — so the file goes on proving it stays fixed.
