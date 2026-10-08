// Vitrine: video ads for semi-fine jewellery, built on the flow-mcp pipeline (ported from Bemfeitor/vitrine-de-avatares).
//
// The whole point: generative models draw what is plausible, not what is exact - ask for a necklace with 14 stones and
// you get a convincing one with 13. So AI NEVER draws the piece. The real photo is cut out and composited onto a
// pre-made avatar picture (a "plate") with plain pixel maths; the only thing made up is the contact shadow, and that is
// an image operation too (grow + blur + darken the piece's own mask). Flow only enters where generation is legitimate:
// drawing the avatar plates (free images) and animating an approved, already-composited hero frame (I2V).
//
// The Vitrine original did these steps in ComfyUI graphs. They were core image nodes plus one background-removal model,
// so they run here on ffmpeg (decode/encode/scale) and a few loops over raw pixels - no ComfyUI, no new dependency.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { promisify } from "node:util";
import { FFMPEG_HINT } from "./platform.js";

const run = promisify(execFile);
const FFMPEG = process.env.FLOW_MCP_FFMPEG ?? "ffmpeg";
const FFPROBE = process.env.FLOW_MCP_FFPROBE ?? "ffprobe";

export type Ancora = "pescoco" | "orelha" | "mao" | "pulso";
export type TipoPeca = "colar" | "brinco" | "anel" | "pulseira" | "conjunto";
export type Familia = "dourada_quente" | "estudio_neutro" | "dia_suave" | "noturna";
export const TIPOS = ["colar", "brinco", "anel", "pulseira", "conjunto"] as const;
export const ANCORAS = ["pescoco", "orelha", "mao", "pulso"] as const;
export const FAMILIAS = ["dourada_quente", "estudio_neutro", "dia_suave", "noturna"] as const;
export const METAIS = ["dourado", "prateado", "rose"] as const;

// Presets per anchor, copied from the Vitrine's workflows/presets-ancora.json (shadow calibrated 11/09: the first values
// made a halo round the whole piece; real contact = little growth, little blur, a bigger offset away from the light).
// The shadow numbers are pixels for a piece 420 px wide - the size the ComfyUI template composited at - and are scaled
// with the piece. escala_rel is the share of the marked anchor width the piece should fill.
export const PRESETS: Record<Exclude<TipoPeca, "conjunto">, {
  ancora: Ancora; escala_rel: number; sombra_expand: number; sombra_blur: number; sombra_sigma: number; sombra_dx: number; sombra_dy: number;
  dificuldade: string; risco: string; macro_peso: number;
}> = {
  colar: { ancora: "pescoco", escala_rel: 0.62, sombra_expand: 2, sombra_blur: 6, sombra_sigma: 3, sombra_dx: 5, sombra_dy: 8, dificuldade: "media", risco: "Cabelo solto cobre a corrente durante o movimento. Plates de colar devem ter cabelo preso.", macro_peso: 0.5 },
  brinco: { ancora: "orelha", escala_rel: 0.48, sombra_expand: 1, sombra_blur: 4, sombra_sigma: 2, sombra_dx: 3, sombra_dy: 5, dificuldade: "alta", risco: "Regiao minuscula: erro de 3px ja desalinha. Exige zoom alto e mecha atras da orelha.", macro_peso: 0.6 },
  anel: { ancora: "mao", escala_rel: 0.55, sombra_expand: 2, sombra_blur: 5, sombra_sigma: 2.5, sombra_dx: 4, sombra_dy: 6, dificuldade: "muito_alta", risco: "Pior caso do sistema. Mao em movimento e onde IA mais erra - plates devem ter mao apoiada e dedos separados.", macro_peso: 0.75 },
  pulseira: { ancora: "pulso", escala_rel: 0.7, sombra_expand: 2, sombra_blur: 6, sombra_sigma: 3, sombra_dx: 5, sombra_dy: 7, dificuldade: "alta", risco: "Envolve um cilindro: a peca precisa acompanhar a curvatura do pulso, nao ficar chapada.", macro_peso: 0.6 },
};
export const presetFor = (tipo: TipoPeca) => PRESETS[tipo === "conjunto" ? "colar" : tipo];

