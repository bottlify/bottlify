# Phase 9 — Networking

> **Status:** partly built, and further along than the master plan's one-line Phase 9 entry
> suggests. The transport seam, the socket surface behind it, the relay protocol and the relay
> server all exist and are tested. What is missing is the half a *game* needs: the notification
> style a period title actually uses, DirectPlay, and a run of two real peers proving it.
>
> Written against `modules/networking/` and `modules/core/src/layers/win32/wsock32/` as they stand.
> Everything below that says "exists" was read there; nothing here is inferred from a commit message.

## Why this is a phase at all

The master plan's §11 and Phase 9 describe a separate package that the core never imports. That
decision held, and it is why this can be a late phase without holding anything up: a single-player
title runs with no network at all, and the default configuration is exactly that.

What the plan did not say — because it was written before the shape was known — is that the
*expensive* part is not the relay. It is the seam. A browser tab has no sockets; it has a WebSocket
and nothing else. So every design question is about who owns the address space, what a socket means
when the bytes travel through somebody else's process, and what happens to a parked guest thread
when that process goes away. Those questions had to be answered inside `@bottlify/core`, in a layer
that must keep working when no network package is installed at all.

## What is built

### The seam, in the core

`layers/win32/wsock32/transport.js` defines what the embedder supplies, and `win32/module.js` reads
it from `config.network`, falling back to `createLoopbackAdapter()`. Nothing in the core imports the
networking package, and everything in the contract is optional: what is not supplied behaves as
though there were no network. Three embedder choices cost the same to wire — nothing, ours, or your
own partial implementation.

Four properties in that file are load-bearing and are the reason the seam is where the work went: a
stream is named by an id this runtime allocates rather than by an address pair (an address pair is
not unique, and keying on one delivers a peer's bytes to the wrong socket); bytes handed to a
transport are the transport's own copy, because the guest may overwrite its buffer the moment the
call returns; a refused dial has to arrive as a refusal, recorded on the socket as well as returned,
because a non-blocking `connect` reads it from `getsockopt(SO_ERROR)` and never sees the return
value; and losing the link is not silence, or a guest thread parked in `recv` waits for the rest of
the run.

The socket registry above it serves the local address space itself, so a remote socket and a local
one are the same socket to every call above — `recv`, `select` and `FIONREAD` read one queue and
neither knows nor cares which side filled it. That is what makes the whole surface testable without
a network.

### The Winsock surface

`WSOCK32.dll` and `WS2_32.dll` are both published, over one registry, with the ordinal tables kept
apart because three of them genuinely disagree between the two libraries. Implemented: startup and
error state, `socket`/`bind`/`listen`/`connect`/`accept`/`closesocket`, `send`/`recv`/`sendto`/
`recvfrom`, `shutdown`, `getsockname`/`getpeername`, `setsockopt`/`getsockopt`, `ioctlsocket`,
`select` with `__WSAFDIsSet`, the byte-order family, `inet_addr`/`inet_ntoa`, `gethostname`/
`gethostbyname`, `WSARecv`/`WSASend`, and the overlapped extensions `AcceptEx`,
`GetAcceptExSockaddrs`, `ConnectEx` and `DisconnectEx`.

### The package

`@bottlify/networking` is both halves and has no runtime dependencies, server included — the RFC
6455 server side it needs is about a hundred lines of its own.

- `protocol.js` is imported by both halves and depends on nothing, so client and relay cannot drift.
  Control messages are JSON text frames; everything else is a binary frame with a twenty-byte header
  the relay routes on without reading the payload, so one guest `send()` is one frame and a
  datagram's boundaries survive the trip.
- The relay puts every peer that named the same room onto a private `10.86.0.0/16` and gives each an
  address on it. Room-addressed traffic never leaves the relay process, so a guest's broadcast
  reaches the room and stops there and two unrelated sessions cannot discover each other's games.
  Anything else is a real socket the relay opens on the peer's behalf, refused unless policy allows
  it — and **the default policy refuses everything outside the room**, so an unconfigured relay is a
  private LAN rather than an open proxy. That is not a nicety: the whole purpose of the thing is to
  be reachable.
- `--allow` opens named hosts (a `*.` prefix opening a suffix), `--origin` restricts which pages may
  connect, checked at the handshake because a browser will open a WebSocket cross-origin without
  asking anyone. TLS is terminated in front of the relay; a page served over HTTPS may only open
  `wss://`, so this is not optional in a deployment.

### Tests

Frame and control codecs; the relay's routing driven through fake peers; the WebSocket server
against Node's own `WebSocket` client, including fragmented and interleaved frames; and the client
transport, including what happens to a dial, a name lookup and an open stream when the link drops
underneath them. The workspace's tests and typecheck run in the root `npm test` and `npm run
typecheck`, so this package is in CI rather than beside it.

## What is not built

- **`WSAAsyncSelect` and `WSAAsyncGetHostByName`.** The master plan's §11 names "async notifications
  via window messages", and this is that: a period title asks for readiness as a window message
  rather than by polling `select`. The ordinal table already carries the name; nothing implements
  it. `WSAEventSelect` is absent too. This is the largest single gap between what exists and what a
  game of the target era will actually call.
- **DirectPlay.** Nothing at all — no `dplayx`, no interfaces, no plan beyond §11's sentence.
- **Rooms as a product.** The relay has rooms; there is no room manager, no discovery, no
  authentication, and no story for who runs a relay for whom.
- **WebRTC NAT traversal.** §11 lists it; everything today goes through the relay.
- **Local mode.** §11's "two tabs on one machine acting as two networked machines" works only by
  both tabs joining a relay, which means a relay process even for a local test. Whether that is good
  enough, or whether the two tabs should meet without one, is undecided.
- **A measurement with two real peers.** Every test above drives fake peers or a loopback. Nothing
  has yet played a networked game, so the acceptance criterion below is entirely unmet.

## What it is blocked on

Nothing structural. The seam is the part that had to be right and it is done; the remainder is
surface work and one measurement. In practical order:

1. `WSAAsyncSelect` — cheap, and the thing a target title asks for first.
2. Two tabs, one relay, a real game's LAN browser. This is the measurement that will say which of
   the remaining gaps are real.
3. DirectPlay, if and only if a target title turns out to import it — which none of the four has
   been checked for, and an import table answers in a minute.

**Acceptance** (from the master plan): a networked game between two tabs, then between two machines
via relay.
