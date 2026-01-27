const { 
  LOBBY_TIMEOUT, 
  AUTO_MOVE_BONUS, 
  PVP_QUIT_PENALTY,
  HIGH_SCORE_THRESHOLD,
  ACTIVE_GAMES,
  PENDING_LOBBIES,
  PLAYER_TO_GAME,
  PLAYER_CONNECTIONS,
  PLAYER_QUEUE,
  BOT_DEPOSITS
} = require('./constants');
const { recordMatch } = require('./utils');
const db = require('./database');

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
      const pool = require('./dbPool');
      recordMatch(p1.number, p2.number, pool);
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
      if (p.ws?.readyState === require('ws').OPEN) {
        p.ws.send(JSON.stringify({
          type: 'match_cancelled',
          message: reason,
          lobby_id: this.id
        }));
      }
      
      PLAYER_TO_GAME.delete(p.number);
      
      if (!p.ws || p.ws.readyState !== require('ws').OPEN) {
        PLAYER_QUEUE.add(p.number);
      }
    });
    
    this.cleanup();
    
    PENDING_LOBBIES.delete(this.id);
    ACTIVE_GAMES.delete(this.id);
  }

  broadcast(msg) {
    this.players.forEach(p => p.ws?.readyState === require('ws').OPEN && p.ws.send(JSON.stringify(msg)));
  }

  broadcastGameState() {
    this.players.forEach(p => {
      if (p.ws?.readyState === require('ws').OPEN) {
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
    const connectedPlayers = this.players.filter(p => p.ws?.readyState === require('ws').OPEN);
    
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
      if (p.ws?.readyState === require('ws').OPEN) {
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
      if (p.ws?.readyState === require('ws').OPEN && p.role !== player.role) {
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
    
    if (remainingPlayer?.ws?.readyState === require('ws').OPEN) {
      remainingPlayer.ws.send(JSON.stringify({ 
        type: 'opponent_left', 
        message: 'Adversaire a quitté la partie' 
      }));
      
      // APPLICATION DES PÉNALITÉS DIFFÉRENTES SELON LE TYPE DE MATCH
      if (this.gameType === 'pvp_match') {
        // PVP: Celui qui quitte perd -250 points, l'autre gagne +200
        await this._applyPvPDisconnectPenalties(disconnectedPlayer, remainingPlayer);
      } else {
        // Match contre bot: Logique existante
        await this._applyBotDisconnectPenalties(disconnectedPlayer, remainingPlayer);
      }
      
      this.broadcast({ type: 'game_end', data: { scores: this.scores, winner: remainingPlayer.role } });
      this.cleanup();
    } else {
      this.cleanup();
    }
  }

  // NOUVELLE MÉTHODE: Pénalités pour abandon PVP
  async _applyPvPDisconnectPenalties(disconnectedPlayer, remainingPlayer) {
    try {
      await db.applyPvPQuitPenalty(disconnectedPlayer.number, remainingPlayer.number);
    } catch (error) {
      console.error('Erreur pénalités déconnexion PVP:', error);
    }
  }

  // Méthode existante pour matchs contre bots
  async _applyBotDisconnectPenalties(disconnectedPlayer, remainingPlayer) {
    try {
      // Note: Pour un match contre bot, "remainingPlayer" est le joueur humain
      // et "disconnectedPlayer" est le bot (mais le bot ne se déconnecte pas)
      // Cette logique est pour si le joueur se déconnecte d'un match contre bot
      
      const disconnectedUser = await db.getUserByNumber(disconnectedPlayer.number);
      const remainingUser = await db.getUserByNumber(remainingPlayer.number);
      
      if (disconnectedUser && remainingUser) {
        const disconnectedScore = this.scores[disconnectedPlayer.role];
        const remainingScore = this.scores[remainingPlayer.role];
        
        // Logique existante pour match contre bot
        const newDisconnectedScore = Math.max(0, disconnectedUser.score - (disconnectedScore > 15 ? disconnectedScore : 15));
        const newRemainingScore = remainingUser.score + (remainingScore < 15 ? 15 : remainingScore) + AUTO_MOVE_BONUS;
        
        console.log(`💰 Bonus +${AUTO_MOVE_BONUS} points pour ${remainingPlayer.username} (adversaire a quitté)`);
        console.log(`   Score ${remainingPlayer.username}: ${remainingUser.score} → ${newRemainingScore}`);
        console.log(`   Score ${disconnectedPlayer.username}: ${disconnectedUser.score} → ${newDisconnectedScore}`);
        
        await db.updateUserScore(disconnectedPlayer.number, newDisconnectedScore);
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

// Créer un lobby de jeu
async function createGameLobby(playerNumbers, db) {
  const { PLAYER_TO_GAME, PLAYER_QUEUE, PLAYER_CONNECTIONS } = require('./constants');
  
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
  
  if (!ws1 || ws1.readyState !== require('ws').OPEN || !ws2 || ws2.readyState !== require('ws').OPEN) {
    console.log(`❌ Impossible de créer lobby: un joueur déconnecté`);
    if (!PLAYER_TO_GAME.has(player1Number)) PLAYER_QUEUE.add(player1Number);
    if (!PLAYER_TO_GAME.has(player2Number)) PLAYER_QUEUE.add(player2Number);
    return;
  }
  
  const { generateId } = require('./utils');
  const gameId = generateId();
  console.log(`🎮 Création lobby ${gameId}: ${p1.username} vs ${p2.username}`);
  
  new Game(gameId, p1, p2);
  
  playerNumbers.forEach((num, idx) => {
    const ws = PLAYER_CONNECTIONS.get(num);
    const opponent = idx === 0 ? p2 : p1;
    if (ws?.readyState === require('ws').OPEN) {
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

// Gérer les actions de jeu
function handleGameAction(ws, message, deviceKey) {
  const { TRUSTED_DEVICES, PLAYER_TO_GAME, ACTIVE_GAMES } = require('./constants');
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

module.exports = {
  Game,
  createGameLobby,
  handleGameAction
};
