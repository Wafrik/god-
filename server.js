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
const generateId = () => Math.random().toString(36).substring(2, 15);

// Clé unique améliorée
const generateDeviceKey = (ip, deviceId) => {
    if (ip.includes('127.0.0.1') || ip.includes('::1') || ip === '::ffff:127.0.0.1') {
        return `web_${deviceId}`;
    }
    return `${ip}_${deviceId}`;
};

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
        });
        
        ACTIVE_GAMES.set(id, this);
        console.log(`🎮 Lobby ${id} créé: ${p1.username} vs ${p2.username}`);
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

        // Notification aux joueurs
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

    handlePlayerDisconnect(disconnectedPlayer) {
        const remainingPlayer = this.players.find(p => p.number !== disconnectedPlayer.number);
        if (remainingPlayer?.ws?.readyState === WebSocket.OPEN) {
            remainingPlayer.ws.send(JSON.stringify({ type: 'opponent_left', message: 'Adversaire a quitté la partie' }));
            setTimeout(() => this._endGameByDisconnect(disconnectedPlayer, remainingPlayer), 10000);
        } else {
            this.cleanup();
        }
    }

    _endGameByDisconnect(disconnectedPlayer, remainingPlayer) {
        this._applyDisconnectPenalties(disconnectedPlayer, remainingPlayer);
        this.broadcast({ type: 'game_end', data: { scores: this.scores, winner: remainingPlayer.role } });
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

    endGame() {
        let winner = 'draw';
        if (this.scores.player1 > this.scores.player2) winner = 'player1';
        else if (this.scores.player2 > this.scores.player1) winner = 'player2';
        
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
            }
        });
        saveUsers(users);
    }

    cleanup() {
        if (this.timerInterval) clearInterval(this.timerInterval);
        this.players.forEach(p => PLAYER_TO_GAME.delete(p.number));
        ACTIVE_GAMES.delete(this.id);
    }

    getPlayerByNumber(n) { return this.players.find(p => p.number === n); }
}

// WebSocket avec système de TOKEN
wss.on('connection', (ws, req) => {
    const ip = req.socket.remoteAddress;
    let deviceId = "unknown";
    
    console.log(`🌐 Nouvelle connexion depuis: ${ip}`);
    
    // Envoyer un message de bienvenue
    ws.send(JSON.stringify({ type: 'connected', message: 'Serveur connecté' }));
    
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
            const deviceKey = generateDeviceKey(ip, deviceId);
            const disconnectedNumber = TRUSTED_DEVICES.get(deviceKey);
            
            if (disconnectedNumber) {
                PLAYER_CONNECTIONS.delete(disconnectedNumber);
                PLAYER_QUEUE.delete(disconnectedNumber);
                
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
            }
        }, 10000);
    });
});

