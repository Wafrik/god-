const WebSocket = require('ws');
const { TRUSTED_DEVICES, PLAYER_CONNECTIONS, ADMIN_CONNECTIONS } = require('./constants');
const { generateDeviceKey } = require('./utils');
const { handleAdminMessage, handleClientMessage } = require('./handlers');

function setupWebSocket(server) {
  const wss = new WebSocket.Server({ server });
  
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
          adminId = 'admin_' + require('./utils').generateId();
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
          
          // Gestion déconnexion joueur (importe db depuis database.js)
          const db = require('./database');
          
          PLAYER_CONNECTIONS.delete(disconnectedNumber);
          require('./constants').PLAYER_QUEUE.delete(disconnectedNumber);
          
          await db.setUserOnlineStatus(disconnectedNumber, false);
          
          // Gestion déconnexion du jeu
          const gameId = require('./constants').PLAYER_TO_GAME.get(disconnectedNumber);
          if (gameId) {
            const game = require('./constants').ACTIVE_GAMES.get(gameId);
            if (game) {
              const player = game.getPlayerByNumber(disconnectedNumber);
              if (player) {
                await game.handlePlayerDisconnect(player);
              }
            }
          }
          
          require('./constants').PLAYER_TO_GAME.delete(disconnectedNumber);
        }
      }
    });
  });
  
  return wss;
}

module.exports = {
  setupWebSocket
};
