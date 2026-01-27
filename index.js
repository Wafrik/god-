const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

// Import des modules
const { pool } = require('./dbPool');
const constants = require('./constants');
const utils = require('./utils');
const db = require('./database');
const { findBestMatchFromQueue, scanAndValidateAllSponsorships, incrementBotScoresAutomatically, loadBotScores, recordMatch, canMatchPlayers, updateBotScore } = require('./gameUtils');
const Game = require('./game');
const { handleAdminMessage, handleClientMessage } = require('./handlers');
const routes = require('./routes');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Structures de données globales
const TRUSTED_DEVICES = new Map();
const PLAYER_CONNECTIONS = new Map();
const ADMIN_CONNECTIONS = new Map();
const PLAYER_QUEUE = new Set();
const ACTIVE_GAMES = new Map();
const PLAYER_TO_GAME = new Map();
const BOT_SCORES = new Map();
const BOT_DEPOSITS = new Map();
const PENDING_LOBBIES = new Map();

// Variables globales
let botAutoIncrementInterval = null;
let sponsorshipScanInterval = null;

// Initialisation WebSocket
wss.on('connection', (ws, req) => {
  const ip = req.socket.remoteAddress;
  let deviceId = "unknown";
  let isAdminConnection = false;
  let adminId = null;
  
  ws.send(JSON.stringify({ type: 'connected', message: 'Serveur connecté' }));
  
  ws.on('message', async (data) => {
    try { 
      const message = JSON.parse(data);
      
      if (message.deviceId) {
        deviceId = message.deviceId;
      }
      
      if (message.type === 'admin_authenticate') {
        isAdminConnection = true;
        adminId = 'admin_' + utils.generateId();
        ADMIN_CONNECTIONS.set(adminId, ws);
      }
      
      if (isAdminConnection) {
        await handleAdminMessage(ws, message, adminId, constants.ADMIN_KEY, ADMIN_CONNECTIONS, db, Game, ACTIVE_GAMES, PLAYER_CONNECTIONS, PLAYER_QUEUE, PLAYER_TO_GAME, BOT_DEPOSITS, BOT_SCORES, PENDING_LOBBIES, TRUSTED_DEVICES, scanAndValidateAllSponsorships);
      } else {
        await handleClientMessage(ws, message, ip, deviceId, TRUSTED_DEVICES, PLAYER_CONNECTIONS, ADMIN_CONNECTIONS, PLAYER_QUEUE, ACTIVE_GAMES, PLAYER_TO_GAME, BOT_SCORES, BOT_DEPOSITS, PENDING_LOBBIES, db, utils, findBestMatchFromQueue, createGameLobby, handleGameAction, constants, updateBotScore);
      }
      
    } catch(e) {
      console.error("Erreur parsing message:", e);
    }
  });

  ws.on('close', async () => {
    if (isAdminConnection && adminId) {
      ADMIN_CONNECTIONS.delete(adminId);
    } else {
      const deviceKey = utils.generateDeviceKey(ip, deviceId);
      const disconnectedNumber = TRUSTED_DEVICES.get(deviceKey);
      
      if (disconnectedNumber) {
        console.log(`🔌 Déconnexion WebSocket: ${disconnectedNumber}`);
        
        PLAYER_CONNECTIONS.delete(disconnectedNumber);
        PLAYER_QUEUE.delete(disconnectedNumber);
        
        await db.setUserOnlineStatus(disconnectedNumber, false);
        
        const gameId = PLAYER_TO_GAME.get(disconnectedNumber);
        if (gameId) {
          const game = ACTIVE_GAMES.get(gameId);
          if (game) {
            const player = game.getPlayerByNumber(disconnectedNumber);
            if (player) {
              await game.handlePlayerDisconnect(player);
            }
          }
        }
        
        PLAYER_TO_GAME.delete(disconnectedNumber);
      }
    }
  });
});

