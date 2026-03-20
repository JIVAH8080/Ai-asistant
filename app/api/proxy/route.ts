import { NextRequest, NextResponse } from "next/server"
import { NVIDIA, ANTHROPIC, modelSupportsTools, modelSupportsSystem } from "@/lib/config"
import { sanitizeForStrictAlternation, openaiToAnthropic, type Msg } from "@/lib/sanitize"

export const runtime = "nodejs"
export const maxDuration = 60

const ts = () => new Date().toTimeString().slice(0, 8)
type Body = { messages: Msg[]; tools?: unknown[]; tool_choice?: unknown; max_tokens?: number }

export async function POST(req: NextRequest) {
  let body: Body
  try { body = await req.json() }
  catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }) }

  console.log(`[${ts()}] ▶ NVIDIA  ${NVIDIA.model}`)
  const nv = await tryNvidia(body)
  if (nv.ok && nv.stream) { console.log(`[${ts()}] ✓ NVIDIA`); return sse(nv.stream) }
  console.warn(`[${ts()}] ✗ NVIDIA — ${nv.error}`)

  if (!ANTHROPIC.key) return NextResponse.json({ error: "NVIDIA failed. Set ANTHROPIC_API_KEY." }, { status: 502 })

  console.log(`[${ts()}] ▶ Anthropic fallback`)
  const ant = await tryAnthropic(body)
  if (ant.ok && ant.stream) { console.log(`[${ts()}] ✓ Anthropic`); return sse(ant.stream) }
  console.error(`[${ts()}] ✗ Anthropic — ${ant.error}`)
  return NextResponse.json({ error: `Both failed. ${ant.error}` }, { status: 502 })
}

async function tryNvidia(body: Body) {
  const out: Record<string, unknown> = { ...body, model: NVIDIA.model, stream: true,
    temperature: NVIDIA.temperature, top_p: NVIDIA.top_p, max_tokens: NVIDIA.max_tokens }
  if (!modelSupportsTools(NVIDIA.model)) { delete out.tools; delete out.tool_choice; console.log(`[${ts()}]   tools stripped`) }
  if (!modelSupportsSystem(NVIDIA.model)) { out.messages = sanitizeForStrictAlternation(out.messages as Msg[]); console.log(`[${ts()}]   conversation sanitized`) }
  try {
    const res = await fetch(`https://${NVIDIA.host}${NVIDIA.path}`, { method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${NVIDIA.key}`, "Accept": "text/event-stream" },
      body: JSON.stringify(out) })
    if (!res.ok || !res.body) { const t = await res.text(); return { ok: false as const, error: `HTTP ${res.status}: ${t.slice(0,200)}` } }
    return { ok: true as const, stream: res.body }
  } catch(e) { return { ok: false as const, error: String(e) } }
}

async function tryAnthropic(body: Body) {
  try {
    const res = await fetch(`https://${ANTHROPIC.host}${ANTHROPIC.path}`, { method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC.key,
        "anthropic-version": ANTHROPIC.version, "Accept": "text/event-stream" },
      body: JSON.stringify(openaiToAnthropic(body)) })
    if (!res.ok || !res.body) { const t = await res.text(); return { ok: false as const, error: `HTTP ${res.status}: ${t.slice(0,200)}` } }
    return { ok: true as const, stream: translateAnthropic(res.body) }
  } catch(e) { return { ok: false as const, error: String(e) } }
}

function translateAnthropic(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const enc = new TextEncoder(), dec = new TextDecoder()
  let buf = "", toolIdx = 0, doneSent = false
  const toolMap: Record<number, number> = {}
  const emit = (c: ReadableStreamDefaultController, o: unknown) => c.enqueue(enc.encode(`data: ${JSON.stringify(o)}\n\n`))
  const done = (c: ReadableStreamDefaultController) => { if (!doneSent) { c.enqueue(enc.encode("data: [DONE]\n\n")); doneSent = true } }
  return new ReadableStream({ async start(ctrl) {
    const reader = body.getReader()
    try {
      while (true) {
        const { done: d, value } = await reader.read()
        if (d) { done(ctrl); ctrl.close(); break }
        buf += dec.decode(value, { stream: true })
        const lines = buf.split("\n"); buf = lines.pop() ?? ""
        for (const line of lines) {
          const t = line.trim()
          if (!t.startsWith("data: ")) continue
          const raw = t.slice(6).trim()
          if (!raw || raw === "[DONE]") { done(ctrl); continue }
          let evt: Record<string, unknown>; try { evt = JSON.parse(raw) } catch { continue }
          if (evt.type === "content_block_start") {
            const cb = evt.content_block as { type: string; id?: string; name?: string } | undefined
            if (cb?.type === "tool_use") { const ti = toolIdx++; toolMap[evt.index as number] = ti
              emit(ctrl, { choices: [{ delta: { tool_calls: [{ index: ti, id: cb.id, type: "function", function: { name: cb.name, arguments: "" } }] }, finish_reason: null }] }) }
            continue
          }
          if (evt.type === "content_block_delta") {
            const d2 = evt.delta as { type: string; text?: string; partial_json?: string } | undefined; if (!d2) continue
            if (d2.type === "text_delta" && d2.text) emit(ctrl, { choices: [{ delta: { content: d2.text }, finish_reason: null }] })
            if (d2.type === "input_json_delta" && d2.partial_json !== undefined) {
              const ti = toolMap[evt.index as number]
              if (ti !== undefined) emit(ctrl, { choices: [{ delta: { tool_calls: [{ index: ti, function: { arguments: d2.partial_json } }] }, finish_reason: null }] })
            }
            continue
          }
          if (evt.type === "message_delta") {
            const d3 = evt.delta as { stop_reason?: string } | undefined
            if (d3?.stop_reason) { const r = d3.stop_reason === "tool_use" ? "tool_calls" : "stop"
              emit(ctrl, { choices: [{ delta: {}, finish_reason: r }] }); done(ctrl) }
            continue
          }
          if (evt.type === "message_stop") { done(ctrl); continue }
        }
      }
    } catch(e) { console.error("[translate]", e); ctrl.close() }
  }})
}

function sse(stream: ReadableStream<Uint8Array>) {
  return new Response(stream, { headers: { "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache", "X-Accel-Buffering": "no", "Connection": "keep-alive" } })
}
