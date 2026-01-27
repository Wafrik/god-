const { BOTS, BOT_SCORES } = require('./constants');

// Génération d'ID unique
function generateId() {
  return Math.random().toString(36).substring(2, 15);
}

// Génération de clé device
function generateDeviceKey(ip, deviceId) {
  if (ip.includes('127.0.0.1') || ip.includes('::1') || ip === '::ffff:127.0.0.1') {
    return `web_${deviceId}`;
  }
  return `${ip}_${deviceId}`;
}

// Récupérer un bot aléatoire
function getRandomBot() {
  const randomBot = BOTS[Math.floor(Math.random() * BOTS.length)];
  const botScore = BOT_SCORES.get(randomBot.id) || randomBot.baseScore;
  return { ...randomBot, score: botScore, is_bot: true };
}

// Formater une date
function formatDate(dateString) {
  if (dateString == "" || dateString == "null" || dateString == "None") {
    return "N/A";
  }
  
  const dateParts = dateString.split("T");
  if (dateParts.length > 0) {
    const dateArray = dateParts[0].split("-");
    if (dateArray.length == 3) {
      return dateArray[2] + "/" + dateArray[1] + "/" + dateArray[0];
    }
  }
  
  return dateString;
}

// FONCTIONS PERSISTANTES POUR ANTI-MATCH RAPIDE
async function canMatchPlayers(player1Number, player2Number, pool) {
  const { MATCHMAKING_CONFIG, HIGH_SCORE_THRESHOLD, LOW_SCORE_THRESHOLD } = require('./constants');
  
  if (!MATCHMAKING_CONFIG.anti_quick_rematch) {
    return { canMatch: true, reason: "Anti-quick-rematch désactivé" };
  }
  
  try {
    // Récupérer les joueurs depuis la base
    const player1Result = await pool.query('SELECT * FROM users WHERE number = $1', [player1Number]);
    const player2Result = await pool.query('SELECT * FROM users WHERE number = $2', [player2Number]);
    
    const player1 = player1Result.rows[0];
    const player2 = player2Result.rows[0];
    
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
    
    // Nettoyer les vieux matchs
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
async function recordMatch(player1Number, player2Number, pool) {
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

module.exports = {
  generateId,
  generateDeviceKey,
  getRandomBot,
  formatDate,
  canMatchPlayers,
  recordMatch
};
