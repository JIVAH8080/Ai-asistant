'use client'

import { useRef, useState, useEffect, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'

interface Msg {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[]
  tool_call_id?: string
  name?: string
}

interface ChatMsg { id: number; role: 'user' | 'assistant'; content: string; streaming?: boolean }

interface BookingData {
  full_name: string; phone: string; email?: string
  service: string; date: string; time: string; confirmation_id: string
}

const SYSTEM = `You are a friendly and professional AI receptionist for Sky Dental NYC.
Responsibilities: answer questions about services, help book appointments, collect patient details.
Tone: polite, calm, reassuring. ONE question per message only. Keep replies to 2-3 sentences max.
Services: General dentistry, Cosmetic dentistry, Dental implants, Invisalign, Teeth whitening, Veneers, Crowns, Bridges, Root canal, Emergency dental care
FAQs:
- Insurance: We accept most major dental insurance plans
- Location: Midtown Manhattan, New York City
- Hours: Monday-Saturday 8AM-7PM
- Emergencies: Same-day or earliest available
- Phone: (212) 555-0100
Booking Flow (one step per message):
1. Ask service needed
2. Ask preferred date
3. Ask preferred time
4. Collect full name
5. Collect phone number
6. Collect email (optional)
7. Call check_availability to verify slot
8. Read back all details, ask patient YES or NO
9. Only after YES - call book_appointment
Rules: NEVER book without check_availability first. NEVER book without YES. Suggest alternatives if unavailable.`

const TOOLS = [
  { type: 'function', function: { name: 'check_availability', description: 'Check available slots for a date',
      parameters: { type: 'object', properties: { date: { type: 'string', description: 'YYYY-MM-DD' }, service: { type: 'string' } }, required: ['date'] } } },
  { type: 'function', function: { name: 'book_appointment', description: 'Book confirmed appointment after patient YES',
      parameters: { type: 'object', properties: { full_name: { type: 'string' }, phone: { type: 'string' }, email: { type: 'string' },
          service: { type: 'string' }, date: { type: 'string' }, time: { type: 'string' } }, required: ['full_name','phone','service','date','time'] } } },
]

const CHIPS = [
  { label: '📅 Book appointment', text: 'I want to book an appointment' },
  { label: '🦷 Services offered',  text: 'What services do you offer?' },
  { label: '💳 Insurance',         text: 'Do you accept insurance?' },
  { label: '🚨 Dental emergency',  text: 'I have a dental emergency' },
  { label: '⏰ Hours & location',  text: 'What are your hours and location?' },
]

const GREETING = "Thank you for contacting Sky Dental NYC! I'm your virtual assistant — I can help you book an appointment, answer questions about our services, or assist with a dental emergency. How can I help you today?"

function execTool(name: string, args: Record<string, string>) {
  if (name === 'check_availability') {
    const slots = ['09:00','10:30','11:00','13:30','14:00','15:30','16:00','17:00']
    return { available: true, date: args.date, service: args.service ?? 'Any', slots, message: `Available on ${args.date}: ${slots.join(', ')}` }
  }
  if (name === 'book_appointment') {
    const id = 'SKY-' + Math.random().toString(36).substr(2,6).toUpperCase()
    return { success: true, confirmation_id: id, ...args }
  }
  return { error: 'Unknown tool' }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const mv = { hidden: { opacity: 0, y: 14 }, show: { opacity: 1, y: 0, transition: { duration: 0.24, ease: [0.25,0.46,0.45,0.94] as number[] } } }

export default function Page() {
  const [messages,  setMessages]  = useState<ChatMsg[]>([])
  const [history,   setHistory]   = useState<Msg[]>([])
  const [input,     setInput]     = useState('')
  const [busy,      setBusy]      = useState(false)
  const [chips,     setChips]     = useState(true)
  const [thinking,  setThinking]  = useState<string | null>(null)
  const [toolLabel, setToolLabel] = useState<string | null>(null)
  const [booking,   setBooking]   = useState<BookingData | null>(null)
  const [greeted,   setGreeted]   = useState(false)

  const ancRef   = useRef<HTMLDivElement>(null)
  const taRef    = useRef<HTMLTextAreaElement>(null)
  const histRef  = useRef<Msg[]>([])

  const scroll = useCallback(() => setTimeout(() => ancRef.current?.scrollIntoView({ behavior: 'smooth' }), 30), [])
  useEffect(() => { histRef.current = history }, [history])

  // Typed greeting on mount
  useEffect(() => {
    if (greeted) return
    setGreeted(true)
    const id = Date.now()
    let out = '', stop = false
    setMessages([{ id, role: 'assistant', content: '', streaming: true }])
    ;(async () => {
      for (const ch of GREETING) {
        if (stop) break
        out += ch
        setMessages(prev => prev.map(m => m.id === id ? { ...m, content: out } : m))
        scroll()
        await sleep(ch === '.' || ch === ',' ? 30 : 10)
      }
      setMessages(prev => prev.map(m => m.id === id ? { ...m, streaming: false } : m))
      const h: Msg[] = [{ role: 'assistant', content: GREETING }]
      setHistory(h); histRef.current = h
    })()
    return () => { stop = true }
  }, [greeted, scroll])

  const runAgent = useCallback(async (userText: string) => {
    const h0: Msg[] = [...histRef.current, { role: 'user', content: userText }]
    setHistory(h0); histRef.current = h0
    setBusy(true)

    try {
      let cur = h0
      while (true) {
        const res = await fetch('/api/proxy', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messages: [{ role: 'system', content: SYSTEM }, ...cur], tools: TOOLS, tool_choice: 'auto' }),
        })
        if (!res.ok || !res.body) throw new Error(`API ${res.status}: ${await res.text()}`)

        const reader = res.body.getReader(), dec = new TextDecoder()
        let buf = '', fullText = '', fullReason = ''
        const toolMap: Record<number, { id: string; name: string; args: string }> = {}
        let hasTools = false, bubbleId: number | null = null

        outer: while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buf += dec.decode(value, { stream: true })
          const lines = buf.split('\n'); buf = lines.pop() ?? ''

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue
            const raw = line.slice(6).trim()
            if (raw === '[DONE]') break outer
            let chunk: { choices?: [{ delta?: { content?: string; reasoning_content?: string; tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[] } }] }
            try { chunk = JSON.parse(raw) } catch { continue }
            const delta = chunk.choices?.[0]?.delta
            if (!delta) continue

            if ('reasoning_content' in delta && delta.reasoning_content) {
              fullReason += delta.reasoning_content as string
              setThinking(fullReason.length > 160 ? '...' + fullReason.slice(-160) : fullReason)
            }

            if (delta.content) {
              fullText += delta.content
              if (bubbleId === null) {
                setThinking(null)
                bubbleId = Date.now()
                setMessages(prev => [...prev, { id: bubbleId!, role: 'assistant', content: fullText, streaming: true }])
              } else {
                setMessages(prev => prev.map(m => m.id === bubbleId ? { ...m, content: fullText } : m))
              }
              scroll()
            }

            if (delta.tool_calls) {
              hasTools = true
              for (const tc of delta.tool_calls) {
                const i = tc.index ?? 0
                if (!toolMap[i]) toolMap[i] = { id: '', name: '', args: '' }
                if (tc.id) toolMap[i].id = tc.id
                if (tc.function?.name) toolMap[i].name += tc.function.name
                if (tc.function?.arguments) toolMap[i].args += tc.function.arguments
              }
            }
          }
        }

        setThinking(null)
        if (bubbleId !== null) setMessages(prev => prev.map(m => m.id === bubbleId ? { ...m, streaming: false } : m))

        if (hasTools && Object.keys(toolMap).length > 0) {
          const calls = Object.values(toolMap)
          const h1: Msg[] = [...cur, { role: 'assistant', content: fullText || null,
            tool_calls: calls.map(tc => ({ id: tc.id, type: 'function' as const, function: { name: tc.name, arguments: tc.args } })) }]

          for (const tc of calls) {
            let args: Record<string, string> = {}
            try { args = JSON.parse(tc.args) } catch { /**/ }
            setToolLabel(tc.name === 'check_availability'
              ? `Checking availability for ${args.date ?? 'requested date'}...`
              : `Booking appointment for ${args.full_name ?? 'patient'}...`)
            await sleep(900)
            setToolLabel(null)
            const result = execTool(tc.name, args)
            if (tc.name === 'book_appointment' && 'success' in result && result.success)
              setBooking(result as unknown as BookingData)
            h1.push({ role: 'tool', tool_call_id: tc.id, name: tc.name, content: JSON.stringify(result) })
          }
          cur = h1; setHistory(h1); histRef.current = h1
          continue
        }

        if (fullText.trim()) {
          const hf: Msg[] = [...cur, { role: 'assistant', content: fullText.trim() }]
          setHistory(hf); histRef.current = hf
        }
        break
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setMessages(prev => [...prev, { id: Date.now(), role: 'assistant', content: `Error: ${msg}` }])
    } finally { setThinking(null); setToolLabel(null); setBusy(false) }
  }, [scroll])

  const send = useCallback(() => {
    const txt = input.trim(); if (!txt || busy) return
    setInput(''); setChips(false)
    if (taRef.current) taRef.current.style.height = 'auto'
    setMessages(prev => [...prev, { id: Date.now(), role: 'user', content: txt }])
    runAgent(txt)
  }, [input, busy, runAgent])

  const onKey = (e: React.KeyboardEvent) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }
  const resize = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value); e.target.style.height = 'auto'; e.target.style.height = e.target.scrollHeight + 'px'
  }

  const showTyping = busy && !thinking && !toolLabel && messages[messages.length-1]?.role === 'user'

  return (
    <div className="flex items-center justify-center h-screen">
      <div className="w-full max-w-[460px] h-screen max-h-[820px] flex flex-col rounded-3xl overflow-hidden"
        style={{ background: '#f7f4ef', boxShadow: '0 24px 80px rgba(0,0,0,.22),0 4px 16px rgba(0,0,0,.10),inset 0 1px 0 rgba(255,255,255,.5)' }}>

        {/* Header */}
        <div className="relative overflow-hidden flex items-center gap-3 px-5 py-[15px] flex-shrink-0"
          style={{ background: 'linear-gradient(150deg,#071f2b 0%,#0a3547 50%,#0c4258 100%)' }}>
          <div className="absolute top-[-30px] right-[-20px] w-[120px] h-[120px] rounded-full pointer-events-none"
            style={{ background: 'radial-gradient(circle,rgba(200,168,75,.2) 0%,transparent 70%)' }}/>
          <div className="w-11 h-11 rounded-full flex-shrink-0 flex items-center justify-center z-10"
            style={{ background: 'rgba(255,255,255,.07)', border: '1px solid rgba(200,168,75,.3)' }}>
            <svg width="21" height="21" viewBox="0 0 24 24" fill="none">
              <path d="M12 2.5C9.8 2.5 8 4.3 8 6.5C8 8 8.8 9.3 10 10.1C9.1 11.7 8.5 13.8 8.5 16C8.5 19.3 9.9 22 12 22C14.1 22 15.5 19.3 15.5 16C15.5 13.8 14.9 11.7 14 10.1C15.2 9.3 16 8 16 6.5C16 4.3 14.2 2.5 12 2.5Z"
                stroke="rgba(255,255,255,.82)" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
              <path d="M9.5 10.8C10.3 11.2 11.1 11.4 12 11.4C12.9 11.4 13.7 11.2 14.5 10.8"
                stroke="#c8a84b" strokeWidth="1.2" strokeLinecap="round"/>
            </svg>
          </div>
          <div className="flex-1 z-10">
            <div style={{ fontFamily: "'Cormorant Garamond',Georgia,serif", fontSize: 19, fontWeight: 600, color: '#fff', lineHeight: 1.1 }}>Sky Dental NYC</div>
            <div style={{ fontSize: 10, color: 'rgba(255,255,255,.45)', letterSpacing: '2px', textTransform: 'uppercase', marginTop: 2, fontWeight: 300 }}>Virtual Receptionist</div>
          </div>
          <div className="flex items-center gap-1.5 z-10" style={{ fontSize: 11, color: 'rgba(255,255,255,.5)', fontWeight: 300 }}>
            <div className="w-[7px] h-[7px] rounded-full bg-green-400" style={{ boxShadow: '0 0 6px rgba(74,222,128,.7)', animation: 'pdot 2.5s ease-in-out infinite' }}/>
            Online
          </div>
        </div>

        {/* Info strip */}
        <div className="flex gap-4 px-5 py-[7px] flex-shrink-0" style={{ background: '#0a3547' }}>
          {[['📍','Midtown Manhattan'],['🕐','Mon–Sat 8AM–7PM'],['🚨','Same-day emergency']].map(([ic,tx]) => (
            <div key={tx} className="flex items-center gap-1" style={{ fontSize: 10, color: 'rgba(255,255,255,.38)', fontWeight: 300 }}>
              <span style={{ color: 'rgba(200,168,75,.7)', fontSize: 12 }}>{ic}</span>{tx}
            </div>
          ))}
        </div>

        {/* Messages */}
        <div className="msgs-scroll flex-1 overflow-y-auto flex flex-col gap-2.5 px-3.5 pt-4 pb-2">
          <AnimatePresence initial={false}>
            {messages.map(m => (
              <motion.div key={m.id} variants={mv} initial="hidden" animate="show"
                className={`flex gap-2 ${m.role === 'user' ? 'flex-row-reverse' : ''}`}>
                {m.role === 'assistant' && (
                  <div className="w-7 h-7 rounded-full flex-shrink-0 mt-0.5 flex items-center justify-center text-[13px]"
                    style={{ background: 'linear-gradient(135deg,#0a3547,#0f5c78)', border: '1.5px solid rgba(200,168,75,.22)' }}>🦷</div>
                )}
                <div className={`max-w-[80%] px-3.5 py-[9px] rounded-2xl break-words ${m.streaming ? 'stream-cursor' : ''} ${
                    m.role === 'user' ? 'text-white rounded-br-[3px]' : 'rounded-bl-[3px]'}`}
                  style={m.role === 'user'
                    ? { background: 'linear-gradient(135deg,#0a3547,#0f5c78)', fontSize: 13.5, lineHeight: 1.58, boxShadow: '0 2px 8px rgba(10,53,71,.3)' }
                    : { background: '#fff', color: '#1a1a1a', fontSize: 13.5, lineHeight: 1.58, boxShadow: '0 1px 3px rgba(0,0,0,.07),0 0 0 1px rgba(0,0,0,.04)' }}>
                  {m.content}
                </div>
              </motion.div>
            ))}
          </AnimatePresence>

          {/* Thinking */}
          <AnimatePresence>
            {thinking && (
              <motion.div key="thk" variants={mv} initial="hidden" animate="show" exit={{ opacity: 0 }} className="flex gap-2">
                <div className="w-7 h-7 rounded-full flex-shrink-0 flex items-center justify-center text-[13px]"
                  style={{ background: 'linear-gradient(135deg,#0a3547,#0f5c78)', border: '1.5px solid rgba(200,168,75,.22)' }}>🦷</div>
                <div className="max-w-[82%] px-3 py-2 rounded-2xl rounded-bl-[3px] relative overflow-hidden"
                  style={{ background: 'linear-gradient(135deg,#fefce8,#fef3c7)', border: '1px solid #fcd34d', fontSize: 11, color: '#78350f', lineHeight: 1.5, fontStyle: 'italic', fontWeight: 300 }}>
                  <div className="absolute inset-0 pointer-events-none" style={{ background: 'linear-gradient(90deg,transparent,rgba(255,255,255,.5),transparent)', backgroundSize: '200% 100%', animation: 'shimmer 1.8s ease-in-out infinite' }}/>
                  <div style={{ fontSize: 9.5, fontWeight: 600, letterSpacing: '1.5px', textTransform: 'uppercase', color: '#92400e', marginBottom: 3, fontStyle: 'normal' }}>⚡ Thinking</div>
                  <div className="relative z-10">{thinking}</div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Tool banner */}
          <AnimatePresence>
            {toolLabel && (
              <motion.div key="tool" variants={mv} initial="hidden" animate="show" exit={{ opacity: 0 }}
                className="ml-9 flex items-center gap-2 px-3 py-2 rounded-xl"
                style={{ background: 'linear-gradient(135deg,#f0f9ff,#e0f2fe)', border: '1px solid #bae6fd', fontSize: 12, color: '#075985', fontWeight: 500 }}>
                <div className="w-3.5 h-3.5 rounded-full flex-shrink-0" style={{ border: '2px solid rgba(7,89,133,.15)', borderTopColor: '#0369a1', animation: 'spin .7s linear infinite' }}/>
                {toolLabel}
              </motion.div>
            )}
          </AnimatePresence>

          {/* Typing dots */}
          <AnimatePresence>
            {showTyping && (
              <motion.div key="typing" variants={mv} initial="hidden" animate="show" exit={{ opacity: 0 }} className="flex gap-2 items-end">
                <div className="w-7 h-7 rounded-full flex-shrink-0 flex items-center justify-center text-[13px]"
                  style={{ background: 'linear-gradient(135deg,#0a3547,#0f5c78)', border: '1.5px solid rgba(200,168,75,.22)' }}>🦷</div>
                <div className="flex gap-1 items-center px-3.5 py-3 rounded-2xl rounded-bl-[3px]"
                  style={{ background: '#fff', boxShadow: '0 1px 3px rgba(0,0,0,.07)' }}>
                  {[0,1,2].map(i => (
                    <div key={i} className="w-1.5 h-1.5 rounded-full"
                      style={{ background: '#0d4a61', opacity: .3, animation: `bounce-dot 1.3s ease-in-out ${i*.16}s infinite` }}/>
                  ))}
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Booking card */}
          <AnimatePresence>
            {booking && (
              <motion.div key="booking"
                initial={{ opacity: 0, y: 14, scale: .97 }}
                animate={{ opacity: 1, y: 0, scale: 1, transition: { duration: .35, ease: [.34,1.56,.64,1] as number[] } }}
                className="ml-9 rounded-2xl p-4"
                style={{ background: 'linear-gradient(135deg,#f0fdf4,#ecfdf5)', border: '1px solid #86efac', boxShadow: '0 2px 12px rgba(22,163,74,.1)' }}>
                <div className="flex items-center gap-2 mb-3 pb-2.5" style={{ fontWeight: 600, color: '#14532d', fontSize: 13, borderBottom: '1px solid rgba(22,163,74,.15)' }}>
                  <div className="w-5 h-5 rounded-full bg-[#22c55e] flex items-center justify-center flex-shrink-0">
                    <svg width="11" height="11" viewBox="0 0 12 12" fill="none"><path d="M2 6l3 3 5-5" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/></svg>
                  </div>
                  Appointment Confirmed
                </div>
                {([['Patient',booking.full_name],['Service',booking.service],['Date',booking.date],['Time',booking.time],['Phone',booking.phone],...(booking.email?[['Email',booking.email]]:[])] as [string,string][]).map(([l,v]) => (
                  <div key={l} className="flex justify-between mb-1.5 gap-2" style={{ fontSize: 12 }}>
                    <span style={{ color: '#6b7280' }}>{l}</span>
                    <span style={{ color: '#111827', fontWeight: 500, textAlign: 'right' }}>{v}</span>
                  </div>
                ))}
                <div className="flex justify-between items-center mt-2.5 px-2.5 py-1.5 rounded-lg"
                  style={{ background: 'rgba(22,163,74,.08)', border: '1px solid rgba(22,163,74,.2)' }}>
                  <span style={{ fontSize: 11, color: '#6b7280' }}>Confirmation ID</span>
                  <span style={{ fontSize: 12.5, color: '#15803d', fontWeight: 700, letterSpacing: 1 }}>{booking.confirmation_id}</span>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          <div ref={ancRef}/>
        </div>

        {/* Quick chips */}
        <AnimatePresence>
          {chips && (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              className="px-3.5 pb-2.5 flex flex-wrap gap-1.5 flex-shrink-0">
              {CHIPS.map(c => (
                <button key={c.label} disabled={busy}
                  onClick={() => { setChips(false); setMessages(prev => [...prev, { id: Date.now(), role: 'user', content: c.label }]); runAgent(c.text) }}
                  className="px-3 py-1.5 rounded-full text-[11.5px] text-gray-700 bg-white cursor-pointer transition-all duration-150 disabled:opacity-40"
                  style={{ border: '1px solid #c4bcb1' }}
                  onMouseEnter={e => { (e.target as HTMLElement).style.borderColor = '#0a3547'; (e.target as HTMLElement).style.color = '#0a3547' }}
                  onMouseLeave={e => { (e.target as HTMLElement).style.borderColor = '#c4bcb1'; (e.target as HTMLElement).style.color = '#374151' }}>
                  {c.label}
                </button>
              ))}
            </motion.div>
          )}
        </AnimatePresence>

        {/* Input */}
        <div className="px-3.5 pb-3.5 pt-2 flex-shrink-0" style={{ borderTop: '1px solid #ddd7ce', background: '#f7f4ef' }}>
          <div className="flex gap-2 items-end rounded-[15px] px-3.5 pt-2 pb-2 transition-all"
            style={{ background: '#fff', border: '1.5px solid #ccc5b9' }}
            onFocus={e => (e.currentTarget.style.borderColor = '#0d4a61')}
            onBlur={e => (e.currentTarget.style.borderColor = '#ccc5b9')}>
            <textarea ref={taRef} rows={1} value={input} onChange={resize} onKeyDown={onKey} disabled={busy}
              placeholder="Type your message…"
              className="flex-1 border-none outline-none resize-none bg-transparent leading-relaxed disabled:opacity-50"
              style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 13.5, color: '#1a1a1a', maxHeight: 90, minHeight: 20, padding: '1px 0' }}/>
            <button onClick={send} disabled={busy || !input.trim()}
              className="w-[34px] h-[34px] rounded-[11px] flex items-center justify-center flex-shrink-0 cursor-pointer transition-all disabled:cursor-not-allowed disabled:opacity-35"
              style={{ background: '#0a3547', border: 'none', color: '#fff' }}
              onMouseEnter={e => !busy && ((e.target as HTMLElement).closest('button')!.style.background = '#0f5c78')}
              onMouseLeave={e => ((e.target as HTMLElement).closest('button')!.style.background = '#0a3547')}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                <path d="M22 2L11 13" stroke="white" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/>
                <path d="M22 2L15 22L11 13L2 9L22 2Z" stroke="white" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </button>
          </div>
          <p className="text-center mt-1.5" style={{ fontSize: 9.5, color: '#b2aa9f', letterSpacing: .3 }}>
            Gemma 2 2B · Claude Sonnet fallback · Sky Dental NYC · (212) 555-0100
          </p>
        </div>

      </div>
    </div>
  )
}