// Light families from the Vitrine schema seed. A plate was drawn under one light; swapping the background is only safe
// inside the same family, so plates carry their family and the prompts below describe it.
export const LUZ: Record<Familia, { nome: string; prompt: string }> = {
  dourada_quente: { nome: "Dourada quente", prompt: "warm late-afternoon light at about 3000 K coming low from the side, golden tones" },
  estudio_neutro: { nome: "Estúdio neutro", prompt: "neutral studio light at about 5400 K, soft and diffused from the front, gentle shadows, catalogue look" },
  dia_suave: { nome: "Dia suave", prompt: "soft diffused daylight at about 6300 K from a large window, slightly cool" },
  noturna: { nome: "Noturna", prompt: "night-time interior with a single warm point light, high contrast, crisp highlights" },
};

// How each anchor has to be framed so the piece can sit on it and survive animation (the risks in PRESETS).
const ENQUADRAMENTO: Record<Ancora, string> = {
  pescoco: "Head-and-shoulders portrait, facing the camera, hair tied back in a low bun so the neck is completely uncovered, bare neck and collarbones fully visible, simple strapless or wide V neckline",
  orelha: "Close three-quarter portrait of the face and one ear, hair tucked behind the ear, the earlobe clearly visible and in sharp focus",
  mao: "Close-up of one hand resting on a plain surface, back of the hand toward the camera, fingers relaxed and slightly apart, the face softly out of focus behind it",
  pulso: "Close-up of a forearm and bare wrist resting on a plain surface, hand relaxed, the wrist clearly visible and in sharp focus",
};

export const AVATARES_PADRAO = [
  "a Brazilian woman in her late twenties, warm brown skin, dark curly hair, natural makeup",
  "a woman in her thirties, light olive skin, straight dark-blonde hair, soft natural makeup",
  "a woman in her forties, deep brown skin, short black natural hair, elegant minimal makeup",
];

export function platePrompt(avatar: string, ancora: Ancora, familia: Familia): string {
  return `Photorealistic vertical jewellery-catalogue photograph of ${avatar.trim().replace(/\.$/, "")}, a synthetic model who resembles no real person. ${ENQUADRAMENTO[ancora]}. She wears NO jewellery at all: no necklace, earrings, rings, bracelets or watch. ${LUZ[familia].prompt}. Plain uncluttered background, sharp focus, natural skin texture, editorial beauty look.`;
}

const MOVIMENTO: Record<Ancora, string> = {
  pescoco: "Her hair stays tied back so the necklace is always fully visible.",
  orelha: "Her hair stays behind her ear and the earring stays fully visible as she turns very slightly.",
  mao: "Her hand stays resting exactly where it is with the fingers apart and still; only her face and shoulders move.",
  pulso: "Her wrist stays resting exactly where it is; only a slight shift of the shoulders.",
};

// I2V from the composited hero frame. The jewellery is real pixels in the first frame, so the prompt's whole job is to
// keep the model from touching it: tiny motion, nothing crossing the piece, nothing redrawn.
export function animationPrompt(ancora: Ancora): string {
  return `Jewellery advertisement. The model holds almost still with one small, slow movement: a gentle breath, a soft smile and a slight turn of the head toward the camera. The camera makes a very slow push-in. Same soft light throughout, no flicker. ${MOVIMENTO[ancora]} The jewellery stays exactly as in the first frame: the same shape, the same number of stones, the same metal colour and the same position on her body; it is never redrawn, never changes and is never hidden by hair or hands. No dialogue, no text.`;
}

/* ---------- raw pixels through ffmpeg ---------- */

type Fmt = "rgba" | "rgb24" | "gray";
const CHANNELS: Record<Fmt, number> = { rgba: 4, rgb24: 3, gray: 1 };
interface Raw { w: number; h: number; data: Buffer }

async function ff(bin: string, args: string[], opts: object = {}) {
  try {
    return await run(bin, args, { maxBuffer: 1 << 30, encoding: "buffer", ...opts });
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: Buffer };
    throw new Error(e.code === "ENOENT" ? `ffmpeg is not installed (${FFMPEG_HINT}).` : `ffmpeg failed: ${String(e.stderr ?? e).slice(-400)}`);
  }
}

