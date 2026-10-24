# Sussurro RPG — contexto do projeto

App de chamadas de voz/vídeo para grupos de RPG entre amigos (substituto do Discord). Roda como **app desktop Electron (Windows)** e como **site/PWA**, com o mesmo código.

## Como responder
- Sempre em **português**.
- O dono do projeto programou só para web até agora e é iniciante em Windows/Electron: explique termos técnicos de forma simples.
- Mudanças **mínimas e cirúrgicas**; não reescrever arquivos inteiros sem necessidade.
- Ao terminar, dizer **quais arquivos foram alterados**.
- Rodar `node --check <arquivo>` em todo .js/.cjs alterado antes de considerar pronto.
- Não mudar a versão sem o dono pedir (ele avisa).

## Arquitetura
- **Sem bundler no Electron**: os arquivos são ES modules carregados direto pelo `index.html` (`<script type="importmap">` aponta `firebase/app` e `firebase/database` para o CDN gstatic).
- **WebRTC mesh** (todos conectados com todos, até 15 pessoas) com *Perfect Negotiation*. Sinalização via **Firebase Realtime Database** (`rooms/<sala>/peers`, `rooms/<sala>/signals`, `rooms/<sala>/chat`).
- **Chat Geral** da tela inicial em `lobby/chat` (máx. 50 mensagens; texto, links e fotos comprimidas em dataURL; sem outros arquivos).
- Regras do Firebase: tudo bloqueado exceto `rooms` e `lobby` (leitura/escrita liberadas).
- Atualização automática: `electron-updater` com GitHub Releases (`Hardiscore/Sussuro`). Registro em `%APPDATA%/<app>/updater.log`.

## Arquivos principais
| Arquivo | Função |
| --- | --- |
| `main.cjs` | Processo principal do Electron: janela, bandeja, atalhos globais (globalShortcut + node-global-key-listener + uiohook), captura de tela, áudio por aplicativo (loopback-capture), autoUpdater, iniciar com Windows, ícone de não lidas |
| `preload.cjs` | Ponte `window.electronAPI` entre renderer e main |
| `app.js` | Interface e estado (≈6000 linhas): lobby, chamada, grid, configurações, dados de RPG, atalhos, versão (`APP_VERSION`) |
| `webrtc.js` | Classe `TavernWebRTC`: mídia, conexões, compartilhamento de tela, DataChannel, modo "Pc da Hayfa" |
| `chat.js` | Chat dentro da chamada (`RoomChat`): texto via Firebase, arquivos P2P pelo DataChannel (até 200 MB), arrastar e soltar |
| `lobby-chat.js` | Chat Geral da tela inicial (`LobbyChat`) + notificações (ícone e som) |
| `video-effects.js` | Efeitos de vídeo (desfoque, fundos, acessórios, filtros) com MediaPipe; **desligados por padrão** |
| `noise-suppressor.js` | Supressão de ruído |
| `firebase-config.js` | Inicialização do Firebase e wrappers (`ref`, `set`, `get`, `remove`, `onChildAdded`, `queryLast`...) |
| `public/sw.js` | Service Worker do PWA (tem a versão no nome do cache) |

## Cuidados conhecidos (já causaram bugs)
- Comentário CSS não fechado em `styles.css` "engole" regras: conferir que `/*` e `*/` batem.
- Arquivos carregados dinamicamente (`import()`/`addModule`) precisam estar em `asarUnpack` no `package.json`; todo arquivo novo precisa entrar em `build.files`.
- Teclas de digitar (espaço, letras, `=`) **não** podem ir para `globalShortcut` (o Windows bloqueia a digitação); usar só o ouvinte passivo.
- Quem tem versão diferente na sala é ignorado (não derruba os outros). Ao sair, a sala vazia é apagada do Firebase.
- Efeitos de vídeo e o pipeline só rodam se houver efeito ativo (economia de CPU).

## Versão e publicação
- A versão aparece em: `package.json`, `app.js` (`APP_VERSION`), `index.html` (vários lugares), `server.ts` e `public/sw.js`.
- Publicar: commit + push + tag `vX.Y.Z` → GitHub Actions (`.github/workflows/release.yml`) gera a release com `latest.yml`, `.exe` e `.blockmap`.
- Quando o dono pedir para **mudar a versão e dar commit/push**, fazer o processo completo de lançamento: atualizar a versão em todos os lugares, commit, push **e** criar/enviar a tag `vX.Y.Z` (sem perguntar de novo).
- O site/PWA é publicado no **Firebase Hosting** (projeto `sussurro-4ef44`, site `sussurro-rpg` → https://sussurro-rpg.web.app, pasta `dist/` do `vite build`; o site padrão `sussurro-4ef44.web.app` foi desativado) pelo job `deploy-site` do mesmo workflow (secret `FIREBASE_SERVICE_ACCOUNT_SUSSURRO_4EF44`). Sem servidor: rotas `/api/*` dão 404 e o app trata como modo estático. Deploy manual: `npx vite build` + `npx firebase-tools deploy --only hosting`.
- O botão "Baixar para Windows" (`/api/download/windows`) é um redirect no `firebase.json` para `releases/latest/download/Sussurro-RPG-Setup.exe`: se mudar o `nsis.artifactName`, atualizar o redirect.
- **Atenção:** a tag precisa apontar para um commit que já tenha todos os arquivos (a v1.1.7 saiu sem `lobby-chat.js`).

## Pendências / ideias anotadas
- Confirmar se a atualização automática volta a funcionar a partir da 1.1.8 (se falhar, ver `updater.log`).
- Ideias avaliadas e ainda não feitas: soundboard, música/ambiência do mestre, "mostrar imagem para a mesa", rolagem secreta do mestre, reações rápidas.
