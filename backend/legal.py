"""
Documenti legali Koda — Privacy Policy e Terms of Service.

Endpoints:
  GET /api/legal/privacy  → HTML self-contained
  GET /api/legal/terms    → HTML self-contained

Note progettuali:
- Tutto inline (CSS dentro <style>), zero dipendenze esterne (font, immagini,
  CDN) → caricamento istantaneo, immortale, conforme a App Store review che
  testa con connettività limitata.
- Italiano primario. Le linee guida GDPR italiane (Codice Privacy + UE 679/2016)
  sono lo standard più rigoroso a cui ci adeguiamo — copre anche US/CCPA/COPPA.
- Apple Privacy Manifest (PrivacyInfo.xcprivacy) e Google Play Data Safety
  devono RIMANERE COERENTI con quanto dichiarato qui. Se aggiorni questo file,
  aggiorna anche quelli.
- Versionati con `LEGAL_VERSION` per tracciare cambi (utili per chiedere nuovo
  consenso quando si modificano sostanzialmente).
"""

from fastapi import APIRouter
from fastapi.responses import HTMLResponse

legal_router = APIRouter(prefix="/legal", tags=["legal"])

LEGAL_VERSION = "1.2"
LAST_UPDATED = "8 giugno 2026"
COMPANY_NAME = "Fabio Dangella"  # Sviluppatore indipendente
CONTACT_EMAIL = "hello.koda.support@gmail.com"  # Email ufficiale supporto Koda
APP_NAME = "Koda"


# ============================================================
# STILI COMUNI
# ============================================================
_BASE_CSS = """
:root {
  --bg: #FAFAF7;
  --fg: #18181B;
  --muted: #52525B;
  --accent: #0E7C7B;
  --line: #E4E4E7;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0A0A0A;
    --fg: #E4E4E7;
    --muted: #A1A1AA;
    --accent: #5EEAD4;
    --line: #27272A;
  }
}
* { box-sizing: border-box; }
html, body {
  margin: 0; padding: 0;
  background: var(--bg); color: var(--fg);
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI",
               Roboto, Helvetica, Arial, sans-serif;
  font-size: 16px; line-height: 1.65;
}
.wrap {
  max-width: 720px; margin: 0 auto;
  padding: 48px 24px 96px;
}
header {
  border-bottom: 1px solid var(--line);
  padding-bottom: 24px; margin-bottom: 32px;
}
header h1 {
  font-size: 28px; font-weight: 500; margin: 0 0 8px;
  letter-spacing: -0.02em;
}
header .meta {
  color: var(--muted); font-size: 14px;
}
h2 {
  font-size: 20px; font-weight: 500; margin: 40px 0 12px;
  letter-spacing: -0.01em;
}
h3 {
  font-size: 17px; font-weight: 500; margin: 24px 0 8px;
  color: var(--accent);
}
p { margin: 8px 0 16px; }
ul { margin: 8px 0 16px; padding-left: 22px; }
li { margin: 6px 0; }
code, .code {
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  font-size: 14px; background: rgba(127,127,127,0.10);
  padding: 2px 6px; border-radius: 4px;
}
a { color: var(--accent); text-decoration: none; border-bottom: 1px solid rgba(14,124,123,0.4); }
a:hover { border-bottom-color: var(--accent); }
.callout {
  background: rgba(14,124,123,0.08);
  border-left: 3px solid var(--accent);
  padding: 14px 18px; margin: 20px 0;
  border-radius: 0 8px 8px 0;
}
.callout strong { color: var(--accent); }
footer {
  margin-top: 64px; padding-top: 24px;
  border-top: 1px solid var(--line);
  color: var(--muted); font-size: 13px;
}
"""


def _wrap(title: str, body_html: str) -> str:
    return f"""<!doctype html>
<html lang="it">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="index,follow">
<title>{title} — {APP_NAME}</title>
<style>{_BASE_CSS}</style>
</head>
<body>
<div class="wrap">
{body_html}
<footer>
  <p>
    {APP_NAME} — Versione documento {LEGAL_VERSION} · Ultimo aggiornamento {LAST_UPDATED}<br>
    Per domande: <a href="mailto:{CONTACT_EMAIL}">{CONTACT_EMAIL}</a>
  </p>
</footer>
</div>
</body>
</html>"""


