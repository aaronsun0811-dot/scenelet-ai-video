"""Travel-video route preview helpers.

Map APIs are optional. This service always returns a usable preview shape:
with a configured map key it resolves route steps; otherwise it falls back to
manual route notes and reference images so generation can still proceed.
"""

from __future__ import annotations

import html
import math
import re
from datetime import UTC, datetime
from typing import Any, Literal

import httpx

GOOGLE_DIRECTIONS_URL = "https://maps.googleapis.com/maps/api/directions/json"
GOOGLE_STREET_VIEW_METADATA_URL = "https://maps.googleapis.com/maps/api/streetview/metadata"
GOOGLE_STREET_VIEW_IMAGE_URL = "https://maps.googleapis.com/maps/api/streetview"
AMAP_GEOCODE_URL = "https://restapi.amap.com/v3/geocode/geo"
AMAP_WALKING_DIRECTIONS_URL = "https://restapi.amap.com/v3/direction/walking"
BAIDU_GEOCODE_URL = "https://api.map.baidu.com/geocoding/v3/"
BAIDU_WALKING_DIRECTIONS_URL = "https://api.map.baidu.com/directionlite/v1/walking"
MAX_ROUTE_NODES = 8
MAX_TRAVEL_REFERENCE_IMAGES = 10


def _text(value: object) -> str:
    return str(value or "").strip()


def _reference_images(settings: dict[str, Any]) -> list[str]:
    raw = settings.get("reference_images")
    if not isinstance(raw, list):
        return []
    return [item.strip() for item in raw if isinstance(item, str) and item.strip()][:MAX_TRAVEL_REFERENCE_IMAGES]


def _strip_html(value: object) -> str:
    text = re.sub(r"<[^>]+>", " ", str(value or ""))
    return re.sub(r"\s+", " ", html.unescape(text)).strip()


def _distance_label(distance: dict[str, Any] | None) -> str | None:
    if not isinstance(distance, dict):
        return None
    text = _text(distance.get("text"))
    return text or None


def _duration_label(duration: dict[str, Any] | None) -> str | None:
    if not isinstance(duration, dict):
        return None
    text = _text(duration.get("text"))
    return text or None


def _lat_lng(value: dict[str, Any] | None) -> tuple[float | None, float | None]:
    if not isinstance(value, dict):
        return None, None
    try:
        return float(value["lat"]), float(value["lng"])
    except (KeyError, TypeError, ValueError):
        return None, None


def _lng_lat_from_text(value: object) -> tuple[float | None, float | None]:
    parts = _text(value).split(",", maxsplit=1)
    if len(parts) != 2:
        return None, None
    lng = _number(parts[0])
    lat = _number(parts[1])
    return lat, lng


def _heading(start: tuple[float | None, float | None], end: tuple[float | None, float | None]) -> float | None:
    lat1, lng1 = start
    lat2, lng2 = end
    if lat1 is None or lng1 is None or lat2 is None or lng2 is None:
        return None
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    delta_lng = math.radians(lng2 - lng1)
    y = math.sin(delta_lng) * math.cos(phi2)
    x = math.cos(phi1) * math.sin(phi2) - math.sin(phi1) * math.cos(phi2) * math.cos(delta_lng)
    return round((math.degrees(math.atan2(y, x)) + 360) % 360, 1)


def _number(value: object) -> float | None:
    try:
        parsed = float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
    return parsed if math.isfinite(parsed) else None


