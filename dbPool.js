const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL non définie');
  process.exit(1);
}

module.exports = pool;
