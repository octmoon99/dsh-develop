"""In-memory HTTP alarm system for local DSH integration tests.

The service implements the strict gateway response consumed by
``@deepseek-ai/dsh-integration-alarm-http``. Administrative routes only shape
fixture state; they are not model tools and do not represent production alarm
management APIs.
"""

from __future__ import annotations

import os
import re
import secrets
import threading
import time
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from enum import Enum
from typing import Annotated

from fastapi import Depends, FastAPI, HTTPException, Query, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    ValidationInfo,
    field_validator,
    model_validator,
)


TIMESTAMP_PATTERN = re.compile(
    r"^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:[Zz]|[+-]\d{2}:\d{2})$"
)
MAX_ALARMS = 200
MAX_DELAY_MS = 5_000


class Severity(str, Enum):
    """Alarm severities accepted by the DSH alarm capability."""

    CRITICAL = "critical"
    HIGH = "high"
    MEDIUM = "medium"
    LOW = "low"


class AlarmStatus(str, Enum):
    """Alarm lifecycle states accepted by the DSH alarm capability."""

    FIRING = "firing"
    ACKNOWLEDGED = "acknowledged"
    RESOLVED = "resolved"


class Scenario(str, Enum):
    """Deterministic fixture datasets exposed by the reset route."""

    NORMAL = "normal"
    EMPTY = "empty"
    MANY = "many"
    LONG_DETAIL = "long-detail"


class FaultMode(str, Enum):
    """Bounded faults that affect only alarm queries."""

    NONE = "none"
    NEXT_503 = "next-503"
    DELAY = "delay"


def parse_timestamp(value: str, subject: str) -> datetime:
    """Parse one timezone-qualified ISO-8601 timestamp or raise ``ValueError``."""

    if not TIMESTAMP_PATTERN.fullmatch(value):
        raise ValueError(f"{subject} must be an ISO-8601 date-time with a timezone")
    normalized = value[:-1] + "+00:00" if value[-1] in {"Z", "z"} else value
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError as error:
        raise ValueError(f"{subject} must be a real ISO-8601 date-time") from error
    if parsed.utcoffset() is None:
        raise ValueError(f"{subject} must carry a timezone")
    return parsed.astimezone(timezone.utc)


def format_timestamp(value: datetime) -> str:
    """Render one aware datetime as a canonical UTC instant."""

    if value.utcoffset() is None:
        raise ValueError("fixture timestamps must carry a timezone")
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


class Alarm(BaseModel):
    """One strict alarm response entry."""

    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)

    id: str = Field(min_length=1, max_length=200)
    title: str = Field(min_length=1, max_length=500)
    severity: Severity
    status: AlarmStatus
    source: str | None = Field(default=None, min_length=1, max_length=200)
    fired_at: str = Field(alias="firedAt")
    acknowledged_at: str | None = Field(default=None, alias="acknowledgedAt")
    resolved_at: str | None = Field(default=None, alias="resolvedAt")
    detail: str | None = Field(default=None, max_length=20_000)

    @field_validator("fired_at", "acknowledged_at", "resolved_at")
    @classmethod
    def validate_timestamp(cls, value: str | None, info: ValidationInfo) -> str | None:
        """Reject timestamps that the fixture cannot compare consistently."""

        if value is None:
            return None
        parse_timestamp(value, info.field_name)
        return value


class AlarmResponse(BaseModel):
    """Exact response read by the DSH HTTP alarm provider."""

    model_config = ConfigDict(extra="forbid")

    total: int = Field(ge=0)
    alarms: list[Alarm]


