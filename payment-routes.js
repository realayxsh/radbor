const crypto = require("crypto");
const https = require("https");
const express = require("express");
const multer = require("multer");
const QRCode = require("qrcode");
const paymentStore = require("./payment-store");

const router = express.Router();
const plans = {
  "no-prefix": { label: "No Prefix", monthly: 99, yearly: 1045.44 },
  "premium-code": { label: "Premium code", monthly: 199, yearly: 2101.44 }
};
const ltcAddress = "ltc1qd3rqdzplwawpdwwmn4xehczm88mtq29r2quhwl";
const requestCounts = new Map();
const imageTypes = {
  "image/jpeg": (buffer) => buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff,
  "image/png": (buffer) => buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
  "image/webp": (buffer) => buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP"
};
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 8, parts: 10 },
  fileFilter: (req, file, callback) => {
    if (!Object.hasOwn(imageTypes, file.mimetype)) {
      callback(new Error("Upload a PNG, JPEG, or WebP screenshot."));
      return;
    }
    callback(null, true);
  }
});

let cachedLtcInr = null;
let cachedLtcInrAt = 0;

function allowRequests(limit, windowMs) {
  return (req, res, next) => {
    const now = Date.now();
    const ip = req.ip || req.socket.remoteAddress || "unknown";
    const entry = requestCounts.get(ip);
    if (entry && now < entry.resetAt && entry.count >= limit) {
      res.status(429).json({ error: "Too many requests. Please wait a few minutes and try again." });
      return;
    }

    if (!entry || now >= entry.resetAt) {
      requestCounts.set(ip, { count: 1, resetAt: now + windowMs });
    } else {
      entry.count += 1;
    }

    if (requestCounts.size > 2000) {
      for (const [key, value] of requestCounts) {
        if (now >= value.resetAt) requestCounts.delete(key);
      }
    }
    next();
  };
}

function requireSameOrigin(req, res, next) {
  const origin = req.get("origin");
  if (!origin) {
    next();
    return;
  }

  try {
    if (new URL(origin).host === req.get("host")) {
      next();
      return;
    }
  } catch {
    // Reject malformed origins below.
  }
  res.status(403).json({ error: "This request must come from the Radio website." });
}

function getWebhookUrl() {
  const value = process.env.DISCORD_PAYMENT_WEBHOOK_URL;
  if (!value) return null;

  try {
    const webhook = new URL(value);
    if (
      webhook.protocol === "https:" &&
      ["discord.com", "discordapp.com"].includes(webhook.hostname) &&
      /^\/api\/webhooks\/\d+\/[^/]+$/.test(webhook.pathname) &&
      !webhook.search &&
      !webhook.hash
    ) {
      return webhook;
    }
  } catch {
    return null;
  }
  return null;
}

function getPublicBaseUrl() {
  const configured = process.env.PUBLIC_BASE_URL;
  if (!configured) return null;
  try {
    const baseUrl = new URL(configured);
    if (
      !["http:", "https:"].includes(baseUrl.protocol) ||
      baseUrl.username ||
      baseUrl.password ||
      baseUrl.pathname !== "/" ||
      baseUrl.search ||
      baseUrl.hash ||
      (process.env.NODE_ENV === "production" && baseUrl.protocol !== "https:")
    ) {
      return null;
    }
    return baseUrl.origin;
  } catch {
    return null;
  }
}

function fetchLtcInr() {
  if (cachedLtcInr && Date.now() - cachedLtcInrAt < 30_000) {
    return Promise.resolve(cachedLtcInr);
  }

  return new Promise((resolve, reject) => {
    const request = https.get(
      "https://api.coingecko.com/api/v3/simple/price?ids=litecoin&vs_currencies=inr",
      { headers: { "user-agent": "RadioPremiumCheckout/1.0" }, timeout: 8000 },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
          if (body.length > 16_384) request.destroy(new Error("Price response was too large."));
        });
        response.on("end", () => {
          if (response.statusCode !== 200) {
            reject(new Error("The Litecoin exchange rate is temporarily unavailable."));
            return;
          }
          try {
            const rate = Number(JSON.parse(body)?.litecoin?.inr);
            if (!Number.isFinite(rate) || rate <= 0) throw new Error("Invalid exchange rate.");
            cachedLtcInr = rate;
            cachedLtcInrAt = Date.now();
            resolve(rate);
          } catch {
            reject(new Error("Could not read the Litecoin exchange rate."));
          }
        });
      }
    );
    request.on("timeout", () => request.destroy(new Error("Litecoin price request timed out.")));
    request.on("error", reject);
  });
}

