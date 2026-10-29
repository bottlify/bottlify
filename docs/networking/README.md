# `@bottlify/networking`

TCP and UDP for a browser tab, over one WebSocket.

A page cannot open a TCP connection or bind a UDP port, but it can open a WebSocket. This package
works from both ends of one: a **relay** server (Node, no dependencies) holds real sockets, and a
**client** gives the page sockets through it (streams, datagrams, listening ports, name lookups).
Pages that join the same **room** share a private network, `10.86.0.0/16`, and reach each other
directly; anything outside the room is a real connection the relay opens, only to the hosts you
allow.

`@bottlify/core` uses it to give a Windows program Winsock, but it does not need the engine: a
game, an emulator or a tool of your own can use the same transport.

```
page A ── wss ──┐                ┌── page B        (same room: 10.86.0.1 ↔ 10.86.0.2)
                ├── relay ───────┤
page C ── wss ──┘                └── TCP/UDP to an allowed host on the internet
```

## Run a relay

```sh
npm run relay -w @bottlify/networking -- --port 8787
# or, from modules/networking:
node src/server/cli.js --port 8787 --allow logon.example.com --allow '*.example.net'
node src/server/cli.js --port 8787 --origin https://play.example.com
```

| Option | Default | What it does |
| --- | --- | --- |
| `--port` | 8787 | The port it listens on. |
| `--host` | `0.0.0.0` | The address it binds. |
| `--allow host` | nothing | A host the relay may open real connections to; `*.example.net` allows a suffix. Repeat for more. |
| `--origin url` | any | Only pages from these origins may connect (checked at the handshake). Repeat for more. |
| `--resume-seconds n` | 10 | How long a peer whose link dropped is kept for its page to come back to; 0 ends it with the link. |
| `--proxy http://host:port` | none | Every real TCP connection goes through that HTTP proxy's `CONNECT`, asking for the name the page resolved where there is one: for a relay whose machine has no other way out. A refusal reaches the guest as a refused connection, a 504 as a timeout. UDP is not carried. |
| `--address-header name` | none | Behind a proxy, the header with the client's address (`cf-connecting-ip`), which the per-address limit counts by. Only when nothing but that proxy reaches the relay. |

With no `--allow`, a relay is a private LAN per room, never an open proxy. Whatever the policy
says, real sockets never reach the relay's own machine or a private, link-local or reserved network
(`privateNetworks: true` allows it, for a relay on one's own machine). A relay takes at most 1024
links, 16 from one address (`maxConnections`, `maxConnectionsPerAddress`), drops a link that has
not joined a room within 10 s, and stops reading a real socket while the page it feeds is behind. A page served over
HTTPS may only open `wss://`, so in a deployment put TLS in front of the relay, or attach it to the
HTTPS server you already have:

```js
import { createRelayServer } from '@bottlify/networking/server';

const relay = createRelayServer({ server: httpsServer, path: '/relay',
    policy: ({ room, peer, protocol, host, port })=>host === 'logon.example.com' });
httpsServer.listen(443, ()=>relay.listen());
```

`policy` decides every outbound connection. It sees the host *name* when the page looked it up
through the relay, so an allowlist reads the way it was meant. `createRelayServer({ port })` runs
standalone. `dial: proxyDialer(url)` is the `--proxy` option from code.

## Give a Bottlify program the network

```js
const app = await createApp({
    ...options,
    network: {
        module: '/networking/src/client/index.js',  // where the page serves this package's client
        url: 'wss://play.example.com/relay',
        room: 'my-game-lobby',                      // everyone in it is on one LAN
    },
});
```

The engine runs in a worker, so it is given the client's URL and connects from there (the
`network` option in [`docs/core/api.md`](../core/api.md)). Without `network`, Winsock has
only a loopback adapter. A program's broadcast reaches every peer of its room and stops there, so
two sessions in different rooms never find each other.

## Use it on your own

```js
import { connectRelay } from '@bottlify/networking';

const net = await connectRelay({ url: 'wss://relay.example.com', room: 'demo' });
net.localAddress();                 // 10.86.0.x in host byte order, assigned on joining

net.attach({
    datagram: (port, from, bytes)=>console.log(port, from, new TextDecoder().decode(bytes)),
    accepted: (port, streamId, remote)=>{},     // a peer connected to a port you listen on
    received: (streamId, bytes)=>{},            // bytes on a stream
    disconnected: (streamId, error)=>{},
    lost: error=>{},                            // the relay link dropped: every socket is gone
});

// UDP: bind a port, send to a peer of the room.
net.listen(false, 5000);
net.sendTo({ host: net.localAddress(), port: 5000 }, { host: peerAddress, port: 5000 }, bytes);

// TCP: to a peer, or to an allowed host outside.
const [host] = await net.resolve('logon.example.com');
const { error } = await net.connect(1, { host, port: 6112 });   // 1: a stream id you choose
net.send(1, bytes);
net.disconnect(1, false);
```

Addresses are `{ host, port }`, the host a 32-bit number in host byte order. `listen(true, port)`
accepts streams.

A dropped link comes back as the same session. The client asks to be resumable when it joins
(`resumable: false` does not), and the relay keeps its peer -- address, streams, real sockets -- for
the resume window after the link drops. Both sides number their binary frames, acknowledge them
every heartbeat (5 s), and keep the ones not yet acknowledged; the client reconnects with its
session secret and each side resends what the other missed, so the program sees a pause, not a
loss. Datagrams sent while the link is down are dropped, as a network drops them. A link silent for
three heartbeats is taken for dead and comes back the same way. Past the window, or when the relay
will not resume, the loss is reported through `lost`: a fresh join would mean a new address and an
empty room. Node 22 and later has `WebSocket` built in, so the
client runs there too.

## The wire

Both halves share `@bottlify/networking/protocol`, so they cannot drift apart. Joining and the
roster are JSON text frames; everything else is a binary frame with a twenty-byte header the relay
routes without reading the payload, so one `send` is one frame and a datagram keeps its
boundaries. The RFC 6455 server side is [`src/server/websocket.js`](../../modules/networking/src/server/websocket.js).

Inside `@bottlify/core`, Winsock reaches the network through the transport contract in
[`modules/core/src/layers/win32/wsock32/transport.js`](../../modules/core/src/layers/win32/wsock32/transport.js).
Every part of it is optional, and a missing part behaves as no network. When the engine runs on
the page's own thread (`host: 'thread'`), `createApp({ win32: { network: transport } })` takes any
object implementing it.

## Tests

```sh
npm test -w @bottlify/networking
```

Frame and control codecs; the relay's routing through fake peers; the WebSocket server against
Node's own client, fragmented and interleaved frames included; the client transport, including what
happens to a dial, a lookup and an open stream when the link drops underneath them.
