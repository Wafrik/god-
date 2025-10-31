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
const PORT = process.env.PORT || 8000; // 🚀 IMPORTANT pour Render

// Structures optimisées
const TRUSTED_DEVICES = new Map(), PLAYER_CONNECTIONS = new Map(), PLAYER_QUEUE = new Set();
const ACTIVE_GAMES = new Map(), PLAYER_TO_GAME = new Map();

// NOUVEAU: Stockage des sessions WebGL par token unique
const WEBGL_SESSIONS = new Map();

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

// CORRECTION: Clé unique pour WebGL - Utilise IP + User-Agent + Session ID
const generateDeviceKey = (ip, deviceId, userAgent = 'unknown') => {
    // Pour WebGL, on crée une clé plus unique avec plus de données
    return `${ip}_${deviceId}_${userAgent}`;
};

// NOUVELLE FONCTION: Générer un ID de session unique pour WebGL
const generateWebGLSessionId = (ws, req) => {
    const ip = req.socket.remoteAddress;
    const userAgent = req.headers['user-agent'] || 'unknown';
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 15);
    
    return `webgl_${ip}_${userAgent}_${timestamp}_${random}`.replace(/[^a-zA-Z0-9_]/g, '_');
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

// CORRECTION: WebSocket avec gestion améliorée pour WebGL
wss.on('connection', (ws, req) => {
    const ip = req.socket.remoteAddress;
    const userAgent = req.headers['user-agent'] || 'unknown';
    
    // NOUVEAU: Générer un ID de session unique pour WebGL
    const webglSessionId = generateWebGLSessionId(ws, req);
    
    console.log(`🌐 Nouvelle connexion WebGL: ${ip} - ${userAgent.substring(0, 50)}...`);
    
    // Stocker la session WebGL
    WEBGL_SESSIONS.set(webglSessionId, {
        ws: ws,
        ip: ip,
        userAgent: userAgent,
        deviceId: "webgl_" + generateId(),
        connectedAt: Date.now()
    });
    
    // CORRECTION: AUTO-CONNEXION IMMÉDIATE - Vérifier si l'appareil est déjà connu
    const deviceKeyForAutoLogin = `webgl_${webglSessionId}`;
    const trustedNumber = TRUSTED_DEVICES.get(deviceKeyForAutoLogin);
    
    if (trustedNumber) {
        // AUTO-CONNEXION: L'appareil est déjà connu, connexion automatique
        const users = loadUsers();
        const user = users.find(u => u.number === trustedNumber);
        
        if (user) {
            PLAYER_CONNECTIONS.set(trustedNumber, ws);
            user.online = true;
            saveUsers(users);
            
            // Générer un nouveau token
            const token = generateId() + generateId();
            
            // Envoyer la confirmation d'auto-connexion IMMÉDIATE
            ws.send(JSON.stringify({ 
                type: 'auto_login_success', 
                username: user.username, 
                score: user.score, 
                number: user.number,
                token: token,
                sessionId: webglSessionId,
                isWebGL: true,
                message: 'Connexion automatique réussie'
            }));
            
            console.log(`🔄 Auto-connexion IMMÉDIATE: ${user.username} (${deviceKeyForAutoLogin.substring(0, 20)}...)`);
            
            // Reconnexion lobby si en jeu
            const gameId = PLAYER_TO_GAME.get(trustedNumber);
            const game = ACTIVE_GAMES.get(gameId);
            const player = game?.getPlayerByNumber(trustedNumber);
            if (player) { 
                player.ws = ws; 
                game.broadcastGameState(); 
            }
            
            return; // Ne pas envoyer le message 'connected' normal
        }
    }
    
    // Si pas d'auto-connexion, envoyer le message normal
    ws.send(JSON.stringify({ 
        type: 'connected', 
        message: 'Serveur connecté',
        sessionId: webglSessionId,
        isWebGL: true
    }));
    
    ws.on('message', (data) => {
        try { 
            const message = JSON.parse(data);
            
            // CORRECTION: Pour WebGL, utiliser la session ID comme deviceId principal
            let deviceId = message.deviceId || "unknown";
            
            // Si c'est WebGL, prioriser la session ID
            if (message.sessionId && WEBGL_SESSIONS.has(message.sessionId)) {
                const session = WEBGL_SESSIONS.get(message.sessionId);
                deviceId = session.deviceId;
            }
            
            handleClientMessage(ws, message, ip, deviceId, userAgent, webglSessionId); 
        } catch(e) {
            console.error("❌ Erreur parsing message:", e);
        }
    });

    ws.on('close', () => {
        // Nettoyer la session WebGL
        WEBGL_SESSIONS.delete(webglSessionId);
        
        setTimeout(() => {
            // CORRECTION: Trouver la connexion basée sur la session WebGL
            let disconnectedNumber = null;
            
            // Chercher dans les trusted devices avec la session
            for (let [deviceKey, number] of TRUSTED_DEVICES) {
                if (deviceKey.includes(webglSessionId)) {
                    disconnectedNumber = number;
                    break;
                }
            }
            
            // Si pas trouvé, chercher par IP + User-Agent
            if (!disconnectedNumber) {
                const deviceKey = generateDeviceKey(ip, "webgl", userAgent);
                disconnectedNumber = TRUSTED_DEVICES.get(deviceKey);
            }
            
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
                
                console.log(`🔴 Déconnexion WebGL: ${disconnectedNumber} (${webglSessionId.substring(0, 10)}...)`);
            }
        }, 10000);
    });
});

