import pytest

from server.services.travel_route import build_travel_route_preview, fetch_travel_route_street_view_image


class _FakeResponse:
    def __init__(self, payload=None, *, content=b"", headers=None):
        self.payload = payload
        self.content = content
        self.headers = headers or {}

    def raise_for_status(self):
        return None

    def json(self):
        return self.payload


class _FakeGoogleClient:
    def __init__(self):
        self.calls = []

    async def get(self, url, params):
        self.calls.append((url, params))
        if "directions" in url:
            return _FakeResponse({
                "status": "OK",
                "routes": [
                    {
                        "summary": "Sennichimae Dori",
                        "legs": [
                            {
                                "distance": {"text": "1.2 km"},
                                "duration": {"text": "15 mins"},
                                "steps": [
                                    {
                                        "html_instructions": "Head <b>east</b>",
                                        "start_location": {"lat": 34.665, "lng": 135.501},
                                        "end_location": {"lat": 34.666, "lng": 135.502},
                                        "distance": {"text": "300 m"},
                                        "duration": {"text": "4 mins"},
                                    }
                                ],
                            }
                        ],
                    }
                ],
            })
        return _FakeResponse({
            "status": "OK",
            "pano_id": "pano-demo",
            "location": {"lat": 34.6651, "lng": 135.5011},
        })


class _FakeStreetViewImageClient:
    def __init__(self):
        self.calls = []

    async def get(self, url, params):
        self.calls.append((url, params))
        return _FakeResponse(content=b"jpeg-bytes", headers={"content-type": "image/jpeg; charset=utf-8"})


class _FakeDomesticMapsClient:
    def __init__(self):
        self.calls = []

    async def get(self, url, params):
        self.calls.append((url, params))
        if "restapi.amap.com/v3/geocode/geo" in url:
            address = params["address"]
            location = "135.501,34.665" if "难波" in address else "135.506,34.668"
            return _FakeResponse({"status": "1", "geocodes": [{"location": location}]})
        if "restapi.amap.com/v3/direction/walking" in url:
            return _FakeResponse({
                "status": "1",
                "route": {
                    "paths": [
                        {
                            "distance": "1200",
                            "duration": "900",
                            "steps": [
                                {
                                    "instruction": "沿千日前通向东步行",
                                    "distance": "300",
                                    "duration": "240",
                                    "polyline": "135.501,34.665;135.502,34.666",
                                }
                            ],
                        }
                    ]
                },
            })
        if "api.map.baidu.com/geocoding/v3" in url:
            address = params["address"]
            location = {"lat": 34.665, "lng": 135.501} if "难波" in address else {"lat": 34.668, "lng": 135.506}
            return _FakeResponse({"status": 0, "result": {"location": location}})
        if "api.map.baidu.com/directionlite/v1/walking" in url:
            return _FakeResponse({
                "status": 0,
                "result": {
                    "routes": [
                        {
                            "distance": 1200,
                            "duration": 900,
                            "steps": [
                                {
                                    "instruction": "沿千日前通向东步行",
                                    "distance": 300,
                                    "duration": 240,
                                    "path": "135.501,34.665;135.502,34.666",
                                }
                            ],
                        }
                    ]
                },
            })
        raise AssertionError(f"unexpected url: {url}")


@pytest.mark.asyncio
async def test_build_google_travel_route_preview_samples_steps_and_street_view():
    client = _FakeGoogleClient()

    preview = await build_travel_route_preview(
        {
            "origin": "大阪难波站",
            "destination": "黑门市场",
            "route_source": "google_street_view",
            "narration_language": "zh",
        },
        google_maps_api_key="AIza-demo",
        http_client=client,
    )

    assert preview["source"] == "google"
    assert preview["route_ready"] is True
    assert preview["summary"] == "Sennichimae Dori"
    assert preview["distance_text"] == "1.2 km"
    assert preview["duration_text"] == "15 mins"
    assert preview["nodes"][0]["instruction"] == "Head east"
    assert preview["nodes"][0]["street_view_status"] == "OK"
    assert preview["nodes"][0]["pano_id"] == "pano-demo"
    assert len(client.calls) == 2


