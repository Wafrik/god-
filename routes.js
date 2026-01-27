const express = require('express');

function configureRoutes(app, db, pool, constants, PLAYER_CONNECTIONS, PLAYER_QUEUE, ACTIVE_GAMES, PLAYER_TO_GAME, BOT_DEPOSITS, BOT_SCORES, PENDING_LOBBIES, MATCHMAKING_CONFIG, incrementBotScoresAutomatically, scanAndValidateAllSponsorships, getRandomBot, updateBotScore, BOTS) {
  
  const router = express.Router();
  
  // Route pour obtenir un bot aléatoire
  router.get('/get-bot', async (req, res) => {
    try {
      const bot = getRandomBot(constants.BOTS, BOT_SCORES);
      
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
  
  // Route pour mettre à jour un match contre bot
  router.post('/update-bot-match', express.json(), async (req, res) => {
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
        const currentBotScore = botResult.rows[0]?.score || constants.BOTS.find(b => b.id === botId)?.baseScore || 100;
        
        const botUpdateSuccess = await updateBotScore(botId, currentBotScore, isBotWin, botScore, pool, BOT_SCORES, constants);
        
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
  
  // Route pour signaler une déconnexion
  router.post('/report-disconnect', express.json(), async (req, res) => {
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
  
  // Route pour le classement avec bots
  router.get('/leaderboard-with-bots', async (req, res) => {
    try {
      const leaderboard = await db.getLeaderboard();
      res.json({ success: true, leaderboard: leaderboard, count: leaderboard.length });
    } catch (error) {
      res.status(500).json({ success: false, message: "Erreur serveur" });
    }
  });
  
  // Route pour forcer l'incrément des bots
  router.post('/force-bot-increment', express.json(), async (req, res) => {
    try {
      const { admin_key } = req.body;
      
      if (admin_key !== constants.ADMIN_KEY) {
        return res.status(403).json({ success: false, message: "Clé admin invalide" });
      }
      
      const result = await incrementBotScoresAutomatically(pool, BOT_SCORES);
      
      res.json({
        success: result.success,
        message: "Incrément adversaires effectué"
      });
    } catch (error) {
      console.error('Erreur force adversaire increment:', error);
      res.status(500).json({ success: false, message: "Erreur serveur" });
    }
  });
  
  // Route pour obtenir la configuration du matchmaking
  router.get('/matchmaking-config', (req, res) => {
    res.json({
      success: true,
      config: constants.MATCHMAKING_CONFIG,
      thresholds: {
        high_score: constants.HIGH_SCORE_THRESHOLD,
        low_score: constants.LOW_SCORE_THRESHOLD,
        description: `Joueurs ≥${constants.HIGH_SCORE_THRESHOLD} ne peuvent pas rencontrer joueurs <${constants.LOW_SCORE_THRESHOLD}`
      }
    });
  });
  
  // Route pour mettre à jour la configuration du matchmaking
  router.post('/matchmaking-config/update', express.json(), (req, res) => {
    try {
      const { admin_key, anti_quick_rematch, min_rematch_delay_minutes } = req.body;
      
      if (admin_key !== constants.ADMIN_KEY) {
        return res.status(403).json({ success: false, message: "Clé admin invalide" });
      }
      
      if (anti_quick_rematch !== undefined) {
        constants.MATCHMAKING_CONFIG.anti_quick_rematch = anti_quick_rematch;
      }
      
      if (min_rematch_delay_minutes) {
        constants.MATCHMAKING_CONFIG.min_rematch_delay = min_rematch_delay_minutes * 60 * 1000;
      }
      
      console.log(`⚙️ Configuration matchmaking mise à jour:`, constants.MATCHMAKING_CONFIG);
      
      res.json({
        success: true,
        config: constants.MATCHMAKING_CONFIG,
        message: 'Configuration matchmaking mise à jour (n\'affecte pas les timers en cours)'
      });
    } catch (error) {
      console.error('Erreur update config matchmaking:', error);
      res.status(500).json({ success: false, message: "Erreur serveur" });
    }
  });
  
  // Route pour obtenir les informations de parrain
  router.get('/sponsor-info/:playerNumber', async (req, res) => {
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
  
  // Route pour obtenir les statistiques de parrainage
  router.get('/sponsorship-stats/:playerNumber', async (req, res) => {
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
  
  // Route pour choisir un parrain
  router.post('/choose-sponsor', express.json(), async (req, res) => {
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
  
  // Route pour forcer le scan des parrainages
  router.post('/force-sponsorship-scan', express.json(), async (req, res) => {
    try {
      const { admin_key } = req.body;
      
      if (!admin_key || admin_key !== constants.ADMIN_KEY) {
        return res.status(403).json({ success: false, message: "Clé admin invalide" });
      }
      
      const result = await scanAndValidateAllSponsorships(pool, constants, PLAYER_CONNECTIONS, require('ws'));
      
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
  
  // Route admin pour obtenir les parrainages
  router.get('/admin/sponsorships', async (req, res) => {
    try {
      const { admin_key } = req.query;
      
      if (admin_key !== constants.ADMIN_KEY) {
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
  
  // Route admin pour réinitialiser les compteurs de parrainage
  router.post('/admin/reset-sponsorship-counters', express.json(), async (req, res) => {
    try {
      const { admin_key } = req.body;
      
      if (admin_key !== constants.ADMIN_KEY) {
        return res.status(403).json({ success: false, message: "Clé admin invalide" });
      }
      
      const result = await db.resetSponsorshipCounters();
      
      res.json(result);
    } catch (error) {
      console.error('Erreur reset compteurs parrainage admin:', error);
      res.status(500).json({ success: false, message: "Erreur serveur" });
    }
  });
  
  // Route admin pour obtenir les validations permanentes
  router.get('/admin/permanent-validations', async (req, res) => {
    try {
      const { admin_key } = req.query;
      
      if (admin_key !== constants.ADMIN_KEY) {
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
  
  // Route pour obtenir les statistiques du serveur
  router.get('/server-stats', async (req, res) => {
    try {
      const recentMatchesResult = await pool.query(`
        SELECT COUNT(*) as count FROM recent_matches 
        WHERE match_timestamp > NOW() - INTERVAL '${constants.MATCHMAKING_CONFIG.min_rematch_delay / 60000} minutes'
      `);
      
      res.json({
        success: true,
        stats: {
          connected_players: PLAYER_CONNECTIONS.size,
          in_queue: PLAYER_QUEUE.size,
          active_games: ACTIVE_GAMES.size,
          pending_lobbies: PENDING_LOBBIES.size,
          player_to_game: PLAYER_TO_GAME.size,
          bot_deposits: BOT_DEPOSITS.size,
          recent_matches_in_db: parseInt(recentMatchesResult.rows[0].count)
        },
        matchmaking: {
          config: constants.MATCHMAKING_CONFIG,
          thresholds: {
            high_score: constants.HIGH_SCORE_THRESHOLD,
            low_score: constants.LOW_SCORE_THRESHOLD
          }
        },
        pvp_quit_penalty: constants.PVP_QUIT_PENALTY,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      res.status(500).json({ success: false, message: "Erreur serveur" });
    }
  });
  
  // Route admin pour ajuster manuellement le compteur de parrainage
  router.post('/admin/adjust-sponsorship-counter', express.json(), async (req, res) => {
    try {
      const { admin_key, player_number, adjustment } = req.body;
      
      if (!admin_key || admin_key !== constants.ADMIN_KEY) {
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
  
  // Route admin pour obtenir l'historique des ajustements
  router.get('/admin/sponsorship-adjustment-history', async (req, res) => {
    try {
      const { admin_key } = req.query;
      
      if (!admin_key || admin_key !== constants.ADMIN_KEY) {
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
  
  // Route admin pour supprimer un compte
  router.post('/admin/delete-user', express.json(), async (req, res) => {
    try {
      const { admin_key, player_number } = req.body;
      
      if (!admin_key || admin_key !== constants.ADMIN_KEY) {
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
  
  // Route admin pour obtenir la liste noire
  router.get('/admin/blacklist', async (req, res) => {
    try {
      const { admin_key } = req.query;
      
      if (!admin_key || admin_key !== constants.ADMIN_KEY) {
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
  
  // Route admin pour retirer un numéro de la liste noire
  router.post('/admin/unblacklist', express.json(), async (req, res) => {
    try {
      const { admin_key, number } = req.body;
      
      if (!admin_key || admin_key !== constants.ADMIN_KEY) {
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
  
  // Route de santé
  router.get('/health', (req, res) => {
    res.status(200).json({ 
      status: 'OK', 
      database: 'PostgreSQL', 
      total_bots: constants.BOTS.length,
      bot_deposit: constants.BOT_DEPOSIT,
      pvp_quit_penalty: constants.PVP_QUIT_PENALTY,
      active_deposits: BOT_DEPOSITS.size,
      matchmaking_config: constants.MATCHMAKING_CONFIG,
      score_thresholds: {
        high: constants.HIGH_SCORE_THRESHOLD,
        low: constants.LOW_SCORE_THRESHOLD,
        rule: `≥${constants.HIGH_SCORE_THRESHOLD} vs <${constants.LOW_SCORE_THRESHOLD} = bloqué`
      },
      pending_lobbies: PENDING_LOBBIES.size,
      lobby_timeout: constants.LOBBY_TIMEOUT,
      auto_move_bonus: constants.AUTO_MOVE_BONUS,
      timestamp: new Date().toISOString() 
    });
  });
  
  // Route pour configurer les mises à jour
  router.get('/update-config/:status', (req, res) => {
    const status = req.params.status;
    constants.UPDATE_CONFIG.force_update = (status === 'true' || status === '1' || status === 'yes');
    console.log('✅ Configuration MAJ changée: force_update =', constants.UPDATE_CONFIG.force_update);
    res.json({ 
      success: true, 
      force_update: constants.UPDATE_CONFIG.force_update,
      message: `MAJ ${constants.UPDATE_CONFIG.force_update ? 'activée' : 'désactivée'}`
    });
  });
  
  // Route pour obtenir la configuration des mises à jour
  router.get('/update-config', (req, res) => {
    res.json({
      success: true,
      config: constants.UPDATE_CONFIG
    });
  });
  
  // Utiliser le router
  app.use('/', router);
}

module.exports = { configureRoutes };
