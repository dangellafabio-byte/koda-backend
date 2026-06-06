"""
Koda Legal Documents — Privacy Policy + Terms of Service.

HTML statici serviti su /api/legal/privacy e /api/legal/terms.
Da raffinare con un legale prima di pubblicazione su App Store/Play.

TEMPLATE INIZIALE — Non sostituisce consulenza legale.
Basato su GDPR + Apple App Store + Google Play guidelines.
"""

from datetime import date
from fastapi import APIRouter
from fastapi.responses import HTMLResponse

EFFECTIVE_DATE = "5 giugno 2026"
COMPANY_NAME = "Fabio D'Angella"  # Aggiornare con denominazione legale corretta
CONTACT_EMAIL = "dangella.fabio@gmail.com"
APP_NAME = "Koda — Il tuo spazio di ascolto"


_BASE_CSS = """
<style>
  :root { color-scheme: light dark; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    max-width: 720px; margin: 0 auto; padding: 32px 20px 80px;
    line-height: 1.65; color: #1A1A1A; background: #F4F4F2;
  }
  @media (prefers-color-scheme: dark) {
    body { color: #E8E8E8; background: #1A1A1A; }
    a { color: #7FD0CF; }
    h1, h2, h3 { color: #FFFFFF; }
    .updated { color: #B8B8B8; }
    hr { border-color: #333; }
  }
  h1 { font-size: 28px; margin-bottom: 4px; font-weight: 600; }
  h2 { font-size: 19px; margin-top: 32px; font-weight: 600; }
  h3 { font-size: 16px; margin-top: 20px; font-weight: 600; }
  .updated { font-size: 13px; color: #6B7280; margin-bottom: 24px; }
  ul { padding-left: 22px; }
  li { margin-bottom: 6px; }
  a { color: #0E7C7B; }
  hr { border: 0; border-top: 1px solid #E5E5E5; margin: 32px 0; }
  .footer { font-size: 13px; color: #6B7280; margin-top: 40px; text-align: center; }
  code { background: rgba(0,0,0,0.06); padding: 2px 6px; border-radius: 4px; font-size: 90%; }
</style>
"""


def _wrap(title: str, body: str) -> str:
    return f"""<!doctype html>
<html lang="it">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title} — {APP_NAME}</title>
{_BASE_CSS}
</head>
<body>
{body}
<div class="footer">© {date.today().year} {COMPANY_NAME} — Tutti i diritti riservati.</div>
</body>
</html>"""


