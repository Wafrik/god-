const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL non définie');
  process.exit(1);
}

const PORT = process.env.PORT || 8000;
const ADMIN_KEY = process.env.ADMIN_KEY || "SECRET_ADMIN_KEY_12345";
const HIGH_SCORE_THRESHOLD = 10000;
const BOT_INCREMENT_INTERVAL = 3 * 60 * 60 * 1000;

const TRUSTED_DEVICES = new Map();
const PLAYER_CONNECTIONS = new Map();
const ADMIN_CONNECTIONS = new Map();
const PLAYER_QUEUE = new Set();
const ACTIVE_GAMES = new Map();
const PLAYER_TO_GAME = new Map();
const BOT_SCORES = new Map();

const BOTS = [
  { id: "bot_m_001", username: "Lucas", gender: "M", baseScore: 0 },
  { id: "bot_m_002", username: "Thomas", gender: "M", baseScore: 0 },
  { id: "bot_m_003", username: "Alexandre", gender: "M", baseScore: 0 },
  { id: "bot_m_004", username: "Mathis", gender: "M", baseScore: 0 },
  { id: "bot_m_005", username: "Nathan", gender: "M", baseScore: 0 },
  { id: "bot_m_006", username: "Enzo", gender: "M", baseScore: 0 },
  { id: "bot_m_007", username: "Louis", gender: "M", baseScore: 0 },
  { id: "bot_m_008", username: "Gabriel", gender: "M", baseScore: 0 },
  { id: "bot_m_009", username: "Hugo", gender: "M", baseScore: 0 },
  { id: "bot_m_010", username: "Raphaël", gender: "M", baseScore: 0 },
  { id: "bot_f_001", username: "Emma", gender: "F", baseScore: 0 },
  { id: "bot_f_002", username: "Léa", gender: "F", baseScore: 0 },
  { id: "bot_f_003", username: "Manon", gender: "F", baseScore: 0 },
  { id: "bot_f_004", username: "Chloé", gender: "F", baseScore: 0 },
  { id: "bot_f_005", username: "Camille", gender: "F", baseScore: 0 },
  { id: "bot_f_006", username: "Sarah", gender: "F", baseScore: 0 },
  { id: "bot_f_007", username: "Julie", gender: "F", baseScore: 0 },
  { id: "bot_f_008", username: "Clara", gender: "F", baseScore: 0 },
  { id: "bot_f_009", username: "Inès", gender: "F", baseScore: 0 },
  { id: "bot_f_010", username: "Zoé", gender: "F", baseScore: 0 },
  { id: "bot_001", username: "Zaboule", gender: "M", baseScore: 0 },
  { id: "bot_002", username: "Ddk", gender: "M", baseScore: 0 },
  { id: "bot_003", username: "Zokou la panthère", gender: "M", baseScore: 0 },
  { id: "bot_004", username: "Atom", gender: "M", baseScore: 0 },
  { id: "bot_005", username: "Yven125", gender: "M", baseScore: 0 },
  { id: "bot_006", username: "Pataff4", gender: "M", baseScore: 0 },
  { id: "bot_007", username: "Afrocc", gender: "M", baseScore: 0 },
  { id: "bot_008", username: "Le babato deluxe", gender: "M", baseScore: 0 },
  { id: "bot_009", username: "Miello", gender: "M", baseScore: 0 },
  { id: "bot_010", username: "2418coto", gender: "M", baseScore: 0 },
  { id: "bot_011", username: "Yako2001", gender: "M", baseScore: 0 },
  { id: "bot_012", username: "Ziparotus", gender: "M", baseScore: 0 },
  { id: "bot_013", username: "Agapli", gender: "F", baseScore: 0 },
  { id: "bot_014", username: "Mireille68", gender: "F", baseScore: 0 },
  { id: "bot_015", username: "Pela8", gender: "F", baseScore: 0 },
  { id: "bot_016", username: "Sylivie", gender: "F", baseScore: 0 },
  { id: "bot_017", username: "Soeur cartie", gender: "F", baseScore: 0 },
  { id: "bot_018", username: "Zezeta23", gender: "F", baseScore: 0 },
  { id: "bot_019", username: "Timo", gender: "M", baseScore: 0 },
  { id: "bot_020", username: "Lina", gender: "F", baseScore: 0 }
];

let botAutoIncrementInterval = null;

const generateId = () => Math.random().toString(36).substring(2, 15);

const generateDeviceKey = (ip, deviceId) => {
  if (ip.includes('127.0.0.1') || ip.includes('::1') || ip === '::ffff:127.0.0.1') {
    return `web_${deviceId}`;
  }
  return `${ip}_${deviceId}`;
};

