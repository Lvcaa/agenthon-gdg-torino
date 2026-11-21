import { createCardSimulator } from "./card-simulator.ts";
import { lithicFromEnv } from "./lithic.ts";
import { stripeFromEnv, type StripeIssuing } from "./stripe.ts";

// Chi emette la carta virtuale. CARD_PROVIDER: "simulator" (predefinito, nessuna rete), "lithic" o "stripe".
// Tutti implementano la stessa interfaccia: il flusso non sa quale provider c'è dietro.
export type CardProviderName = "simulator" | "lithic" | "stripe";

export function cardProviderName(): CardProviderName {
  const name = process.env.CARD_PROVIDER ?? "simulator";
  if (name === "simulator" || name === "lithic" || name === "stripe") return name;
  throw new Error(`CARD_PROVIDER non valido: ${name} (usa simulator, lithic o stripe)`);
}

// Lithic tiene in memoria PAN e categorie ammesse per carta: una sola istanza per processo.
let lithic: StripeIssuing | null | undefined;

export function cardProviderFromEnv(): StripeIssuing | null {
  switch (cardProviderName()) {
    case "stripe":
      return stripeFromEnv();
    case "lithic":
      if (lithic === undefined) lithic = lithicFromEnv();
      return lithic;
    default:
      return createCardSimulator();
  }
}