async function imageSize(file: string): Promise<{ w: number; h: number }> {
  const { stdout } = await ff(FFPROBE, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0:s=x", file]);
  const [w, h] = stdout.toString().trim().split("x").map(Number);
  if (!w || !h) throw new Error(`Não consegui ler a imagem ${file}.`);
  return { w, h };
}

// Decodes the first frame to raw pixels, optionally scaled to a width (lanczos, aspect kept).
async function decode(file: string, fmt: Fmt, width?: number): Promise<Raw> {
  const src = await imageSize(file);
  const w = width ? Math.max(1, Math.round(width)) : src.w;
  const h = width ? Math.max(1, Math.round((src.h * w) / src.w)) : src.h;
  const scale = width ? ["-vf", `scale=${w}:${h}:flags=lanczos`] : [];
  const { stdout } = await ff(FFMPEG, ["-v", "error", "-i", file, ...scale, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", fmt, "pipe:1"]);
  if (stdout.length !== w * h * CHANNELS[fmt]) throw new Error(`Decodificação inesperada de ${file}.`);
  return { w, h, data: stdout };
}

async function encode(raw: Raw, fmt: Fmt, out: string): Promise<string> {
  const tmp = `${out}.${randomUUID().slice(0, 6)}.raw`;
  writeFileSync(tmp, raw.data);
  try {
    await ff(FFMPEG, ["-y", "-v", "error", "-f", "rawvideo", "-pix_fmt", fmt, "-s", `${raw.w}x${raw.h}`, "-i", tmp, "-frames:v", "1", out]);
  } finally {
    rmSync(tmp, { force: true });
  }
  return out;
}

/* ---------- quality control (port of the Vitrine's qc.service.ts) ---------- */

export interface Metricas { largura: number; altura: number; menorLado: number; nitidez: number; estouro: number; ocupacao: number; score: number; motivos: string[] }

// The real photo is the ceiling of fidelity: the macro shot is a crop of it and nothing later recovers what it lacks.
// Stopping a bad photo here is what keeps credits from being spent on rubbish. Thresholds are the Vitrine's first guess,
// still to be calibrated with real catalogue photos.
const MIN_LADO = 1000, BOM_LADO = 2000, MIN_NITIDEZ = 80, BOA_NITIDEZ = 400, MAX_ESTOURO = 0.04;

function avaliar(gray: Raw, cutout: Raw | undefined): Metricas {
  const { w, h, data: d } = gray;
  const menorLado = Math.min(w, h);
  let soma = 0, soma2 = 0, n = 0, estourados = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const v = -4 * d[i] + d[i - 1] + d[i + 1] + d[i - w] + d[i + w];
      soma += v; soma2 += v * v; n++;
    }
  }
  for (let i = 0; i < d.length; i++) if (d[i] >= 250) estourados++;
  const nitidez = n ? soma2 / n - (soma / n) ** 2 : 0;
  const estouro = estourados / d.length;
  // The Vitrine measured coverage as the opaque share of the frame, which fails a thin chain that spans the whole photo
  // (1.7 % opaque on a frame-filling necklace). "Too small, get closer" is about the area the piece spans - the trimmed
  // cut-out's box - while "the background came along" is still the opaque share.
  let ocupacao = 1, opaco = 0;
  if (cutout) {
    let op = 0;
    for (let i = 3; i < cutout.data.length; i += 4) if (cutout.data[i] > 128) op++;
    ocupacao = (cutout.w * cutout.h) / (w * h);
    opaco = op / (w * h);
  }

  const motivos: string[] = [];
  let score = 1;
  if (menorLado < MIN_LADO) { score -= 0.45; motivos.push(`Resolução baixa (${menorLado}px). O plano macro é recorte desta foto e sairia borrado.`); }
  else if (menorLado < BOM_LADO) { score -= 0.12; motivos.push(`Resolução aceitável (${menorLado}px), mas abaixo do ideal de ${BOM_LADO}px.`); }
  if (nitidez < MIN_NITIDEZ) { score -= 0.4; motivos.push(`Foto sem nitidez (${nitidez.toFixed(0)}). Refaça com apoio ou tripé.`); }
  else if (nitidez < BOA_NITIDEZ) { score -= 0.1; motivos.push(`Nitidez mediana (${nitidez.toFixed(0)}).`); }
  if (estouro > MAX_ESTOURO) { score -= 0.3; motivos.push(`Metal estourado em ${(estouro * 100).toFixed(1)}% da imagem. Detalhe perdido não volta — use luz difusa.`); }
  if (cutout && ocupacao < 0.02) { score -= 0.35; motivos.push(`Peça ocupa apenas ${(ocupacao * 100).toFixed(1)}% do quadro. Aproxime ou recorte antes de enviar.`); }
  if (cutout && opaco > 0.85) { score -= 0.25; motivos.push(`Recorte manteve ${(opaco * 100).toFixed(0)}% do quadro — provável falha de segmentação (fundo junto).`); }
  return {
    largura: w, altura: h, menorLado,
    nitidez: Number(nitidez.toFixed(1)), estouro: Number(estouro.toFixed(4)), ocupacao: Number(ocupacao.toFixed(4)),
    score: Number(Math.max(0, Math.min(1, score)).toFixed(3)), motivos,
  };
}

/* ---------- cut-out ---------- */

// A photo that already has transparency is used as is. Otherwise the background is taken away by flooding in from the
// border: catalogue photos are shot on a plain backdrop, so whatever touches the edge and matches the border colour is
// background. Edge pixels close to that colour get partial alpha so the outline is not jagged. This replaces the
// Vitrine's RMBG model; it fails on busy backgrounds (refused below) and on light metal shot on a light backdrop, which
// the QC's coverage check flags - shoot pearls and silver on a dark or grey backdrop.
const TOL = 30, SOFT = 60;

function recortar(img: Raw): { raw: Raw; metodo: string } {
  const { w, h, data } = img;
  const total = w * h;
  let transparentes = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i] < 128) transparentes++;
  if (transparentes / total > 0.01) return { raw: crop(img), metodo: "transparência da própria foto" };

  const borda: number[] = [];
  for (let x = 0; x < w; x++) borda.push(x, (h - 1) * w + x);
  for (let y = 1; y < h - 1; y++) borda.push(y * w, y * w + w - 1);
  const mediana = (c: number) => { const v = borda.map((p) => data[p * 4 + c]).sort((a, b) => a - b); return v[v.length >> 1]; };
  const bg = [mediana(0), mediana(1), mediana(2)];
  const dist = (p: number) => Math.hypot(data[p * 4] - bg[0], data[p * 4 + 1] - bg[1], data[p * 4 + 2] - bg[2]);
  const uniforme = borda.filter((p) => dist(p) <= TOL).length / borda.length;
  if (uniforme < 0.6) {
    throw new Error("O fundo da foto não é liso, então não dá para recortar sozinho. Fotografe a peça sobre um fundo de cor única, ou envie um PNG já recortado (com transparência).");
  }

  const fundo = new Uint8Array(total);
  const pilha = new Int32Array(total);
  let topo = 0;
  for (const p of borda) if (!fundo[p] && dist(p) <= TOL) { fundo[p] = 1; pilha[topo++] = p; }
  while (topo) {
    const p = pilha[--topo];
    const x = p % w;
    for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, p - w, p + w]) {
      if (q >= 0 && q < total && !fundo[q] && dist(q) <= TOL) { fundo[q] = 1; pilha[topo++] = q; }
    }
  }
  const out = Buffer.from(data);
  for (let p = 0; p < total; p++) {
    if (fundo[p]) { out[p * 4 + 3] = 0; continue; }
    const x = p % w;
    const vizinhoFundo = (x > 0 && fundo[p - 1]) || (x < w - 1 && fundo[p + 1]) || (p >= w && fundo[p - w]) || (p + w < total && fundo[p + w]);
    const d = dist(p);
    if (vizinhoFundo && d < SOFT) out[p * 4 + 3] = Math.round((255 * (d - TOL)) / (SOFT - TOL));
  }
  return { raw: crop({ w, h, data: out }), metodo: "fundo liso removido automaticamente" };
}

