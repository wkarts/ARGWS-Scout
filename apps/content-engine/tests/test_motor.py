import json
import tempfile
import unittest
from pathlib import Path
from PIL import Image

from motor_publicacoes.ingestion import normalize, brl, safe_http_url
from motor_publicacoes.engine import Options, process
from motor_publicacoes.media import read_media
from motor_publicacoes.publications import whatsapp_caption, email_html
from motor_publicacoes.cli import execute

ROOT=Path(__file__).resolve().parents[1]

class MotorTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.raw=json.loads((ROOT/'examples/kabum_entrada_reconstituida.json').read_text(encoding='utf-8'))

    def test_60_products_and_47_relevant(self):
        full=normalize(self.raw, query='RTX 5050')
        self.assertEqual(full['total'],60)
        self.assertEqual(sum(r['query_match'] for r in full['items']),47)
        self.assertEqual(sum(full['warnings_by_type'].values()),19)
        filtered=normalize(self.raw, query='RTX 5050', only_relevant=True)
        self.assertEqual(filtered['total'],47)

    def test_do_not_fabricate_prices_or_urls(self):
        r=normalize(self.raw,query='RTX 5050')['items']
        p=next(p for p in r if p['id']=='1053116')
        self.assertEqual(p['price'],'2299.99')
        self.assertIn('desconto_anunciado_diverge_do_calculado',p['warnings'])
        self.assertTrue(p['requires_review'])
        self.assertTrue('https://www.kabum.com.br' in p['url'])
        self.assertEqual(brl(p['price']),'R$ 2.299,99')
        self.assertNotIn('23%',whatsapp_caption(p))
        self.assertIsNone(safe_http_url('javascript:alert(1)'))

    def test_json_ld_product(self):
        source={'finalUrl':'https://example.com/a', 'data':{'html':'''<html><head><script type="application/ld+json">{"@type":"Product","name":"Tablet 8 polegadas","sku":"001","url":"https://example.com/a","image":["https://images.example.com/a.png"],"offers":{"price":"199.99","priceCurrency":"BRL"}}</script></head></html>'''}}
        p=normalize(source)['items'][0]
        self.assertEqual(p['title'],'Tablet 8 polegadas')
        self.assertEqual(p['price'],'199.99')
        self.assertEqual(p['image_input'],'https://images.example.com/a.png')

    def test_article_without_price_and_html_escape(self):
        p=normalize({'items':[{'id':'x','kind':'artigo','title':'<script>alert(1)</script>', 'url':'https://example.org/a','description':'& conteúdo'}]})['items'][0]
        self.assertIsNone(p['price'])
        self.assertFalse(p['requires_review'])
        self.assertIn('&lt;script&gt;',email_html(p))
        self.assertNotIn('<script>',email_html(p))

    def test_images_local_safe_and_collage(self):
        with tempfile.TemporaryDirectory() as base:
            root=Path(base)
            for id,color in enumerate(['red','blue'],start=1):
                Image.new('RGB',(160,160),color).save(root/f'{id}.png')
            self.assertIsNone(read_media('../../etc/passwd',media_root=root,fetch_images=False)[0])
            obj={'items':[{'id':'demo','title':'Exemplo dupla imagem','price':'100.00', 'url':'https://example.org/p', 'images':['1.png','2.png']}]}
            job,m=process(obj,root/'out',Options(media_root=root,create_wide=True,create_story=True))
            self.assertEqual(m['total'],1)
            self.assertEqual(m['image_summary']['originais'],1)
            d=job/'publicacoes'/m['items'][0]['slug']
            self.assertTrue((d/'card-square.png').exists())
            self.assertTrue((d/'card-story.png').exists())
            self.assertTrue((d/'email.eml').exists())
            self.assertEqual(m['items'][0]['image']['source_images_count'],2)
            self.assertEqual(m['messages_sent'],0)

    def test_approval_gates_sending(self):
        with tempfile.TemporaryDirectory() as base:
            root=Path(base)
            p={'items':[{'id':'one','title':'Teste','url':'https://example.com/p','price':'5.00'}]}
            job,manifest=process(p,root,Options(create_wide=False))
            self.assertNotEqual(manifest['items'][0]['status'],'aprovado')
            with self.assertRaises(ValueError):
                execute(['send','--job',str(job),'--id','one','--channel','whatsapp','--to','5575999998888'])
            result=execute(['approve','--job',str(job),'--all-clean','--reviewer','teste'])
            self.assertEqual(result,0)
            approved=json.loads((job/'manifest.json').read_text())
            self.assertEqual(approved['items'][0]['status'],'aprovado')
            self.assertEqual(approved['messages_sent'],0)

if __name__=='__main__': unittest.main()