// CORRECTION: Gestion messages avec support WebGL amélioré
function handleClientMessage(ws, message, ip, deviceId, userAgent, webglSessionId) {
    // CORRECTION: Pour WebGL, utiliser une clé plus spécifique
    let deviceKey;
    
    if (webglSessionId) {
        // WebGL: utiliser la session ID comme clé principale
        deviceKey = `webgl_${webglSessionId}`;
    } else {
        // Appareil normal
        deviceKey = generateDeviceKey(ip, deviceId, userAgent);
    }
    
    const handlers = {
        authenticate: () => {
            const users = loadUsers();
            const user = users.find(u => u.number === message.number && u.password === message.password);
            if (user) {
                // CORRECTION: Sauvegarder avec la clé WebGL si applicable
                TRUSTED_DEVICES.set(deviceKey, message.number);
                saveTrustedDevices(TRUSTED_DEVICES);
                
                PLAYER_CONNECTIONS.set(message.number, ws);
                user.online = true;
                saveUsers(users);
                
                // Générer un token
                const token = generateId() + generateId();
                
                ws.send(JSON.stringify({ 
                    type: 'auth_success', 
                    username: user.username, 
                    score: user.score, 
                    number: user.number,
                    token: token,
                    sessionId: webglSessionId, // Inclure la session ID pour WebGL
                    isWebGL: !!webglSessionId,
                    message: 'Connexion réussie - Auto-connexion activée'
                }));
                
                console.log(`✅ Connexion WebGL: ${user.username} (${deviceKey.substring(0, 20)}...) - Auto-connexion activée`);
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
                const newUser = { username, password, number, age: parseInt(age), score: 0, online: true };
                users.push(newUser);
                saveUsers(users);
                
                // CORRECTION: Sauvegarder avec la clé WebGL - ACTIVATION AUTO-CONNEXION
                TRUSTED_DEVICES.set(deviceKey, number);
                saveTrustedDevices(TRUSTED_DEVICES);
                
                PLAYER_CONNECTIONS.set(number, ws);
                
                // Générer un token
                const token = generateId() + generateId();
                
                ws.send(JSON.stringify({ 
                    type: 'register_success', 
                    message: "Inscription réussie - Auto-connexion activée", 
                    username, 
                    score: 0, 
                    number,
                    token: token,
                    sessionId: webglSessionId, // Inclure la session ID pour WebGL
                    isWebGL: !!webglSessionId
                }));
                
                console.log(`✅ Inscription WebGL: ${username} (${deviceKey.substring(0, 20)}...) - Auto-connexion activée`);
            }
        },

        logout: () => {
            const playerNumber = TRUSTED_DEVICES.get(deviceKey);
            if (playerNumber) {
                // Supprimer l'appareil des devices trusted - DÉSACTIVER AUTO-CONNEXION
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
                
                console.log(`🚪 Déconnexion manuelle WebGL: ${playerNumber} (${deviceKey.substring(0, 20)}...) - Auto-connexion désactivée`);
                
                // Envoyer confirmation
                ws.send(JSON.stringify({ type: 'logout_success', message: 'Déconnexion réussie - Auto-connexion désactivée' }));
            } else {
                ws.send(JSON.stringify({ type: 'error', message: 'Non authentifié' }));
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
                    
                    ws.send(JSON.stringify({ 
                        type: 'auto_login_success', 
                        username: user.username, 
                        score: user.score, 
                        number: user.number,
                        token: token,
                        sessionId: webglSessionId, // Inclure la session ID pour WebGL
                        isWebGL: !!webglSessionId,
                        message: 'Auto-connexion réussie'
                    }));
                    
                    // Reconnexion lobby
                    const gameId = PLAYER_TO_GAME.get(trustedNumber);
                    const game = ACTIVE_GAMES.get(gameId);
                    const player = game?.getPlayerByNumber(trustedNumber);
                    if (player) { 
                        player.ws = ws; 
                        game.broadcastGameState(); 
                    }
                    
                    console.log(`🔄 Auto-login WebGL: ${user.username} (${deviceKey.substring(0, 20)}...)`);
                } else {
                    ws.send(JSON.stringify({ type: 'auto_login_failed', message: 'Utilisateur non trouvé' }));
                }
            } else {
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
    console.log(`🎮 Serveur WEBGL AVEC AUTO-CONNEXION actif sur le port ${PORT}`);
    console.log('✅ Identification unique: Session ID + IP + User-Agent');
    console.log('✅ Support WebGL/itch.io amélioré');
    console.log('✅ AUTO-CONNEXION IMMÉDIATE activée après première connexion');
    console.log('✅ Gestion des connexions multiples depuis même IP');
});
