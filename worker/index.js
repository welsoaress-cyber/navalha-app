// Backend do Navalha no Bigode — pagamentos Pix via Mercado Pago
// Secrets necessários (Cloudflare → Settings → Variables and Secrets):
//   MP_ACCESS_TOKEN      — Access Token de produção do Mercado Pago
//   SUPABASE_SERVICE_KEY — service_role key do Supabase

const PLANS = {
  solo:   { name: 'Solo',   monthly: 99,  setup: 150 },
  equipe: { name: 'Equipe', monthly: 149, setup: 300 },
  black:  { name: 'Black',  monthly: 299, setup: 500 },
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    try {
      if (url.pathname === '/api/pix' && request.method === 'POST') return await createPix(request, env)
      if (url.pathname === '/api/pix-status') return await pixStatus(url, env)
      if (url.pathname === '/api/mp-webhook') return await mpWebhook(request, url, env)
    } catch (e) {
      return json({ error: 'internal', detail: String(e) }, 500)
    }
    return env.ASSETS.fetch(request)
  }
}

async function mp(env, path, init = {}) {
  return fetch('https://api.mercadopago.com' + path, {
    ...init,
    headers: {
      'Authorization': 'Bearer ' + env.MP_ACCESS_TOKEN,
      'Content-Type': 'application/json',
      ...(init.headers || {})
    }
  })
}

function sbHeaders(env) {
  return { 'apikey': env.SUPABASE_SERVICE_KEY, 'Authorization': 'Bearer ' + env.SUPABASE_SERVICE_KEY }
}

async function createPix(request, env) {
  if (!env.MP_ACCESS_TOKEN || !env.SUPABASE_SERVICE_KEY) return json({ error: 'not_configured' }, 503)

  let body
  try { body = await request.json() } catch { return json({ error: 'bad_request' }, 400) }
  const shopId = body.barbershop_id
  if (!shopId) return json({ error: 'bad_request' }, 400)

  // Busca a barbearia — o valor é calculado aqui no servidor, nunca vem do navegador
  const sr = await fetch(env.SUPABASE_URL + '/rest/v1/barbershops?id=eq.' + encodeURIComponent(shopId) + '&select=id,name,plan,owner_email,status', {
    headers: sbHeaders(env)
  })
  const rows = await sr.json()
  const shop = Array.isArray(rows) ? rows[0] : null
  if (!shop) return json({ error: 'not_found' }, 404)

  const plan = PLANS[shop.plan] || PLANS.solo
  const amount = plan.monthly + plan.setup
  const origin = new URL(request.url).origin

  // QR expira em 5 minutos (horário expresso em UTC-3)
  const expMs = Date.now() + 5 * 60 * 1000
  const expStr = new Date(expMs - 3 * 3600 * 1000).toISOString().replace('Z', '-03:00')

  const pr = await mp(env, '/v1/payments', {
    method: 'POST',
    headers: { 'X-Idempotency-Key': crypto.randomUUID() },
    body: JSON.stringify({
      transaction_amount: amount,
      description: `Navalha no Bigode — Plano ${plan.name} (1º mês + kit)`,
      payment_method_id: 'pix',
      payer: { email: shop.owner_email || 'cliente@navalhanobigode.com.br' },
      external_reference: shop.id,
      notification_url: origin + '/api/mp-webhook',
      date_of_expiration: expStr,
    })
  })
  const pd = await pr.json()
  if (!pr.ok) return json({ error: 'mp_error', detail: pd && pd.message }, 502)

  const tx = pd.point_of_interaction && pd.point_of_interaction.transaction_data
  return json({
    payment_id: pd.id,
    amount,
    description: `Plano ${plan.name} — 1º mês R$ ${plan.monthly} + Kit R$ ${plan.setup}`,
    qr_code: tx && tx.qr_code,
    qr_base64: tx && tx.qr_code_base64,
    expires_in: 300,
  })
}

async function pixStatus(url, env) {
  const id = url.searchParams.get('id')
  if (!id || !/^\d+$/.test(id)) return json({ error: 'bad_request' }, 400)
  const r = await mp(env, '/v1/payments/' + id)
  if (!r.ok) return json({ error: 'mp_error' }, 502)
  const d = await r.json()
  // Redundância: se o webhook falhar, a própria consulta ativa a barbearia
  if (d.status === 'approved' && d.external_reference) await activate(env, d.external_reference)
  return json({ status: d.status })
}

async function mpWebhook(request, url, env) {
  // O Mercado Pago avisa por query string ou por corpo JSON
  let paymentId = url.searchParams.get('data.id') || url.searchParams.get('id')
  if (!paymentId && request.method === 'POST') {
    try { const b = await request.json(); paymentId = b && b.data && b.data.id } catch {}
  }
  if (paymentId) {
    // Nunca confia no aviso: confirma direto na API do MP
    const r = await mp(env, '/v1/payments/' + paymentId)
    if (r.ok) {
      const d = await r.json()
      if (d.status === 'approved' && d.external_reference) await activate(env, d.external_reference)
    }
  }
  return new Response('ok')
}

async function activate(env, shopId) {
  await fetch(env.SUPABASE_URL + '/rest/v1/barbershops?id=eq.' + encodeURIComponent(shopId) + '&status=neq.active', {
    method: 'PATCH',
    headers: { ...sbHeaders(env), 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
    body: JSON.stringify({ status: 'active' })
  })
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } })
}