function getRandomBot() {
  const randomBot = BOTS[Math.floor(Math.random() * BOTS.length)];
  const botScore = BOT_SCORES.get(randomBot.id) || randomBot.baseScore;
  return { ...randomBot, score: botScore, is_bot: true };
}

async function updateBotScore(botId, currentBotScore, isWin = false, gameScore = 0) {
  try {
    let finalScore = currentBotScore;
    const isHighScore = currentBotScore >= HIGH_SCORE_THRESHOLD;

    if (isWin) {
      finalScore = currentBotScore + gameScore + 200;
    } else {
      if (isHighScore) {
        finalScore = Math.max(0, currentBotScore - gameScore - 200);
      } else {
        finalScore = Math.max(0, currentBotScore - gameScore);
      }
    }

    BOT_SCORES.set(botId, finalScore);

    await pool.query(`
      INSERT INTO bot_scores (bot_id, score, last_played) 
      VALUES ($1, $2, CURRENT_TIMESTAMP)
      ON CONFLICT (bot_id) 
      DO UPDATE SET score = $2, last_played = CURRENT_TIMESTAMP
    `, [botId, finalScore]);

    return true;
  } catch (error) {
    console.error('Erreur score bot:', error);
    return false;
  }
}

async function incrementBotScoresAutomatically() {
  try {
    const result = await pool.query('SELECT bot_id, score FROM bot_scores');
    
    for (const row of result.rows) {
      const increment = Math.floor(Math.random() * (200 - 70 + 1)) + 70;
      const newScore = row.score + increment;
      
      await pool.query(
        'UPDATE bot_scores SET score = $1, last_played = CURRENT_TIMESTAMP WHERE bot_id = $2',
        [newScore, row.bot_id]
      );
      
      BOT_SCORES.set(row.bot_id, newScore);
    }
    
    return { success: true };
  } catch (error) {
    console.error('Erreur incrément bots:', error);
    return { success: false };
  }
}

async function loadBotScores() {
  try {
    const result = await pool.query('SELECT bot_id, score FROM bot_scores');
    result.rows.forEach(row => {
      BOT_SCORES.set(row.bot_id, row.score);
    });
  } catch (error) {
    // Ignorer si table non existante
  }
}