class ResetRequest(BaseModel):
    """Administrative request that atomically replaces all fixture alarms."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    scenario: Scenario
    anchor: str | None = None

    @field_validator("anchor")
    @classmethod
    def validate_anchor(cls, value: str | None) -> str | None:
        if value is not None:
            parse_timestamp(value, "anchor")
        return value


class ResetResult(BaseModel):
    """Observable state after a reset."""

    model_config = ConfigDict(extra="forbid")

    scenario: Scenario
    count: int = Field(ge=0)
    anchor: str


class FaultRequest(BaseModel):
    """Administrative fault configuration for subsequent alarm queries."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    mode: FaultMode
    delay_ms: int = Field(default=0, alias="delayMs", ge=0, le=MAX_DELAY_MS)

    @model_validator(mode="after")
    def validate_mode(self) -> FaultRequest:
        if self.mode is FaultMode.DELAY and self.delay_ms == 0:
            raise ValueError("delayMs must be positive when mode is delay")
        if self.mode is not FaultMode.DELAY and self.delay_ms != 0:
            raise ValueError("delayMs must be zero unless mode is delay")
        return self


class FaultResult(BaseModel):
    """Active query-fault configuration."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    mode: FaultMode
    delay_ms: int = Field(alias="delayMs", ge=0, le=MAX_DELAY_MS)


class HealthResult(BaseModel):
    """Readiness response; it intentionally carries no credential data."""

    model_config = ConfigDict(extra="forbid")

    status: str
    storage: str


@dataclass(frozen=True)
class Settings:
    """Validated process-local credentials."""

    read_token: str
    admin_token: str


class AlarmStore:
    """Thread-safe in-memory alarms and query-fault state."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._alarms: dict[str, Alarm] = {}
        self._fault = FaultRequest(mode=FaultMode.NONE)

    def reset(self, scenario: Scenario, anchor: datetime) -> ResetResult:
        alarms = scenario_alarms(scenario, anchor)
        with self._lock:
            self._alarms = {alarm.id: alarm for alarm in alarms}
            self._fault = FaultRequest(mode=FaultMode.NONE)
        return ResetResult(
            scenario=scenario, count=len(alarms), anchor=format_timestamp(anchor)
        )

    def add(self, alarm: Alarm) -> Alarm:
        with self._lock:
            if alarm.id in self._alarms:
                raise KeyError(alarm.id)
            self._alarms[alarm.id] = alarm
        return alarm

    def snapshot(self) -> list[Alarm]:
        with self._lock:
            return list(self._alarms.values())

    def set_fault(self, fault: FaultRequest) -> FaultResult:
        with self._lock:
            self._fault = fault
        return FaultResult(mode=fault.mode, delay_ms=fault.delay_ms)

    def consume_fault(self) -> FaultResult:
        with self._lock:
            fault = self._fault
            if fault.mode is FaultMode.NEXT_503:
                self._fault = FaultRequest(mode=FaultMode.NONE)
        return FaultResult(mode=fault.mode, delay_ms=fault.delay_ms)


def build_alarm(
    *,
    alarm_id: str,
    title: str,
    severity: Severity,
    alarm_status: AlarmStatus,
    source: str,
    fired_at: datetime,
    detail: str,
) -> Alarm:
    """Build one internally consistent seed alarm."""

    acknowledged_at = None
    resolved_at = None
    if alarm_status in {AlarmStatus.ACKNOWLEDGED, AlarmStatus.RESOLVED}:
        acknowledged_at = format_timestamp(fired_at + timedelta(minutes=1))
    if alarm_status is AlarmStatus.RESOLVED:
        resolved_at = format_timestamp(fired_at + timedelta(minutes=3))
    return Alarm(
        id=alarm_id,
        title=title,
        severity=severity,
        status=alarm_status,
        source=source,
        fired_at=format_timestamp(fired_at),
        acknowledged_at=acknowledged_at,
        resolved_at=resolved_at,
        detail=detail,
    )


