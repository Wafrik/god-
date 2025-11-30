const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// 🗄️ CONFIGURATION POSTGRESQL POUR RENDER
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Test de la connexion PostgreSQL
pool.on('connect', () => {
  console.log('✅ Connecté à PostgreSQL');
});

pool.on('error', (err) => {
  console.error('❌ Erreur PostgreSQL:', err);
});

const PORT = process.env.PORT || 8000;

// Structures en mémoire
const TRUSTED_DEVICES = new Map();
const PLAYER_CONNECTIONS = new Map();
const PLAYER_QUEUE = new Set();
const ACTIVE_GAMES = new Map();
const PLAYER_TO_GAME = new Map();

// 🗄️ INITIALISATION DE LA BASE DE DONNÉES
async function initializeDatabase() {
  try {
    // Table des utilisateurs
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

    // Table des appareils de confiance
    await pool.query(`
      CREATE TABLE IF NOT EXISTS trusted_devices (
        id SERIAL PRIMARY KEY,
        device_key VARCHAR(200) UNIQUE NOT NULL,
        user_number VARCHAR(20) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_number) REFERENCES users(number) ON DELETE CASCADE
      )
    `);

    console.log('🗄️ Base de données initialisée');
  } catch (error) {
    console.error('❌ Erreur initialisation base de données:', error);
  }
}

// Utilitaires optimisés
const generateId = () => Math.random().toString(36).substring(2, 15);
const generateDeviceKey = (ip, deviceId) => {
  if (ip.includes('127.0.0.1') || ip.includes('::1') || ip === '::ffff:127.0.0.1') {
    return `web_${deviceId}`;
  }
  return `${ip}_${deviceId}`;
};

// 🗄️ FONCTIONS DATABASE
const db = {
  // Utilisateurs
  async getUserByNumber(number) {
    const result = await pool.query('SELECT * FROM users WHERE number = $1', [number]);
    return result.rows[0];
  },

  async getUserByUsername(username) {
    const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
    return result.rows[0];
  },

  async getUserByToken(token) {
    const result = await pool.query('SELECT * FROM users WHERE token = $1', [token]);
    return result.rows[0];
  },

  async createUser(userData) {
    const { username, password, number, age } = userData;
    const result = await pool.query(
      `INSERT INTO users (username, password, number, age, score, online, token) 
       VALUES ($1, $2, $3, $4, $5, $6, $7) 
       RETURNING *`,
      [username, password, number, age, 0, true, generateId() + generateId()]
    );
    return result.rows[0];
  },

  async updateUserScore(number, newScore) {
    await pool.query(
      'UPDATE users SET score = $1, updated_at = CURRENT_TIMESTAMP WHERE number = $2',
      [newScore, number]
    );
  },

  async setUserOnlineStatus(number, online) {
    await pool.query(
      'UPDATE users SET online = $1, updated_at = CURRENT_TIMESTAMP WHERE number = $2',
      [online, number]
    );
  },

  async updateUserToken(number, token) {
    await pool.query(
      'UPDATE users SET token = $1, updated_at = CURRENT_TIMESTAMP WHERE number = $2',
      [token, number]
    );
  },

  // Appareils de confiance
  async getTrustedDevice(deviceKey) {
    const result = await pool.query(
      'SELECT * FROM trusted_devices WHERE device_key = $1',
      [deviceKey]
    );
    return result.rows[0];
  },

  async createTrustedDevice(deviceKey, userNumber) {
    await pool.query(
      'INSERT INTO trusted_devices (device_key, user_number) VALUES ($1, $2) ON CONFLICT (device_key) DO UPDATE SET user_number = $2',
      [deviceKey, userNumber]
    );
  },

  async deleteTrustedDevice(deviceKey) {
    await pool.query('DELETE FROM trusted_devices WHERE device_key = $1', [deviceKey]);
  },

  // Classement
  async getLeaderboard() {
    const result = await pool.query(
      'SELECT username, score FROM users WHERE score >= 0 ORDER BY score DESC LIMIT 100'
    );
    return result.rows;
  }
};

