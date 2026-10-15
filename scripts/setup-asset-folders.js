import fs from 'fs';
import path from 'path';
import zlib from 'zlib';

function createCrcTable() {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      if (c & 1) {
        c = 0xedb88320 ^ (c >>> 1);
      } else {
        c = c >>> 1;
      }
    }
    table[n] = c;
  }
  return table;
}

const crcTable = createCrcTable();
function crc32(buf, start = 0, end = buf.length) {
  let crc = 0xffffffff;
  for (let i = start; i < end; i++) {
    crc = crcTable[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function writePng(width, height, rgbaBuffer) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  // IHDR chunk
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = 6; // color type: 6 = RGBA
  ihdrData[10] = 0; // compression
  ihdrData[11] = 0; // filter
  ihdrData[12] = 0; // interlace

  const ihdrChunk = makeChunk('IHDR', ihdrData);

  // Scanlines with filter byte 0
  const scanlineLength = width * 4;
  const rawData = Buffer.alloc(height * (scanlineLength + 1));
  for (let y = 0; y < height; y++) {
    const rawOffset = y * (scanlineLength + 1);
    rawData[rawOffset] = 0; // filter byte: None
    rgbaBuffer.copy(rawData, rawOffset + 1, y * scanlineLength, (y + 1) * scanlineLength);
  }

  const deflated = zlib.deflateSync(rawData);
  const idatChunk = makeChunk('IDAT', deflated);
  const iendChunk = makeChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([signature, ihdrChunk, idatChunk, iendChunk]);
}

function makeChunk(type, data) {
  const len = data.length;
  const chunk = Buffer.alloc(12 + len);
  chunk.writeUInt32BE(len, 0);
  chunk.write(type, 4, 4, 'ascii');
  data.copy(chunk, 8);
  const crc = crc32(chunk, 4, 8 + len);
  chunk.writeUInt32BE(crc, 8 + len);
  return chunk;
}

// Criar pastas se não existirem
const bgDir = path.join(process.cwd(), 'public', 'backgrounds');
const accDir = path.join(process.cwd(), 'public', 'accessories');

fs.mkdirSync(bgDir, { recursive: true });
fs.mkdirSync(accDir, { recursive: true });

// 1. Criar PARAMETROS.txt em cada pasta
const bgParams = `========================================================================
SUSSURRO RPG - GUIA DE PARÂMETROS PARA IMAGENS DE CENÁRIO (BACKGROUND)
========================================================================

Qualquer imagem que você colocar nesta pasta ("public/backgrounds") será
automaticamente reconhecida pelo programa no menu "Filtros e Avatar"!

1. PARÂMETROS RECOMENDADOS:
   • Resolução Ideal: 1920x1080 (Full HD) ou 1280x720 (HD).
   • Proporção: 16:9 (widescreen padrão de webcam e monitores).
   • Formatos aceitos: .jpg, .jpeg, .png, .webp
   • Tamanho do arquivo: Entre 200 KB e 5 MB (imagens muito pesadas podem demorar a carregar).
   • Nome do arquivo: Use nomes descritivos com letras minúsculas e sublinhado (ex: taverna_animada.jpg, caverna_do_dragao.png). O nome do arquivo será usado como o título do cenário na tela!

2. DICAS DE ENQUADRAMENTO PARA RPG:
   • Seu corpo e rosto ficarão no centro da tela.
   • Escolha imagens com sensação de profundidade e ambiente (tochas, lareiras, estantes, árvores nas laterais).
   • Evite imagens com objetos grandes desenhados bem no centro, pois sua câmera vai ficar por cima deles.

3. PERSISTÊNCIA:
   • As imagens adicionadas nesta pasta ficam salvas no seu computador e NÃO são apagadas nas atualizações!
`;

const accParams = `========================================================================
SUSSURRO RPG - GUIA DE PARÂMETROS PARA ACESSÓRIOS & ADEREÇOS (PNG)
========================================================================

Qualquer imagem PNG que você colocar nesta pasta ("public/accessories") será
automaticamente reconhecida pelo programa e poderá ser equipada na sua câmera!

1. PARÂMETROS OBRIGATÓRIOS & RECOMENDADOS:
   • Fundo: 100% TRANSPARENTE (Canal Alpha / RGBA de 32 bits).
     ATENÇÃO: NÃO use arquivos JPG para acessórios, pois JPG não tem transparência e ficará com um quadrado branco/preto!
   • Formatos aceitos: .png, .webp (com transparência).
   • Resolução Ideal: 512x512 pixels ou 1024x1024 pixels (quadrado).
   • Margem/Respiro: Deixe cerca de 10% a 15% de margem transparente ao redor do desenho para não cortar as pontas.
   • Peso: Menos de 2 MB por arquivo para garantir 60 FPS no rastreamento facial.

2. PONTOS DE ANCORAGEM (ANCHOR) AUTOMÁTICOS:
   Você pode definir onde o acessório se prende selecionando o ponto na tela do app ou nomeando o arquivo com um sufixo:
   • Topo da Cabeça (head): Chapeus, elmos, tiaras, coroas, orelhas de animais.
   • Olhos / Rosto (eyes): Óculos, tapa-olhos, monóculos, vendas místicas.
   • Boca / Queixo (mouth): Máscaras, barbas de anão, bigodes, cachimbos.
   • Ombros / Peito (chest): Capas, armaduras de ombro, colares, emblemas.
   • Lateral / Mascote (side): Dragões de ombro, corujas, fadas familiares, asas.

3. PERSISTÊNCIA:
   • Seus adereços ficam salvos permanentemente no seu computador e NÃO são apagados ao atualizar a versão do aplicativo!
`;

fs.writeFileSync(path.join(bgDir, 'PARAMETROS_CENARIOS.txt'), bgParams, 'utf8');
fs.writeFileSync(path.join(accDir, 'PARAMETROS_ACESSORIOS_PNG.txt'), accParams, 'utf8');

// Desenha acessórios vetoriais rasterizados em PNG de 256x256 com canal alfa transparente
function createAccessoryPng(type) {
  const size = 256;
  const buf = Buffer.alloc(size * size * 4); // RGBA

  const setPixel = (x, y, r, g, b, a) => {
    if (x < 0 || x >= size || y < 0 || y >= size) return;
    const idx = (Math.floor(y) * size + Math.floor(x)) * 4;
    // Alpha blending
    const srcA = a / 255;
    const dstA = buf[idx + 3] / 255;
    const outA = srcA + dstA * (1 - srcA);
    if (outA > 0) {
      buf[idx] = Math.round((r * srcA + buf[idx] * dstA * (1 - srcA)) / outA);
      buf[idx + 1] = Math.round((g * srcA + buf[idx + 1] * dstA * (1 - srcA)) / outA);
      buf[idx + 2] = Math.round((b * srcA + buf[idx + 2] * dstA * (1 - srcA)) / outA);
      buf[idx + 3] = Math.round(outA * 255);
    }
  };

  const drawFilledCircle = (cx, cy, radius, r, g, b, a) => {
    for (let y = cy - radius; y <= cy + radius; y++) {
      for (let x = cx - radius; x <= cx + radius; x++) {
        const d = Math.hypot(x - cx, y - cy);
        if (d <= radius) {
          const edgeAlpha = Math.min(1, radius - d + 0.5) * a;
          setPixel(x, y, r, g, b, edgeAlpha);
        }
      }
    }
  };

  const drawFilledRect = (rx, ry, rw, rh, r, g, b, a) => {
    for (let y = ry; y < ry + rh; y++) {
      for (let x = rx; x < rx + rw; x++) {
        setPixel(x, y, r, g, b, a);
      }
    }
  };

  if (type === 'coroa_dourada') {
    // Base da coroa
    drawFilledRect(40, 160, 176, 26, 234, 179, 8, 255);
    drawFilledRect(44, 164, 168, 18, 251, 191, 36, 255);
    // Pontas da coroa
    for (let x = 40; x <= 216; x++) {
      for (let y = 80; y <= 160; y++) {
        const normX = (x - 40) / 176;
        let peakY = 160;
        if (normX < 0.25) peakY = 80 + (normX / 0.25) * 80;
        else if (normX < 0.5) peakY = 160 - ((normX - 0.25) / 0.25) * 100;
        else if (normX < 0.75) peakY = 60 + ((normX - 0.5) / 0.25) * 100;
        else peakY = 160 - ((normX - 0.75) / 0.25) * 80;
        if (y >= peakY) {
          setPixel(x, y, 245, 158, 11, 255);
        }
      }
    }
    // Jóias brilhantes
    drawFilledCircle(40, 80, 10, 239, 68, 68, 255); // Rubi esquerdo
    drawFilledCircle(128, 60, 13, 239, 68, 68, 255); // Rubi central
    drawFilledCircle(216, 80, 10, 239, 68, 68, 255); // Rubi direito
    drawFilledCircle(85, 173, 7, 59, 130, 246, 255); // Safira
    drawFilledCircle(128, 173, 8, 16, 185, 129, 255); // Esmeralda
    drawFilledCircle(171, 173, 7, 59, 130, 246, 255); // Safira
  } else if (type === 'chapeu_mago') {
    // Aba do chapéu
    for (let y = 170; y < 210; y++) {
      for (let x = 20; x < 236; x++) {
        const dx = (x - 128) / 106;
        const dy = (y - 190) / 20;
        if (dx * dx + dy * dy <= 1) {
          setPixel(x, y, 49, 46, 129, 255);
        }
      }
    }
    // Cone do chapéu arqueado
    for (let y = 40; y < 190; y++) {
      const progress = (y - 40) / 150;
      const width = progress * 80;
      const bend = Math.sin(progress * Math.PI) * 22;
      const cx = 128 + (1 - progress) * 20 - bend;
      for (let x = cx - width; x <= cx + width; x++) {
        setPixel(x, y, 67, 56, 202, 255);
      }
    }
    // Faixa dourada com fivela
    drawFilledRect(68, 172, 120, 14, 245, 158, 11, 255);
    drawFilledCircle(128, 179, 8, 254, 240, 138, 255);
    // Estrela mágica no topo
    drawFilledCircle(145, 42, 8, 250, 204, 21, 255);
  } else if (type === 'elmo_cavaleiro') {
    // Cúpula do elmo
    for (let y = 60; y < 190; y++) {
      for (let x = 50; x < 206; x++) {
        const dx = (x - 128) / 76;
        const dy = (y - 130) / 70;
        if (dx * dx + dy * dy <= 1) {
          const shade = 100 + Math.round((1 - Math.abs(dx)) * 80);
          setPixel(x, y, shade, shade + 8, shade + 18, 255);
        }
      }
    }
    // Fenda de visão (visor preto com reflexo)
    drawFilledRect(66, 122, 124, 16, 15, 23, 42, 255);
    drawFilledRect(70, 126, 116, 6, 30, 41, 59, 255);
    // Pluma vermelha no topo
    for (let y = 20; y < 70; y++) {
      const w = 14 + (y - 20) * 0.4;
      for (let x = 128 - w; x <= 128 + w; x++) {
        setPixel(x, y, 220, 38, 38, 255);
      }
    }
  } else if (type === 'chifres_demonio') {
    // Chifre esquerdo
    for (let t = 0; t <= 1; t += 0.005) {
      const cx = 90 - Math.sin(t * 1.5) * 55;
      const cy = 180 - t * 130;
      const r = (1 - t) * 20 + 4;
      drawFilledCircle(cx, cy, r, 185, 28, 28, 255);
    }
    // Chifre direito
    for (let t = 0; t <= 1; t += 0.005) {
      const cx = 166 + Math.sin(t * 1.5) * 55;
      const cy = 180 - t * 130;
      const r = (1 - t) * 20 + 4;
      drawFilledCircle(cx, cy, r, 185, 28, 28, 255);
    }
  } else if (type === 'tapa_olho_pirata') {
    // Faixa diagonal
    for (let x = 0; x < 256; x++) {
      const y = Math.round(50 + (x / 256) * 110);
      drawFilledRect(x, y - 4, 3, 8, 28, 25, 23, 255);
    }
    // Remendo de couro no olho esquerdo
    for (let y = 100; y < 165; y++) {
      for (let x = 80; x < 145; x++) {
        const dx = (x - 112) / 30;
        const dy = (y - 132) / 30;
        if (dx * dx + dy * dy <= 1) {
          setPixel(x, y, 41, 37, 36, 255);
        }
      }
    }
    // Caveira metálica no centro do tapa-olho
    drawFilledCircle(112, 132, 7, 214, 211, 209, 255);
  } else if (type === 'mascara_ladino') {
    // Máscara triangular de tecido ninja / ladino
    for (let y = 90; y < 210; y++) {
      const progress = (y - 90) / 120;
      const width = 85 - progress * 40;
      for (let x = 128 - width; x <= 128 + width; x++) {
        setPixel(x, y, 30, 41, 59, 255);
      }
    }
    // Costura
    for (let y = 92; y < 205; y += 6) {
      setPixel(128, y, 71, 85, 105, 255);
    }
  } else if (type === 'barba_ruiva_anao') {
    // Bigode volumoso
    for (let y = 60; y < 100; y++) {
      for (let x = 40; x < 216; x++) {
        const dx = (x - 128) / 85;
        const dy = (y - 80) / 18;
        if (dx * dx + dy * dy <= 1) {
          setPixel(x, y, 194, 65, 12, 255);
        }
      }
    }
    // Barba longa trançada de anão
    for (let y = 90; y < 240; y++) {
      const progress = (y - 90) / 150;
      const w = 75 - progress * 25 + Math.sin(y * 0.15) * 8;
      for (let x = 128 - w; x <= 128 + w; x++) {
        setPixel(x, y, 180, 83, 9, 255);
      }
    }
    // Anel de metal na trança
    drawFilledRect(110, 180, 36, 12, 234, 179, 8, 255);
  } else if (type === 'mini_dragao_ombro') {
    // Corpo do pequeno dragãozinho familiar
    drawFilledCircle(180, 140, 35, 16, 185, 129, 255); // Corpo
    drawFilledCircle(195, 110, 24, 16, 185, 129, 255); // Cabeça
    drawFilledCircle(175, 100, 12, 245, 158, 11, 255); // Chifre
    drawFilledCircle(202, 106, 5, 254, 240, 138, 255); // Olho dourado
    // Asinhas abertas
    for (let y = 80; y < 140; y++) {
      for (let x = 120; x < 180; x++) {
        const dx = (x - 150) / 30;
        const dy = (y - 110) / 30;
        if (dx * dx + dy * dy <= 1) {
          setPixel(x, y, 5, 150, 105, 240);
        }
      }
    }
    // Chama mística saindo da boca
    drawFilledCircle(222, 118, 9, 249, 115, 22, 255);
    drawFilledCircle(232, 120, 6, 250, 204, 21, 255);
  }

  return writePng(size, size, buf);
}

// Cria fundos 640x360 em PNG de alta resolução
function createBackgroundPng(preset) {
  const W = 640;
  const H = 360;
  const buf = Buffer.alloc(W * H * 4);

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const idx = (y * W + x) * 4;
      let r = 20, g = 20, b = 25;

      if (preset === 'taverna_medieval') {
        // Madeira escura aconchegante com iluminação de fogueira
        const warmGlow = Math.max(0, 1 - Math.hypot(x - 120, y - 260) / 280);
        r = Math.min(255, Math.round(35 + warmGlow * 160 + (y / H) * 20));
        g = Math.min(255, Math.round(18 + warmGlow * 90 + (y / H) * 10));
        b = Math.min(255, Math.round(8 + warmGlow * 20));
        // Vigas
        if (y % 55 < 4 || (x % 140 < 12)) {
          r = Math.round(r * 0.65);
          g = Math.round(g * 0.65);
          b = Math.round(b * 0.65);
        }
      } else if (preset === 'masmorra_pedra') {
        // Pedras acinzentadas e tocha azul mística
        const blueGlow = Math.max(0, 1 - Math.hypot(x - 520, y - 100) / 260);
        r = Math.min(255, Math.round(18 + blueGlow * 40));
        g = Math.min(255, Math.round(24 + blueGlow * 120));
        b = Math.min(255, Math.round(36 + blueGlow * 220));
        // Tijolos de pedra
        const row = Math.floor(y / 40);
        const colShift = (row % 2) * 45;
        if (y % 40 < 3 || ((x + colShift) % 90 < 3)) {
          r = Math.round(r * 0.5);
          g = Math.round(g * 0.5);
          b = Math.round(b * 0.5);
        }
      } else if (preset === 'floresta_elfica') {
        // Verde profundo e vaga-lumes dourados
        const elfGlow = Math.max(0, 1 - Math.hypot(x - W / 2, y - 100) / 320);
        r = Math.min(255, Math.round(8 + elfGlow * 60));
        g = Math.min(255, Math.round(26 + elfGlow * 150));
        b = Math.min(255, Math.round(18 + elfGlow * 90));
      } else if (preset === 'biblioteca_arcana') {
        // Púrpura cósmico e prateleiras de livros
        const magGlow = Math.max(0, 1 - Math.hypot(x - W / 2, y - H / 2) / 300);
        r = Math.min(255, Math.round(28 + magGlow * 120));
        g = Math.min(255, Math.round(14 + magGlow * 50));
        b = Math.min(255, Math.round(44 + magGlow * 180));
      }

      buf[idx] = r;
      buf[idx + 1] = g;
      buf[idx + 2] = b;
      buf[idx + 3] = 255;
    }
  }

  return writePng(W, H, buf);
}

