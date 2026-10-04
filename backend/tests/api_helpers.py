"""Helpers for tests that talk HTTP as different accounts."""

import httpx

ADMIN_PASSWORD = "admin-passwort-1"
SETUP_TOKEN = "test-setup-token-0123"
"""As GEOTANDEM_SETUP_TOKEN of the test instances (conftest ``app``)."""
USER_PASSWORD = "nutzer-passwort-1"


async def sign_in_as(
    client: httpx.AsyncClient,
    username: str,
    role: str = "user",
    password: str = "nutzer-passwort-1",
) -> None:
    """Create an account through the admin API, then switch ``client`` to it."""
    created = await client.post("/api/admin/users", json={"username": username, "role": role})
    assert created.status_code == 201, created.text
    start = created.json()["start_password"]
    client.cookies.clear()
    await client.post("/api/auth/login", json={"username": username, "password": start})
    changed = await client.post("/api/auth/password", json={"current": start, "new": password})
    assert changed.status_code == 204, changed.text


async def sign_in(client: httpx.AsyncClient, username: str, password: str) -> None:
    client.cookies.clear()
    response = await client.post(
        "/api/auth/login", json={"username": username, "password": password}
    )
    assert response.status_code == 200, response.text
