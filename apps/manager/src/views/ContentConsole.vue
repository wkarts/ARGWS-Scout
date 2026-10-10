<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { Archive, Check, ClipboardCopy, FileJson, Images, RefreshCw, UploadCloud } from "@lucide/vue";
import { api } from "../api";

type Instance = { id:string; name:string; slug:string };
type Settings = { autoProcess:boolean; query:string; onlyRelevant:boolean; maxItems:number; createStory:boolean; fetchImages:boolean; enrichImages:boolean };
type Job = { id:string; instanceId:string; createdAt:string; source:{name:string}; contentBatch?:{id:string;status:string;total:number}|null };
type Batch = { id:string; jobId:string; status:string; total:number; reviewRequired:number; attempts:number; createdAt:string; finishedAt?:string|null; errorCode?:string|null; instance:{name:string}; _count?:{entries:number} };
type Entry = { id:string; identityId:string; title:string; kind:string; price:string|null; url:string|null; reviewStatus:string; normalized:Record<string,unknown>; channels:Record<string,string>; images:Record<string,string>; warnings:string[] };
const props=defineProps<{role:string;instances:Instance[]}>();
const emit=defineEmits<{error:[string];notify:[string]}>();
const enabled=ref(false);
const instanceId=ref("");
const sourceId=ref("");
const sources=ref<Array<{id:string;name:string}>>([]);
const settings=ref<Settings>({autoProcess:false,query:"",onlyRelevant:false,maxItems:100,createStory:true,fetchImages:false,enrichImages:false});
const jobs=ref<Job[]>([]);
const batches=ref<Batch[]>([]);
const batchId=ref("");
const entries=ref<Entry[]>([]);
const selectedItem=ref<Entry|null>(null);
const jobId=ref("");
const importText=ref("");
const showImport=ref(false);
const busy=ref(false);
const loading=ref(false);
const API_PREFIX=import.meta.env.VITE_API_BASE_URL ?? "/api/v1";
const canOperate=computed(()=>["OWNER","ADMIN","OPERATOR"].includes(props.role));
const canAdmin=computed(()=>["OWNER","ADMIN"].includes(props.role));
const selectedBatch=computed(()=>batches.value.find(b=>b.id===batchId.value));
function media(id:string,kind:"square"|"story"|"wide"|"eml"){return `${API_PREFIX}/content/items/${id}/media/${kind}`;}
function date(value:string|null|undefined) {return value?new Date(value).toLocaleString("pt-BR"):"—";}
function toast(error:unknown){emit("error",error instanceof Error?error.message:"Não foi possível completar a operação.");}
async function loadBatch(id:string){
  batchId.value=id;selectedItem.value=null;
  try {const result=await api<{batch:{entries:Entry[]}}>(`/content/batches/${id}`); entries.value=result.batch.entries;}
  catch(e){toast(e);}
}
async function refresh(){
  loading.value=true;
  try {
    const status=await api<{enabled:boolean}>("/content/status");enabled.value=status.enabled;
    const target=instanceId.value;
    if (!target){ jobs.value=[]; batches.value=[];sources.value=[];entries.value=[];return; }
    const [config,js,bs,ss]=await Promise.all([
      api<{settings:Settings}>(`/content/instances/${target}/settings`),
      api<{data:Job[]}>(`/content/jobs?instanceId=${target}`),
      api<{data:Batch[]}>(`/content/batches?instanceId=${target}`),
      api<{data:Array<{id:string;name:string}>}>(`/instances/${target}/sources`),
    ]);
    settings.value=config.settings;jobs.value=js.data;batches.value=bs.data;sources.value=ss.data;
    if (!sources.value.some(s=>s.id===sourceId.value))sourceId.value=sources.value[0]?.id??"";
    if (!jobs.value.some(j=>j.id===jobId.value))jobId.value=jobs.value.find(j=>!j.contentBatch)?.id??jobs.value[0]?.id??"";
    if (batchId.value && batches.value.some(b=>b.id===batchId.value)) await loadBatch(batchId.value);
    else if(bs.data[0]) await loadBatch(bs.data[0].id);
    else {batchId.value="";entries.value=[];selectedItem.value=null;}
  } catch(e){toast(e);}
  finally{loading.value=false;}
}
watch(()=>props.instances,items=>{
  if (!items.some(i=>i.id===instanceId.value)) instanceId.value=items[0]?.id??"";
},{immediate:true});
watch(instanceId,()=>{batchId.value="";entries.value=[];selectedItem.value=null;void refresh();});
onMounted(()=>{void refresh();});
async function saveSettings(){
  if(!canAdmin.value||busy.value)return;busy.value=true;
  try{
    const result=await api<{settings:Settings}>(`/content/instances/${instanceId.value}/settings`,{
      method:"PATCH",body:JSON.stringify(settings.value)});
    settings.value=result.settings;emit("notify","Configurações de refinamento atualizadas.");
  }catch(e){toast(e);}finally{busy.value=false;}
}
async function refine(){
  if(!canOperate.value||busy.value||!jobId.value)return;busy.value=true;
  try{
    const result=await api<{batch:Batch}>(`/content/jobs/${jobId.value}/refine`,{method:"POST",body:JSON.stringify({
      query:settings.value.query,onlyRelevant:settings.value.onlyRelevant,maxItems:settings.value.maxItems,
      createStory:settings.value.createStory,fetchImages:settings.value.fetchImages,enrichImages:settings.value.enrichImages})});
    emit("notify",`Lote ${result.batch.status.toLowerCase()} para processamento.`);
    await refresh();
  }catch(e){toast(e);}finally{busy.value=false;}
}
async function importCapture(){
  if(!canOperate.value||busy.value||!sourceId.value)return;busy.value=true;
  try{
    const payload=JSON.parse(importText.value);
    await api("/content/import",{method:"POST",body:JSON.stringify({
      instanceId:instanceId.value,sourceId:sourceId.value,payload,
      options:{maxItems:settings.value.maxItems,query:settings.value.query,
        onlyRelevant:settings.value.onlyRelevant,createStory:settings.value.createStory,
        fetchImages:settings.value.fetchImages,enrichImages:settings.value.enrichImages},
    })});
    showImport.value=false;importText.value="";
    emit("notify","Captura importada e encaminhada à fila de refinamento.");
    await refresh();
  }catch(e){toast(e);}finally{busy.value=false;}
}
async function review(item:Entry,status:"APPROVED"|"ARCHIVED"|"DRAFT"){
  if(!canOperate.value||busy.value)return;busy.value=true;
  try{
    const response=await api<{item:Entry}>(`/content/items/${item.id}/review`,{
      method:"PATCH",body:JSON.stringify({status})});
    item.reviewStatus=response.item.reviewStatus;
    emit("notify","Revisão registrada. Nenhuma mensagem foi enviada.");
  }catch(e){toast(e);}finally{busy.value=false;}
}
async function copy(content:string){
  try {await navigator.clipboard.writeText(content);emit("notify","Conteúdo copiado.");}
  catch {emit("error","Não foi possível copiar o conteúdo.");}
}
async function exportItem(item:Entry){
  try {
    const value=await api(`/content/items/${item.id}/export`);
    const blob=new Blob([JSON.stringify(value,null,2)],{type:"application/json"});
    const url=URL.createObjectURL(blob);const anchor=document.createElement("a");anchor.href=url;anchor.download=`publicacao-${item.id}.json`;
    anchor.click();URL.revokeObjectURL(url);
  }catch(e){toast(e);}
}
</script>