const db = {
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
    const token = generateId() + generateId();
    const result = await pool.query(
      `INSERT INTO users (username, password, number, age, score, online, token) 
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [username, password, number, age, 0, true, token]
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

  async updateUserScoreAfterBotMatch(playerNumber, playerGameScore, isWin, isDraw = false) {
    try {
      // Si c'est un match nul, aucun changement de score
      if (isDraw) {
        console.log(`Match nul - Aucun changement de score pour ${playerNumber}`);
        return true;
      }
      
      const playerResult = await pool.query('SELECT score FROM users WHERE number = $1', [playerNumber]);
      const currentScore = playerResult.rows[0]?.score || 0;
      const isHighScore = currentScore >= HIGH_SCORE_THRESHOLD;
      
      let newScore;
      
      if (isWin) {
        newScore = currentScore + playerGameScore + 200;
        console.log(`🏆 Victoire ${playerNumber}: ${currentScore} + ${playerGameScore} + 200 = ${newScore}`);
      } else {
        if (isHighScore) {
          newScore = Math.max(0, currentScore - playerGameScore - 200);
          console.log(`🔥 Défaite (≥10k) ${playerNumber}: ${currentScore} - ${playerGameScore} - 200 = ${newScore}`);
        } else {
          newScore = Math.max(0, currentScore - playerGameScore);
          console.log(`😢 Défaite (<10k) ${playerNumber}: ${currentScore} - ${playerGameScore} = ${newScore}`);
        }
      }
      
      await pool.query(
        'UPDATE users SET score = $1, updated_at = CURRENT_TIMESTAMP WHERE number = $2',
        [newScore, playerNumber]
      );
      
      return true;
    } catch (error) {
      console.error('Erreur mise à jour score bot match:', error);
      return false;
    }
  },

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

  async getLeaderboard() {
    try {
      const playersResult = await pool.query(`
        SELECT username, score FROM users WHERE score >= 0 ORDER BY score DESC
      `);
      
      const botsResult = await pool.query(`
        SELECT bs.bot_id, bs.score, b.username 
        FROM bot_scores bs LEFT JOIN bot_profiles b ON bs.bot_id = b.id 
        ORDER BY bs.score DESC
      `).catch(() => ({ rows: [] }));
      
      const leaderboard = [];
      
      playersResult.rows.forEach((user) => {
        leaderboard.push({
          username: user.username,
          score: user.score,
          is_bot: false
        });
      });
      
      botsResult.rows.forEach((bot) => {
        leaderboard.push({
          username: bot.username || `Bot_${bot.bot_id}`,
          score: bot.score,
          is_bot: false
        });
      });
      
      leaderboard.sort((a, b) => b.score - a.score);
      
      return leaderboard.map((item, index) => ({
        ...item,
        rank: index + 1
      }));
    } catch (error) {
      console.error('Erreur classement:', error);
      return [];
    }
  },

  async getAllPlayers() {
    const result = await pool.query(`
      SELECT username, number, age, score, created_at, online 
      FROM users 
      WHERE score >= 0 
      ORDER BY score DESC
    `);
    return result.rows;
  },

  async resetAllScores() {
    try {
      const playersReset = await pool.query('UPDATE users SET score = 0 WHERE score > 0');
      
      const botsReset = await pool.query(`
        UPDATE bot_scores bs 
        SET score = bp.base_score 
        FROM bot_profiles bp 
        WHERE bs.bot_id = bp.id
      `);
      
      for (const bot of BOTS) {
        BOT_SCORES.set(bot.id, bot.baseScore);
      }
      
      return { 
        playersReset: playersReset.rowCount,
        botsReset: BOTS.length 
      };
    } catch (error) {
      console.error('Erreur reset scores:', error);
      throw error;
    }
  },

  async updatePlayerScoreById(playerId, points, operation) {
    try {
      if (!playerId) return { success: false, message: "ID joueur manquant" };
      
      const player = await pool.query('SELECT * FROM users WHERE number = $1', [playerId]);
      if (!player.rows[0]) return { success: false, message: "Joueur non trouvé" };
      
      const currentScore = player.rows[0].score;
      let newScore;
      
      if (operation === "add") {
        newScore = currentScore + points;
      } else if (operation === "subtract") {
        newScore = Math.max(0, currentScore - points);
      } else {
        return { success: false, message: "Opération invalide" };
      }
      
      await pool.query(
        'UPDATE users SET score = $1, updated_at = CURRENT_TIMESTAMP WHERE number = $2',
        [newScore, playerId]
      );
      
      return { 
        success: true, 
        player_id: playerId,
        new_score: newScore,
        points: points,
        operation: operation
      };
    } catch (error) {
      console.error('Erreur update score joueur:', error);
      return { success: false, message: "Erreur serveur" };
    }
  },

  async getPlayersList() {
    try {
      const result = await pool.query(`
        SELECT number as id, username, score, age, number, 
               created_at, online, 
               RANK() OVER (ORDER BY score DESC) as rank
        FROM users 
        WHERE score >= 0 
        ORDER BY score DESC
      `);
      
      return result.rows.map(player => ({
        id: player.id,
        username: player.username,
        score: player.score,
        rank: player.rank,
        age: player.age,
        number: player.number,
        created_at: player.created_at,
        online: player.online
      }));
    } catch (error) {
      console.error('Erreur liste joueurs:', error);
      return [];
    }
  },

  async getFullListWithBots() {
    try {
      // Récupérer tous les joueurs
      const playersResult = await pool.query(`
        SELECT number as id, username, score, age, number, 
               created_at, online, false as is_bot,
               RANK() OVER (ORDER BY score DESC) as rank
        FROM users 
        WHERE score >= 0 
      `);
      
      // Récupérer tous les bots
      const botsResult = await pool.query(`
        SELECT bs.bot_id as id, b.username, bs.score, 
               'bot' as number, 0 as age, 
               bp.created_at, false as online, true as is_bot,
               RANK() OVER (ORDER BY bs.score DESC) as rank
        FROM bot_scores bs 
        LEFT JOIN bot_profiles b ON bs.bot_id = b.id 
        LEFT JOIN bot_profiles bp ON bs.bot_id = bp.id
      `).catch(() => ({ rows: [] }));
      
      // Combiner les résultats
      const combinedList = [];
      
      // Ajouter les joueurs
      playersResult.rows.forEach(player => {
        combinedList.push({
          id: player.id,
          username: player.username,
          score: player.score,
          rank: player.rank,
          age: player.age,
          number: player.number,
          created_at: player.created_at,
          online: player.online,
          is_bot: false
        });
      });
      
      // Ajouter les bots
      botsResult.rows.forEach(bot => {
        combinedList.push({
          id: bot.id,
          username: bot.username,
          score: bot.score,
          rank: bot.rank,
          age: bot.age,
          number: bot.number,
          created_at: bot.created_at,
          online: bot.online,
          is_bot: true
        });
      });
      
      // Trier par score décroissant
      combinedList.sort((a, b) => b.score - a.score);
      
      // Réassigner les rangs après le tri combiné
      combinedList.forEach((item, index) => {
        item.rank = index + 1;
      });
      
      return combinedList;
    } catch (error) {
      console.error('Erreur liste complète avec bots:', error);
      return [];
    }
  },

  async updateBotScoreById(botId, points, operation) {
    try {
      if (!botId) return { success: false, message: "ID bot manquant" };
      
      const botResult = await pool.query('SELECT score FROM bot_scores WHERE bot_id = $1', [botId]);
      if (!botResult.rows[0]) return { success: false, message: "Bot non trouvé" };
      
      const currentScore = botResult.rows[0].score;
      let newScore;
      
      if (operation === "add") {
        newScore = currentScore + points;
      } else if (operation === "subtract") {
        newScore = Math.max(0, currentScore - points);
      } else {
        return { success: false, message: "Opération invalide" };
      }
      
      await pool.query(
        'UPDATE bot_scores SET score = $1, last_played = CURRENT_TIMESTAMP WHERE bot_id = $2',
        [newScore, botId]
      );
      
      // Mettre à jour en mémoire
      BOT_SCORES.set(botId, newScore);
      
      return { 
        success: true, 
        bot_id: botId,
        new_score: newScore,
        points: points,
        operation: operation
      };
    } catch (error) {
      console.error('Erreur update score bot:', error);
      return { success: false, message: "Erreur serveur" };
    }
  }
};

async function initializeDatabase() {
  try {
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

    await pool.query(`
      CREATE TABLE IF NOT EXISTS trusted_devices (
        id SERIAL PRIMARY KEY,
        device_key VARCHAR(200) UNIQUE NOT NULL,
        user_number VARCHAR(20) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS bot_profiles (
        id VARCHAR(50) PRIMARY KEY,
        username VARCHAR(50) NOT NULL,
        gender VARCHAR(1) NOT NULL,
        base_score INTEGER DEFAULT 100,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

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

    for (const bot of BOTS) {
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

    if (combination) {
      const parts = combination.split('-');
      if (parts.length === 6) this.playerCombinations[player.role] = parts.map(Number);
    }

    const oppRole = player.role === 'player1' ? 'player2' : 'player1';
    if (!this.playerCombinations.player1) this.playerCombinations.player1 = [1,2,3,4,5,6];
    if (!this.playerCombinations.player2) this.playerCombinations.player2 = [1,2,3,4,5,6];

    const arrayIndex = slot - 1;
    if (arrayIndex < 0 || arrayIndex >= 6) return false;

    const realValue = this.playerCombinations[oppRole][arrayIndex];
    this.availableSlots[player.role] = this.availableSlots[player.role].filter(s => s !== slot);
    this.scores[player.role] += realValue;
    this.selectionsThisManche++;

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
      console.error('Erreur pénalités déconnexion:', error);
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
      // Si match nul, aucun changement de score
      if (winner === 'draw') {
        console.log('Match nul - Aucun changement de score');
        return;
      }
      
      for (const player of this.players) {
        const user = await db.getUserByNumber(player.number);
        if (user) {
          const totalScore = this.scores[player.role];
          let newScore = user.score;
          const isHighScore = user.score >= HIGH_SCORE_THRESHOLD;
          
          if (winner === player.role) {
            newScore = user.score + totalScore + 200;
            console.log(`🏆 ${player.number} gagne: ${user.score} + ${totalScore} + 200 = ${newScore}`);
          } else {
            if (isHighScore) {
              newScore = Math.max(0, user.score - totalScore - 200);
              console.log(`🔥 ${player.number} perd (≥10k): ${user.score} - ${totalScore} - 200 = ${newScore}`);
            } else {
              newScore = Math.max(0, user.score - totalScore);
              console.log(`😢 ${player.number} perd (<10k): ${user.score} - ${totalScore} = ${newScore}`);
            }
          }
          
          await db.updateUserScore(player.number, newScore);
        }
      }
    } catch (error) {
      console.error('Erreur mise à jour scores:', error);
    }
  }

  cleanup() {
    if (this.timerInterval) clearInterval(this.timerInterval);
    this.players.forEach(p => PLAYER_TO_GAME.delete(p.number));
    ACTIVE_GAMES.delete(this.id);
  }

  getPlayerByNumber(n) { return this.players.find(p => p.number === n); }
}

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
        adminId = 'admin_' + generateId();
        ADMIN_CONNECTIONS.set(adminId, ws);
      }
      
      if (isAdminConnection) {
        await handleAdminMessage(ws, message, adminId);
      } else {
        await handleClientMessage(ws, message, ip, deviceId);
      }
      
    } catch(e) {
      console.error("Erreur parsing message:", e);
    }
  });

  ws.on('close', async () => {
    if (isAdminConnection && adminId) {
      ADMIN_CONNECTIONS.delete(adminId);
    } else {
      setTimeout(async () => {
        const deviceKey = generateDeviceKey(ip, deviceId);
        const disconnectedNumber = TRUSTED_DEVICES.get(deviceKey);
        
        if (disconnectedNumber) {
          PLAYER_CONNECTIONS.delete(disconnectedNumber);
          PLAYER_QUEUE.delete(disconnectedNumber);
          
          await db.setUserOnlineStatus(disconnectedNumber, false);
          
          const gameId = PLAYER_TO_GAME.get(disconnectedNumber);
          const game = ACTIVE_GAMES.get(gameId);
          const player = game?.getPlayerByNumber(disconnectedNumber);
          if (player) await game.handlePlayerDisconnect(player);
          PLAYER_TO_GAME.delete(disconnectedNumber);
        }
      }, 10000);
    }
  });
});

