"""Regressões: fotos oficiais, prévias privadas e fallback honesto."""
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from PIL import Image

from motor_publicacoes.engine import Options, process
from motor_publicacoes.media import image_from_product_html, safe_online_image_url


def cheap_card(item, output, *, kind, original, accent):
    output.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", (48, 48), "white").save(output)
    return {
        "file": output.name,
        "width": 48,
        "height": 48,
        "source_image_used": bool(original),
        "source_images_count": len(original),
        "fallback_is_illustrative": not bool(original),
    }


class OfficialImagesTests(unittest.TestCase):
    def test_enrichment_covers_all_items_and_stores_official_preview(self):
        products = [
            {"id": str(i), "title": f"Produto oficial modelo {i}",
             "url": f"https://loja.example.com/produto/{i}",
             "kind": "produto", "price": "10.00"}
            for i in range(12)
        ]
        source = {"finalUrl": "https://loja.example.com/busca",
                  "data": {"items": products}}
        photos = []
        def fake_media(spec, *, media_root, fetch_images):
            self.assertTrue(fetch_images)
            photos.append(spec)
            return Image.new("RGB", (120, 90), "blue"), spec, None
        with tempfile.TemporaryDirectory() as temp:
            with patch("motor_publicacoes.engine.fetch_public_html", return_value="<html></html>"), \
                 patch("motor_publicacoes.engine.image_from_product_html",
                       return_value="https://cdn.example.com/produto.webp"), \
                 patch("motor_publicacoes.engine.read_media", side_effect=fake_media), \
                 patch("motor_publicacoes.engine.render_card", side_effect=cheap_card):
                directory, manifest = process(
                    source, Path(temp),
                    Options(max_items=12, enrich_images=True, fetch_images=True,
                            enrich_limit=12, enrich_delay=0, create_wide=False))
            self.assertEqual(len(photos), 12)
            self.assertEqual(manifest["image_summary"]["originais"], 12)
            for entry in manifest["items"]:
                self.assertEqual(entry["image"]["original_file"], "original.webp")
                self.assertTrue((directory / "publicacoes" / entry["slug"] / "original.webp").exists())
            normalized = json.loads((directory / "registros_refinados.json").read_text())
            self.assertTrue(all(x["image_status"] == "stored" for x in normalized["items"]))

    def test_online_source_is_kept_when_download_fails(self):
        source = {"finalUrl": "https://loja.example.com/busca", "data": {"items": [{
            "id": "1", "title": "Produto teste oficial", "kind": "produto",
            "price": "100.00", "url": "https://loja.example.com/produto/1",
            "image_url": "https://cdn.example.com/foto.jpg",
        }]}}
        with tempfile.TemporaryDirectory() as temp:
            with patch("motor_publicacoes.engine.read_media",
                       return_value=(None, None, "erro_imagem:HTTP403")), \
                 patch("motor_publicacoes.engine.safe_online_image_url",
                       return_value="https://cdn.example.com/foto.jpg"), \
                 patch("motor_publicacoes.engine.render_card", side_effect=cheap_card):
                directory, manifest = process(source, Path(temp),
                    Options(fetch_images=True, enrich_images=False, create_wide=False))
            self.assertEqual(manifest["image_summary"].get("originais", 0), 0)
            self.assertEqual(manifest["image_summary"]["online"], 1)
            self.assertEqual(manifest["image_summary"]["ilustrativas"], 1)
            item = json.loads((directory / "registros_refinados.json").read_text())["items"][0]
            self.assertEqual(item["image_status"], "online")
            self.assertEqual(item["image_online_url"], "https://cdn.example.com/foto.jpg")
            self.assertFalse((directory / "publicacoes" / manifest["items"][0]["slug"] / "original.webp").exists())

    def test_metadata_rejects_recommended_different_product(self):
        html = """<html><head><title>Produto correto 5050</title>
        <script type="application/ld+json">
        {"@type":"Product","name":"Produto errado 6060","image":"https://cdn.example.com/outro.webp"}
        </script><meta property="og:image" content="https://cdn.example.com/certo.webp">
        </head></html>"""
        actual = image_from_product_html(html, "https://loja.example.com/produto/1",
                                         expected_title="Produto correto 5050")
        self.assertEqual(actual, "https://cdn.example.com/certo.webp")
        self.assertIsNone(image_from_product_html(
            "<html><head><title>Just a moment...</title><meta property=\"og:image\" content=\"https://cdn.example.com/logo.png\"></head></html>",
            "https://loja.example.com/produto/1", expected_title="Produto correto 5050"))

    def test_remote_preview_rejects_private_and_non_https_links(self):
        with patch("motor_publicacoes.media._resolve_public_ip", return_value="93.184.215.14"):
            self.assertIsNone(safe_online_image_url("http://cdn.example.com/foto.png"))
            self.assertIsNone(safe_online_image_url("https://user:pass@cdn.example.com/foto.png"))
            self.assertIsNone(safe_online_image_url("https://cdn.example.com:8443/foto.png"))
            self.assertEqual(safe_online_image_url("https://cdn.example.com/foto.png"),
                             "https://cdn.example.com/foto.png")


if __name__ == "__main__":
    unittest.main()
