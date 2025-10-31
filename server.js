const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// 🚀 CHEMINS CORRIGÉS POUR RENDER
const USERS_FILE = path.join(__dirname, 'users.json');
const TRUSTED_DEVICES_FILE = path.join(__dirname, 'trusted_devices.json');
const PORT = process.env.PORT || 8000;

// Structures optimisées
const TRUSTED_DEVICES = new Map(), PLAYER_CONNECTIONS = new Map(), PLAYER_QUEUE = new Set();
const ACTIVE_GAMES = new Map(), PLAYER_TO_GAME = new Map();

// 🚨 NOUVEAU: File d'attente avec timestamp pour éviter les blocages
const QUEUE_TIMESTAMPS = new Map();

// Utilitaires optimisés
const loadUsers = () => {
    if (!fs.existsSync(USERS_FILE)) {
        fs.writeFileSync(USERS_FILE, JSON.stringify([]));
        return [];
    }
    return JSON.parse(fs.readFileSync(USERS_FILE));
};

const saveUsers = (u) => fs.writeFileSync(USERS_FILE, JSON.stringify(u, null, 2));

const loadTrustedDevices = () => {
    if (!fs.existsSync(TRUSTED_DEVICES_FILE)) {
        fs.writeFileSync(TRUSTED_DEVICES_FILE, JSON.stringify({}));
        return new Map();
    }
    return new Map(Object.entries(JSON.parse(fs.readFileSync(TRUSTED_DEVICES_FILE))));
};

const saveTrustedDevices = (m) => fs.writeFileSync(TRUSTED_DEVICES_FILE, JSON.stringify(Object.fromEntries(m), null, 2));
const generateId = () => Math.random().toString(36).substring(2, 10);

// Clé unique pour identifier les appareils : IP + Device ID
const generateDeviceKey = (ip, deviceId) => `${ip}_${deviceId}`;

// Chargement devices
const trustedDevicesData = loadTrustedDevices();
trustedDevicesData.forEach((v, k) => TRUSTED_DEVICES.set(k, v));

