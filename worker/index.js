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
      if (url.pathname === '/api/welcome' && request.method === 'POST') return await sendWelcome(request, env)
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
  // TESTE: valor fixo de R$ 1,00 — restaurar para (plan.monthly + plan.setup) depois do teste
  const amount = 1
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

// E-mail de boas-vindas com orientações de uso (via Resend)
async function sendWelcome(request, env) {
  if (!env.RESEND_API_KEY || !env.SUPABASE_SERVICE_KEY) return json({ sent: false, reason: 'not_configured' })

  let body
  try { body = await request.json() } catch { return json({ error: 'bad_request' }, 400) }
  if (!body.barbershop_id) return json({ error: 'bad_request' }, 400)

  const sr = await fetch(env.SUPABASE_URL + '/rest/v1/barbershops?id=eq.' + encodeURIComponent(body.barbershop_id) + '&select=id,name,slug,plan,owner_email', {
    headers: sbHeaders(env)
  })
  const rows = await sr.json()
  const shop = Array.isArray(rows) ? rows[0] : null
  if (!shop || !shop.owner_email) return json({ sent: false, reason: 'not_found' })

  const origin  = new URL(request.url).origin
  const appLink = origin + '/?barbearia=' + shop.slug
  const panel   = origin + '/painel/'

  const html = `
  <div style="font-family:Arial,Helvetica,sans-serif;background:#0F172A;padding:32px 16px;">
    <div style="max-width:560px;margin:0 auto;background:#1E293B;border-radius:16px;padding:32px;color:#F8FAFC;">
      <h1 style="color:#D4A843;font-size:22px;margin:0 0 6px;">💈 Navalha no Bigode</h1>
      <p style="color:#94A3B8;font-size:14px;margin:0 0 24px;">Sua barbearia digital está pronta!</p>
      <h2 style="font-size:18px;margin:0 0 16px;">Bem-vindo, ${shop.name}! 🎉</h2>
      <p style="font-size:14px;line-height:1.6;color:#CBD5E1;">Seu cadastro foi concluído. Guarde este e-mail — aqui está tudo o que você precisa para começar:</p>

      <div style="background:#0F172A;border-radius:12px;padding:18px;margin:18px 0;">
        <p style="margin:0 0 4px;font-size:11px;color:#64748B;text-transform:uppercase;letter-spacing:1px;">Link de agendamento (envie aos seus clientes)</p>
        <p style="margin:0 0 14px;"><a href="${appLink}" style="color:#D4A843;font-size:14px;word-break:break-all;">${appLink}</a></p>
        <p style="margin:0 0 4px;font-size:11px;color:#64748B;text-transform:uppercase;letter-spacing:1px;">Seu painel (agenda e configurações)</p>
        <p style="margin:0 0 14px;"><a href="${panel}" style="color:#D4A843;font-size:14px;">${panel}</a></p>
        <p style="margin:0 0 4px;font-size:11px;color:#64748B;text-transform:uppercase;letter-spacing:1px;">Login</p>
        <p style="margin:0;font-size:14px;color:#F8FAFC;">${shop.owner_email}<br><span style="color:#94A3B8;font-size:12px;">Senha: a que você criou no cadastro</span></p>
      </div>

      <h3 style="font-size:15px;margin:22px 0 10px;color:#D4A843;">Primeiros passos</h3>
      <ol style="font-size:14px;line-height:1.9;color:#CBD5E1;padding-left:20px;margin:0;">
        <li><strong>Salve o app no celular:</strong> abra o link de agendamento e use "Adicionar à tela inicial" no navegador.</li>
        <li><strong>Divulgue:</strong> mande o link de agendamento no WhatsApp dos seus clientes e coloque na bio do Instagram.</li>
        <li><strong>Confira seus horários:</strong> no painel, ajuste os dias e horários de atendimento quando precisar.</li>
        <li><strong>Acompanhe a agenda:</strong> os agendamentos aparecem no painel em tempo real.</li>
      </ol>

      <p style="font-size:13px;color:#94A3B8;margin-top:24px;">Dúvidas? Fale com a gente: <a href="https://wa.me/5511954490001" style="color:#D4A843;">WhatsApp</a></p>
    </div>
  </div>`

  const mr = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: env.MAIL_FROM || 'Navalha no Bigode <contato@navalhanobigode.com.br>',
      to: [shop.owner_email],
      subject: `💈 ${shop.name} — seu app está pronto! Dados de acesso e primeiros passos`,
      html
    })
  })
  return json({ sent: mr.ok })
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } })
}
