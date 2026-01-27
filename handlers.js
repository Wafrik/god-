const { 
  TRUSTED_DEVICES, 
  PLAYER_CONNECTIONS, 
  PLAYER_QUEUE, 
  PLAYER_TO_GAME, 
  UPDATE_CONFIG,
  BOT_DEPOSITS
} = require('./constants');
const { generateDeviceKey } = require('./utils');
const { getRandomBot } = require('./gameUtils');
const { createGameLobby, handleGameAction } = require('./game');
const { findBestMatchFromQueue } = require('./gameUtils');
const db = require('./database');

// HANDLERS ADMIN
async function handleAdminMessage(ws, message, adminId) {
  const { ADMIN_KEY } = require('./constants');
  const pool = require('./dbPool');
  const { scanAndValidateAllSponsorships } = require('./gameUtils');
  
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
          const { MATCHMAKING_CONFIG } = require('./constants');
          MATCHMAKING_CONFIG.anti_quick_rematch = anti_quick_rematch;
          console.log(`⚙️ Anti-match rapide: ${anti_quick_rematch ? 'ACTIVÉ' : 'DÉSACTIVÉ'}`);
        }
        
        if (min_rematch_delay_minutes) {
          const { MATCHMAKING_CONFIG } = require('./constants');
          MATCHMAKING_CONFIG.min_rematch_delay = min_rematch_delay_minutes * 60 * 1000;
          console.log(`⏱️ Délai anti-match configuré: ${min_rematch_delay_minutes} minutes`);
        }
        
        ws.send(JSON.stringify({
          type: 'admin_matchmaking_config',
          success: true,
          config: require('./constants').MATCHMAKING_CONFIG,
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
          config: require('./constants').MATCHMAKING_CONFIG,
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

        const result = await scanAndValidateAllSponsorships(pool, PLAYER_CONNECTIONS);
        
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

        const { MATCHMAKING_CONFIG, PVP_QUIT_PENALTY } = require('./constants');
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
            active_games: require('./constants').ACTIVE_GAMES.size,
            pending_lobbies: require('./constants').PENDING_LOBBIES.size,
            player_to_game: PLAYER_TO_GAME.size,
            bot_deposits: BOT_DEPOSITS.size,
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

    // NOUVEAU HANDLER: Supprimer un compte
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

    // NOUVEAU HANDLER: Obtenir la liste noire
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

    // NOUVEAU HANDLER: Retirer un numéro de la liste noire
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

    // NOUVEAU HANDLER: Ajuster manuellement le compteur de parrainage
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

    // NOUVEAU HANDLER: Obtenir l'historique des ajustements
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
    await handlers[message.type]();
  } else {
    ws.send(JSON.stringify({ 
      type: 'error', 
      message: 'Commande admin inconnue' 
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
          const newToken = require('./utils').generateId() + require('./utils').generateId();
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
          const game = require('./constants').ACTIVE_GAMES.get(gameId);
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
          const game = require('./constants').ACTIVE_GAMES.get(gameId);
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
            const newToken = require('./utils').generateId() + require('./utils').generateId();
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
        const pool = require('./dbPool');
        const bestMatch = await findBestMatchFromQueue(pool, db);
        
        if (bestMatch) {
          bestMatch.forEach(player => PLAYER_QUEUE.delete(player));
          await createGameLobby(bestMatch, db);
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
      
      const game = require('./constants').ACTIVE_GAMES.get(gameId);
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

module.exports = {
  handleAdminMessage,
  handleClientMessage
};