PRIVACY_HTML = _wrap("Privacy Policy", f"""
<h1>Privacy Policy</h1>
<p class="updated">Ultimo aggiornamento: {EFFECTIVE_DATE}</p>

<p>La presente Privacy Policy descrive come {COMPANY_NAME} ("noi", "nostro")
raccoglie, utilizza e protegge i dati degli utenti dell'applicazione
<strong>{APP_NAME}</strong> (l'"App").</p>

<h2>1. Titolare del trattamento</h2>
<p>{COMPANY_NAME}<br>Email contatto: <a href="mailto:{CONTACT_EMAIL}">{CONTACT_EMAIL}</a></p>

<h2>2. Dati raccolti</h2>
<p>Koda è progettato per minimizzare la raccolta dati. Raccogliamo solo:</p>
<ul>
  <li><strong>Identificativo dispositivo (UUID)</strong>: un codice univoco generato localmente sul tuo dispositivo, conservato in modo sicuro tramite SecureStore. Non è collegato alla tua identità reale.</li>
  <li><strong>Cronologia conversazioni</strong>: testo dei messaggi scambiati con Koda, salvato sui nostri server per garantire la continuità della relazione tra te e l'AI.</li>
  <li><strong>Audio temporaneo</strong>: la tua voce viene inviata ai servizi di trascrizione (Deepgram) e sintesi vocale (ElevenLabs); l'audio NON viene memorizzato permanentemente.</li>
  <li><strong>Preferenze app</strong>: tema, voce AI, lingua e impostazioni personali.</li>
  <li><strong>Stato sottoscrizione</strong>: piano attivo, data scadenza, contatori di utilizzo (gestito tramite RevenueCat).</li>
</ul>

<h3>Modalità Confessionale (Fortezza)</h3>
<p>I messaggi inviati in modalità Confessionale sono <strong>effimeri</strong>:
processati esclusivamente in memoria (RAM) sui nostri server, non vengono mai
scritti su database. Allo stesso modo, il client cancella la RAM all'uscita.
Questo è il nostro principio di "Doppia Stanza" (zero-knowledge).</p>

<h2>3. Finalità del trattamento</h2>
<ul>
  <li>Fornire le funzionalità dell'App (conversazione AI, memoria contestuale, voce)</li>
  <li>Gestire la sottoscrizione e il trial gratuito</li>
  <li>Migliorare la qualità del servizio</li>
  <li>Adempiere a obblighi di legge</li>
</ul>

<h2>4. Base giuridica</h2>
<p>Il trattamento si basa sul tuo consenso (art. 6.1.a GDPR) e
sull'esecuzione del contratto di servizio (art. 6.1.b GDPR).</p>

<h2>5. Servizi terzi utilizzati</h2>
<ul>
  <li><strong>Anthropic Claude</strong> — Generazione risposte AI</li>
  <li><strong>Deepgram</strong> — Trascrizione audio (Speech-to-Text)</li>
  <li><strong>ElevenLabs</strong> — Sintesi vocale (Text-to-Speech)</li>
  <li><strong>MongoDB Atlas</strong> — Storage cronologia conversazioni</li>
  <li><strong>RevenueCat</strong> — Gestione abbonamenti in-app</li>
  <li><strong>Apple App Store / Google Play</strong> — Distribuzione e pagamenti</li>
</ul>
<p>I dati condivisi con questi fornitori sono strettamente limitati a quanto necessario
per l'erogazione del servizio. Tutti aderiscono a standard internazionali di sicurezza.</p>

<h2>6. Conservazione dei dati</h2>
<p>I dati delle conversazioni standard sono conservati finché mantieni l'App installata
o finché non eserciti il diritto di cancellazione. I messaggi del Confessionale NON sono
mai conservati.</p>

<h2>7. I tuoi diritti (GDPR)</h2>
<p>Hai diritto a:</p>
<ul>
  <li>Accedere ai tuoi dati</li>
  <li>Rettificare i tuoi dati</li>
  <li>Cancellare i tuoi dati ("diritto all'oblio") — la cancellazione completa è disponibile dalle impostazioni dell'App</li>
  <li>Portabilità dei dati</li>
  <li>Opporti al trattamento</li>
  <li>Revocare il consenso in qualsiasi momento</li>
</ul>
<p>Per esercitare i tuoi diritti, contattaci a
<a href="mailto:{CONTACT_EMAIL}">{CONTACT_EMAIL}</a>.</p>

<h2>8. Sicurezza</h2>
<p>Adottiamo misure tecniche e organizzative adeguate per proteggere i tuoi dati,
incluse cifratura in transito (TLS), salvataggio sicuro dell'identificativo
dispositivo tramite SecureStore (iOS Keychain / Android Keystore) e accesso
ristretto ai nostri server.</p>

<h2>9. Minori</h2>
<p>{APP_NAME} non è destinato a minori di 13 anni. Se sei un genitore o tutore e
ritieni che tuo figlio ci abbia fornito informazioni, contattaci per la rimozione.</p>

<h2>10. Modifiche</h2>
<p>Possiamo aggiornare questa Privacy Policy periodicamente. Le modifiche entrano
in vigore alla pubblicazione su questa pagina.</p>

<h2>11. Contatti</h2>
<p>Per qualsiasi domanda: <a href="mailto:{CONTACT_EMAIL}">{CONTACT_EMAIL}</a></p>
""")


