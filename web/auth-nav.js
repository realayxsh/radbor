(() => {
  const getAvatarUrl = (user) => {
    if (user.avatar) {
      const format = user.avatar.startsWith("a_") ? "gif" : "png";
      return `https://cdn.discordapp.com/avatars/${encodeURIComponent(user.id)}/${encodeURIComponent(user.avatar)}.${format}?size=128`;
    }
    const defaultAvatar = Number((BigInt(user.id) >> 22n) % 6n);
    return `https://cdn.discordapp.com/embed/avatars/${defaultAvatar}.png`;
  };

  document.querySelectorAll("[data-auth-nav]").forEach((nav) => {
    const loginLinks = nav.querySelectorAll("[data-auth-login]");
    const profile = nav.querySelector("[data-auth-profile]");
    const avatar = nav.querySelector("[data-auth-avatar]");
    const fallback = nav.querySelector("[data-auth-fallback]");
    const menu = nav.querySelector("[data-auth-menu]");
    const logout = nav.querySelector("[data-auth-logout]");
    const status = nav.querySelector("[data-auth-status]");

    profile.addEventListener("click", () => {
      const isExpanded = profile.getAttribute("aria-expanded") === "true";
      profile.setAttribute("aria-expanded", String(!isExpanded));
      menu.hidden = isExpanded;
    });

    document.addEventListener("click", (event) => {
      if (!nav.contains(event.target)) {
        profile.setAttribute("aria-expanded", "false");
        menu.hidden = true;
      }
    });

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        profile.setAttribute("aria-expanded", "false");
        menu.hidden = true;
      }
    });

    logout.addEventListener("click", async () => {
      logout.disabled = true;
      status.textContent = "Signing out…";
      try {
        const response = await fetch("/auth/logout", {
          method: "POST",
          credentials: "same-origin"
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "Could not sign out. Please try again.");
        window.location.assign("/login");
      } catch (error) {
        status.textContent = error.message;
        logout.disabled = false;
      }
    });

    fetch("/api/payment/me", { credentials: "same-origin" })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Account check failed (HTTP ${response.status}).`);
        return response.json();
      })
      .then(({ authenticated, discordUser }) => {
        if (!authenticated || !discordUser) return;
        loginLinks.forEach((login) => {
          login.hidden = true;
        });
        profile.hidden = false;
        fallback.textContent = (discordUser.globalName || discordUser.username || "R").charAt(0).toUpperCase();
        avatar.alt = `${discordUser.globalName || discordUser.username}'s Discord avatar`;
        avatar.onload = () => {
          avatar.hidden = false;
          fallback.hidden = true;
        };
        avatar.onerror = () => {
          avatar.hidden = true;
          fallback.hidden = false;
        };
        avatar.src = getAvatarUrl(discordUser);
      })
      .catch((error) => {
        console.error("[account menu] Could not load sign-in status:", error);
      });
  });
})();
