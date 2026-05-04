import os
import pytest
import requests

BASE_URL = os.environ.get("EXPO_PUBLIC_BACKEND_URL", "https://app-finder-408.preview.emergentagent.com").rstrip("/")
API = f"{BASE_URL}/api"


@pytest.fixture(scope="module")
def s():
    sess = requests.Session()
    sess.headers.update({"Content-Type": "application/json"})
    return sess


# Categories
def test_categories(s):
    r = s.get(f"{API}/categories", timeout=30)
    assert r.status_code == 200
    data = r.json()
    assert len(data) == 12
    assert all({"id", "name", "emoji", "description", "examples"} <= set(c.keys()) for c in data)


# Recommend empty
def test_recommend_empty(s):
    r = s.post(f"{API}/recommend", json={"query": ""}, timeout=30)
    assert r.status_code == 400


# Recommend real (AI)
@pytest.fixture(scope="module")
def recommend_result(s):
    r = s.post(f"{API}/recommend", json={"query": "voglio modificare una foto"}, timeout=90)
    assert r.status_code == 200, r.text
    return r.json()


def test_recommend_structure(recommend_result):
    d = recommend_result
    assert d.get("summary")
    assert isinstance(d.get("apps"), list)
    assert len(d["apps"]) >= 4
    first = d["apps"][0]
    for k in ("name", "description", "platforms", "pricing", "pros", "cons"):
        assert k in first


# History
def test_history_has_entry(s, recommend_result):
    r = s.get(f"{API}/history", timeout=30)
    assert r.status_code == 200
    items = r.json()
    assert len(items) >= 1
    assert any(i["query"] == "voglio modificare una foto" for i in items)


# Favorites roundtrip + duplicates
def test_favorites_roundtrip(s, recommend_result):
    app_item = recommend_result["apps"][0]
    r1 = s.post(f"{API}/favorites", json={"app": app_item, "query": recommend_result["query"]}, timeout=30)
    assert r1.status_code == 200
    fav = r1.json()
    assert fav["app"]["name"] == app_item["name"]
    fav_id = fav["id"]

    # GET verify
    r2 = s.get(f"{API}/favorites", timeout=30)
    assert r2.status_code == 200
    assert any(f["id"] == fav_id for f in r2.json())

    # Duplicate by name -> same id
    r3 = s.post(f"{API}/favorites", json={"app": app_item}, timeout=30)
    assert r3.status_code == 200
    assert r3.json()["id"] == fav_id

    # Delete
    r4 = s.delete(f"{API}/favorites/{fav_id}", timeout=30)
    assert r4.status_code == 200
    r5 = s.get(f"{API}/favorites", timeout=30)
    assert not any(f["id"] == fav_id for f in r5.json())


# History delete single + clear all
def test_history_delete(s):
    items = s.get(f"{API}/history", timeout=30).json()
    if items:
        hid = items[0]["id"]
        r = s.delete(f"{API}/history/{hid}", timeout=30)
        assert r.status_code == 200
        after = s.get(f"{API}/history", timeout=30).json()
        assert not any(i["id"] == hid for i in after)

    r2 = s.delete(f"{API}/history", timeout=30)
    assert r2.status_code == 200
    assert s.get(f"{API}/history", timeout=30).json() == []
