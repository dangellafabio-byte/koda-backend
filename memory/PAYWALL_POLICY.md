# PAYWALL POLICY — Regole vincolanti prima di toccare il freemium

**Owner: Fabio D'Angella**
**Data policy: 2026-07-23**
**Status: BLOCCANTE — leggere PRIMA di scrivere codice paywall**

---

## ⛔ Regola #0 — Il proprietario NON deve mai essere bloccato dalla sua app

Prima di implementare o modificare qualsiasi logica di:
- Contatore turni gratuiti / limite giornaliero
- Blocco funzionalità dopo N interazioni
- Redirect a schermata di acquisto/paywall
- Verifica di stato "premium" / "subscription active"
- Gate di feature (Stanza dello Sfogo premium, memoria estesa, ecc.)

**...devi PRIMA implementare il meccanismo di bypass per account privilegiati.**

Se implementi il paywall SENZA il bypass, rischi di lasciare Fabio (owner) e chiunque testa l'app in condizioni di sviluppo, bloccato dalla propria applicazione — situazione già sperimentata in altri progetti e riportata come richiesta esplicita il 2026-07-23.

---

## ✅ Requisito 1 — Lista "unlimited accounts" server-side

Deve esistere un meccanismo lato backend che verifichi l'identità dell'utente
(email verificata via OAuth, oppure user_id database) contro una lista whitelist,
e **restituisca `is_unlimited=True` bypassando OGNI check di limite**.

Struttura consigliata:

```python
# In server.py o config dedicato
KODA_UNLIMITED_USERS = os.getenv("KODA_UNLIMITED_USERS", "").split(",")
# Esempio env var:
# KODA_UNLIMITED_USERS=fabio@example.com,stefania@example.com,tester1@example.com

def is_user_unlimited(user_email: str, user_id: str) -> bool:
    """Ritorna True per account bypass paywall. Da chiamare PRIMA di ogni
    check di quota/turno/feature-gate."""
    if not user_email:
        return False
    email_norm = user_email.strip().lower()
    if email_norm in [e.strip().lower() for e in KODA_UNLIMITED_USERS if e]:
        return True
    # Fallback: anche via user_id (per test senza email verificata)
    unlimited_ids = os.getenv("KODA_UNLIMITED_USER_IDS", "").split(",")
    if user_id and user_id in [i.strip() for i in unlimited_ids if i]:
        return True
    return False
```

Le email/ID vanno lette da **environment variable** (mai hardcoded nel codice),
così Fabio può cambiare la lista senza redeploy: aggiorna la var su Railway
dashboard, restart, fatto.

---

## ✅ Requisito 2 — Environment override per build di sviluppo

Su TestFlight / build di sviluppo il paywall deve essere disabilitabile
totalmente via env var:

```python
KODA_PAYWALL_ENABLED = os.getenv("KODA_PAYWALL_ENABLED", "1").lower() in ("1", "true", "yes")

def check_paywall_or_bypass(user_email, user_id):
    if not KODA_PAYWALL_ENABLED:
        return {"allowed": True, "reason": "paywall_disabled_env"}
    if is_user_unlimited(user_email, user_id):
        return {"allowed": True, "reason": "unlimited_user"}
    # ...normale check di quota/turno/feature
```

Questo permette a Fabio di disattivare tutto il paywall in un ambiente
staging senza toccare il codice.

---

## ✅ Requisito 3 — Log esplicito su ogni bypass

Ogni volta che il bypass scatta, deve loggare:

```
logger.info(
    f"[PAYWALL_BYPASS user={user_email or user_id[:8]} "
    f"reason={reason}] paywall check skipped"
)
```

Così nei log Railway Fabio (e agent futuri) vedono immediatamente:
- Quante volte il bypass ha protetto lo user privilegiato
- Se qualche non-privileged sta sbagliando (email typo → paywall attivo su chi non doveva)

---

## ✅ Requisito 4 — Client-side deve rispettare la risposta backend

Il frontend NON deve implementare la sua propria logica di conteggio turni.
Deve chiedere al backend a ogni interazione (o al login) se l'utente è
allowed o meno, e mostrare il paywall SOLO se il backend risponde
`allowed=False`.

Motivo: se il conteggio è client-side, un utente unlimited che chiude e
riapre l'app potrebbe vedere lo stesso il paywall (contatore locale non
resettato). Il backend è la fonte di verità.

---

## 📋 Lista account privilegiati — DA COMPILARE PRIMA DEL LANCIO

**⚠️ Compilare quando si implementa il paywall, non prima. Fabio decide
quali email/ID inserire.**

Attualmente vuota (Fabio, 2026-07-23: "Da inserire a piacimento gli
account/mail che decido che diventano unlimited").

Slot suggeriti:
- `fabio@...` (owner, proprietario dell'app)
- `stefania@...` (compagna di Fabio — accesso permanente illimitato)
- `[beta_tester_1]` (opzionale, per test allargati)
- `[beta_tester_2]` (opzionale)
- Eventuali altri account privati che Fabio userà per sviluppo/debugging

Le variabili env di riferimento:
```
KODA_UNLIMITED_USERS=email1@x.com,email2@x.com,email3@x.com
KODA_UNLIMITED_USER_IDS=uid_abc,uid_def
KODA_PAYWALL_ENABLED=1  # o 0 per disabilitare tutto in staging
```

---

## 🔒 Checklist prima di mergere un fix paywall

Prima di committare qualsiasi modifica che introduce/modifica il paywall,
verificare:

- [ ] `is_user_unlimited()` (o equivalente) esiste e viene chiamato PRIMA
      di ogni check di quota/limite
- [ ] `KODA_PAYWALL_ENABLED=0` disabilita tutto in ambiente di sviluppo
- [ ] Env var `KODA_UNLIMITED_USERS` è documentata nel README/env template
- [ ] Log `[PAYWALL_BYPASS]` funziona e appare quando dovuto
- [ ] Testato con account owner (Fabio) → nessun blocco anche dopo
      50+ turni consecutivi
- [ ] Testato con account normale (nuovo signup) → il paywall scatta come
      previsto dopo il limite
- [ ] Lista email/ID in env var Railway effettivamente popolata prima
      del primo Publish che attiva il paywall

Se anche solo UNO di questi check è unchecked → NON pushare.

---

## 📝 Storia della policy

- **2026-07-23** — Fabio esplicita il requisito post-checkpoint v60.4-stable,
  prima di iniziare il backlog Freemium Paywall. Cita esperienza pregressa
  con altre app dove ha rischiato di bloccarsi da solo. Chiede che il primo
  agent che tocca paywall lo faccia con questa policy davanti.