// Chargement des appareils de confiance au démarrage
async function loadTrustedDevices() {
  try {
    const result = await pool.query('SELECT * FROM trusted_devices');
    result.rows.forEach(row => {
      TRUSTED_DEVICES.set(row.device_key, row.user_number);
    });
    console.log(`📱 ${result.rows.length} appareils de confiance chargés`);
  } catch (error) {
    console.error('❌ Erreur chargement appareils de confiance:', error);
  }
}

// Classe Game (identique mais avec appels DB)
class Game {
  constructor(id, p1, p2) {
    Object.assign(this, {
      id, players: [], phase: 'waiting', manche: 1, maxManches: 3, turn: null,
      scores: { player1: 0, player2: 0 }, playerCombinations: { player1: null, player2: null },
      availableSlots: { player1: [1,2,3,4,5,6], player2: [1,2,3,4,5,6] },
      preparationTime: 20, turnTime: 30, selectionsThisManche: 0, maxSelections: 3, timerInterval: null
    });
    
    [p1, p2].forEach((p, i) => {
      const player = {...p, ws: PLAYER_CONNECTIONS.get(p.number), role: i === 0 ? 'player1' : 'player2'};
      this.players.push(player);
      PLAYER_TO_GAME.set(p.number, id);
    });
    
    ACTIVE_GAMES.set(id, this);
    console.log(`🎮 Lobby ${id} créé: ${p1.username} vs ${p2.username}`);
    setTimeout(() => this.checkAndStartGame(), 1000);
  }

  broadcast(msg) {
    this.players.forEach(p => p.ws?.readyState === WebSocket.OPEN && p.ws.send(JSON.stringify(msg)));
  }

  broadcastGameState() {
    this.players.forEach(p => {
      if (p.ws?.readyState === WebSocket.OPEN) {
        const oppRole = p.role === 'player1' ? 'player2' : 'player1';
        const oppCombo = this.playerCombinations[oppRole] || [1,1,1,1,1,1];
        p.ws.send(JSON.stringify({
          type: 'game_state', gameState: {
            phase: this.phase, manche: this.manche, turn: this.turn, scores: this.scores,
            slotContents: oppCombo, availableSlots: this.availableSlots[p.role]
          }, player: { id: p.number, role: p.role }
        }));
      }
    });
  }

  checkAndStartGame() {
    if (this.players.filter(p => p.ws?.readyState === WebSocket.OPEN).length === 2 && this.phase === 'waiting') {
      this.phase = 'preparation';
      this.broadcast({ type: 'game_start' });
      this.broadcastGameState();
      this.startPreparationTimer();
    }
  }

  startPreparationTimer() {
    let timeLeft = this.preparationTime;
    this.broadcast({ type: 'timer_update', timer: timeLeft });
    this.timerInterval = setInterval(() => {
      if (--timeLeft <= 0) {
        clearInterval(this.timerInterval);
        this.startPlaying();
      } else {
        this.broadcast({ type: 'timer_update', timer: timeLeft });
      }
    }, 1000);
  }

  startPlaying() {
    this.phase = 'playing';
    this.turn = Math.random() > 0.5 ? 'player1' : 'player2';
    this.broadcast({ type: 'phase_change', phase: 'playing' });
    this.broadcast({ type: 'turn_change', turn: this.turn });
    this.broadcastGameState();
    this.startTurnTimer();
  }

  startTurnTimer() {
    let timeLeft = this.turnTime;
    this.broadcast({ type: 'timer_update', timer: timeLeft });
    this.timerInterval = setInterval(() => {
      if (--timeLeft <= 0) {
        clearInterval(this.timerInterval);
        const player = this.players.find(p => p.role === this.turn);
        player ? this.makeAutomaticMove(player) : this.endTurn();
      } else {
        this.broadcast({ type: 'timer_update', timer: timeLeft });
      }
    }, 1000);
  }

