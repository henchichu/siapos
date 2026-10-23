// The React and htm scripts the pages load from /vendor, served from node_modules
const path = require("path");
const express = require("express");

const VENDOR = {
  "react.js": "react/umd/react.production.min.js",
  "react-dom.js": "react-dom/umd/react-dom.production.min.js",
  "htm.js": "htm/dist/htm.umd.js",
};
const router = express.Router();
router.get("/vendor/:file", (req, res, next) => {
  const file = VENDOR[req.params.file];
  if (!file) return next();
  res.sendFile(path.join(__dirname, "../node_modules", file), { maxAge: "1d" });
});

module.exports = router;
