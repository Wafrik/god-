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

// Fonctions de base pour le jeu
function getRandomBot() {
  const randomBot = require('./constants').BOTS[Math.floor(Math.random() * require('./constants').BOTS.length)];
  const botScore = require('./constants').BOT_SCORES.get(randomBot.id) || randomBot.baseScore;
  return { ...randomBot, score: botScore, is_bot: true };
}

module.exports = {
  generateId,
  generateDeviceKey,
  getRandomBot
};