  makeMove(player, slotIndex, value, combination) {
    if (this.phase !== 'playing' || this.turn !== player.role) return false;
    
    const slot = parseInt(slotIndex);
    if (!this.availableSlots[player.role].includes(slot)) return false;

    // Mise à jour combinaison
    if (combination) {
      const parts = combination.split('-');
      if (parts.length === 6) this.playerCombinations[player.role] = parts.map(Number);
    }

    // Initialisation combinaisons si manquantes
    const oppRole = player.role === 'player1' ? 'player2' : 'player1';
    if (!this.playerCombinations.player1) this.playerCombinations.player1 = [1,2,3,4,5,6];
    if (!this.playerCombinations.player2) this.playerCombinations.player2 = [1,2,3,4,5,6];

    const arrayIndex = slot - 1;
    if (arrayIndex < 0 || arrayIndex >= 6) return false;

    const realValue = this.playerCombinations[oppRole][arrayIndex];
    this.availableSlots[player.role] = this.availableSlots[player.role].filter(s => s !== slot);
    this.scores[player.role] += realValue;
    this.selectionsThisManche++;

    // Notification aux joueurs
    this.players.forEach(p => {
      if (p.ws?.readyState === WebSocket.OPEN) {
        const isCurrentPlayer = p.role === player.role;
        p.ws.send(JSON.stringify({
          type: 'move_made', data: {
            player: player.role, slotIndex: slot, value: realValue,
            newScore: this.scores[player.role],
            actionType: isCurrentPlayer ? 'reveal_die' : 'remove_die',
            target: isCurrentPlayer ? 'opponent_slot' : 'player_die',
            dieIndex: realValue, availableSlots: this.availableSlots[p.role]
          }
        }));
      }
    });

    this.broadcastGameState();
    this.selectionsThisManche >= this.maxSelections * 2 ? this.endManche() : this.endTurn();
    return true;
  }

  makeAutomaticMove(player) {
    const slots = this.availableSlots[player.role];
    if (slots.length === 0) { this.endTurn(); return false; }
    const randomSlot = slots[Math.floor(Math.random() * slots.length)];
    return this.makeMove(player, randomSlot, 0, null);
  }

  swapDice(player, dieIndexA, dieIndexB, combination) {
    const a = parseInt(dieIndexA) - 1, b = parseInt(dieIndexB) - 1;
    if (a >= 0 && a < 6 && b >= 0 && b < 6) {
      if (combination) {
        const parts = combination.split('-');
        if (parts.length === 6) this.playerCombinations[player.role] = parts.map(Number);
      } else if (this.playerCombinations[player.role]) {
        [this.playerCombinations[player.role][a], this.playerCombinations[player.role][b]] = 
        [this.playerCombinations[player.role][b], this.playerCombinations[player.role][a]];
      }
      this.broadcast({ type: 'dice_swapped', data: { dieIndexA, dieIndexB } });
      this.broadcastGameState();
    }
  }

  handleEmoji(player, emojiIndex) {
    this.players.forEach(p => {
      if (p.ws?.readyState === WebSocket.OPEN && p.role !== player.role) {
        p.ws.send(JSON.stringify({
          type: 'emoji_used', data: { player: player.role, emojiIndex }
        }));
      }
    });
  }

  async handlePlayerDisconnect(disconnectedPlayer) {
    const remainingPlayer = this.players.find(p => p.number !== disconnectedPlayer.number);
    if (remainingPlayer?.ws?.readyState === WebSocket.OPEN) {
      remainingPlayer.ws.send(JSON.stringify({ type: 'opponent_left', message: 'Adversaire a quitté la partie' }));
      setTimeout(() => this._endGameByDisconnect(disconnectedPlayer, remainingPlayer), 10000);
    } else {
      this.cleanup();
    }
  }

