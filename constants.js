// CONFIGURATION DU SERVEUR
const PORT = process.env.PORT || 8000;
const ADMIN_KEY = process.env.ADMIN_KEY || "SECRET_ADMIN_KEY_12345";

// CONSTANTES DU JEU
const HIGH_SCORE_THRESHOLD = 10000;
const LOW_SCORE_THRESHOLD = 3000;
const BOT_INCREMENT_INTERVAL = 3 * 60 * 60 * 1000;
const BOT_DEPOSIT = 250;
const SPONSOR_MIN_SCORE = 2000;
const SPONSORSHIP_SCAN_INTERVAL = 5 * 60 * 1000;
const LOBBY_TIMEOUT = 30000;
const AUTO_MOVE_BONUS = 200;
const PVP_QUIT_PENALTY = 250;

// CONFIGURATION DU MATCHMAKING
const MATCHMAKING_CONFIG = {
  anti_quick_rematch: true,
  min_rematch_delay: 50 * 60 * 1000,
};

// CONFIGURATION DES MISES À JOUR
const UPDATE_CONFIG = {
  force_update: false,
  min_version: "1.1.0",
  latest_version: "1.2.0",
  update_url: "https://play.google.com/store/apps/details?id=com.dogbale.wafrik"
};

// LISTE DES BOTS
const BOTS = [
  { id: "bot_m_001", username: "Lucas", gender: "M", baseScore: 0 },
  { id: "bot_m_002", username: "Thomas", gender: "M", baseScore: 0 },
  { id: "bot_m_003", username: "Alexandre", gender: "M", baseScore: 0 },
  { id: "bot_m_004", username: "Mathis", gender: "M", baseScore: 0 },
  { id: "bot_m_005", username: "Nathan", gender: "M", baseScore: 0 },
  { id: "bot_m_006", username: "Enzo", gender: "M", baseScore: 0 },
  { id: "bot_m_007", username: "Louis", gender: "M", baseScore: 0 },
  { id: "bot_m_008", username: "Gabriel", gender: "M", baseScore: 0 },
  { id: "bot_m_009", username: "Hugo", gender: "M", baseScore: 0 },
  { id: "bot_m_010", username: "Raphaël", gender: "M", baseScore: 0 },
  { id: "bot_f_001", username: "Emma", gender: "F", baseScore: 0 },
  { id: "bot_f_002", username: "Léa", gender: "F", baseScore: 0 },
  { id: "bot_f_003", username: "Manon", gender: "F", baseScore: 0 },
  { id: "bot_f_004", username: "Chloé", gender: "F", baseScore: 0 },
  { id: "bot_f_005", username: "Camille", gender: "F", baseScore: 0 },
  { id: "bot_f_006", username: "Sarah", gender: "F", baseScore: 0 },
  { id: "bot_f_007", username: "Julie", gender: "F", baseScore: 0 },
  { id: "bot_f_008", username: "Clara", gender: "F", baseScore: 0 },
  { id: "bot_f_009", username: "Inès", gender: "F", baseScore: 0 },
  { id: "bot_f_010", username: "Zoé", gender: "F", baseScore: 0 },
  { id: "bot_001", username: "Zaboule", gender: "M", baseScore: 0 },
  { id: "bot_002", username: "Ddk", gender: "M", baseScore: 0 },
  { id: "bot_003", username: "Zokou la panthère", gender: "M", baseScore: 0 },
  { id: "bot_004", username: "Atom", gender: "M", baseScore: 0 },
  { id: "bot_005", username: "Yven125", gender: "M", baseScore: 0 },
  { id: "bot_006", username: "Pataff4", gender: "M", baseScore: 0 },
  { id: "bot_007", username: "Afrocc", gender: "M", baseScore: 0 },
  { id: "bot_008", username: "Le babato deluxe", gender: "M", baseScore: 0 },
  { id: "bot_009", username: "Miello", gender: "M", baseScore: 0 },
  { id: "bot_010", username: "2418coto", gender: "M", baseScore: 0 },
  { id: "bot_011", username: "Yako2001", gender: "M", baseScore: 0 },
  { id: "bot_012", username: "Ziparotus", gender: "M", baseScore: 0 },
  { id: "bot_013", username: "Agapli", gender: "F", baseScore: 0 },
  { id: "bot_014", username: "Mireille68", gender: "F", baseScore: 0 },
  { id: "bot_015", username: "Pela8", gender: "F", baseScore: 0 },
  { id: "bot_016", username: "Sylivie", gender: "F", baseScore: 0 },
  { id: "bot_017", username: "Soeur cartie", gender: "F", baseScore: 0 },
  { id: "bot_018", username: "Zezeta23", gender: "F", baseScore: 0 },
  { id: "bot_019", username: "Timo", gender: "M", baseScore: 0 },
  { id: "bot_020", username: "Lina", gender: "F", baseScore: 0 }
];

// MAPS GLOBALES (stockage en mémoire)
const TRUSTED_DEVICES = new Map();
const PLAYER_CONNECTIONS = new Map();
const ADMIN_CONNECTIONS = new Map();
const PLAYER_QUEUE = new Set();
const ACTIVE_GAMES = new Map();
const PLAYER_TO_GAME = new Map();
const BOT_SCORES = new Map();
const BOT_DEPOSITS = new Map();
const PENDING_LOBBIES = new Map();

// Variables d'intervalle
let botAutoIncrementInterval = null;
let sponsorshipScanInterval = null;

module.exports = {
  PORT,
  ADMIN_KEY,
  HIGH_SCORE_THRESHOLD,
  LOW_SCORE_THRESHOLD,
  BOT_INCREMENT_INTERVAL,
  BOT_DEPOSIT,
  SPONSOR_MIN_SCORE,
  SPONSORSHIP_SCAN_INTERVAL,
  LOBBY_TIMEOUT,
  AUTO_MOVE_BONUS,
  PVP_QUIT_PENALTY,
  MATCHMAKING_CONFIG,
  UPDATE_CONFIG,
  BOTS,
  TRUSTED_DEVICES,
  PLAYER_CONNECTIONS,
  ADMIN_CONNECTIONS,
  PLAYER_QUEUE,
  ACTIVE_GAMES,
  PLAYER_TO_GAME,
  BOT_SCORES,
  BOT_DEPOSITS,
  PENDING_LOBBIES,
  botAutoIncrementInterval,
  sponsorshipScanInterval
};