async function handleAdminMessage(ws, message, adminId) {
  
  const handlers = {
    admin_authenticate: async () => {
      if (message.admin_key === ADMIN_KEY) {
        ws.send(JSON.stringify({ 
          type: 'admin_auth_success', 
          message: 'Authentification admin réussie' 
        }));
      } else {
        ws.send(JSON.stringify({ 
          type: 'admin_auth_failed', 
          message: 'Clé admin invalide' 
        }));
      }
    },

    admin_export_data: async () => {
      try {
        if (message.admin_key !== ADMIN_KEY) {
          return ws.send(JSON.stringify({ 
            type: 'error', 
            message: 'Clé admin invalide' 
          }));
        }

        const players = await db.getAllPlayers();
        const data = players.map((player, index) => ({
          rank: index + 1,
          username: player.username,
          number: player.number,
          age: player.age,
          score: player.score,
          created_at: player.created_at,
          online: player.online
        }));
        
        ws.send(JSON.stringify({
          type: 'admin_export_data',
          success: true,
          data: data,
          count: data.length
        }));
      } catch (error) {
        console.error('Erreur export admin:', error);
        ws.send(JSON.stringify({ 
          type: 'admin_export_data', 
          success: false, 
          message: 'Erreur export' 
        }));
      }
    },

    admin_get_players: async () => {
      try {
        if (message.admin_key !== ADMIN_KEY) {
          return ws.send(JSON.stringify({ 
            type: 'error', 
            message: 'Clé admin invalide' 
          }));
        }

        const players = await db.getPlayersList();
        
        ws.send(JSON.stringify({
          type: 'admin_player_list',
          success: true,
          players: players,
          count: players.length
        }));
      } catch (error) {
        console.error('Erreur liste joueurs admin:', error);
        ws.send(JSON.stringify({ 
          type: 'admin_player_list', 
          success: false, 
          message: 'Erreur liste joueurs' 
        }));
      }
    },

    admin_get_full_list: async () => {
      try {
        if (message.admin_key !== ADMIN_KEY) {
          return ws.send(JSON.stringify({ 
            type: 'error', 
            message: 'Clé admin invalide' 
          }));
        }

        const fullList = await db.getFullListWithBots();
        
        ws.send(JSON.stringify({
          type: 'admin_full_list',
          success: true,
          data: fullList,
          count: fullList.length
        }));
      } catch (error) {
        console.error('Erreur liste complète admin:', error);
        ws.send(JSON.stringify({ 
          type: 'admin_full_list', 
          success: false, 
          message: 'Erreur liste complète' 
        }));
      }
    },

    admin_reset_scores: async () => {
      try {
        if (message.admin_key !== ADMIN_KEY) {
          return ws.send(JSON.stringify({ 
            type: 'error', 
            message: 'Clé admin invalide' 
          }));
        }

        const resetResult = await db.resetAllScores();
        
        ws.send(JSON.stringify({
          type: 'admin_reset_scores',
          success: true,
          message: `Scores réinitialisés`,
          players_reset: resetResult.playersReset,
          bots_reset: resetResult.botsReset
        }));
      } catch (error) {
        console.error('Erreur reset admin:', error);
        ws.send(JSON.stringify({ 
          type: 'admin_reset_scores', 
          success: false, 
          message: 'Erreur reset' 
        }));
      }
    },

    admin_update_player_score: async () => {
      try {
        if (message.admin_key !== ADMIN_KEY) {
          return ws.send(JSON.stringify({ 
            type: 'error', 
            message: 'Clé admin invalide' 
          }));
        }

        const { player_id, points, operation } = message;
        
        if (!player_id || !points || !operation) {
          return ws.send(JSON.stringify({
            type: 'admin_update_score',
            success: false,
            message: 'Données manquantes'
          }));
        }

        const result = await db.updatePlayerScoreById(player_id, parseInt(points), operation);
        
        ws.send(JSON.stringify({
          type: 'admin_update_score',
          success: result.success,
          message: result.message || 'Score mis à jour',
          player_id: result.player_id,
          new_score: result.new_score,
          points: result.points,
          operation: result.operation
        }));
      } catch (error) {
        console.error('Erreur update score admin:', error);
        ws.send(JSON.stringify({ 
          type: 'admin_update_score', 
          success: false, 
          message: 'Erreur mise à jour score' 
        }));
      }
    },

    admin_update_bot_score: async () => {
      try {
        if (message.admin_key !== ADMIN_KEY) {
          return ws.send(JSON.stringify({ 
            type: 'error', 
            message: 'Clé admin invalide' 
          }));
        }

        const { bot_id, points, operation } = message;
        
        if (!bot_id || !points || !operation) {
          return ws.send(JSON.stringify({
            type: 'admin_update_bot_score',
            success: false,
            message: 'Données manquantes'
          }));
        }

        const result = await db.updateBotScoreById(bot_id, parseInt(points), operation);
        
        ws.send(JSON.stringify({
          type: 'admin_update_bot_score',
          success: result.success,
          message: result.message || 'Score bot mis à jour',
          bot_id: result.bot_id,
          new_score: result.new_score,
          points: result.points,
          operation: result.operation
        }));
      } catch (error) {
        console.error('Erreur update score bot admin:', error);
        ws.send(JSON.stringify({ 
          type: 'admin_update_bot_score', 
          success: false, 
          message: 'Erreur mise à jour score bot' 
        }));
      }
    }
  };
  
  if (handlers[message.type]) {
    await handlers[message.type]();
  } else {
    ws.send(JSON.stringify({ 
      type: 'error', 
      message: 'Commande admin inconnue' 
    }));
  }
}