<template>
  <section class="panel contents-root">
    <div class="panel-header">
      <div><h2>Refinamento e publicações</h2><p>Transforme capturas de qualquer fonte em registros auditáveis, imagens e modelos individuais de comunicação.</p></div>
      <button class="button outline" :disabled="loading" @click="refresh"><RefreshCw :size="16"/> Atualizar</button>
    </div>
    <div v-if="!enabled" class="notice">O processamento está desativado no ambiente. Para habilitar, configure <code>SCOUT_CONTENT_ENABLED=true</code>, a chave interna e o perfil <code>content</code> do Compose.</div>
    <div class="contents-controls">
      <label>Instância
        <select v-model="instanceId"><option v-for="item in instances" :key="item.id" :value="item.id">{{item.name}}</option></select>
      </label>
      <label>Pesquisa opcional (relevância)
        <input v-model="settings.query" maxlength="150" placeholder="Ex.: RTX 5050" />
      </label>
      <label>Limite por lote
        <input v-model.number="settings.maxItems" type="number" min="1" max="250" />
      </label>
    </div>
    <div class="contents-controls compact-controls">
      <label><input v-model="settings.onlyRelevant" type="checkbox"/> Somente relevantes</label>
      <label><input v-model="settings.createStory" type="checkbox"/> Produzir formato vertical</label>
      <label><input v-model="settings.fetchImages" type="checkbox"/> Obter fotografias originais fornecidas (HTTPS público)</label>
      <label><input v-model="settings.enrichImages" type="checkbox"/> Consultar páginas originais para descobrir imagens (limitado)</label>
      <label><input v-model="settings.autoProcess" :disabled="!canAdmin" type="checkbox"/> Refinar automaticamente após coleta concluída</label>
      <button class="button outline" :disabled="!canAdmin||busy||!instanceId" @click="saveSettings">Salvar por instância</button>
    </div>
    <div class="contents-controls actions">
      <label>Coleta concluída
        <select v-model="jobId"><option v-for="job in jobs" :key="job.id" :value="job.id">{{job.source.name}} · {{date(job.createdAt)}} · {{job.contentBatch?.status??'Ainda não refinada'}}</option></select>
      </label>
      <button class="button primary" :disabled="!enabled||!canOperate||!jobId||busy" @click="refine"><Images :size="15"/> Criar publicações</button>
      <button class="button outline" :disabled="!enabled||!canOperate||busy||!sources.length" @click="showImport=!showImport"><UploadCloud :size="15"/> Importar JSON</button>
    </div>
    <div v-if="showImport" class="import-panel">
      <h3>Importar retorno já capturado</h3>
      <p>Associe o retorno a uma fonte da instância. A importação não visita o site nem altera a captura original.</p>
      <label>Fonte associada<select v-model="sourceId"><option v-for="source in sources" :key="source.id" :value="source.id">{{source.name}}</option></select></label>
      <textarea v-model="importText" rows="9" spellcheck="false" placeholder='Cole o objeto JSON com data.links, products, items, html, title ou JSON-LD'/>
      <button class="button primary" :disabled="busy||!importText.trim()" @click="importCapture">Importar e processar</button>
    </div>
    <div class="batch-section">
      <h3>Histórico dos lotes</h3>
      <div v-if="!batches.length" class="empty-state compact">Nenhum lote refinado nesta instância.</div>
      <div v-else class="batch-list">
        <button v-for="batch in batches" :key="batch.id" class="batch-option" :class="{active:batchId===batch.id}" @click="loadBatch(batch.id)">
          <strong>{{date(batch.createdAt)}}</strong><span>{{batch.status}} · {{batch.total||batch._count?.entries||0}} itens</span>
          <span v-if="batch.errorCode" class="warning">{{batch.errorCode}}</span>
          <small>{{batch.reviewRequired}} pendentes de revisão na extração</small>
        </button>
      </div>
    </div>
    <div v-if="selectedBatch" class="batch-section">
      <h3>Publicações individuais · {{selectedBatch.status}}</h3>
      <p v-if="selectedBatch.status==='QUEUED'||selectedBatch.status==='RUNNING'">O worker está preparando as artes. Use Atualizar para consultar o progresso.</p>
      <p v-if="selectedBatch.status==='FAILED'" class="warning">Falha no refinamento. Código: {{selectedBatch.errorCode||'REFINEMENT_FAILED'}}. É possível reenfileirar a coleta na seleção acima.</p>
      <div class="publications-grid">
        <article v-for="item in entries" :key="item.id" class="publication-tile">
          <img v-if="item.images.square" :src="media(item.id,'square')" :alt="item.title" loading="lazy" />
          <div class="publication-details">
            <strong :title="item.title">{{item.title}}</strong>
            <small>{{item.kind}} · {{item.reviewStatus}}</small>
            <p v-if="item.price">{{item.normalized.currency==='BRL'?'R$ ':String(item.normalized.currency||'')+' '}}{{Number(item.price).toLocaleString('pt-BR',{minimumFractionDigits:2})}}</p>
            <span v-if="item.warnings?.length" class="warning">{{item.warnings.length}} advertência(s)</span>
            <button class="button outline" @click="selectedItem=item">Ver e revisar</button>
          </div>
        </article>
      </div>
    </div>
    <div v-if="selectedItem" class="preview-panel">
      <div class="panel-header"><h3>Prévia e aprovação individual</h3><button class="button outline" @click="selectedItem=null">Fechar prévia</button></div>
      <div class="preview-layout">
        <img :src="media(selectedItem.id,'square')" :alt="selectedItem.title" class="preview-media" />
        <div class="preview-copy">
          <h3>{{selectedItem.title}}</h3>
          <p v-if="selectedItem.warnings?.length" class="warning">Advertências: {{selectedItem.warnings.join(', ')}}</p>
          <div v-for="channel in ['whatsapp','telegram','emailText','instagram','facebook','linkedin','sms']" :key="channel" class="caption-preview">
            <div><strong>{{channel==='emailText'?'E-mail':channel}}</strong><button class="button outline" @click="copy(selectedItem!.channels[channel]||'')"><ClipboardCopy :size="14"/> Copiar</button></div>
            <pre>{{selectedItem.channels[channel]}}</pre>
          </div>
          <div class="review-actions">
            <button class="button primary" :disabled="!canOperate||busy||(selectedItem.reviewStatus==='REVIEW'&&!canAdmin)" @click="review(selectedItem!,'APPROVED')"><Check :size="15"/> Aprovar</button>
            <button class="button outline" :disabled="!canOperate||busy" @click="review(selectedItem!,'DRAFT')">Rascunho</button>
            <button class="button outline" :disabled="!canOperate||busy" @click="review(selectedItem!,'ARCHIVED')"><Archive :size="15"/> Arquivar</button>
            <button class="button outline" @click="exportItem(selectedItem!)"><FileJson :size="15"/> Exportar JSON</button>
            <a class="button outline" :href="media(selectedItem.id,'eml')" download>Baixar e-mail EML</a>
          </div>
        </div>
      </div>
      <p class="notice">Aprovação não realiza envio. As mensagens são rascunhos para uso nos canais autorizados.</p>
    </div>
  </section>
