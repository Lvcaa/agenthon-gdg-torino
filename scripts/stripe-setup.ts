// Ricarica l'Issuing balance di test (500 nella valuta della sandbox: USD con STRIPE_REGION=us, altrimenti EUR) e stampa il saldo.
// Uso: node --env-file=.env.local scripts/stripe-setup.ts [importo_in_euro]
const key = process.env.STRIPE_SECRET_KEY;
if (!key || !key.startsWith("sk_test_")) {
  console.error("STRIPE_SECRET_KEY mancante o non sandbox (sk_test_...)");
  process.exit(1);
}
const euro = Number(process.argv[2] ?? 500);
const currency = process.env.STRIPE_REGION === "us" ? "usd" : "eur";
const headers = { authorization: `Bearer ${key}` };

async function call(method: string, path: string, body?: string) {
  const res = await fetch(`https://api.stripe.com/v1${path}`, {
    method,
    headers: { ...headers, ...(body ? { "content-type": "application/x-www-form-urlencoded" } : {}) },
    body,
  });
  const json: any = await res.json();
  if (!res.ok) throw new Error(`Stripe ${res.status}: ${json?.error?.message ?? "errore"}`);
  return json;
}

await call("POST", "/test_helpers/issuing/fund_balance", `amount=${Math.round(euro * 100)}&currency=${currency}`);
const bal = await call("GET", "/balance");
for (const b of bal.issuing?.available ?? []) {
  console.log(`Issuing balance disponibile: ${(b.amount / 100).toFixed(2)} ${String(b.currency).toUpperCase()}`);
}

export {};
