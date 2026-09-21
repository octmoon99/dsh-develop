"""Protocol and live-network tests for the local alarm-system fixture."""

from __future__ import annotations

import socket
import threading
import time
from collections.abc import Iterator
from datetime import datetime, timezone

import httpx
import pytest
import uvicorn
from fastapi.testclient import TestClient

from alarm_mock.app import create_app


READ_TOKEN = "fixture-read-token"
ADMIN_TOKEN = "fixture-admin-token"
ANCHOR = datetime(2026, 9, 20, 6, 0, tzinfo=timezone.utc)
READ_HEADERS = {"authorization": f"Bearer {READ_TOKEN}"}
ADMIN_HEADERS = {"authorization": f"Bearer {ADMIN_TOKEN}"}


@pytest.fixture
def client() -> Iterator[TestClient]:
    application = create_app(
        read_token=READ_TOKEN, admin_token=ADMIN_TOKEN, clock=lambda: ANCHOR
    )
    with TestClient(application) as test_client:
        yield test_client


def test_startup_requires_distinct_nonempty_tokens() -> None:
    with pytest.raises(RuntimeError, match="ALARM_MOCK_READ_TOKEN"):
        with TestClient(create_app(read_token="", admin_token=ADMIN_TOKEN)):
            pass
    with pytest.raises(RuntimeError, match="must differ"):
        with TestClient(create_app(read_token=READ_TOKEN, admin_token=READ_TOKEN)):
            pass


def test_health_is_public_but_alarm_queries_require_the_read_token(
    client: TestClient,
) -> None:
    assert client.get("/healthz").json() == {"status": "ok", "storage": "memory"}
    denied = client.get("/alarms")
    assert denied.status_code == 401
    assert denied.headers["www-authenticate"] == "Bearer"
    assert client.get("/alarms", headers=READ_HEADERS).status_code == 200


def test_normal_query_filters_orders_and_counts_before_limit(
    client: TestClient,
) -> None:
    response = client.get("/alarms", params={"limit": 2}, headers=READ_HEADERS)
    assert response.status_code == 200
    body = response.json()
    assert set(body) == {"total", "alarms"}
    assert body["total"] == 12
    assert [alarm["id"] for alarm in body["alarms"]] == ["normal-001", "normal-002"]
    assert all(
        set(alarm)
        <= {
            "id",
            "title",
            "severity",
            "status",
            "source",
            "firedAt",
            "acknowledgedAt",
            "resolvedAt",
            "detail",
        }
        for alarm in body["alarms"]
    )

    filtered = client.get(
        "/alarms",
        params={"severity": "critical", "status": "firing", "source": "demo-database"},
        headers=READ_HEADERS,
    ).json()
    assert filtered["total"] == 1
    assert filtered["alarms"][0]["id"] == "normal-001"


def test_keyword_and_half_open_time_window_are_intersected(client: TestClient) -> None:
    response = client.get(
        "/alarms",
        params={
            "keyword": "数据库",
            "since": "2026-09-20T05:39:59Z",
            "until": "2026-09-20T06:00:00Z",
        },
        headers=READ_HEADERS,
    )
    assert response.status_code == 200
    assert response.json() == {
        "total": 1,
        "alarms": [
            {
                "id": "normal-005",
                "title": "演示数据库连接失败",
                "severity": "critical",
                "status": "acknowledged",
                "source": "demo-api",
                "firedAt": "2026-09-20T05:40:00Z",
                "acknowledgedAt": "2026-09-20T05:41:00Z",
                "detail": "本地合成数据 #5，用于验证报警查询链路。",
            }
        ],
    }


@pytest.mark.parametrize(
    ("params", "detail"),
    [
        ({"since": "not-a-time"}, "since must be an ISO-8601"),
        (
            {"since": "2026-09-20T06:00:00Z", "until": "2026-09-20T06:00:00Z"},
            "since must be earlier than until",
        ),
    ],
)
def test_invalid_time_filters_fail_loud(
    client: TestClient, params: dict[str, str], detail: str
) -> None:
    response = client.get("/alarms", params=params, headers=READ_HEADERS)
    assert response.status_code == 422
    assert detail in response.json()["detail"]