@pytest.mark.asyncio
async def test_build_travel_route_preview_falls_back_without_google_key():
    preview = await build_travel_route_preview(
        {
            "origin": "大阪难波站",
            "destination": "黑门市场",
            "route_source": "google_street_view",
            "route_notes": "沿千日前通前进。",
            "reference_images": ["travel_references/map.png"],
        },
        google_maps_api_key="",
    )

    assert preview["source"] == "hybrid"
    assert preview["google_configured"] is False
    assert preview["route_ready"] is True
    assert preview["warnings"][0]["code"] == "google_maps_optional_missing"
    assert any(node["source"] == "reference_image" for node in preview["nodes"])


@pytest.mark.asyncio
async def test_build_travel_route_preview_caps_reference_images_at_ten():
    preview = await build_travel_route_preview(
        {
            "route_source": "reference_images",
            "reference_images": [f"travel_references/ref-{index}.png" for index in range(11)],
        },
        google_maps_api_key="",
    )

    assert len(preview["reference_images"]) == 10
    assert len([node for node in preview["nodes"] if node["source"] == "reference_image"]) == 10


@pytest.mark.asyncio
async def test_build_amap_travel_route_preview_geocodes_and_routes():
    client = _FakeDomesticMapsClient()

    preview = await build_travel_route_preview(
        {
            "origin": "大阪难波站",
            "destination": "黑门市场",
            "route_source": "amap_maps",
        },
        google_maps_api_key="",
        amap_maps_api_key="amap-demo",
        http_client=client,
    )

    assert preview["source"] == "amap"
    assert preview["route_ready"] is True
    assert preview["distance_text"] == "1.2 km"
    assert preview["duration_text"] == "15 mins"
    assert preview["nodes"][0]["source"] == "amap"
    assert preview["nodes"][0]["instruction"] == "沿千日前通向东步行"
    assert len(client.calls) == 3


@pytest.mark.asyncio
async def test_build_baidu_travel_route_preview_geocodes_and_routes():
    client = _FakeDomesticMapsClient()

    preview = await build_travel_route_preview(
        {
            "origin": "大阪难波站",
            "destination": "黑门市场",
            "route_source": "baidu_maps",
        },
        google_maps_api_key="",
        baidu_maps_api_key="baidu-demo",
        http_client=client,
    )

    assert preview["source"] == "baidu"
    assert preview["route_ready"] is True
    assert preview["distance_text"] == "1.2 km"
    assert preview["duration_text"] == "15 mins"
    assert preview["nodes"][0]["source"] == "baidu"
    assert preview["nodes"][0]["instruction"] == "沿千日前通向东步行"
    assert len(client.calls) == 3


@pytest.mark.asyncio
async def test_fetch_travel_route_street_view_image_uses_pano_without_exposing_key():
    client = _FakeStreetViewImageClient()

    image, content_type = await fetch_travel_route_street_view_image(
        {
            "id": "google-step-1",
            "source": "google",
            "pano_id": "pano-demo",
            "heading": 42.34,
        },
        google_maps_api_key="AIza-demo",
        http_client=client,
    )

    assert image == b"jpeg-bytes"
    assert content_type == "image/jpeg"
    _, params = client.calls[0]
    assert params["pano"] == "pano-demo"
    assert params["heading"] == "42.3"
    assert params["key"] == "AIza-demo"
    assert "location" not in params


@pytest.mark.asyncio
async def test_fetch_travel_route_street_view_image_preserves_zero_coordinates():
    client = _FakeStreetViewImageClient()

    await fetch_travel_route_street_view_image(
        {
            "id": "google-step-equator",
            "source": "google",
            "street_view_lat": 0,
            "street_view_lng": 0,
        },
        google_maps_api_key="AIza-demo",
        http_client=client,
    )

    _, params = client.calls[0]
    assert params["location"] == "0.0,0.0"