// Fonction pour créer un lobby de jeu
async function createGameLobby(playerNumbers, PLAYER_CONNECTIONS, PLAYER_TO_GAME, PLAYER_QUEUE, db, Game, ACTIVE_GAMES, PENDING_LOBBIES) {
  if (!playerNumbers || playerNumbers.length !== 2) {
    console.log(`❌ Données invalides pour créer un lobby`);
    return;
  }
  
  const [player1Number, player2Number] = playerNumbers;
  
  // Vérification finale avant création
  if (PLAYER_TO_GAME.has(player1Number)) {
    console.log(`🚨 ERREUR CRITIQUE: ${player1Number} déjà dans un jeu! Annulation création lobby`);
    PLAYER_QUEUE.delete(player1Number);
    return;
  }
  
  if (PLAYER_TO_GAME.has(player2Number)) {
    console.log(`🚨 ERREUR CRITIQUE: ${player2Number} déjà dans un jeu! Annulation création lobby`);
    PLAYER_QUEUE.delete(player2Number);
    return;
  }
  
  const p1 = await db.getUserByNumber(player1Number);
  const p2 = await db.getUserByNumber(player2Number);
  if (!p1 || !p2) {
    console.log(`❌ Un des joueurs non trouvé en base`);
    return;
  }
  
  const ws1 = PLAYER_CONNECTIONS.get(p1.number);
  const ws2 = PLAYER_CONNECTIONS.get(p2.number);
  
  if (!ws1 || ws1.readyState !== WebSocket.OPEN || !ws2 || ws2.readyState !== WebSocket.OPEN) {
    console.log(`❌ Impossible de créer lobby: un joueur déconnecté`);
    if (!PLAYER_TO_GAME.has(player1Number)) PLAYER_QUEUE.add(player1Number);
    if (!PLAYER_TO_GAME.has(player2Number)) PLAYER_QUEUE.add(player2Number);
    return;
  }
  
  const gameId = utils.generateId();
  console.log(`🎮 Création lobby ${gameId}: ${p1.username} vs ${p2.username}`);
  
  new Game(gameId, p1, p2, PLAYER_CONNECTIONS, PLAYER_TO_GAME, ACTIVE_GAMES, PENDING_LOBBIES, constants, db, recordMatch);
  
  playerNumbers.forEach((num, idx) => {
    const ws = PLAYER_CONNECTIONS.get(num);
    const opponent = idx === 0 ? p2 : p1;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'match_found',
        matchId: gameId,
        opponent: { 
          username: opponent.username, 
          score: opponent.score, 
          number: opponent.number 
        },
        isPlayer1: idx === 0,
        can_cancel: true
      }));
    }
  });
}

// Fonction pour gérer les actions de jeu
function handleGameAction(ws, message, deviceKey, TRUSTED_DEVICES, PLAYER_TO_GAME, ACTIVE_GAMES, WebSocket) {
  const playerNumber = TRUSTED_DEVICES.get(deviceKey);
  if (!playerNumber) return ws.send(JSON.stringify({ type: 'error', message: 'Non identifié' }));
  
  const game = ACTIVE_GAMES.get(PLAYER_TO_GAME.get(playerNumber));
  if (!game) return ws.send(JSON.stringify({ type: 'error', message: 'Aucune partie active' }));
  
  const player = game.getPlayerByNumber(playerNumber);
  if (!player) return ws.send(JSON.stringify({ type: 'error', message: 'Joueur introuvable' }));
  
  const actions = {
    player_move: () => game.makeMove(player, message.data.slotIndex, message.data.value, message.data.combination),
    dice_swap: () => game.swapDice(player, message.data.dieIndexA, message.data.dieIndexB, message.data.combination),
    emoji_used: () => game.handleEmoji(player, message.data.emojiIndex)
  };
  
  actions[message.type]?.();
}

// Configuration des routes
routes.configureRoutes(app, db, pool, constants, PLAYER_CONNECTIONS, PLAYER_QUEUE, ACTIVE_GAMES, PLAYER_TO_GAME, BOT_DEPOSITS, BOT_SCORES, PENDING_LOBBIES, constants.MATCHMAKING_CONFIG, incrementBotScoresAutomatically, scanAndValidateAllSponsorships, getRandomBot, updateBotScore, constants.BOTS);