// Trims to the opaque area plus a small margin, so "piece width" means the piece and not the photo.
function crop(img: Raw): Raw {
  const { w, h, data } = img;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (data[(y * w + x) * 4 + 3] > 16) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  if (x1 < 0) throw new Error("O recorte ficou vazio: a peça tem a mesma cor do fundo. Fotografe sobre um fundo que contraste com ela.");
  const m = Math.round(Math.max(x1 - x0, y1 - y0) * 0.02);
  x0 = Math.max(0, x0 - m); y0 = Math.max(0, y0 - m); x1 = Math.min(w - 1, x1 + m); y1 = Math.min(h - 1, y1 + m);
  const cw = x1 - x0 + 1, ch = y1 - y0 + 1;
  const out = Buffer.alloc(cw * ch * 4);
  for (let y = 0; y < ch; y++) data.copy(out, y * cw * 4, ((y0 + y) * w + x0) * 4, ((y0 + y) * w + x1 + 1) * 4);
  return { w: cw, h: ch, data: out };
}

/* ---------- composition (port of compor-peca.json) ---------- */

function dilate(src: Float32Array, w: number, h: number, r: number): Float32Array {
  if (r < 1) return src;
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let m = 0;
    for (let i = Math.max(0, x - r); i <= Math.min(w - 1, x + r); i++) m = Math.max(m, src[y * w + i]);
    tmp[y * w + x] = m;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let m = 0;
    for (let j = Math.max(0, y - r); j <= Math.min(h - 1, y + r); j++) m = Math.max(m, tmp[j * w + x]);
    out[y * w + x] = m;
  }
  return out;
}

