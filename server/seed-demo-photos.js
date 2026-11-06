// Development-only startup: fill missing photos without replacing business uploads.
const fs = require("node:fs/promises");
const path = require("node:path");
const pool = require("./database/connection");

async function seed() {
  const photos = {
    "prd-latte": "latte.jpg", "prd-americano": "americano.webp",
    "prd-chai": "chai.webp", "prd-croissant": "croissant.jpg",
    "prd-muffin": "muffin.jpg", "prd-bag": "whole-bean.webp",
  };
  const uploads = process.env.UPLOAD_DIR || path.join(__dirname, "../uploads");
  for (const [id, file] of Object.entries(photos)) {
    const [rows] = await pool.query(
      "SELECT ProductID FROM Product WHERE ProductID = ? AND BusinessID = ? AND ImageKey IS NULL",
      [id, "biz-brewbean"]
    );
    if (!rows.length) continue;
    const key = `demo-products/${file}`;
    await fs.mkdir(path.join(uploads, "demo-products"), { recursive: true });
    await fs.copyFile(path.join("/sql-dev/photos", file), path.join(uploads, key));
    await pool.query(
      "UPDATE Product SET ImageKey = ? WHERE ProductID = ? AND BusinessID = ? AND ImageKey IS NULL",
      [key, id, "biz-brewbean"]
    );
  }
}

seed().catch((err) => { console.error("Demo photo setup failed:", err); process.exitCode = 1; })
  .finally(() => pool.end());
