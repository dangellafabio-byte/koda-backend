# Configurazione abbonamenti — Ollenya (brief 2026-11-06)

Allineamento App Store Connect + RevenueCat Dashboard per i tre piani
definitivi. Questa è la configurazione **lato portale**: il codice backend
(`subscription_ledger`, webhook, `/subscription/*`) è già allineato agli
identifier proposti qui sotto.

## 1 · Prodotti Auto-Renewing Subscription

| Identifier (ASC)       | Prezzo   | Durata    | Entitlement RC         | Tier interno |
|------------------------|----------|-----------|------------------------|--------------|
| `ollenya_monthly`      | 29,90 €  | 1 mese    | `ollenya_monthly`      | `monthly`    |
| `ollenya_bimonthly`    | 59,90 €  | 2 mesi    | `ollenya_bimonthly`    | `bimonthly`  |
| `ollenya_annual`       | 354,90 € | 1 anno    | `ollenya_annual`       | `annual`     |

Tutti e tre appartengono allo stesso **Subscription Group** (es.
`ollenya_core`) per consentire upgrade/downgrade tra piani con proration.

### Prodotto Consumable già esistente
`koda_topup_30min_249` — +30 min · 2,49 €. Resta invariato (gestito dal
campo `topup_minutes_remaining` del ledger).

## 2 · Entitlement RevenueCat

Tre entitlement distinti, mutuamente esclusivi:
- `ollenya_monthly` → attaccato al product `ollenya_monthly`
- `ollenya_bimonthly` → attaccato al product `ollenya_bimonthly`
- `ollenya_annual` → attaccato al product `ollenya_annual`

**Priorità in caso di multi-attivazione** (grace, promo, downgrade):
`annual` > `bimonthly` > `monthly`. Già implementata nel webhook.

## 3 · Offering unica
Una sola Offering `default` con 3 Package:
- `$rc_monthly` → `ollenya_monthly`
- `$rc_two_month` → `ollenya_bimonthly`
- `$rc_annual` → `ollenya_annual`

## 4 · Webhook RevenueCat
- URL: `https://<prod-domain>/api/subscription/webhook`
- Header: `Authorization: <valore di REVENUECAT_WEBHOOK_AUTH>`
- Eventi gestiti: `INITIAL_PURCHASE`, `RENEWAL`, `PRODUCT_CHANGE`,
  `CANCELLATION`, `EXPIRATION`.
- **Dedup**: su `transaction_id` (persistito in `rc_webhook_events`).
  Retry RevenueCat non generano doppi accrediti.
- Cancellation: lascia il tier attivo fino a `expires_at`, poi
  `EXPIRATION` disattiva.

## 5 · Carry-over (solo backend, nessuna configurazione RC)
- Monthly: 0 min di riporto.
- Bimonthly: 1 slot M1→M2, cap 50.
- Annual: slot ad ogni passaggio mensile, cap 50; lifetime=1 mese
  (il riportato vale SOLO nel mese successivo). Max 6 riporti nell'annualità
  = 300 min totali. Peak mensile: 300 + 50 = 350.

## 6 · Cosa DEVO fare io (backend/frontend)
- [x] Ledger allineato a 300/50/lifetime=1
- [x] `PLANS` paywall con prezzi/minuti nuovi
- [x] Webhook con mapping nuovo, dedup, auth, ledger lifecycle
- [x] Test ledger (15/15) e test webhook (mapping/priority/dedup/cancel)
- [ ] Integrazione reale `react-native-purchases` nel paywall (bloccata: serve API key RC pubblica + conferma identifier ASC)

## 7 · Cosa devi fare TU (portali)
- [ ] App Store Connect: creare i 3 prodotti auto-renewing con gli
  identifier sopra.
- [ ] RevenueCat Dashboard: creare i 3 entitlement, collegarli ai
  prodotti ASC, creare Offering `default`.
- [ ] RevenueCat: generare chiave API pubblica iOS (pk\_...) → me la
  chiederai tramite card segreti.
- [ ] RevenueCat: impostare webhook con `Authorization` = valore di
  `REVENUECAT_WEBHOOK_AUTH`.
