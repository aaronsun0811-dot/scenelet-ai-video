from lib.default_duration import normalize_project_default_duration


def test_legacy_implicit_drama_duration_is_auto():
    assert normalize_project_default_duration({"content_mode": "drama", "default_duration": 8}) is None


def test_legacy_implicit_narration_duration_is_auto():
    assert normalize_project_default_duration({"content_mode": "narration", "default_duration": 4}) is None


def test_explicit_duration_is_preserved_even_when_matching_mode_default():
    assert (
        normalize_project_default_duration(
            {"content_mode": "drama", "default_duration": 8, "default_duration_explicit": True}
        )
        == 8
    )


def test_non_implicit_duration_is_preserved():
    assert normalize_project_default_duration({"content_mode": "drama", "default_duration": "6"}) == 6