// Initialisation base de données
async function initializeDatabase() {
  try {
    // Table users
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(50) UNIQUE NOT NULL,
        password VARCHAR(100) NOT NULL,
        number VARCHAR(20) UNIQUE NOT NULL,
        age INTEGER NOT NULL,
        score INTEGER DEFAULT 0,
        online BOOLEAN DEFAULT FALSE,
        token VARCHAR(100),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Table trusted_devices
    await pool.query(`
      CREATE TABLE IF NOT EXISTS trusted_devices (
        id SERIAL PRIMARY KEY,
        device_key VARCHAR(200) UNIQUE NOT NULL,
        user_number VARCHAR(20) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Table recent_matches
    await pool.query(`
      CREATE TABLE IF NOT EXISTS recent_matches (
        id SERIAL PRIMARY KEY,
        player1_number VARCHAR(20) NOT NULL,
        player2_number VARCHAR(20) NOT NULL,
        match_timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(player1_number, player2_number)
      )
    `);

    // Table admin_resets
    await pool.query(`
      CREATE TABLE IF NOT EXISTS admin_resets (
        id SERIAL PRIMARY KEY,
        reset_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        reset_type VARCHAR(50) NOT NULL,
        notes TEXT
      )
    `);

    // Table bot_profiles
    await pool.query(`
      CREATE TABLE IF NOT EXISTS bot_profiles (
        id VARCHAR(50) PRIMARY KEY,
        username VARCHAR(50) NOT NULL,
        gender VARCHAR(1) NOT NULL,
        base_score INTEGER DEFAULT 100,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Table bot_scores
    await pool.query(`
      CREATE TABLE IF NOT EXISTS bot_scores (
        id SERIAL PRIMARY KEY,
        bot_id VARCHAR(50) UNIQUE NOT NULL,
        score INTEGER DEFAULT 0,
        last_played TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_auto_increment TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (bot_id) REFERENCES bot_profiles(id) ON DELETE CASCADE
      )
    `);

    // Table sponsorships
    await pool.query(`
      CREATE TABLE IF NOT EXISTS sponsorships (
        id SERIAL PRIMARY KEY,
        sponsor_number VARCHAR(20) NOT NULL,
        sponsored_number VARCHAR(20) UNIQUE NOT NULL,
        is_validated BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        validated_at TIMESTAMP,
        FOREIGN KEY (sponsor_number) REFERENCES users(number) ON DELETE CASCADE,
        FOREIGN KEY (sponsored_number) REFERENCES users(number) ON DELETE CASCADE
      )
    `);

    // Table sponsorship_stats
    await pool.query(`
      CREATE TABLE IF NOT EXISTS sponsorship_stats (
        id SERIAL PRIMARY KEY,
        player_number VARCHAR(20) UNIQUE NOT NULL,
        total_sponsored INTEGER DEFAULT 0,
        validated_sponsored INTEGER DEFAULT 0,
        last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (player_number) REFERENCES users(number) ON DELETE CASCADE
      )
    `);

    // Table sponsorship_validated_history
    await pool.query(`
      CREATE TABLE IF NOT EXISTS sponsorship_validated_history (
        id SERIAL PRIMARY KEY,
        sponsor_number VARCHAR(20) NOT NULL,
        sponsored_number VARCHAR(20) UNIQUE NOT NULL,
        validated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (sponsor_number) REFERENCES users(number) ON DELETE CASCADE,
        FOREIGN KEY (sponsored_number) REFERENCES users(number) ON DELETE CASCADE
      )
    `);

    // Table blacklisted_numbers
    await pool.query(`
      CREATE TABLE IF NOT EXISTS blacklisted_numbers (
        id SERIAL PRIMARY KEY,
        number VARCHAR(20) UNIQUE NOT NULL,
        original_username VARCHAR(50),
        reason TEXT,
        banned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Table admin_sponsorship_adjustments
    await pool.query(`
      CREATE TABLE IF NOT EXISTS admin_sponsorship_adjustments (
        id SERIAL PRIMARY KEY,
        admin_key VARCHAR(100) NOT NULL,
        player_number VARCHAR(20) NOT NULL,
        adjustment INTEGER NOT NULL,
        old_value INTEGER NOT NULL,
        new_value INTEGER NOT NULL,
        reason TEXT,
        adjusted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Créer des index
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_recent_matches_timestamp 
      ON recent_matches(match_timestamp)
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_recent_matches_players 
      ON recent_matches(player1_number, player2_number)
    `);

    // Insérer les bots
    for (const bot of constants.BOTS) {
      await pool.query(`
        INSERT INTO bot_profiles (id, username, gender, base_score) 
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (id) DO UPDATE SET
          username = EXCLUDED.username,
          gender = EXCLUDED.gender,
          base_score = EXCLUDED.base_score
      `, [bot.id, bot.username, bot.gender, bot.baseScore]);
      
      await pool.query(`
        INSERT INTO bot_scores (bot_id, score) 
        VALUES ($1, $2)
        ON CONFLICT (bot_id) DO NOTHING
      `, [bot.id, bot.baseScore]);
    }

    // Insérer un reset initial si aucun existe
    const resetCheck = await pool.query('SELECT COUNT(*) FROM admin_resets');
    if (parseInt(resetCheck.rows[0].count) === 0) {
      await pool.query(`
        INSERT INTO admin_resets (reset_date, reset_type, notes) 
        VALUES (CURRENT_TIMESTAMP, 'initial', 'Reset initial système')
      `);
    }

    console.log('✅ Base de données initialisée avec système de suppression et liste noire');

  } catch (error) {
    console.error('Erreur init DB:', error);
    throw error;
  }
}

async function loadTrustedDevices() {
  try {
    const result = await pool.query('SELECT * FROM trusted_devices');
    result.rows.forEach(row => {
      TRUSTED_DEVICES.set(row.device_key, row.user_number);
    });
  } catch (error) {
    console.error('Erreur chargement devices:', error);
  }
}

// Fonction pour obtenir un bot aléatoire
function getRandomBot(BOTS, BOT_SCORES) {
  const randomBot = BOTS[Math.floor(Math.random() * BOTS.length)];
  const botScore = BOT_SCORES.get(randomBot.id) || randomBot.baseScore;
  return { ...randomBot, score: botScore, is_bot: true };
}

// Démarrer le serveur
async function startServer() {
  try {
    await initializeDatabase();
    await loadTrustedDevices();
    await loadBotScores(pool, BOT_SCORES);
    
    sponsorshipScanInterval = setInterval(scanAndValidateAllSponsorships, constants.SPONSORSHIP_SCAN_INTERVAL);
    
    setTimeout(() => {
      scanAndValidateAllSponsorships(pool, constants, PLAYER_CONNECTIONS, WebSocket);
    }, 10 * 1000);
    
    botAutoIncrementInterval = setInterval(incrementBotScoresAutomatically, constants.BOT_INCREMENT_INTERVAL);
    
    setTimeout(() => {
      incrementBotScoresAutomatically(pool, BOT_SCORES);
    }, 60 * 1000);
    
    server.listen(constants.PORT, '0.0.0.0', () => {
      console.log(`=========================================`);
      console.log(`✅ Serveur démarré sur port ${constants.PORT}`);
      console.log(`🤖 ${constants.BOTS.length} adversaires disponibles`);
      console.log(`🎮 SYSTÈME PVP AMÉLIORÉ`);
      console.log(`   • Abandon en 1v1: -${constants.PVP_QUIT_PENALTY} points (TOUJOURS)`);
      console.log(`   • Victime d'abandon: +${constants.AUTO_MOVE_BONUS} points bonus`);
      console.log(`💰 SYSTÈME BOTS AVEC CAUTION`);
      console.log(`   • Caution flexible: max ${constants.BOT_DEPOSIT} points`);
      console.log(`   • Logique différente selon score (≥10k ou <10k)`);
      console.log(`⚙️  SYSTÈME ANTI-MATCH RAPIDE PERSISTANT`);
      console.log(`   • Activé: ${constants.MATCHMAKING_CONFIG.anti_quick_rematch ? 'OUI' : 'NON'}`);
      console.log(`   • Délai: ${constants.MATCHMAKING_CONFIG.min_rematch_delay / 60000} minutes`);
      console.log(`📊 RESTRICTIONS DE SCORE`);
      console.log(`   • ≥${constants.HIGH_SCORE_THRESHOLD} points → ne rencontre pas <${constants.LOW_SCORE_THRESHOLD} points`);
      console.log(`🔒 NOUVELLES FONCTIONNALITÉS ADMIN`);
      console.log(`   • Suppression compte avec liste noire`);
      console.log(`   • Ajustement manuel compteur parrainage`);
      console.log(`   • Gestion liste noire complète`);
      console.log(`=========================================`);
    });
  } catch (error) {
    console.error('❌ Erreur démarrage:', error);
    process.exit(1);
  }
}

// Gestion des signaux
process.on('SIGTERM', () => {
  if (botAutoIncrementInterval) clearInterval(botAutoIncrementInterval);
  if (sponsorshipScanInterval) clearInterval(sponsorshipScanInterval);
  server.close(() => {
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  if (botAutoIncrementInterval) clearInterval(botAutoIncrementInterval);
  if (sponsorshipScanInterval) clearInterval(sponsorshipScanInterval);
  server.close(() => {
    process.exit(0);
  });
});

startServer();

// Export pour les tests si besoin
module.exports = {
  app,
  server,
  wss,
  TRUSTED_DEVICES,
  PLAYER_CONNECTIONS,
  ADMIN_CONNECTIONS,
  PLAYER_QUEUE,
  ACTIVE_GAMES,
  PLAYER_TO_GAME,
  BOT_SCORES,
  BOT_DEPOSITS,
  PENDING_LOBBIES
};
