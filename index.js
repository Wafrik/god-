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
const BOT_DEPOSIT = 250;
const SPONSOR_MIN_SCORE = 2000; // Score minimum pour valider un parrainage
const SPONSORSHIP_SCAN_INTERVAL = 5 * 60 * 1000; // Scanner toutes les 5 minutes

// CONFIGURATION DU MATCHMAKING
const MATCHMAKING_CONFIG = {
  anti_quick_rematch: false,
  min_rematch_delay: 50 * 60 * 1000,
};

const UPDATE_CONFIG = {
  force_update: true,
  min_version: "1.1.0",
  latest_version: "1.2.0",
  update_url: "https://play.google.com/store/apps/details?id=com.dogbale.wafrik"
};

const TRUSTED_DEVICES = new Map();
const PLAYER_CONNECTIONS = new Map();
const ADMIN_CONNECTIONS = new Map();
const PLAYER_QUEUE = new Set();
const ACTIVE_GAMES = new Map();
const PLAYER_TO_GAME = new Map();
const BOT_SCORES = new Map();
const BOT_DEPOSITS = new Map();
const LAST_MATCHES = new Map();

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
let sponsorshipScanInterval = null;

const generateId = () => Math.random().toString(36).substring(2, 15);

const generateDeviceKey = (ip, deviceId) => {
  if (ip.includes('127.0.0.1') || ip.includes('::1') || ip === '::ffff:127.0.0.1') {
    return `web_${deviceId}`;
  }
  return `${ip}_${deviceId}`;
};

// FONCTION ANTI-MATCH RAPIDE
function canMatchPlayers(player1Number, player2Number) {
  if (!MATCHMAKING_CONFIG.anti_quick_rematch) {
    return { canMatch: true, reason: "Anti-quick-rematch désactivé" };
  }
  
  const lastMatch1 = LAST_MATCHES.get(player1Number);
  const lastMatch2 = LAST_MATCHES.get(player2Number);
  
  if (lastMatch1 && lastMatch1.opponent === player2Number) {
    const timeSinceLastMatch = Date.now() - lastMatch1.timestamp;
    if (timeSinceLastMatch < MATCHMAKING_CONFIG.min_rematch_delay) {
      const remainingTime = Math.ceil((MATCHMAKING_CONFIG.min_rematch_delay - timeSinceLastMatch) / 1000 / 60);
      return { 
        canMatch: false, 
        reason: `Vous avez déjà joué contre ce joueur il y a moins de ${remainingTime} minute(s). Attendez un peu.` 
      };
    }
  }
  
  if (lastMatch2 && lastMatch2.opponent === player1Number) {
    const timeSinceLastMatch = Date.now() - lastMatch2.timestamp;
    if (timeSinceLastMatch < MATCHMAKING_CONFIG.min_rematch_delay) {
      const remainingTime = Math.ceil((MATCHMAKING_CONFIG.min_rematch_delay - timeSinceLastMatch) / 1000 / 60);
      return { 
        canMatch: false, 
        reason: `Ce joueur vous a déjà affronté il y a moins de ${remainingTime} minute(s).` 
      };
    }
  }
  
  return { canMatch: true, reason: "Match autorisé" };
}

// ENREGISTRER UN MATCH
function recordMatch(player1Number, player2Number) {
  LAST_MATCHES.set(player1Number, { opponent: player2Number, timestamp: Date.now() });
  LAST_MATCHES.set(player2Number, { opponent: player1Number, timestamp: Date.now() });
  
  const twentyFourHoursAgo = Date.now() - (24 * 60 * 60 * 1000);
  for (const [player, match] of LAST_MATCHES.entries()) {
    if (match.timestamp < twentyFourHoursAgo) {
      LAST_MATCHES.delete(player);
    }
  }
}

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

// ===========================================
// NOUVELLE FONCTION : SCAN GLOBAL DES PARRAINAGES
// ===========================================
async function scanAndValidateAllSponsorships() {
  try {
    console.log('🔍 Démarrage scan global des parrainages...');
    
    // Trouver TOUS les filleuls qui ont atteint 2000 points mais dont le parrainage n'est pas validé
    const result = await pool.query(`
      SELECT 
        u.number as sponsored_number,
        u.username as sponsored_username,
        u.score as sponsored_score,
        s.sponsor_number,
        sp.username as sponsor_username,
        s.is_validated
      FROM users u
      JOIN sponsorships s ON u.number = s.sponsored_number
      JOIN users sp ON s.sponsor_number = sp.number
      WHERE u.score >= $1 
        AND s.is_validated = false
      ORDER BY u.score DESC
    `, [SPONSOR_MIN_SCORE]);
    
    console.log(`📊 ${result.rows.length} parrainages éligibles à la validation trouvés`);
    
    let validatedCount = 0;
    
    for (const row of result.rows) {
      const sponsoredNumber = row.sponsored_number;
      const sponsoredUsername = row.sponsored_username;
      const sponsoredScore = row.sponsored_score;
      const sponsorNumber = row.sponsor_number;
      const sponsorUsername = row.sponsor_username;
      
      console.log(`🎯 Vérification: ${sponsoredUsername} (${sponsoredScore} points) → ${sponsorUsername}`);
      
      // Valider le parrainage
      await pool.query(
        `UPDATE sponsorships 
         SET is_validated = true, validated_at = CURRENT_TIMESTAMP 
         WHERE sponsor_number = $1 AND sponsored_number = $2`,
        [sponsorNumber, sponsoredNumber]
      );
      
      // Mettre à jour les compteurs (total et validé augmentent tous les deux)
      await pool.query(
        `INSERT INTO sponsorship_stats (player_number, total_sponsored, validated_sponsored) 
         VALUES ($1, 1, 1) 
         ON CONFLICT (player_number) 
         DO UPDATE SET 
           total_sponsored = sponsorship_stats.total_sponsored + 1,
           validated_sponsored = sponsorship_stats.validated_sponsored + 1`,
        [sponsorNumber]
      );
      
      console.log(`✅ Parrainage validé par scan: ${sponsorUsername} → ${sponsoredUsername}`);
      console.log(`   Score: ${sponsoredScore} points | +1 ajouté au compteur`);
      
      validatedCount++;
      
      // Notifier le parrain s'il est connecté
      const sponsorWs = PLAYER_CONNECTIONS.get(sponsorNumber);
      if (sponsorWs && sponsorWs.readyState === WebSocket.OPEN) {
        sponsorWs.send(JSON.stringify({
          type: 'sponsorship_validated',
          message: `Votre filleul ${sponsoredUsername} a atteint ${SPONSOR_MIN_SCORE} points !`,
          sponsored_player: sponsoredUsername,
          validated_count: 1
        }));
      }
    }
    
    if (validatedCount > 0) {
      console.log(`🎉 Scan terminé: ${validatedCount} parrainages validés`);
    } else {
      console.log('✅ Aucun parrainage à valider');
    }
    
    return { success: true, validated: validatedCount };
  } catch (error) {
    console.error('❌ Erreur scan parrainages:', error);
    return { success: false, error: error.message };
  }
}