  async _endGameByDisconnect(disconnectedPlayer, remainingPlayer) {
    await this._applyDisconnectPenalties(disconnectedPlayer, remainingPlayer);
    this.broadcast({ type: 'game_end', data: { scores: this.scores, winner: remainingPlayer.role } });
    setTimeout(() => this.cleanup(), 5000);
  }

  async _applyDisconnectPenalties(disconnectedPlayer, remainingPlayer) {
    try {
      const disconnectedUser = await db.getUserByNumber(disconnectedPlayer.number);
      const remainingUser = await db.getUserByNumber(remainingPlayer.number);
      
      if (disconnectedUser && remainingUser) {
        const disconnectedScore = this.scores[disconnectedPlayer.role];
        const remainingScore = this.scores[remainingPlayer.role];
        
        const newDisconnectedScore = Math.max(0, disconnectedUser.score - (disconnectedScore > 15 ? disconnectedScore : 15));
        const newRemainingScore = remainingUser.score + (remainingScore < 15 ? 15 : remainingScore);
        
        await db.updateUserScore(disconnectedPlayer.number, newDisconnectedScore);
        await db.updateUserScore(remainingPlayer.number, newRemainingScore);
      }
    } catch (error) {
      console.error('❌ Erreur application pénalités déconnexion:', error);
    }
  }

  endTurn() {
    if (this.timerInterval) clearInterval(this.timerInterval);
    this.turn = this.turn === 'player1' ? 'player2' : 'player1';
    this.broadcast({ type: 'turn_change', turn: this.turn });
    this.broadcastGameState();
    this.startTurnTimer();
  }

  endManche() {
    if (this.timerInterval) clearInterval(this.timerInterval);
    this.broadcast({ type: 'manche_end', manche: this.manche, scores: this.scores });
    this.broadcastGameState();
    this.manche >= this.maxManches ? setTimeout(() => this.endGame(), 2000) : (this.manche++, setTimeout(() => this.startNewManche(), 2000));
  }

  startNewManche() {
    Object.assign(this, {
      playerCombinations: { player1: null, player2: null },
      availableSlots: { player1: [1,2,3,4,5,6], player2: [1,2,3,4,5,6] },
      selectionsThisManche: 0, phase: 'preparation'
    });
    this.broadcastGameState();
    this.startPreparationTimer();
  }

  async endGame() {
    let winner = 'draw';
    if (this.scores.player1 > this.scores.player2) winner = 'player1';
    else if (this.scores.player2 > this.scores.player1) winner = 'player2';
    
    await this._updatePlayerScores(winner);
    this.broadcast({ type: 'game_end', data: { scores: this.scores, winner } });
    setTimeout(() => this.cleanup(), 5000);
  }

  async _updatePlayerScores(winner) {
    try {
      for (const player of this.players) {
        const user = await db.getUserByNumber(player.number);
        if (user) {
          if (winner === 'draw') continue;
          
          const totalScore = this.scores[player.role];
          const newScore = winner === player.role ? 
            user.score + totalScore : 
            Math.max(0, user.score - totalScore);
          
          await db.updateUserScore(player.number, newScore);
        }
      }
    } catch (error) {
      console.error('❌ Erreur mise à jour scores:', error);
    }
  }

  cleanup() {
    if (this.timerInterval) clearInterval(this.timerInterval);
    this.players.forEach(p => PLAYER_TO_GAME.delete(p.number));
    ACTIVE_GAMES.delete(this.id);
  }

  getPlayerByNumber(n) { return this.players.find(p => p.number === n); }
}

