"""Contratos do refinamento ligado ao Scout: sem DB, sem rede externa."""
import asyncio
import os
import tempfile
from pathlib import Path
from unittest import TestCase
from unittest.mock import patch

import httpx

from motor_publicacoes.ingestion import normalize, format_money
from motor_publicacoes.publications import whatsapp_caption
from api import app
import api as service


class GenericCaptureTests(TestCase):
    def test_existing_scout_json_http_wrapper(self):
        source = {
            "requestedUrl": "https://catalogo.example.com/api/products",
            "finalUrl": "https://catalogo.example.com/api/products",
            "capturedAt": "2026-10-10T20:21:02Z",
            "data": {"value": {"products": [{
                "id": "x1", "name": "Câmera compacta", "price": "25.55",
                "currency": "USD", "url": "https://catalogo.example.com/produtos/x1",
                "images": ["https://cdn.example.com/x1.png"],
            }]}}
        }
        result = normalize(source)
        self.assertEqual(result["total"], 1)
        self.assertEqual(result["items"][0]["title"], "Câmera compacta")
        self.assertEqual(result["items"][0]["currency"], "USD")
        self.assertEqual(format_money("25.55", "USD"), "US$ 25,55")
        self.assertNotIn("no Pix", whatsapp_caption(result["items"][0]))
        self.assertEqual(result["items"][0]["source"]["captured_at"], "2026-10-10T20:21:02Z")

    def test_new_html_extractor_jsonld_and_images(self):
        raw = {"finalUrl": "https://loja.example.com/objetos", "data": {
            "structuredData": [{"@context": "https://schema.org", "@type": "Product",
                 "sku": "OBJETOP", "name": "Produto de teste", "url": "https://loja.example.com/p/1",
                 "image": "/media/foto.png", "offers": {"price": "37.15", "priceCurrency": "EUR"}}],
            "openGraph": {"title": "Página"},
        }}
        p = normalize(raw)["items"][0]
        self.assertEqual(p["price"], "37.15")
        self.assertEqual(p["currency"], "EUR")
        self.assertEqual(p["image_input"], "https://loja.example.com/media/foto.png")

    def test_mixed_links_preserves_same_registrable_domain(self):
        raw = {"finalUrl": "https://lista.mercadolivre.com.br/cameras", "data": {"links": [
            {"href":"https://produto.mercadolivre.com.br/MLB-123-camera-compacta",
             "text":"Câmera compacta digital 2026 R$ 1.299,90", "image_url":"https://fotos.mercadolivre.com.br/obj.jpg"},
            {"href":"https://outrosite.com.br/produto/999", "text":"Menu exclusivo R$ 1.999,99"}
        ]}}
        rows = normalize(raw)["items"]
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["price"], "1299.90")
        self.assertEqual(rows[0]["image_input"], "https://fotos.mercadolivre.com.br/obj.jpg")

    def test_duplicate_source_ids_do_not_collide(self):
        rows = normalize({"items":[
            {"id":"dup", "title":"Oferta A", "url":"https://example.org/produto/a"},
            {"id":"dup", "title":"Oferta B", "url":"https://example.org/produto/b"}
        ]})["items"]
        self.assertNotEqual(rows[0]["id"], rows[1]["id"])
        self.assertIn("identificador_original_repetido", rows[1]["warnings"])

    def test_open_graph_fallback_is_noncommercial(self):
        rows = normalize({"finalUrl":"https://jornal.example.org/texto",
            "data":{"openGraph":{"title":"Notícia relevante", "image":"https://cdn.example.org/thumb.png"},
                    "text":"Algo aconteceu no mundo; reportagens e informações importantes."}})["items"]
        self.assertEqual(rows[0]["kind"], "artigo")
        self.assertFalse(rows[0]["requires_review"])


class PrivateApiTests(TestCase):
    def test_authenticated_process_and_cleanup(self):
        async def exercise(root: Path):
            service.ROOT = root
            transport = httpx.ASGITransport(app=app)
            async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
                body = {"payload": {"items": [{"id": "one", "kind": "artigo", "title": "Notícia individual",
                    "url": "https://example.com/news/one", "description": "Resumo sem preço"}]},
                        "options": {"max_items": 3, "create_story": True}}
                self.assertEqual((await client.post("/v1/process", json=body)).status_code, 503)
                with patch.dict(os.environ,{"SCOUT_CONTENT_ENGINE_KEY":"x"*40}):
                    self.assertEqual((await client.post("/v1/process", json=body)).status_code,401)
                    headers={"x-api-key":"x"*40}
                    result=await client.post("/v1/process",json=body,headers=headers)
                    self.assertEqual(result.status_code, 200, result.text)
                    obj=result.json()
                    self.assertEqual(obj["total"], 1)
                    job=obj["job_id"]
                    manifest=await client.get(f"/v1/jobs/{job}/manifest",headers=headers)
                    self.assertEqual(manifest.status_code,200)
                    self.assertEqual(manifest.json()["messages_sent"],0)
                    slug=manifest.json()["items"][0]["slug"]
                    png=await client.get(f"/v1/jobs/{job}/files/publicacoes/{slug}/card-square.png",headers=headers)
                    self.assertEqual(png.status_code,200)
                    self.assertTrue(png.content.startswith(b"\x89PNG"))
                    self.assertEqual((await client.get(f"/v1/jobs/{job}/files/../../etc/passwd",headers=headers)).status_code,404)
                    self.assertEqual((await client.delete(f"/v1/jobs/{job}",headers=headers)).status_code,200)
                    self.assertEqual((await client.get(f"/v1/jobs/{job}/manifest",headers=headers)).status_code,404)
        with tempfile.TemporaryDirectory() as tmp:
            with patch.dict(os.environ,{},clear=False):
                os.environ.pop("SCOUT_CONTENT_ENGINE_KEY",None)
                asyncio.run(exercise(Path(tmp)))

    def test_process_failure_cleans_temporary_staging(self):
        async def exercise(root: Path):
            service.ROOT = root
            transport = httpx.ASGITransport(app=app)
            with patch.dict(os.environ,{"SCOUT_CONTENT_ENGINE_KEY":"y"*40}):
                with patch.object(service,"process",side_effect=ValueError("simulacao_falha")):
                    async with httpx.AsyncClient(transport=transport,base_url="http://testserver") as client:
                        result = await client.post("/v1/process",json={"payload":{"items":[{"title":"teste"}]}},headers={"x-api-key":"y"*40})
                        self.assertEqual(result.status_code,422)
                        staging=root/".staging"
                        self.assertTrue(staging.exists())
                        self.assertEqual(list(staging.iterdir()),[])
        with tempfile.TemporaryDirectory() as tmp:
            asyncio.run(exercise(Path(tmp)))