function gaussian(src: Float32Array, w: number, h: number, r: number, sigma: number): Float32Array {
  if (r < 1 || sigma <= 0) return src;
  const k = Array.from({ length: 2 * r + 1 }, (_, i) => Math.exp(-((i - r) ** 2) / (2 * sigma * sigma)));
  const sum = k.reduce((a, b) => a + b, 0);
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let a = 0;
    for (let i = -r; i <= r; i++) a += src[y * w + Math.min(w - 1, Math.max(0, x + i))] * k[i + r];
    tmp[y * w + x] = a / sum;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let a = 0;
    for (let i = -r; i <= r; i++) a += tmp[Math.min(h - 1, Math.max(0, y + i)) * w + x] * k[i + r];
    out[y * w + x] = a / sum;
  }
  return out;
}

export interface Posicao { x: number; y: number; w: number }

// The piece is scaled to escala_rel of the marked anchor width and centred on the marked point. Its own alpha, grown,
// blurred and offset away from the light, darkens the plate underneath first (the contact shadow); then the real
// pixels go on top. Nothing here is generated.
export async function compor(plateFile: string, cutoutFile: string, pos: Posicao, tipo: TipoPeca, out: string): Promise<string> {
  const p = presetFor(tipo);
  const plate = await decode(plateFile, "rgb24");
  const pieceW = Math.max(8, p.escala_rel * pos.w * plate.w);
  const piece = await decode(cutoutFile, "rgba", pieceW);
  const k = piece.w / 420;
  const expand = Math.round(p.sombra_expand * k), raio = Math.max(1, Math.round(p.sombra_blur * k)), sigma = p.sombra_sigma * k;
  const dx = Math.round(p.sombra_dx * k), dy = Math.round(p.sombra_dy * k);
  const ox = Math.round(pos.x * plate.w - piece.w / 2), oy = Math.round(pos.y * plate.h - piece.h / 2);

  const m = expand + raio + 2;
  const cw = piece.w + 2 * m, ch = piece.h + 2 * m;
  const mascara = new Float32Array(cw * ch);
  for (let y = 0; y < piece.h; y++) for (let x = 0; x < piece.w; x++) mascara[(y + m) * cw + x + m] = piece.data[(y * piece.w + x) * 4 + 3] / 255;
  const sombra = gaussian(dilate(mascara, cw, ch, expand), cw, ch, raio, sigma);

  const px = plate.data;
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
    const tx = ox - m + dx + x, ty = oy - m + dy + y;
    const s = sombra[y * cw + x];
    if (s <= 0 || tx < 0 || ty < 0 || tx >= plate.w || ty >= plate.h) continue;
    const i = (ty * plate.w + tx) * 3;
    px[i] *= 1 - s; px[i + 1] *= 1 - s; px[i + 2] *= 1 - s;
  }
  for (let y = 0; y < piece.h; y++) for (let x = 0; x < piece.w; x++) {
    const tx = ox + x, ty = oy + y;
    if (tx < 0 || ty < 0 || tx >= plate.w || ty >= plate.h) continue;
    const j = (y * piece.w + x) * 4, a = piece.data[j + 3] / 255;
    if (!a) continue;
    const i = (ty * plate.w + tx) * 3;
    px[i] = px[i] * (1 - a) + piece.data[j] * a;
    px[i + 1] = px[i + 1] * (1 - a) + piece.data[j + 1] * a;
    px[i + 2] = px[i + 2] * (1 - a) + piece.data[j + 2] * a;
  }
  return encode(plate, "rgb24", out);
}

