export interface Msg {
  role: "system" | "user" | "assistant" | "tool"
  content: string | null
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[]
  tool_call_id?: string
  name?: string
}

export function sanitizeForStrictAlternation(messages: Msg[]): Msg[] {
  let sys = ""
  const noSys = messages.filter(m => { if (m.role === "system") { sys = m.content ?? ""; return false } return true })
  const noTools = noSys.filter(m => m.role === "user" || m.role === "assistant")
  let i = 0
  while (i < noTools.length && noTools[i].role === "assistant") i++
  const trimmed = noTools.slice(i)
  if (trimmed.length === 0) return [{ role: "user", content: sys ? "[Instructions]
" + sys + "

Hello." : "Hello." }]
  const out: Msg[] = []
  for (const m of trimmed) {
    const prev = out[out.length - 1]
    if (prev && prev.role === m.role) prev.content = (prev.content ?? "") + "
" + (m.content ?? "")
    else out.push({ role: m.role, content: m.content })
  }
  if (sys) { const fi = out.findIndex(m => m.role === "user"); if (fi !== -1) out[fi].content = "[Instructions]
" + sys + "

" + (out[fi].content ?? "") }
  return out
}

export function openaiToAnthropic(body: { messages: Msg[]; tools?: unknown[]; max_tokens?: number }) {
  const { messages, tools = [], max_tokens = 1024 } = body
  let system = ""
  const rest = messages.filter(m => { if (m.role === "system") { system = m.content ?? ""; return false } return true })
  const converted: unknown[] = []
  let i = 0
  while (i < rest.length) {
    const m = rest[i]
    if (m.role === "tool") {
      const results: unknown[] = []
      while (i < rest.length && rest[i].role === "tool") {
        results.push({ type: "tool_result", tool_use_id: rest[i].tool_call_id, content: rest[i].content })
        i++
      }
      converted.push({ role: "user", content: results }); continue
    }
    if (m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
      const content: unknown[] = []
      if (m.content) content.push({ type: "text", text: m.content })
      for (const tc of m.tool_calls) {
        let input: Record<string, unknown> = {}; try { input = JSON.parse(tc.function.arguments || "{}") } catch { /**/ }
        content.push({ type: "tool_use", id: tc.id, name: tc.function.name, input })
      }
      converted.push({ role: "assistant", content }); i++; continue
    }
    converted.push({ role: m.role, content: m.content ?? "" }); i++
  }
  const anthropicTools = (tools as { function: { name: string; description: string; parameters: unknown } }[])
    .map(t => ({ name: t.function.name, description: t.function.description ?? "", input_schema: t.function.parameters }))
  return { model: "claude-sonnet-4-20250514", max_tokens, messages: converted, stream: true,
    ...(system ? { system } : {}), ...(anthropicTools.length ? { tools: anthropicTools } : {}) }
}