def scenario_alarms(scenario: Scenario, anchor: datetime) -> list[Alarm]:
    """Generate one scenario relative to its explicit UTC anchor."""

    anchor = anchor.astimezone(timezone.utc)
    if scenario is Scenario.EMPTY:
        return []
    if scenario is Scenario.LONG_DETAIL:
        return [
            build_alarm(
                alarm_id="long-detail-001",
                title="演示日志持续增长",
                severity=Severity.HIGH,
                alarm_status=AlarmStatus.FIRING,
                source="demo-logging",
                fired_at=anchor,
                detail="这是一段用于验证结果预算和卡片截断的本地模拟详情。" * 300,
            )
        ]

    count = 50 if scenario is Scenario.MANY else 12
    severities = list(Severity)
    statuses = list(AlarmStatus)
    sources = ["demo-database", "demo-api", "demo-worker"]
    titles = ["数据库连接失败", "API 错误率升高", "任务队列积压", "磁盘使用率升高"]
    prefix = scenario.value
    return [
        build_alarm(
            alarm_id=f"{prefix}-{index + 1:03d}",
            title=f"演示{titles[index % len(titles)]}",
            severity=severities[index % len(severities)],
            alarm_status=statuses[index % len(statuses)],
            source=sources[index % len(sources)],
            fired_at=anchor - timedelta(minutes=index * 5),
            detail=f"本地合成数据 #{index + 1}，用于验证报警查询链路。",
        )
        for index in range(count)
    ]


def filtered_alarms(
    alarms: list[Alarm],
    *,
    severity: Severity | None,
    alarm_status: AlarmStatus | None,
    source: str | None,
    keyword: str | None,
    since: datetime | None,
    until: datetime | None,
) -> list[Alarm]:
    """Filter and stably order a snapshot without mutating the store."""

    needle = keyword.casefold() if keyword is not None else None

    def included(alarm: Alarm) -> bool:
        fired_at = parse_timestamp(alarm.fired_at, "firedAt")
        if severity is not None and alarm.severity is not severity:
            return False
        if alarm_status is not None and alarm.status is not alarm_status:
            return False
        if source is not None and alarm.source != source:
            return False
        if (
            needle is not None
            and needle not in f"{alarm.title}\n{alarm.detail or ''}".casefold()
        ):
            return False
        if since is not None and fired_at < since:
            return False
        if until is not None and fired_at >= until:
            return False
        return True

    selected = [alarm for alarm in alarms if included(alarm)]
    selected.sort(key=lambda alarm: alarm.id)
    selected.sort(
        key=lambda alarm: parse_timestamp(alarm.fired_at, "firedAt"), reverse=True
    )
    return selected


def configured_token(value: str | None, env_name: str) -> str:
    """Resolve one non-empty token without trimming valid credential bytes."""

    token = value if value is not None else os.environ.get(env_name)
    if token is None or token == "":
        raise RuntimeError(f"alarm mock: required {env_name} is missing or empty")
    if token != token.strip():
        raise RuntimeError(
            f"alarm mock: {env_name} must not have surrounding whitespace"
        )
    return token


_bearer = HTTPBearer(auto_error=False)


class BearerGuard:
    """Validate either the read or administrative bearer credential."""

    def __init__(self, token_attribute: str) -> None:
        self._token_attribute = token_attribute

    async def __call__(
        self,
        request: Request,
        credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(_bearer)],
    ) -> None:
        expected = getattr(request.app.state.settings, self._token_attribute)
        if (
            credentials is None
            or credentials.scheme.lower() != "bearer"
            or not secrets.compare_digest(credentials.credentials, expected)
        ):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="invalid bearer token",
                headers={"WWW-Authenticate": "Bearer"},
            )


require_read = BearerGuard("read_token")
require_admin = BearerGuard("admin_token")


