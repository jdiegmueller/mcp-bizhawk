import http from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { VERSION } from "./version.js";

export interface WebServerOptions {
  mcpUrl: URL;
}

export interface WebListenerConfig {
  host: string;
  port: number;
  mcpUrl: URL;
}

export function resolveWebListenerConfig(env: Record<string, string | undefined>): WebListenerConfig {
  const mcpHost = env.MCP_HTTP_HOST ?? "127.0.0.1";
  const mcpPort = parseInt(env.MCP_HTTP_PORT ?? "8765", 10);
  return {
    host: env.WEB_HTTP_HOST ?? mcpHost,
    port: parseInt(env.WEB_HTTP_PORT ?? "8767", 10),
    mcpUrl: new URL(`http://${mcpHost}:${mcpPort}/mcp`),
  };
}

function normalizedIp(address: string | undefined): string {
  if (!address) return "";
  return address.startsWith("::ffff:") ? address.slice(7) : address;
}

export function isAllowedWebAddress(address: string | undefined): boolean {
  const ip = normalizedIp(address);
  if (ip === "::1") return true;
  const octets = ip.split(".").map(Number);
  if (octets.length !== 4 || octets.some((x) => !Number.isInteger(x) || x < 0 || x > 255)) return false;
  return octets[0] === 127 || (octets[0] === 10 && octets[1] === 245);
}

function json(res: http.ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(value));
}

function readJson(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      body += chunk;
      if (body.length > 1024 * 1024) reject(new Error("request body too large"));
    });
    req.on("end", () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch { reject(new Error("invalid JSON")); }
    });
    req.on("error", reject);
  });
}

async function withClient<T>(mcpUrl: URL, fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ name: "mcp-bizhawk-web", version: VERSION }, { capabilities: {} });
  try {
    await client.connect(new StreamableHTTPClientTransport(mcpUrl));
    return await fn(client);
  } finally {
    await client.close().catch(() => undefined);
  }
}

export function createWebHttpServer(options: WebServerOptions): http.Server {
  return http.createServer(async (req, res) => {
    if (!isAllowedWebAddress(req.socket.remoteAddress)) {
      json(res, 403, { error: "Forbidden" });
      return;
    }
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
    try {
      if (req.method === "GET" && url.pathname === "/") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        res.end(WEB_PAGE);
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/tools") {
        const result = await withClient(options.mcpUrl, (client) => client.listTools());
        json(res, 200, result);
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/call") {
        const body = await readJson(req) as { name?: unknown; arguments?: unknown };
        if (typeof body.name !== "string" || !body.name) {
          json(res, 400, { error: "name must be a non-empty string" });
          return;
        }
        if (body.arguments !== undefined && (body.arguments === null || typeof body.arguments !== "object" || Array.isArray(body.arguments))) {
          json(res, 400, { error: "arguments must be an object" });
          return;
        }
        const result = await withClient(options.mcpUrl, (client) => client.callTool({
          name: body.name as string,
          arguments: (body.arguments ?? {}) as Record<string, unknown>,
        }));
        json(res, 200, result);
        return;
      }
      json(res, 404, { error: "Not found" });
    } catch (error) {
      json(res, 502, { error: (error as Error).message });
    }
  });
}