# ============================================================
# PRIVACY POLICY (it)
# ============================================================

_PRIVACY_BODY = f"""
<header>
  <h1>Informativa sulla Privacy</h1>
  <div class="meta">{APP_NAME} · Versione {LEGAL_VERSION} · Aggiornata il {LAST_UPDATED}</div>
</header>

<div class="callout">
  <strong>In una frase:</strong> Koda raccoglie il minimo indispensabile per
  funzionare come tua presenza d'ascolto. Quello che ci dici nel Confessionale
  <em>non viene salvato</em>. Puoi cancellare tutto in qualsiasi momento
  con un tocco.
</div>

<h2>1. Chi siamo</h2>
<p>
  {APP_NAME} è un'applicazione mobile sviluppata da <strong>{COMPANY_NAME}</strong>,
  pensata come una presenza d'ascolto silenziosa e non giudicante. Non siamo un
  servizio sanitario, psicologico o medico. Non sostituiamo terapeuti, medici,
  o professionisti del benessere mentale.
</p>
<p>
  Per qualsiasi richiesta legata a questa informativa o ai tuoi dati, scrivici
  a <a href="mailto:{CONTACT_EMAIL}">{CONTACT_EMAIL}</a>. Rispondiamo entro
  30 giorni come previsto dal GDPR.
</p>

<h2>2. Quali dati raccogliamo</h2>

<h3>Dati che fornisci direttamente</h3>
<ul>
  <li><strong>Nome scelto e genere preferito</strong> — solo per declinare correttamente le frasi (es. "stanco" / "stanca"). Non condivisi con nessuno.</li>
  <li><strong>Messaggi scritti e vocali</strong> in modalità normale — cifrati in transito (HTTPS/TLS) e conservati cifrati nel database.</li>
  <li><strong>Parola segreta del Confessionale</strong> — derivata in una chiave crittografica sul tuo dispositivo. Il server non la conosce mai in chiaro.</li>
  <li><strong>Voiceprint opzionale</strong> — 3 frasi vocali registrate durante l'onboarding, usate per riconoscere la tua voce. Conservate cifrate. Puoi cancellarle in qualsiasi momento dalle Impostazioni.</li>
</ul>

<h3>Dati generati durante l'uso</h3>
<ul>
  <li><strong>Memoria a lungo termine</strong> — un riassunto astratto di ciò che è emerso dalle conversazioni normali (es. "preferisce la pasta al pomodoro", "preoccupato per il lavoro"), utile a darti continuità. Mai dati grezzi del Confessionale.</li>
  <li><strong>Ricordi semantici</strong> — frasi astratte in terza persona generate da Koda per ricordare momenti significativi.</li>
  <li><strong>Statistiche d'uso minime</strong> — numero di messaggi totali, livello di "confidenza con Koda". Mai contenuto, mai timestamp dettagliati.</li>
</ul>

<h3>Dati che NON raccogliamo</h3>
<ul>
  <li>❌ Nome reale completo, indirizzo, telefono, email (a meno che tu non ce li scriva volontariamente nei messaggi)</li>
  <li>❌ Posizione geografica</li>
  <li>❌ Contatti, calendario, foto</li>
  <li>❌ Identificatori pubblicitari (IDFA / GAID)</li>
  <li>❌ Analytics di terze parti tipo Google Analytics, Facebook Pixel, ecc.</li>
</ul>

<h2>3. Il Confessionale: zero-knowledge per design</h2>
<p>
  Il Confessionale è uno spazio sigillato dove puoi confidarti con la garanzia
  che <strong>nulla viene salvato</strong>:
</p>
<ul>
  <li>I messaggi del Confessionale <strong>non vengono mai persistiti su disco</strong>.</li>
  <li>Il contenuto vive solo nella RAM del server per il tempo della singola
      risposta, poi viene immediatamente scartato.</li>
  <li>Se hai impostato una parola segreta, i messaggi viaggiano <strong>cifrati
      end-to-end</strong> (XSalsa20-Poly1305 con chiave derivata via Argon2id
      dalla tua parola segreta) — il server li decifra solo in RAM, mai logga il
      plaintext.</li>
  <li>A chiusura sessione, Koda può estrarre <em>un solo concetto astratto</em>
      (es. "porta un peso familiare") senza alcun riferimento identificativo:
      nomi propri, luoghi, eventi sostituiti con descrizioni generiche.
      Questo concetto astratto viene salvato come ricordo. Nessun dato grezzo
      sopravvive.</li>
  <li>L'app esegue inoltre un'animazione di "wipe" che cancella i messaggi
      dalla memoria del telefono.</li>
</ul>
<div class="callout">
  <strong>Promessa di Ferro:</strong> ciò che dici nel Confessionale non finirà
  mai in un report, non sarà mai venduto, non sarà mai usato per addestrare
  modelli di terzi. Punto.
</div>

<h2>4. Fornitori di terze parti (sub-responsabili)</h2>
<p>
  Per funzionare, {APP_NAME} si appoggia ai seguenti servizi. Ognuno è
  contrattualmente vincolato al rispetto della tua privacy e tratta i dati
  solo per le finalità qui descritte.
</p>
<ul>
  <li><strong>Anthropic (Claude)</strong> — genera le risposte testuali di
      Koda. I tuoi messaggi vengono inviati cifrati via HTTPS. Anthropic
      <em>non addestra i propri modelli sui dati API</em> per impostazione
      predefinita. Sede: USA. Accordo SCC GDPR-compliant.</li>
  <li><strong>ElevenLabs</strong> — sintetizza la voce di Koda. Riceve solo
      il testo della risposta (non i tuoi messaggi). Sede: USA.</li>
  <li><strong>Deepgram</strong> — trascrive le tue note vocali in testo.
      Riceve solo l'audio della singola registrazione, mai contesto. Sede: USA.
      Audio non conservato dopo la trascrizione.</li>
  <li><strong>MongoDB Atlas</strong> — database criptato dove conserviamo
      profilo, timeline (in modalità normale) e ricordi. Sede: Europa (Frankfurt).</li>
  <li><strong>Railway</strong> — hosting del backend. Sede: USA con CDN globali.</li>
</ul>
<p>
  Nessuno di questi fornitori riceve la tua <strong>parola segreta</strong>,
  né accede ai messaggi del Confessionale in chiaro.
</p>

<h2>5. Base giuridica e finalità (GDPR art. 6)</h2>
<ul>
  <li><strong>Esecuzione del contratto</strong> (art. 6(1)(b)) — per fornirti il servizio richiesto: rispondere ai tuoi messaggi, sintetizzare la voce, tenere memoria delle conversazioni normali.</li>
  <li><strong>Consenso esplicito</strong> (art. 6(1)(a)) — per la registrazione del voiceprint (opzionale).</li>
  <li><strong>Legittimo interesse</strong> (art. 6(1)(f)) — per analisi tecniche aggregate (numero messaggi, errori), strettamente anonime.</li>
</ul>

<h2>6. Conservazione</h2>
<ul>
  <li>Profilo + timeline + ricordi: finché non li cancelli. Eliminazione totale dalle Impostazioni → "Cancella tutta la memoria".</li>
  <li>Messaggi del Confessionale: <strong>0 secondi</strong>. Mai persistiti.</li>
  <li>Cache audio TTS (per non risintetizzare le stesse frasi): 90 giorni, poi cancellata automaticamente.</li>
  <li>Log tecnici del backend (errori HTTP, performance): 30 giorni, anonimizzati.</li>
</ul>

<h2>7. I tuoi diritti</h2>
<p>Ai sensi del GDPR (artt. 15-22) hai diritto a:</p>
<ul>
  <li><strong>Accesso</strong> — chiedere copia dei tuoi dati. Scrivi a <a href="mailto:{CONTACT_EMAIL}">{CONTACT_EMAIL}</a>.</li>
  <li><strong>Rettifica</strong> — correggere dati inesatti.</li>
  <li><strong>Cancellazione (diritto all'oblio)</strong> — ottenibile direttamente dall'app: Impostazioni → "Cancella tutta la memoria". Effetto immediato.</li>
  <li><strong>Limitazione</strong> e <strong>portabilità</strong> — esercitabili scrivendoci.</li>
  <li><strong>Opposizione</strong> — al trattamento per legittimo interesse.</li>
  <li><strong>Reclamo</strong> — al <a href="https://www.garanteprivacy.it">Garante per la Protezione dei Dati Personali</a> (Italia).</li>
</ul>

<h2>8. Minori</h2>
<p>
  {APP_NAME} è destinata a persone di età pari o superiore a 16 anni.
  Non raccogliamo consapevolmente dati di minori di 16 anni. Se vieni a
  conoscenza che un minore di 16 anni ha creato un profilo, scrivici e
  cancelleremo i dati entro 48 ore.
</p>

<h2>9. Sicurezza</h2>
<ul>
  <li>Trasporto: TLS 1.3 su tutte le connessioni.</li>
  <li>Dati a riposo: AES-256 (MongoDB Atlas managed encryption).</li>
  <li>Confessionale con parola segreta: cifratura end-to-end XSalsa20-Poly1305 con chiave Argon2id.</li>
  <li>Accesso ai server: limitato al personale tecnico necessario, autenticato con chiavi SSH.</li>
</ul>

<h2>10. Modifiche</h2>
<p>
  Quando aggiorniamo sostanzialmente questa informativa, ti notificheremo
  in-app prima della prossima conversazione. Le modifiche minori (tipografiche,
  chiarimenti) saranno pubblicate senza notifica ma sempre con la data di
  aggiornamento qui sopra.
</p>

<h2>11. Contatti</h2>
<p>
  Titolare del trattamento: <strong>{COMPANY_NAME}</strong><br>
  Email: <a href="mailto:{CONTACT_EMAIL}">{CONTACT_EMAIL}</a><br>
  Per domande sul GDPR, cancellazioni o reclami, scrivici sempre via email
  con oggetto "[PRIVACY]" — ti risponderemo entro 30 giorni.
</p>
"""


