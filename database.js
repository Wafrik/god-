const { 
  HIGH_SCORE_THRESHOLD, 
  LOW_SCORE_THRESHOLD, 
  BOT_DEPOSIT, 
  SPONSOR_MIN_SCORE,
  BOT_SCORES,
  BOT_DEPOSITS,
  BOTS,
  ADMIN_KEY,
  PVP_QUIT_PENALTY,
  AUTO_MOVE_BONUS
} = require('./constants');
const { generateId } = require('./utils');
const pool = require('./dbPool');

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
    
    // Validation parrainage (fonction externe)
    console.log(`   Validation parrainage pour ${number} (score: ${newScore})`);
    const { validateSponsorshipsWhenScoreReached } = require('./gameUtils');
    await validateSponsorshipsWhenScoreReached(number, newScore, pool);
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

  // IMPORTANT: Fonction pour matchs contre BOTS (système caution)
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

  // NOUVELLE FONCTION: Pénalité abandon en match PVP (1v1)
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
      
      BOT_DEPOSITS.clear();
      
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

  // ===== MODIFICATION DE LA FONCTION getFullListWithBots =====
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
        -- TOTAL GLOBAL (F) = toutes les validations depuis le début
        COALESCE(ss.validated_sponsored, 0) as total_sponsored,
        -- FV = validations DEPUIS LE DERNIER RESET
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
        total_sponsored: player.total_sponsored || 0,      // F = Total global
        validated_sponsored: player.validated_sponsored || 0  // FV = Depuis dernier reset
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
  
// ===== NOUVELLE FONCTION : Réinitialiser les compteurs parrainage =====
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

  // ===== MODIFICATION DE LA FONCTION getSponsorshipStats =====
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

  // NOUVELLE FONCTION: Supprimer un compte
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
      const { PLAYER_CONNECTIONS, PLAYER_QUEUE, PLAYER_TO_GAME, ACTIVE_GAMES } = require('./constants');
      
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

  // NOUVELLE FONCTION: Vérifier si un numéro est sur liste noire
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

  // NOUVELLE FONCTION: Obtenir la liste des numéros blacklistés
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

  // NOUVELLE FONCTION: Retirer un numéro de la liste noire
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

  // ===== MODIFICATION DE LA FONCTION manuallyAdjustSponsorshipCounter =====
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
 
  // NOUVELLE FONCTION: Obtenir l'historique des ajustements de parrainage
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

module.exports = db;
