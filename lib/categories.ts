// Categorie di spesa e dati di fatturazione aziendali (sintetici). Il seed della tabella sta in lib/db.ts.
export const COMPANY_BILLING = {
  name: "Gatti Demo S.r.l.",
  vatNumber: "IT01234567897",
  sdiCode: "M5UXCR1",
  pec: "fatture@gattidemo.example",
  address: "Via Roma 1, 10121 Torino",
} as const;

export interface CategoryRule {
  code: string;
  label: string;
  stripeCategories: string[];
  mcc: string;
  requiresInvoice: boolean;
  receiptLabel: string;
  invoiceNote: string;
}

export const EXPENSE_CATEGORIES: CategoryRule[] = [
  { code: "taxi", label: "Taxi e NCC", stripeCategories: ["taxicabs_limousines"], mcc: "4121", requiresInvoice: false, receiptLabel: "Ricevuta del tassista", invoiceNote: "" },
  { code: "train", label: "Treno", stripeCategories: ["railroads", "passenger_railways"], mcc: "4011/4112", requiresInvoice: false, receiptLabel: "Biglietto o ricevuta", invoiceNote: "" },
  { code: "meals", label: "Pasti", stripeCategories: ["eating_places_restaurants", "fast_food_restaurants"], mcc: "5812/5814", requiresInvoice: false, receiptLabel: "Scontrino", invoiceNote: "" },
  { code: "hotel", label: "Hotel", stripeCategories: ["hotels_motels_and_resorts"], mcc: "7011", requiresInvoice: true, receiptLabel: "Ricevuta o scontrino", invoiceNote: "Senza fattura intestata all'azienda l'IVA non è detraibile." },
  { code: "car_rental", label: "Noleggio auto", stripeCategories: ["car_rental_agencies"], mcc: "7512", requiresInvoice: true, receiptLabel: "Ricevuta", invoiceNote: "Serve la fattura intestata all'azienda per dedurre il costo." },
  { code: "fuel", label: "Carburante", stripeCategories: ["service_stations", "automated_fuel_dispensers"], mcc: "5541/5542", requiresInvoice: true, receiptLabel: "Scontrino", invoiceNote: "Per legge serve la fattura elettronica intestata all'azienda." },
  { code: "conference", label: "Congressi e formazione", stripeCategories: ["miscellaneous_business_services"], mcc: "7399", requiresInvoice: true, receiptLabel: "Ricevuta", invoiceNote: "Serve la fattura intestata all'azienda." },
  { code: "other", label: "Altre spese", stripeCategories: [], mcc: "-", requiresInvoice: true, receiptLabel: "Scontrino", invoiceNote: "Serve la fattura intestata all'azienda." },
];
