(() => {
  const formatPrice = (amount, period) =>
    new Intl.NumberFormat("en-IN", {
      style: "currency",
      currency: "INR",
      minimumFractionDigits: period === "yearly" ? 2 : 0,
      maximumFractionDigits: 2
    }).format(Number(amount));

  document.querySelectorAll(".pricing-period-switch").forEach((switcher) => {
    const scope = switcher.closest(".background-dark") || document;
    const buttons = Array.from(switcher.querySelectorAll("[data-pricing-period]"));

    const updatePrices = (period) => {
      buttons.forEach((button) => {
        button.setAttribute("aria-pressed", String(button.dataset.pricingPeriod === period));
      });

      scope.querySelectorAll("[data-price-monthly][data-price-yearly]").forEach((price) => {
        price.textContent = formatPrice(price.dataset[`price${period[0].toUpperCase()}${period.slice(1)}`], period);
      });

      scope.querySelectorAll("[data-frequency-monthly][data-frequency-yearly]").forEach((frequency) => {
        frequency.textContent = frequency.dataset[`frequency${period[0].toUpperCase()}${period.slice(1)}`];
      });

      scope.querySelectorAll("[data-checkout-plan]").forEach((link) => {
        const params = new URLSearchParams({ plan: link.dataset.checkoutPlan, period });
        link.href = `/premium/payment-method?${params}`;
      });
    };

    buttons.forEach((button) => {
      button.addEventListener("click", () => updatePrices(button.dataset.pricingPeriod));
    });

    updatePrices("monthly");
  });
})();
