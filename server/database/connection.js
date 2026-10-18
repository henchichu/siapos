const fs = require("fs");
const mysql = require("mysql2/promise");

const password =
  process.env.DB_PASSWORD ||
  (process.env.DB_PASSWORD_FILE &&
    fs.readFileSync(process.env.DB_PASSWORD_FILE, "utf8").trim());

const pool = mysql.createPool({
  host: process.env.DB_HOST || "127.0.0.1",
  port: Number(process.env.DB_PORT) || 3306,
  database: process.env.DB_NAME || "miniworld",
  user: process.env.DB_USER || "app_user",
  password,
  connectionLimit: 10,
  timezone: "Z", // the container runs in UTC
});

// Runs fn(conn) as one transaction: committed if it returns, rolled back if it throws
pool.tx = async (fn) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
};

module.exports = pool;
