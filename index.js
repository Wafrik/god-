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
const LOW_SCORE_THRESHOLD = 3000;
const BOT_INCREMENT_INTERVAL = 3 * 60 * 60 * 1000;
const SPONSOR_MIN_SCORE = 2000;
const SPONSORSHIP_SCAN_INTERVAL = 5 * 60 * 1000;
const LOBBY_TIMEOUT = 30000;
const AUTO_MOVE_BONUS = 200;

// Pénalité abandon 1v1
const PVP_QUIT_PENALTY = 250;

// CONFIGURATION DU MATCHMAKING
const MATCHMAKING_CONFIG = {
  anti_quick_rematch: true,
  min_rematch_delay: 50 * 60 * 1000,
};

const UPDATE_CONFIG = {
  force_update: false,
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
const PENDING_LOBBIES = new Map();

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

// FONCTIONS PERSISTANTES POUR ANTI-MATCH RAPIDE
async function canMatchPlayers(player1Number, player2Number) {
  if (!MATCHMAKING_CONFIG.anti_quick_rematch) {
    return { canMatch: true, reason: "Anti-quick-rematch désactivé" };
  }
  
  try {
    const player1 = await db.getUserByNumber(player1Number);
    const player2 = await db.getUserByNumber(player2Number);
    
    if (!player1 || !player2) {
      return { canMatch: true, reason: "Un des joueurs non trouvé" };
    }
    
    if ((player1.score >= HIGH_SCORE_THRESHOLD && player2.score < LOW_SCORE_THRESHOLD) ||
        (player2.score >= HIGH_SCORE_THRESHOLD && player1.score < LOW_SCORE_THRESHOLD)) {
      return { 
        canMatch: false, 
        reason: `Écart de score trop important (≥${HIGH_SCORE_THRESHOLD} vs <${LOW_SCORE_THRESHOLD})` 
      };
    }
    
    const result = await pool.query(`
      SELECT * FROM recent_matches 
      WHERE (player1_number = $1 AND player2_number = $2)
         OR (player1_number = $2 AND player2_number = $1)
         AND match_timestamp > NOW() - INTERVAL '${MATCHMAKING_CONFIG.min_rematch_delay / 60000} minutes'
      LIMIT 1
    `, [player1Number, player2Number]);
    
    if (result.rows.length > 0) {
      const match = result.rows[0];
      const matchTime = new Date(match.match_timestamp);
      const now = new Date();
      const timeSinceMatch = now - matchTime;
      const remainingTimeMs = MATCHMAKING_CONFIG.min_rematch_delay - timeSinceMatch;
      
      if (remainingTimeMs > 0) {
        const remainingMinutes = Math.ceil(remainingTimeMs / 60000);
        return { 
          canMatch: false, 
          reason: `Vous avez déjà joué contre ce joueur il y a moins de ${remainingMinutes} minute(s)`
        };
      }
    }
    
    await pool.query(`
      DELETE FROM recent_matches 
      WHERE match_timestamp < NOW() - INTERVAL '${MATCHMAKING_CONFIG.min_rematch_delay / 60000} minutes'
    `);
    
    return { canMatch: true, reason: "Match autorisé" };
  } catch (error) {
    console.error('Erreur vérification match rapide:', error);
    return { canMatch: true, reason: "Erreur vérification, autorisation par défaut" };
  }
}

// ENREGISTRER UN MATCH DANS LA BASE PERSISTANTE
async function recordMatch(player1Number, player2Number) {
  try {
    await pool.query(`
      INSERT INTO recent_matches (player1_number, player2_number, match_timestamp) 
      VALUES ($1, $2, NOW())
      ON CONFLICT (player1_number, player2_number) 
      DO UPDATE SET match_timestamp = NOW()
    `, [player1Number, player2Number]);
    
    console.log(`📝 Match enregistré dans DB: ${player1Number} vs ${player2Number}`);
  } catch (error) {
    console.error('Erreur enregistrement match:', error);
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

async function scanAndValidateAllSponsorships() {
  try {
    console.log('🔍 Démarrage scan global des parrainages (anti-revalidation)...');
    
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
      LEFT JOIN sponsorship_validated_history h ON u.number = h.sponsored_number
      WHERE u.score >= $1 
        AND s.is_validated = false
        AND h.sponsored_number IS NULL
      ORDER BY u.score DESC
    `, [SPONSOR_MIN_SCORE]);
    
    console.log(`📊 ${result.rows.length} NOUVEAUX parrainages éligibles à la validation trouvés`);
    
    let validatedCount = 0;
    
    for (const row of result.rows) {
      const sponsoredNumber = row.sponsored_number;
      const sponsoredUsername = row.sponsored_username;
      const sponsoredScore = row.sponsored_score;
      const sponsorNumber = row.sponsor_number;
      const sponsorUsername = row.sponsor_username;
      
      console.log(`🎯 NOUVEAU parrainage à valider: ${sponsoredUsername} (${sponsoredScore} points) → ${sponsorUsername}`);
      
      await pool.query(
        `UPDATE sponsorships 
         SET is_validated = true, validated_at = CURRENT_TIMESTAMP 
         WHERE sponsor_number = $1 AND sponsored_number = $2`,
        [sponsorNumber, sponsoredNumber]
      );
      
      await pool.query(
        `INSERT INTO sponsorship_validated_history (sponsor_number, sponsored_number, validated_at)
         VALUES ($1, $2, CURRENT_TIMESTAMP)
         ON CONFLICT (sponsored_number) DO NOTHING`,
        [sponsorNumber, sponsoredNumber]
      );
      
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
      console.log(`   Score: ${sponsoredScore} points | +1 ajouté au compteur | Ajouté à l'historique`);
      
      validatedCount++;
      
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
      console.log(`🎉 Scan terminé: ${validatedCount} NOUVEAUX parrainages validés`);
    } else {
      console.log('✅ Aucun NOUVEAU parrainage à valider');
    }
    
    return { success: true, validated: validatedCount };
  } catch (error) {
    console.error('❌ Erreur scan parrainages:', error);
    return { success: false, error: error.message };
  }
}

async function validateSponsorshipsWhenScoreReached(playerNumber, newScore) {
  try {
    if (newScore >= SPONSOR_MIN_SCORE) {
      const sponsorshipsResult = await pool.query(
        `SELECT s.* 
         FROM sponsorships s
         LEFT JOIN sponsorship_validated_history h ON s.sponsored_number = h.sponsored_number
         WHERE s.sponsored_number = $1 
         AND s.is_validated = false
         AND h.sponsored_number IS NULL`,
        [playerNumber]
      );
      
      for (const sponsorship of sponsorshipsResult.rows) {
        await pool.query(
          `UPDATE sponsorships 
           SET is_validated = true, validated_at = CURRENT_TIMESTAMP 
           WHERE sponsor_number = $1 AND sponsored_number = $2`,
          [sponsorship.sponsor_number, sponsorship.sponsored_number]
        );
        
        await pool.query(
          `INSERT INTO sponsorship_validated_history (sponsor_number, sponsored_number, validated_at)
           VALUES ($1, $2, CURRENT_TIMESTAMP)
           ON CONFLICT (sponsored_number) DO NOTHING`,
          [sponsorship.sponsor_number, sponsorship.sponsored_number]
        );
        
        await pool.query(
          `INSERT INTO sponsorship_stats (player_number, total_sponsored, validated_sponsored) 
           VALUES ($1, 1, 1) 
           ON CONFLICT (player_number) 
           DO UPDATE SET 
             total_sponsored = sponsorship_stats.total_sponsored + 1,
             validated_sponsored = sponsorship_stats.validated_sponsored + 1`,
          [sponsorship.sponsor_number]
        );
        
        console.log(`✅ NOUVEAU parrainage validé: ${sponsorship.sponsor_number} → ${sponsorship.sponsored_number}`);
        console.log(`   +1 ajouté au compteur (score atteint: ${newScore}) | Ajouté à l'historique`);
        
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
    
    // Vérifier si le numéro est sur liste noire
    const blacklisted = await this.isNumberBlacklisted(number);
    if (blacklisted) {
      throw new Error('Ce numéro a été banni et ne peut pas être réutilisé');
    }
    
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
    
    console.log(`   Validation parrainage pour ${number} (score: ${newScore})`);
    await validateSponsorshipsWhenScoreReached(number, newScore);
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

  // IMPORTANT: Fonction pour matchs contre BOTS (système simplifié)
  async updateUserScoreAfterBotMatch(playerNumber, playerGameScore, isWin, isDraw = false) {
    try {
      const player = await this.getUserByNumber(playerNumber);
      if (!player) return false;
      
      const currentScore = player.score;
      const isHighScore = currentScore >= HIGH_SCORE_THRESHOLD;
      
      let newScore = currentScore;
      
      if (isDraw) {
        console.log(`🤝 Match nul - ${player.username} garde son score`);
        return true;
      }
      
      if (isWin) {
        newScore = currentScore + playerGameScore + 200;
        console.log(`🏆 [BOT MATCH] Victoire ${player.username}: ${currentScore} + ${playerGameScore} + 200 = ${newScore}`);
      } else {
        if (isHighScore) {
          newScore = Math.max(0, currentScore - playerGameScore - 200);
          console.log(`🔥 [BOT MATCH] Défaite (≥10k) ${player.username}: ${currentScore} - ${playerGameScore} - 200 = ${newScore}`);
        } else {
          newScore = Math.max(0, currentScore - playerGameScore);
          console.log(`😢 [BOT MATCH] Défaite (<10k) ${player.username}: ${currentScore} - ${playerGameScore} = ${newScore}`);
        }
      }
      
      await this.updateUserScore(playerNumber, newScore);
      
      return true;
    } catch (error) {
      console.error('Erreur mise à jour score bot match:', error);
      return false;
    }
  },

  // Pénalité abandon en match PVP (1v1)
  async applyPvPQuitPenalty(quitterNumber, remainingPlayerNumber) {
    try {
      const quitter = await this.getUserByNumber(quitterNumber);
      const remaining = await this.getUserByNumber(remainingPlayerNumber);
      
      if (!quitter || !remaining) return false;
      
      // Pénalité pour celui qui quitte: TOUJOURS -250 points
      const newQuitterScore = Math.max(0, quitter.score - PVP_QUIT_PENALTY);
      
      // Bonus pour celui qui reste: +200 points
      const newRemainingScore = remaining.score + AUTO_MOVE_BONUS;
      
      console.log(`🎮 [PVP ABANDON] ${quitter.username} quitte le match`);
      console.log(`   ${quitter.username}: ${quitter.score} - ${PVP_QUIT_PENALTY} = ${newQuitterScore} (TOUJOURS -${PVP_QUIT_PENALTY} points)`);
      console.log(`   ${remaining.username}: ${remaining.score} + ${AUTO_MOVE_BONUS} = ${newRemainingScore} (bonus abandon)`);
      
      await this.updateUserScore(quitterNumber, newQuitterScore);
      await this.updateUserScore(remainingPlayerNumber, newRemainingScore);
      
      return true;
    } catch (error) {
      console.error('Erreur pénalité PVP abandon:', error);
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
      
      // Enregistrer la date du reset dans la base
      await pool.query(`
        INSERT INTO admin_resets (reset_date, reset_type) 
        VALUES (CURRENT_TIMESTAMP, 'weekly_scores')
        ON CONFLICT DO NOTHING
      `);
      
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
          sp.sponsor_number,
          sp_user.username as sponsor_username,
          sp.is_validated,
          COALESCE(ss.validated_sponsored, 0) as total_sponsored,
          (
            SELECT COALESCE(COUNT(*), 0)
            FROM sponsorship_validated_history vh
            LEFT JOIN (
              SELECT MAX(reset_date) as last_reset 
              FROM admin_resets 
              WHERE reset_type = 'sponsorship_counters'
            ) r ON 1=1
            WHERE vh.sponsor_number = u.number
            AND (r.last_reset IS NULL OR vh.validated_at >= r.last_reset)
          ) as validated_sponsored
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
  
  async resetSponsorshipCounters() {
    try {
      // Enregistrer la date du reset des parrainages
      await pool.query(`
        INSERT INTO admin_resets (reset_date, reset_type, notes) 
        VALUES (CURRENT_TIMESTAMP, 'sponsorship_counters', 'Reset hebdomadaire des compteurs parrainage')
        ON CONFLICT DO NOTHING
      `);
      
      console.log(`🔄 Reset des compteurs parrainage effectué à ${new Date().toISOString()}`);
      
      return { 
        success: true, 
        message: "Compteurs de parrainage réinitialisés",
        reset_date: new Date().toISOString(),
        notes: "Les compteurs FV afficheront maintenant seulement les validations après cette date"
      };
    } catch (error) {
      console.error('Erreur reset compteurs parrainage:', error);
      return { success: false, message: "Erreur serveur" };
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
      
      const alreadyValidatedInHistory = await pool.query(
        'SELECT * FROM sponsorship_validated_history WHERE sponsored_number = $1',
        [sponsoredNumber]
      );
      
      if (alreadyValidatedInHistory.rows.length > 0) {
        return { success: false, message: "Ce joueur a déjà validé un parrainage (ne peut plus changer)" };
      }
      
      const sponsoredScore = sponsored.score;
      let isAlreadyValidated = false;
      
      if (sponsoredScore >= SPONSOR_MIN_SCORE) {
        isAlreadyValidated = true;
      }
      
      await pool.query(
        `INSERT INTO sponsorships (sponsor_number, sponsored_number, is_validated) 
         VALUES ($1, $2, $3)`,
        [sponsorNumber, sponsoredNumber, isAlreadyValidated]
      );
      
      if (isAlreadyValidated) {
        await pool.query(
          `INSERT INTO sponsorship_validated_history (sponsor_number, sponsored_number, validated_at)
           VALUES ($1, $2, CURRENT_TIMESTAMP)`,
          [sponsorNumber, sponsoredNumber]
        );
        
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
        console.log(`   +1 ajouté au compteur (score actuel: ${sponsoredScore} points) | Ajouté à l'historique`);
      } else {
        await pool.query(
          `INSERT INTO sponsorship_stats (player_number, total_sponsored, validated_sponsored) 
           VALUES ($1, 0, 0) 
           ON CONFLICT (player_number) 
           DO NOTHING`,
          [sponsorNumber]
        );
        
        console.log(`🤝 Parrainage créé (en attente): ${sponsorNumber} → ${sponsoredNumber}`);
        console.log(`   Score filleul: ${sponsoredScore} points (attente ${SPONSOR_MIN_SCORE})`);
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
        `SELECT s.sponsor_number, u.username as sponsor_username, s.is_validated,
                h.validated_at as permanently_validated_at
         FROM sponsorships s
         JOIN users u ON s.sponsor_number = u.number
         LEFT JOIN sponsorship_validated_history h ON s.sponsored_number = h.sponsored_number
         WHERE s.sponsored_number = $1`,
        [playerNumber]
      );
      
      if (result.rows.length === 0) {
        return { success: false, message: "Aucun parrain", has_sponsor: false };
      }
      
      const sponsorship = result.rows[0];
      const isPermanentlyValidated = !!sponsorship.permanently_validated_at;
      
      return {
        success: true,
        has_sponsor: true,
        sponsor_number: sponsorship.sponsor_number,
        sponsor_username: sponsorship.sponsor_username,
        is_validated: sponsorship.is_validated,
        is_permanently_validated: isPermanentlyValidated,
        permanently_validated_at: sponsorship.permanently_validated_at
      };
    } catch (error) {
      console.error('Erreur récupération parrain:', error);
      return { success: false, message: "Erreur serveur" };
    }
  },

  async getSponsorshipStats(playerNumber) {
    try {
      // 1. Récupérer la date du dernier reset des compteurs parrainage
      const lastResetResult = await pool.query(`
        SELECT reset_date 
        FROM admin_resets 
        WHERE reset_type = 'sponsorship_counters' 
        ORDER BY reset_date DESC 
        LIMIT 1
      `);
      
      const lastResetDate = lastResetResult.rows[0]?.reset_date;
      
      // 2. Si pas de reset, compter tout (situation initiale)
      if (!lastResetDate) {
        const result = await pool.query(
          'SELECT validated_sponsored FROM sponsorship_stats WHERE player_number = $1',
          [playerNumber]
        );
        
        const validatedCount = result.rows.length > 0 ? result.rows[0].validated_sponsored : 0;
        
        console.log(`📊 Stats parrainage pour ${playerNumber}: ${validatedCount} filleul(s) validé(s) (aucun reset)`);
        
        return { 
          success: true, 
          validated_sponsored: validatedCount,
          last_reset_date: null,
          message: validatedCount > 0 ? 
            `${validatedCount} filleul(s) validé(s)` : 
            "Aucun filleul validé pour le moment"
        };
      }
      
      // 3. Compter seulement les validations après le dernier reset
      const countResult = await pool.query(`
        SELECT COUNT(*) as count 
        FROM sponsorship_validated_history 
        WHERE sponsor_number = $1 
        AND validated_at >= $2
      `, [playerNumber, lastResetDate]);
      
      const validatedCount = parseInt(countResult.rows[0]?.count || 0);
      
      // 4. Vérifier aussi les ajustements manuels admin après le reset
      const adjustmentResult = await pool.query(`
        SELECT COALESCE(SUM(adjustment), 0) as total_adjustment
        FROM admin_sponsorship_adjustments 
        WHERE player_number = $1 
        AND adjusted_at >= $2
      `, [playerNumber, lastResetDate]);
      
      const totalAdjustment = parseInt(adjustmentResult.rows[0]?.total_adjustment || 0);
      
      // 5. Total = validations naturelles + ajustements admin
      const totalValidated = Math.max(0, validatedCount + totalAdjustment);
      
      console.log(`📊 Stats parrainage pour ${playerNumber}:`);
      console.log(`   Validations naturelles après reset: ${validatedCount}`);
      console.log(`   Ajustements admin après reset: ${totalAdjustment}`);
      console.log(`   TOTAL (ce que client voit): ${totalValidated}`);
      
      return { 
        success: true, 
        validated_sponsored: totalValidated,
        last_reset_date: lastResetDate,
        message: totalValidated > 0 ? 
          `${totalValidated} filleul(s) validé(s) cette semaine` : 
          "Aucun filleul validé cette semaine"
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
          u2.score as sponsored_score,
          h.validated_at as permanently_validated_at,
          CASE WHEN h.sponsored_number IS NOT NULL THEN true ELSE false END as is_permanently_validated
        FROM sponsorships s
        JOIN users u1 ON s.sponsor_number = u1.number
        JOIN users u2 ON s.sponsored_number = u2.number
        LEFT JOIN sponsorship_validated_history h ON s.sponsored_number = h.sponsored_number
        ORDER BY s.created_at DESC
      `);
      
      return result.rows;
    } catch (error) {
      console.error('Erreur récupération parrainages:', error);
      return [];
    }
  },

  async getPermanentValidationHistory() {
    try {
      const result = await pool.query(`
        SELECT 
          h.sponsor_number,
          u1.username as sponsor_username,
          h.sponsored_number,
          u2.username as sponsored_username,
          h.validated_at,
          u2.score as current_sponsored_score
        FROM sponsorship_validated_history h
        JOIN users u1 ON h.sponsor_number = u1.number
        JOIN users u2 ON h.sponsored_number = u2.number
        ORDER BY h.validated_at DESC
      `);
      
      return result.rows;
    } catch (error) {
      console.error('Erreur récupération historique validations:', error);
      return [];
    }
  },

  // Supprimer un compte
  async deleteUserAccount(playerNumber, adminKey) {
    try {
      if (!adminKey || adminKey !== ADMIN_KEY) {
        return { success: false, message: "Clé admin invalide" };
      }
      
      const user = await this.getUserByNumber(playerNumber);
      if (!user) {
        return { success: false, message: "Joueur non trouvé" };
      }
      
      // 1. Mettre le numéro sur liste noire
      await pool.query(`
        INSERT INTO blacklisted_numbers (number, banned_at, reason, original_username) 
        VALUES ($1, CURRENT_TIMESTAMP, $2, $3)
        ON CONFLICT (number) DO UPDATE SET 
          banned_at = CURRENT_TIMESTAMP,
          reason = EXCLUDED.reason
      `, [playerNumber, 'Suppression admin', user.username]);
      
      console.log(`🚫 Numéro ${playerNumber} (${user.username}) ajouté à la liste noire`);
      
      // 2. Supprimer le joueur de toutes les connexions actives
      PLAYER_CONNECTIONS.delete(playerNumber);
      PLAYER_QUEUE.delete(playerNumber);
      
      // 3. Vérifier si le joueur est dans un jeu actif
      const gameId = PLAYER_TO_GAME.get(playerNumber);
      if (gameId) {
        const game = ACTIVE_GAMES.get(gameId);
        if (game) {
          const player = game.getPlayerByNumber(playerNumber);
          if (player) {
            await game.handlePlayerDisconnect(player);
          }
        }
        PLAYER_TO_GAME.delete(playerNumber);
      }
      
      // 4. Supprimer les devices trustés
      await pool.query('DELETE FROM trusted_devices WHERE user_number = $1', [playerNumber]);
      
      // 5. Supprimer les parrainages liés
      await pool.query('DELETE FROM sponsorships WHERE sponsor_number = $1 OR sponsored_number = $1', [playerNumber]);
      await pool.query('DELETE FROM sponsorship_validated_history WHERE sponsor_number = $1 OR sponsored_number = $1', [playerNumber]);
      await pool.query('DELETE FROM sponsorship_stats WHERE player_number = $1', [playerNumber]);
      
      // 6. Supprimer les matchs récents
      await pool.query('DELETE FROM recent_matches WHERE player1_number = $1 OR player2_number = $1', [playerNumber]);
      
      // 7. Supprimer l'utilisateur
      await pool.query('DELETE FROM users WHERE number = $1', [playerNumber]);
      
      console.log(`🗑️ Compte ${playerNumber} (${user.username}) supprimé avec succès`);
      
      return { 
        success: true, 
        message: `Compte ${user.username} (${playerNumber}) supprimé avec succès`,
        username: user.username,
        number: playerNumber,
        score: user.score,
        blacklisted: true
      };
    } catch (error) {
      console.error('Erreur suppression compte:', error);
      return { success: false, message: "Erreur serveur lors de la suppression" };
    }
  },

  // Vérifier si un numéro est sur liste noire
  async isNumberBlacklisted(number) {
    try {
      const result = await pool.query(
        'SELECT * FROM blacklisted_numbers WHERE number = $1',
        [number]
      );
      return result.rows.length > 0;
    } catch (error) {
      console.error('Erreur vérification liste noire:', error);
      return false;
    }
  },

  // Obtenir la liste des numéros blacklistés
  async getBlacklistedNumbers() {
    try {
      const result = await pool.query(`
        SELECT number, original_username, reason, banned_at 
        FROM blacklisted_numbers 
        ORDER BY banned_at DESC
      `);
      return result.rows;
    } catch (error) {
      console.error('Erreur récupération liste noire:', error);
      return [];
    }
  },

  // Retirer un numéro de la liste noire
  async unblacklistNumber(number, adminKey) {
    try {
      if (!adminKey || adminKey !== ADMIN_KEY) {
        return { success: false, message: "Clé admin invalide" };
      }
      
      const result = await pool.query(
        'DELETE FROM blacklisted_numbers WHERE number = $1 RETURNING *',
        [number]
      );
      
      if (result.rows.length === 0) {
        return { success: false, message: "Numéro non trouvé dans la liste noire" };
      }
      
      return { 
        success: true, 
        message: `Numéro ${number} retiré de la liste noire`,
        number: number
      };
    } catch (error) {
      console.error('Erreur retrait liste noire:', error);
      return { success: false, message: "Erreur serveur" };
    }
  },

  async manuallyAdjustSponsorshipCounter(playerNumber, adjustment, adminKey) {
    try {
      if (!adminKey || adminKey !== ADMIN_KEY) {
        return { success: false, message: "Clé admin invalide" };
      }
      
      if (!playerNumber || adjustment === undefined) {
        return { success: false, message: "Données manquantes" };
      }
      
      const user = await this.getUserByNumber(playerNumber);
      if (!user) {
        return { success: false, message: "Joueur non trouvé" };
      }
      
      // 1. Récupérer la date du dernier reset
      const lastResetResult = await pool.query(`
        SELECT reset_date 
        FROM admin_resets 
        WHERE reset_type = 'sponsorship_counters' 
        ORDER BY reset_date DESC 
        LIMIT 1
      `);
      
      const lastResetDate = lastResetResult.rows[0]?.reset_date;
      
      if (!lastResetDate) {
        return { success: false, message: "Aucun reset trouvé, veuillez d'abord effectuer un reset des compteurs" };
      }
      
      // 2. Calculer les validations après le dernier reset
      let currentValidated = 0;
      if (lastResetDate) {
        const countResult = await pool.query(`
          SELECT COUNT(*) as count 
          FROM sponsorship_validated_history 
          WHERE sponsor_number = $1 
          AND validated_at >= $2
        `, [playerNumber, lastResetDate]);
        
        currentValidated = parseInt(countResult.rows[0]?.count || 0);
      }
      
      // 3. Calculer les ajustements précédents après le dernier reset
      const previousAdjustmentsResult = await pool.query(`
        SELECT COALESCE(SUM(adjustment), 0) as total_adjustment
        FROM admin_sponsorship_adjustments 
        WHERE player_number = $1 
        AND adjusted_at >= $2
      `, [playerNumber, lastResetDate]);
      
      const previousAdjustments = parseInt(previousAdjustmentsResult.rows[0]?.total_adjustment || 0);
      
      // 4. Total actuel (avant nouveau ajustement)
      const totalBefore = Math.max(0, currentValidated + previousAdjustments);
      
      // 5. Nouveau total
      const totalAfter = Math.max(0, totalBefore + adjustment);
      
      // 6. Mettre à jour les stats globales (pour F dans admin)
      const globalStatsResult = await pool.query(
        'SELECT total_sponsored, validated_sponsored FROM sponsorship_stats WHERE player_number = $1',
        [playerNumber]
      );
      
      if (globalStatsResult.rows.length > 0) {
        // Mettre à jour le validated_sponsored global (F)
        const newGlobalValidated = globalStatsResult.rows[0].validated_sponsored + adjustment;
        await pool.query(`
          UPDATE sponsorship_stats 
          SET validated_sponsored = $1,
              total_sponsored = GREATEST(validated_sponsored, total_sponsored),
              last_updated = CURRENT_TIMESTAMP
          WHERE player_number = $2
        `, [Math.max(0, newGlobalValidated), playerNumber]);
      } else {
        // Créer l'entrée si elle n'existe pas
        await pool.query(`
          INSERT INTO sponsorship_stats (player_number, total_sponsored, validated_sponsored, last_updated) 
          VALUES ($1, GREATEST($2, 0), GREATEST($2, 0), CURRENT_TIMESTAMP)
        `, [playerNumber, Math.max(0, adjustment)]);
      }
      
      console.log(`📊 Ajustement parrainage pour ${playerNumber} (${user.username}):`);
      console.log(`   Validations naturelles après reset: ${currentValidated}`);
      console.log(`   Ajustements précédents: ${previousAdjustments}`);
      console.log(`   Total avant ajustement (ce que client voit): ${totalBefore}`);
      console.log(`   Ajustement demandé: ${adjustment}`);
      console.log(`   Total après ajustement (ce que client verra): ${totalAfter}`);
      
      // 7. Enregistrer l'ajustement dans l'historique
      await pool.query(`
        INSERT INTO admin_sponsorship_adjustments (admin_key, player_number, adjustment, old_value, new_value, reason) 
        VALUES ($1, $2, $3, $4, $5, $6)
      `, [adminKey, playerNumber, adjustment, totalBefore, totalAfter, 'Ajustement manuel admin après reset']);
      
      return { 
        success: true, 
        message: `Compteur parrainage ajusté: ${totalBefore} → ${totalAfter}`,
        player_number: playerNumber,
        username: user.username,
        old_value: totalBefore,
        new_value: totalAfter,
        adjustment: adjustment,
        natural_validations: currentValidated,
        previous_adjustments: previousAdjustments,
        is_post_reset: true
      };
    } catch (error) {
      console.error('Erreur ajustement compteur parrainage:', error);
      return { success: false, message: "Erreur serveur" };
    }
  },
 
  // Obtenir l'historique des ajustements de parrainage
  async getSponsorshipAdjustmentHistory(adminKey) {
    try {
      if (!adminKey || adminKey !== ADMIN_KEY) {
        return { success: false, message: "Clé admin invalide" };
      }
      
      const result = await pool.query(`
        SELECT 
          a.*,
          u.username as player_username
        FROM admin_sponsorship_adjustments a
        LEFT JOIN users u ON a.player_number = u.number
        ORDER BY a.adjusted_at DESC
      `);
      
      return result.rows;
    } catch (error) {
      console.error('Erreur récupération historique ajustements:', error);
      return [];
    }
  }
};

// CLASSE GAME
class Game {
  constructor(id, p1, p2) {
    Object.assign(this, {
      id, players: [], phase: 'waiting', manche: 1, maxManches: 3, turn: null,
      scores: { player1: 0, player2: 0 }, playerCombinations: { player1: null, player2: null },
      availableSlots: { player1: [1,2,3,4,5,6], player2: [1,2,3,4,5,6] },
      preparationTime: 20, turnTime: 30, selectionsThisManche: 0, maxSelections: 3, timerInterval: null,
      lobbyTimeout: null,
      created_at: Date.now(),
      status: 'lobby',
      autoMoveUsed: { player1: false, player2: false },
      gameType: p2.is_bot ? 'bot_match' : 'pvp_match'
    });
    
    [p1, p2].forEach((p, i) => {
      const player = {...p, ws: PLAYER_CONNECTIONS.get(p.number), role: i === 0 ? 'player1' : 'player2'};
      this.players.push(player);
      PLAYER_TO_GAME.set(p.number, id);
    });
    
    ACTIVE_GAMES.set(id, this);
    PENDING_LOBBIES.set(id, this);
    
    // Enregistrer le match dans la base persistante (seulement pour PVP)
    if (this.gameType === 'pvp_match') {
      recordMatch(p1.number, p2.number);
    }
    
    console.log(`🎮 Nouveau lobby créé: ${this.id} (${this.gameType})`);
    console.log(`   Joueurs: ${p1.username} vs ${p2.username}`);
    console.log(`   Lobbys actifs: ${PENDING_LOBBIES.size}, Parties actives: ${ACTIVE_GAMES.size}`);
    
    this.lobbyTimeout = setTimeout(() => {
      if (this.phase === 'waiting' && this.status === 'lobby') {
        console.log(`⏱️ Timeout lobby ${this.id} - Annulation automatique`);
        this.cancelLobby('Délai de connexion dépassé');
      }
    }, LOBBY_TIMEOUT);
    
    setTimeout(() => this.checkAndStartGame(), 1000);
  }

  cancelLobby(reason) {
    if (this.status === 'cancelled') return;
    
    console.log(`❌ Annulation lobby ${this.id}: ${reason}`);
    this.status = 'cancelled';
    
    this.players.forEach(p => {
      if (p.ws?.readyState === WebSocket.OPEN) {
        p.ws.send(JSON.stringify({
          type: 'match_cancelled',
          message: reason,
          lobby_id: this.id
        }));
      }
      
      PLAYER_TO_GAME.delete(p.number);
      
      if (!p.ws || p.ws.readyState !== WebSocket.OPEN) {
        PLAYER_QUEUE.add(p.number);
      }
    });
    
    this.cleanup();
    
    PENDING_LOBBIES.delete(this.id);
    ACTIVE_GAMES.delete(this.id);
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
    const connectedPlayers = this.players.filter(p => p.ws?.readyState === WebSocket.OPEN);
    
    if (connectedPlayers.length < 2) {
      console.log(`⚠️ Lobby ${this.id}: Un joueur s'est déconnecté avant le début`);
      this.cancelLobby('Un joueur s\'est déconnecté');
      return;
    }
    
    if (this.phase === 'waiting' && this.status === 'lobby') {
      this.phase = 'preparation';
      this.status = 'active';
      PENDING_LOBBIES.delete(this.id);
      
      if (this.lobbyTimeout) {
        clearTimeout(this.lobbyTimeout);
        this.lobbyTimeout = null;
      }
      
      console.log(`🎲 Début de partie ${this.id} (${this.gameType}): ${this.players[0].username} vs ${this.players[1].username}`);
      console.log(`   Lobbys en attente: ${PENDING_LOBBIES.size}, Parties en cours: ${ACTIVE_GAMES.size - PENDING_LOBBIES.size}`);
      
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
        
        const currentPlayer = this.players.find(p => p.role === this.turn);
        if (!currentPlayer) {
          console.log(`❌ Joueur ${this.turn} non trouvé`);
          this.endTurn();
          return;
        }
        
        if (!this.autoMoveUsed[this.turn]) {
          console.log(`⏰ Timeout tour ${this.turn} - Premier coup automatique`);
          this.makeSingleAutomaticMove(currentPlayer);
        } else {
          console.log(`⏰ Timeout tour ${this.turn} - Coup automatique déjà utilisé → JOUEUR A QUITTÉ`);
          this.handlePlayerDisconnect(currentPlayer);
        }
      } else {
        this.broadcast({ type: 'timer_update', timer: timeLeft });
      }
    }, 1000);
  }

  makeSingleAutomaticMove(player) {
    const slots = this.availableSlots[player.role];
    if (slots.length === 0) { 
      console.log(`⚠️ Aucun slot disponible pour ${player.role}`);
      this.endTurn(); 
      return false; 
    }
    
    this.autoMoveUsed[player.role] = true;
    console.log(`🤖 Coup automatique unique pour ${player.role} (manche ${this.manche})`);
    
    const randomSlot = slots[Math.floor(Math.random() * slots.length)];
    const success = this.makeMove(player, randomSlot, 0, null);
    
    this.broadcast({
      type: 'auto_move_notification',
      player: player.role,
      message: 'Le serveur a joué automatiquement (1 coup max/manche)'
    });
    
    return success;
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
    if (this.status === 'cancelled') return;
    
    const remainingPlayer = this.players.find(p => p.number !== disconnectedPlayer.number);
    
    if (this.phase === 'waiting' && this.status === 'lobby') {
      this.cancelLobby('Un joueur s\'est déconnecté');
      return;
    }
    
    console.log(`🔌 ${disconnectedPlayer.username} (${disconnectedPlayer.role}) a quitté la partie ${this.id} (${this.gameType})`);
    
    if (remainingPlayer?.ws?.readyState === WebSocket.OPEN) {
      remainingPlayer.ws.send(JSON.stringify({ 
        type: 'opponent_left', 
        message: 'Adversaire a quitté la partie' 
      }));
      
      // APPLICATION DES PÉNALITÉS DIFFÉRENTES SELON LE TYPE DE MATCH
      if (this.gameType === 'pvp_match') {
        // PVP: Celui qui quitte perd -250 points, l'autre gagne +200
        await this._applyPvPDisconnectPenalties(disconnectedPlayer, remainingPlayer);
      } else {
        // Match contre bot: Logique simplifiée
        await this._applyBotDisconnectPenalties(disconnectedPlayer, remainingPlayer);
      }
      
      this.broadcast({ type: 'game_end', data: { scores: this.scores, winner: remainingPlayer.role } });
      this.cleanup();
    } else {
      this.cleanup();
    }
  }

  // Pénalités pour abandon PVP
  async _applyPvPDisconnectPenalties(disconnectedPlayer, remainingPlayer) {
    try {
      await db.applyPvPQuitPenalty(disconnectedPlayer.number, remainingPlayer.number);
    } catch (error) {
      console.error('Erreur pénalités déconnexion PVP:', error);
    }
  }

  // Méthode pour matchs contre bots (simplifiée)
  async _applyBotDisconnectPenalties(disconnectedPlayer, remainingPlayer) {
    try {
      // Note: Pour un match contre bot, "remainingPlayer" est le joueur humain
      // Logique simplifiée pour le match contre bot
      const remainingUser = await db.getUserByNumber(remainingPlayer.number);
      
      if (remainingUser) {
        const remainingScore = this.scores[remainingPlayer.role];
        
        // Logique existante pour match contre bot
        const newRemainingScore = remainingUser.score + (remainingScore < 15 ? 15 : remainingScore) + AUTO_MOVE_BONUS;
        
        console.log(`💰 Bonus +${AUTO_MOVE_BONUS} points pour ${remainingPlayer.username} (adversaire a quitté)`);
        console.log(`   Score ${remainingPlayer.username}: ${remainingUser.score} → ${newRemainingScore}`);
        
        await db.updateUserScore(remainingPlayer.number, newRemainingScore);
      }
    } catch (error) {
      console.error('Erreur pénalités déconnexion bot:', error);
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
    
    this.autoMoveUsed = { player1: false, player2: false };
    console.log(`🔄 Fin manche ${this.manche} - Réinitialisation coups automatiques`);
    
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
    if (this.lobbyTimeout) clearTimeout(this.lobbyTimeout);
    if (this.timerInterval) clearInterval(this.timerInterval);
    
    this.players.forEach(p => {
      PLAYER_TO_GAME.delete(p.number);
    });
    
    PENDING_LOBBIES.delete(this.id);
    ACTIVE_GAMES.delete(this.id);
    
    console.log(`🗑️  Nettoyage partie ${this.id}`);
    console.log(`   Lobbys restants: ${PENDING_LOBBIES.size}, Parties actives: ${ACTIVE_GAMES.size}`);
  }

  getPlayerByNumber(n) { 
    return this.players.find(p => p.number === n); 
  }
}

// FONCTION DE MATCHMAKING AMÉLIORÉE AVEC VÉRIFICATION DE DOUBLON
async function findBestMatchFromQueue() {
  if (PLAYER_QUEUE.size < 2) {
    console.log(`📊 File d'attente: ${PLAYER_QUEUE.size} joueur(s) - Pas assez pour un match`);
    return null;
  }
  
  const players = Array.from(PLAYER_QUEUE);
  console.log(`📊 Analyse file d'attente: ${players.length} joueurs`);
  
  const availablePlayers = players.filter(playerNumber => !PLAYER_TO_GAME.has(playerNumber));
  
  if (availablePlayers.length !== players.length) {
    const alreadyInGame = players.length - availablePlayers.length;
    console.log(`⚠️ ${alreadyInGame} joueur(s) déjà dans un jeu/lobby, ignorés de la file`);
    
    players.forEach(playerNumber => {
      if (PLAYER_TO_GAME.has(playerNumber)) {
        PLAYER_QUEUE.delete(playerNumber);
        console.log(`🧹 Suppression de la file: ${playerNumber} (déjà dans un jeu)`);
      }
    });
  }
  
  if (availablePlayers.length < 2) {
    console.log(`❌ Pas assez de joueurs disponibles pour un match (${availablePlayers.length} disponible(s))`);
    return null;
  }
  
  const playersWithScores = [];
  for (const playerNumber of availablePlayers) {
    const user = await db.getUserByNumber(playerNumber);
    if (user) {
      playersWithScores.push({
        number: playerNumber,
        score: user.score,
        username: user.username
      });
    }
  }
  
  const possiblePairs = [];
  
  for (let i = 0; i < playersWithScores.length - 1; i++) {
    for (let j = i + 1; j < playersWithScores.length; j++) {
      const player1 = playersWithScores[i];
      const player2 = playersWithScores[j];
      
      if (PLAYER_TO_GAME.has(player1.number) || PLAYER_TO_GAME.has(player2.number)) {
        console.log(`⛔ Double vérification échouée: ${player1.number} ou ${player2.number} déjà dans un jeu`);
        continue;
      }
      
      const scoreGapBlocked = (player1.score >= HIGH_SCORE_THRESHOLD && player2.score < LOW_SCORE_THRESHOLD) ||
                              (player2.score >= HIGH_SCORE_THRESHOLD && player1.score < LOW_SCORE_THRESHOLD);
      
      if (scoreGapBlocked) {
        console.log(`⛔ Bloqué écart score: ${player1.username} (${player1.score}) vs ${player2.username} (${player2.score})`);
        continue;
      }
      
      const matchCheck = await canMatchPlayers(player1.number, player2.number);
      
      if (matchCheck.canMatch) {
        possiblePairs.push({
          player1: player1.number,
          player2: player2.number,
          player1Score: player1.score,
          player2Score: player2.score,
          scoreDiff: Math.abs(player1.score - player2.score),
          player1Name: player1.username,
          player2Name: player2.username
        });
        console.log(`✅ Match possible: ${player1.username} (${player1.score}) vs ${player2.username} (${player2.score})`);
      } else {
        console.log(`⏳ Match bloqué: ${player1.username} vs ${player2.username} - ${matchCheck.reason}`);
      }
    }
  }
  
  if (possiblePairs.length === 0) {
    console.log(`❌ Aucune paire possible trouvée parmi ${playersWithScores.length} joueurs disponibles`);
    return null;
  }
  
  possiblePairs.sort((a, b) => a.scoreDiff - b.scoreDiff);
  const bestPair = possiblePairs[0];
  
  if (PLAYER_TO_GAME.has(bestPair.player1) || PLAYER_TO_GAME.has(bestPair.player2)) {
    console.log(`🚨 ALERTE: ${bestPair.player1Name} ou ${bestPair.player2Name} a rejoint un jeu entre-temps!`);
    console.log(`   Annulation du match pour éviter les doublons`);
    
    if (PLAYER_TO_GAME.has(bestPair.player1)) {
      PLAYER_QUEUE.delete(bestPair.player1);
      console.log(`   ${bestPair.player1Name} retiré de la file (déjà dans jeu)`);
    }
    if (PLAYER_TO_GAME.has(bestPair.player2)) {
      PLAYER_QUEUE.delete(bestPair.player2);
      console.log(`   ${bestPair.player2Name} retiré de la file (déjà dans jeu)`);
    }
    
    return null;
  }
  
  console.log(`🎯 Meilleur match sélectionné: ${bestPair.player1Name} vs ${bestPair.player2Name}`);
  console.log(`   Différence de score: ${bestPair.scoreDiff}`);
  console.log(`   Joueurs disponibles confirmés`);
  
  return [bestPair.player1, bestPair.player2];
}

// INITIALISATION DE LA BASE DE DONNÉES
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

// WEBSOCKET CONNECTION
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
      const deviceKey = generateDeviceKey(ip, deviceId);
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

// HANDLERS ADMIN
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

    // ⭐⭐ HANDLER MANQUANT AJOUTÉ ICI ⭐⭐
    admin_get_full_list: async () => {
      try {
        console.log("🎯 admin_get_full_list appelé");
        
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
        
        console.log(`✅ admin_full_list envoyé: ${fullList.length} éléments`);
        
      } catch (error) {
        console.error('❌ Erreur admin_get_full_list:', error);
        ws.send(JSON.stringify({ 
          type: 'admin_full_list', 
          success: false, 
          message: 'Erreur serveur' 
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
          console.log(`⚙️ Anti-match rapide: ${anti_quick_rematch ? 'ACTIVÉ' : 'DÉSACTIVÉ'}`);
        }
        
        if (min_rematch_delay_minutes) {
          MATCHMAKING_CONFIG.min_rematch_delay = min_rematch_delay_minutes * 60 * 1000;
          console.log(`⏱️ Délai anti-match configuré: ${min_rematch_delay_minutes} minutes`);
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
          message: 'Configuration actuelle'
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
          pending_count: sponsorships.filter(s => !s.is_validated).length,
          permanently_validated_count: sponsorships.filter(s => s.is_permanently_validated).length
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
          message: result.message,
          reset_date: result.reset_date
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
            `Scan terminé: ${result.validated} NOUVEAUX parrainages validés` : 
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
    },

    admin_get_permanent_validations: async () => {
      try {
        if (message.admin_key !== ADMIN_KEY) {
          return ws.send(JSON.stringify({ 
            type: 'error', 
            message: 'Clé admin invalide' 
          }));
        }

        const history = await db.getPermanentValidationHistory();
        
        ws.send(JSON.stringify({
          type: 'admin_permanent_validations',
          success: true,
          history: history,
          count: history.length,
          message: `Historique des ${history.length} validations permanentes`
        }));
      } catch (error) {
        console.error('Erreur récupération historique validations admin:', error);
        ws.send(JSON.stringify({ 
          type: 'admin_permanent_validations', 
          success: false, 
          message: 'Erreur récupération' 
        }));
      }
    },

    admin_get_server_stats: async () => {
      try {
        if (message.admin_key !== ADMIN_KEY) {
          return ws.send(JSON.stringify({ 
            type: 'error', 
            message: 'Clé admin invalide' 
          }));
        }

        const recentMatchesResult = await pool.query(`
          SELECT COUNT(*) as count FROM recent_matches 
          WHERE match_timestamp > NOW() - INTERVAL '${MATCHMAKING_CONFIG.min_rematch_delay / 60000} minutes'
        `);
        
        const lastResetResult = await pool.query(`
          SELECT reset_date FROM admin_resets 
          ORDER BY reset_date DESC 
          LIMIT 1
        `);
        
        ws.send(JSON.stringify({
          type: 'admin_server_stats',
          success: true,
          stats: {
            connected_players: PLAYER_CONNECTIONS.size,
            in_queue: PLAYER_QUEUE.size,
            active_games: ACTIVE_GAMES.size,
            pending_lobbies: PENDING_LOBBIES.size,
            player_to_game: PLAYER_TO_GAME.size,
            recent_matches_in_db: parseInt(recentMatchesResult.rows[0].count),
            trusted_devices: TRUSTED_DEVICES.size
          },
          matchmaking_config: MATCHMAKING_CONFIG,
          last_reset_date: lastResetResult.rows[0]?.reset_date || 'Jamais',
          pvp_quit_penalty: PVP_QUIT_PENALTY,
          message: 'Statistiques serveur'
        }));
      } catch (error) {
        console.error('Erreur stats serveur admin:', error);
        ws.send(JSON.stringify({ 
          type: 'admin_server_stats', 
          success: false, 
          message: 'Erreur stats' 
        }));
      }
    },

    // Supprimer un compte
    admin_delete_user: async () => {
      try {
        if (message.admin_key !== ADMIN_KEY) {
          return ws.send(JSON.stringify({ 
            type: 'error', 
            message: 'Clé admin invalide' 
          }));
        }

        const { player_number } = message;
        
        if (!player_number) {
          return ws.send(JSON.stringify({
            type: 'admin_delete_user',
            success: false,
            message: 'Numéro joueur manquant'
          }));
        }

        const result = await db.deleteUserAccount(player_number, message.admin_key);
        
        ws.send(JSON.stringify({
          type: 'admin_delete_user',
          success: result.success,
          message: result.message,
          player_number: result.number,
          username: result.username,
          score: result.score,
          blacklisted: result.blacklisted
        }));
      } catch (error) {
        console.error('Erreur suppression compte admin:', error);
        ws.send(JSON.stringify({ 
          type: 'admin_delete_user', 
          success: false, 
          message: 'Erreur suppression' 
        }));
      }
    },

    // Obtenir la liste noire
    admin_get_blacklist: async () => {
      try {
        if (message.admin_key !== ADMIN_KEY) {
          return ws.send(JSON.stringify({ 
            type: 'error', 
            message: 'Clé admin invalide' 
          }));
        }

        const blacklist = await db.getBlacklistedNumbers();
        
        ws.send(JSON.stringify({
          type: 'admin_blacklist',
          success: true,
          blacklist: blacklist,
          count: blacklist.length,
          message: `Liste noire: ${blacklist.length} numéro(s)`
        }));
      } catch (error) {
        console.error('Erreur récupération liste noire admin:', error);
        ws.send(JSON.stringify({ 
          type: 'admin_blacklist', 
          success: false, 
          message: 'Erreur récupération' 
        }));
      }
    },

    // Retirer un numéro de la liste noire
    admin_unblacklist_number: async () => {
      try {
        if (message.admin_key !== ADMIN_KEY) {
          return ws.send(JSON.stringify({ 
            type: 'error', 
            message: 'Clé admin invalide' 
          }));
        }

        const { number } = message;
        
        if (!number) {
          return ws.send(JSON.stringify({
            type: 'admin_unblacklist',
            success: false,
            message: 'Numéro manquant'
          }));
        }

        const result = await db.unblacklistNumber(number, message.admin_key);
        
        ws.send(JSON.stringify({
          type: 'admin_unblacklist',
          success: result.success,
          message: result.message,
          number: result.number
        }));
      } catch (error) {
        console.error('Erreur retrait liste noire admin:', error);
        ws.send(JSON.stringify({ 
          type: 'admin_unblacklist', 
          success: false, 
          message: 'Erreur retrait' 
        }));
      }
    },

    // Ajuster manuellement le compteur de parrainage
    admin_adjust_sponsorship_counter: async () => {
      try {
        if (message.admin_key !== ADMIN_KEY) {
          return ws.send(JSON.stringify({ 
            type: 'error', 
            message: 'Clé admin invalide' 
          }));
        }

        const { player_number, adjustment } = message;
        
        if (!player_number || adjustment === undefined) {
          return ws.send(JSON.stringify({
            type: 'admin_adjust_sponsorship',
            success: false,
            message: 'Données manquantes'
          }));
        }

        const result = await db.manuallyAdjustSponsorshipCounter(
          player_number, 
          parseInt(adjustment), 
          message.admin_key
        );
        
        ws.send(JSON.stringify({
          type: 'admin_adjust_sponsorship',
          success: result.success,
          message: result.message,
          player_number: result.player_number,
          username: result.username,
          old_value: result.old_value,
          new_value: result.new_value,
          adjustment: result.adjustment
        }));
      } catch (error) {
        console.error('Erreur ajustement parrainage admin:', error);
        ws.send(JSON.stringify({ 
          type: 'admin_adjust_sponsorship', 
          success: false, 
          message: 'Erreur ajustement' 
        }));
      }
    },

    // Obtenir l'historique des ajustements
    admin_get_sponsorship_adjustment_history: async () => {
      try {
        if (message.admin_key !== ADMIN_KEY) {
          return ws.send(JSON.stringify({ 
            type: 'error', 
            message: 'Clé admin invalide' 
          }));
        }

        const history = await db.getSponsorshipAdjustmentHistory(message.admin_key);
        
        ws.send(JSON.stringify({
          type: 'admin_sponsorship_adjustment_history',
          success: true,
          history: history,
          count: history.length,
          message: `Historique des ${history.length} ajustements`
        }));
      } catch (error) {
        console.error('Erreur récupération historique ajustements admin:', error);
        ws.send(JSON.stringify({ 
          type: 'admin_sponsorship_adjustment_history', 
          success: false, 
          message: 'Erreur récupération' 
        }));
      }
    }
  };
  
  if (handlers[message.type]) {
    console.log(`🔄 Exécution du handler: ${message.type}`);
    await handlers[message.type]();
    console.log(`✅ Handler ${message.type} terminé`);
  } else {
    console.log(`❌ Handler NON TROUVÉ pour: ${message.type}`);
    console.log(`   Handlers disponibles:`, Object.keys(handlers));
    ws.send(JSON.stringify({ 
      type: 'error', 
      message: 'Commande admin inconnue: ' + message.type 
    }));
  }
}

// HANDLERS CLIENT
async function handleClientMessage(ws, message, ip, deviceId) {
  const deviceKey = generateDeviceKey(ip, deviceId);
  const playerNumber = TRUSTED_DEVICES.get(deviceKey);
  
  const handlers = {
    check_update: async () => {
      console.log('📱 Vérification MAJ demandée');
      
      if (UPDATE_CONFIG.force_update) {
        ws.send(JSON.stringify({
          type: 'check_update_response',
          needs_update: true,
          message: "Mise à jour requise",
          min_version: UPDATE_CONFIG.min_version,
          latest_version: UPDATE_CONFIG.latest_version,
          update_url: UPDATE_CONFIG.update_url
        }));
      } else {
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
      } else {
        try {
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
        } catch (error) {
          if (error.message.includes('banni')) {
            ws.send(JSON.stringify({ 
              type: 'register_failed', 
              message: "Ce numéro a été banni et ne peut pas être réutilisé" 
            }));
          } else if (await db.getUserByNumber(number)) {
            ws.send(JSON.stringify({ type: 'register_failed', message: "Numéro déjà utilisé" }));
          } else {
            ws.send(JSON.stringify({ type: 'register_failed', message: "Erreur lors de l'inscription" }));
          }
        }
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
        if (gameId) {
          const game = ACTIVE_GAMES.get(gameId);
          if (game) {
            const player = game.getPlayerByNumber(playerNumber);
            if (player) await game.handlePlayerDisconnect(player);
          }
        }
        
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
    
    join_queue: async () => {
      const playerNumber = TRUSTED_DEVICES.get(deviceKey);
      if (!playerNumber) return ws.send(JSON.stringify({ type: 'error', message: 'Non authentifié' }));
      if (PLAYER_TO_GAME.has(playerNumber)) return ws.send(JSON.stringify({ type: 'error', message: 'Déjà dans une partie' }));
      
      PLAYER_QUEUE.add(playerNumber);
      ws.send(JSON.stringify({ type: 'queue_joined', message: 'En attente adversaire' }));
      
      console.log(`🎯 Joueur ${playerNumber} a rejoint la file d'attente`);
      console.log(`📊 Taille file: ${PLAYER_QUEUE.size} joueur(s)`);
      
      if (PLAYER_QUEUE.size >= 2) {
        const bestMatch = await findBestMatchFromQueue();
        
        if (bestMatch) {
          bestMatch.forEach(player => PLAYER_QUEUE.delete(player));
          createGameLobby(bestMatch);
        } else {
          console.log(`⏳ Aucun match possible pour le moment dans la file (${PLAYER_QUEUE.size} joueurs)`);
        }
      }
    },
    
    leave_queue: () => {
      const playerNumber = TRUSTED_DEVICES.get(deviceKey);
      if (playerNumber && PLAYER_QUEUE.has(playerNumber)) {
        PLAYER_QUEUE.delete(playerNumber);
        ws.send(JSON.stringify({ type: 'queue_left', message: 'Recherche annulée' }));
        console.log(`🚪 Joueur ${playerNumber} a quitté la file d'attente`);
      }
    },

    cancel_match: async () => {
      const playerNumber = TRUSTED_DEVICES.get(deviceKey);
      if (!playerNumber) return ws.send(JSON.stringify({ type: 'error', message: 'Non authentifié' }));
      
      const gameId = PLAYER_TO_GAME.get(playerNumber);
      if (!gameId) return ws.send(JSON.stringify({ type: 'error', message: 'Aucun match trouvé' }));
      
      const game = ACTIVE_GAMES.get(gameId);
      if (!game) return ws.send(JSON.stringify({ type: 'error', message: 'Match introuvable' }));
      
      if (game.phase !== 'waiting' || game.status !== 'lobby') {
        return ws.send(JSON.stringify({ 
          type: 'error', 
          message: 'La partie a déjà commencé' 
        }));
      }
      
      console.log(`🖐️ Annulation lobby ${gameId} par ${playerNumber}`);
      game.cancelLobby('L\'adversaire a annulé le match');
      
      ws.send(JSON.stringify({
        type: 'match_cancelled_success',
        message: 'Match annulé avec succès'
      }));
    },

    // Demande un bot (simplifiée - sans caution)
    request_bot: async () => {
      const playerNumber = TRUSTED_DEVICES.get(deviceKey);
      if (!playerNumber) return ws.send(JSON.stringify({ type: 'error', message: 'Non authentifié' }));
      
      if (PLAYER_TO_GAME.has(playerNumber)) {
        return ws.send(JSON.stringify({ type: 'error', message: 'Déjà dans une partie' }));
      }
      
      const bot = getRandomBot();
      
      console.log(`🤖 Adversaire demandé par ${playerNumber} via WebSocket`);
      
      ws.send(JSON.stringify({
        type: 'bot_assigned',
        bot: bot,
        message: "Adversaire assigné. Jouez directement."
      }));
    },
    
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
        is_permanently_validated: result.is_permanently_validated || false,
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
        validated_sponsored: result.validated_sponsored,
        last_reset_date: result.last_reset_date,
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

// CRÉATION DU LOBBY AVEC VÉRIFICATION DE DOUBLON
async function createGameLobby(playerNumbers) {
  if (!playerNumbers || playerNumbers.length !== 2) {
    console.log(`❌ Données invalides pour créer un lobby`);
    return;
  }
  
  const [player1Number, player2Number] = playerNumbers;
  
  // VÉRIFICATION FINALE AVANT CRÉATION
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
  
  const gameId = generateId();
  console.log(`🎮 Création lobby ${gameId}: ${p1.username} vs ${p2.username}`);
  
  new Game(gameId, p1, p2);
  
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
      message: "Adversaire assigné"
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
    
    console.log(`[BOT MATCH] Résultats reçus pour ${playerNumber} contre ${botId}`);
    
    const isBotWin = !isPlayerWin;
    const isDraw = (playerScore === botScore);
    
    const playerUpdateSuccess = await db.updateUserScoreAfterBotMatch(playerNumber, playerScore, isPlayerWin, isDraw);
    
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
      res.json({ 
        success: true, 
        message: "Match nul",
        is_draw: true
      });
    }
  } catch (error) {
    console.error('Erreur update adversaire match:', error);
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

app.get('/matchmaking-config', (req, res) => {
  res.json({
    success: true,
    config: MATCHMAKING_CONFIG,
    thresholds: {
      high_score: HIGH_SCORE_THRESHOLD,
      low_score: LOW_SCORE_THRESHOLD,
      description: `Joueurs ≥${HIGH_SCORE_THRESHOLD} ne peuvent pas rencontrer joueurs <${LOW_SCORE_THRESHOLD}`
    }
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
      message: 'Configuration matchmaking mise à jour (n\'affecte pas les timers en cours)'
    });
  } catch (error) {
    console.error('Erreur update config matchmaking:', error);
    res.status(500).json({ success: false, message: "Erreur serveur" });
  }
});

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
        `Scan terminé: ${result.validated} NOUVEAUX parrainages validés` : 
        'Erreur lors du scan'
    });
  } catch (error) {
    console.error('Erreur scan parrainages:', error);
    res.status(500).json({ success: false, message: "Erreur serveur" });
  }
});

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
      pending_count: sponsorships.filter(s => !s.is_validated).length,
      permanently_validated_count: sponsorships.filter(s => s.is_permanently_validated).length
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

app.get('/admin/permanent-validations', async (req, res) => {
  try {
    const { admin_key } = req.query;
    
    if (admin_key !== ADMIN_KEY) {
      return res.status(403).json({ success: false, message: "Clé admin invalide" });
    }
    
    const history = await db.getPermanentValidationHistory();
    
    res.json({
      success: true,
      history: history,
      count: history.length,
      message: `Historique des ${history.length} validations permanentes`
    });
  } catch (error) {
    console.error('Erreur récupération historique validations admin:', error);
    res.status(500).json({ success: false, message: "Erreur serveur" });
  }
});

app.get('/server-stats', async (req, res) => {
  try {
    const recentMatchesResult = await pool.query(`
      SELECT COUNT(*) as count FROM recent_matches 
      WHERE match_timestamp > NOW() - INTERVAL '${MATCHMAKING_CONFIG.min_rematch_delay / 60000} minutes'
    `);
    
    res.json({
      success: true,
      stats: {
        connected_players: PLAYER_CONNECTIONS.size,
        in_queue: PLAYER_QUEUE.size,
        active_games: ACTIVE_GAMES.size,
        pending_lobbies: PENDING_LOBBIES.size,
        player_to_game: PLAYER_TO_GAME.size,
        recent_matches_in_db: parseInt(recentMatchesResult.rows[0].count)
      },
      matchmaking: {
        config: MATCHMAKING_CONFIG,
        thresholds: {
          high_score: HIGH_SCORE_THRESHOLD,
          low_score: LOW_SCORE_THRESHOLD
        }
      },
      pvp_quit_penalty: PVP_QUIT_PENALTY,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ success: false, message: "Erreur serveur" });
  }
});

// Ajuster manuellement le compteur de parrainage
app.post('/admin/adjust-sponsorship-counter', express.json(), async (req, res) => {
  try {
    const { admin_key, player_number, adjustment } = req.body;
    
    if (!admin_key || admin_key !== ADMIN_KEY) {
      return res.status(403).json({ success: false, message: "Clé admin invalide" });
    }
    
    if (!player_number || adjustment === undefined) {
      return res.status(400).json({ success: false, message: "Données manquantes" });
    }
    
    const result = await db.manuallyAdjustSponsorshipCounter(player_number, parseInt(adjustment), admin_key);
    
    if (result.success) {
      res.json(result);
    } else {
      res.status(400).json(result);
    }
  } catch (error) {
    console.error('Erreur ajustement compteur parrainage:', error);
    res.status(500).json({ success: false, message: "Erreur serveur" });
  }
});

// Obtenir l'historique des ajustements
app.get('/admin/sponsorship-adjustment-history', async (req, res) => {
  try {
    const { admin_key } = req.query;
    
    if (!admin_key || admin_key !== ADMIN_KEY) {
      return res.status(403).json({ success: false, message: "Clé admin invalide" });
    }
    
    const history = await db.getSponsorshipAdjustmentHistory(admin_key);
    
    res.json({
      success: true,
      history: history,
      count: history.length,
      message: `Historique des ${history.length} ajustements`
    });
  } catch (error) {
    console.error('Erreur récupération historique ajustements:', error);
    res.status(500).json({ success: false, message: "Erreur serveur" });
  }
});

// Supprimer un compte
app.post('/admin/delete-user', express.json(), async (req, res) => {
  try {
    const { admin_key, player_number } = req.body;
    
    if (!admin_key || admin_key !== ADMIN_KEY) {
      return res.status(403).json({ success: false, message: "Clé admin invalide" });
    }
    
    if (!player_number) {
      return res.status(400).json({ success: false, message: "Numéro joueur manquant" });
    }
    
    const result = await db.deleteUserAccount(player_number, admin_key);
    
    if (result.success) {
      res.json(result);
    } else {
      res.status(400).json(result);
    }
  } catch (error) {
    console.error('Erreur suppression compte:', error);
    res.status(500).json({ success: false, message: "Erreur serveur" });
  }
});

// Obtenir la liste noire
app.get('/admin/blacklist', async (req, res) => {
  try {
    const { admin_key } = req.query;
    
    if (!admin_key || admin_key !== ADMIN_KEY) {
      return res.status(403).json({ success: false, message: "Clé admin invalide" });
    }
    
    const blacklist = await db.getBlacklistedNumbers();
    
    res.json({
      success: true,
      blacklist: blacklist,
      count: blacklist.length,
      message: `Liste noire: ${blacklist.length} numéro(s)`
    });
  } catch (error) {
    console.error('Erreur récupération liste noire:', error);
    res.status(500).json({ success: false, message: "Erreur serveur" });
  }
});

// Retirer un numéro de la liste noire
app.post('/admin/unblacklist', express.json(), async (req, res) => {
  try {
    const { admin_key, number } = req.body;
    
    if (!admin_key || admin_key !== ADMIN_KEY) {
      return res.status(403).json({ success: false, message: "Clé admin invalide" });
    }
    
    if (!number) {
      return res.status(400).json({ success: false, message: "Numéro manquant" });
    }
    
    const result = await db.unblacklistNumber(number, admin_key);
    
    if (result.success) {
      res.json(result);
    } else {
      res.status(400).json(result);
    }
  } catch (error) {
    console.error('Erreur retrait liste noire:', error);
    res.status(500).json({ success: false, message: "Erreur serveur" });
  }
});

app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'OK', 
    database: 'PostgreSQL', 
    total_bots: BOTS.length,
    pvp_quit_penalty: PVP_QUIT_PENALTY,
    matchmaking_config: MATCHMAKING_CONFIG,
    score_thresholds: {
      high: HIGH_SCORE_THRESHOLD,
      low: LOW_SCORE_THRESHOLD,
      rule: `≥${HIGH_SCORE_THRESHOLD} vs <${LOW_SCORE_THRESHOLD} = bloqué`
    },
    pending_lobbies: PENDING_LOBBIES.size,
    lobby_timeout: LOBBY_TIMEOUT,
    auto_move_bonus: AUTO_MOVE_BONUS,
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

// DÉMARRAGE DU SERVEUR
async function startServer() {
  try {
    await initializeDatabase();
    await loadTrustedDevices();
    await loadBotScores();
    
    sponsorshipScanInterval = setInterval(scanAndValidateAllSponsorships, SPONSORSHIP_SCAN_INTERVAL);
    
    setTimeout(() => {
      scanAndValidateAllSponsorships();
    }, 10 * 1000);
    
    botAutoIncrementInterval = setInterval(incrementBotScoresAutomatically, BOT_INCREMENT_INTERVAL);
    
    setTimeout(() => {
      incrementBotScoresAutomatically();
    }, 60 * 1000);
    
    server.listen(PORT, '0.0.0.0', () => {
      console.log(`=========================================`);
      console.log(`✅ Serveur démarré sur port ${PORT}`);
      console.log(`🤖 ${BOTS.length} adversaires disponibles`);
      console.log(`🎮 SYSTÈME PVP AMÉLIORÉ`);
      console.log(`   • Abandon en 1v1: -${PVP_QUIT_PENALTY} points (TOUJOURS)`);
      console.log(`   • Victime d'abandon: +${AUTO_MOVE_BONUS} points bonus`);
      console.log(`⚙️  SYSTÈME ANTI-MATCH RAPIDE PERSISTANT`);
      console.log(`   • Activé: ${MATCHMAKING_CONFIG.anti_quick_rematch ? 'OUI' : 'NON'}`);
      console.log(`   • Délai: ${MATCHMAKING_CONFIG.min_rematch_delay / 60000} minutes`);
      console.log(`📊 RESTRICTIONS DE SCORE`);
      console.log(`   • ≥${HIGH_SCORE_THRESHOLD} points → ne rencontre pas <${LOW_SCORE_THRESHOLD} points`);
      console.log(`🔒 NOUVELLES FONCTIONNALITÉS ADMIN`);
      console.log(`   • Suppression compte avec liste noire`);
      console.log(`   • Ajustement manuel compteur parrainage`);
      console.log(`   • Gestion liste noire complète`);
      console.log(`⭐ HANDLER admin_get_full_list AJOUTÉ !`);
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
