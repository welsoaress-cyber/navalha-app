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
      if (url.pathname === '/api/notify' && request.method === 'POST') return await notify(request, env)
      if (url.pathname === '/api/pix-status') return await pixStatus(url, env)
      if (url.pathname === '/api/mp-webhook') return await mpWebhook(request, url, env)
    } catch (e) {
      return json({ error: 'internal', detail: String(e) }, 500)
    }
    return env.ASSETS.fetch(request)
  },

  async scheduled(event, env) {
    await sendReminders(env)
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

  // QR expira em 30 minutos (horário expresso em UTC-3)
  const expMs = Date.now() + 30 * 60 * 1000
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
    expires_in: 1800,
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

  const appLink = 'https://' + shop.slug + '.navalhanobigode.com.br'
  const panel   = appLink + '/painel/'
  const btn = (href, label) => `<a href="${href}" style="display:inline-block;background:#D4A843;color:#0F172A;font-weight:bold;font-size:14px;text-decoration:none;padding:12px 22px;border-radius:10px;">${label}</a>`

  const html = `
  <div style="font-family:Arial,Helvetica,sans-serif;background:#0F172A;padding:32px 16px;">
    <div style="max-width:560px;margin:0 auto;background:#1E293B;border-radius:16px;padding:32px;color:#F8FAFC;">
      <h1 style="color:#D4A843;font-size:22px;margin:0 0 6px;">💈 Navalha no Bigode</h1>
      <p style="color:#94A3B8;font-size:14px;margin:0 0 24px;">Sua barbearia digital está pronta!</p>
      <h2 style="font-size:18px;margin:0 0 16px;">Bem-vindo, ${shop.name}! 🎉</h2>
      <p style="font-size:14px;line-height:1.6;color:#CBD5E1;">Seu cadastro foi concluído. Guarde este e-mail — aqui está tudo o que você precisa para começar:</p>

      <div style="background:#0F172A;border-radius:12px;padding:20px;margin:18px 0;">
        <p style="margin:0 0 6px;font-size:11px;color:#64748B;text-transform:uppercase;letter-spacing:1px;">Seu app de agendamento</p>
        <p style="margin:0 0 8px;font-size:16px;font-weight:bold;color:#F8FAFC;">${shop.slug}.navalhanobigode.com.br</p>
        <p style="margin:0 0 20px;">${btn(appLink, '📲 Abrir meu app')}</p>
        <p style="margin:0 0 6px;font-size:11px;color:#64748B;text-transform:uppercase;letter-spacing:1px;">Seu painel (agenda e configurações)</p>
        <p style="margin:0 0 20px;">${btn(panel, '🗓 Abrir meu painel')}</p>
        <p style="margin:0 0 6px;font-size:11px;color:#64748B;text-transform:uppercase;letter-spacing:1px;">Login</p>
        <p style="margin:0;font-size:14px;color:#F8FAFC;">${shop.owner_email}<br><span style="color:#94A3B8;font-size:12px;">Senha: a que você criou no cadastro</span></p>
      </div>

      <h3 style="font-size:15px;margin:22px 0 10px;color:#D4A843;">Primeiros passos</h3>
      <ol style="font-size:14px;line-height:1.9;color:#CBD5E1;padding-left:20px;margin:0;">
        <li><strong>Instale o app no celular:</strong> abra o link do seu app e toque em "Adicionar à tela inicial" — ele vira um ícone, como qualquer aplicativo.</li>
        <li><strong>Divulgue:</strong> mande o link no WhatsApp dos seus clientes e coloque na bio do Instagram.</li>
        <li><strong>Confira seus horários:</strong> no painel, ajuste os dias e horários de atendimento quando precisar.</li>
        <li><strong>Acompanhe a agenda:</strong> os agendamentos aparecem no painel em tempo real.</li>
      </ol>

      <div style="background:rgba(212,168,67,0.1);border:1px solid rgba(212,168,67,0.3);border-radius:12px;padding:16px;margin-top:22px;">
        <p style="margin:0;font-size:14px;line-height:1.6;color:#F8FAFC;">💳 <strong>Seus cartões estão a caminho!</strong><br>
        <span style="color:#CBD5E1;font-size:13px;">Você vai receber cartões com o QR Code da sua barbearia para distribuir aos clientes. A primeira remessa é por nossa conta — remessas adicionais são cobradas à parte.</span><br><br>
        <span style="color:#CBD5E1;font-size:13px;">🚚 <strong style="color:#F8FAFC;">Prazo de entrega:</strong> impressão e envio em até <strong style="color:#F8FAFC;">15 dias úteis</strong> após a confirmação do pagamento. Enquanto isso, seu app já funciona normalmente.</span></p>
      </div>

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

// ── WhatsApp automático via Evolution API ──
async function evoSend(env, number, text) {
  if (!env.EVOLUTION_APIKEY || !env.EVOLUTION_URL) return false
  const digits = String(number || '').replace(/\D/g, '')
  if (digits.length < 10) return false
  const to = digits.startsWith('55') ? digits : '55' + digits
  try {
    const r = await fetch(`${env.EVOLUTION_URL}/message/sendText/${env.EVOLUTION_INSTANCE || 'servnet'}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': env.EVOLUTION_APIKEY },
      body: JSON.stringify({ number: to, text })
    })
    return r.ok
  } catch (e) { return false }
}

