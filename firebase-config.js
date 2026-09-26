/**
 * TavernRTC - Firebase Signaling Configuration
 * 
 * Este arquivo gerencia a inicialização do Firebase para sinalização WebRTC
 * (troca de SDP Offers, Answers e ICE Candidates).
 * 
 * Instruções para uso gratuito:
 * 1. Crie um projeto gratuito em https://console.firebase.google.com
 * 2. Crie uma instância do "Realtime Database" (modo de teste para leitura/escrita)
 * 3. Cole suas credenciais abaixo ou através do modal de Configurações no app.
 */

// Gerenciamento de módulos Firebase carregados sob demanda
let fbAppModule = null;
let fbDbModule = null;

/**
 * Carrega os módulos do Firebase dinamicamente (seguro para Electron e navegador)
 */
export async function getFirebaseModules() {
  if (fbAppModule && fbDbModule) {
    return { app: fbAppModule, db: fbDbModule };
  }
  try {
    const [appMod, dbMod] = await Promise.all([
      import('firebase/app'),
      import('firebase/database')
    ]);
    fbAppModule = appMod;
    fbDbModule = dbMod;
    return { app: fbAppModule, db: fbDbModule };
  } catch (err) {
    console.warn('[Firebase] Módulos remotos do Firebase não carregados (modo local Mesh ativado):', err);
    return null;
  }
}

// Chave para persistência interna caso desenvolvedor precise
const STORAGE_KEY_FIREBASE = 'sussurro_firebase_config';

// Configuração embutida do Firebase - Projeto Sussurro do Usuário
// Conectado diretamente ao Realtime Database criado em modo de teste:
// https://console.firebase.google.com/project/sussurro-4ef44/database/sussurro-4ef44-default-rtdb/data/~2F
export const BUILTIN_FIREBASE_CONFIG = {
  apiKey: "AIzaSyANv0zE1zUcRUAht2xfV0lE0ttP0pQ6zYg",
  authDomain: "sussurro-4ef44.firebaseapp.com",
  databaseURL: "https://sussurro-4ef44-default-rtdb.firebaseio.com",
  projectId: "sussurro-4ef44",
  storageBucket: "sussurro-4ef44.firebasestorage.app",
  messagingSenderId: "665822907696",
  appId: "1:665822907696:web:ad2b091714600783f6ccf5"
};

/**
 * Obtém a configuração ativa (diretamente embutida no programa)
 */
export function getStoredFirebaseConfig() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY_FIREBASE);
    if (saved) {
      const parsed = JSON.parse(saved);
      if (parsed && typeof parsed === 'object' && !parsed.databaseURL?.includes('seu-projeto-rpg')) {
        return { ...BUILTIN_FIREBASE_CONFIG, ...parsed };
      }
    }
  } catch (err) {
    console.warn('[FirebaseConfig] Falha ao ler configuração:', err);
  }
  return BUILTIN_FIREBASE_CONFIG;
}

/**
 * Salva uma nova configuração personalizada de Firebase
 */
export function saveFirebaseConfig(newConfig) {
  try {
    localStorage.setItem(STORAGE_KEY_FIREBASE, JSON.stringify(newConfig));
    return true;
  } catch (err) {
    console.error('[FirebaseConfig] Erro ao salvar configuração:', err);
    return false;
  }
}

/**
 * Restaura a configuração padrão
 */
export function resetFirebaseConfig() {
  try {
    localStorage.removeItem(STORAGE_KEY_FIREBASE);
    return true;
  } catch (err) {
    return false;
  }
}

/**
 * Verifica se o Firebase está configurado com credenciais válidas e não é apenas o placeholder
 */
export function isFirebaseConfigured(config = null) {
  const cfg = config || getStoredFirebaseConfig();
  if (!cfg || !cfg.databaseURL) return false;
  const isPlaceholder = cfg.databaseURL.includes('seu-projeto-rpg') ||
                        cfg.projectId.includes('seu-projeto-rpg');
  return !isPlaceholder;
}

let currentApp = null;
let currentDb = null;

/**
 * Inicializa a instância do Firebase App e do Realtime Database sob demanda
 */
export async function initFirebase() {
  const config = getStoredFirebaseConfig();
  
  if (!isFirebaseConfigured(config)) {
    console.info('[Firebase] Configuração padrão detectada. Usando sinalização P2P local Mesh.');
    return { app: null, db: null, isConfigured: false, config };
  }

  try {
    const mods = await getFirebaseModules();
    if (!mods) {
      console.warn('[Firebase] Não foi possível carregar o SDK do Firebase. Usando modo Mesh local.');
      return { app: null, db: null, isConfigured: false, config };
    }

    const { initializeApp, getApps, getApp } = mods.app;
    const { getDatabase } = mods.db;

    if (getApps().length === 0) {
      currentApp = initializeApp(config);
    } else {
      currentApp = getApp();
    }
    currentDb = getDatabase(currentApp);
    console.log('[Firebase] Realtime Database inicializado com sucesso.');
    return { app: currentApp, db: currentDb, isConfigured: true, config };
  } catch (err) {
    console.error('[Firebase] Erro ao inicializar SDK:', err);
    return { app: null, db: null, isConfigured: false, config, error: err.message };
  }
}

// Wrappers resilientes para operações do Realtime Database
export function ref(db, path) {
  if (fbDbModule && db) return fbDbModule.ref(db, path);
  return { db, path };
}

export function set(refObj, value) {
  if (fbDbModule && refObj && typeof fbDbModule.set === 'function') {
    return fbDbModule.set(refObj, value);
  }
  return Promise.resolve();
}

export function get(refObj) {
  if (fbDbModule && refObj && typeof fbDbModule.get === 'function') {
    return fbDbModule.get(refObj);
  }
  return Promise.resolve({ val: () => null, exists: () => false });
}

export function child(refObj, path) {
  if (fbDbModule && refObj && typeof fbDbModule.child === 'function') {
    return fbDbModule.child(refObj, path);
  }
  return { ...refObj, path };
}

export function onValue(refObj, callback) {
  if (fbDbModule && refObj && typeof fbDbModule.onValue === 'function') {
    return fbDbModule.onValue(refObj, callback);
  }
  return () => {};
}

export function onChildAdded(refObj, callback) {
  if (fbDbModule && refObj && typeof fbDbModule.onChildAdded === 'function') {
    return fbDbModule.onChildAdded(refObj, callback);
  }
  return () => {};
}

export function onChildChanged(refObj, callback) {
  if (fbDbModule && refObj && typeof fbDbModule.onChildChanged === 'function') {
    return fbDbModule.onChildChanged(refObj, callback);
  }
  return () => {};
}

export function onChildRemoved(refObj, callback) {
  if (fbDbModule && refObj && typeof fbDbModule.onChildRemoved === 'function') {
    return fbDbModule.onChildRemoved(refObj, callback);
  }
  return () => {};
}

export function remove(refObj) {
  if (fbDbModule && refObj && typeof fbDbModule.remove === 'function') {
    return fbDbModule.remove(refObj);
  }
  return Promise.resolve();
}

export function onDisconnect(refObj) {
  if (fbDbModule && refObj && typeof fbDbModule.onDisconnect === 'function') {
    return fbDbModule.onDisconnect(refObj);
  }
  return { 
    remove: () => Promise.resolve(), 
    set: () => Promise.resolve(), 
    cancel: () => Promise.resolve() 
  };
}
