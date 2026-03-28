// ─── HELPERS ──────────────────────────────────────────────────────────────────
export const fmt = (n) =>
  "₹" + Number(n ?? 0).toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

export const fmtCompact = (n) => {
  const num  = Number(n ?? 0);
  const abs  = Math.abs(num);
  const sign = num < 0 ? "-" : "";
  if (abs >= 10000000) return sign + "₹" + (abs / 10000000).toFixed(2) + "Cr";
  if (abs >= 100000)   return sign + "₹" + (abs / 100000).toFixed(2) + "L";
  if (abs >= 1000)     return sign + "₹" + (abs / 1000).toFixed(2) + "K";
  return sign + "₹" + abs.toFixed(2);
};