/* ---------- macro shot (port of macro-produto.sh) ---------- */

// Ken Burns over the REAL photo: 100 % fidelity, no AI touches these pixels. In the cut it alternates with the avatar
// shot - desire, then proof - so the piece never has to be perfect in motion on a person.
export async function macro(cutout: string, out: string, aspecto: "9:16" | "4:5" | "1:1" = "9:16", dur = 2.5, direcao: "in" | "out" | "pan" = "in"): Promise<string> {
  const fps = 30, quadros = Math.round(dur * fps);
  const [L, A] = { "9:16": [1080, 1920], "4:5": [1080, 1350], "1:1": [1080, 1080] }[aspecto];
  // zoompan samples the already-scaled frame; working at twice the size and only then shrinking avoids jagged zooms.
  const SL = L * 2, SA = A * 2;
  const [Z, X, Y] = {
    in: ["min(zoom+0.0012,1.35)", "iw/2-(iw/zoom/2)", "ih/2-(ih/zoom/2)"],
    out: ["if(lte(zoom,1.0),1.35,max(zoom-0.0012,1.0))", "iw/2-(iw/zoom/2)", "ih/2-(ih/zoom/2)"],
    pan: ["1.18", `(iw-iw/zoom)*(on/${quadros})`, "ih/2-(ih/zoom/2)"],
  }[direcao];
  // One composed frame goes into zoompan, which makes every output frame from it.
  const filtro = [
    `[0:v]format=rgba,geq=r='r(X,Y)+18*(1-Y/H)':g='g(X,Y)+14*(1-Y/H)':b='b(X,Y)+9*(1-Y/H)':a='255'[fundo]`,
    `[1:v]format=rgba,scale=${SL}*0.78:${SA}*0.78:force_original_aspect_ratio=decrease:flags=lanczos[peca]`,
    `[fundo][peca]overlay=(W-w)/2:(H-h)/2:format=auto[comp]`,
    `[comp]zoompan=z='${Z}':x='${X}':y='${Y}':d=${quadros}:s=${SL}x${SA}:fps=${fps},scale=${L}:${A}:flags=lanczos,format=yuv420p[saida]`,
  ].join(";");
  await ff(FFMPEG, [
    "-y", "-v", "error",
    "-f", "lavfi", "-i", `color=c=0x15120E:s=${SL}x${SA}:r=${fps},trim=end_frame=1`,
    "-i", cutout,
    "-filter_complex", filtro, "-map", "[saida]",
    "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-movflags", "+faststart", "-t", String(dur), out,
  ]);
  return out;
}

/* ---------- catalogue ---------- */

export type Aprovacao = "aprovado" | "em_revisao" | "rejeitado";
export interface Peca { id: string; nome: string; sku?: string; tipo: TipoPeca; metal?: string; foto: string; cutout: string; recorte: string; qc: Metricas; status: Aprovacao; criado_em: string }
export interface Plate { id: string; nome: string; avatar: string; ancora: Ancora; familia?: Familia; imagem: string; posicao: Posicao; criado_em: string }
export interface Criativo {
  id: string; peca_id: string; plate_id: string; heroi: string; macro: string;
  status: "portao" | "aprovado" | "rejeitado"; job_id?: string; final?: string; criado_em: string;
}
interface Catalogo { pecas: Peca[]; plates: Plate[]; criativos: Criativo[] }

export const vitrineDir = (root: string) => join(root, "_vitrine");
const catalogFile = (root: string) => join(vitrineDir(root), "catalogo.json");

export function lerCatalogo(root: string): Catalogo {
  const f = catalogFile(root);
  const c = existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as Partial<Catalogo>) : {};
  return { pecas: c.pecas ?? [], plates: c.plates ?? [], criativos: c.criativos ?? [] };
}

export function gravarCatalogo(root: string, c: Catalogo): void {
  mkdirSync(vitrineDir(root), { recursive: true });
  // Written to a side file and renamed, so a crash mid-write can never leave a half catalogue behind.
  const f = catalogFile(root);
  writeFileSync(`${f}.tmp`, JSON.stringify(c, null, 2));
  renameSync(`${f}.tmp`, f);
}

const novoId = () => randomUUID().slice(0, 8);
const APROVA_QC = 0.7;