TERMS_HTML = _wrap("Termini di Servizio", f"""
<h1>Termini di Servizio</h1>
<p class="updated">Ultimo aggiornamento: {EFFECTIVE_DATE}</p>

<p>I presenti Termini regolano l'utilizzo dell'applicazione
<strong>{APP_NAME}</strong> (l'"App") fornita da {COMPANY_NAME}.</p>

<h2>1. Accettazione</h2>
<p>Utilizzando l'App accetti integralmente i presenti Termini. Se non sei d'accordo,
non utilizzare l'App.</p>

<h2>2. Descrizione del servizio</h2>
<p>{APP_NAME} è un'app di compagnia AI conversazionale, uno spazio di ascolto personale, progettata
per il benessere emotivo e la crescita personale. Include funzionalità di
conversazione vocale, modalità Confessionale a privacy aumentata, e personalizzazione
dell'esperienza.</p>

<h2>3. Sottoscrizione e prova gratuita</h2>
<p>L'accesso completo all'App richiede una sottoscrizione attiva. Offriamo:</p>
<ul>
  <li><strong>Prova gratuita di 3 giorni</strong> con un limite di 20 messaggi al giorno.</li>
  <li><strong>Piano Essential</strong>: 80 messaggi/mese — €4,99/mese</li>
  <li><strong>Piano Daily</strong>: 250 messaggi/mese — €9,99/mese</li>
  <li><strong>Piano Plus</strong>: 500 messaggi/mese — €19,99/mese</li>
</ul>
<p>Il pagamento viene gestito da Apple App Store o Google Play. Le sottoscrizioni si
rinnovano automaticamente al termine di ciascun periodo finché non vengono annullate
almeno 24 ore prima della fine del periodo corrente. L'annullamento può essere
effettuato dalle impostazioni del tuo account App Store / Play Store.</p>
<p>La prova gratuita può essere usata una sola volta per utente.</p>

<h2>4. Limiti di utilizzo</h2>
<p>I limiti mensili di messaggi sono per ciclo di fatturazione e non sono cumulabili.
Eventuali messaggi non utilizzati non vengono trasferiti al ciclo successivo.</p>

<h2>5. Uso appropriato</h2>
<p>Ti impegni a NON utilizzare l'App per:</p>
<ul>
  <li>Attività illegali o che incitino all'odio</li>
  <li>Pianificazione o coordinamento di violenza, atti illegali o autolesionismo</li>
  <li>Tentativi di compromettere la sicurezza del servizio</li>
  <li>Estrazione massiva o reverse engineering del modello AI</li>
</ul>

<h2>6. Disclaimer su contenuti AI</h2>
<p>{APP_NAME} utilizza intelligenza artificiale per generare risposte. <strong>Koda non
è un sostituto di assistenza medica, psicologica o legale professionale.</strong>
Se ti trovi in situazione di crisi o pericolo immediato, contatta i servizi di
emergenza locali o uno specialista qualificato.</p>
<p>Le risposte dell'AI sono prodotte automaticamente e possono contenere imprecisioni.
Non offriamo alcuna garanzia sulla loro accuratezza o appropriatezza.</p>

<h2>7. Proprietà intellettuale</h2>
<p>L'App, il marchio, il design e tutti i contenuti originali sono di proprietà
di {COMPANY_NAME}. Le conversazioni che generi rimangono tue: garantisci a noi
una licenza limitata, non esclusiva, gratuita di utilizzarle al solo scopo di
fornirti il servizio.</p>

<h2>8. Privacy</h2>
<p>Il trattamento dei tuoi dati è regolato dalla nostra
<a href="/api/legal/privacy">Privacy Policy</a>, parte integrante dei presenti Termini.</p>

<h2>9. Modifiche al servizio</h2>
<p>Ci riserviamo il diritto di modificare, sospendere o interrompere parti del
servizio in qualsiasi momento. In caso di modifiche sostanziali che impattino
sottoscrizioni attive, ti informeremo con ragionevole anticipo.</p>

<h2>10. Limitazione di responsabilità</h2>
<p>L'App è fornita "così com'è". Nei limiti consentiti dalla legge, escludiamo
qualsiasi garanzia implicita e limitiamo la nostra responsabilità per danni
indiretti o consequenziali derivanti dall'uso dell'App.</p>

<h2>11. Recesso e rimborsi</h2>
<p>Puoi annullare la sottoscrizione in qualsiasi momento attraverso il tuo account
App Store o Play Store. I rimborsi sono soggetti alle policy di Apple / Google;
ti invitiamo a contattare direttamente lo store per richieste di rimborso.</p>

<h2>12. Legge applicabile</h2>
<p>I presenti Termini sono regolati dalla legge italiana. Foro competente
esclusivo: il foro del consumatore, ove applicabile.</p>

<h2>13. Contatti</h2>
<p>Per qualsiasi domanda: <a href="mailto:{CONTACT_EMAIL}">{CONTACT_EMAIL}</a></p>
""")


def create_legal_router() -> APIRouter:
    router = APIRouter(prefix="/api/legal", tags=["legal"])

    @router.get("/privacy", response_class=HTMLResponse)
    async def get_privacy():
        return HTMLResponse(content=PRIVACY_HTML, status_code=200)

    @router.get("/terms", response_class=HTMLResponse)
    async def get_terms():
        return HTMLResponse(content=TERMS_HTML, status_code=200)

    return router
