from pathlib import Path
import hashlib, json, sys
root = Path(__file__).resolve().parents[2]
manifest = json.loads((root / "frontend/mobile-source-manifest.json").read_text())
failed = []
for name, expected in manifest["files"].items():
    path = root / name
    if not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest() != expected:
        failed.append(name)
if failed:
    print("SORGENTI NON ALLINEATI: " + ", ".join(failed))
    sys.exit(1)
print("Sorgenti corrispondenti al pacchetto: " + manifest["build_tag"])
print("Questo controllo NON conferma la compilazione o il funzionamento su Honor.")