// WebSocket avec système de TOKEN
wss.on('connection', (ws, req) => {
  const ip = req.socket.remoteAddress;
  let deviceId = "unknown";
  
  console.log(`🌐 Nouvelle connexion depuis: ${ip}`);
  
  // Envoyer un message de bienvenue
  ws.send(JSON.stringify({ type: 'connected', message: 'Serveur connecté' }));
  
  ws.on('message', async (data) => {
    try { 
      const message = JSON.parse(data);
      
      // Récupérer le deviceId du message
      if (message.deviceId) {
        deviceId = message.deviceId;
      }
      
      await handleClientMessage(ws, message, ip, deviceId); 
    } catch(e) {
      console.error("❌ Erreur parsing message:", e);
    }
  });

  ws.on('close', async () => {
    setTimeout(async () => {
      const deviceKey = generateDeviceKey(ip, deviceId);
      const disconnectedNumber = TRUSTED_DEVICES.get(deviceKey);
      
      if (disconnectedNumber) {
        PLAYER_CONNECTIONS.delete(disconnectedNumber);
        PLAYER_QUEUE.delete(disconnectedNumber);
        
        // Marquer comme hors ligne
        await db.setUserOnlineStatus(disconnectedNumber, false);
        
        // Gérer la déconnexion du jeu
        const gameId = PLAYER_TO_GAME.get(disconnectedNumber);
        const game = ACTIVE_GAMES.get(gameId);
        const player = game?.getPlayerByNumber(disconnectedNumber);
        if (player) await game.handlePlayerDisconnect(player);
        PLAYER_TO_GAME.delete(disconnectedNumber);
        
        console.log(`🔴 Déconnexion: ${disconnectedNumber} (${deviceKey})`);
      }
    }, 10000);
  });
});