function isDiscordOAuthConfigured() {
  return Boolean(
    process.env.DISCORD_CLIENT_ID &&
    process.env.DISCORD_CLIENT_SECRET &&
    process.env.DISCORD_REDIRECT_URI
  );
}

function requireDiscordLogin(req, res, next) {
  if (!req.session.discordUser) {
    res.status(401).json({ error: "Sign in with Discord before continuing." });
    return;
  }
  next();
}

function safeReturnPath(value) {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) {
    return "/premium";
  }
  try {
    const url = new URL(value, "https://radio.invalid");
    if (!["/account", "/login", "/premium/payment-method", "/premium/payment", "/premium/submit"].includes(url.pathname)) {
      return "/premium";
    }
    return `${url.pathname}${url.search}`;
  } catch {
    return "/premium";
  }
}

function saveRegeneratedSession(req, res, user, returnPath) {
  req.session.regenerate((error) => {
    if (error) {
      console.error("[Discord OAuth] Could not renew the login session.");
      res.status(500).send("Could not start a secure login session. Please try again.");
      return;
    }
    req.session.discordUser = user;
    req.session.save((saveError) => {
      if (saveError) {
        console.error("[Discord OAuth] Could not save the login session.");
        res.status(500).send("Could not save your login. Please try again.");
        return;
      }
      res.redirect(returnPath);
    });
  });
}

function sendToDiscord(webhook, fields, file) {
  return new Promise((resolve, reject) => {
    const boundary = `----------------radio${crypto.randomBytes(16).toString("hex")}`;
    const textPart = (name, value) =>
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`);
    const parts = [
      textPart("payload_json", JSON.stringify({
        content: `New Premium payment proof submitted for manual review.\n${fields}`,
        allowed_mentions: { parse: [] }
      }))
    ];
    if (file) {
      parts.push(
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="files[0]"; filename="payment-proof.${file.extension}"\r\n` +
          `Content-Type: ${file.mimeType}\r\n\r\n`
        ),
        file.buffer,
        Buffer.from("\r\n")
      );
    }
    parts.push(Buffer.from(`--${boundary}--\r\n`));
    const body = Buffer.concat(parts);
    const request = https.request({
      hostname: webhook.hostname,
      port: 443,
      path: webhook.pathname,
      method: "POST",
      headers: {
        "content-type": `multipart/form-data; boundary=${boundary}`,
        "content-length": body.length
      },
      timeout: 10_000
    }, (response) => {
      response.resume();
      response.on("end", () => {
        if (response.statusCode >= 200 && response.statusCode < 300) {
          resolve();
        } else {
          reject(new Error(`Discord rejected the upload (HTTP ${response.statusCode}).`));
        }
      });
    });
    request.on("timeout", () => request.destroy(new Error("Discord upload timed out.")));
    request.on("error", reject);
    request.end(body);
  });
}

let expiryCheckRunning = false;
async function notifyExpiredApprovals() {
  if (expiryCheckRunning) return;
  expiryCheckRunning = true;
  try {
    const webhook = getWebhookUrl();
    if (!webhook) return;
    const expired = await paymentStore.getExpiredApprovals(Date.now());
    for (const submission of expired) {
      try {
        await sendToDiscord(webhook, [
          "Premium website approval period has ended.",
          `Plan: ${plans[submission.plan]?.label || "Premium"} (${submission.period})`,
          `Discord user ID: ${submission.discordUserId}`,
          `Website purchase reference: ${submission.reference}`,
          `Expired: ${new Date(submission.expiresAt).toISOString()}`,
          "Status: website approval expired; bot entitlement changes require bot integration."
        ].join("\n"), null);
        await paymentStore.updateSubmission(submission.reference, (current) => {
          if (current.status !== "approved" || current.expiryNotifiedAt) return null;
          return { ...current, status: "expired", expiryNotifiedAt: Date.now() };
        });
      } catch (error) {
        console.error("[payment expiry notification]", error.message);
      }
    }
  } catch (error) {
    console.error("[payment expiry check]", error.message);
  } finally {
    expiryCheckRunning = false;
  }
}

const expiryTimer = setInterval(notifyExpiredApprovals, 60_000);
expiryTimer.unref();
notifyExpiredApprovals();

