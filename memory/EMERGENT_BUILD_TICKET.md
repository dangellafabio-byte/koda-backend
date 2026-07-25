# EMAIL PRONTA DA MANDARE A support@emergent.sh

**Quando usare questa email**: SOLO se dopo aver fatto
1. Publish → Redeploy (attendere "Deployed with success")
2. Build Android → Genera nuova build

la pipeline continua a mostrare v1.0.37 come ultima versione (o
comunque una versione precedente a v1.0.114) senza generare un
nuovo APK.

Se dopo la sequenza esce v1.0.114 (o qualsiasi numero > 37) e canary
"build-v63.9-audio-and-breath-diag" → NON serve mandare niente,
la pipeline ha funzionato.

---

## OGGETTO EMAIL

```
Build Android non incrementa versione dopo Redeploy — progetto Koda (app-finder-408)
```

## CORPO EMAIL

```
Salve,

sono Fabio D'Angella (dangella.fabio@gmail.com), utente Emergent
sul progetto "Koda" (URL project: app-finder-408).

Da questa mattina la pipeline "Build Android" non genera nuove
versioni APK nonostante:

1. Ho fatto Publish → Redeploy correttamente (conferma "Deployed
   with success")
2. Ho cliccato "Genera nuova build" nella sezione Build Android
3. Ho ripetuto la sequenza più volte

La lista mostra come "ultima versione" v1.0.37 (compilata il 25/07
alle 9:08 AM italiano) e non appare mai una v1.0.38 o successiva
dopo il click su "Genera nuova build".

Ho anche fatto un bump esplicito in app.json della versione:
- version: 1.0.113 → 1.0.114
- buildNumber: 7 → 8
- versionCode: 7 → 8

Il canary in-app (visibile nel footer di Impostazioni) conferma che
l'APK v1.0.37 contiene una versione vecchia del codice
("build-v63.7-xiaomi-fix") mentre il codice più recente committato
è "build-v63.9-audio-and-breath-diag" — sono passati diversi fix
di audio session che non riesco a testare finché la Build non
rigenera.

Commit più recenti nel pod (verificati da agente):
- fbe27b31  chore(release): bump 1.0.113→1.0.114, versionCode 7→8
- e457fcae  v63.9 — Fix C2 (pre-STT AudioFocus) + test diag breath
- baa1867e  auto-commit
- b109a913  v63.8 — TTS AudioFocus cycle dopo STT stop (Fix C1)

Non ho un remote git configurato per il frontend (solo koda-backend
verso GitHub). La build sta usando lo snapshot del pod, e forse
lo snapshot non si sta aggiornando anche dopo Redeploy.

Vi chiedo:
1. Verificare perché la pipeline non produce un nuovo APK dopo
   Redeploy + Build
2. Se possibile forzare la generazione di un APK v1.0.114 dallo
   snapshot corrente
3. Confermarmi come devo procedere in futuro per evitare che la
   pipeline si blocchi in questo stato

Sto lavorando con un agente su fix critici audio per Xiaomi/Honor
e ogni ora persa qui è un problema serio. Vi ringrazio in anticipo
per una risposta rapida.

Cordiali saluti,
Fabio D'Angella
dangella.fabio@gmail.com
```

---

## COSA ALLEGARE ALL'EMAIL

1. **Screenshot** che hai già fatto della pagina "Build Android"
   che mostra la lista di versioni ferma a v1.0.37
2. **Screenshot** del canary in Impostazioni che mostra
   "build-v63.7-xiaomi-fix" (l'ultimo che hai mandato)
3. **Job ID** dell'ultimo "Genera nuova build" che hai cliccato — lo
   trovi nella pagina Build Android, di solito accanto al bottone
   o nei dettagli della versione (potrebbe essere una stringa come
   "d9i61nd" che ho visto in uno degli screenshot precedenti)

---

## SE VUOI ESSERE PIÙ DURO CON IL SUPPORTO

Aggiungi in fondo al corpo email:

```
Questo è il 3° ticket che apro con problemi Emergent nel giro
di poche settimane e ho perso ore di sviluppo su questioni di
infrastruttura. Se non ricevo una soluzione operativa (non
"riprova, controlla connessione" ecc.) entro 24h, valuto rimborso
crediti e/o migrazione ad altro provider di build.
```

Questo è opzionale. Ma se sei stufo, mettilo — a volte serve a
farti prendere sul serio dal primo livello di supporto.