// Gestion messages avec TOKEN PRINCIPAL
async function handleClientMessage(ws, message, ip, deviceId) {
  const deviceKey = generateDeviceKey(ip, deviceId);
  
  console.log(`🔑 Message ${message.type} - Device: ${deviceId}`);
  if (message.token) {
    console.log(`🔑 Token fourni: ${message.token.substring(0, 10)}...`);
  }
  
  const handlers = {
    authenticate: async () => {
      const user = await db.getUserByNumber(message.number);
      if (user && user.password === message.password) {
        // GÉNÉRER OU METTRE À JOUR LE TOKEN
        if (!user.token) {
          const newToken = generateId() + generateId();
          await db.updateUserToken(user.number, newToken);
          user.token = newToken;
          console.log(`🔑 Nouveau token généré pour ${user.username}`);
        }
        
        // Sauvegarder l'association device → user
        TRUSTED_DEVICES.set(deviceKey, message.number);
        await db.createTrustedDevice(deviceKey, message.number);
        
        PLAYER_CONNECTIONS.set(message.number, ws);
        await db.setUserOnlineStatus(message.number, true);
        
        ws.send(JSON.stringify({ 
          type: 'auth_success', 
          username: user.username, 
          score: user.score, 
          number: user.number,
          token: user.token
        }));
        
        console.log(`✅ Connexion: ${user.username} (Token activé)`);
      } else {
        ws.send(JSON.stringify({ type: 'auth_failed', message: 'Numéro ou mot de passe incorrect' }));
      }
    },
    
    register: async () => {
      const { username, password, confirmPassword, number, age } = message;
      if (!username || !password || !confirmPassword || !number || !age) {
        ws.send(JSON.stringify({ type: 'register_failed', message: "Tous les champs sont requis" }));
      } else if (password !== confirmPassword) {
        ws.send(JSON.stringify({ type: 'register_failed', message: "Mots de passe différents" }));
      } else if (await db.getUserByUsername(username)) {
        ws.send(JSON.stringify({ type: 'register_failed', message: "Pseudo déjà utilisé" }));
      } else if (await db.getUserByNumber(number)) {
        ws.send(JSON.stringify({ type: 'register_failed', message: "Numéro déjà utilisé" }));
      } else {
        try {
          const newUser = await db.createUser({ username, password, number, age: parseInt(age) });
          
          // Sauvegarder l'association device → user
          TRUSTED_DEVICES.set(deviceKey, number);
          await db.createTrustedDevice(deviceKey, number);
          
          PLAYER_CONNECTIONS.set(number, ws);
          
          ws.send(JSON.stringify({ 
            type: 'register_success', 
            message: "Inscription réussie", 
            username, 
            score: 0, 
            number,
            token: newUser.token
          }));
          
          console.log(`✅ Inscription: ${username} (Token créé)`);
        } catch (error) {
          console.error('❌ Erreur inscription:', error);
          ws.send(JSON.stringify({ type: 'register_failed', message: "Erreur lors de l'inscription" }));
        }
      }
    },

    logout: async () => {
      const playerNumber = TRUSTED_DEVICES.get(deviceKey);
      if (playerNumber) {
        // Supprimer l'appareil des devices trusted
        TRUSTED_DEVICES.delete(deviceKey);
        await db.deleteTrustedDevice(deviceKey);
        
        // Supprimer la connexion
        PLAYER_CONNECTIONS.delete(playerNumber);
        PLAYER_QUEUE.delete(playerNumber);
        
        // Marquer comme hors ligne dans la base
        await db.setUserOnlineStatus(playerNumber, false);
        
        // Gérer la déconnexion du jeu si en cours
        const gameId = PLAYER_TO_GAME.get(playerNumber);
        const game = ACTIVE_GAMES.get(gameId);
        const player = game?.getPlayerByNumber(playerNumber);
        if (player) await game.handlePlayerDisconnect(player);
        PLAYER_TO_GAME.delete(playerNumber);
        
        console.log(`🚪 Déconnexion manuelle: ${playerNumber}`);
        
        // Envoyer confirmation
        ws.send(JSON.stringify({ type: 'logout_success', message: 'Déconnexion réussie' }));
      } else {
        ws.send(JSON.stringify({ type: 'error', message: 'Non authentifié' }));
      }
    },
    
    auto_login: async () => {
      // PRIORITÉ ABSOLUE AU TOKEN
      if (message.token) {
        const user = await db.getUserByToken(message.token);
        
        if (user) {
          PLAYER_CONNECTIONS.set(user.number, ws);
          await db.setUserOnlineStatus(user.number, true);
          
          // Sauvegarder aussi l'association device (pour compatibilité)
          if (deviceId && deviceId !== "unknown") {
            TRUSTED_DEVICES.set(deviceKey, user.number);
            await db.createTrustedDevice(deviceKey, user.number);
          }
          
          ws.send(JSON.stringify({ 
            type: 'auto_login_success', 
            username: user.username, 
            score: user.score, 
            number: user.number,
            token: user.token
          }));
          
          // Reconnexion lobby si en jeu
          const gameId = PLAYER_TO_GAME.get(user.number);
          const game = ACTIVE_GAMES.get(gameId);
          const player = game?.getPlayerByNumber(user.number);
          if (player) { 
            player.ws = ws; 
            game.broadcastGameState(); 
          }
          
          console.log(`🔄 Auto-login PAR TOKEN: ${user.username}`);
          return;
        } else {
          console.log(`❌ Token invalide: ${message.token.substring(0, 10)}...`);
          ws.send(JSON.stringify({ type: 'auto_login_failed', message: 'Token invalide' }));
          return;
        }
      }
      
      // FALLBACK: ancien système par device (pour compatibilité)
      const trustedNumber = TRUSTED_DEVICES.get(deviceKey);
      if (trustedNumber) {
        const user = await db.getUserByNumber(trustedNumber);
        if (user) {
          PLAYER_CONNECTIONS.set(trustedNumber, ws);
          await db.setUserOnlineStatus(trustedNumber, true);
          
          // S'assurer que l'utilisateur a un token
          if (!user.token) {
            const newToken = generateId() + generateId();
            await db.updateUserToken(user.number, newToken);
            user.token = newToken;
            console.log(`🔑 Token généré pour ${user.username} (fallback device)`);
          }
          
          ws.send(JSON.stringify({ 
            type: 'auto_login_success', 
            username: user.username, 
            score: user.score, 
            number: user.number,
            token: user.token
          }));
          
          console.log(`🔄 Auto-login par device: ${user.username}`);
        } else {
          ws.send(JSON.stringify({ type: 'auto_login_failed', message: 'Utilisateur non trouvé' }));
        }
      } else {
        console.log(`❌ Auto-login échoué - Pas de token ni device reconnu`);
        ws.send(JSON.stringify({ type: 'auto_login_failed', message: 'Appareil non reconnu' }));
      }
    },
    
    get_leaderboard: async () => {
      const leaderboard = await db.getLeaderboard();
      const formattedLeaderboard = leaderboard.map((user, index) => ({
        rank: index + 1,
        username: user.username,
        score: user.score
      }));
      ws.send(JSON.stringify({ type: 'leaderboard', leaderboard: formattedLeaderboard }));
    },
    
    join_queue: () => {
      const playerNumber = TRUSTED_DEVICES.get(deviceKey);
      if (!playerNumber) return ws.send(JSON.stringify({ type: 'error', message: 'Non authentifié' }));
      if (PLAYER_TO_GAME.has(playerNumber)) return ws.send(JSON.stringify({ type: 'error', message: 'Déjà dans une partie' }));
      
      PLAYER_QUEUE.add(playerNumber);
      ws.send(JSON.stringify({ type: 'queue_joined', message: 'En attente adversaire' }));
      
      if (PLAYER_QUEUE.size >= 2) {
        const players = Array.from(PLAYER_QUEUE).slice(0, 2);
        players.forEach(p => PLAYER_QUEUE.delete(p));
        createGameLobby(players);
      }
    },
    
    leave_queue: () => {
      const playerNumber = TRUSTED_DEVICES.get(deviceKey);
      if (playerNumber && PLAYER_QUEUE.has(playerNumber)) {
        PLAYER_QUEUE.delete(playerNumber);
        ws.send(JSON.stringify({ type: 'queue_left', message: 'Recherche annulée' }));
      }
    },
    
    player_move: () => handleGameAction(ws, message, deviceKey),
    dice_swap: () => handleGameAction(ws, message, deviceKey),
    emoji_used: () => handleGameAction(ws, message, deviceKey)
  };
  
  if (handlers[message.type]) {
    await handlers[message.type]();
  }
}