router.get("/auth/discord", (req, res) => {
  if (!isDiscordOAuthConfigured()) {
    res.status(503).send("Discord sign-in is not configured. Set DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, and DISCORD_REDIRECT_URI on the server.");
    return;
  }
  try {
    const redirectUri = new URL(process.env.DISCORD_REDIRECT_URI);
    if (redirectUri.protocol !== "https:" && process.env.NODE_ENV === "production") {
      res.status(503).send("Discord sign-in requires an HTTPS callback URL in production.");
      return;
    }
    const state = crypto.randomBytes(32).toString("hex");
    req.session.discordOAuthState = state;
    req.session.discordOAuthReturnPath = safeReturnPath(req.query.returnTo);
    req.session.save((error) => {
      if (error) {
        console.error("[Discord OAuth] Could not save authorization state.");
        res.status(500).send("Could not start Discord sign-in. Please try again.");
        return;
      }
      const authorizeUrl = new URL("https://discord.com/oauth2/authorize");
      authorizeUrl.search = new URLSearchParams({
        client_id: process.env.DISCORD_CLIENT_ID,
        redirect_uri: redirectUri.toString(),
        response_type: "code",
        scope: "identify",
        state
      }).toString();
      res.redirect(authorizeUrl.toString());
    });
  } catch {
    res.status(503).send("The Discord OAuth callback URL is invalid. Check DISCORD_REDIRECT_URI on the server.");
  }
});

router.get("/auth/discord/callback", async (req, res) => {
  if (req.query.error) {
    res.status(400).send("Discord sign-in was cancelled or denied. Return to Premium and try again.");
    return;
  }
  const expectedState = req.session.discordOAuthState;
  const suppliedState = req.query.state;
  delete req.session.discordOAuthState;
  if (
    typeof expectedState !== "string" ||
    typeof suppliedState !== "string" ||
    expectedState.length !== suppliedState.length ||
    !crypto.timingSafeEqual(Buffer.from(expectedState), Buffer.from(suppliedState))
  ) {
    res.status(400).send("Discord sign-in could not be verified. Please start again from the Premium page.");
    return;
  }

  const returnPath = safeReturnPath(req.session.discordOAuthReturnPath);
  if (!isDiscordOAuthConfigured() || typeof req.query.code !== "string") {
    res.status(503).send("Discord sign-in is not configured correctly.");
    return;
  }

  try {
    const tokenResponse = await fetch("https://discord.com/api/v10/oauth2/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: process.env.DISCORD_CLIENT_ID,
        client_secret: process.env.DISCORD_CLIENT_SECRET,
        grant_type: "authorization_code",
        code: req.query.code,
        redirect_uri: process.env.DISCORD_REDIRECT_URI
      }),
      signal: AbortSignal.timeout(10_000)
    });
    if (!tokenResponse.ok) {
      console.error(`[Discord OAuth] Token exchange failed (HTTP ${tokenResponse.status}).`);
      res.status(502).send("Discord sign-in could not be completed. Please try again.");
      return;
    }
    const token = await tokenResponse.json();
    const userResponse = await fetch("https://discord.com/api/v10/users/@me", {
      headers: { authorization: `Bearer ${token.access_token}` },
      signal: AbortSignal.timeout(10_000)
    });
    if (!userResponse.ok) {
      console.error(`[Discord OAuth] User profile lookup failed (HTTP ${userResponse.status}).`);
      res.status(502).send("Discord could not provide your profile. Please try again.");
      return;
    }
    const profile = await userResponse.json();
    if (!/^\d{17,20}$/.test(profile.id) || typeof profile.username !== "string") {
      res.status(502).send("Discord returned an unexpected user profile. Please try again.");
      return;
    }
    saveRegeneratedSession(req, res, {
      id: profile.id,
      username: profile.username.slice(0, 50),
      globalName: typeof profile.global_name === "string" ? profile.global_name.slice(0, 50) : null,
      avatar: typeof profile.avatar === "string" ? profile.avatar : null
    }, returnPath);
  } catch (error) {
    console.error("[Discord OAuth] Profile request failed:", error.message);
    res.status(502).send("Discord sign-in is temporarily unavailable. Please try again.");
  }
});

router.get("/api/payment/me", (req, res) => {
  res.json({
    authenticated: Boolean(req.session.discordUser),
    discordUser: req.session.discordUser || null,
    oauthConfigured: isDiscordOAuthConfigured()
  });
});

router.post("/auth/logout", requireSameOrigin, (req, res) => {
  req.session.destroy((error) => {
    if (error) {
      console.error("[Discord OAuth] Could not end the login session.");
      res.status(500).json({ error: "Could not sign out. Please try again." });
      return;
    }
    res.clearCookie("connect.sid", {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production"
    });
    res.json({ message: "Signed out." });
  });
});

