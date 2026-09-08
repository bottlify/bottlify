# `@bottlify/networking`

A browser tab cannot open a TCP connection or bind a UDP port. It can open a
WebSocket, and nothing else. So a guest program that wants a socket asks a relay,
and the relay does the work with its own sockets and forwards the bytes back.

This package is both halves of that: the transport a runtime plugs in, and the
server it talks to.

```
guest program                 @bottlify/core                @bottlify/networking
-------------                 --------------                --------------------
connect() ------------------> wsock32 --------------------> client transport
                              socket registry                     |
                              (local addresses served here)       | wss
                                                                  v
                                                            relay --> real socket
                                                                  --> another peer
```

## The seam

`@bottlify/core` never imports this package. Its Winsock layer defines a
transport contract in `layers/win32/wsock32/transport.js` and reaches the network
only through whatever the embedder passed as `win32.network`. Everything in that
contract is optional; what is not supplied behaves as though there were no
network, which is the default and is what a single-tab run gets.

So an embedder has three choices, and they cost the same to wire:

```js
// Nothing outside this runtime. Loopback still works; this is the default.
createApp({ win32: {} });

// Ours.
import { connectRelay } from '@bottlify/networking';
createApp({ win32: { network: await connectRelay({ url, room: 'my-game' }) } });

// Yours. Implement as much of the contract as you have; the rest degrades.
createApp({ win32: { network: { sendTo, listen, attach } } });
```

## Two destinations, one address space

The relay puts every peer that named the same room onto a private network,
`10.86.0.0/16`, and gives each an address on it.

- **Anything aimed at a room address** never leaves the relay process: it is
  handed to that peer. A guest's broadcast reaches the room and stops there, so
  two unrelated sessions cannot discover each other's games.
- **Anything else** is a real socket the relay opens on the peer's behalf, and
  it is refused unless the policy allows it.

The default policy refuses everything outside the room. An unconfigured relay is
therefore a private LAN and not an open proxy — which is the only safe thing for
a service whose whole purpose is to be reachable.

## Running one

```sh
node src/server/cli.js --port 8787
node src/server/cli.js --port 8787 --allow logon.example.com --allow '*.example.net'
node src/server/cli.js --port 8787 --origin https://play.example.com
```

`--allow` opens named hosts to the outbound bridge, `*.` opening a suffix.
`--origin`, if given at all, restricts which pages may open a connection; it is
checked at the handshake, because a browser will open a WebSocket cross-origin
without asking anyone.

Terminate TLS in front of the relay. A page served over HTTPS may only open a
`wss://` connection, so this is not optional in a deployment.

For anything beyond the two flags, embed it:

```js
import { createRelayServer } from '@bottlify/networking/server';

const server = createRelayServer({
    port: 8787,
    policy: ({ room, peer, protocol, host, port }) => ...,
});
await server.listen();
```

The policy sees a host *name* rather than an address whenever the guest reached
it through the relay's resolver, so an allowlist can be written in the terms it
was meant in.

## The wire

`@bottlify/networking/protocol` is imported by both halves and depends on
nothing, so the two cannot drift apart. Control messages — joining, the roster —
are JSON text frames. Everything else is a binary frame with a twenty-byte
header the relay routes on without reading the payload, so one guest `send()` is
one frame and a datagram's boundaries survive the trip.

The whole package has no runtime dependencies, server included: the RFC 6455
server side it needs is about a hundred lines and is in `src/server/websocket.js`.

## Tests

```sh
npm test --workspace @bottlify/networking
```

Frame and control codecs; the relay's routing, driven directly through fake
peers; the WebSocket server against Node's own `WebSocket` client, including
fragmented and interleaved frames; the client transport, including what happens
to a dial, a name lookup and an open stream when the link drops underneath them.
