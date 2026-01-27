const { Pool } = require('pg');
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
const pool = require('./dbPool'); // Nous créerons ce fichier séparément

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

  // ... CONTINUER AVEC TOUTES LES AUTRES FONCTIONS ...
};

module.exports = db;