router.post("/api/payment/quote", requireSameOrigin, requireDiscordLogin, allowRequests(30, 10 * 60 * 1000), express.json({ limit: "4kb" }), async (req, res) => {
  const { plan: planKey, period, method } = req.body || {};
  const plan = plans[planKey];
  if (!plan || !["monthly", "yearly"].includes(period) || !["upi", "litecoin"].includes(method)) {
    res.status(400).json({ error: "Choose a valid Premium plan, billing period, and payment method." });
    return;
  }

  try {
    const inrAmount = plan[period];
    const issuedAt = Date.now();
    const reference = `R${issuedAt.toString(36).toUpperCase()}${crypto.randomBytes(2).toString("hex").toUpperCase()}`;
    const quote = {
      plan: planKey,
      period,
      method,
      amountInr: inrAmount,
      issuedAt,
      expiresAt: issuedAt + 60_000,
      reference,
      discordUserId: req.session.discordUser.id
    };
    let paymentUri;
    let ltcAmount;
    let ltcInrRate;

    if (method === "upi") {
      const term = period === "yearly" ? "Yearly" : "Monthly";
      const params = new URLSearchParams({
        pa: "ayushreal@fam",
        pn: "Radio Premium",
        am: inrAmount.toFixed(2),
        cu: "INR",
        tn: `${plan.label} ${term} ${reference}`
      });
      paymentUri = `upi://pay?${params}`;
    } else {
      ltcInrRate = await fetchLtcInr();
      ltcAmount = Math.ceil((inrAmount / ltcInrRate) * 100_000_000) / 100_000_000;
      quote.ltcAmount = ltcAmount;
      quote.ltcInrRate = ltcInrRate;
      const params = new URLSearchParams({
        amount: ltcAmount.toFixed(8),
        message: `Radio Premium ${reference}`
      });
      paymentUri = `litecoin:${ltcAddress}?${params}`;
    }

    const qrCode = await QRCode.toDataURL(paymentUri, {
      errorCorrectionLevel: "M",
      margin: 2,
      width: 280
    });
    req.session.paymentQuote = quote;
    req.session.save((error) => {
      if (error) {
        console.error("[payment quote] Could not save the quote to the login session.");
        res.status(500).json({ error: "Could not save this payment session. Please try again." });
        return;
      }
      res.json({
        plan: plan.label,
        period,
        method,
        amountInr: inrAmount,
        reference,
        expiresAt: quote.expiresAt,
        paymentUri,
        qrCode,
        ...(method === "litecoin" ? { ltcAmount, ltcInrRate, ltcAddress } : {})
      });
    });
  } catch (error) {
    console.error("[payment quote]", error.message);
    res.status(503).json({ error: "Could not create a payment quote right now. Please try again shortly." });
  }
});

router.get("/api/payment/context", requireDiscordLogin, (req, res) => {
  const quote = req.session.paymentQuote;
  if (!quote || quote.discordUserId !== req.session.discordUser.id || Date.now() - quote.issuedAt > 24 * 60 * 60 * 1000) {
    res.status(404).json({ error: "No payment session was found. Start again from the Premium page." });
    return;
  }
  res.json({
    plan: plans[quote.plan].label,
    period: quote.period,
    method: quote.method,
    amountInr: quote.amountInr,
    reference: quote.reference,
    expiresAt: quote.expiresAt,
    ltcAmount: quote.ltcAmount || null,
    ltcInrRate: quote.ltcInrRate || null,
    discordUser: req.session.discordUser
  });
});

router.get("/api/payment/submission", requireDiscordLogin, (req, res) => {
  const submission = req.session.paymentSubmission;
  if (!submission || submission.discordUserId !== req.session.discordUser.id) {
    res.status(404).json({ error: "No completed proof submission was found." });
    return;
  }
  res.json({
    plan: plans[submission.plan].label,
    period: submission.period,
    method: submission.method,
    amountInr: submission.amountInr,
    ltcAmount: submission.ltcAmount || null,
    reference: submission.reference,
    submittedAt: submission.submittedAt,
    discordUser: req.session.discordUser
  });
});

router.get("/api/payment/account", requireDiscordLogin, async (req, res) => {
  try {
    const submissions = await paymentStore.getSubmissions(req.session.discordUser.id);
    res.json({ submissions });
  } catch (error) {
    console.error("[payment account] Could not load website payment history:", error.message);
    res.status(500).json({ error: "Could not load your website payment history. Please try again later." });
  }
});

