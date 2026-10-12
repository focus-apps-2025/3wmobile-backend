import express from "express";
import crypto from "crypto";
import { exec } from "child_process";

const router = express.Router();
const GITHUB_SECRET = process.env.GITHUB_SECRET || "focus123";

router.post("/", (req, res) => {
  const signature = req.headers["x-hub-signature-256"];
  const event = req.headers["x-github-event"] || "unknown";

  if (event === "ping") return res.status(200).send({ success: true, message: "Ping received" });
  if (!signature) return res.status(400).send({ success: false, message: "Signature missing" });

  const expected = "sha256=" + crypto.createHmac("sha256", GITHUB_SECRET)
    .update(req.rawBody)
    .digest("hex");

  if (!crypto.timingSafeEqual(Buffer.from(signature, "utf8"), Buffer.from(expected, "utf8"))) {
    return res.status(401).send({ success: false, message: "Invalid signature" });
  }

  res.status(200).send({ success: true, message: "Deployment triggered" });

  // Async deploy
  exec("cd /var/www/3w-wheeler-backend && git fetch origin main && git reset --hard origin/main && npm ci --omit=dev && pm2 restart 3w-wheeler-backend",
    (err, stdout, stderr) => {
      if (err) return console.error("❌ Deployment failed:", err);
      console.log("✅ Deployment complete:\n", stdout);
      if (stderr) console.error(stderr);
    });
});

export default router;