def _int_status(value: object) -> int | None:
    try:
        return int(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None


def _first_number(*values: object) -> float | None:
    for value in values:
        parsed = _number(value)
        if parsed is not None:
            return parsed
    return None


def _meters_label(value: object) -> str | None:
    meters = _number(value)
    if meters is None:
        return None
    if meters < 1000:
        return f"{round(meters)} m"
    return f"{meters / 1000:.1f} km"


def _seconds_label(value: object) -> str | None:
    seconds = _number(value)
    if seconds is None:
        return None
    minutes = round(seconds / 60)
    if minutes < 60:
        return f"{max(1, minutes)} mins"
    hours = minutes // 60
    rest = minutes % 60
    return f"{hours}h {rest}m" if rest else f"{hours}h"


def _sample_google_steps(steps: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if not steps:
        return []
    if len(steps) <= MAX_ROUTE_NODES:
        return steps
    stride = max(1, math.ceil(len(steps) / MAX_ROUTE_NODES))
    sampled = steps[::stride]
    if steps[-1] not in sampled:
        sampled.append(steps[-1])
    return sampled[:MAX_ROUTE_NODES]


def _sample_steps(steps: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if not steps:
        return []
    if len(steps) <= MAX_ROUTE_NODES:
        return steps
    stride = max(1, math.ceil(len(steps) / MAX_ROUTE_NODES))
    sampled = steps[::stride]
    if steps[-1] not in sampled:
        sampled.append(steps[-1])
    return sampled[:MAX_ROUTE_NODES]


def _first_polyline_lat_lng(value: object) -> tuple[float | None, float | None]:
    first = _text(value).split(";", maxsplit=1)[0]
    return _lng_lat_from_text(first)


async def _amap_geocode(http_client: httpx.AsyncClient, *, api_key: str, address: str) -> tuple[float, float]:
    res = await http_client.get(
        AMAP_GEOCODE_URL,
        params={"address": address, "key": api_key, "output": "json"},
    )
    res.raise_for_status()
    body = res.json()
    if not isinstance(body, dict) or _text(body.get("status")) != "1":
        raise ValueError(_text(body.get("info")) if isinstance(body, dict) else "UNKNOWN")
    geocodes = body.get("geocodes")
    first = geocodes[0] if isinstance(geocodes, list) and geocodes else None
    lat, lng = _lng_lat_from_text(first.get("location") if isinstance(first, dict) else None)
    if lat is None or lng is None:
        raise ValueError("NO_GEOCODE")
    return lat, lng


async def _baidu_geocode(http_client: httpx.AsyncClient, *, api_key: str, address: str) -> tuple[float, float]:
    res = await http_client.get(
        BAIDU_GEOCODE_URL,
        params={"address": address, "output": "json", "ak": api_key},
    )
    res.raise_for_status()
    body = res.json()
    if not isinstance(body, dict) or _int_status(body.get("status")) != 0:
        raise ValueError(_text(body.get("message")) if isinstance(body, dict) else "UNKNOWN")
    result = body.get("result")
    location = result.get("location") if isinstance(result, dict) else None
    lat, lng = _lat_lng(location)
    if lat is None or lng is None:
        raise ValueError("NO_GEOCODE")
    return lat, lng


async def _build_amap_route_preview(
    settings: dict[str, Any],
    *,
    api_key: str,
    http_client: httpx.AsyncClient,
    warnings: list[dict[str, str]],
) -> dict[str, Any]:
    origin = _text(settings.get("origin"))
    destination = _text(settings.get("destination"))
    route_notes = _text(settings.get("route_notes"))
    refs = _reference_images(settings)

    try:
        origin_lat, origin_lng = await _amap_geocode(http_client, api_key=api_key, address=origin)
        destination_lat, destination_lng = await _amap_geocode(http_client, api_key=api_key, address=destination)
        route_res = await http_client.get(
            AMAP_WALKING_DIRECTIONS_URL,
            params={
                "origin": f"{origin_lng},{origin_lat}",
                "destination": f"{destination_lng},{destination_lat}",
                "key": api_key,
                "output": "json",
            },
        )
        route_res.raise_for_status()
        body = route_res.json()
    except (httpx.HTTPError, ValueError) as exc:
        warnings.append({
            "code": "amap_route_request_failed",
            "message": f"高德地图路线解析请求失败：{exc}",
        })
        return _manual_preview(settings, google_configured=False, warnings=warnings)

    if not isinstance(body, dict) or _text(body.get("status")) != "1":
        warnings.append({
            "code": "amap_route_status",
            "message": f"高德地图路线解析未返回可用路线：{_text(body.get('info')) if isinstance(body, dict) else 'UNKNOWN'}",
        })
        return _manual_preview(settings, google_configured=False, warnings=warnings)

    route = body.get("route")
    paths = route.get("paths") if isinstance(route, dict) else None
    path = paths[0] if isinstance(paths, list) and paths else {}
    steps = path.get("steps") if isinstance(path, dict) else []
    sampled_steps = _sample_steps([step for step in steps if isinstance(step, dict)])
    nodes: list[dict[str, Any]] = []
    previous: tuple[float | None, float | None] = (origin_lat, origin_lng)
    for idx, step in enumerate(sampled_steps, start=1):
        lat, lng = _first_polyline_lat_lng(step.get("polyline"))
        current = (lat, lng)
        nodes.append({
            "id": f"amap-step-{idx}",
            "label": f"路线节点 {idx}",
            "instruction": _strip_html(step.get("instruction")) or None,
            "lat": lat,
            "lng": lng,
            "heading": _heading(previous, current),
            "distance_text": _meters_label(step.get("distance")),
            "duration_text": _seconds_label(step.get("duration")),
            "source": "amap",
        })
        if lat is not None and lng is not None:
            previous = current

    summary = route_notes or f"{origin} → {destination}"
    return {
        "source": "amap",
        "google_configured": False,
        "map_configured": True,
        "route_ready": bool(nodes or route_notes or refs or (origin and destination)),
        "origin": origin,
        "destination": destination,
        "summary": summary,
        "distance_text": _meters_label(path.get("distance") if isinstance(path, dict) else None),
        "duration_text": _seconds_label(path.get("duration") if isinstance(path, dict) else None),
        "nodes": nodes,
        "reference_images": refs,
        "warnings": warnings,
        "generated_at": datetime.now(UTC).isoformat(),
    }


async def _build_baidu_route_preview(
    settings: dict[str, Any],
    *,
    api_key: str,
    http_client: httpx.AsyncClient,
    warnings: list[dict[str, str]],
) -> dict[str, Any]:
    origin = _text(settings.get("origin"))
    destination = _text(settings.get("destination"))
    route_notes = _text(settings.get("route_notes"))
    refs = _reference_images(settings)

    try:
        origin_lat, origin_lng = await _baidu_geocode(http_client, api_key=api_key, address=origin)
        destination_lat, destination_lng = await _baidu_geocode(http_client, api_key=api_key, address=destination)
        route_res = await http_client.get(
            BAIDU_WALKING_DIRECTIONS_URL,
            params={
                "origin": f"{origin_lat},{origin_lng}",
                "destination": f"{destination_lat},{destination_lng}",
                "ak": api_key,
            },
        )
        route_res.raise_for_status()
        body = route_res.json()
    except (httpx.HTTPError, ValueError) as exc:
        warnings.append({
            "code": "baidu_route_request_failed",
            "message": f"百度地图路线解析请求失败：{exc}",
        })
        return _manual_preview(settings, google_configured=False, warnings=warnings)

    if not isinstance(body, dict) or _int_status(body.get("status")) != 0:
        warnings.append({
            "code": "baidu_route_status",
            "message": f"百度地图路线解析未返回可用路线：{_text(body.get('message')) if isinstance(body, dict) else 'UNKNOWN'}",
        })
        return _manual_preview(settings, google_configured=False, warnings=warnings)

    result = body.get("result")
    routes = result.get("routes") if isinstance(result, dict) else None
    route = routes[0] if isinstance(routes, list) and routes else {}
    steps = route.get("steps") if isinstance(route, dict) else []
    sampled_steps = _sample_steps([step for step in steps if isinstance(step, dict)])
    nodes: list[dict[str, Any]] = []
    previous: tuple[float | None, float | None] = (origin_lat, origin_lng)
    for idx, step in enumerate(sampled_steps, start=1):
        lat, lng = _first_polyline_lat_lng(step.get("path"))
        current = (lat, lng)
        nodes.append({
            "id": f"baidu-step-{idx}",
            "label": f"路线节点 {idx}",
            "instruction": _strip_html(step.get("instruction") or step.get("instructions")) or None,
            "lat": lat,
            "lng": lng,
            "heading": _heading(previous, current),
            "distance_text": _meters_label(step.get("distance")),
            "duration_text": _seconds_label(step.get("duration")),
            "source": "baidu",
        })
        if lat is not None and lng is not None:
            previous = current

    summary = route_notes or f"{origin} → {destination}"
    return {
        "source": "baidu",
        "google_configured": False,
        "map_configured": True,
        "route_ready": bool(nodes or route_notes or refs or (origin and destination)),
        "origin": origin,
        "destination": destination,
        "summary": summary,
        "distance_text": _meters_label(route.get("distance") if isinstance(route, dict) else None),
        "duration_text": _seconds_label(route.get("duration") if isinstance(route, dict) else None),
        "nodes": nodes,
        "reference_images": refs,
        "warnings": warnings,
        "generated_at": datetime.now(UTC).isoformat(),
    }


async def test_travel_map_provider(
    provider: Literal["google", "baidu", "amap"],
    *,
    api_key: str,
    http_client: httpx.AsyncClient | None = None,
) -> dict[str, Any]:
    """Run a lightweight server-side connectivity check for a map provider key."""

    key = _text(api_key)
    if not key:
        return {"success": False, "provider": provider, "message": "地图 API Key 未配置。"}

    if http_client is None:
        async with httpx.AsyncClient(timeout=8.0) as temp_client:
            return await test_travel_map_provider(provider, api_key=api_key, http_client=temp_client)

    try:
        if provider == "google":
            res = await http_client.get(
                GOOGLE_DIRECTIONS_URL,
                params={
                    "origin": "Tokyo Station",
                    "destination": "Tokyo Tower",
                    "mode": "walking",
                    "language": "zh",
                    "key": key,
                },
            )
            res.raise_for_status()
            body = res.json()
            status = _text(body.get("status")) if isinstance(body, dict) else "UNKNOWN"
            if status == "OK":
                return {"success": True, "provider": provider, "message": "Google 地图 Key 可用，路线服务响应正常。"}
            error_message = _text(body.get("error_message")) if isinstance(body, dict) else ""
            return {
                "success": False,
                "provider": provider,
                "message": f"Google 地图测试失败：{error_message or status}",
            }

        if provider == "amap":
            origin_lat, origin_lng = await _amap_geocode(http_client, api_key=key, address="北京市天安门")
            destination_lat, destination_lng = await _amap_geocode(http_client, api_key=key, address="北京市王府井")
            res = await http_client.get(
                AMAP_WALKING_DIRECTIONS_URL,
                params={
                    "origin": f"{origin_lng},{origin_lat}",
                    "destination": f"{destination_lng},{destination_lat}",
                    "key": key,
                    "output": "json",
                },
            )
            res.raise_for_status()
            body = res.json()
            if isinstance(body, dict) and _text(body.get("status")) == "1":
                return {"success": True, "provider": provider, "message": "高德地图 Key 可用，地理编码和步行路线响应正常。"}
            return {
                "success": False,
                "provider": provider,
                "message": f"高德地图测试失败：{_text(body.get('info')) if isinstance(body, dict) else 'UNKNOWN'}",
            }

        origin_lat, origin_lng = await _baidu_geocode(http_client, api_key=key, address="北京市天安门")
        destination_lat, destination_lng = await _baidu_geocode(http_client, api_key=key, address="北京市王府井")
        res = await http_client.get(
            BAIDU_WALKING_DIRECTIONS_URL,
            params={
                "origin": f"{origin_lat},{origin_lng}",
                "destination": f"{destination_lat},{destination_lng}",
                "ak": key,
            },
        )
        res.raise_for_status()
        body = res.json()
        if isinstance(body, dict) and _int_status(body.get("status")) == 0:
            return {"success": True, "provider": provider, "message": "百度地图 Key 可用，地理编码和步行路线响应正常。"}
        return {
            "success": False,
            "provider": provider,
            "message": f"百度地图测试失败：{_text(body.get('message')) if isinstance(body, dict) else 'UNKNOWN'}",
        }
    except (httpx.HTTPError, ValueError) as exc:
        provider_label = {"google": "Google 地图", "baidu": "百度地图", "amap": "高德地图"}[provider]
        return {"success": False, "provider": provider, "message": f"{provider_label}测试失败：{exc}"}


async def _street_view_metadata(
    http_client: httpx.AsyncClient,
    *,
    api_key: str,
    lat: float | None,
    lng: float | None,
) -> dict[str, Any]:
    if lat is None or lng is None:
        return {"status": "NO_LOCATION"}
    res = await http_client.get(
        GOOGLE_STREET_VIEW_METADATA_URL,
        params={
            "location": f"{lat},{lng}",
            "source": "outdoor",
            "key": api_key,
        },
    )
    res.raise_for_status()
    body = res.json()
    location = body.get("location") if isinstance(body, dict) else None
    pano_lat, pano_lng = _lat_lng(location)
    status = _text(body.get("status")) if isinstance(body, dict) else "UNKNOWN"
    pano_id = _text(body.get("pano_id")) if isinstance(body, dict) else ""
    return {
        "status": status,
        "pano_id": pano_id or None,
        "lat": pano_lat,
        "lng": pano_lng,
    }


def _street_view_image_params(node: dict[str, Any], *, size: str = "640x360") -> dict[str, str]:
    params = {
        "size": size,
        "source": "outdoor",
        "fov": "80",
        "pitch": "0",
    }
    pano_id = _text(node.get("pano_id"))
    if pano_id:
        params["pano"] = pano_id
    else:
        lat = _first_number(node.get("street_view_lat"), node.get("lat"))
        lng = _first_number(node.get("street_view_lng"), node.get("lng"))
        if lat is None or lng is None:
            raise ValueError("street view node has no pano or location")
        params["location"] = f"{lat},{lng}"

    heading = _number(node.get("heading"))
    if heading is not None:
        params["heading"] = str(round(heading, 1))
    return params


async def fetch_travel_route_street_view_image(
    node: dict[str, Any],
    *,
    google_maps_api_key: str | None,
    http_client: httpx.AsyncClient | None = None,
) -> tuple[bytes, str]:
    """Fetch a Google Street View Static image for a route node.

    The caller receives raw image bytes only. The Google key stays server-side,
    which lets the frontend show thumbnails without exposing billable secrets.
    """

    google_key = _text(google_maps_api_key)
    if not google_key:
        raise ValueError("google maps api key is not configured")
    if _text(node.get("source")) != "google":
        raise ValueError("street view images are only available for google route nodes")

    if http_client is None:
        async with httpx.AsyncClient(timeout=8.0) as temp_client:
            return await fetch_travel_route_street_view_image(
                node,
                google_maps_api_key=google_maps_api_key,
                http_client=temp_client,
            )

    params = _street_view_image_params(node)
    params["key"] = google_key
    res = await http_client.get(GOOGLE_STREET_VIEW_IMAGE_URL, params=params)
    res.raise_for_status()
    content_type = res.headers.get("content-type", "image/jpeg").split(";", maxsplit=1)[0].strip()
    if not content_type.startswith("image/"):
        raise ValueError("google street view did not return an image")
    return res.content, content_type


def _manual_preview(settings: dict[str, Any], *, google_configured: bool, warnings: list[dict[str, str]]) -> dict[str, Any]:
    origin = _text(settings.get("origin"))
    destination = _text(settings.get("destination"))
    route_notes = _text(settings.get("route_notes"))
    refs = _reference_images(settings)
    nodes: list[dict[str, Any]] = []
    if origin:
        nodes.append({"id": "origin", "label": "出发地", "instruction": origin, "source": "manual"})
    if route_notes:
        nodes.append({"id": "route-notes", "label": "手动路线", "instruction": route_notes, "source": "manual"})
    if destination:
        nodes.append({"id": "destination", "label": "目的地", "instruction": destination, "source": "manual"})
    for idx, ref in enumerate(refs, start=1):
        nodes.append({"id": f"reference-{idx}", "label": f"参考图 {idx}", "instruction": ref, "source": "reference_image"})

    source: Literal["manual", "reference_images", "hybrid"] = (
        "hybrid" if route_notes and refs else "reference_images" if refs and not (origin or destination or route_notes) else "manual"
    )
    return {
        "source": source,
        "google_configured": google_configured,
        "route_ready": bool(route_notes or refs or (origin and destination)),
        "origin": origin or None,
        "destination": destination or None,
        "summary": route_notes or ("使用上传的路线参考图生成。" if refs else None),
        "distance_text": None,
        "duration_text": None,
        "nodes": nodes,
        "reference_images": refs,
        "warnings": warnings,
        "generated_at": datetime.now(UTC).isoformat(),
    }


async def build_travel_route_preview(
    settings: dict[str, Any],
    *,
    google_maps_api_key: str | None,
    baidu_maps_api_key: str | None = None,
    amap_maps_api_key: str | None = None,
    http_client: httpx.AsyncClient | None = None,
) -> dict[str, Any]:
    """Build a route preview for travel-video generation.

    The return payload is intentionally JSON-serializable and key-free. Never
    expose the Google API key or signed URLs to the frontend.
    """
    origin = _text(settings.get("origin"))
    destination = _text(settings.get("destination"))
    route_source = _text(settings.get("route_source")) or "google_street_view"
    route_notes = _text(settings.get("route_notes"))
    refs = _reference_images(settings)
    google_key = _text(google_maps_api_key)
    baidu_key = _text(baidu_maps_api_key)
    amap_key = _text(amap_maps_api_key)
    google_configured = bool(google_key)
    warnings: list[dict[str, str]] = []

    if route_source in {"baidu_maps", "amap_maps"}:
        provider_key = baidu_key if route_source == "baidu_maps" else amap_key
        provider_label = "百度地图" if route_source == "baidu_maps" else "高德地图"
        provider_code = "baidu" if route_source == "baidu_maps" else "amap"
        if not provider_key:
            warnings.append({
                "code": f"{provider_code}_maps_optional_missing",
                "message": f"{provider_label} API Key 未配置，已使用手动路线或参考图预检。",
            })
            return _manual_preview(settings, google_configured=google_configured, warnings=warnings)
        if not origin or not destination:
            warnings.append({
                "code": f"{provider_code}_route_places_missing",
                "message": f"{provider_label}路线解析需要同时填写出发地和目的地。",
            })
            return _manual_preview(settings, google_configured=google_configured, warnings=warnings)
        if http_client is None:
            async with httpx.AsyncClient(timeout=5.0) as temp_client:
                return await build_travel_route_preview(
                    settings,
                    google_maps_api_key=google_maps_api_key,
                    baidu_maps_api_key=baidu_maps_api_key,
                    amap_maps_api_key=amap_maps_api_key,
                    http_client=temp_client,
                )
        if route_source == "baidu_maps":
            return await _build_baidu_route_preview(
                settings,
                api_key=provider_key,
                http_client=http_client,
                warnings=warnings,
            )
        return await _build_amap_route_preview(
            settings,
            api_key=provider_key,
            http_client=http_client,
            warnings=warnings,
        )

    if route_source != "google_street_view":
        return _manual_preview(settings, google_configured=google_configured, warnings=warnings)

    if not google_key:
        warnings.append({
            "code": "google_maps_optional_missing",
            "message": "Google 街景/地图 API Key 未配置，已使用手动路线或参考图预检。",
        })
        return _manual_preview(settings, google_configured=False, warnings=warnings)

    if not origin or not destination:
        warnings.append({
            "code": "google_route_places_missing",
            "message": "Google 路线解析需要同时填写出发地和目的地。",
        })
        return _manual_preview(settings, google_configured=True, warnings=warnings)

    if http_client is None:
        async with httpx.AsyncClient(timeout=5.0) as temp_client:
            return await build_travel_route_preview(
                settings,
                google_maps_api_key=google_maps_api_key,
                baidu_maps_api_key=baidu_maps_api_key,
                amap_maps_api_key=amap_maps_api_key,
                http_client=temp_client,
            )

    try:
        language = _text(settings.get("narration_language"))
        if language == "auto":
            language = "zh"
        directions = await http_client.get(
            GOOGLE_DIRECTIONS_URL,
            params={
                "origin": origin,
                "destination": destination,
                "mode": "walking",
                "language": language or "zh",
                "key": google_key,
            },
        )
        directions.raise_for_status()
        body = directions.json()
    except httpx.HTTPError as exc:
        warnings.append({
            "code": "google_route_request_failed",
            "message": f"Google 路线解析请求失败：{exc}",
        })
        return _manual_preview(settings, google_configured=True, warnings=warnings)

    status = _text(body.get("status")) if isinstance(body, dict) else "UNKNOWN"
    if status != "OK":
        warnings.append({
            "code": "google_route_status",
            "message": f"Google 路线解析未返回可用路线：{status}",
        })
        return _manual_preview(settings, google_configured=True, warnings=warnings)

    route = (body.get("routes") or [{}])[0]
    leg = (route.get("legs") or [{}])[0]
    steps = [step for step in (leg.get("steps") or []) if isinstance(step, dict)]
    sampled_steps = _sample_google_steps(steps)
    nodes: list[dict[str, Any]] = []
    for idx, step in enumerate(sampled_steps, start=1):
        start = _lat_lng(step.get("start_location"))
        end = _lat_lng(step.get("end_location"))
        lat, lng = start
        try:
            metadata = await _street_view_metadata(http_client, api_key=google_key, lat=lat, lng=lng)
        except httpx.HTTPError:
            metadata = {"status": "REQUEST_FAILED", "pano_id": None, "lat": None, "lng": None}
        nodes.append({
            "id": f"google-step-{idx}",
            "label": f"路线节点 {idx}",
            "instruction": _strip_html(step.get("html_instructions")) or None,
            "lat": lat,
            "lng": lng,
            "heading": _heading(start, end),
            "distance_text": _distance_label(step.get("distance")),
            "duration_text": _duration_label(step.get("duration")),
            "street_view_status": metadata.get("status"),
            "pano_id": metadata.get("pano_id"),
            "street_view_lat": metadata.get("lat"),
            "street_view_lng": metadata.get("lng"),
            "source": "google",
        })

    summary = _strip_html(route.get("summary")) or route_notes or f"{origin} → {destination}"
    return {
        "source": "google",
        "google_configured": True,
        "route_ready": bool(nodes or route_notes or refs or (origin and destination)),
        "origin": origin,
        "destination": destination,
        "summary": summary,
        "distance_text": _distance_label(leg.get("distance")),
        "duration_text": _duration_label(leg.get("duration")),
        "nodes": nodes,
        "reference_images": refs,
        "warnings": warnings,
        "generated_at": datetime.now(UTC).isoformat(),
    }
