const { SPONSOR_MIN_SCORE, BOT_SCORES, BOTS } = require('./constants');
const { getRandomBot } = require('./utils');

// Mettre à jour le score d'un bot
async function updateBotScore(botId, currentBotScore, isWin = false, gameScore = 0, pool) {
  try {
    let finalScore = currentBotScore;
    const isHighScore = currentBotScore >= 10000; // HIGH_SCORE_THRESHOLD

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

// Incrémenter automatiquement les scores des bots
async function incrementBotScoresAutomatically(pool) {
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

// Scanner et valider tous les parrainages
async function scanAndValidateAllSponsorships(pool, PLAYER_CONNECTIONS) {
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
      if (sponsorWs && sponsorWs.readyState === require('ws').OPEN) {
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

// Valider les parrainages quand le score est atteint
async function validateSponsorshipsWhenScoreReached(playerNumber, newScore, pool) {
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
      }
    }
  } catch (error) {
    console.error('Erreur validation parrainages:', error);
  }
}

// Charger les scores des bots
async function loadBotScores(pool) {
  try {
    const result = await pool.query('SELECT bot_id, score FROM bot_scores');
    result.rows.forEach(row => {
      BOT_SCORES.set(row.bot_id, row.score);
    });
  } catch (error) {
    // Ignorer si table non existante
  }
}

// Trouver le meilleur match depuis la file d'attente
async function findBestMatchFromQueue(pool, db) {
  const { PLAYER_QUEUE, PLAYER_TO_GAME, HIGH_SCORE_THRESHOLD, LOW_SCORE_THRESHOLD, MATCHMAKING_CONFIG } = require('./constants');
  const { canMatchPlayers } = require('./utils');
  
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
      
      const matchCheck = await canMatchPlayers(player1.number, player2.number, pool);
      
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

module.exports = {
  updateBotScore,
  incrementBotScoresAutomatically,
  scanAndValidateAllSponsorships,
  validateSponsorshipsWhenScoreReached,
  loadBotScores,
  findBestMatchFromQueue,
  getRandomBot
};
