import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from 'npm:@supabase/supabase-js@2.115.0'

const allowedOrigins = new Set([
  'https://squid-app-4wjgx.ondigitalocean.app',
  'https://hayat-almajd-pharmacy.netlify.app',
  'http://localhost:4173',
  'http://localhost:3000',
])
const requests = new Map<string, { count: number; resetAt: number }>()
const MESSAGE_LIMIT = 15

async function sha256(value: string) {
  const bytes = new TextEncoder().encode(value)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function cors(origin: string | null) {
  return {
    'Access-Control-Allow-Origin': origin && allowedOrigins.has(origin) ? origin : 'https://squid-app-4wjgx.ondigitalocean.app',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json; charset=utf-8',
    'Vary': 'Origin',
  }
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get('origin')
  const headers = cors(origin)
  if (req.method === 'OPTIONS') return new Response('ok', { headers })
  if (req.method !== 'POST' || (origin && !allowedOrigins.has(origin))) return new Response(JSON.stringify({ error: 'غير مسموح' }), { status: 403, headers })

  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'
  const now = Date.now()
  const bucket = requests.get(ip)
  if (!bucket || bucket.resetAt < now) requests.set(ip, { count: 1, resetAt: now + 60_000 })
  else if (++bucket.count > 12) return new Response(JSON.stringify({ error: 'طلبات كثيرة، حاول بعد دقيقة' }), { status: 429, headers })

  try {
    const body = await req.json()
    const message = String(body?.message || '').trim().slice(0, 500)
    const clientId = String(body?.clientId || '').trim()
    if (!message) return new Response(JSON.stringify({ error: 'الرسالة مطلوبة' }), { status: 400, headers })
    if (!/^[0-9a-f-]{36}$/i.test(clientId)) return new Response(JSON.stringify({ error: 'معرّف المستخدم غير صالح' }), { status: 400, headers })

    const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } })
    const clientHash = await sha256(`${clientId}:${ip}`)
    const { data: quotaRows, error: quotaError } = await supabase.rpc('consume_chat_message', { p_client_hash: clientHash, p_limit: MESSAGE_LIMIT })
    if (quotaError) throw quotaError
    const quota = Array.isArray(quotaRows) ? quotaRows[0] : quotaRows
    if (!quota?.allowed) return new Response(JSON.stringify({ error: 'لقد استخدمت الحد الأقصى للمساعد وهو 15 رسالة.', remaining: 0, limit: MESSAGE_LIMIT }), { status: 429, headers })

    const { data: products, error } = await supabase.from('products').select('name,category,price,old_price,stock,description').order('featured', { ascending: false }).limit(250)
    if (error) throw error
    const catalog = (products || []).map((p) => `${p.name} | ${p.category} | ${p.price} د.ع | المخزون ${p.stock} | ${p.description || ''}`).join('\n')
    const history = Array.isArray(body?.history) ? body.history.slice(-8).map((m: {role?: string;text?: string}) => `${m.role === 'assistant' ? 'المساعد' : 'الزبون'}: ${String(m.text || '').slice(0, 500)}`).join('\n') : ''
    const input = `أنت مساعد صيدلية حياة المجد في العراق. أجب بالعربية العراقية الواضحة وباختصار. استخدم فقط معلومات المتجر والكتالوج أدناه ولا تخترع سعرًا أو توفرًا. لا تشخص الأمراض ولا تصف علاجًا؛ عند الأسئلة الطبية الحساسة اطلب مراجعة طبيب أو صيدلاني. الدفع عند الاستلام، وتأكيد الطلب هاتفيًا، والتوصيل لجميع محافظات العراق. إذا لم تجد المنتج قل إنه غير موجود حاليًا واقترح أقرب بديل من الكتالوج.\n\nالكتالوج الحالي:\n${catalog}\n\nسجل المحادثة:\n${history}\n\nالسؤال: ${message}`
    const apiKey = Deno.env.get('GEMINI_API_KEY')
    if (!apiKey) throw new Error('GEMINI_API_KEY is not configured')
    let reply = ''
    try {
      const aiResponse = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: `${input}\n\nأكمل الإجابة في أقل من 120 كلمة.` }] }], generationConfig: { temperature: 0.2, maxOutputTokens: 1400, thinkingConfig: { thinkingBudget: 0 } } }),
        signal: AbortSignal.timeout(18_000),
      })
      if (!aiResponse.ok) throw new Error(`Gemini request failed: ${aiResponse.status} ${(await aiResponse.text()).slice(0, 240)}`)
      const result = await aiResponse.json()
      reply = String(result.candidates?.[0]?.content?.parts?.map((part: {text?: string}) => part.text || '').join('') || '').trim()
    } catch (aiError) {
      console.error(aiError)
      const normalized = message.toLowerCase()
      const matches = (products || []).filter((p) => normalized.includes(String(p.name).toLowerCase()) || normalized.includes(String(p.category).toLowerCase())).slice(0, 5)
      const picks = matches.length ? matches : (products || []).filter((p) => Number(p.stock) > 0).slice(0, 5)
      reply = picks.length
        ? `هذه أبرز المنتجات المتوفرة حاليًا:\n${picks.map((p) => `• ${p.name} — ${p.price} د.ع${Number(p.stock) > 0 ? ' (متوفر)' : ' (غير متوفر)'}`).join('\n')}\nيمكنك فتح المنتج من المتجر لإضافته إلى السلة.`
        : 'لا توجد منتجات مطابقة متوفرة حاليًا. يمكنك التواصل معنا عبر واتساب للمساعدة.'
    }
    if (!reply) throw new Error('No assistant response')
    return new Response(JSON.stringify({ reply, remaining: Number(quota.remaining ?? 0), limit: MESSAGE_LIMIT }), { headers })
  } catch (error) {
    console.error(error)
    return new Response(JSON.stringify({ error: 'تعذر تشغيل المساعد الآن' }), { status: 500, headers })
  }
})