export async function novaPeca(root: string, a: { nome: string; sku?: string; tipo: TipoPeca; metal?: string; foto: string }): Promise<Peca> {
  if (!existsSync(a.foto)) throw new Error(`Foto não encontrada: ${a.foto}`);
  const id = novoId();
  const dir = join(vitrineDir(root), "pecas", id);
  mkdirSync(dir, { recursive: true });
  const foto = join(dir, `foto${extname(a.foto).toLowerCase() || ".jpg"}`);
  copyFileSync(a.foto, foto);
  try {
    const { raw, metodo } = recortar(await decode(foto, "rgba"));
    const cutout = await encode(raw, "rgba", join(dir, "recorte.png"));
    const qc = avaliar(await decode(foto, "gray"), raw);
    const peca: Peca = { id, nome: a.nome, sku: a.sku, tipo: a.tipo, metal: a.metal, foto, cutout, recorte: metodo, qc, status: qc.score >= APROVA_QC ? "aprovado" : "em_revisao", criado_em: new Date().toISOString() };
    const c = lerCatalogo(root);
    c.pecas.unshift(peca);
    gravarCatalogo(root, c);
    return peca;
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    throw err;
  }
}

export function salvarPlate(root: string, a: { id?: string; nome: string; avatar: string; ancora: Ancora; familia?: Familia; imagem: string; x: number; y: number; w: number }): Plate {
  if (!existsSync(a.imagem)) throw new Error(`Imagem não encontrada: ${a.imagem}`);
  const c = lerCatalogo(root);
  const antigo = a.id ? c.plates.find((p) => p.id === a.id) : undefined;
  if (a.id && !antigo) throw new Error(`Plate ${a.id} não existe.`);
  const id = antigo?.id ?? novoId();
  // The plate keeps its own copy, so clearing the uploads or the Flow downloads never breaks it.
  let imagem = antigo?.imagem ?? "";
  if (!antigo || a.imagem !== antigo.imagem) {
    mkdirSync(join(vitrineDir(root), "plates"), { recursive: true });
    imagem = join(vitrineDir(root), "plates", `${id}${extname(a.imagem).toLowerCase() || ".png"}`);
    copyFileSync(a.imagem, imagem);
  }
  const plate: Plate = { id, nome: a.nome, avatar: a.avatar, ancora: a.ancora, familia: a.familia, imagem, posicao: { x: a.x, y: a.y, w: a.w }, criado_em: antigo?.criado_em ?? new Date().toISOString() };
  c.plates = antigo ? c.plates.map((p) => (p.id === id ? plate : p)) : [plate, ...c.plates];
  gravarCatalogo(root, c);
  return plate;
}

export const ancoraDe = (tipo: TipoPeca): Ancora => presetFor(tipo).ancora;

// One creative per plate: hero frame (composited) and macro shot, both free. It then waits at the fidelity gate.
export async function novosCriativos(root: string, peca_id: string, plate_ids: string[]): Promise<Criativo[]> {
  const c = lerCatalogo(root);
  const peca = c.pecas.find((p) => p.id === peca_id);
  if (!peca) throw new Error(`Peça ${peca_id} não existe.`);
  if (peca.status !== "aprovado") throw new Error(`A peça "${peca.nome}" está "${peca.status}". Só peça aprovada entra em produção.`);
  const feitos: Criativo[] = [];
  for (const plate_id of plate_ids) {
    const plate = c.plates.find((p) => p.id === plate_id);
    if (!plate) throw new Error(`Plate ${plate_id} não existe.`);
    if (plate.ancora !== ancoraDe(peca.tipo)) throw new Error(`O plate "${plate.nome}" é de ${plate.ancora}, mas ${peca.tipo} vai em ${ancoraDe(peca.tipo)}.`);
    const id = novoId();
    const dir = join(vitrineDir(root), "criativos", id);
    mkdirSync(dir, { recursive: true });
    const heroi = await compor(plate.imagem, peca.cutout, plate.posicao, peca.tipo, join(dir, "heroi.png"));
    const mac = await macro(peca.cutout, join(dir, "macro.mp4"));
    feitos.push({ id, peca_id, plate_id, heroi, macro: mac, status: "portao", criado_em: new Date().toISOString() });
  }
  const atual = lerCatalogo(root);
  atual.criativos.unshift(...feitos);
  gravarCatalogo(root, atual);
  return feitos;
}
