/**
 * TavernRTC - Electron Main Process (ES Module Wrapper)
 * 
 * Cria ponte segura para carregar o processo principal CommonJS (.cjs)
 * evitando erros de 'require is not defined in ES module scope'.
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);

// Carrega o processo principal CommonJS
require('./main.cjs');