function getReviewToken(req) {
  const token = req.params.token;
  if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token)) return null;
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  return paymentStore.getByReviewTokenHash(tokenHash);
}

router.get("/api/payment/review/:token", allowRequests(30, 10 * 60 * 1000), async (req, res) => {
  try {
    const submission = await getReviewToken(req);
    if (!submission) {
      res.status(404).json({ error: "This review link is invalid." });
      return;
    }
    res.json({
      plan: plans[submission.plan]?.label || "Premium",
      period: submission.period,
      method: submission.method,
      amountInr: submission.amountInr,
      ltcAmount: submission.ltcAmount,
      discordUserId: submission.discordUserId,
      discordUsername: submission.discordUsername,
      submittedAt: submission.submittedAt,
      status: submission.status,
      reason: submission.declineReason || null,
      expiresAt: submission.expiresAt || null
    });
  } catch (error) {
    console.error("[payment review] Could not load review details:", error.message);
    res.status(500).json({ error: "Could not load this review. Please try again." });
  }
});

router.post("/api/payment/review/:token/approve", requireSameOrigin, allowRequests(10, 10 * 60 * 1000), async (req, res) => {
  try {
    const submission = await getReviewToken(req);
    if (!submission) {
      res.status(404).json({ error: "This review link is invalid." });
      return;
    }
    const approvedAt = Date.now();
    const duration = submission.period === "yearly" ? 365 : 30;
    const updated = await paymentStore.updateSubmission(submission.reference, (current) => {
      if (current.status !== "pending_review") return null;
      return {
        ...current,
        status: "approved",
        approvedAt,
        expiresAt: approvedAt + duration * 24 * 60 * 60 * 1000
      };
    });
    if (!updated) {
      res.status(409).json({ error: "This payment has already been reviewed." });
      return;
    }
    res.json({ status: "approved", expiresAt: updated.expiresAt });
  } catch (error) {
    console.error("[payment review] Could not approve submission:", error.message);
    res.status(500).json({ error: "Could not record approval. Please try again." });
  }
});

router.post("/api/payment/review/:token/decline", requireSameOrigin, allowRequests(10, 10 * 60 * 1000), async (req, res) => {
  const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
  if (!reason || reason.length > 1000) {
    res.status(400).json({ error: "Enter a decline reason between 1 and 1000 characters." });
    return;
  }
  try {
    const submission = await getReviewToken(req);
    if (!submission) {
      res.status(404).json({ error: "This review link is invalid." });
      return;
    }
    const updated = await paymentStore.updateSubmission(submission.reference, (current) => {
      if (current.status !== "pending_review") return null;
      return { ...current, status: "declined", declineReason: reason, declinedAt: Date.now() };
    });
    if (!updated) {
      res.status(409).json({ error: "This payment has already been reviewed." });
      return;
    }
    res.json({ status: "declined" });
  } catch (error) {
    console.error("[payment review] Could not decline submission:", error.message);
    res.status(500).json({ error: "Could not record the decline. Please try again." });
  }
});

