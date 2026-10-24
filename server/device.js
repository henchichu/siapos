// Gives each browser a random id in a cookie, so the limits and the "same order twice" check can tell phones apart on one wifi.
// It is not a login: anyone can clear it, so the address limit stays as the backstop.
const crypto = require("crypto");

module.exports = (req, res, next) => {
  let id = /(?:^|;\s*)device=([a-f0-9]{32})/.exec(req.headers.cookie || "")?.[1];
  if (!id) {
    id = crypto.randomBytes(16).toString("hex");
    res.cookie("device", id, { httpOnly: true, sameSite: "strict", maxAge: 365 * 24 * 60 * 60 * 1000, secure: process.env.COOKIE_SECURE === "1" || req.secure });
  }
  req.device = id;
  next();
};