async function createGameLobby(playerNumbers) {
  const p1 = await db.getUserByNumber(playerNumbers[0]);
  const p2 = await db.getUserByNumber(playerNumbers[1]);
  if (!p1 || !p2) return;
  
  const gameId = generateId();
  new Game(gameId, p1, p2);
  
  playerNumbers.forEach((num, idx) => {
    const ws = PLAYER_CONNECTIONS.get(num);
    const opponent = idx === 0 ? p2 : p1;
    ws?.send(JSON.stringify({
      type: 'match_found', matchId: gameId,
      opponent: { username: opponent.username, score: opponent.score, number: opponent.number },
      isPlayer1: idx === 0
    }));
  });
}

function handleGameAction(ws, message, deviceKey) {
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

// Démarrage
app.use(express.static('public'));

// Route de santé pour Render
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'OK', database: 'PostgreSQL', timestamp: new Date().toISOString() });
});

// Initialisation au démarrage
async function startServer() {
  try {
    await initializeDatabase();
    await loadTrustedDevices();
    
    server.listen(PORT, '0.0.0.0', () => {
      console.log(`🎮 Serveur PostgreSQL ACTIF sur le port ${PORT}`);
      console.log('🗄️ Base de données PostgreSQL initialisée');
      console.log('✅ Système de token principal activé');
      console.log('✅ Données persistantes garanties');
    });
  } catch (error) {
    console.error('❌ Erreur démarrage serveur:', error);
    process.exit(1);
  }
}

startServer();
