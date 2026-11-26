"""Construct outbound queries from a fixed public vocabulary."""

import re
import unicodedata

_CITIES = {
    city.casefold(): city for city in (
        "Ancona", "Aosta", "Bari", "Bologna", "Bolzano", "Cagliari",
        "Campobasso", "Catanzaro", "Chiusi", "Firenze", "Genova", "L'Aquila",
        "Milano", "Montepulciano", "Napoli", "Palermo", "Perugia", "Pescara",
        "Potenza", "Reggio Calabria", "Roma", "Torino", "Trento", "Trieste",
        "Venezia", "Verona",
    )
}
_TOPICS = {
    "notizie": "notizie di oggi",
    "notizie di oggi": "notizie di oggi",
    "ultime notizie": "notizie di oggi",
    "notizie in italia": "notizie di oggi in Italia",
    "notizie di oggi in italia": "notizie di oggi in Italia",
    "notizie nel mondo": "notizie di oggi nel mondo",
    "notizie di oggi nel mondo": "notizie di oggi nel mondo",
    "serie a": "risultati Serie A",
    "risultati serie a": "risultati Serie A",
    "champions league": "risultati Champions League",
    "risultati champions league": "risultati Champions League",
    "prezzo bitcoin": "quotazione Bitcoin oggi",
    "prezzo del bitcoin": "quotazione Bitcoin oggi",
    "quotazione bitcoin oggi": "quotazione Bitcoin oggi",
    "cambio euro dollaro": "cambio euro dollaro oggi",
    "cambio euro dollaro oggi": "cambio euro dollaro oggi",
}

_REQUEST_PREFIX = re.compile(r"^(?:cerca online|cerca(?:mi)?|dimmi|controlla) ")
_WEATHER = re.compile(
    r"(?:meteo|previsioni meteo|che tempo fa|che tempo c'è|piove)"
    r"(?: oggi)?(?: (?:a|ad|in|di|per) (?P<city>[^?]+))?"
)


def _normalized(value: str) -> str:
    return " ".join(unicodedata.normalize("NFKC", value).replace("’", "'").casefold().split())


def public_search_query(text: str, *, authorized_city: str = "") -> str | None:
    """Return canonical provider input, or None when the full request is unsupported."""
    if not isinstance(text, str) or len(text) > 160:
        return None
    request = _REQUEST_PREFIX.sub("", _normalized(text).rstrip("?!").rstrip(), count=1)
    if request in _TOPICS:
        return _TOPICS[request]
    match = _WEATHER.fullmatch(request)
    if not match:
        return None
    if match["city"] is not None:
        if match["city"] == "italia":
            return "meteo oggi in Italia"
        city = _CITIES.get(match["city"])
        return f"meteo oggi a {city}" if city else None
    city = _CITIES.get(_normalized(authorized_city)) if authorized_city else None
    return f"meteo oggi a {city}" if city else "meteo oggi in Italia"


def is_public_search_query(query: str) -> bool:
    """Only canonical strings may cross the provider and cache boundary."""
    return isinstance(query, str) and query == public_search_query(query)


def has_explicit_search_intent(text: str) -> bool:
    request = _normalized(text[:160])
    return bool(_REQUEST_PREFIX.match(request)) or request.startswith((
        "meteo ", "previsioni meteo ", "ultime notizie ", "notizie di oggi ",
        "prezzo del ", "quotazione ", "risultati ",
    ))