async function handleClientMessage(ws, message, ip, deviceId) {
  const deviceKey = generateDeviceKey(ip, deviceId);
  
  const handlers = {
    authenticate: async () => {
      const user = await db.getUserByNumber(message.number);
      if (user && user.password === message.password) {
        if (!user.token) {
          const newToken = generateId() + generateId();
          await db.updateUserToken(user.number, newToken);
          user.token = newToken;
        }
        
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
      } else {
        ws.send(JSON.stringify({ type: 'auth_failed', message: 'Numéro ou mot de passe incorrect' }));
      }
    },
    
    register: async () => {
      const { username, password, confirmPassword, number, age } = message;
      if (!username || !password || !confirmPassword || !number || !age) {
        ws.send(JSON.stringify({ type: 'register_failed', message: "Tous les champs requis" }));
      } else if (password !== confirmPassword) {
        ws.send(JSON.stringify({ type: 'register_failed', message: "Mots de passe différents" }));
      } else if (await db.getUserByUsername(username)) {
        ws.send(JSON.stringify({ type: 'register_failed', message: "Pseudo déjà utilisé" }));
      } else if (await db.getUserByNumber(number)) {
        ws.send(JSON.stringify({ type: 'register_failed', message: "Numéro déjà utilisé" }));
      } else {
        const newUser = await db.createUser({ username, password, number, age: parseInt(age) });
        
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
      }
    },

    logout: async () => {
      const playerNumber = TRUSTED_DEVICES.get(deviceKey);
      if (playerNumber) {
        TRUSTED_DEVICES.delete(deviceKey);
        await db.deleteTrustedDevice(deviceKey);
        
        PLAYER_CONNECTIONS.delete(playerNumber);
        PLAYER_QUEUE.delete(playerNumber);
        
        await db.setUserOnlineStatus(playerNumber, false);
        
        const gameId = PLAYER_TO_GAME.get(playerNumber);
        const game = ACTIVE_GAMES.get(gameId);
        const player = game?.getPlayerByNumber(playerNumber);
        if (player) await game.handlePlayerDisconnect(player);
        PLAYER_TO_GAME.delete(playerNumber);
        
        ws.send(JSON.stringify({ type: 'logout_success', message: 'Déconnexion réussie' }));
      } else {
        ws.send(JSON.stringify({ type: 'error', message: 'Non authentifié' }));
      }
    },
    
    auto_login: async () => {
      if (message.token) {
        const user = await db.getUserByToken(message.token);
        
        if (user) {
          PLAYER_CONNECTIONS.set(user.number, ws);
          await db.setUserOnlineStatus(user.number, true);
          
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
          
          const gameId = PLAYER_TO_GAME.get(user.number);
          const game = ACTIVE_GAMES.get(gameId);
          const player = game?.getPlayerByNumber(user.number);
          if (player) { 
            player.ws = ws; 
            game.broadcastGameState(); 
          }
          return;
        } else {
          ws.send(JSON.stringify({ type: 'auto_login_failed', message: 'Token invalide' }));
          return;
        }
      }
      
      const trustedNumber = TRUSTED_DEVICES.get(deviceKey);
      if (trustedNumber) {
        const user = await db.getUserByNumber(trustedNumber);
        if (user) {
          PLAYER_CONNECTIONS.set(trustedNumber, ws);
          await db.setUserOnlineStatus(trustedNumber, true);
          
          if (!user.token) {
            const newToken = generateId() + generateId();
            await db.updateUserToken(user.number, newToken);
            user.token = newToken;
          }
          
          ws.send(JSON.stringify({ 
            type: 'auto_login_success', 
            username: user.username, 
            score: user.score, 
            number: user.number,
            token: user.token
          }));
        } else {
          ws.send(JSON.stringify({ type: 'auto_login_failed', message: 'Utilisateur non trouvé' }));
        }
      } else {
        ws.send(JSON.stringify({ type: 'auto_login_failed', message: 'Appareil non reconnu' }));
      }
    },
    
    get_leaderboard: async () => {
      const leaderboard = await db.getLeaderboard();
      ws.send(JSON.stringify({ type: 'leaderboard', leaderboard: leaderboard }));
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

app.get('/get-bot', (req, res) => {
  try {
    const bot = getRandomBot();
    res.json({ success: true, bot: bot });
  } catch (error) {
    res.status(500).json({ success: false, message: "Erreur serveur" });
  }
});

app.post('/update-bot-match', express.json(), async (req, res) => {
  try {
    const { playerNumber, botId, playerScore, botScore, isPlayerWin } = req.body;
    
    if (!playerNumber || !botId || playerScore === undefined || botScore === undefined) {
      return res.status(400).json({ success: false, message: "Données manquantes" });
    }
    
    const isBotWin = !isPlayerWin;
    const isDraw = (playerScore === botScore);
    
    const playerUpdateSuccess = await db.updateUserScoreAfterBotMatch(playerNumber, playerScore, isPlayerWin, isDraw);
    
    // Si c'est un match nul, le bot ne gagne ni ne perd de points
    if (!isDraw) {
      const botResult = await pool.query('SELECT score FROM bot_scores WHERE bot_id = $1', [botId]);
      const currentBotScore = botResult.rows[0]?.score || BOTS.find(b => b.id === botId)?.baseScore || 100;
      
      const botUpdateSuccess = await updateBotScore(botId, currentBotScore, isBotWin, botScore);
      
      if (playerUpdateSuccess && botUpdateSuccess) {
        res.json({ 
          success: true, 
          message: "Scores mis à jour",
          is_draw: isDraw
        });
      } else {
        res.status(500).json({ success: false, message: "Erreur mise à jour scores" });
      }
    } else {
      // Match nul - aucun changement de score
      res.json({ 
        success: true, 
        message: "Match nul - Aucun changement de score",
        is_draw: true
      });
    }
  } catch (error) {
    res.status(500).json({ success: false, message: "Erreur serveur" });
  }
});

app.get('/leaderboard-with-bots', async (req, res) => {
  try {
    const leaderboard = await db.getLeaderboard();
    res.json({ success: true, leaderboard: leaderboard, count: leaderboard.length });
  } catch (error) {
    res.status(500).json({ success: false, message: "Erreur serveur" });
  }
});

app.post('/force-bot-increment', express.json(), async (req, res) => {
  try {
    const { admin_key } = req.body;
    
    if (admin_key !== ADMIN_KEY) {
      return res.status(403).json({ success: false, message: "Clé admin invalide" });
    }
    
    const result = await incrementBotScoresAutomatically();
    
    res.json({
      success: result.success,
      message: "Incrément bots effectué"
    });
  } catch (error) {
    res.status(500).json({ success: false, message: "Erreur serveur" });
  }
});

app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'OK', 
    database: 'PostgreSQL', 
    total_bots: BOTS.length,
    high_score_threshold: HIGH_SCORE_THRESHOLD,
    timestamp: new Date().toISOString() 
  });
});

