# Backend smoke: /api/health via public URL + server.py parse (v70.6.1 frontend-only change verification)
import ast
import os
import requests

BASE_URL = (os.environ.get('EXPO_PUBLIC_BACKEND_URL') or os.environ.get('EXPO_BACKEND_URL')).rstrip('/')


def test_server_py_parses():
    with open('/app/backend/server.py') as f:
        ast.parse(f.read())


def test_health_public():
    r = requests.get(f"{BASE_URL}/api/health", timeout=20)
    assert r.status_code == 200
    data = r.json()
    assert data.get("ok") is True
    assert isinstance(data.get("version"), str) and data["version"]