// Classe Game ultra-optimisée
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
            
            // 🚨 NETTOYER LA FILE D'ATTENTE
            PLAYER_QUEUE.delete(p.number);
            QUEUE_TIMESTAMPS.delete(p.number);
        });
        
        ACTIVE_GAMES.set(id, this);
        console.log(`🎮 Lobby ${id} créé: ${p1.username} vs ${p2.username}`);
        console.log(`📊 File d'attente après création: ${Array.from(PLAYER_QUEUE)}`);
        setTimeout(() => this.checkAndStartGame(), 1000);
    }

    broadcast(msg) {
        this.players.forEach(p => {
            if (p.ws?.readyState === WebSocket.OPEN) {
                try {
                    p.ws.send(JSON.stringify(msg));
                } catch (e) {
                    console.error(`❌ Erreur envoi à ${p.username}:`, e);
                }
            }
        });
    }

    broadcastGameState() {
        this.players.forEach(p => {
            if (p.ws?.readyState === WebSocket.OPEN) {
                const oppRole = p.role === 'player1' ? 'player2' : 'player1';
                const oppCombo = this.playerCombinations[oppRole] || [1,1,1,1,1,1];
                try {
                    p.ws.send(JSON.stringify({
                        type: 'game_state', gameState: {
                            phase: this.phase, manche: this.manche, turn: this.turn, scores: this.scores,
                            slotContents: oppCombo, availableSlots: this.availableSlots[p.role]
                        }, player: { id: p.number, role: p.role }
                    }));
                } catch (e) {
                    console.error(`❌ Erreur game_state à ${p.username}:`, e);
                }
            }
        });
    }

    checkAndStartGame() {
        const connectedPlayers = this.players.filter(p => p.ws?.readyState === WebSocket.OPEN);
        console.log(`🔍 Vérification démarrage: ${connectedPlayers.length}/2 joueurs connectés`);
        
        if (connectedPlayers.length === 2 && this.phase === 'waiting') {
            this.phase = 'preparation';
            console.log(`🚀 Démarrage partie ${this.id}`);
            this.broadcast({ type: 'game_start' });
            this.broadcastGameState();
            this.startPreparationTimer();
        } else if (connectedPlayers.length < 2) {
            console.log(`⏳ Attente joueurs... ${connectedPlayers.length}/2`);
            // Réessayer dans 2 secondes
            setTimeout(() => this.checkAndStartGame(), 2000);
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
        console.log(`🎲 Tour initial: ${this.turn}`);
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
        if (this.phase !== 'playing' || this.turn !== player.role) {
            console.log(`❌ Move rejeté: phase=${this.phase}, turn=${this.turn}, player=${player.role}`);
            return false;
        }
        
        const slot = parseInt(slotIndex);
        if (!this.availableSlots[player.role].includes(slot)) {
            console.log(`❌ Slot ${slot} non disponible pour ${player.role}`);
            return false;
        }

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

        console.log(`🎯 ${player.username} choisit slot ${slot} -> ${realValue} points`);

        // Notification aux joueurs
        this.players.forEach(p => {
            if (p.ws?.readyState === WebSocket.OPEN) {
                const isCurrentPlayer = p.role === player.role;
                try {
                    p.ws.send(JSON.stringify({
                        type: 'move_made', data: {
                            player: player.role, slotIndex: slot, value: realValue,
                            newScore: this.scores[player.role],
                            actionType: isCurrentPlayer ? 'reveal_die' : 'remove_die',
                            target: isCurrentPlayer ? 'opponent_slot' : 'player_die',
                            dieIndex: realValue, availableSlots: this.availableSlots[p.role]
                        }
                    }));
                } catch (e) {
                    console.error(`❌ Erreur move_made à ${p.username}:`, e);
                }
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
        console.log(`🤖 Move automatique pour ${player.username}: slot ${randomSlot}`);
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
                try {
                    p.ws.send(JSON.stringify({
                        type: 'emoji_used', data: { player: player.role, emojiIndex }
                    }));
                } catch (e) {
                    console.error(`❌ Erreur emoji à ${p.username}:`, e);
                }
            }
        });
    }

    handlePlayerDisconnect(disconnectedPlayer) {
        console.log(`🔌 ${disconnectedPlayer.username} déconnecté de la partie ${this.id}`);
        const remainingPlayer = this.players.find(p => p.number !== disconnectedPlayer.number);
        if (remainingPlayer?.ws?.readyState === WebSocket.OPEN) {
            try {
                remainingPlayer.ws.send(JSON.stringify({ type: 'opponent_left', message: 'Adversaire a quitté la partie' }));
            } catch (e) {
                console.error(`❌ Erreur opponent_left:`, e);
            }
            setTimeout(() => this._endGameByDisconnect(disconnectedPlayer, remainingPlayer), 10000);
        } else {
            this.cleanup();
        }
    }

    _endGameByDisconnect(disconnectedPlayer, remainingPlayer) {
        this._applyDisconnectPenalties(disconnectedPlayer, remainingPlayer);
        try {
            this.broadcast({ type: 'game_end', data: { scores: this.scores, winner: remainingPlayer.role } });
        } catch (e) {
            console.error(`❌ Erreur game_end:`, e);
        }
        setTimeout(() => this.cleanup(), 5000);
    }

    _applyDisconnectPenalties(disconnectedPlayer, remainingPlayer) {
        const users = loadUsers();
        const disconnectedUser = users.find(u => u.number === disconnectedPlayer.number);
        const remainingUser = users.find(u => u.number === remainingPlayer.number);
        
        if (disconnectedUser && remainingUser) {
            const disconnectedScore = this.scores[disconnectedPlayer.role];
            const remainingScore = this.scores[remainingPlayer.role];
            
            disconnectedUser.score = Math.max(0, disconnectedUser.score - (disconnectedScore > 15 ? disconnectedScore : 15));
            remainingUser.score += remainingScore < 15 ? 15 : remainingScore;
            
            saveUsers(users);
        }
    }

    endTurn() {
        if (this.timerInterval) clearInterval(this.timerInterval);
        this.turn = this.turn === 'player1' ? 'player2' : 'player1';
        console.log(`🔄 Tour changé: ${this.turn}`);
        this.broadcast({ type: 'turn_change', turn: this.turn });
        this.broadcastGameState();
        this.startTurnTimer();
    }

    endManche() {
        if (this.timerInterval) clearInterval(this.timerInterval);
        console.log(`🏁 Manche ${this.manche} terminée`);
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

    endGame() {
        let winner = 'draw';
        if (this.scores.player1 > this.scores.player2) winner = 'player1';
        else if (this.scores.player2 > this.scores.player1) winner = 'player2';
        
        console.log(`🏆 Partie terminée - Vainqueur: ${winner}`);
        this._updatePlayerScores(winner);
        this.broadcast({ type: 'game_end', data: { scores: this.scores, winner } });
        setTimeout(() => this.cleanup(), 5000);
    }

    _updatePlayerScores(winner) {
        const users = loadUsers();
        this.players.forEach(player => {
            const user = users.find(u => u.number === player.number);
            if (user) {
                if (winner === 'draw') return;
                const totalScore = this.scores[player.role];
                user.score += winner === player.role ? totalScore : -totalScore;
                user.score = Math.max(0, user.score);
                console.log(`📊 ${player.username}: ${user.score} points`);
            }
        });
        saveUsers(users);
    }

    cleanup() {
        if (this.timerInterval) clearInterval(this.timerInterval);
        this.players.forEach(p => PLAYER_TO_GAME.delete(p.number));
        ACTIVE_GAMES.delete(this.id);
        console.log(`🧹 Partie ${this.id} nettoyée`);
    }

    getPlayerByNumber(n) { return this.players.find(p => p.number === n); }
}

// WebSocket avec identification Device ID
wss.on('connection', (ws, req) => {
    const ip = req.socket.remoteAddress;
    let deviceId = "unknown";
    
    // Envoyer un message de bienvenue
    try {
        ws.send(JSON.stringify({ type: 'connected', message: 'Serveur connecté' }));
    } catch (e) {
        console.error("❌ Erreur message bienvenue:", e);
    }
    
    ws.on('message', (data) => {
        try { 
            const message = JSON.parse(data);
            
            // Récupérer le deviceId du message
            if (message.deviceId) {
                deviceId = message.deviceId;
            }
            
            handleClientMessage(ws, message, ip, deviceId); 
        } catch(e) {
            console.error("❌ Erreur parsing message:", e);
        }
    });

    ws.on('close', () => {
        setTimeout(() => {
            // Trouver la connexion à fermer basée sur IP + Device ID
            const deviceKey = generateDeviceKey(ip, deviceId);
            const disconnectedNumber = TRUSTED_DEVICES.get(deviceKey);
            
            if (disconnectedNumber) {
                PLAYER_CONNECTIONS.delete(disconnectedNumber);
                PLAYER_QUEUE.delete(disconnectedNumber);
                QUEUE_TIMESTAMPS.delete(disconnectedNumber);
                
                // Marquer comme hors ligne
                const users = loadUsers();
                const user = users.find(u => u.number === disconnectedNumber);
                if (user) {
                    user.online = false;
                    saveUsers(users);
                }
                
                // Gérer la déconnexion du jeu
                const gameId = PLAYER_TO_GAME.get(disconnectedNumber);
                const game = ACTIVE_GAMES.get(gameId);
                const player = game?.getPlayerByNumber(disconnectedNumber);
                if (player) game.handlePlayerDisconnect(player);
                PLAYER_TO_GAME.delete(disconnectedNumber);
                
                console.log(`🔴 Déconnexion: ${disconnectedNumber} (${deviceKey})`);
                console.log(`📊 File d'attente après déco: ${Array.from(PLAYER_QUEUE)}`);
            }
        }, 10000);
    });
});

// 🚨 NOUVELLE FONCTION: Nettoyer la file d'attente des joueurs bloqués
function cleanupStaleQueue() {
    const now = Date.now();
    const STALE_TIMEOUT = 30000; // 30 secondes
    
    for (const [playerNumber, timestamp] of QUEUE_TIMESTAMPS.entries()) {
        if (now - timestamp > STALE_TIMEOUT) {
            console.log(`🧹 Suppression joueur stagnant: ${playerNumber}`);
            PLAYER_QUEUE.delete(playerNumber);
            QUEUE_TIMESTAMPS.delete(playerNumber);
        }
    }
}

// 🚨 NETTOYAGE AUTOMATIQUE TOUTES LES 30 SECONDES
setInterval(cleanupStaleQueue, 30000);

// Gestion messages avec Device ID
function handleClientMessage(ws, message, ip, deviceId) {
    const deviceKey = generateDeviceKey(ip, deviceId);
    
    const handlers = {
        authenticate: () => {
            const users = loadUsers();
            const user = users.find(u => u.number === message.number && u.password === message.password);
            if (user) {
                // Sauvegarder l'association device → user
                TRUSTED_DEVICES.set(deviceKey, message.number);
                saveTrustedDevices(TRUSTED_DEVICES);
                
                PLAYER_CONNECTIONS.set(message.number, ws);
                user.online = true;
                saveUsers(users);
                
                // Générer un token
                const token = generateId() + generateId();
                
                try {
                    ws.send(JSON.stringify({ 
                        type: 'auth_success', 
                        username: user.username, 
                        score: user.score, 
                        number: user.number,
                        token: token
                    }));
                } catch (e) {
                    console.error("❌ Erreur auth_success:", e);
                }
                
                console.log(`✅ Connexion: ${user.username} (${deviceKey})`);
            } else {
                try {
                    ws.send(JSON.stringify({ type: 'auth_failed', message: 'Numéro ou mot de passe incorrect' }));
                } catch (e) {
                    console.error("❌ Erreur auth_failed:", e);
                }
            }
        },
        
        register: () => {
            const users = loadUsers();
            const { username, password, confirmPassword, number, age } = message;
            if (!username || !password || !confirmPassword || !number || !age) {
                try {
                    ws.send(JSON.stringify({ type: 'register_failed', message: "Tous les champs sont requis" }));
                } catch (e) {
                    console.error("❌ Erreur register_failed:", e);
                }
            } else if (password !== confirmPassword) {
                try {
                    ws.send(JSON.stringify({ type: 'register_failed', message: "Mots de passe différents" }));
                } catch (e) {
                    console.error("❌ Erreur register_failed:", e);
                }
            } else if (users.find(u => u.username === username)) {
                try {
                    ws.send(JSON.stringify({ type: 'register_failed', message: "Pseudo déjà utilisé" }));
                } catch (e) {
                    console.error("❌ Erreur register_failed:", e);
                }
            } else if (users.find(u => u.number === number)) {
                try {
                    ws.send(JSON.stringify({ type: 'register_failed', message: "Numéro déjà utilisé" }));
                } catch (e) {
                    console.error("❌ Erreur register_failed:", e);
                }
            } else {
                const newUser = { username, password, number, age: parseInt(age), score: 0, online: true };
                users.push(newUser);
                saveUsers(users);
                
                // Sauvegarder l'association device → user
                TRUSTED_DEVICES.set(deviceKey, number);
                saveTrustedDevices(TRUSTED_DEVICES);
                
                PLAYER_CONNECTIONS.set(number, ws);
                
                // Générer un token
                const token = generateId() + generateId();
                
                try {
                    ws.send(JSON.stringify({ 
                        type: 'register_success', 
                        message: "Inscription réussie", 
                        username, 
                        score: 0, 
                        number,
                        token: token
                    }));
                } catch (e) {
                    console.error("❌ Erreur register_success:", e);
                }
                
                console.log(`✅ Inscription: ${username} (${deviceKey})`);
            }
        },

        // NOUVEAU: Handler pour la déconnexion manuelle
        logout: () => {
            const playerNumber = TRUSTED_DEVICES.get(deviceKey);
            if (playerNumber) {
                // Supprimer l'appareil des devices trusted
                TRUSTED_DEVICES.delete(deviceKey);
                saveTrustedDevices(TRUSTED_DEVICES);
                
                // Supprimer la connexion
                PLAYER_CONNECTIONS.delete(playerNumber);
                PLAYER_QUEUE.delete(playerNumber);
                QUEUE_TIMESTAMPS.delete(playerNumber);
                
                // Marquer comme hors ligne dans la base
                const users = loadUsers();
                const user = users.find(u => u.number === playerNumber);
                if (user) {
                    user.online = false;
                    saveUsers(users);
                }
                
                // Gérer la déconnexion du jeu si en cours
                const gameId = PLAYER_TO_GAME.get(playerNumber);
                const game = ACTIVE_GAMES.get(gameId);
                const player = game?.getPlayerByNumber(playerNumber);
                if (player) game.handlePlayerDisconnect(player);
                PLAYER_TO_GAME.delete(playerNumber);
                
                console.log(`🚪 Déconnexion manuelle: ${playerNumber} (${deviceKey})`);
                
                // Envoyer confirmation
                try {
                    ws.send(JSON.stringify({ type: 'logout_success', message: 'Déconnexion réussie' }));
                } catch (e) {
                    console.error("❌ Erreur logout_success:", e);
                }
            } else {
                try {
                    ws.send(JSON.stringify({ type: 'error', message: 'Non authentifié' }));
                } catch (e) {
                    console.error("❌ Erreur logout error:", e);
                }
            }
        },
        
        auto_login: () => {
            const trustedNumber = TRUSTED_DEVICES.get(deviceKey);
            if (trustedNumber) {
                const users = loadUsers();
                const user = users.find(u => u.number === trustedNumber);
                if (user) {
                    PLAYER_CONNECTIONS.set(trustedNumber, ws);
                    user.online = true;
                    saveUsers(users);
                    
                    // Générer un nouveau token
                    const token = generateId() + generateId();
                    
                    try {
                        ws.send(JSON.stringify({ 
                            type: 'auto_login_success', 
                            username: user.username, 
                            score: user.score, 
                            number: user.number,
                            token: token
                        }));
                    } catch (e) {
                        console.error("❌ Erreur auto_login_success:", e);
                    }
                    
                    // Reconnexion lobby
                    const gameId = PLAYER_TO_GAME.get(trustedNumber);
                    const game = ACTIVE_GAMES.get(gameId);
                    const player = game?.getPlayerByNumber(trustedNumber);
                    if (player) { 
                        player.ws = ws; 
                        game.broadcastGameState(); 
                    }
                    
                    console.log(`🔄 Auto-login: ${user.username} (${deviceKey})`);
                } else {
                    try {
                        ws.send(JSON.stringify({ type: 'auto_login_failed', message: 'Utilisateur non trouvé' }));
                    } catch (e) {
                        console.error("❌ Erreur auto_login_failed:", e);
                    }
                }
            } else {
                try {
                    ws.send(JSON.stringify({ type: 'auto_login_failed', message: 'Appareil non reconnu' }));
                } catch (e) {
                    console.error("❌ Erreur auto_login_failed:", e);
                }
            }
        },
        
        get_leaderboard: () => {
            const leaderboard = loadUsers().filter(u => u.score >= 0).sort((a,b) => b.score - a.score)
                .map((u,i) => ({ rank: i+1, username: u.username, score: u.score }));
            try {
                ws.send(JSON.stringify({ type: 'leaderboard', leaderboard }));
            } catch (e) {
                console.error("❌ Erreur leaderboard:", e);
            }
        },
        
        join_queue: () => {
            const playerNumber = TRUSTED_DEVICES.get(deviceKey);
            if (!playerNumber) {
                try {
                    ws.send(JSON.stringify({ type: 'error', message: 'Non authentifié' }));
                } catch (e) {
                    console.error("❌ Erreur join_queue auth:", e);
                }
                return;
            }
            
            if (PLAYER_TO_GAME.has(playerNumber)) {
                try {
                    ws.send(JSON.stringify({ type: 'error', message: 'Déjà dans une partie' }));
                } catch (e) {
                    console.error("❌ Erreur join_queue déjà en jeu:", e);
                }
                return;
            }
            
            // 🚨 AJOUT TIMESTAMP POUR ÉVITER LES BLOQUAGES
            PLAYER_QUEUE.add(playerNumber);
            QUEUE_TIMESTAMPS.set(playerNumber, Date.now());
            
            try {
                ws.send(JSON.stringify({ type: 'queue_joined', message: 'En attente adversaire' }));
            } catch (e) {
                console.error("❌ Erreur queue_joined:", e);
            }
            
            console.log(`🎯 Joueur ${playerNumber} rejoint file: ${Array.from(PLAYER_QUEUE)}`);
            
            // 🚨 CRÉATION IMMÉDIATE SI 2 JOUEURS DISPONIBLES
            if (PLAYER_QUEUE.size >= 2) {
                const players = Array.from(PLAYER_QUEUE).slice(0, 2);
                console.log(`🎮 Match trouvé entre: ${players}`);
                players.forEach(p => {
                    PLAYER_QUEUE.delete(p);
                    QUEUE_TIMESTAMPS.delete(p);
                });
                createGameLobby(players);
            }
        },
        
        leave_queue: () => {
            const playerNumber = TRUSTED_DEVICES.get(deviceKey);
            if (playerNumber && PLAYER_QUEUE.has(playerNumber)) {
                PLAYER_QUEUE.delete(playerNumber);
                QUEUE_TIMESTAMPS.delete(playerNumber);
                try {
                    ws.send(JSON.stringify({ type: 'queue_left', message: 'Recherche annulée' }));
                } catch (e) {
                    console.error("❌ Erreur queue_left:", e);
                }
                console.log(`❌ Joueur ${playerNumber} quitte file: ${Array.from(PLAYER_QUEUE)}`);
            }
        },
        
        player_move: () => handleGameAction(ws, message, deviceKey),
        dice_swap: () => handleGameAction(ws, message, deviceKey),
        emoji_used: () => handleGameAction(ws, message, deviceKey)
    };
    
    handlers[message.type]?.();
}

function createGameLobby(playerNumbers) {
    const users = loadUsers();
    const p1 = users.find(u => u.number === playerNumbers[0]);
    const p2 = users.find(u => u.number === playerNumbers[1]);
    
    if (!p1 || !p2) {
        console.log(`❌ Impossible de créer lobby: joueurs introuvables`);
        return;
    }
    
    const gameId = generateId();
    console.log(`🎮 Création lobby ${gameId}: ${p1.username} vs ${p2.username}`);
    new Game(gameId, p1, p2);
    
    playerNumbers.forEach((num, idx) => {
        const ws = PLAYER_CONNECTIONS.get(num);
        const opponent = idx === 0 ? p2 : p1;
        if (ws?.readyState === WebSocket.OPEN) {
            try {
                ws.send(JSON.stringify({
                    type: 'match_found', matchId: gameId,
                    opponent: { username: opponent.username, score: opponent.score, number: opponent.number },
                    isPlayer1: idx === 0
                }));
                console.log(`📨 Notification match envoyée à ${idx === 0 ? p1.username : p2.username}`);
            } catch (e) {
                console.error(`❌ Erreur envoi match_found à ${num}:`, e);
            }
        } else {
            console.log(`⚠️ Joueur ${num} non connecté pour notification match`);
        }
    });
}

function handleGameAction(ws, message, deviceKey) {
    const playerNumber = TRUSTED_DEVICES.get(deviceKey);
    if (!playerNumber) {
        try {
            ws.send(JSON.stringify({ type: 'error', message: 'Non identifié' }));
        } catch (e) {
            console.error("❌ Erreur game action auth:", e);
        }
        return;
    }
    
    const game = ACTIVE_GAMES.get(PLAYER_TO_GAME.get(playerNumber));
    if (!game) {
        try {
            ws.send(JSON.stringify({ type: 'error', message: 'Aucune partie active' }));
        } catch (e) {
            console.error("❌ Erreur game action no game:", e);
        }
        return;
    }
    
    const player = game.getPlayerByNumber(playerNumber);
    if (!player) {
        try {
            ws.send(JSON.stringify({ type: 'error', message: 'Joueur introuvable' }));
        } catch (e) {
            console.error("❌ Erreur game action no player:", e);
        }
        return;
    }
    
    const actions = {
        player_move: () => game.makeMove(player, message.data.slotIndex, message.data.value, message.data.combination),
        dice_swap: () => game.swapDice(player, message.data.dieIndexA, message.data.dieIndexB, message.data.combination),
        emoji_used: () => game.handleEmoji(player, message.data.emojiIndex)
    };
    
    actions[message.type]?.();
}

// === 🚨 CORRECTION - AJOUTER CES ROUTES EXPRESS ===

// Route racine pour les health checks
app.get('/', (req, res) => {
    res.json({ 
        status: 'online', 
        message: 'Serveur jeu Godot actif',
        timestamp: new Date().toISOString(),
        players_online: PLAYER_CONNECTIONS.size,
        games_active: ACTIVE_GAMES.size,
        queue_size: PLAYER_QUEUE.size
    });
});

// Route health pour Render
app.get('/health', (req, res) => {
    res.json({ 
        status: 'healthy',
        websocket_connections: PLAYER_CONNECTIONS.size,
        active_games: ACTIVE_GAMES.size,
        queue_size: PLAYER_QUEUE.size,
        queue_players: Array.from(PLAYER_QUEUE)
    });
});

// 🚀 DÉMARRAGE CORRIGÉ
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🎮 Serveur AVEC DEVICE ID actif sur le port ${PORT}`);
    console.log('✅ Identification unique: IP + Device ID');
    console.log('✅ Déconnexion manuelle implémentée');
    console.log(`✅ Health check: http://0.0.0.0:${PORT}/health`);
    console.log('🧹 Nettoyage automatique file d\'attente activé');
});

// Gestion propre de l'arrêt
process.on('SIGTERM', () => {
    console.log('🔄 Arrêt du serveur - Marquage joueurs hors ligne...');
    
    const users = loadUsers();
    users.forEach(user => user.online = false);
    saveUsers(users);
    
    console.log('✅ Tous les joueurs marqués hors ligne');
    process.exit(0);
});