// FONCTION ORIGINALE (conservée pour compatibilité)
async function validateSponsorshipsWhenScoreReached(playerNumber, newScore) {
  try {
    // Vérifier si le joueur a atteint le score minimum pour valider ses parrainages
    if (newScore >= SPONSOR_MIN_SCORE) {
      // Trouver tous les parrainages où ce joueur est parrainé (sponsored)
      const sponsorshipsResult = await pool.query(
        `SELECT * FROM sponsorships 
         WHERE sponsored_number = $1 
         AND is_validated = false`,
        [playerNumber]
      );
      
      for (const sponsorship of sponsorshipsResult.rows) {
        // Valider le parrainage
        await pool.query(
          `UPDATE sponsorships 
           SET is_validated = true, validated_at = CURRENT_TIMESTAMP 
           WHERE sponsor_number = $1 AND sponsored_number = $2`,
          [sponsorship.sponsor_number, sponsorship.sponsored_number]
        );
        
        // CORRECTION : Ajouter +1 AU COMPTEUR SEULEMENT QUAND LE FILLEUL ATTEINT 2000
        // (total_sponsored ET validated_sponsored augmentent tous les deux)
        await pool.query(
          `INSERT INTO sponsorship_stats (player_number, total_sponsored, validated_sponsored) 
           VALUES ($1, 1, 1) 
           ON CONFLICT (player_number) 
           DO UPDATE SET 
             total_sponsored = sponsorship_stats.total_sponsored + 1,
             validated_sponsored = sponsorship_stats.validated_sponsored + 1`,
          [sponsorship.sponsor_number]
        );
        
        console.log(`✅ Parrainage validé: ${sponsorship.sponsor_number} → ${sponsorship.sponsored_number}`);
        console.log(`   +1 ajouté au compteur du parrain (score atteint: ${newScore})`);
        
        // Notifier le parrain si connecté
        const sponsorWs = PLAYER_CONNECTIONS.get(sponsorship.sponsor_number);
        if (sponsorWs && sponsorWs.readyState === WebSocket.OPEN) {
          sponsorWs.send(JSON.stringify({
            type: 'sponsorship_validated',
            message: `Votre filleul a atteint ${SPONSOR_MIN_SCORE} points !`,
            sponsored_player: sponsorship.sponsored_number,
            validated_count: 1
          }));
        }
      }
    }
  } catch (error) {
    console.error('Erreur validation parrainages:', error);
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
    console.log(`🔄 updateUserScore(${number}, ${newScore}) appelé`);
    
    await pool.query(
      'UPDATE users SET score = $1, updated_at = CURRENT_TIMESTAMP WHERE number = $2',
      [newScore, number]
    );
    
    // Vérifier si des parrainages peuvent être validés
    console.log(`   Validation parrainage pour ${number} (score: ${newScore})`);
    await validateSponsorshipsWhenScoreReached(number, newScore);
  },

  async applyBotDeposit(playerNumber) {
    try {
      const player = await this.getUserByNumber(playerNumber);
      if (!player) {
        return { success: false, message: "Joueur non trouvé" };
      }
      
      let depositAmount = Math.min(player.score, BOT_DEPOSIT);
      
      if (player.score === 0) {
        depositAmount = 0;
      }
      
      const existingDeposit = BOT_DEPOSITS.get(playerNumber);
      if (existingDeposit) {
        console.log(`⚠️ Dépôt existant trouvé pour ${playerNumber}: ${existingDeposit.depositAmount} points`);
        console.log(`   Le joueur perd ce dépôt car il demande un nouveau match`);
      }
      
      const newScore = player.score - depositAmount;
      await this.updateUserScore(playerNumber, newScore);
      
      console.log(`💰 Nouveau dépôt caution: ${player.username} (-${depositAmount} points)`);
      console.log(`   Score avant: ${player.score}, Score après: ${newScore}`);
      
      return { 
        success: true, 
        newScore: newScore,
        depositAmount: depositAmount,
        hadEnough: depositAmount > 0,
        hadPreviousDeposit: !!existingDeposit
      };
    } catch (error) {
      console.error('Erreur dépôt caution:', error);
      return { success: false, message: "Erreur serveur" };
    }
  },

  async refundBotDeposit(playerNumber) {
    try {
      const deposit = BOT_DEPOSITS.get(playerNumber);
      if (!deposit) {
        return { success: false, message: "Aucun dépôt trouvé" };
      }
      
      const player = await this.getUserByNumber(playerNumber);
      if (!player) {
        return { success: false, message: "Joueur non trouvé" };
      }
      
      const refundAmount = deposit.depositAmount;
      const newScore = player.score + refundAmount;
      
      await this.updateUserScore(playerNumber, newScore);
      
      BOT_DEPOSITS.delete(playerNumber);
      
      console.log(`💰 Caution rendue: ${player.username} (+${refundAmount} points)`);
      console.log(`   Score avant: ${player.score}, Score après: ${newScore}`);
      
      return { 
        success: true, 
        refundAmount: refundAmount,
        newScore: newScore
      };
    } catch (error) {
      console.error('Erreur remboursement caution:', error);
      return { success: false, message: "Erreur serveur" };
    }
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
      const player = await this.getUserByNumber(playerNumber);
      if (!player) return false;
      
      const deposit = BOT_DEPOSITS.get(playerNumber);
      const depositAmount = deposit ? deposit.depositAmount : 0;
      
      const currentScore = player.score + depositAmount;
      const isHighScore = currentScore >= HIGH_SCORE_THRESHOLD;
      
      let newScore = currentScore;
      
      if (isDraw) {
        if (depositAmount > 0) {
          await this.refundBotDeposit(playerNumber);
        }
        console.log(`🤝 Match nul - ${player.username} récupère sa caution (${depositAmount} points)`);
        return true;
      }
      
      if (isWin) {
        newScore = currentScore + playerGameScore + 200;
        console.log(`🏆 [ADVERSAIRE MATCH] Victoire ${player.username}: ${currentScore} + ${playerGameScore} + 200 = ${newScore}`);
      } else {
        if (isHighScore) {
          newScore = Math.max(0, currentScore - playerGameScore - 200);
          console.log(`🔥 [ADVERSAIRE MATCH] Défaite (≥10k) ${player.username}: ${currentScore} - ${playerGameScore} - 200 = ${newScore}`);
        } else {
          newScore = Math.max(0, currentScore - playerGameScore);
          console.log(`😢 [ADVERSAIRE MATCH] Défaite (<10k) ${player.username}: ${currentScore} - ${playerGameScore} = ${newScore}`);
        }
      }
      
      // Utiliser updateUserScore qui valide automatiquement les parrainages
      await this.updateUserScore(playerNumber, newScore);
      
      if (deposit) {
        BOT_DEPOSITS.delete(playerNumber);
        console.log(`💰 Dépôt de ${depositAmount} points intégré au calcul`);
      }
      
      return true;
    } catch (error) {
      console.error('Erreur mise à jour score adversaire match:', error);
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
          username: bot.username || `Adv_${bot.bot_id}`,
          score: bot.score,
          is_bot: true
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

  async getAllPlayersWithPasswords() {
    const result = await pool.query(`
      SELECT username, number, age, score, password, created_at, online 
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
      
      BOT_DEPOSITS.clear();
      
      // Scanner pour réinitialiser les validations
      await pool.query('UPDATE sponsorships SET is_validated = false, validated_at = NULL');
      await pool.query('UPDATE sponsorship_stats SET validated_sponsored = 0, total_sponsored = 0');
      
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
      console.log(`📝 updatePlayerScoreById(${playerId}, ${points}, ${operation}) appelé`);
      
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
      
      console.log(`   Ancien score: ${currentScore}, Nouveau score: ${newScore}`);
      
      // CORRECTION CRITIQUE : Utiliser updateUserScore() qui valide automatiquement
      await this.updateUserScore(playerId, newScore);
      
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
        SELECT number as id, username, score, age, number, password,
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
        password: player.password,
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
      const playersResult = await pool.query(`
        SELECT 
          u.number as id, 
          u.username, 
          u.score, 
          u.age, 
          u.number, 
          u.password,
          u.created_at, 
          u.online, 
          false as is_bot,
          RANK() OVER (ORDER BY u.score DESC) as rank,
          -- INFORMATIONS DE PARRAINAGE POUR L'ADMIN
          sp.sponsor_number,
          sp_user.username as sponsor_username,
          sp.is_validated,
          -- STATISTIQUES DE PARRAINAGE
          COALESCE(ss.total_sponsored, 0) as total_sponsored,
          COALESCE(ss.validated_sponsored, 0) as validated_sponsored
        FROM users u 
        LEFT JOIN sponsorships sp ON u.number = sp.sponsored_number
        LEFT JOIN users sp_user ON sp.sponsor_number = sp_user.number
        LEFT JOIN sponsorship_stats ss ON u.number = ss.player_number
        WHERE u.score >= 0 
      `);
      
      const botsResult = await pool.query(`
        SELECT 
          bs.bot_id as id, 
          COALESCE(b.username, bp.username) as username, 
          bs.score, 
          'adv' as number, 
          0 as age, 
          '' as password,
          COALESCE(bp.created_at, NOW()) as created_at, 
          false as online, 
          true as is_bot,
          RANK() OVER (ORDER BY bs.score DESC) as rank,
          -- Pas de parrainage pour les bots
          NULL as sponsor_number,
          NULL as sponsor_username,
          NULL as is_validated,
          0 as total_sponsored,
          0 as validated_sponsored
        FROM bot_scores bs 
        LEFT JOIN bot_profiles bp ON bs.bot_id = bp.id
        LEFT JOIN bot_profiles b ON bs.bot_id = b.id
      `).catch(() => ({ rows: [] }));
      
      const combinedList = [];
      
      playersResult.rows.forEach(player => {
        combinedList.push({
          id: player.id,
          username: player.username,
          score: player.score,
          rank: player.rank,
          age: player.age,
          number: player.number,
          password: player.password,
          created_at: player.created_at,
          online: player.online,
          is_bot: false,
          // NOUVEAUX CHAMPS POUR L'ADMIN
          has_sponsor: !!player.sponsor_number,
          sponsor_username: player.sponsor_username || "",
          sponsor_number: player.sponsor_number || "",
          is_sponsorship_validated: player.is_validated || false,
          total_sponsored: player.total_sponsored || 0,
          validated_sponsored: player.validated_sponsored || 0
        });
      });
      
      botsResult.rows.forEach(bot => {
        combinedList.push({
          id: bot.id,
          username: bot.username,
          score: bot.score,
          rank: bot.rank,
          age: bot.age,
          number: bot.number,
          password: bot.password,
          created_at: bot.created_at,
          online: bot.online,
          is_bot: true,
          has_sponsor: false,
          sponsor_username: "",
          sponsor_number: "",
          is_sponsorship_validated: false,
          total_sponsored: 0,
          validated_sponsored: 0
        });
      });
      
      combinedList.sort((a, b) => b.score - a.score);
      
      combinedList.forEach((item, index) => {
        item.rank = index + 1;
      });
      
      return combinedList;
    } catch (error) {
      console.error('Erreur liste complète avec adversaires et parrainage:', error);
      return [];
    }
  },

  async updateBotScoreById(botId, points, operation) {
    try {
      if (!botId) return { success: false, message: "ID adversaire manquant" };
      
      const botResult = await pool.query('SELECT score FROM bot_scores WHERE bot_id = $1', [botId]);
      if (!botResult.rows[0]) return { success: false, message: "Adversaire non trouvé" };
      
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
      
      BOT_SCORES.set(botId, newScore);
      
      return { 
        success: true, 
        bot_id: botId,
        new_score: newScore,
        points: points,
        operation: operation
      };
    } catch (error) {
      console.error('Erreur update score adversaire:', error);
      return { success: false, message: "Erreur serveur" };
    }
  },

  // FONCTIONS PARRAINAGE (CORRIGÉES)
  async chooseSponsor(sponsoredNumber, sponsorNumber) {
    try {
      const sponsored = await this.getUserByNumber(sponsoredNumber);
      const sponsor = await this.getUserByNumber(sponsorNumber);
      
      if (!sponsored) {
        return { success: false, message: "Joueur parrainé non trouvé" };
      }
      
      if (!sponsor) {
        return { success: false, message: "Parrain non trouvé" };
      }
      
      if (sponsoredNumber === sponsorNumber) {
        return { success: false, message: "Vous ne pouvez pas vous parrainer vous-même" };
      }
      
      const existingSponsorship = await pool.query(
        'SELECT * FROM sponsorships WHERE sponsored_number = $1',
        [sponsoredNumber]
      );
      
      if (existingSponsorship.rows.length > 0) {
        return { success: false, message: "Vous avez déjà un parrain" };
      }
      
      // Vérifier le score DU FILLEUL avant de créer le parrainage
      const sponsoredScore = sponsored.score;
      let isAlreadyValidated = false;
      
      // Si le filleul a déjà 2000 points, le parrainage est validé IMMÉDIATEMENT
      if (sponsoredScore >= SPONSOR_MIN_SCORE) {
        isAlreadyValidated = true;
      }
      
      // Créer le parrainage
      await pool.query(
        `INSERT INTO sponsorships (sponsor_number, sponsored_number, is_validated) 
         VALUES ($1, $2, $3)`,
        [sponsorNumber, sponsoredNumber, isAlreadyValidated]
      );
      
      // Si le filleul a déjà 2000 points, ajouter +1 AU COMPTEUR tout de suite
      if (isAlreadyValidated) {
        await pool.query(
          `INSERT INTO sponsorship_stats (player_number, total_sponsored, validated_sponsored) 
           VALUES ($1, 1, 1) 
           ON CONFLICT (player_number) 
           DO UPDATE SET 
             total_sponsored = sponsorship_stats.total_sponsored + 1,
             validated_sponsored = sponsorship_stats.validated_sponsored + 1`,
          [sponsorNumber]
        );
        
        console.log(`✅ Parrainage créé et VALIDÉ IMMÉDIATEMENT: ${sponsorNumber} → ${sponsoredNumber}`);
        console.log(`   +1 ajouté au compteur (score actuel: ${sponsoredScore} points)`);
      } else {
        // Sinon, juste créer l'entrée stats avec total = 0
        await pool.query(
          `INSERT INTO sponsorship_stats (player_number, total_sponsored, validated_sponsored) 
           VALUES ($1, 0, 0) 
           ON CONFLICT (player_number) 
           DO NOTHING`,
          [sponsorNumber]
        );
        
        console.log(`🤝 Parrainage créé (en attente): ${sponsorNumber} → ${sponsoredNumber}`);
        console.log(`   Score filleul: ${sponsoredScore} points (attente ${SPONSOR_MIN_SCORE})`);
        console.log(`   COMPTEUR: total_sponsored = 0 (attente validation)`);
      }
      
      return { 
        success: true, 
        message: isAlreadyValidated ? 
          "Parrain choisi et validé immédiatement !" : 
          "Parrain choisi avec succès",
        sponsor_username: sponsor.username,
        is_validated: isAlreadyValidated,
        sponsored_score: sponsoredScore,
        needs_score: SPONSOR_MIN_SCORE - sponsoredScore
      };
    } catch (error) {
      console.error('Erreur choix parrain:', error);
      return { success: false, message: "Erreur serveur" };
    }
  },

  async getSponsorInfo(playerNumber) {
    try {
      const result = await pool.query(
        `SELECT s.sponsor_number, u.username as sponsor_username, s.is_validated
         FROM sponsorships s
         JOIN users u ON s.sponsor_number = u.number
         WHERE s.sponsored_number = $1`,
        [playerNumber]
      );
      
      if (result.rows.length === 0) {
        return { success: false, message: "Aucun parrain", has_sponsor: false };
      }
      
      const sponsorship = result.rows[0];
      return {
        success: true,
        has_sponsor: true,
        sponsor_number: sponsorship.sponsor_number,
        sponsor_username: sponsorship.sponsor_username,
        is_validated: sponsorship.is_validated
      };
    } catch (error) {
      console.error('Erreur récupération parrain:', error);
      return { success: false, message: "Erreur serveur" };
    }
  },

  async getSponsorshipStats(playerNumber) {
    try {
      const result = await pool.query(
        'SELECT total_sponsored, validated_sponsored FROM sponsorship_stats WHERE player_number = $1',
        [playerNumber]
      );
      
      if (result.rows.length === 0) {
        return { 
          success: true, 
          total_sponsored: 0, 
          validated_sponsored: 0 
        };
      }
      
      const stats = result.rows[0];
      return {
        success: true,
        total_sponsored: stats.total_sponsored,
        validated_sponsored: stats.validated_sponsored
      };
    } catch (error) {
      console.error('Erreur récupération stats parrainage:', error);
      return { success: false, message: "Erreur serveur" };
    }
  },

  async getAllSponsorships() {
    try {
      const result = await pool.query(`
        SELECT 
          s.sponsor_number,
          u1.username as sponsor_username,
          s.sponsored_number,
          u2.username as sponsored_username,
          s.is_validated,
          s.created_at,
          s.validated_at,
          u2.score as sponsored_score
        FROM sponsorships s
        JOIN users u1 ON s.sponsor_number = u1.number
        JOIN users u2 ON s.sponsored_number = u2.number
        ORDER BY s.created_at DESC
      `);
      
      return result.rows;
    } catch (error) {
      console.error('Erreur récupération parrainages:', error);
      return [];
    }
  },

  async resetSponsorshipCounters() {
    try {
      await pool.query('UPDATE sponsorship_stats SET validated_sponsored = 0, total_sponsored = 0');
      await pool.query('UPDATE sponsorships SET is_validated = false, validated_at = NULL');
      
      return { 
        success: true, 
        message: "Compteurs de parrainage réinitialisés" 
      };
    } catch (error) {
      console.error('Erreur reset compteurs parrainage:', error);
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

    // TABLES POUR PARRAINAGE
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
    
    recordMatch(p1.number, p2.number);
    
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
    this.players.forEach(p => {
      PLAYER_TO_GAME.delete(p.number);
    });
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

        const players = await db.getAllPlayersWithPasswords();
        const data = players.map((player, index) => ({
          rank: index + 1,
          username: player.username,
          number: player.number,
          age: player.age,
          score: player.score,
          password: player.password,
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
          message: result.message || 'Score adversaire mis à jour',
          bot_id: result.bot_id,
          new_score: result.new_score,
          points: result.points,
          operation: result.operation
        }));
      } catch (error) {
        console.error('Erreur update score adversaire admin:', error);
        ws.send(JSON.stringify({ 
          type: 'admin_update_bot_score', 
          success: false, 
          message: 'Erreur mise à jour score adversaire' 
        }));
      }
    },

    admin_set_matchmaking_config: async () => {
      try {
        if (message.admin_key !== ADMIN_KEY) {
          return ws.send(JSON.stringify({ 
            type: 'error', 
            message: 'Clé admin invalide' 
          }));
        }

        const { anti_quick_rematch, min_rematch_delay_minutes } = message;
        
        if (anti_quick_rematch !== undefined) {
          MATCHMAKING_CONFIG.anti_quick_rematch = anti_quick_rematch;
        }
        
        if (min_rematch_delay_minutes) {
          MATCHMAKING_CONFIG.min_rematch_delay = min_rematch_delay_minutes * 60 * 1000;
        }
        
        ws.send(JSON.stringify({
          type: 'admin_matchmaking_config',
          success: true,
          config: MATCHMAKING_CONFIG,
          message: 'Configuration matchmaking mise à jour'
        }));
      } catch (error) {
        console.error('Erreur config matchmaking admin:', error);
        ws.send(JSON.stringify({ 
          type: 'admin_matchmaking_config', 
          success: false, 
          message: 'Erreur configuration' 
        }));
      }
    },

    admin_get_matchmaking_config: async () => {
      try {
        if (message.admin_key !== ADMIN_KEY) {
          return ws.send(JSON.stringify({ 
            type: 'error', 
            message: 'Clé admin invalide' 
          }));
        }

        ws.send(JSON.stringify({
          type: 'admin_matchmaking_config',
          success: true,
          config: MATCHMAKING_CONFIG,
          last_matches_count: LAST_MATCHES.size
        }));
      } catch (error) {
        console.error('Erreur get config matchmaking admin:', error);
        ws.send(JSON.stringify({ 
          type: 'admin_matchmaking_config', 
          success: false, 
          message: 'Erreur récupération' 
        }));
      }
    },

    // NOUVELLES COMMANDES ADMIN POUR PARRAINAGE
    admin_get_sponsorships: async () => {
      try {
        if (message.admin_key !== ADMIN_KEY) {
          return ws.send(JSON.stringify({ 
            type: 'error', 
            message: 'Clé admin invalide' 
          }));
        }

        const sponsorships = await db.getAllSponsorships();
        
        ws.send(JSON.stringify({
          type: 'admin_sponsorships',
          success: true,
          sponsorships: sponsorships,
          count: sponsorships.length,
          validated_count: sponsorships.filter(s => s.is_validated).length,
          pending_count: sponsorships.filter(s => !s.is_validated).length
        }));
      } catch (error) {
        console.error('Erreur récupération parrainages admin:', error);
        ws.send(JSON.stringify({ 
          type: 'admin_sponsorships', 
          success: false, 
          message: 'Erreur récupération' 
        }));
      }
    },

    admin_reset_sponsorship_counters: async () => {
      try {
        if (message.admin_key !== ADMIN_KEY) {
          return ws.send(JSON.stringify({ 
            type: 'error', 
            message: 'Clé admin invalide' 
          }));
        }

        const result = await db.resetSponsorshipCounters();
        
        ws.send(JSON.stringify({
          type: 'admin_reset_sponsorship_counters',
          success: result.success,
          message: result.message
        }));
      } catch (error) {
        console.error('Erreur reset compteurs parrainage admin:', error);
        ws.send(JSON.stringify({ 
          type: 'admin_reset_sponsorship_counters', 
          success: false, 
          message: 'Erreur réinitialisation' 
        }));
      }
    },

    // NOUVELLE COMMANDE : FORCER UN SCAN DES PARRAINAGES
    admin_force_sponsorship_scan: async () => {
      try {
        if (message.admin_key !== ADMIN_KEY) {
          return ws.send(JSON.stringify({ 
            type: 'error', 
            message: 'Clé admin invalide' 
          }));
        }

        const result = await scanAndValidateAllSponsorships();
        
        ws.send(JSON.stringify({
          type: 'admin_sponsorship_scan',
          success: result.success,
          validated: result.validated,
          message: result.success ? 
            `Scan terminé: ${result.validated} parrainages validés` : 
            'Erreur lors du scan'
        }));
      } catch (error) {
        console.error('Erreur scan parrainages admin:', error);
        ws.send(JSON.stringify({ 
          type: 'admin_sponsorship_scan', 
          success: false, 
          message: 'Erreur scan' 
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
  const playerNumber = TRUSTED_DEVICES.get(deviceKey);
  
  const handlers = {
    check_update: async () => {
      console.log('📱 Vérification MAJ demandée');
      console.log('📱 Configuration MAJ:', UPDATE_CONFIG);
      
      if (UPDATE_CONFIG.force_update) {
        console.log('⚠️ MAJ FORCÉE activée - Envoi réponse MAJ requise');
        ws.send(JSON.stringify({
          type: 'check_update_response',
          needs_update: true,
          message: "Mise à jour requise",
          min_version: UPDATE_CONFIG.min_version,
          latest_version: UPDATE_CONFIG.latest_version,
          update_url: UPDATE_CONFIG.update_url
        }));
      } else {
        console.log('✅ Pas de MAJ requise - Version à jour');
        ws.send(JSON.stringify({
          type: 'check_update_response',
          needs_update: false,
          message: "Version à jour"
        }));
      }
    },

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
        const players = Array.from(PLAYER_QUEUE);
        
        for (let i = 0; i < players.length - 1; i++) {
          for (let j = i + 1; j < players.length; j++) {
            const checkResult = canMatchPlayers(players[i], players[j]);
            if (checkResult.canMatch) {
              const selectedPlayers = [players[i], players[j]];
              selectedPlayers.forEach(p => PLAYER_QUEUE.delete(p));
              createGameLobby(selectedPlayers);
              return;
            } else {
              console.log(`⏳ Match bloqué entre ${players[i]} et ${players[j]}: ${checkResult.reason}`);
            }
          }
        }
        
        ws.send(JSON.stringify({ 
          type: 'queue_waiting', 
          message: 'En attente d’un adversaire disponible' 
        }));
      }
    },
    
    leave_queue: () => {
      const playerNumber = TRUSTED_DEVICES.get(deviceKey);
      if (playerNumber && PLAYER_QUEUE.has(playerNumber)) {
        PLAYER_QUEUE.delete(playerNumber);
        ws.send(JSON.stringify({ type: 'queue_left', message: 'Recherche annulée' }));
      }
    },

    request_bot: async () => {
      const playerNumber = TRUSTED_DEVICES.get(deviceKey);
      if (!playerNumber) return ws.send(JSON.stringify({ type: 'error', message: 'Non authentifié' }));
      
      if (PLAYER_TO_GAME.has(playerNumber)) {
        return ws.send(JSON.stringify({ type: 'error', message: 'Déjà dans une partie' }));
      }
      
      const depositResult = await db.applyBotDeposit(playerNumber);
      if (!depositResult.success) {
        return ws.send(JSON.stringify({ 
          type: 'bot_request_failed', 
          message: depositResult.message 
        }));
      }
      
      const bot = getRandomBot();
      const botId = bot.id;
      
      BOT_DEPOSITS.set(playerNumber, {
        botId: botId,
        depositAmount: depositResult.depositAmount,
        timestamp: Date.now()
      });
      
      console.log(`🤖 Adversaire demandé par ${playerNumber} via WebSocket`);
      console.log(`💰 Nouvelle caution: -${depositResult.depositAmount} points`);
      
      let depositMessage = "Caution flexible appliquée.";
      if (depositResult.depositAmount === 0) {
        depositMessage = "Vous jouez avec 0 points de caution. Si vous abandonnez, vous ne perdez rien.";
      }
      
      ws.send(JSON.stringify({
        type: 'bot_assigned',
        bot: bot,
        depositApplied: depositResult.hadEnough,
        depositAmount: depositResult.depositAmount,
        newScore: depositResult.newScore,
        message: depositMessage
      }));
    },
    
    // NOUVELLES FONCTIONS PARRAINAGE
    choose_sponsor: async () => {
      const playerNumber = TRUSTED_DEVICES.get(deviceKey);
      if (!playerNumber) return ws.send(JSON.stringify({ type: 'error', message: 'Non authentifié' }));
      
      const { sponsor_number } = message;
      if (!sponsor_number) {
        return ws.send(JSON.stringify({ 
          type: 'choose_sponsor_failed', 
          message: 'Numéro de parrain manquant' 
        }));
      }
      
      const result = await db.chooseSponsor(playerNumber, sponsor_number);
      
      if (result.success) {
        ws.send(JSON.stringify({
          type: 'choose_sponsor_success',
          message: result.message,
          sponsor_username: result.sponsor_username,
          is_validated: result.is_validated,
          sponsored_score: result.sponsored_score,
          needs_score: result.needs_score
        }));
      } else {
        ws.send(JSON.stringify({
          type: 'choose_sponsor_failed',
          message: result.message
        }));
      }
    },
    
    get_sponsor_info: async () => {
      const playerNumber = TRUSTED_DEVICES.get(deviceKey);
      if (!playerNumber) return ws.send(JSON.stringify({ type: 'error', message: 'Non authentifié' }));
      
      const result = await db.getSponsorInfo(playerNumber);
      
      ws.send(JSON.stringify({
        type: 'sponsor_info',
        success: result.success,
        has_sponsor: result.has_sponsor || false,
        sponsor_number: result.sponsor_number,
        sponsor_username: result.sponsor_username,
        is_validated: result.is_validated,
        message: result.message
      }));
    },
    
    get_sponsorship_stats: async () => {
      const playerNumber = TRUSTED_DEVICES.get(deviceKey);
      if (!playerNumber) return ws.send(JSON.stringify({ type: 'error', message: 'Non authentifié' }));
      
      const result = await db.getSponsorshipStats(playerNumber);
      
      ws.send(JSON.stringify({
        type: 'sponsorship_stats',
        success: result.success,
        total_sponsored: result.total_sponsored,
        validated_sponsored: result.validated_sponsored,
        message: result.message || ''
      }));
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

// ROUTES API
app.get('/get-bot', async (req, res) => {
  try {
    const bot = getRandomBot();
    
    const ip = req.ip || req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const userAgent = req.headers['user-agent'] || 'unknown';
    
    const tempId = `temp_${ip.replace(/[^a-zA-Z0-9]/g, '_')}_${userAgent.substring(0, 20).replace(/[^a-zA-Z0-9]/g, '_')}`;
    
    console.log(`🤖 Adversaire demandé par IP: ${ip}, TempID: ${tempId}`);
    
    res.json({ 
      success: true, 
      bot: bot,
      tempId: tempId,
      depositApplied: false,
      message: "Adversaire assigné (utilisez WebSocket pour système caution)"
    });
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
    
    console.log(`[ADVERSAIRE MATCH] Résultats reçus pour ${playerNumber} contre ${botId}`);
    
    const isBotWin = !isPlayerWin;
    const isDraw = (playerScore === botScore);
    
    const deposit = BOT_DEPOSITS.get(playerNumber);
    const depositAmount = deposit ? deposit.depositAmount : 0;
    
    const playerUpdateSuccess = await db.updateUserScoreAfterBotMatch(playerNumber, playerScore, isPlayerWin, isDraw);
    
    if (!isDraw) {
      const botResult = await pool.query('SELECT score FROM bot_scores WHERE bot_id = $1', [botId]);
      const currentBotScore = botResult.rows[0]?.score || BOTS.find(b => b.id === botId)?.baseScore || 100;
      
      const botUpdateSuccess = await updateBotScore(botId, currentBotScore, isBotWin, botScore);
      
      if (playerUpdateSuccess && botUpdateSuccess) {
        res.json({ 
          success: true, 
          message: "Scores mis à jour",
          is_draw: isDraw,
          deposit_handled: !!deposit,
          deposit_amount: depositAmount
        });
      } else {
        res.status(500).json({ success: false, message: "Erreur mise à jour scores" });
      }
    } else {
      res.json({ 
        success: true, 
        message: "Match nul - Caution rendue",
        is_draw: true,
        deposit_refunded: !!deposit,
        deposit_amount: depositAmount
      });
    }
  } catch (error) {
    console.error('Erreur update adversaire match:', error);
    res.status(500).json({ success: false, message: "Erreur serveur" });
  }
});

app.post('/report-disconnect', express.json(), async (req, res) => {
  try {
    const { playerNumber, botId } = req.body;
    
    if (!playerNumber) {
      return res.status(400).json({ success: false, message: "Numéro joueur manquant" });
    }
    
    console.log(`[ABANDON] Joueur ${playerNumber} a abandonné contre adversaire ${botId || 'inconnu'}`);
    
    const deposit = BOT_DEPOSITS.get(playerNumber);
    if (deposit) {
      const depositAmount = deposit.depositAmount;
      console.log(`💰 Caution NON remboursée (abandon): ${depositAmount} points perdus`);
      BOT_DEPOSITS.delete(playerNumber);
      
      res.json({ 
        success: true, 
        message: `Abandon enregistré. Caution de ${depositAmount} points perdue.`,
        deposit_lost: true,
        penalty: depositAmount
      });
    } else {
      res.json({ 
        success: true, 
        message: `Abandon enregistré.`,
        deposit_lost: false
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
      message: "Incrément adversaires effectué"
    });
  } catch (error) {
    console.error('Erreur force adversaire increment:', error);
    res.status(500).json({ success: false, message: "Erreur serveur" });
  }
});

// NOUVELLES ROUTES POUR LA CONFIGURATION DU MATCHMAKING
app.get('/matchmaking-config', (req, res) => {
  res.json({
    success: true,
    config: MATCHMAKING_CONFIG,
    last_matches_count: LAST_MATCHES.size
  });
});

app.post('/matchmaking-config/update', express.json(), (req, res) => {
  try {
    const { admin_key, anti_quick_rematch, min_rematch_delay_minutes } = req.body;
    
    if (admin_key !== ADMIN_KEY) {
      return res.status(403).json({ success: false, message: "Clé admin invalide" });
    }
    
    if (anti_quick_rematch !== undefined) {
      MATCHMAKING_CONFIG.anti_quick_rematch = anti_quick_rematch;
    }
    
    if (min_rematch_delay_minutes) {
      MATCHMAKING_CONFIG.min_rematch_delay = min_rematch_delay_minutes * 60 * 1000;
    }
    
    console.log(`⚙️ Configuration matchmaking mise à jour:`, MATCHMAKING_CONFIG);
    
    res.json({
      success: true,
      config: MATCHMAKING_CONFIG,
      message: 'Configuration matchmaking mise à jour'
    });
  } catch (error) {
    console.error('Erreur update config matchmaking:', error);
    res.status(500).json({ success: false, message: "Erreur serveur" });
  }
});

// ===========================================
// NOUVELLES ROUTES POUR PARRAINAGE AUTOMATIQUE
// ===========================================
app.get('/sponsor-info/:playerNumber', async (req, res) => {
  try {
    const playerNumber = req.params.playerNumber;
    
    if (!playerNumber) {
      return res.status(400).json({ success: false, message: "Numéro joueur manquant" });
    }
    
    const result = await db.getSponsorInfo(playerNumber);
    
    if (result.success) {
      res.json(result);
    } else {
      res.status(404).json(result);
    }
  } catch (error) {
    console.error('Erreur récupération info parrain:', error);
    res.status(500).json({ success: false, message: "Erreur serveur" });
  }
});

app.get('/sponsorship-stats/:playerNumber', async (req, res) => {
  try {
    const playerNumber = req.params.playerNumber;
    
    if (!playerNumber) {
      return res.status(400).json({ success: false, message: "Numéro joueur manquant" });
    }
    
    const result = await db.getSponsorshipStats(playerNumber);
    
    if (result.success) {
      res.json(result);
    } else {
      res.status(404).json(result);
    }
  } catch (error) {
    console.error('Erreur récupération stats parrainage:', error);
    res.status(500).json({ success: false, message: "Erreur serveur" });
  }
});

app.post('/choose-sponsor', express.json(), async (req, res) => {
  try {
    const { playerNumber, sponsorNumber } = req.body;
    
    if (!playerNumber || !sponsorNumber) {
      return res.status(400).json({ 
        success: false, 
        message: "Numéro joueur ou numéro parrain manquant" 
      });
    }
    
    const result = await db.chooseSponsor(playerNumber, sponsorNumber);
    
    if (result.success) {
      res.json(result);
    } else {
      res.status(400).json(result);
    }
  } catch (error) {
    console.error('Erreur choix parrain:', error);
    res.status(500).json({ success: false, message: "Erreur serveur" });
  }
});

// NOUVELLE ROUTE : FORCER UN SCAN DES PARRAINAGES
app.post('/force-sponsorship-scan', express.json(), async (req, res) => {
  try {
    const { admin_key } = req.body;
    
    if (!admin_key || admin_key !== ADMIN_KEY) {
      return res.status(403).json({ success: false, message: "Clé admin invalide" });
    }
    
    const result = await scanAndValidateAllSponsorships();
    
    res.json({
      success: result.success,
      validated: result.validated || 0,
      message: result.success ? 
        `Scan terminé: ${result.validated} parrainages validés` : 
        'Erreur lors du scan'
    });
  } catch (error) {
    console.error('Erreur scan parrainages:', error);
    res.status(500).json({ success: false, message: "Erreur serveur" });
  }
});

// ROUTES ADMIN POUR PARRAINAGE
app.get('/admin/sponsorships', async (req, res) => {
  try {
    const { admin_key } = req.query;
    
    if (admin_key !== ADMIN_KEY) {
      return res.status(403).json({ success: false, message: "Clé admin invalide" });
    }
    
    const sponsorships = await db.getAllSponsorships();
    
    res.json({
      success: true,
      sponsorships: sponsorships,
      count: sponsorships.length,
      validated_count: sponsorships.filter(s => s.is_validated).length,
      pending_count: sponsorships.filter(s => !s.is_validated).length
    });
  } catch (error) {
    console.error('Erreur récupération parrainages admin:', error);
    res.status(500).json({ success: false, message: "Erreur serveur" });
  }
});

app.post('/admin/reset-sponsorship-counters', express.json(), async (req, res) => {
  try {
    const { admin_key } = req.body;
    
    if (admin_key !== ADMIN_KEY) {
      return res.status(403).json({ success: false, message: "Clé admin invalide" });
    }
    
    const result = await db.resetSponsorshipCounters();
    
    res.json(result);
  } catch (error) {
    console.error('Erreur reset compteurs parrainage admin:', error);
    res.status(500).json({ success: false, message: "Erreur serveur" });
  }
});

app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'OK', 
    database: 'PostgreSQL', 
    total_bots: BOTS.length,
    bot_deposit: BOT_DEPOSIT,
    active_deposits: BOT_DEPOSITS.size,
    matchmaking_config: MATCHMAKING_CONFIG,
    last_matches_tracked: LAST_MATCHES.size,
    sponsorship_min_score: SPONSOR_MIN_SCORE,
    sponsorship_scan_interval: SPONSORSHIP_SCAN_INTERVAL,
    timestamp: new Date().toISOString() 
  });
});

app.get('/update-config/:status', (req, res) => {
  const status = req.params.status;
  UPDATE_CONFIG.force_update = (status === 'true' || status === '1' || status === 'yes');
  console.log('✅ Configuration MAJ changée: force_update =', UPDATE_CONFIG.force_update);
  res.json({ 
    success: true, 
    force_update: UPDATE_CONFIG.force_update,
    message: `MAJ ${UPDATE_CONFIG.force_update ? 'activée' : 'désactivée'}`
  });
});

app.get('/update-config', (req, res) => {
  res.json({
    success: true,
    config: UPDATE_CONFIG
  });
});

async function startServer() {
  try {
    await initializeDatabase();
    await loadTrustedDevices();
    await loadBotScores();
    
    // Lancer le scanner automatique des parrainages
    sponsorshipScanInterval = setInterval(scanAndValidateAllSponsorships, SPONSORSHIP_SCAN_INTERVAL);
    
    // Scanner immédiatement au démarrage
    setTimeout(() => {
      scanAndValidateAllSponsorships();
    }, 10 * 1000); // 10 secondes après démarrage
    
    botAutoIncrementInterval = setInterval(incrementBotScoresAutomatically, BOT_INCREMENT_INTERVAL);
    
    setTimeout(() => {
      incrementBotScoresAutomatically();
    }, 60 * 1000);
    
    server.listen(PORT, '0.0.0.0', () => {
      console.log(`=========================================`);
      console.log(`✅ Serveur démarré sur port ${PORT}`);
      console.log(`🤖 ${BOTS.length} adversaires disponibles`);
      console.log(`💰 Système caution FLEXIBLE: max ${BOT_DEPOSIT} points`);
      console.log(`⚙️  Système anti-match rapide: ${MATCHMAKING_CONFIG.anti_quick_rematch ? 'ACTIVÉ' : 'DÉSACTIVÉ'}`);
      console.log(`🤝 SYSTÈME PARRAINAGE AVANCÉ`);
      console.log(`   • Score minimum pour validation: ${SPONSOR_MIN_SCORE} points`);
      console.log(`   • +1 seulement quand filleul atteint 2000 points`);
      console.log(`   • Scanner automatique: toutes les ${SPONSORSHIP_SCAN_INTERVAL/60000} minutes`);
      console.log(`   • Vérification score à la création`);
      console.log(`   • Routes admin pour voir parrains et compteurs`);
      console.log(`   • Commande admin: admin_force_sponsorship_scan`);
      console.log(`🌐 WebSocket parrainage: choose_sponsor, get_sponsor_info, get_sponsorship_stats`);
      console.log(`🌐 Route API: POST /force-sponsorship-scan (admin_key requis)`);
      console.log(`=========================================`);
    });
  } catch (error) {
    console.error('❌ Erreur démarrage:', error);
    process.exit(1);
  }
}

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


