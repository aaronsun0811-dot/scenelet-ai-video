"""HTML renderers for the project archive service.

Extracted from ``project_archive.py`` so the main module stops being a god file.
Pure functions — no service state required, just take a manifest dict in and
return rendered HTML.
"""

from __future__ import annotations

import html as html_lib
from typing import Any


def render_travel_route_assets_html(manifest: dict[str, Any]) -> str:
    """Render the travel-route asset manifest as a standalone dark-mode HTML page."""
    route = manifest.get("route") if isinstance(manifest.get("route"), dict) else {}
    coverage = manifest.get("node_coverage") if isinstance(manifest.get("node_coverage"), dict) else {}
    refs = manifest.get("reference_images") if isinstance(manifest.get("reference_images"), dict) else {}
    ref_items = refs.get("items") if isinstance(refs.get("items"), list) else []
    nodes = manifest.get("nodes") if isinstance(manifest.get("nodes"), list) else []

    def esc(value: Any) -> str:
        return html_lib.escape(str(value or ""), quote=True)

    def stat(label: str, value: Any) -> str:
        return (
            '<div class="stat">'
            f'<span>{esc(label)}</span>'
            f'<strong>{esc(value)}</strong>'
            "</div>"
        )

    node_cards: list[str] = []
    for index, node in enumerate(nodes, start=1):
        if not isinstance(node, dict):
            continue
        covered = bool(node.get("covered"))
        matched_units = node.get("matched_units") if isinstance(node.get("matched_units"), list) else []
        matched_unit_details = (
            node.get("matched_unit_details") if isinstance(node.get("matched_unit_details"), list) else []
        )
        unit_details_by_id = {
            item.get("id"): item
            for item in matched_unit_details
            if isinstance(item, dict) and isinstance(item.get("id"), str)
        }
        reference_images = node.get("reference_images") if isinstance(node.get("reference_images"), list) else []
        matched_pills: list[str] = []
        for unit in matched_units:
            if not isinstance(unit, str) or not unit.strip():
                continue
            detail = unit_details_by_id.get(unit)
            extra = ""
            if isinstance(detail, dict):
                episode = detail.get("episode")
                title = esc(detail.get("title"))
                if isinstance(episode, int) and not isinstance(episode, bool):
                    extra = f" · E{episode}"
                if title:
                    extra = f"{extra} · {title}" if extra else f" · {title}"
            matched_pills.append(f'<span class="pill">{esc(unit)}{extra}</span>')
        matched_html = "".join(matched_pills) or '<span class="muted">未匹配视频单元</span>'
        refs_html = "".join(
            f'<span class="pill soft">{esc(ref)}</span>'
            for ref in reference_images
            if isinstance(ref, str) and ref.strip()
        ) or '<span class="muted">未绑定参考图</span>'
        node_meta = " · ".join(
            part
            for part in (
                esc(node.get("source") or "unknown"),
                esc(node.get("distance_text")),
                esc(node.get("duration_text")),
                esc(node.get("street_view_status")),
            )
            if part
        )
        node_cards.append(
            '<article class="card node-card">'
            '<div class="card-head">'
            f'<span class="index">{index:02d}</span>'
            f'<span class="badge {"ok" if covered else "warn"}">{"已覆盖" if covered else "未覆盖"}</span>'
            "</div>"
            f'<h3>{esc(node.get("label") or node.get("id") or f"路线节点 {index}")}</h3>'
            f'<p class="instruction">{esc(node.get("instruction") or "暂无节点说明")}</p>'
            f'<p class="meta">{node_meta or "无额外路线元数据"}</p>'
            '<div class="section-label">匹配视频单元</div>'
            f'<div class="pill-row">{matched_html}</div>'
            '<div class="section-label">关联参考图</div>'
            f'<div class="pill-row">{refs_html}</div>'
            "</article>"
        )

    ref_cards: list[str] = []
    for item in ref_items:
        if not isinstance(item, dict):
            continue
        path = item.get("path")
        html_src = item.get("html_src")
        usable = bool(item.get("usable"))
        used_by_nodes = item.get("used_by_nodes") if isinstance(item.get("used_by_nodes"), list) else []
        used_by_html = ", ".join(
            esc(node_id)
            for node_id in used_by_nodes
            if isinstance(node_id, str) and node_id.strip()
        ) or "未绑定节点"
        preview = (
            f'<img src="{esc(html_src)}" alt="{esc(path)}">'
            if isinstance(html_src, str) and html_src.strip()
            else '<div class="missing-preview">未打包或不可预览</div>'
        )
        ref_cards.append(
            '<article class="card ref-card">'
            f'<div class="thumb">{preview}</div>'
            f'<span class="badge {"ok" if usable else "warn"}">{"可用" if usable else "缺失"}</span>'
            f'<h3>{esc(path)}</h3>'
            f'<p class="meta">类型: {esc(item.get("kind") or "local")}</p>'
            f'<p class="meta">关联节点: {used_by_html}</p>'
            "</article>"
        )

    if not node_cards:
        node_cards.append('<div class="empty">暂无路线节点。</div>')
    if not ref_cards:
        ref_cards.append('<div class="empty">暂无参考图。</div>')

    route_status = "已预检" if route.get("route_ready") else "未通过/未预检"
    origin_destination = " / ".join(
        part
        for part in (
            esc(route.get("origin") or "-"),
            esc(route.get("destination") or "-"),
        )
        if part
    )
    stats_html = "".join(
        [
            stat("路线状态", route_status),
            stat("路线节点覆盖", f"{coverage.get('covered', 0)} / {coverage.get('total', 0)}"),
            stat("参考图数量", f"{refs.get('usable', 0)} / {refs.get('total', 0)} 可用"),
            stat("路线来源", route.get("source") or "-"),
        ]
    )

    return f"""<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Scenelet 旅游路线素材清单</title>
  <style>
    :root {{
      color-scheme: dark;
      --bg: #070b14;
      --panel: #101827;
      --panel-soft: #152033;
      --border: #243247;
      --text: #edf4ff;
      --muted: #8fa0b8;
      --accent: #77e0c6;
      --warn: #ffc36b;
    }}
    * {{ box-sizing: border-box; }}
    body {{
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font: 15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }}
    main {{
      max-width: 1180px;
      margin: 0 auto;
      padding: 32px 24px 48px;
    }}
    header {{
      display: grid;
      gap: 12px;
      padding-bottom: 24px;
      border-bottom: 1px solid var(--border);
    }}
    h1, h2, h3, p {{ margin: 0; }}
    h1 {{ font-size: 28px; }}
    h2 {{ margin: 28px 0 12px; font-size: 18px; }}
    h3 {{ margin-top: 10px; font-size: 14px; word-break: break-word; }}
    .summary {{ color: var(--muted); max-width: 820px; }}
    .stats {{
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 10px;
      margin-top: 16px;
    }}
    .stat, .card {{
      border: 1px solid var(--border);
      background: var(--panel);
      border-radius: 10px;
    }}
    .stat {{ padding: 12px; }}
    .stat span, .meta, .muted {{ color: var(--muted); }}
    .stat strong {{ display: block; margin-top: 4px; font-size: 18px; }}
    .grid {{
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
      gap: 12px;
    }}
    .card {{ padding: 14px; }}
    .card-head {{ display: flex; align-items: center; justify-content: space-between; gap: 8px; }}
    .index {{ font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--muted); }}
    .badge {{
      display: inline-flex;
      align-items: center;
      border-radius: 999px;
      padding: 2px 8px;
      font-size: 12px;
      border: 1px solid currentColor;
    }}
    .badge.ok {{ color: var(--accent); background: rgba(119, 224, 198, .1); }}
    .badge.warn {{ color: var(--warn); background: rgba(255, 195, 107, .1); }}
    .instruction {{ margin-top: 8px; color: #cbd7ea; min-height: 48px; }}
    .section-label {{ margin-top: 12px; color: var(--muted); font-size: 12px; }}
    .pill-row {{ display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }}
    .pill {{
      border-radius: 6px;
      padding: 3px 7px;
      background: rgba(119, 224, 198, .12);
      color: #b8f7e8;
      font-size: 12px;
      word-break: break-all;
    }}
    .pill.soft {{ background: rgba(143, 160, 184, .14); color: #d3dceb; }}
    .thumb {{
      position: relative;
      aspect-ratio: 16 / 9;
      overflow: hidden;
      border-radius: 8px;
      border: 1px solid var(--border);
      background: var(--panel-soft);
    }}
    .thumb img {{ width: 100%; height: 100%; object-fit: cover; display: block; }}
    .missing-preview {{
      height: 100%;
      display: grid;
      place-items: center;
      color: var(--muted);
      font-size: 13px;
    }}
    .ref-card .badge {{ margin-top: 10px; }}
    .empty {{
      border: 1px dashed var(--border);
      border-radius: 10px;
      padding: 18px;
      color: var(--muted);
      background: rgba(16, 24, 39, .5);
    }}
  </style>
</head>
<body>
  <main>
    <header>
      <h1>Scenelet 旅游路线素材清单</h1>
      <p class="summary">{esc(route.get("summary") or "暂无路线摘要")}</p>
      <p class="meta">出发地 / 目的地: {origin_destination}</p>
      <p class="meta">路线距离 / 预计时长: {esc(route.get("distance_text") or "-")} / {esc(route.get("duration_text") or "-")}</p>
      <div class="stats">{stats_html}</div>
    </header>

    <section>
      <h2>路线节点覆盖</h2>
      <div class="grid">{"".join(node_cards)}</div>
    </section>

    <section>
      <h2>参考图清单</h2>
      <div class="grid">{"".join(ref_cards)}</div>
    </section>
  </main>
</body>
</html>
"""


__all__ = ["render_travel_route_assets_html"]
