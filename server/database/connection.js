const fs = require("fs");
const mysql = require("mysql2/promise");

const password =
  process.env.DB_PASSWORD ||
  (process.env.DB_PASSWORD_FILE &&
    fs.readFileSync(process.env.DB_PASSWORD_FILE, "utf8").trim());

module.exports = mysql.createPool({
  host: process.env.DB_HOST || "127.0.0.1",
  port: Number(process.env.DB_PORT) || 3306,
  database: process.env.DB_NAME || "miniworld",
  user: process.env.DB_USER || "app_user",
  password,
  connectionLimit: 10,
  timezone: "Z", // the container runs in UTC
});