// Gera os arquivos iniciais para as pastas
const accessoriesToGen = [
  { name: 'coroa_dourada.png', type: 'coroa_dourada' },
  { name: 'chapeu_mago.png', type: 'chapeu_mago' },
  { name: 'elmo_cavaleiro.png', type: 'elmo_cavaleiro' },
  { name: 'chifres_demonio.png', type: 'chifres_demonio' },
  { name: 'tapa_olho_pirata.png', type: 'tapa_olho_pirata' },
  { name: 'mascara_ladino.png', type: 'mascara_ladino' },
  { name: 'barba_ruiva_anao.png', type: 'barba_ruiva_anao' },
  { name: 'mini_dragao_ombro.png', type: 'mini_dragao_ombro' }
];

for (const item of accessoriesToGen) {
  const filePath = path.join(accDir, item.name);
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, createAccessoryPng(item.type));
    console.log(`Acessório gerado: ${item.name}`);
  }
}

const backgroundsToGen = [
  { name: 'taverna_medieval.png', type: 'taverna_medieval' },
  { name: 'masmorra_pedra.png', type: 'masmorra_pedra' },
  { name: 'floresta_elfica.png', type: 'floresta_elfica' },
  { name: 'biblioteca_arcana.png', type: 'biblioteca_arcana' }
];

for (const item of backgroundsToGen) {
  const filePath = path.join(bgDir, item.name);
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, createBackgroundPng(item.type));
    console.log(`Cenário gerado: ${item.name}`);
  }
}

console.log('Pastas e guias de parâmetros criados com sucesso!');

