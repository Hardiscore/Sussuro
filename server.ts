import express, { Request, Response } from "express";
import path from "path";
import { createServer as createViteServer } from "vite";

interface PeerInfo {
  id: string;
  name: string;
  role: string;
  audioMuted: boolean;
  videoOff: boolean;
  joinedAt: number;
  appVersion?: string;
}

interface RoomPeer {
  peerId: string;
  userInfo: PeerInfo;
  lastSeen: number;
  sseRes: Response | null;
  queuedSignals: Array<any>;
}

interface Room {
  id: string;
  peers: Map<string, RoomPeer>;
  requiredVersion?: string;
  diceBlockedForAll?: boolean;
}

const rooms = new Map<string, Room>();

function getOrCreateRoom(roomId: string): Room {
  const normId = roomId.trim().toLowerCase().replace(/[\.#$\[\]\/]/g, '-').replace(/\s+/g, '-');
  let room = rooms.get(normId);
  if (!room) {
    room = { id: normId, peers: new Map() };
    rooms.set(normId, room);
  }
  return room;
}

function sendToPeer(peer: RoomPeer, payload: any) {
  if (peer.sseRes && !peer.sseRes.writableEnded) {
    try {
      peer.sseRes.write(`data: ${JSON.stringify(payload)}\n\n`);
      return;
    } catch (err) {
      peer.sseRes = null;
    }
  }
  // Se SSE não estiver ativo no momento, enfileira para a próxima requisição de polling/reconexão
  peer.queuedSignals.push(payload);
  if (peer.queuedSignals.length > 100) {
    peer.queuedSignals.shift();
  }
}

function broadcastToRoom(room: Room, payload: any, excludePeerId: string = '') {
  for (const [id, peer] of room.peers.entries()) {
    if (id !== excludePeerId) {
      sendToPeer(peer, payload);
    }
  }
}

function getPort(): number {
  const portIndex = process.argv.indexOf("--port");
  if (portIndex !== -1 && process.argv[portIndex + 1]) {
    const val = parseInt(process.argv[portIndex + 1], 10);
    if (!isNaN(val)) return val;
  }
  return Number(process.env.PORT) || 3000;
}

async function startServer() {
  const app = express();
  const PORT = getPort();

  app.use(express.json());

  // API de Saúde
  app.get("/api/health", (_req: Request, res: Response) => {
    res.json({ status: "ok", activeRooms: rooms.size });
  });

  // 1. Entrar na sala de RPG
  app.post("/api/rooms/:roomId/join", (req: Request, res: Response) => {
    const { roomId } = req.params;
    const { peerId, userInfo } = req.body;

    if (!peerId) {
      return res.status(400).json({ error: "peerId é obrigatório" });
    }

    const room = getOrCreateRoom(roomId);
    const clientVersion = (userInfo && userInfo.appVersion) ? String(userInfo.appVersion).trim() : '1.0.6';

    // Verificação estrita de versão: não permite entrar em sala com versão incompatível
    if (room.peers.size > 0 && room.requiredVersion && room.requiredVersion !== clientVersion) {
      console.warn(`[Signaling Server] Entrada negada ao peer ${peerId}: Versão incompatível (${clientVersion} vs ${room.requiredVersion}) na sala "${room.id}"`);
      return res.status(409).json({
        error: "VERSION_MISMATCH",
        yourVersion: clientVersion,
        requiredVersion: room.requiredVersion,
        message: `Versão incompatível. Sua versão é v${clientVersion} e a chamada requer v${room.requiredVersion}.`
      });
    }

    if (room.peers.size === 0) {
      room.requiredVersion = clientVersion;
    }

    const existingPeers = Array.from(room.peers.values())
      .filter(p => p.peerId !== peerId)
      .map(p => ({ peerId: p.peerId, userInfo: p.userInfo }));

    let currentPeer = room.peers.get(peerId);
    if (!currentPeer) {
      currentPeer = {
        peerId,
        userInfo: userInfo || { id: peerId, name: 'Aventureiro', role: 'jogador', appVersion: clientVersion },
        lastSeen: Date.now(),
        sseRes: null,
        queuedSignals: []
      };
      room.peers.set(peerId, currentPeer);
    } else {
      currentPeer.userInfo = { ...currentPeer.userInfo, ...userInfo, appVersion: clientVersion };
      currentPeer.lastSeen = Date.now();
    }

    // Notifica todos os outros membros sobre a chegada do novo aventureiro
    broadcastToRoom(room, {
      type: 'peer-joined',
      peerId,
      userInfo: currentPeer.userInfo
    }, peerId);

    console.log(`[Signaling Server] Peer ${peerId} (${currentPeer.userInfo.name} - v${clientVersion}) entrou na sala "${room.id}". Total: ${room.peers.size}`);

    res.json({
      success: true,
      roomId: room.id,
      requiredVersion: room.requiredVersion,
      diceBlockedForAll: !!room.diceBlockedForAll,
      peers: existingPeers
    });
  });

  // 2. Stream de eventos em tempo real (Server-Sent Events)
  app.get("/api/rooms/:roomId/events", (req: Request, res: Response) => {
    const { roomId } = req.params;
    const peerId = (req.query.peerId as string) || '';

    if (!peerId) {
      return res.status(400).send("peerId query param é obrigatório");
    }

    const room = getOrCreateRoom(roomId);
    let peer = room.peers.get(peerId);
    if (!peer) {
      peer = {
        peerId,
        userInfo: { id: peerId, name: 'Aventureiro', role: 'jogador', audioMuted: false, videoOff: true, joinedAt: Date.now() },
        lastSeen: Date.now(),
        sseRes: null,
        queuedSignals: []
      };
      room.peers.set(peerId, peer);
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    peer.sseRes = res;
    peer.lastSeen = Date.now();

    // Envia confirmação de conexão
    res.write(`data: ${JSON.stringify({ type: 'connected', peerId, roomId: room.id })}\n\n`);

    // Despeja sinais enfileirados enquanto o peer não tinha SSE ativo
    while (peer.queuedSignals.length > 0) {
      const queued = peer.queuedSignals.shift();
      res.write(`data: ${JSON.stringify(queued)}\n\n`);
    }

    req.on('close', () => {
      if (peer && peer.sseRes === res) {
        peer.sseRes = null;
      }
    });
  });

  // 3. Enviar sinal WebRTC (Offer, Answer, Candidate) para outro participante
  app.post("/api/rooms/:roomId/signal", (req: Request, res: Response) => {
    const { roomId } = req.params;
    const { from, to, signal } = req.body;

    if (!from || !to || !signal) {
      return res.status(400).json({ error: "from, to e signal são obrigatórios" });
    }

    const room = getOrCreateRoom(roomId);
    const targetPeer = room.peers.get(to);

    if (targetPeer) {
      sendToPeer(targetPeer, {
        type: 'signal',
        from,
        signal
      });
    }

    const fromPeer = room.peers.get(from);
    if (fromPeer) fromPeer.lastSeen = Date.now();

    res.json({ success: true });
  });

  // 4. Atualizar metadata do usuário (Mute, Câmera, Papel de RPG)
  app.post("/api/rooms/:roomId/meta", (req: Request, res: Response) => {
    const { roomId } = req.params;
    const { peerId, userInfo } = req.body;

    const room = getOrCreateRoom(roomId);
    const peer = room.peers.get(peerId);
    if (peer) {
      peer.userInfo = { ...peer.userInfo, ...userInfo };
      peer.lastSeen = Date.now();
      broadcastToRoom(room, {
        type: 'peer-meta',
        from: peerId,
        userInfo: peer.userInfo
      }, peerId);
    }

    res.json({ success: true });
  });

  // 5. Ação de RPG ou Comando de Mestre (Rolagem de dados D20, Silenciar jogador)
  app.post("/api/rooms/:roomId/action", (req: Request, res: Response) => {
    const { roomId } = req.params;
    const { from, data } = req.body;

    const room = getOrCreateRoom(roomId);
    if (data && data.type === 'gm-toggle-dice-rolling') {
      room.diceBlockedForAll = !!data.blocked;
      console.log(`[Signaling Server] Mestre ${from} alterou bloqueio de dados na sala ${roomId} para: ${room.diceBlockedForAll}`);
    }

    broadcastToRoom(room, {
      type: 'rpg-action',
      from,
      data
    }, from);

    res.json({ success: true });
  });

  // 6. Polling fallback para proxies que não sustentam conexões longas de SSE
  app.get("/api/rooms/:roomId/poll", (req: Request, res: Response) => {
    const { roomId } = req.params;
    const peerId = (req.query.peerId as string) || '';

    const room = getOrCreateRoom(roomId);
    const peer = room.peers.get(peerId);

    if (!peer) {
      return res.json({ signals: [] });
    }

    peer.lastSeen = Date.now();
    const signals = peer.queuedSignals.splice(0);
    res.json({ signals });
  });

  // 7. Sair da sala
  app.post("/api/rooms/:roomId/leave", (req: Request, res: Response) => {
    const { roomId } = req.params;
    const { peerId } = req.body;

    const room = getOrCreateRoom(roomId);
    if (room.peers.has(peerId)) {
      const leavingPeer = room.peers.get(peerId);
      if (leavingPeer?.sseRes) {
        try { leavingPeer.sseRes.end(); } catch (e) {}
      }
      room.peers.delete(peerId);
      broadcastToRoom(room, {
        type: 'peer-left',
        peerId
      }, peerId);
      console.log(`[Signaling Server] Peer ${peerId} saiu da sala "${room.id}". Restantes: ${room.peers.size}`);
    }

    if (room.peers.size === 0) {
      rooms.delete(room.id);
    }

    res.json({ success: true });
  });

  // Limpeza periódica de conexões inativas (Ping SSE a cada 10s e expulsão após 35s sem heartbeat)
  setInterval(() => {
    const now = Date.now();
    for (const [roomId, room] of rooms.entries()) {
      for (const [peerId, peer] of room.peers.entries()) {
        // Envia ping SSE se conectado
        if (peer.sseRes && !peer.sseRes.writableEnded) {
          try {
            peer.sseRes.write(": ping\n\n");
          } catch (e) {
            peer.sseRes = null;
          }
        }

        // Se o peer ficou mais de 35 segundos sem contato nem SSE, remove da sala
        if (now - peer.lastSeen > 35000 && !peer.sseRes) {
          console.log(`[Signaling Server] Prunando peer inativo: ${peerId} da sala ${roomId}`);
          room.peers.delete(peerId);
          broadcastToRoom(room, { type: 'peer-left', peerId }, peerId);
        }
      }

      if (room.peers.size === 0) {
        rooms.delete(roomId);
      }
    }
  }, 10000);

  // Vite middleware para desenvolvimento / estático para produção
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`[Sussurro Server] Servidor executando em http://localhost:${PORT}`);
  });
}

startServer().catch(err => {
  console.error("[Sussurro Server] Falha catastrófica ao iniciar:", err);
});