def test_admin_can_create_one_alarm_and_duplicate_ids_conflict(
    client: TestClient,
) -> None:
    alarm = {
        "id": "manual-001",
        "title": "手工模拟报警",
        "severity": "high",
        "status": "firing",
        "source": "manual-test",
        "firedAt": "2026-09-20T06:10:00+00:00",
        "detail": "由管理接口创建。",
    }
    assert (
        client.post("/_admin/alarms", json=alarm, headers=READ_HEADERS).status_code
        == 401
    )
    created = client.post("/_admin/alarms", json=alarm, headers=ADMIN_HEADERS)
    assert created.status_code == 201
    assert created.json() == alarm
    duplicate = client.post("/_admin/alarms", json=alarm, headers=ADMIN_HEADERS)
    assert duplicate.status_code == 409

    queried = client.get(
        "/alarms", params={"source": "manual-test"}, headers=READ_HEADERS
    ).json()
    assert queried == {"total": 1, "alarms": [alarm]}


def test_reset_scenarios_replace_data_and_clear_faults(client: TestClient) -> None:
    configured = client.put(
        "/_admin/faults",
        json={"mode": "next-503"},
        headers=ADMIN_HEADERS,
    )
    assert configured.json() == {"mode": "next-503", "delayMs": 0}
    reset = client.post(
        "/_admin/reset",
        json={"scenario": "many", "anchor": "2026-09-20T06:00:00Z"},
        headers=ADMIN_HEADERS,
    )
    assert reset.json() == {
        "scenario": "many",
        "count": 50,
        "anchor": "2026-09-20T06:00:00Z",
    }
    many = client.get("/alarms", params={"limit": 20}, headers=READ_HEADERS)
    assert many.status_code == 200
    assert many.json()["total"] == 50
    assert len(many.json()["alarms"]) == 20

    empty = client.post(
        "/_admin/reset",
        json={"scenario": "empty", "anchor": "2026-09-20T06:00:00Z"},
        headers=ADMIN_HEADERS,
    )
    assert empty.json()["count"] == 0
    assert client.get("/alarms", headers=READ_HEADERS).json() == {
        "total": 0,
        "alarms": [],
    }


def test_faults_are_bounded_to_alarm_queries(client: TestClient) -> None:
    client.put("/_admin/faults", json={"mode": "next-503"}, headers=ADMIN_HEADERS)
    assert client.get("/healthz").status_code == 200
    assert client.get("/alarms", headers=READ_HEADERS).status_code == 503
    assert client.get("/alarms", headers=READ_HEADERS).status_code == 200

    client.put(
        "/_admin/faults", json={"mode": "delay", "delayMs": 1}, headers=ADMIN_HEADERS
    )
    assert client.get("/alarms", headers=READ_HEADERS).status_code == 200
    invalid = client.put(
        "/_admin/faults", json={"mode": "delay", "delayMs": 0}, headers=ADMIN_HEADERS
    )
    assert invalid.status_code == 422


@pytest.fixture
def live_base_url() -> Iterator[str]:
    application = create_app(
        read_token=READ_TOKEN, admin_token=ADMIN_TOKEN, clock=lambda: ANCHOR
    )
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    listener.bind(("127.0.0.1", 0))
    listener.listen(128)
    host, port = listener.getsockname()
    server = uvicorn.Server(
        uvicorn.Config(application, log_level="critical", lifespan="on", ws="none")
    )
    thread = threading.Thread(
        target=server.run, kwargs={"sockets": [listener]}, daemon=False
    )
    thread.start()
    base_url = f"http://{host}:{port}"
    deadline = time.monotonic() + 10
    try:
        while True:
            if not thread.is_alive():
                raise RuntimeError("live alarm fixture exited before readiness")
            try:
                response = httpx.get(f"{base_url}/healthz", timeout=0.2)
                if response.status_code == 200:
                    break
            except httpx.TransportError:
                pass
            if time.monotonic() >= deadline:
                raise RuntimeError("live alarm fixture did not become ready")
            time.sleep(0.01)
        yield base_url
    finally:
        server.should_exit = True
        thread.join(timeout=10)
        listener.close()
        if thread.is_alive():
            raise RuntimeError("live alarm fixture did not stop")


def test_real_http_listener_serves_the_gateway_protocol(live_base_url: str) -> None:
    with httpx.Client(base_url=live_base_url, timeout=2) as client:
        response = client.get("/alarms", params={"limit": 1}, headers=READ_HEADERS)
    assert response.status_code == 200
    assert response.json()["total"] == 12
    assert response.json()["alarms"][0]["id"] == "normal-001"