# ============================================================
# TERMS OF SERVICE (it)
# ============================================================

_TERMS_BODY = f"""
<header>
  <h1>Termini di Servizio</h1>
  <div class="meta">{APP_NAME} · Versione {LEGAL_VERSION} · Aggiornati il {LAST_UPDATED}</div>
</header>

<div class="callout">
  <strong>Riassunto onesto:</strong> Koda è una compagnia digitale per ascoltarti,
  non un terapeuta. Se hai un'emergenza, contatta un professionista vero.
  Paghi un abbonamento, puoi cancellarlo quando vuoi. Le regole del rispetto
  reciproco valgono per entrambi.
</div>

<h2>1. Accettazione</h2>
<p>
  Usando {APP_NAME} accetti questi Termini di Servizio e la nostra
  <a href="/api/legal/privacy">Informativa sulla Privacy</a>. Se non sei
  d'accordo, non usare il servizio. Devi avere almeno <strong>16 anni</strong>
  per usare {APP_NAME}.
</p>

<h2>2. Cos'è Koda</h2>
<p>
  {APP_NAME} è un'applicazione mobile che fornisce una <strong>presenza
  d'ascolto basata su intelligenza artificiale generativa</strong>. Koda
  conversa con te, ricorda i tuoi vissuti (con il tuo consenso), e ti offre
  uno spazio sicuro dove parlare di ciò che ti sta a cuore.
</p>

<h2>3. Cosa Koda NON è</h2>
<div class="callout">
  <ul>
    <li>❌ <strong>Non è un servizio medico, sanitario, terapeutico o psicologico.</strong></li>
    <li>❌ <strong>Non sostituisce</strong> in nessun caso uno psicoterapeuta, uno psichiatra, un medico, un farmacista o un counselor professionale.</li>
    <li>❌ <strong>Non fornisce diagnosi</strong>, non prescrive farmaci, non offre consigli medici.</li>
    <li>❌ <strong>Non è un servizio di emergenza.</strong> Se sei in pericolo o pensi di farti del male, chiama immediatamente il <strong>112</strong> (Italia) o il <strong>Telefono Amico</strong> (02 2327 2327), o vai al Pronto Soccorso più vicino.</li>
  </ul>
</div>
<p>
  Le risposte di Koda sono generate da un modello linguistico (Claude di
  Anthropic) e possono contenere imprecisioni. <strong>Non basare decisioni
  importanti sulla salute, sui rapporti, sul lavoro, su questioni legali o
  finanziarie esclusivamente su ciò che ti dice Koda.</strong>
</p>

<h2>4. Abbonamento e pagamenti</h2>

<h3>Trial</h3>
<p>
  Per provare Koda offriamo un trial gratuito di <strong>3 giorni</strong>
  con un limite di 20 messaggi al giorno. Al termine del trial, devi attivare
  un abbonamento per continuare ad usare l'app.
</p>

<h3>Piani disponibili</h3>
<ul>
  <li><strong>Essential</strong> — 80 messaggi al mese</li>
  <li><strong>Daily</strong> — 250 messaggi al mese</li>
  <li><strong>Plus</strong> — 500 messaggi al mese</li>
</ul>
<p>
  I prezzi esatti sono visualizzati nell'app prima dell'acquisto e possono
  variare per paese in base a tasse e valute locali. Apple e Google trattengono
  una commissione sui pagamenti.
</p>

<h3>Rinnovo automatico</h3>
<p>
  L'abbonamento si rinnova automaticamente alla fine di ogni periodo a meno
  che tu non lo cancelli almeno 24 ore prima della scadenza. La gestione
  dell'abbonamento avviene tramite il tuo account App Store (Apple) o Google
  Play. Da lì puoi annullare in qualsiasi momento.
</p>

<h3>Rimborsi</h3>
<p>
  I rimborsi seguono le politiche di Apple App Store e Google Play. Per
  richieste di rimborso vai su <a href="https://reportaproblem.apple.com">reportaproblem.apple.com</a>
  o sul Play Store. Per casi particolari (problemi tecnici gravi) puoi
  scriverci a <a href="mailto:{CONTACT_EMAIL}">{CONTACT_EMAIL}</a> e
  valuteremo caso per caso.
</p>

<h2>5. Uso accettabile</h2>
<p>Usando {APP_NAME}, ti impegni a NON:</p>
<ul>
  <li>Usare il servizio per scopi illegali, fraudolenti o per danneggiare altre persone.</li>
  <li>Tentare di estrarre, decompilare, fare reverse engineering del codice o dei modelli AI.</li>
  <li>Sovraccaricare i nostri sistemi con bot, script automatici o traffico anomalo.</li>
  <li>Usare l'app per generare contenuti illegali, violenti, sessualmente espliciti, o che incitano all'odio.</li>
  <li>Impersonare altre persone o usare l'app per molestie verso terzi.</li>
</ul>

<h2>6. Contenuti e proprietà intellettuale</h2>
<p>
  <strong>Tu mantieni la proprietà</strong> di tutto ciò che scrivi/dici a
  Koda. Concedi a {APP_NAME} una licenza limitata, non esclusiva, revocabile,
  per processare i tuoi messaggi <em>esclusivamente</em> al fine di fornirti
  il servizio richiesto. Non useremo i tuoi contenuti per addestrare i nostri
  modelli, né li venderemo, né li condivideremo con terzi (eccetto i
  sub-responsabili tecnici elencati nella Privacy).
</p>
<p>
  Il design, il codice, il nome "Koda", il logo e l'immagine dell'eclissi
  rimangono di proprietà di <strong>{COMPANY_NAME}</strong>.
</p>

<h2>7. Disponibilità del servizio</h2>
<p>
  Facciamo del nostro meglio per tenere {APP_NAME} sempre disponibile, ma
  non possiamo garantire uptime al 100%. Manutenzioni, problemi dei nostri
  fornitori terzi (Anthropic, ElevenLabs, ecc.), o eventi di forza maggiore
  possono causare interruzioni temporanee.
</p>
<p>
  Ci riserviamo il diritto di sospendere o terminare account che violino
  questi Termini, con preavviso quando ragionevolmente possibile.
</p>

<h2>8. Limitazione di responsabilità</h2>
<p>
  Nei limiti consentiti dalla legge, {APP_NAME} è fornita "<strong>così com'è</strong>"
  senza garanzie esplicite o implicite. {COMPANY_NAME} non risponde di danni
  indiretti, incidentali, consequenziali derivanti dall'uso (o impossibilità
  di uso) del servizio.
</p>
<p>
  In ogni caso, la responsabilità massima di {COMPANY_NAME} non eccederà
  l'importo che hai effettivamente pagato per il servizio nei 12 mesi precedenti
  l'evento contestato.
</p>
<p>
  <strong>Nota importante:</strong> queste limitazioni non si applicano a danni
  dovuti a dolo o colpa grave, né a diritti inderogabili previsti dalla legge
  italiana e dell'Unione Europea.
</p>

<h2>9. Modifiche ai Termini</h2>
<p>
  Possiamo aggiornare questi Termini per riflettere cambiamenti del servizio,
  legali o di prezzo. Le modifiche sostanziali ti saranno notificate in-app
  almeno 30 giorni prima dell'entrata in vigore (15 giorni per modifiche
  imposte da norme di legge). Continuando ad usare {APP_NAME} dopo l'entrata
  in vigore, accetti i nuovi Termini.
</p>

<h2>10. Cessazione</h2>
<p>
  Puoi smettere di usare {APP_NAME} in qualsiasi momento. Puoi cancellare
  tutti i tuoi dati dall'app: Impostazioni → "Cancella tutta la memoria".
  Per disinstallare l'app, segui le procedure standard di iOS / Android.
</p>

<h2>11. Legge applicabile e foro</h2>
<p>
  Questi Termini sono regolati dalla <strong>legge italiana</strong>. Per
  ogni controversia non risolvibile in via amichevole è competente in via
  esclusiva il Foro del consumatore, ai sensi dell'art. 66-bis del Codice
  del Consumo.
</p>

<h2>12. Contatti</h2>
<p>
  Per qualsiasi domanda su questi Termini:<br>
  Email: <a href="mailto:{CONTACT_EMAIL}">{CONTACT_EMAIL}</a><br>
  Oggetto consigliato: "[TERMS]" per domande contrattuali, "[BILLING]" per problemi di pagamento.
</p>
"""