const WEB_PAGE = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>BizHawk Control</title>
<style>
:root{color-scheme:dark;--bg:#0d1014;--panel:#161b21;--soft:#1d242c;--line:#303a45;--text:#edf2f7;--muted:#8f9ba8;--green:#61e6a8;--red:#ff7b82}
*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 50% -20%,#1b2730 0,var(--bg) 42%);color:var(--text);font:14px/1.5 Inter,ui-sans-serif,system-ui,sans-serif;min-height:100vh}
.shell{width:min(760px,calc(100% - 28px));margin:34px auto}.top{display:flex;align-items:center;gap:10px;padding:0 4px 18px}.brand{font-weight:800;letter-spacing:-.03em;margin-right:auto}.dot{width:8px;height:8px;border-radius:50%;background:var(--green);box-shadow:0 0 12px #61e6a888}.muted{color:var(--muted)}
.panel{background:color-mix(in srgb,var(--panel) 96%,transparent);border:1px solid var(--line);border-radius:14px;box-shadow:0 24px 70px #0007;overflow:hidden}.section{padding:20px;border-bottom:1px solid #252d36}.section:last-child{border-bottom:0}
label,.eyebrow{display:block;color:#a9b4bf;font-size:11px;font-weight:750;letter-spacing:.08em;text-transform:uppercase;margin-bottom:7px}input,select,textarea,button{font:inherit}input,select,textarea{width:100%;color:var(--text);background:#10151a;border:1px solid var(--line);border-radius:8px;padding:10px 11px;outline:none}input:focus,select:focus,textarea:focus{border-color:#5b8c79;box-shadow:0 0 0 3px #61e6a814}textarea{min-height:110px;resize:vertical;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}.grid{display:grid;grid-template-columns:1fr 180px;gap:12px}.desc{color:var(--muted);font-size:13px;margin:10px 2px 0;white-space:pre-wrap;max-height:110px;overflow:auto}.fields{display:grid;gap:13px}.field-head{display:flex;gap:8px;align-items:center}.required{color:var(--green);font-size:10px}.help{color:#74818e;font-size:12px;margin:5px 2px 0}.check{display:flex;align-items:center;gap:9px}.check input{width:auto;accent-color:var(--green)}details{border-top:1px solid #252d36;padding-top:13px}summary{cursor:pointer;color:#b9c4cf;font-weight:650}.optional-fields{display:grid;gap:13px;margin-top:13px}.actions{display:flex;align-items:center;gap:12px}button{border:0;border-radius:8px;background:var(--green);color:#092117;font-weight:800;padding:10px 18px;cursor:pointer}button:disabled{opacity:.55;cursor:wait}.status{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;color:var(--muted)}
#result{margin:0;background:#0a0d10;color:#bdebd4;border:1px solid #26332d;border-radius:9px;padding:13px;min-height:62px;white-space:pre-wrap;overflow:auto;font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace}.error{color:var(--red)!important;border-color:#533238!important}.result-image{display:block;max-width:100%;margin-top:12px;border-radius:8px;border:1px solid var(--line)}
@media(max-width:620px){.grid{grid-template-columns:1fr}.shell{margin:14px auto}.section{padding:15px}}
</style>
</head>
<body><main class="shell">
<header class="top"><div class="brand">BIZHAWK / CONTROL</div><span class="dot" id="dot"></span><span class="muted" id="connection">connecting</span></header>
<div class="panel">
  <section class="section"><div class="grid">
    <div><label for="tool-search">Tool</label><input id="tool-search" list="tools" autocomplete="off" placeholder="Type to find a tool…"><datalist id="tools"></datalist></div>
    <div><label for="backend">Backend</label><select id="backend"><option>loading…</option></select></div>
  </div><div class="desc" id="description">Choose a tool to begin.</div></section>
  <form id="form"><section class="section"><div class="fields" id="required-fields"></div><details id="optional-wrap"><summary>Optional parameters</summary><div class="optional-fields" id="optional-fields"></div></details></section>
  <section class="section actions"><button id="run" type="submit">RUN TOOL&nbsp; ↵</button><span class="status" id="status">ready</span></section></form>
  <section class="section"><div class="eyebrow">Result</div><pre id="result">No result yet.</pre><div id="images"></div></section>
</div></main>
<script>
const $=id=>document.getElementById(id);let tools=[],selected=null;
const shortDesc=s=>{const m=String(s||'').match(/PURPOSE:\s*(.*?)(?:\s+USAGE:|$)/s);return (m?m[1]:s)||''};
async function api(path,options){const r=await fetch(path,options);const j=await r.json();if(!r.ok)throw new Error(j.error||('HTTP '+r.status));return j}
function setConnection(ok,text){$('connection').textContent=text;$('dot').style.background=ok?'var(--green)':'var(--red)'}
function addField(parent,name,schema,required){
  if(name==='target')return;const wrap=document.createElement('div');const head=document.createElement('div');head.className='field-head';const lab=document.createElement('label');lab.htmlFor='field-'+name;lab.textContent=name;head.append(lab);if(required){const tag=document.createElement('span');tag.className='required';tag.textContent='REQUIRED';head.append(tag)}wrap.append(head);
  let input;const type=Array.isArray(schema.type)?schema.type.find(x=>x!=='null'):schema.type;
  if(schema.enum){input=document.createElement('select');for(const value of schema.enum){const o=document.createElement('option');o.value=String(value);o.textContent=String(value);input.append(o)}}
  else if(type==='boolean'){input=document.createElement('input');input.type='checkbox';wrap.classList.add('check')}
  else if(type==='object'||type==='array'||schema.oneOf){input=document.createElement('textarea');input.dataset.json='1';input.placeholder=type==='array'?'[]':'{}'}
  else{input=document.createElement('input');input.type=(type==='integer'||type==='number')?'number':'text';if(schema.minimum!==undefined)input.min=schema.minimum;if(schema.maximum!==undefined)input.max=schema.maximum}
  input.id='field-'+name;input.dataset.name=name;input.dataset.type=type||'';if(schema.default!==undefined){if(input.type==='checkbox')input.checked=Boolean(schema.default);else if(input.dataset.json)input.value=JSON.stringify(schema.default,null,2);else input.value=String(schema.default)}wrap.append(input);
  if(schema.description){const help=document.createElement('div');help.className='help';help.textContent=schema.description;wrap.append(help)}parent.append(wrap)
}
function chooseTool(name){selected=tools.find(t=>t.name===name)||null;$('required-fields').replaceChildren();$('optional-fields').replaceChildren();$('description').textContent=selected?shortDesc(selected.description):'Choose a tool to begin.';if(!selected)return;const schema=selected.inputSchema||{};const req=new Set(schema.required||[]);for(const [name,prop] of Object.entries(schema.properties||{}))addField(req.has(name)?$('required-fields'):$('optional-fields'),name,prop,req.has(name));$('optional-wrap').style.display=$('optional-fields').children.length?'block':'none'}
function argumentsFromForm(){const args={};if(selected?.inputSchema?.properties?.target)args.target=$('backend').value;for(const input of document.querySelectorAll('[data-name]')){const name=input.dataset.name;if(input.type==='checkbox'){if(input.checked)args[name]=true;continue}if(input.value==='')continue;if(input.dataset.json){try{args[name]=JSON.parse(input.value)}catch{throw new Error(name+' must contain valid JSON')}}else if(input.dataset.type==='integer'||input.dataset.type==='number')args[name]=Number(input.value);else args[name]=input.value}return args}
async function load(){try{const catalog=await api('/api/tools');tools=catalog.tools||[];$('tools').replaceChildren(...tools.map(t=>{const o=document.createElement('option');o.value=t.name;o.label=shortDesc(t.description);return o}));const backends=await api('/api/call',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:'bizhawk_list_backends',arguments:{}})});const text=(backends.content||[]).find(x=>x.type==='text')?.text||'';const names=text==='No backends configured.'?[]:text.split('\n').map(x=>x.split(' @ ')[0]);$('backend').replaceChildren(...names.map(n=>{const o=document.createElement('option');o.value=n;o.textContent=n;return o}));if(!names.length){const o=document.createElement('option');o.value='';o.textContent='none configured';$('backend').append(o)}setConnection(true,'connected')}catch(e){setConnection(false,'offline');$('result').textContent=e.message;$('result').className='error'}}
$('tool-search').addEventListener('input',e=>chooseTool(e.target.value));$('form').addEventListener('submit',async e=>{e.preventDefault();if(!selected){$('result').textContent='Choose a tool first.';return}const run=$('run');run.disabled=true;$('status').textContent='running…';$('result').className='';$('images').replaceChildren();try{const result=await api('/api/call',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:selected.name,arguments:argumentsFromForm()})});const text=(result.content||[]).filter(x=>x.type==='text').map(x=>x.text).join('\n\n');$('result').textContent=text||'(no text result)';for(const item of (result.content||[])){if(item.type==='image'){const img=document.createElement('img');img.className='result-image';img.alt='Tool result';img.src='data:'+(item.mimeType||'image/png')+';base64,'+item.data;$('images').append(img)}}if(result.isError)$('result').className='error';$('status').textContent=result.isError?'tool error':'complete'}catch(err){$('result').textContent=err.message;$('result').className='error';$('status').textContent='error'}finally{run.disabled=false}});document.addEventListener('keydown',e=>{if((e.ctrlKey||e.metaKey)&&e.key==='Enter')$('form').requestSubmit()});load();
</script></body></html>`;