async function startServer() {
  try {
    await initializeDatabase();
    await loadTrustedDevices();
    await loadBotScores();
    
    botAutoIncrementInterval = setInterval(incrementBotScoresAutomatically, BOT_INCREMENT_INTERVAL);
    
    setTimeout(() => {
      incrementBotScoresAutomatically();
    }, 60 * 1000);
    
    server.listen(PORT, '0.0.0.0', () => {
      console.log(`Serveur sur port ${PORT}`);
      console.log(`${BOTS.length} bots disponibles`);
    });
  } catch (error) {
    console.error('Erreur démarrage:', error);
    process.exit(1);
  }
}

process.on('SIGTERM', () => {
  if (botAutoIncrementInterval) clearInterval(botAutoIncrementInterval);
  server.close(() => {
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  if (botAutoIncrementInterval) clearInterval(botAutoIncrementInterval);
  server.close(() => {
    process.exit(0);
  });
});

// AJOUTEZ CETTE PARTIE DANS VOTRE SERVEUR (vers la fin du fichier)
// ==============================================================

// CONFIGURATION SIMPLE DE MISE À JOUR
const APP_CONFIG = {
  // Mettez "true" pour forcer la mise à jour, "false" pour laisser passer
  force_update: true,
  
  // Version minimale requise (à adapter)
  min_version: "1.1.0",
  
  // Version actuelle disponible
  latest_version: "1.2.0",
  
  // Lien Play Store (à personnaliser)
  update_url: "https://play.google.com/store/apps/details?id=votre.app.id"
};

// Route pour vérifier la mise à jour (AJOUTEZ CETTE ROUTE)
app.post('/check-update', express.json(), async (req, res) => {
  try {
    const { app_version } = req.body;
    
    console.log(`📱 Vérification MAJ: version client = ${app_version}`);
    console.log(`📱 Configuration: force_update = ${APP_CONFIG.force_update}`);
    
    // Si force_update est à true, on force la mise à jour
    if (APP_CONFIG.force_update) {
      console.log('⚠️ MAJ FORCÉE activée');
      return res.json({
        needs_update: true,
        message: "Mise à jour requise",
        min_version: APP_CONFIG.min_version,
        latest_version: APP_CONFIG.latest_version,
        update_url: APP_CONFIG.update_url
      });
    }
    
    // Sinon, comparaison simple des versions
    let needs_update = false;
    
    if (app_version && APP_CONFIG.min_version) {
      // Convertir en nombres pour comparaison simple (1.0.0 -> 100)
      const clientNum = parseInt(app_version.replace(/\./g, ''));
      const minNum = parseInt(APP_CONFIG.min_version.replace(/\./g, ''));
      
      if (clientNum < minNum) {
        needs_update = true;
      }
    }
    
    console.log(`📱 Résultat: needs_update = ${needs_update}`);
    
    res.json({
      needs_update: needs_update,
      message: needs_update ? "Mise à jour requise" : "Version à jour",
      min_version: APP_CONFIG.min_version,
      latest_version: APP_CONFIG.latest_version,
      update_url: APP_CONFIG.update_url
    });
    
  } catch (error) {
    console.error('Erreur vérification MAJ:', error);
    res.status(500).json({
      needs_update: false,
      message: "Erreur vérification"
    });
  }
});

// Route pour modifier la configuration (optionnel - protégée par clé admin)
app.post('/admin/set-update-config', express.json(), async (req, res) => {
  try {
    const { admin_key, force_update, min_version, latest_version, update_url } = req.body;
    
    if (admin_key !== ADMIN_KEY) {
      return res.status(403).json({ success: false, message: "Clé admin invalide" });
    }
    
    // Mettre à jour la configuration
    if (force_update !== undefined) {
      APP_CONFIG.force_update = force_update === true;
    }
    if (min_version) {
      APP_CONFIG.min_version = min_version;
    }
    if (latest_version) {
      APP_CONFIG.latest_version = latest_version;
    }
    if (update_url) {
      APP_CONFIG.update_url = update_url;
    }
    
    console.log('✅ Configuration MAJ mise à jour:', APP_CONFIG);
    
    res.json({
      success: true,
      message: "Configuration mise à jour",
      config: APP_CONFIG
    });
    
  } catch (error) {
    console.error('Erreur mise à jour config:', error);
    res.status(500).json({ success: false, message: "Erreur serveur" });
  }
});

// Route pour voir la config actuelle (optionnel)
app.get('/admin/get-update-config', (req, res) => {
  const { admin_key } = req.query;
  
  if (admin_key !== ADMIN_KEY) {
    return res.status(403).json({ success: false, message: "Clé admin invalide" });
  }
  
  res.json({
    success: true,
    config: APP_CONFIG
  });
});
// ==============================================================

startServer();