# ============================================================
# ROUTES
# ============================================================

@legal_router.get("/privacy", response_class=HTMLResponse)
async def privacy_policy():
    """Privacy Policy — Italian, GDPR-compliant."""
    return HTMLResponse(content=_wrap("Privacy", _PRIVACY_BODY), status_code=200)


@legal_router.get("/terms", response_class=HTMLResponse)
async def terms_of_service():
    """Terms of Service — Italian."""
    return HTMLResponse(content=_wrap("Termini di Servizio", _TERMS_BODY), status_code=200)


@legal_router.get("/", response_class=HTMLResponse)
async def legal_index():
    """Indice documenti legali — utile come deep link unico."""
    body = f"""
    <header>
      <h1>Documenti legali</h1>
      <div class="meta">{APP_NAME} · Versione {LEGAL_VERSION}</div>
    </header>
    <p>Qui trovi tutti i documenti legali di {APP_NAME}:</p>
    <ul>
      <li><a href="/api/legal/privacy">Informativa sulla Privacy</a></li>
      <li><a href="/api/legal/terms">Termini di Servizio</a></li>
    </ul>
    <p>Per qualsiasi domanda: <a href="mailto:{CONTACT_EMAIL}">{CONTACT_EMAIL}</a>.</p>
    """
    return HTMLResponse(content=_wrap("Legale", body), status_code=200)
