# Known Issues — segnalati da Fabio dopo test build v65 (2026-08-02)

## ISSUE A — Offline UX silent failure 🔴 P1

**Sintomo**: se il device non ha rete internet quando l'utente clicca
sull'eclissi/orb per parlare, dopo ~1 secondo lo stato torna a "idle" SENZA
alcun feedback all'utente. L'utente non capisce perché Koda non risponde.

**Impatto**: bad UX critica — nel mondo reale (metropolitana, cantina,
montagna, aereo, roaming saltuario) è comune non avere rete. Ora Koda
"muore in silenzio" e l'utente pensa che l'app sia rotta.

**Comportamento atteso**: quando si tenta di attivare la registrazione
senza rete → messaggio in-personaggio breve tipo "Non ho segnale ora,
ci ritroviamo quando torni online" + toast informativo. NON un errore
tecnico. NON un blocco duro. Solo comunicazione onesta.

**File da toccare**: probabilmente il WebSocket handler in
`app/index.tsx` (il punto dove parte `openStreamingSession`).
Va aggiunto un check `NetInfo` prima dell'apertura del WS.

**Priorità**: P1 (blocca uso in condizioni reali, non è cosmetico).

---

## ISSUE B — "Gradino" tra frase v3 e chunk successivi flash 🔴 P1 qualità

**Sintomo**: dentro la stessa risposta di Koda, la prima frase (generata
con `eleven_v3` per max espressività) si sente diversa dai chunk
successivi (generati con `eleven_flash_v2_5` per velocità/costo). C'è
un "gradino" percepibile — cambio di timbro, prosodia, o micro-pausa
di transizione — che rompe l'illusione di una voce unica continua.

**Filosofia**: incompatibile con la direttiva "qualità massima, mai
compromessi". Se il costo di v3 è sostenibile, la vera soluzione è
usare v3 per TUTTO. Se non è sostenibile, serve trovare come rendere
la transizione impercettibile.

**Ipotesi tecniche da esplorare**:
1. Uniformare `voice_settings` (stability/style/similarity_boost/speed)
   tra le due chiamate — attualmente i preset per tono cambiano tra
   chunk (mismatch prosodico)
2. Passare `previous_text` al flash chunk successivo (continuità
   prosodica dal chunk v3) — richiede check se v3 lo emette
3. Cross-fade audio buffer lato client (100ms overlap) — tecnicamente
   complesso ma elimina qualunque micro-pausa
4. Cut-off intelligente: mai spezzare a metà frase, sempre a fine
   punteggiatura forte (`.`, `?`, `!`) — riduce percettibilità
5. **Radical**: usare solo v3 (elimina il problema alla radice, costo
   ~2x TTS ma dentro budget del piano Business con pochi utenti)

**Priorità**: P1 (direttiva "qualità sopra tutto" post-ricerca competitor).

---

## Note per l'agente

- Fabio è in fase "qualità sopra tutto" (post-ricerca competitor 2026-08-02).
- Ha già validato: NeonBorder + pre-warm audio iPhone → OTTIMO.
- Deve ancora testare: Xiaomi smartphone (gesture bar), Honor (voce),
  Google login dopo pausa 10min.
- Fase 1 pricing è in pausa (stato pulito).
- Il resto della roadmap qualità: #3 Cache audio apertura → #4 A/B test
  optimize_streaming_latency v3 → poi tornare a pricing.