def create_app(
    *,
    read_token: str | None = None,
    admin_token: str | None = None,
    clock: Callable[[], datetime] | None = None,
) -> FastAPI:
    """Create an isolated alarm fixture app.

    Explicit tokens and a clock keep tests free of process-global environment
    and time mutations. The exported production instance resolves credentials
    from ``ALARM_MOCK_READ_TOKEN`` and ``ALARM_MOCK_ADMIN_TOKEN`` at startup.
    """

    now = clock or (lambda: datetime.now(timezone.utc))

    @asynccontextmanager
    async def lifespan(application: FastAPI) -> AsyncIterator[None]:
        resolved_read = configured_token(read_token, "ALARM_MOCK_READ_TOKEN")
        resolved_admin = configured_token(admin_token, "ALARM_MOCK_ADMIN_TOKEN")
        if secrets.compare_digest(resolved_read, resolved_admin):
            raise RuntimeError("alarm mock: read and admin tokens must differ")
        application.state.settings = Settings(
            read_token=resolved_read, admin_token=resolved_admin
        )
        store = AlarmStore()
        store.reset(Scenario.NORMAL, now())
        application.state.store = store
        yield

    application = FastAPI(
        title="Local alarm system fixture",
        description="In-memory REST fixture for the DSH alarm gateway protocol.",
        version="1.0.0",
        lifespan=lifespan,
    )

    @application.get("/healthz", response_model=HealthResult)
    def health() -> HealthResult:
        return HealthResult(status="ok", storage="memory")

    @application.get(
        "/alarms",
        response_model=AlarmResponse,
        response_model_exclude_none=True,
        dependencies=[Depends(require_read)],
    )
    def list_alarms(
        request: Request,
        severity: Severity | None = None,
        alarm_status: Annotated[AlarmStatus | None, Query(alias="status")] = None,
        source: Annotated[str | None, Query(min_length=1, max_length=200)] = None,
        keyword: Annotated[str | None, Query(min_length=1, max_length=500)] = None,
        since: str | None = None,
        until: str | None = None,
        limit: Annotated[int, Query(ge=1, le=MAX_ALARMS)] = 20,
    ) -> AlarmResponse:
        store: AlarmStore = request.app.state.store
        fault = store.consume_fault()
        if fault.mode is FaultMode.NEXT_503:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="injected one-shot failure",
            )
        if fault.mode is FaultMode.DELAY:
            time.sleep(fault.delay_ms / 1_000)

        try:
            parsed_since = (
                parse_timestamp(since, "since") if since is not None else None
            )
            parsed_until = (
                parse_timestamp(until, "until") if until is not None else None
            )
        except ValueError as error:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=str(error)
            ) from error
        if (
            parsed_since is not None
            and parsed_until is not None
            and parsed_since >= parsed_until
        ):
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail="since must be earlier than until",
            )

        selected = filtered_alarms(
            store.snapshot(),
            severity=severity,
            alarm_status=alarm_status,
            source=source,
            keyword=keyword,
            since=parsed_since,
            until=parsed_until,
        )
        return AlarmResponse(total=len(selected), alarms=selected[:limit])

    @application.post(
        "/_admin/alarms",
        response_model=Alarm,
        response_model_exclude_none=True,
        status_code=status.HTTP_201_CREATED,
        dependencies=[Depends(require_admin)],
    )
    def create_alarm(request: Request, alarm: Alarm) -> Alarm:
        store: AlarmStore = request.app.state.store
        try:
            return store.add(alarm)
        except KeyError as error:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f'alarm id "{alarm.id}" already exists',
            ) from error

    @application.post(
        "/_admin/reset",
        response_model=ResetResult,
        dependencies=[Depends(require_admin)],
    )
    def reset(request: Request, reset_request: ResetRequest) -> ResetResult:
        anchor = (
            parse_timestamp(reset_request.anchor, "anchor")
            if reset_request.anchor is not None
            else now()
        )
        store: AlarmStore = request.app.state.store
        return store.reset(reset_request.scenario, anchor)

    @application.put(
        "/_admin/faults",
        response_model=FaultResult,
        dependencies=[Depends(require_admin)],
    )
    def configure_fault(request: Request, fault: FaultRequest) -> FaultResult:
        store: AlarmStore = request.app.state.store
        return store.set_fault(fault)

    return application


app = create_app()
