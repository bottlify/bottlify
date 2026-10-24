# Bottlify: запуск игр и программ для Windows в браузере

[English](README.md)

**Старые игры для ПК и программы Windows прямо в браузере**, без Windows, установки и
плагинов: слой совместимости с Windows (в духе Wine) и транслятор x86 в WebAssembly, DirectX и
OpenGL рисуются через WebGPU. Попробовать: [bottlify.app](https://bottlify.app/).

Bottlify - это набор пакетов, с которыми веб-страница запускает программы и игры для Windows прямо
во вкладке браузера. Windows, плагины и установка для этого не нужны: страница открывает обычный
`.exe`, и программа работает так, будто вокруг неё Windows, с диском `C:`, реестром, окнами,
DirectX и звуком.

Поддерживаются 32-битные программы, DirectDraw, Direct3D 7–10, OpenGL 1.1 с расширениями, Vulkan,
DirectSound, DirectMusic, видео через DirectShow и сеть через Winsock.

## Зачем

Браузер есть на любом устройстве, от телефона до компьютера. Bottlify делает его платформой для
программ и игр, которые уже написаны: игра лежит «в бутылке» и открывается по ссылке.

Раньше браузер пытались сделать платформой плагины: Flash, Java-апплеты, Unity Web Player. Под
каждый программы писали отдельно, и когда браузеры отказались от плагинов, эти игры перестали
запускаться. Bottlify опирается только на стандарты, которые есть в любом современном браузере
(WebAssembly, WebGPU, Web Audio, OPFS), а программы для него переписывать не нужно.

## Из чего состоит

- **[core](modules/core/README.ru.md)** (`@bottlify/core`): окружение Windows, написанное с нуля на
  JavaScript. `kernel32`, `user32`, `gdi32`, DirectX, OpenGL, DirectSound, Winsock и остальные
  системные библиотеки работают поверх WebGPU, WebAudio и OPFS. Страница запускает его одним
  вызовом `createApp()`.
- **[cork](modules/cork/README.ru.md)** (`@bottlify/cork`): процессор x86 для core.
- **[networking](modules/networking/README.md)** (`@bottlify/networking`, по желанию): TCP и UDP
  для вкладки через один WebSocket, сервер-ретранслятор и его клиент. Без него программе доступен
  только loopback внутри вкладки.
- **[installer](modules/installer/README.md)** (`@bottlify/installer`, по желанию): собирает
  бутылку из установщика игры, который запускается внутри движка без изменений.

Как всё устроено целиком (потоки, запуск, трансляция, Win32, графика, звук, сеть, хранилища),
описано в [архитектуре](docs/architecture.ru.md). Тем, кто встраивает `@bottlify/core`, нужны
[API, настройки и ограничения](docs/core/README.md) (на английском). Планы лежат в
[`roadmap/`](roadmap/README.md).

## Сборка и тесты

```sh
npm ci
npm run fetch:video-decoder && npm run fetch:corpus   # the pinned decoder and cork's x86 corpus
npm run typecheck && npm run lint && npm test && npm run check:boundaries
npm run test:integration && npm run build
npm run cdp:probe   # boots the engine in a real headless Chrome
```

Модули лежат в [`modules/`](modules/), инструменты разработки (стенд с настоящим браузером, аудит
импортов, бенчмарки) в [`tools/`](tools/). Лаунчер и интерфейс бутылок живут в отдельном
репозитории, [`bottlify-ui`](https://github.com/bottlify/bottlify-ui).

Bottlify распространяется по лицензии MPL-2.0. Чужие компоненты и код перечислены в
[`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md).