router.post(
  "/api/payment/submit",
  requireSameOrigin,
  requireDiscordLogin,
  allowRequests(5, 60 * 60 * 1000),
  (req, res, next) => {
    if (!getWebhookUrl()) {
      res.status(503).json({ error: "Payment proof submission is not configured. Please contact Radio Support." });
      return;
    }
    upload.single("screenshot")(req, res, (error) => {
      if (error) {
        const status = error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE" ? 413 : 400;
        res.status(status).json({ error: error.message || "Could not accept this screenshot." });
        return;
      }
      next();
    });
  },
  async (req, res) => {
    const quote = req.session.paymentQuote;
    const discordUser = req.session.discordUser;
    const transactionId = String(req.body?.transactionId || "").trim();
    const serverId = String(req.body?.serverId || "").trim();
    const screenshot = req.file;
    const isUpi = quote?.method === "upi";
    let isValidTransaction = Boolean(transactionId) && transactionId.length <= (isUpi ? 128 : 2048);
    if (!isUpi && isValidTransaction) {
      try {
        const transactionUrl = new URL(transactionId);
        isValidTransaction = transactionUrl.protocol === "https:"
          && transactionUrl.hostname.includes(".")
          && !transactionUrl.username
          && !transactionUrl.password;
      } catch {
        isValidTransaction = false;
      }
    }

    if (!quote || quote.discordUserId !== discordUser.id || Date.now() - quote.issuedAt > 24 * 60 * 60 * 1000) {
      res.status(400).json({ error: "This payment session is invalid or too old. Select the plan and payment method again." });
      return;
    }
    if (
      !isValidTransaction ||
      (isUpi && !screenshot) ||
      (!isUpi && screenshot) ||
      (serverId && !/^\d{17,20}$/.test(serverId))
    ) {
      res.status(400).json({
        error: isUpi
          ? "Add your UPI UTR, a screenshot, and a valid optional Discord server ID."
          : "Add a valid HTTPS Litecoin transaction link and a valid optional Discord server ID."
      });
      return;
    }
    if (req.body?.consent !== "on") {
      res.status(400).json({ error: "Confirm that your payment details may be sent to the private review channel." });
      return;
    }
    const isValidImage = screenshot && imageTypes[screenshot.mimetype]?.(screenshot.buffer);
    if (screenshot && !isValidImage) {
      res.status(400).json({ error: "The uploaded file does not match a supported image format." });
      return;
    }

    const amount = quote.method === "litecoin"
      ? `${quote.ltcAmount} LTC (rate ₹${quote.ltcInrRate.toFixed(2)}/LTC)`
      : `₹${quote.amountInr.toFixed(2)}`;
    const publicBaseUrl = getPublicBaseUrl();
    if (!publicBaseUrl) {
      res.status(503).json({ error: "Payment review links are not configured. Set PUBLIC_BASE_URL to the website's public HTTPS origin." });
      return;
    }
    const reviewToken = crypto.randomBytes(32).toString("hex");
    const reviewLink = `${publicBaseUrl}/review/${reviewToken}`;
    const approveLink = `${reviewLink}?decision=approve`;
    const declineLink = `${reviewLink}?decision=decline`;
    const details = [
      "Review actions (the website asks you to confirm):",
      `[Approve](<${approveLink}>) · [Decline and add a reason](<${declineLink}>)`,
      `Plan: ${plans[quote.plan].label} (${quote.period})`,
      `Payment method: ${quote.method === "upi" ? "UPI" : "Litecoin (LTC)"}`,
      `Quoted amount: ${amount}`,
      isUpi ? `UPI UTR: ${transactionId}` : `Litecoin transaction: <${transactionId}>`,
      `Discord user: ${discordUser.username} (${discordUser.id})`,
      serverId ? `Discord server ID: ${serverId}` : null,
      `Quote reference: ${quote.reference}`,
      `Quote created: ${new Date(quote.issuedAt).toISOString()}`,
      `Status: ${isUpi ? "screenshot received; " : ""}payment and Premium eligibility require manual review.`
    ].filter(Boolean).join("\n");
    const webhook = getWebhookUrl();

    try {
      await sendToDiscord(webhook, details, screenshot ? {
          buffer: screenshot.buffer,
          mimeType: screenshot.mimetype,
          extension: screenshot.mimetype === "image/jpeg" ? "jpg" : screenshot.mimetype.slice(6)
        } : null);
      const submittedAt = Date.now();
      await paymentStore.addSubmission({
        reference: quote.reference,
        plan: quote.plan,
        period: quote.period,
        method: quote.method,
        amountInr: quote.amountInr,
        ltcAmount: quote.ltcAmount || null,
        submittedAt,
        status: "pending_review",
        discordUserId: discordUser.id,
        discordUsername: discordUser.username,
        reviewTokenHash: crypto.createHash("sha256").update(reviewToken).digest("hex")
      });
      req.session.paymentSubmission = {
        plan: quote.plan,
        period: quote.period,
        method: quote.method,
        amountInr: quote.amountInr,
        ltcAmount: quote.ltcAmount || null,
        reference: quote.reference,
        submittedAt,
        discordUserId: discordUser.id
      };
      delete req.session.paymentQuote;
      req.session.save((error) => {
        if (error) {
          console.error("[payment proof submission] Could not save confirmation status.");
          res.status(500).json({ error: "Your proof was sent, but its website confirmation could not be saved. Contact Support and include your submission reference." });
          return;
        }
        res.json({ message: "Payment proof sent for manual review." });
      });
    } catch (error) {
      console.error("[payment proof submission]", error.message);
      res.status(502).json({
        error: error.message.includes("Discord rejected") || error.message.includes("Discord upload")
          ? "Could not send your proof to the review channel. Please try again or contact Radio Support."
          : "Your proof may have reached the review channel, but its website history could not be saved. Contact Radio Support before submitting it again."
      });
    }
  }
);

module.exports = router;