</template>

<style scoped>
.contents-root{min-width:0;display:flex;flex-direction:column;gap:18px}
.contents-root .panel-header{display:flex;flex-wrap:wrap;gap:16px;align-items:center;justify-content:space-between}
.contents-root h3{font-size:16px;margin:0 0 8px;color:#18283f}
.contents-root p{line-height:1.5}
.contents-controls{display:grid;grid-template-columns:minmax(160px,1fr) minmax(200px,1fr) minmax(100px,160px);gap:12px;align-items:end}
.contents-controls.actions{grid-template-columns:minmax(160px,1fr) auto auto}
.contents-controls label,.import-panel label{display:flex;flex-direction:column;gap:8px;font-size:12px;font-weight:700;color:#526176;min-width:0}
.contents-controls select,.contents-controls input:not([type=checkbox]),.import-panel select,.import-panel textarea{background:white;border:1px solid #d8e2ed;padding:11px 10px;border-radius:10px;color:#162639;font:inherit;width:100%;min-width:0}
.contents-controls select{overflow:hidden;text-overflow:ellipsis}
.compact-controls{display:flex;align-items:center;flex-wrap:wrap;gap:18px}.compact-controls label{flex-direction:row;align-items:center;gap:7px}
.notice{border:1px solid #d4e4f2;background:#f3f8fe;color:#345377;padding:12px 14px;border-radius:10px;font-size:13px}
.warning{color:#a34e11;font-size:12px}.batch-section{border-top:1px solid #e6ecf3;padding-top:20px;min-width:0}
.batch-list{display:flex;gap:10px;flex-wrap:wrap}.batch-option{min-width:150px;max-width:240px;flex:1;border:1px solid #e0e8f1;background:#fff;padding:12px;border-radius:11px;text-align:left;display:flex;flex-direction:column;gap:6px;cursor:pointer;color:#23334a}
.batch-option.active{border-color:#367dda;background:#f2f8ff}.batch-option span,.batch-option small{font-size:12px;color:#64748b}
.publications-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:14px}
.publication-tile{border:1px solid #e0e8f1;border-radius:12px;overflow:hidden;min-width:0;background:#fff}
.publication-tile>img{display:block;width:100%;aspect-ratio:1;object-fit:contain;background:#f5f7fa}
.publication-details{padding:14px;display:flex;flex-direction:column;align-items:flex-start;gap:9px}
.publication-details strong{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;font-size:13px;line-height:1.5}
.publication-details small{color:#6a7890}.publication-details p{font-weight:700;margin:0}.publication-details .button{width:100%;justify-content:center}
.preview-panel{border-top:1px solid #d8e2ec;padding-top:20px}.preview-layout{display:grid;grid-template-columns:minmax(190px,340px) minmax(0,1fr);gap:24px;align-items:start}
.preview-media{display:block;width:100%;border:1px solid #e0e8f2;border-radius:12px}
.preview-copy{min-width:0;display:flex;flex-direction:column;gap:15px}.preview-copy h3{overflow-wrap:anywhere}
.caption-preview{border:1px solid #e2e9f0;border-radius:10px;padding:11px 12px}.caption-preview>div{display:flex;align-items:center;justify-content:space-between;gap:12px}
.caption-preview pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:185px;overflow-y:auto;font:12px/1.6 ui-monospace,SFMono-Regular,Consolas,monospace;color:#37475e}
.review-actions{display:flex;flex-wrap:wrap;gap:9px}.import-panel{background:#f8fafc;padding:15px;border-radius:12px;display:flex;flex-direction:column;gap:12px}
@media(max-width:850px){.contents-controls,.contents-controls.actions{grid-template-columns:1fr}.preview-layout{grid-template-columns:1fr}.preview-media{max-width:370px}}
@media(max-width:520px){.publications-grid{grid-template-columns:1fr}.contents-root .button{max-width:100%;white-space:normal}}
</style>