function fmtData(dateStr) {
  const [ano, mes, dia] = dateStr.split('-')
  return `${dia}/${mes}`
}

async function loadBookingFull(env, bookingId) {
  const r = await fetch(env.SUPABASE_URL + '/rest/v1/bookings?id=eq.' + encodeURIComponent(bookingId) +
    '&select=*,services(name),barbers(name),barbershops(name,slug)', { headers: sbHeaders(env) })
  const rows = await r.json()
  return Array.isArray(rows) ? rows[0] : null
}

async function notify(request, env) {
  if (!env.SUPABASE_SERVICE_KEY) return json({ sent: false, reason: 'not_configured' })
  let body
  try { body = await request.json() } catch { return json({ error: 'bad_request' }, 400) }
  if (!body.booking_id || !body.type) return json({ error: 'bad_request' }, 400)

  const bk = await loadBookingFull(env, body.booking_id)
  if (!bk) return json({ sent: false, reason: 'not_found' })

  const shop = bk.barbershops || {}
  const link = `https://${shop.slug}.navalhanobigode.com.br`
  const hora = String(bk.start_time).slice(0, 5)
  const servico = bk.services?.name ? `✂️ ${bk.services.name}\n` : ''
  const barbeiro = bk.barbers?.name ? `💇 Com: ${bk.barbers.name}\n` : ''
  let text = null

  if (body.type === 'booking_new') {
    text = `✅ *Agendamento confirmado!*\n\n💈 ${shop.name}\n${servico}${barbeiro}📅 ${fmtData(bk.date)} às ${hora}\n\nAté lá, ${bk.client_name}! Se precisar remarcar: ${link}`
  } else if (body.type === 'cancel_by_shop') {
    text = `Olá, ${bk.client_name}! Aqui é da ${shop.name}. 💈\n\nInfelizmente precisei desmarcar seu horário de ${fmtData(bk.date)} às ${hora}${bk.services?.name ? ' (' + bk.services.name + ')' : ''} por um imprevisto. Me desculpe!\n\nVocê pode escolher um novo horário por aqui: ${link}`
  }

  if (!text) return json({ error: 'bad_type' }, 400)
  const sent = await evoSend(env, bk.client_phone, text)
  return json({ sent })
}

// Lembretes automáticos: roda de 10 em 10 minutos e avisa quem tem horário em ~2h
async function sendReminders(env) {
  if (!env.SUPABASE_SERVICE_KEY || !env.EVOLUTION_APIKEY) return
  // Agora no fuso de Brasília (UTC-3)
  const nowBR = new Date(Date.now() - 3 * 3600 * 1000)
  const hoje = nowBR.toISOString().slice(0, 10)
  const minAgora = nowBR.getUTCHours() * 60 + nowBR.getUTCMinutes()

  const r = await fetch(env.SUPABASE_URL + '/rest/v1/bookings?date=eq.' + hoje +
    '&status=eq.confirmed&reminder_sent=is.null&select=*,services(name),barbers(name),barbershops(name,slug)', {
    headers: sbHeaders(env)
  })
  const rows = await r.json()
  if (!Array.isArray(rows)) return

  for (const bk of rows) {
    const [h, m] = String(bk.start_time).split(':').map(Number)
    const diff = h * 60 + m - minAgora
    if (diff < 90 || diff > 150) continue // janela de ~2h antes

    const shop = bk.barbershops || {}
    const hora = String(bk.start_time).slice(0, 5)
    const text = `⏰ *Lembrete do seu horário!*\n\n💈 ${shop.name}\n${bk.services?.name ? '✂️ ' + bk.services.name + '\n' : ''}📅 Hoje às ${hora}\n\nTe esperamos, ${bk.client_name}! Se não puder vir, remarque em: https://${shop.slug}.navalhanobigode.com.br`
    const ok = await evoSend(env, bk.client_phone, text)
    if (ok) {
      await fetch(env.SUPABASE_URL + '/rest/v1/bookings?id=eq.' + bk.id, {
        method: 'PATCH',
        headers: { ...sbHeaders(env), 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
        body: JSON.stringify({ reminder_sent: new Date().toISOString() })
      })
    }
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } })
}