// Gestion messages avec TOKEN PRINCIPAL
function handleClientMessage(ws, message, ip, deviceId) {
    const deviceKey = generateDeviceKey(ip, deviceId);
    
    console.log(`🔑 Message ${message.type} - Device: ${deviceId}`);
    if (message.token) {
        console.log(`🔑 Token fourni: ${message.token.substring(0, 10)}...`);
    }
    
    const handlers = {
        authenticate: () => {
            const users = loadUsers();
            const user = users.find(u => u.number === message.number && u.password === message.password);
            if (user) {
                // GÉNÉRER OU METTRE À JOUR LE TOKEN
                if (!user.token) {
                    user.token = generateId() + generateId();
                    console.log(`🔑 Nouveau token généré pour ${user.username}`);
                }
                
                // Sauvegarder l'association device → user
                TRUSTED_DEVICES.set(deviceKey, message.number);
                saveTrustedDevices(TRUSTED_DEVICES);
                
                PLAYER_CONNECTIONS.set(message.number, ws);
                user.online = true;
                saveUsers(users);
                
                ws.send(JSON.stringify({ 
                    type: 'auth_success', 
                    username: user.username, 
                    score: user.score, 
                    number: user.number,
                    token: user.token // TOUJOURS ENVOYER LE TOKEN
                }));
                
                console.log(`✅ Connexion: ${user.username} (Token activé)`);
            } else {
                ws.send(JSON.stringify({ type: 'auth_failed', message: 'Numéro ou mot de passe incorrect' }));
            }
        },
        
        register: () => {
            const users = loadUsers();
            const { username, password, confirmPassword, number, age } = message;
            if (!username || !password || !confirmPassword || !number || !age) {
                ws.send(JSON.stringify({ type: 'register_failed', message: "Tous les champs sont requis" }));
            } else if (password !== confirmPassword) {
                ws.send(JSON.stringify({ type: 'register_failed', message: "Mots de passe différents" }));
            } else if (users.find(u => u.username === username)) {
                ws.send(JSON.stringify({ type: 'register_failed', message: "Pseudo déjà utilisé" }));
            } else if (users.find(u => u.number === number)) {
                ws.send(JSON.stringify({ type: 'register_failed', message: "Numéro déjà utilisé" }));
            } else {
                // CRÉER UN TOKEN DÈS L'INSCRIPTION
                const newUser = { 
                    username, 
                    password, 
                    number, 
                    age: parseInt(age), 
                    score: 0, 
                    online: true,
                    token: generateId() + generateId() // TOKEN CRÉÉ ICI
                };
                users.push(newUser);
                saveUsers(users);
                
                // Sauvegarder l'association device → user
                TRUSTED_DEVICES.set(deviceKey, number);
                saveTrustedDevices(TRUSTED_DEVICES);
                
                PLAYER_CONNECTIONS.set(number, ws);
                
                ws.send(JSON.stringify({ 
                    type: 'register_success', 
                    message: "Inscription réussie", 
                    username, 
                    score: 0, 
                    number,
                    token: newUser.token // ENVOYER LE TOKEN
                }));
                
                console.log(`✅ Inscription: ${username} (Token créé)`);
            }
        },

        logout: () => {
            const playerNumber = TRUSTED_DEVICES.get(deviceKey);
            if (playerNumber) {
                // Supprimer l'appareil des devices trusted
                TRUSTED_DEVICES.delete(deviceKey);
                saveTrustedDevices(TRUSTED_DEVICES);
                
                // Supprimer la connexion
                PLAYER_CONNECTIONS.delete(playerNumber);
                PLAYER_QUEUE.delete(playerNumber);
                
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
                
                console.log(`🚪 Déconnexion manuelle: ${playerNumber}`);
                
                // Envoyer confirmation
                ws.send(JSON.stringify({ type: 'logout_success', message: 'Déconnexion réussie' }));
            } else {
                ws.send(JSON.stringify({ type: 'error', message: 'Non authentifié' }));
            }
        },
        
        auto_login: () => {
            // PRIORITÉ ABSOLUE AU TOKEN
            if (message.token) {
                const users = loadUsers();
                const user = users.find(u => u.token === message.token);
                
                if (user) {
                    PLAYER_CONNECTIONS.set(user.number, ws);
                    user.online = true;
                    saveUsers(users);
                    
                    // Sauvegarder aussi l'association device (pour compatibilité)
                    if (deviceId && deviceId !== "unknown") {
                        TRUSTED_DEVICES.set(deviceKey, user.number);
                        saveTrustedDevices(TRUSTED_DEVICES);
                    }
                    
                    ws.send(JSON.stringify({ 
                        type: 'auto_login_success', 
                        username: user.username, 
                        score: user.score, 
                        number: user.number,
                        token: user.token // RENVOYER LE TOKEN
                    }));
                    
                    // Reconnexion lobby si en jeu
                    const gameId = PLAYER_TO_GAME.get(user.number);
                    const game = ACTIVE_GAMES.get(gameId);
                    const player = game?.getPlayerByNumber(user.number);
                    if (player) { 
                        player.ws = ws; 
                        game.broadcastGameState(); 
                    }
                    
                    console.log(`🔄 Auto-login PAR TOKEN: ${user.username}`);
                    return;
                } else {
                    console.log(`❌ Token invalide: ${message.token.substring(0, 10)}...`);
                    ws.send(JSON.stringify({ type: 'auto_login_failed', message: 'Token invalide' }));
                    return;
                }
            }
            
            // FALLBACK: ancien système par device (pour compatibilité)
            const trustedNumber = TRUSTED_DEVICES.get(deviceKey);
            if (trustedNumber) {
                const users = loadUsers();
                const user = users.find(u => u.number === trustedNumber);
                if (user) {
                    PLAYER_CONNECTIONS.set(trustedNumber, ws);
                    user.online = true;
                    saveUsers(users);
                    
                    // S'assurer que l'utilisateur a un token
                    if (!user.token) {
                        user.token = generateId() + generateId();
                        saveUsers(users);
                        console.log(`🔑 Token généré pour ${user.username} (fallback device)`);
                    }
                    
                    ws.send(JSON.stringify({ 
                        type: 'auto_login_success', 
                        username: user.username, 
                        score: user.score, 
                        number: user.number,
                        token: user.token // ENVOYER LE TOKEN
                    }));
                    
                    console.log(`🔄 Auto-login par device: ${user.username}`);
                } else {
                    ws.send(JSON.stringify({ type: 'auto_login_failed', message: 'Utilisateur non trouvé' }));
                }
            } else {
                console.log(`❌ Auto-login échoué - Pas de token ni device reconnu`);
                ws.send(JSON.stringify({ type: 'auto_login_failed', message: 'Appareil non reconnu' }));
            }
        },
        
        get_leaderboard: () => {
            const leaderboard = loadUsers().filter(u => u.score >= 0).sort((a,b) => b.score - a.score)
                .map((u,i) => ({ rank: i+1, username: u.username, score: u.score }));
            ws.send(JSON.stringify({ type: 'leaderboard', leaderboard }));
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
    
    handlers[message.type]?.();
}

function createGameLobby(playerNumbers) {
    const users = loadUsers();
    const p1 = users.find(u => u.number === playerNumbers[0]);
    const p2 = users.find(u => u.number === playerNumbers[1]);
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

// Démarrage
app.use(express.static('public'));
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🎮 Serveur TOKEN ACTIVÉ actif sur le port ${PORT}`);
    console.log('✅ Système de token principal activé');
    console.log('✅ Compatibilité device ID maintenue');
    console.log('✅ Auto-connexion par token pour itch.io');
    console.log('✅ Fallback device ID pour APK/PC');
});
