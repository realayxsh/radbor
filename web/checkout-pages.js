(() => {
  const params = new URLSearchParams(window.location.search);
  const period = params.get("period");
  const plan = params.get("plan");
  const plans = {
    "no-prefix": { label: "No Prefix", monthly: 99, yearly: 1045.44 },
    "premium-code": { label: "Premium code", monthly: 199, yearly: 2101.44 }
  };
  const formatPrice = (amount) =>
    new Intl.NumberFormat("en-IN", {
      style: "currency",
      currency: "INR",
      minimumFractionDigits: period === "yearly" ? 2 : 0,
      maximumFractionDigits: 2
    }).format(Number(amount));
  const loginUrl = (returnTo) =>
    `/auth/discord?${new URLSearchParams({ returnTo }).toString()}`;
  const discordAvatarUrl = (user) => {
    if (user.avatar) {
      const format = user.avatar.startsWith("a_") ? "gif" : "png";
      return `https://cdn.discordapp.com/avatars/${encodeURIComponent(user.id)}/${encodeURIComponent(user.avatar)}.${format}?size=128`;
    }
    const defaultAvatar = Number((BigInt(user.id) >> 22n) % 6n);
    return `https://cdn.discordapp.com/embed/avatars/${defaultAvatar}.png`;
  };
  const setDiscordAvatar = (image, user, fallback) => {
    image.hidden = true;
    image.onload = () => {
      image.hidden = false;
      if (fallback) fallback.hidden = true;
    };
    image.onerror = () => {
      image.hidden = true;
      if (fallback) fallback.hidden = false;
    };
    image.src = discordAvatarUrl(user);
  };
  const pageStatus = document.querySelector("[data-page-status]");
  const currentPage = document.querySelector("[data-checkout-page]")?.dataset.checkoutPage;

  document.querySelectorAll(".checkout-menu-toggle").forEach((toggle) => {
    const navigation = document.getElementById(toggle.getAttribute("aria-controls"));
    if (!navigation) return;

    const closeMenu = () => {
      toggle.setAttribute("aria-expanded", "false");
      toggle.setAttribute("aria-label", "Open navigation menu");
      navigation.classList.remove("is-open");
    };

    toggle.addEventListener("click", () => {
      const isOpen = toggle.getAttribute("aria-expanded") === "true";
      if (isOpen) {
        closeMenu();
      } else {
        toggle.setAttribute("aria-expanded", "true");
        toggle.setAttribute("aria-label", "Close navigation menu");
        navigation.classList.add("is-open");
      }
    });

    navigation.addEventListener("click", (event) => {
      if (event.target.closest("a")) closeMenu();
    });

    document.addEventListener("click", (event) => {
      if (!toggle.parentElement.contains(event.target)) closeMenu();
    });

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") closeMenu();
    });
  });

  const getJson = async (url, options) => {
    const response = await fetch(url, options);
    const data = await response.json();
    if (!response.ok) {
      const error = new Error(data.error || "The request could not be completed.");
      error.status = response.status;
      throw error;
    }
    return data;
  };

  const showLoginRequired = (returnTo, target) => {
    if (target) target.href = loginUrl(returnTo);
    if (pageStatus) {
      pageStatus.textContent = "Sign in with Discord to continue to checkout.";
    }
  };

  const startCountdown = (expiresAt, element) => {
    let interval;
    const update = () => {
      const secondsLeft = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
      const minutes = String(Math.floor(secondsLeft / 60)).padStart(2, "0");
      const seconds = String(secondsLeft % 60).padStart(2, "0");
      element.textContent = secondsLeft
        ? `Quote countdown: ${minutes}:${seconds}`
        : "One-minute quote window ended. Refresh the quote before paying.";
      element.classList.toggle("is-expired", secondsLeft === 0);
      element.closest(".payment-countdown-card")?.classList.toggle("is-expired", secondsLeft === 0);
      if (!secondsLeft) window.clearInterval(interval);
    };
    update();
    interval = window.setInterval(update, 1000);
  };

  const loadMethodPage = async () => {
    const planInfo = plans[plan];
    if (!planInfo || !["monthly", "yearly"].includes(period)) {
      pageStatus.textContent = "That plan link is invalid. Return to Premium and choose a plan again.";
      return;
    }
    document.querySelector("[data-plan-summary]").textContent =
      `${planInfo.label} · ${formatPrice(planInfo[period])} ${period === "yearly" ? "for 12 months" : "per month"}`;
    const methodOptions = document.querySelector("[data-method-options]");
    const loginButton = document.querySelector("[data-discord-login]");
    const loginStatus = document.querySelector("[data-login-status]");
    const discordUser = document.querySelector("[data-discord-user]");
    const discordUserCard = document.querySelector("[data-discord-user-card]");
    const returnTo = `${window.location.pathname}${window.location.search}`;

    loginButton.href = loginUrl(returnTo);
    try {
      const status = await getJson("/api/payment/me");
      if (!status.oauthConfigured) {
        loginStatus.textContent = "Discord sign-in needs to be configured by the site owner before checkout can continue.";
        loginButton.hidden = true;
        return;
      }
      if (!status.authenticated) {
        loginStatus.textContent = "Sign in to securely associate this payment with your Discord account.";
        return;
      }
      const user = status.discordUser;
      loginStatus.textContent = "Discord account verified.";
      discordUserCard.hidden = false;
      discordUser.textContent = `${user.globalName || user.username} (@${user.username})`;
      setDiscordAvatar(discordUserCard.querySelector("[data-discord-avatar]"), user);
      loginButton.textContent = "Switch Discord account";
      methodOptions.hidden = false;
      methodOptions.querySelectorAll("[data-method-link]").forEach((link) => {
        const query = new URLSearchParams({ plan, period, method: link.dataset.methodLink });
        link.href = `/premium/payment?${query}`;
      });
    } catch (error) {
      loginStatus.textContent = error.message;
    }
  };

  const loadPaymentPage = async () => {
    if (!plans[plan] || !["monthly", "yearly"].includes(period) || !["upi", "litecoin"].includes(params.get("method"))) {
      pageStatus.textContent = "That payment link is invalid. Return to Premium and choose your options again.";
      return;
    }
    const method = params.get("method");
    const refreshButton = document.querySelector("[data-refresh-quote]");
    const approveButton = document.querySelector("[data-approve-payment]");
    const returnTo = `${window.location.pathname}${window.location.search}`;
    const methodUrl = `/premium/payment-method?${new URLSearchParams({ plan, period })}`;
    document.querySelectorAll("[data-back-method]").forEach((link) => {
      link.href = methodUrl;
    });

    const createQuote = async () => {
      refreshButton.disabled = true;
      approveButton.hidden = true;
      document.querySelector("[data-qr-wrap]").hidden = true;
      document.querySelector("[data-qr-caption]").hidden = true;
      document.querySelector("[data-payment-qr]").hidden = true;
      document.querySelector("[data-payment-countdown]").textContent = "Refreshing payment quote…";
      pageStatus.textContent = "Creating a payment QR…";
      try {
        const data = await getJson("/api/payment/quote", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ plan, period, method })
        });
        document.querySelector("[data-payment-title]").textContent =
          method === "upi" ? "Pay with UPI" : "Pay with Crypto (Litecoin)";
        document.querySelector("[data-payment-plan]").textContent =
          `${data.plan} · ${period === "yearly" ? "12 months, billed yearly" : "monthly"}`;
        document.querySelector("[data-payment-amount]").textContent = method === "upi"
          ? `${formatPrice(data.amountInr)} INR`
          : `${data.ltcAmount.toFixed(8)} LTC`;
        document.querySelector("[data-payment-detail]").textContent = method === "upi"
          ? `Pay to ayushreal@fam. Payment note: ${data.reference}`
          : `Plan price ${formatPrice(data.amountInr)} INR · live rate ₹${data.ltcInrRate.toFixed(2)}/LTC · Litecoin network only.`;
        const qr = document.querySelector("[data-payment-qr]");
        qr.src = data.qrCode;
        qr.alt = `${method === "upi" ? "UPI" : "Litecoin"} payment QR for ${data.plan}`;
        qr.hidden = false;
        document.querySelector("[data-qr-wrap]").hidden = false;
        document.querySelector("[data-qr-caption]").hidden = false;
        document.querySelector("[data-open-payment]").hidden = method !== "upi";
        document.querySelector("[data-open-payment]").href = method === "upi" ? data.paymentUri : "#";
        const copyButton = document.querySelector("[data-copy-crypto]");
        copyButton.hidden = method !== "litecoin";
        copyButton.dataset.address = data.ltcAddress || "";
        document.querySelector("[data-copy-status]").textContent = "";
        pageStatus.textContent = "";
        approveButton.href = "/premium/submit";
        approveButton.hidden = false;
        startCountdown(data.expiresAt, document.querySelector("[data-payment-countdown]"));
      } catch (error) {
        if (error.status === 401) {
          showLoginRequired(returnTo, null);
          pageStatus.innerHTML = "";
          const loginLink = document.createElement("a");
          loginLink.className = "button w-button";
          loginLink.href = loginUrl(returnTo);
          loginLink.textContent = "Sign in with Discord";
          pageStatus.append(loginLink);
          return;
        }
        pageStatus.textContent = error.message;
      } finally {
        refreshButton.disabled = false;
      }
    };

    refreshButton.addEventListener("click", createQuote);
    document.querySelector("[data-copy-crypto]").addEventListener("click", async (event) => {
      const address = event.currentTarget.dataset.address;
      if (!address) return;
      try {
        await navigator.clipboard.writeText(address);
        document.querySelector("[data-copy-status]").textContent = "Litecoin address copied.";
      } catch {
        document.querySelector("[data-copy-status]").textContent = `Copy this Litecoin address: ${address}`;
      }
    });
    createQuote();
  };

  const loadSubmitPage = async () => {
    const form = document.querySelector("[data-proof-form]");
    const submitButton = document.querySelector("[data-submit-proof]");
    const status = document.querySelector("[data-submit-status]");
    let paymentContext;
    try {
      paymentContext = await getJson("/api/payment/context");
    } catch (error) {
      if (error.status === 401) {
        status.textContent = "Sign in with Discord to continue.";
        const loginLink = document.createElement("a");
        loginLink.className = "button w-button";
        loginLink.href = loginUrl(`${window.location.pathname}${window.location.search}`);
        loginLink.textContent = "Sign in with Discord";
        status.append(document.createElement("br"), loginLink);
      } else {
        status.textContent = error.message;
      }
      form.hidden = true;
      return;
    }

    document.querySelector("[data-proof-plan]").textContent =
      `${paymentContext.plan} · ${paymentContext.period === "yearly" ? "12 months, billed yearly" : "monthly"}`;
    document.querySelector("[data-proof-summary]").textContent =
      `${paymentContext.method === "upi" ? "UPI" : "Litecoin (LTC)"} payment · ${
        paymentContext.method === "upi"
          ? `${formatPrice(paymentContext.amountInr)} INR`
          : `${paymentContext.ltcAmount.toFixed(8)} LTC (quoted at ₹${paymentContext.ltcInrRate.toFixed(2)}/LTC)`
      } · reference ${paymentContext.reference}`;
    const user = paymentContext.discordUser;
    document.querySelector("[data-discord-identity]").textContent =
      `${user.globalName || user.username} (@${user.username})`;
    document.querySelector("[data-discord-user-id]").value = user.id;
    document.querySelector("[data-discord-account]").hidden = false;
    setDiscordAvatar(
      document.querySelector("[data-discord-avatar]"),
      user,
      document.querySelector("[data-avatar-fallback]")
    );
    const isUpi = paymentContext.method === "upi";
    const transactionInput = document.querySelector("#payment-transaction-id");
    const screenshotInput = document.querySelector("#payment-screenshot");
    const screenshotFields = document.querySelector("[data-screenshot-fields]");
    document.querySelector("[data-transaction-label]").textContent =
      isUpi ? "UPI UTR ID" : "Litecoin blockchain transaction link";
    transactionInput.type = isUpi ? "text" : "url";
    transactionInput.maxLength = isUpi ? 128 : 2048;
    transactionInput.placeholder = isUpi
      ? "Enter the UPI UTR ID"
      : "Paste the transaction link from a Litecoin block explorer";
    screenshotInput.required = isUpi;
    screenshotInput.disabled = !isUpi;
    screenshotFields.hidden = !isUpi;
    document.querySelector("[data-consent-copy]").textContent = isUpi
      ? "I agree that my UTR and screenshot will be sent to Radio’s private Discord review channel."
      : "I agree that my Litecoin transaction link and payment details will be sent to Radio’s private Discord review channel.";

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (isUpi) {
        const screenshot = screenshotInput.files[0];
        if (!screenshot || screenshot.size > 5 * 1024 * 1024) {
          status.textContent = "Choose a screenshot no larger than 5 MB.";
          return;
        }
        if (!["image/png", "image/jpeg", "image/webp"].includes(screenshot.type)) {
          status.textContent = "Upload a PNG, JPEG, or WebP screenshot.";
          return;
        }
      } else {
        try {
          const transactionUrl = new URL(transactionInput.value);
          if (transactionUrl.protocol !== "https:" || !transactionUrl.hostname.includes(".")) {
            throw new Error("invalid");
          }
        } catch {
          status.textContent = "Enter a valid HTTPS link to the Litecoin transaction on a block explorer.";
          return;
        }
      }
      const data = new FormData(form);
      submitButton.disabled = true;
      status.textContent = "Sending your proof securely for manual review…";
      try {
        const result = await getJson("/api/payment/submit", { method: "POST", body: data });
        status.textContent = result.message;
        window.location.assign("/premium/submitted");
      } catch (error) {
        status.textContent = error.message;
      } finally {
        submitButton.disabled = false;
      }
    });
  };

  const loadSuccessPage = async () => {
    const status = document.querySelector("[data-success-status]");
    try {
      const submission = await getJson("/api/payment/submission");
      document.querySelector("[data-success-plan]").textContent =
        `${submission.plan} · ${submission.period === "yearly" ? "Yearly" : "Monthly"}`;
      document.querySelector("[data-success-method]").textContent =
        submission.method === "upi" ? "UPI" : `Litecoin · ${submission.ltcAmount} LTC`;
      document.querySelector("[data-success-user]").textContent =
        `${submission.discordUser.globalName || submission.discordUser.username} (@${submission.discordUser.username})`;
      document.querySelector("[data-success-date]").textContent =
        new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short" })
          .format(new Date(submission.submittedAt));
      document.querySelector(".payment-success-card").classList.add("is-confirmed");
    } catch (error) {
      status.textContent = error.status === 401
        ? "Sign in with the Discord account used for the submission to view its status."
        : error.message;
      if (error.status === 401) {
        const loginLink = document.createElement("a");
        loginLink.className = "button w-button";
        loginLink.href = loginUrl(`${window.location.pathname}${window.location.search}`);
        loginLink.textContent = "Sign in with Discord";
        status.append(document.createElement("br"), loginLink);
      }
    }
  };

  const loadAccountPage = async () => {
    const loginPanel = document.querySelector("[data-account-login]");
    const profilePanel = document.querySelector("[data-account-profile]");
    const loginLink = document.querySelector("[data-account-login-link]");
    const statusElement = document.querySelector("[data-account-status]");
    loginLink.href = loginUrl("/account");

    try {
      const status = await getJson("/api/payment/me");
      if (!status.oauthConfigured) {
        statusElement.textContent = "Discord sign-in is not configured yet. Please contact Radio Support.";
        loginLink.hidden = true;
        return;
      }
      if (!status.authenticated) return;

      const user = status.discordUser;
      loginPanel.hidden = true;
      profilePanel.hidden = false;
      document.querySelector("[data-account-heading]").textContent = "Your Radio account";
      document.querySelector("[data-account-intro]").textContent =
        "Your Discord profile is connected to Radio.";
      document.querySelector("[data-account-name]").textContent = user.globalName || user.username;
      document.querySelector("[data-account-username]").textContent = `@${user.username}`;
      document.querySelector("[data-account-id]").textContent = user.id;
      const avatarFallback = document.querySelector("[data-account-avatar-fallback]");
      avatarFallback.textContent = (user.globalName || user.username).charAt(0).toUpperCase();
      setDiscordAvatar(document.querySelector("[data-account-avatar]"), user, avatarFallback);
      await loadAccountHistory();
    } catch (error) {
      statusElement.textContent = error.message;
    }

    document.querySelector("[data-account-logout]").addEventListener("click", async (event) => {
      event.currentTarget.disabled = true;
      statusElement.textContent = "Signing out…";
      try {
        await getJson("/auth/logout", { method: "POST" });
        window.location.assign("/login");
      } catch (error) {
        statusElement.textContent = error.message;
        event.currentTarget.disabled = false;
      }
    });
  };

  const loadAccountHistory = async () => {
    const emptyState = document.querySelector("[data-account-history-empty]");
    const emptyPanel = document.querySelector("[data-account-empty-state]");
    const historyList = document.querySelector("[data-account-submissions]");
    try {
      const { submissions } = await getJson("/api/payment/account");
      historyList.replaceChildren();
      emptyState.hidden = true;
      emptyPanel.hidden = submissions.length > 0;
      submissions.forEach((submission) => {
        const card = document.createElement("article");
        card.className = "account-submission";
        const details = document.createElement("div");
        const title = document.createElement("h3");
        title.textContent = `${submission.plan} · ${submission.period === "yearly" ? "Yearly" : "Monthly"}`;
        const description = document.createElement("p");
        const paymentAmount = submission.method === "litecoin"
          ? `${Number(submission.ltcAmount).toFixed(8)} LTC`
          : formatPrice(submission.amountInr);
        description.textContent =
          `${submission.method === "upi" ? "UPI" : "Litecoin"} · ${paymentAmount} · ${new Intl.DateTimeFormat("en-IN", {
            dateStyle: "medium",
            timeStyle: "short"
          }).format(new Date(submission.submittedAt))}`;
        details.append(title, description);
        const status = document.createElement("span");
        status.className = `account-submission-status is-${submission.status}`;
        status.textContent = {
          pending_review: "Waiting for review",
          approved: "Approved",
          declined: "Declined",
          expired: "Expired"
        }[submission.status] || "Status unavailable";
        const content = document.createElement("div");
        content.className = "account-submission-content";
        content.append(details, status);
        card.append(content);
        if (submission.status === "approved" && submission.expiresAt) {
          const countdown = document.createElement("p");
          countdown.className = "account-submission-countdown";
          countdown.dataset.expiresAt = String(submission.expiresAt);
          card.append(countdown);
        }
        if (submission.status === "declined" && submission.declineReason) {
          const reason = document.createElement("p");
          reason.className = "account-submission-reason";
          reason.textContent = `Reason: ${submission.declineReason}`;
          card.append(reason);
        }
        historyList.append(card);
      });
      startApprovalCountdowns();
    } catch (error) {
      emptyPanel.hidden = true;
      emptyState.hidden = false;
      emptyState.textContent = error.message;
    }
  };

  const startApprovalCountdowns = () => {
    const update = () => {
      document.querySelectorAll("[data-expires-at]").forEach((element) => {
        const remaining = Math.max(0, Number(element.dataset.expiresAt) - Date.now());
        const days = Math.floor(remaining / 86_400_000);
        const hours = Math.floor((remaining % 86_400_000) / 3_600_000);
        const minutes = Math.floor((remaining % 3_600_000) / 60_000);
        const seconds = Math.floor((remaining % 60_000) / 1000);
        if (remaining) {
          element.textContent = `Website approval ends in ${days}d ${hours}h ${minutes}m ${seconds}s`;
        } else {
          element.textContent = "Website approval period has ended.";
          const badge = element.closest(".account-submission")?.querySelector(".account-submission-status");
          if (badge) {
            badge.className = "account-submission-status is-expired";
            badge.textContent = "Expired";
          }
        }
      });
    };
    update();
    window.setInterval(update, 1000);
  };

  const loadReviewPage = async () => {
    const token = window.location.pathname.split("/").pop();
    const status = document.querySelector("[data-review-status]");
    const actions = document.querySelector("[data-review-actions]");
    const declineForm = document.querySelector("[data-decline-form]");
    const showResult = (message) => {
      status.textContent = message;
      actions.hidden = true;
      declineForm.hidden = true;
    };
    document.querySelector("[data-show-decline]").addEventListener("click", () => {
      declineForm.hidden = false;
      document.querySelector("[data-decline-reason]").focus();
    });

    try {
      const submission = await getJson(`/api/payment/review/${encodeURIComponent(token)}`);
      document.querySelector("[data-review-plan]").textContent =
        `${submission.plan} · ${submission.period === "yearly" ? "Yearly" : "Monthly"}`;
      document.querySelector("[data-review-user]").textContent =
        `${submission.discordUsername} (${submission.discordUserId})`;
      document.querySelector("[data-review-payment]").textContent =
        `${submission.method === "upi" ? "UPI" : "Litecoin"} · ${submission.method === "litecoin"
          ? `${Number(submission.ltcAmount).toFixed(8)} LTC`
          : formatPrice(submission.amountInr)}`;
      if (submission.status !== "pending_review") {
        const messages = {
          approved: "This payment has already been approved.",
          declined: `This payment was declined${submission.reason ? `: ${submission.reason}` : "."}`,
          expired: "This approved payment period has expired."
        };
        showResult(messages[submission.status] || "This payment has already been reviewed.");
        return;
      }

      actions.hidden = false;
      if (params.get("decision") === "decline") {
        declineForm.hidden = false;
      }
      document.querySelector("[data-approve-review]").addEventListener("click", async () => {
        const button = document.querySelector("[data-approve-review]");
        button.disabled = true;
        try {
          const result = await getJson(`/api/payment/review/${encodeURIComponent(token)}/approve`, { method: "POST" });
          showResult(`Approved. The website countdown ends ${new Intl.DateTimeFormat("en-IN", {
            dateStyle: "medium",
            timeStyle: "short"
          }).format(new Date(result.expiresAt))}. This does not activate the plan in the bot.`);
        } catch (error) {
          status.textContent = error.message;
          button.disabled = false;
        }
      });

      declineForm.addEventListener("submit", async (event) => {
        event.preventDefault();
        const button = declineForm.querySelector("button[type=submit]");
        button.disabled = true;
        try {
          await getJson(`/api/payment/review/${encodeURIComponent(token)}/decline`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ reason: document.querySelector("[data-decline-reason]").value })
          });
          showResult("Declined. The reason is now visible in the user’s website account.");
        } catch (error) {
          status.textContent = error.message;
          button.disabled = false;
        }
      });
    } catch (error) {
      showResult(error.message);
    }
  };

  document.querySelector("#payment-screenshot")?.addEventListener("change", (event) => {
    const file = event.currentTarget.files[0];
    if (!file) return;
    document.querySelector("[data-upload-title]").textContent = "Screenshot ready";
    document.querySelector("[data-upload-name]").textContent = file.name;
    document.querySelector(".payment-upload-zone").classList.add("is-selected");
  });

  if (currentPage === "method") loadMethodPage();
  if (currentPage === "payment") loadPaymentPage();
  if (currentPage === "submit") loadSubmitPage();
  if (currentPage === "success") loadSuccessPage();
  if (currentPage === "account") loadAccountPage();
  if (currentPage === "review") loadReviewPage();
})();
