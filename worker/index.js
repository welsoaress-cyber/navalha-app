// Backend do Navalha no Bigode — pagamentos Pix via Mercado Pago
// Secrets necessários (Cloudflare → Settings → Variables and Secrets):
//   MP_ACCESS_TOKEN      — Access Token de produção do Mercado Pago
//   SUPABASE_SERVICE_KEY — service_role key do Supabase

const PRECO_POR_BARBEIRO = 39.90   // R$/barbeiro/mês (a partir do 2º mês)
const KIT_PRICE          = 150     // kit de cartões com QR Code + configuração (opcional)

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    try {
      if (url.pathname === '/api/pix' && request.method === 'POST') return await createPix(request, env)
      if (url.pathname === '/api/renew-pix' && request.method === 'POST') return await renewPix(request, env)
      if (url.pathname === '/api/activate-free'  && request.method === 'POST') return await activateFree(request, env)
      if (url.pathname === '/api/trial-activate' && request.method === 'POST') return await trialActivate(request, env)
      if (url.pathname === '/api/trial-invite' && request.method === 'POST') return await trialInvite(request, env)
      if (url.pathname === '/api/admin-stats') return await adminStats(request, env)
      if (url.pathname === '/api/admin-bookings') return await adminBookings(request, env, url)
      if (url.pathname === '/api/admin-email' && request.method === 'POST') return await adminChangeEmail(request, env)
      if (url.pathname.startsWith('/late/')) return await latePage(url.pathname.slice(6).split('/')[0], env)
      if (url.pathname === '/api/late-act' && request.method === 'POST') return await lateAct(request, env)
      if (url.pathname === '/api/reschedule' && request.method === 'POST') return await reschedule(request, env)
      if (url.pathname.startsWith('/c/')) return await cancelPage(url.pathname.slice(3).split('/')[0], env)
      if (url.pathname === '/api/cancel-act' && request.method === 'POST') return await cancelAct(request, env)
      if (url.pathname === '/api/free-now' && request.method === 'POST') return await freeNow(request, env)
      if (url.pathname === '/api/cards-pix' && request.method === 'POST') return await cardsPix(request, env)
      if (url.pathname === '/api/pos-pix' && request.method === 'POST') return await posPix(request, env)
      if (url.pathname === '/pagar') return await payPage(request, env)
      if (url.pathname === '/api/welcome' && request.method === 'POST') return await sendWelcome(request, env)
      if (url.pathname === '/api/notify' && request.method === 'POST') return await notify(request, env)
      if (url.pathname === '/api/cascade' && request.method === 'POST') return await cascadeStart(request, env)
      if (url.pathname === '/api/offer' && request.method === 'POST') return await offerAct(request, env)
      if (url.pathname === '/api/offer') return await offerPage(url.searchParams.get('t'), 'token', env)
      if (url.pathname.startsWith('/o/')) return await offerPage(url.pathname.slice(3).split('/')[0], 'code', env)
      if (url.pathname === '/api/pix-status') return await pixStatus(url, env)
      if (url.pathname === '/api/mp-webhook') return await mpWebhook(request, url, env)
      if (url.pathname === '/sitemap.xml') return sitemap(url)
    } catch (e) {
      return json({ error: 'internal', detail: String(e) }, 500)
    }
    // cadastro.navalhanobigode.com.br serve o cadastro direto na raiz (domínio bonito nos anúncios)
    if (url.hostname === 'cadastro.navalhanobigode.com.br' && (url.pathname === '/' || url.pathname === '/index.html')) {
      const u = new URL(request.url)
      u.pathname = '/cadastro/'
      return env.ASSETS.fetch(new Request(u, request))
    }
    return env.ASSETS.fetch(request)
  },

  async scheduled(event, env) {
    await sendReminders(env)
    await lateTimeouts(env)
    await processExpiredOffers(env)
    await checkBilling(env)
    await sendWeeklyReports(env)
    await sendOnboardingReminders(env)
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
  const sr = await fetch(env.SUPABASE_URL + '/rest/v1/barbershops?id=eq.' + encodeURIComponent(shopId) + '&select=id,name,owner_email,status', {
    headers: sbHeaders(env)
  })
  const rows = await sr.json()
  const shop = Array.isArray(rows) ? rows[0] : null
  if (!shop) return json({ error: 'not_found' }, 404)

  // Kit de instalação: 1º mês é grátis — a única cobrança no cadastro é o kit (opcional)
  const amount = KIT_PRICE
  const origin = new URL(request.url).origin

  // QR expira em 30 minutos (horário expresso em UTC-3)
  const expMs = Date.now() + 30 * 60 * 1000
  const expStr = new Date(expMs - 3 * 3600 * 1000).toISOString().replace('Z', '-03:00')

  const pr = await mp(env, '/v1/payments', {
    method: 'POST',
    headers: { 'X-Idempotency-Key': crypto.randomUUID() },
    body: JSON.stringify({
      transaction_amount: amount,
      description: 'Navalha no Bigode — Kit de Instalação (100 cartões com QR Code + configuração)',
      payment_method_id: 'pix',
      // E-mail interno de propósito: evita o MP mandar e-mails duplicados ao barbeiro (a comunicação é nossa)
      payer: { email: 'pagamentos@navalhanobigode.com.br' },
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
    amount: String(amount),
    description: 'Kit de Instalação — 100 cartões com QR Code + configuração',
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
  // Redundância: se o webhook falhar, a própria consulta ativa/renova a barbearia
  if (d.status === 'approved') await handleApproved(env, d)
  return json({ status: d.status })
}

// Um pagamento aprovado pode ser a adesão (ref = id da barbearia) ou a mensalidade (ref = "ren:id")
async function handleApproved(env, d) {
  const ref = d.external_reference || ''
  if (!ref) return
  if (ref.startsWith('ren:')) await renewShop(env, ref.slice(4), String(d.id))
  else if (ref.startsWith('card:')) await cardsApproved(env, ref.slice(5), String(d.id))
  else if (ref.startsWith('pos:')) await posApproved(env, ref.slice(4), String(d.id))
  else if (ref.startsWith('nokit:')) await activate(env, ref.slice(6), false)
  else await activate(env, ref)
}

// ── Maquininha Point oferecida no cadastro (venda casada) ──
// Preços conferidos no portal do programa de revendedores (preço unitário do kit x2).
// Frete = SEDEX 10 estimado. Atualizar aqui + cadastro/index.html juntos.
const POS_ATIVO = true
const POS = {
  pro3:   { nome: 'Maquininha Point Pro 3',   preco: 89,  frete: 25 },
  smart2: { nome: 'Maquininha Point Smart 2', preco: 199, frete: 25 }
}
const VENDAS_PHONE = '5511954490001' // WhatsApp da operação de maquininhas (público na landing)

async function posPix(request, env) {
  if (!env.MP_ACCESS_TOKEN || !env.SUPABASE_SERVICE_KEY) return json({ error: 'not_configured' }, 503)
  if (!POS_ATIVO) return json({ error: 'disabled' }, 503)
  let body
  try { body = await request.json() } catch { return json({ error: 'bad_request' }, 400) }
  const item = POS[body.model]
  if (!item || !/^[a-f0-9-]+$/.test(body.barbershop_id || '')) return json({ error: 'bad_request' }, 400)

  const [shop] = await sb(env, `barbershops?id=eq.${body.barbershop_id}&select=id,name`) || []
  if (!shop) return json({ error: 'not_found' }, 404)

  const amount = item.preco + item.frete
  const origin = new URL(request.url).origin
  const expStr = new Date(Date.now() + 24 * 3600 * 1000 - 3 * 3600 * 1000).toISOString().replace('Z', '-03:00')
  const pr = await mp(env, '/v1/payments', {
    method: 'POST',
    headers: { 'X-Idempotency-Key': crypto.randomUUID() },
    body: JSON.stringify({
      transaction_amount: amount,
      description: `${item.nome} + frete SEDEX`,
      payment_method_id: 'pix',
      payer: { email: 'pagamentos@navalhanobigode.com.br' },
      external_reference: 'pos:' + shop.id + ':' + body.model,
      notification_url: origin + '/api/mp-webhook',
      date_of_expiration: expStr,
    })
  })
  const pd = await pr.json()
  if (!pr.ok) return json({ error: 'mp_error' }, 502)
  const tx = pd.point_of_interaction && pd.point_of_interaction.transaction_data
  return json({ payment_id: pd.id, amount: fmtValor(amount), qr_code: tx && tx.qr_code, qr_base64: tx && tx.qr_code_base64 })
}

async function posApproved(env, refRest, paymentId) {
  const [shopId, model] = String(refRest).split(':')
  const item = POS[model] || POS.pro3
  const [shop] = await sb(env, `barbershops?id=eq.${shopId}&select=id,name,slug,owner_phone,last_pos_payment_id`) || []
  if (!shop) return
  if (shop.last_pos_payment_id === paymentId) return // webhook repete; processa uma vez
  await sb(env, `barbershops?id=eq.${shopId}`, { method: 'PATCH', body: JSON.stringify({ last_pos_payment_id: paymentId }) })
  if (shop.owner_phone) await evoSend(env, shop.owner_phone,
    `🛒 *Pedido confirmado: ${item.nome}!*\n\n💈 ${shop.name}\nSua maquininha sai via *SEDEX 10* — chega rapidinho.\n\n📦 Me responde aqui com o *endereço completo com CEP* pra eu despachar hoje!\n\n🚀 Quando chegar, ativa em 10 minutos com este passo a passo:\nhttps://navalhanobigode.com.br/maquininha/ativar/`)
  await evoSend(env, env.ADMIN_PHONE || VENDAS_PHONE,
    `🛒 *VENDA DE MAQUININHA!*\n\n${shop.name} (${shop.slug}) pagou ${item.nome} + frete.\nPega o endereço na conversa do robô e posta via SEDEX 10. 📦`)
}

// ── Pedido de cartões pelo painel ──
// Nunca pagou o kit (entrou pelo teste grátis) → paga o kit cheio do plano, como cliente novo.
// Já pagou o kit na adesão → paga só a remessa de reposição.
const CARD_REPO_PRICE = 100
async function cardsPix(request, env) {
  if (!env.MP_ACCESS_TOKEN || !env.SUPABASE_SERVICE_KEY) return json({ error: 'not_configured' }, 503)
  let body
  try { body = await request.json() } catch { return json({ error: 'bad_request' }, 400) }
  const shopId = body.barbershop_id
  if (!shopId || !/^[a-f0-9-]+$/.test(shopId)) return json({ error: 'bad_request' }, 400)

  const [shop] = await sb(env, `barbershops?id=eq.${shopId}&select=id,name,kit_paid`) || []
  if (!shop) return json({ error: 'not_found' }, 404)

  const primeiro = !shop.kit_paid
  const valor = primeiro ? KIT_PRICE : CARD_REPO_PRICE
  const origin = new URL(request.url).origin
  const expStr = new Date(Date.now() + 24 * 3600 * 1000 - 3 * 3600 * 1000).toISOString().replace('Z', '-03:00')

  const pr = await mp(env, '/v1/payments', {
    method: 'POST',
    headers: { 'X-Idempotency-Key': crypto.randomUUID() },
    body: JSON.stringify({
      transaction_amount: valor,
      description: primeiro
        ? 'Navalha no Bigode — Kit de Instalação (100 cartões com QR Code + configuração)'
        : 'Navalha no Bigode — Remessa de cartões (reposição)',
      payment_method_id: 'pix',
      payer: { email: 'pagamentos@navalhanobigode.com.br' },
      external_reference: 'card:' + shop.id,
      notification_url: origin + '/api/mp-webhook',
      date_of_expiration: expStr,
    })
  })
  const pd = await pr.json()
  if (!pr.ok) return json({ error: 'mp_error', detail: pd && pd.message }, 502)
  const tx = pd.point_of_interaction && pd.point_of_interaction.transaction_data
  return json({ payment_id: pd.id, amount: fmtValor(valor), primeiro, qr_code: tx && tx.qr_code, qr_base64: tx && tx.qr_code_base64 })
}

async function cardsApproved(env, shopId, paymentId) {
  const [shop] = await sb(env, `barbershops?id=eq.${shopId}&select=id,name,slug,owner_phone,last_card_payment_id`) || []
  if (!shop) return
  if (shop.last_card_payment_id === paymentId) return // webhook repete o aviso; processa uma vez
  await sb(env, `barbershops?id=eq.${shopId}`, {
    method: 'PATCH',
    body: JSON.stringify({ kit_paid: true, last_card_payment_id: paymentId })
  })
  if (shop.owner_phone) await evoSend(env, shop.owner_phone,
    `✅ *Pedido de cartões confirmado!*\n\n💈 ${shop.name}\nSeus cartões com QR Code entram em produção e chegam em até *15 dias úteis*. 🚚\n\nEnquanto isso, seu link continua funcionando normalmente.`)
  if (env.ADMIN_PHONE) await evoSend(env, env.ADMIN_PHONE,
    `🖨️ *Pedido de cartões pago!*\n\n${shop.name} (${shop.slug}) — hora de produzir a remessa.`)
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
      if (d.status === 'approved') await handleApproved(env, d)
    }
  }
  return new Response('ok')
}

async function activate(env, shopId, kitPaid = true) {
  await fetch(env.SUPABASE_URL + '/rest/v1/barbershops?id=eq.' + encodeURIComponent(shopId) + '&status=neq.active', {
    method: 'PATCH',
    headers: { ...sbHeaders(env), 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
    body: JSON.stringify({ status: 'active', next_due: addMonths(todayBR(), 1), kit_paid: kitPaid, activated_at: new Date().toISOString() })
  })
  // WhatsApp de boas-vindas — mensagem varia conforme o barbeiro pagou ou não o kit
  const [shop] = await sb(env, `barbershops?id=eq.${shopId}&select=name,slug,owner_phone,referred_by`) || []
  if (shop?.owner_phone) {
    const msgBase = kitPaid
      ? `✅ *Kit confirmado — barbearia no ar!*\n\n💈 ${shop.name} está ativa e seus cartões entram em produção (chegam em até 15 dias úteis).\n\n📲 Link pros seus clientes agendarem:\nhttps://${shop.slug}.navalhanobigode.com.br\n\n🖥️ Seu painel:\nhttps://${shop.slug}.navalhanobigode.com.br/painel/\n\nA partir de agora eu confirmo, lembro e cuido da sua agenda. Qualquer dúvida, é só chamar! 🤝`
      : `🎉 *Boas-vindas! Seu 1º mês é grátis.*\n\n💈 ${shop.name} já está no ar.\n\n📲 Link pros seus clientes agendarem:\nhttps://${shop.slug}.navalhanobigode.com.br\n\n🖥️ Seu painel:\nhttps://${shop.slug}.navalhanobigode.com.br/painel/\n\nA partir de agora eu confirmo, lembro e cuido da sua agenda. 🤝\n\n💳 *Quer cartões com QR Code pra distribuir?* São 100 cartões por R$150, impressos com o link da sua barbearia. É só pedir pelo painel quando quiser!`
    await evoSend(env, shop.owner_phone,
      msgBase + `\n\n💳 *Aproveita e pede sua maquininha* — chip 4G incluso, imprime comprovante, sai SEDEX 10 pra todo Brasil. Só R$89. Me chama aqui se quiser! 📦\n\n🤝 *Indica pra um amigo barbeiro e ganha desconto!* Cada indicado que assinar desconta R$30/mês na sua mensalidade.\n\n👉 Toca aqui pra mandar a indicação já com a mensagem pronta:\n${refShareLink(shop.slug)}`)
  }
  // Notifica o indicador quando o indicado vira cliente pago
  if (shop?.referred_by) {
    const [referrer] = await sb(env, `barbershops?slug=eq.${encodeURIComponent(shop.referred_by)}&select=name,slug,owner_phone`) || []
    if (referrer?.owner_phone) {
      await evoSend(env, referrer.owner_phone,
        `🎉 *Indicação confirmada!*\n\nSua indicação *${shop.name}* acabou de assinar o Navalha!\n\nO desconto de R$30 cai na sua próxima mensalidade automaticamente. Continue indicando — cada um conta! 💪\n\nSeu link de indicação:\nhttps://cadastro.navalhanobigode.com.br/?ref=${referrer.slug}`)
    }
  }
}

// ── 1 mês grátis (convite do canal direto — código de USO ÚNICO) ──
// Cada convite é gerado pelo admin (/api/trial-invite), vale uma vez e morre ao ser usado.
// Ao fim do mês grátis, a cobrança normal assume: aviso 3 dias antes, bloqueio no vencimento.
const TRIAL_DAYS = 30
const ADMIN_EMAIL = 'welsoaress@gmail.com'

// Valida que a requisição vem do admin logado (token da sessão Supabase)
async function adminOk(request, env) {
  const auth = request.headers.get('Authorization') || ''
  if (!auth.startsWith('Bearer ')) return false
  const ur = await fetch(env.SUPABASE_URL + '/auth/v1/user', {
    headers: { apikey: env.SUPABASE_SERVICE_KEY, Authorization: auth }
  })
  if (!ur.ok) return false
  const u = await ur.json()
  return (u.email || '').toLowerCase() === ADMIN_EMAIL
}

// Estatísticas por barbearia pro painel admin (total, últimos 7 dias, futuros)
async function adminStats(request, env) {
  if (!env.SUPABASE_SERVICE_KEY) return json({ error: 'not_configured' }, 503)
  if (!(await adminOk(request, env))) return json({ error: 'forbidden' }, 403)
  const r = await fetch(env.SUPABASE_URL + '/rest/v1/bookings?select=barbershop_id,date,status&status=neq.blocked', {
    headers: { ...sbHeaders(env), Range: '0-9999' }
  })
  const rows = await r.json()
  if (!Array.isArray(rows)) return json({ stats: {} })
  const hoje = todayBR()
  const semanaIni = addDays(hoje, -7)
  const stats = {}
  for (const b of rows) {
    const s = stats[b.barbershop_id] || (stats[b.barbershop_id] = { total: 0, semana: 0, futuros: 0 })
    s.total++
    if (b.date >= semanaIni && b.date <= hoje) s.semana++
    if (b.date >= hoje && b.status === 'confirmed') s.futuros++
  }
  return json({ stats })
}

// Corrige o e-mail de um cliente (login + cadastro) — barbeiro digitou errado no cadastro
async function adminChangeEmail(request, env) {
  if (!env.SUPABASE_SERVICE_KEY) return json({ error: 'not_configured' }, 503)
  if (!(await adminOk(request, env))) return json({ error: 'forbidden' }, 403)
  let body
  try { body = await request.json() } catch { return json({ error: 'bad_request' }, 400) }
  const shopId = body.barbershop_id || ''
  const novo = String(body.new_email || '').trim().toLowerCase()
  if (!/^[a-f0-9-]{36}$/.test(shopId) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(novo)) return json({ error: 'bad_request' }, 400)

  const [shop] = await sb(env, `barbershops?id=eq.${shopId}&select=id,owner_email`) || []
  if (!shop) return json({ error: 'not_found' }, 404)
  const antigo = (shop.owner_email || '').toLowerCase()

  // Acha o usuário de login pelo e-mail antigo e atualiza direto no Auth (senha continua a mesma)
  let authUpdated = false
  if (antigo) {
    const lr = await fetch(env.SUPABASE_URL + '/auth/v1/admin/users?per_page=1000', {
      headers: { apikey: env.SUPABASE_SERVICE_KEY, Authorization: 'Bearer ' + env.SUPABASE_SERVICE_KEY }
    })
    const ld = await lr.json()
    const user = (ld.users || []).find(u => (u.email || '').toLowerCase() === antigo)
    if (user) {
      const ur = await fetch(env.SUPABASE_URL + '/auth/v1/admin/users/' + user.id, {
        method: 'PUT',
        headers: { apikey: env.SUPABASE_SERVICE_KEY, Authorization: 'Bearer ' + env.SUPABASE_SERVICE_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: novo, email_confirm: true })
      })
      authUpdated = ur.ok
    }
  }
  await sb(env, `barbershops?id=eq.${shopId}`, { method: 'PATCH', body: JSON.stringify({ owner_email: novo }) })
  return json({ ok: true, auth_updated: authUpdated, old_email: antigo || null })
}

// Detalhe dos agendamentos de uma barbearia pro painel admin
async function adminBookings(request, env, url) {
  if (!env.SUPABASE_SERVICE_KEY) return json({ error: 'not_configured' }, 503)
  if (!(await adminOk(request, env))) return json({ error: 'forbidden' }, 403)
  const shopId = url.searchParams.get('shop') || ''
  if (!/^[a-f0-9-]{36}$/.test(shopId)) return json({ error: 'bad_request' }, 400)
  const r = await fetch(env.SUPABASE_URL + '/rest/v1/bookings?barbershop_id=eq.' + shopId +
    '&status=neq.blocked&select=date,start_time,client_name,client_phone,status,services(name),barbers(name)' +
    '&order=date.desc,start_time.desc', {
    headers: { ...sbHeaders(env), Range: '0-199' }
  })
  const rows = await r.json()
  return json({ bookings: Array.isArray(rows) ? rows : [] })
}

// Gera um convite novo — só o admin logado consegue (valida o token da sessão Supabase)
async function trialInvite(request, env) {
  if (!env.SUPABASE_SERVICE_KEY) return json({ error: 'not_configured' }, 503)
  if (!(await adminOk(request, env))) return json({ error: 'forbidden' }, 403)

  let body = {}
  try { body = await request.json() } catch {}
  const alfabeto = 'abcdefghjkmnpqrstuvwxyz23456789'
  const code = Array.from(crypto.getRandomValues(new Uint8Array(8))).map(b => alfabeto[b % alfabeto.length]).join('')
  const ins = await fetch(env.SUPABASE_URL + '/rest/v1/trial_invites', {
    method: 'POST',
    headers: { ...sbHeaders(env), 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
    body: JSON.stringify({ code, label: String(body.label || '').slice(0, 80) })
  })
  if (!ins.ok) return json({ error: 'insert_failed' }, 500)
  return json({ ok: true, code, url: 'https://cadastro.navalhanobigode.com.br/?teste=' + code })
}

async function trialActivate(request, env) {
  if (!env.SUPABASE_SERVICE_KEY) return json({ error: 'not_configured' }, 503)
  let body
  try { body = await request.json() } catch { return json({ error: 'bad_request' }, 400) }
  if (!body.barbershop_id || !body.code) return json({ error: 'forbidden' }, 403)

  const r = await fetch(env.SUPABASE_URL + '/rest/v1/barbershops?id=eq.' + encodeURIComponent(body.barbershop_id) +
    '&select=id,slug,name,status,next_due,owner_phone,referred_by', { headers: sbHeaders(env) })
  const rows = await r.json()
  const shop = Array.isArray(rows) ? rows[0] : null
  if (!shop) return json({ error: 'not_found' }, 404)
  // Reload da tela final depois de já ativado: responde sucesso, sem gastar outro convite
  if (shop.status === 'active' && shop.next_due) return json({ ok: true, next_due: shop.next_due })
  if (shop.status === 'active' || shop.next_due) return json({ error: 'already_active' }, 409)

  // Convite de uso único: precisa existir e nunca ter sido usado
  const code = String(body.code).trim().toLowerCase()
  const ir = await fetch(env.SUPABASE_URL + '/rest/v1/trial_invites?code=eq.' + encodeURIComponent(code) +
    '&select=id,used_at', { headers: sbHeaders(env) })
  const invs = await ir.json()
  const inv = Array.isArray(invs) ? invs[0] : null
  if (!inv || inv.used_at) return json({ error: 'invalid_invite' }, 403)

  // Marca como usado ANTES de ativar (guarda used_at is null evita corrida/duplo uso)
  const mark = await fetch(env.SUPABASE_URL + '/rest/v1/trial_invites?id=eq.' + inv.id + '&used_at=is.null', {
    method: 'PATCH',
    headers: { ...sbHeaders(env), 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
    body: JSON.stringify({ used_at: new Date().toISOString(), used_by: shop.id })
  })
  const marked = await mark.json()
  if (!Array.isArray(marked) || !marked.length) return json({ error: 'invalid_invite' }, 403)

  const trialUntil = addDays(todayBR(), TRIAL_DAYS)
  await fetch(env.SUPABASE_URL + '/rest/v1/barbershops?id=eq.' + encodeURIComponent(shop.id) + '&status=neq.active', {
    method: 'PATCH',
    headers: { ...sbHeaders(env), 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
    body: JSON.stringify({ status: 'active', next_due: trialUntil, activated_at: new Date().toISOString() })
  })
  if (shop.owner_phone) {
    await evoSend(env, shop.owner_phone,
      `🎁 *Teste grátis ativado!*\n\n💈 ${shop.name} já está no ar.\n\n📲 Link pros seus clientes agendarem (manda no grupo, no status, em todo lugar):\nhttps://${shop.slug}.navalhanobigode.com.br\n\n🖥️ Seu painel (agenda e configurações):\nhttps://${shop.slug}.navalhanobigode.com.br/painel/\n\nSeu teste vale até *${fmtData(trialUntil)}*. A partir de agora eu confirmo, lembro e cuido da sua agenda. Qualquer dúvida, é só chamar! 🤝\n\n💳 *Aproveita e pede sua maquininha* — chip 4G incluso, imprime comprovante, sai SEDEX 10 pra todo Brasil. Só R$89. Me chama aqui se quiser! 📦\n\n🤝 *Indica pra um amigo barbeiro e ganha desconto!* Cada indicado que assinar desconta R$30/mês na sua mensalidade.\n\n👉 Toca aqui pra mandar a indicação já com a mensagem pronta:\n${refShareLink(shop.slug)}`)
  }
  // Notifica o indicador quando o indicado ativa o teste
  if (shop.referred_by) {
    const [referrer] = await sb(env, `barbershops?slug=eq.${encodeURIComponent(shop.referred_by)}&select=name,slug,owner_phone`) || []
    if (referrer?.owner_phone) {
      await evoSend(env, referrer.owner_phone,
        `🎉 *Sua indicação chegou!*\n\n*${shop.name}* acabou de ativar o teste grátis do Navalha pelo seu link!\n\nSe virar cliente pago, R$30 cai direto na sua próxima mensalidade. Continue indicando! 💪\n\nSeu link de indicação:\nhttps://cadastro.navalhanobigode.com.br/?ref=${referrer.slug}`)
    }
  }
  return json({ ok: true, next_due: trialUntil })
}

// ── Ativação gratuita (sem kit) — 1º mês grátis, sem Pix ──
async function activateFree(request, env) {
  if (!env.SUPABASE_SERVICE_KEY) return json({ error: 'not_configured' }, 503)
  let body
  try { body = await request.json() } catch { return json({ error: 'bad_request' }, 400) }
  const shopId = body.barbershop_id
  if (!shopId || !/^[a-f0-9-]+$/.test(shopId)) return json({ error: 'bad_request' }, 400)
  const [shop] = await sb(env, `barbershops?id=eq.${encodeURIComponent(shopId)}&select=id,activated_at`) || []
  if (!shop) return json({ error: 'not_found' }, 404)
  if (shop.activated_at) return json({ ok: true, next_due: addMonths(todayBR(), 1) }) // já ativo: idempotente
  await activate(env, shopId, false)  // kit_paid = false — sem cartões físicos por enquanto
  return json({ ok: true, next_due: addMonths(todayBR(), 1) })
}

// ── Sitemap ──
function sitemap(url) {
  const host = url.hostname
  // Para o domínio cadastro, aponta só o cadastro.
  // Para qualquer outro (landing, subdomínios), lista as rotas públicas deste worker.
  const urls = host === 'cadastro.navalhanobigode.com.br'
    ? [`https://${host}/`]
    : [
        `https://navalhanobigode.com.br/`,
        `https://cadastro.navalhanobigode.com.br/`,
      ]
  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...urls.map(u => `  <url><loc>${u}</loc><changefreq>weekly</changefreq><priority>0.9</priority></url>`),
    '</urlset>',
  ].join('\n')
  return new Response(xml, {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': 'public, max-age=86400',
    }
  })
}

// ── Cobrança mensal via Pix ──
function todayBR() { return new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10) }
function addDays(dateStr, n) { return new Date(Date.parse(dateStr) + n * 86400000).toISOString().slice(0, 10) }
function diasEntre(a, b) { return Math.round((Date.parse(a) - Date.parse(b)) / 86400000) }
function addMonths(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number)
  const alvo = new Date(Date.UTC(y, m - 1 + n, 1))
  const ultimo = new Date(Date.UTC(alvo.getUTCFullYear(), alvo.getUTCMonth() + 1, 0)).getUTCDate()
  alvo.setUTCDate(Math.min(d, ultimo))
  return alvo.toISOString().slice(0, 10)
}

// Mensalidade: R$39,90 × barbeiros ativos; 10% de desconto no mês do aniversário
function valorMensal(shop, barberCount, referralCount = 0) {
  const mesRef = (shop.next_due || todayBR()).slice(5, 7)
  const aniver = !!(shop.owner_birthday && String(shop.owner_birthday).slice(5, 7) === mesRef)
  const base = Math.round(barberCount * PRECO_POR_BARBEIRO * 100) / 100
  const valorBase = aniver ? Math.round(base * 0.9 * 100) / 100 : base
  const refDesc = referralCount > 0 ? Math.min(referralCount * 30, valorBase) : 0
  const valor = Math.max(Math.round((valorBase - refDesc) * 100) / 100, 0)
  return { valor, aniver, refDesc, barberCount }
}

// Conta barbeiros ativos de uma barbearia (base do cálculo da mensalidade)
async function contarBarbeiros(env, shopId) {
  const rows = await sb(env, `barbers?barbershop_id=eq.${encodeURIComponent(shopId)}&active=eq.true&select=id`)
  return Array.isArray(rows) && rows.length > 0 ? rows.length : 1
}

// Conta indicados ativos de uma barbearia (para desconto de indicação)
async function contarIndicados(env, slug) {
  if (!slug) return 0
  const rows = await sb(env, `barbershops?referred_by=eq.${encodeURIComponent(slug)}&status=eq.active&select=id`)
  return Array.isArray(rows) ? rows.length : 0
}
function fmtValor(v) { return Number.isInteger(v) ? String(v) : v.toFixed(2).replace('.', ',') }

// Gera o Pix da mensalidade (só o valor mensal, sem kit) — válido por 24h
async function renewPix(request, env) {
  if (!env.MP_ACCESS_TOKEN || !env.SUPABASE_SERVICE_KEY) return json({ error: 'not_configured' }, 503)
  let body
  try { body = await request.json() } catch { return json({ error: 'bad_request' }, 400) }
  const shopId = body.barbershop_id
  if (!shopId || !/^[a-f0-9-]+$/.test(shopId)) return json({ error: 'bad_request' }, 400)

  const [shop] = await sb(env, `barbershops?id=eq.${shopId}&select=id,name,slug,owner_email,next_due,owner_birthday`) || []
  if (!shop) return json({ error: 'not_found' }, 404)
  if (!shop.next_due) return json({ error: 'not_active' }, 409)

  const barberCount = await contarBarbeiros(env, shopId)
  const referralCount = await contarIndicados(env, shop.slug)
  const { valor, aniver, refDesc } = valorMensal(shop, barberCount, referralCount)
  const origin = new URL(request.url).origin
  const expStr = new Date(Date.now() + 24 * 3600 * 1000 - 3 * 3600 * 1000).toISOString().replace('Z', '-03:00')

  const pr = await mp(env, '/v1/payments', {
    method: 'POST',
    headers: { 'X-Idempotency-Key': crypto.randomUUID() },
    body: JSON.stringify({
      transaction_amount: valor,
      description: `Navalha no Bigode — Mensalidade (${barberCount} barbeiro${barberCount > 1 ? 's' : ''} × R$ ${fmtValor(PRECO_POR_BARBEIRO)})${aniver ? ' — 10% aniversário' : ''}${refDesc > 0 ? ` (−R$${fmtValor(refDesc)} indicação)` : ''}`,
      payment_method_id: 'pix',
      // E-mail interno de propósito: evita o MP mandar e-mails duplicados ao barbeiro (a comunicação é nossa)
      payer: { email: 'pagamentos@navalhanobigode.com.br' },
      external_reference: 'ren:' + shop.id,
      notification_url: origin + '/api/mp-webhook',
      date_of_expiration: expStr,
    })
  })
  const pd = await pr.json()
  if (!pr.ok) return json({ error: 'mp_error', detail: pd && pd.message }, 502)
  const tx = pd.point_of_interaction && pd.point_of_interaction.transaction_data
  return json({ payment_id: pd.id, amount: fmtValor(valor), birthday: aniver, referral_discount: refDesc || 0, referral_count: referralCount, barber_count: barberCount, qr_code: tx && tx.qr_code, qr_base64: tx && tx.qr_code_base64 })
}

// Mensalidade paga: empurra o vencimento +1 mês e reativa tudo na hora
async function renewShop(env, shopId, paymentId) {
  const [shop] = await sb(env, `barbershops?id=eq.${shopId}&select=id,name,slug,next_due,owner_phone,owner_birthday,last_renewal_payment_id`) || []
  if (!shop) return
  if (shop.last_renewal_payment_id === paymentId) return // webhook repete o aviso; cobra só uma vez

  const hoje = todayBR()
  const base = (shop.next_due && shop.next_due > hoje) ? shop.next_due : hoje
  const novo = addMonths(base, 1)
  await sb(env, `barbershops?id=eq.${shop.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ status: 'active', next_due: novo, last_renewal_payment_id: paymentId })
  })
  const barberCount = await contarBarbeiros(env, shopId)
  const referralCount = await contarIndicados(env, shop.slug)
  const { valor, aniver, refDesc } = valorMensal(shop, barberCount, referralCount)
  const indicMsg = refDesc > 0 ? `\n🤝 Desconto de indicação: −R$ ${fmtValor(refDesc)} (${referralCount} indicado${referralCount > 1 ? 's' : ''} ativo${referralCount > 1 ? 's' : ''})` : ''
  await evoSend(env, shop.owner_phone,
    `✅ *Pagamento recebido!*\n\n💈 ${shop.name}\nMensalidade de R$ ${fmtValor(valor)} confirmada.${aniver ? '\n🎂 Com 10% de desconto de aniversário!' : ''}${indicMsg}\nSeu sistema está garantido até *${fmtData(novo)}*. Obrigado! 🤝`)
}

// ── Onboarding 48h: barbearias que ativaram mas não configuraram serviços/horários ──
// Roda no cron às 10h; dispara uma vez por barbearia (marca onboarding_sent_at).
async function sendOnboardingReminders(env) {
  if (!env.SUPABASE_SERVICE_KEY || !env.EVOLUTION_APIKEY) return
  const nowBR = new Date(Date.now() - 3 * 3600 * 1000)
  if (nowBR.getUTCHours() !== 10) return // 10h de Brasília

  // Ativas, sem lembrete enviado, ativadas há pelo menos 48h
  const limite = new Date(Date.now() - 48 * 3600 * 1000).toISOString()
  const shops = await sb(env,
    `barbershops?status=eq.active&onboarding_sent_at=is.null&activated_at=not.is.null` +
    `&activated_at=lte.${encodeURIComponent(limite)}` +
    `&owner_phone=not.is.null&select=id,name,slug,owner_phone`)
  if (!Array.isArray(shops)) return

  for (const shop of shops) {
    // Marca antes de qualquer ação para não disparar duas vezes se o cron sobrepuser
    await sb(env, `barbershops?id=eq.${shop.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ onboarding_sent_at: todayBR() })
    })

    // Verifica se já tem serviços cadastrados
    const servs = await sb(env, `services?barbershop_id=eq.${shop.id}&active=eq.true&select=id`)
    const temServicos = Array.isArray(servs) && servs.length > 0

    // Verifica se algum barbeiro tem horários definidos
    const barbs = await sb(env, `barbers?barbershop_id=eq.${shop.id}&active=eq.true&select=id`)
    let temHorarios = false
    if (Array.isArray(barbs) && barbs.length > 0) {
      const ids = barbs.map(b => b.id).join(',')
      const avail = await sb(env, `availability?barber_id=in.(${ids})&select=id`)
      temHorarios = Array.isArray(avail) && avail.length > 0
    }

    if (temServicos && temHorarios) continue // já configurado, nada a fazer

    const faltam = []
    if (!temServicos) faltam.push('• *Serviços* (corte, barba, etc.) com preço e duração')
    if (!temHorarios) faltam.push('• *Dias e horários* de atendimento')

    await evoSend(env, shop.owner_phone,
      `💈 *Oi, ${shop.name}!*\n\nVi aqui que sua barbearia ainda não está pronta pra receber clientes. Falta configurar:\n\n${faltam.join('\n')}\n\nSem isso, os clientes chegam no link e não conseguem agendar. Leva menos de 5 minutos:\n\n🖥️ https://${shop.slug}.navalhanobigode.com.br/painel/\n\nQualquer dúvida, é só chamar! 🤝`)
  }
}

// Roda no cron: avisos 3 dias antes / no dia, bloqueio ao vencer e suspensão após 5 dias
async function checkBilling(env) {
  if (!env.SUPABASE_SERVICE_KEY) return
  const nowBR = new Date(Date.now() - 3 * 3600 * 1000)
  if (nowBR.getUTCHours() !== 9) return // mensagens de cobrança saem às 9h de Brasília

  const hoje = todayBR()
  const shops = await sb(env,
    `barbershops?status=eq.active&next_due=not.is.null&next_due=lte.${addDays(hoje, 3)}` +
    `&select=id,name,slug,owner_phone,next_due,owner_birthday,billing_notified_3d,billing_notified_due,billing_notified_overdue`)
  if (!Array.isArray(shops)) return

  for (const shop of shops) {
    const barberCount = await contarBarbeiros(env, shop.id)
    const referralCount = await contarIndicados(env, shop.slug)
    const { valor, aniver, refDesc } = valorMensal(shop, barberCount, referralCount)
    const preco = `R$ ${fmtValor(valor)}`
    const brinde = aniver ? '\n🎂 Mês do seu aniversário: já apliquei *10% de desconto*!' : ''
    const indicBonus = refDesc > 0 ? `\n🤝 Desconto de indicação: −R$ ${fmtValor(refDesc)} (${referralCount} indicado${referralCount > 1 ? 's' : ''} ativo${referralCount > 1 ? 's' : ''})` : ''
    const due = shop.next_due
    const diff = diasEntre(due, hoje) // dias até vencer (negativo = vencido)
    const linkPagar = `${shop.slug}.navalhanobigode.com.br/pagar`
    const patch = obj => sb(env, `barbershops?id=eq.${shop.id}`, { method: 'PATCH', body: JSON.stringify(obj) })

    if (diff >= 1 && diff <= 3 && shop.billing_notified_3d !== due) {
      const ok = await evoSend(env, shop.owner_phone,
        `💈 *${shop.name}*\n\nSua mensalidade (${preco}) vence ${diff === 1 ? '*amanhã*' : `em *${diff} dias*`}, dia ${fmtData(due)}.${brinde}${indicBonus}\n\nPague com 1 toque (Pix):\n${linkPagar}`)
      if (ok) await patch({ billing_notified_3d: due })
    } else if (diff === 0 && shop.billing_notified_due !== due) {
      const ok = await evoSend(env, shop.owner_phone,
        `💈 *${shop.name}*\n\n⚠️ Sua mensalidade (${preco}) vence *hoje*, dia ${fmtData(due)}.${brinde}${indicBonus}\n\nPague agora e não perca o acesso ao painel:\n${linkPagar}`)
      if (ok) await patch({ billing_notified_due: due })
    } else if (diff < 0) {
      if (shop.billing_notified_overdue !== due) {
        const ok = await evoSend(env, shop.owner_phone,
          `💈 *${shop.name}*\n\n🔒 Sua mensalidade venceu dia ${fmtData(due)} e o painel foi *bloqueado* — seus clientes continuam agendando, mas você não vê a agenda.\n\nPague o Pix de ${preco} e o acesso volta na hora:\n${linkPagar}`)
        if (ok) await patch({ billing_notified_overdue: due })
      }
      if (diff <= -6) {
        await patch({ status: 'suspended' })
        await evoSend(env, shop.owner_phone,
          `💈 *${shop.name}*\n\n🚫 Com ${-diff} dias de atraso, sua página de agendamento *saiu do ar* — seus clientes não conseguem mais agendar.\n\nPague o Pix de ${preco} e tudo volta na hora:\n${linkPagar}`)
      }
    }
  }
}

// ── Relatório semanal: toda segunda às 9h, resumo dos últimos 7 dias no WhatsApp do dono ──
async function sendWeeklyReports(env) {
  if (!env.SUPABASE_SERVICE_KEY || !env.EVOLUTION_APIKEY) return
  const nowBR = new Date(Date.now() - 3 * 3600 * 1000)
  if (nowBR.getUTCDay() !== 1 || nowBR.getUTCHours() !== 9) return // segunda-feira, 9h de Brasília

  const hoje = todayBR()
  const ini = addDays(hoje, -7), fim = addDays(hoje, -1)          // semana que passou
  const iniAnt = addDays(hoje, -14), fimAnt = addDays(hoje, -8)   // semana anterior (comparação)

  const shops = await sb(env, `barbershops?status=eq.active&owner_phone=not.is.null&select=id,name,slug,owner_phone,weekly_report_sent`)
  if (!Array.isArray(shops)) return

  for (const shop of shops) {
    if (shop.weekly_report_sent === hoje) continue // já enviado nesta segunda

    const bks = await sb(env, `bookings?barbershop_id=eq.${shop.id}&date=gte.${ini}&date=lte.${fim}` +
      `&status=in.(confirmed,completed,cancelled,no_show)&select=status,services(name,price)`)
    const antes = await sb(env, `bookings?barbershop_id=eq.${shop.id}&date=gte.${iniAnt}&date=lte.${fimAnt}` +
      `&status=in.(confirmed,completed,cancelled,no_show)&select=id`)
    const ofertas = await sb(env, `slot_offers?barbershop_id=eq.${shop.id}&status=eq.accepted&date=gte.${ini}&date=lte.${fim}&select=id`)
    if (!Array.isArray(bks)) continue

    const total = bks.length
    const cancelados = bks.filter(b => b.status === 'cancelled').length
    const atendidos = total - cancelados
    const pct = n => total ? Math.round(n / total * 100) : 0
    const reaproveitados = Array.isArray(ofertas) ? ofertas.length : 0
    const validos = bks.filter(b => b.status !== 'cancelled')
    const ganho = validos.reduce((s, b) => s + Number(b.services?.price || 0), 0)
    const media = atendidos ? ganho / atendidos : 0

    // Top 5 serviços mais pedidos
    const porServico = {}
    for (const b of validos) {
      const nome = b.services?.name || 'Outros'
      porServico[nome] = (porServico[nome] || 0) + 1
    }
    const top = Object.entries(porServico).sort((a, b) => b[1] - a[1]).slice(0, 5)
    const medalhas = ['🥇', '🥈', '🥉', '4º', '5º']
    const topTxt = top.map(([nome, n], i) =>
      `${medalhas[i]} ${nome} — ${n} (${atendidos ? Math.round(n / atendidos * 100) : 0}%)`).join('\n')

    // Comparação com a semana anterior
    const totalAnt = Array.isArray(antes) ? antes.length : 0
    let comparacao = ''
    if (totalAnt > 0) {
      const delta = Math.round((total - totalAnt) / totalAnt * 100)
      comparacao = delta > 0 ? ` (📈 +${delta}% vs semana anterior)` : delta < 0 ? ` (📉 ${delta}% vs semana anterior)` : ' (= semana anterior)'
    }

    let text
    if (total === 0) {
      text = `📊 *Resumo da semana — ${shop.name}*\n🗓 ${fmtData(ini)} a ${fmtData(fim)}\n\n` +
        `Nenhum agendamento esta semana. 😕\n\nDica: mande o link ${shop.slug}.navalhanobigode.com.br nos grupos e no status do WhatsApp — é o jeito mais rápido de encher a agenda! 💈`
    } else {
      text = `📊 *Resumo da semana — ${shop.name}*\n🗓 ${fmtData(ini)} a ${fmtData(fim)}\n\n` +
        `📅 Agendamentos: *${total}*${comparacao}\n` +
        `✅ Atendidos: ${atendidos} (${pct(atendidos)}%)\n` +
        `❌ Cancelamentos: ${cancelados} (${pct(cancelados)}%)\n` +
        (reaproveitados ? `⚡ Horários reaproveitados: ${reaproveitados}\n` : '') +
        (ganho ? `💰 Ganho estimado: R$ ${fmtValor(Math.round(ganho * 100) / 100)} (média R$ ${fmtValor(Math.round(media * 100) / 100)} por atendimento)\n` : '') +
        (topTxt ? `\n🏆 *Mais pedidos:*\n${topTxt}\n` : '') +
        `\nBora pra mais uma semana! 💈`
    }

    const ok = await evoSend(env, shop.owner_phone, text)
    if (ok) await sb(env, `barbershops?id=eq.${shop.id}`, { method: 'PATCH', body: JSON.stringify({ weekly_report_sent: hoje }) })
  }
}

// Página de pagamento da mensalidade: slug.navalhanobigode.com.br/pagar
async function payPage(request, env) {
  const url = new URL(request.url)
  let slug = url.searchParams.get('s')
  if (!slug && url.hostname.endsWith('.navalhanobigode.com.br')) slug = url.hostname.split('.')[0]
  if (!slug || !/^[a-z0-9-]+$/.test(slug)) return offerHtml(offerMsg('Página não encontrada', 'Confira o link recebido no WhatsApp.'))

  const [shop] = await sb(env, `barbershops?slug=eq.${slug}&select=id,name,plan,next_due,owner_birthday`) || []
  if (!shop) return offerHtml(offerMsg('Barbearia não encontrada', 'Confira o link recebido no WhatsApp.'))
  if (!shop.next_due) return offerHtml(offerMsg('Cadastro ainda não concluído', 'Esta barbearia ainda não ativou o plano. Conclua o cadastro e o pagamento em navalhanobigode.com.br.'))

  const plan = PLANS[shop.plan] || PLANS.solo
  const { valor, aniver } = valorMensal(shop, plan)
  const hoje = todayBR()
  const vencida = shop.next_due && shop.next_due < hoje
  const situacao = shop.next_due
    ? (vencida ? `<span style="color:#f87171;font-weight:bold;">Venceu dia ${fmtData(shop.next_due)}</span>` : `Vence dia ${fmtData(shop.next_due)}`)
    : ''

  return offerHtml(`
    ${offerMsg(shop.name, `Mensalidade do plano ${plan.name} — <strong style="color:#F8FAFC;">R$ ${fmtValor(valor)}</strong><br>${situacao}${aniver ? '<br><span style="color:#D4A843;">🎂 Mês do seu aniversário: 10% de desconto aplicado!</span>' : ''}`)}
    <div id="pix" style="margin-top:20px;color:#94A3B8;font-size:14px;">Gerando seu Pix…</div>
    <script>
      const pixEl = document.getElementById('pix')
      let pollTimer = null
      async function gera() {
        pixEl.innerHTML = 'Gerando seu Pix…'
        try {
          const r = await fetch('/api/renew-pix', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ barbershop_id: '${shop.id}' }) })
          const d = await r.json()
          if (!d.qr_base64) throw new Error('sem qr')
          pixEl.innerHTML =
            '<img src="data:image/png;base64,' + d.qr_base64 + '" style="width:210px;border-radius:12px;background:#fff;padding:8px;" alt="QR Code Pix">' +
            '<p style="font-size:13px;color:#94A3B8;margin:14px 0 8px;">Escaneie o QR Code no app do seu banco<br>ou use o copia e cola:</p>' +
            '<input id="cec" readonly value="' + d.qr_code + '" style="width:100%;padding:10px;border-radius:8px;border:1px solid #334155;background:#1E293B;color:#94A3B8;font-size:11px;">' +
            '<button onclick="copia()" id="btnCopia" style="width:100%;margin-top:8px;padding:13px;border-radius:10px;border:none;background:#D4A843;color:#0F172A;font-weight:bold;font-size:15px;cursor:pointer;">📋 Copiar código Pix</button>' +
            '<p style="font-size:12px;color:#64748B;margin-top:10px;">Assim que pagar, a confirmação é automática.</p>'
          pollTimer = setInterval(async () => {
            try {
              const s = await fetch('/api/pix-status?id=' + d.payment_id).then(x => x.json())
              if (s.status === 'approved') {
                clearInterval(pollTimer)
                document.getElementById('box').innerHTML = '<div style="font-size:44px;margin-bottom:12px;">✅</div><h2 style="color:#4ade80;margin:0 0 10px;">Pagamento confirmado!</h2><p style="color:#94A3B8;font-size:15px;line-height:1.6;">Seu sistema está liberado. Enviamos a confirmação no seu WhatsApp.</p><a href="/painel/" style="display:inline-block;margin-top:16px;background:#D4A843;color:#0F172A;font-weight:bold;text-decoration:none;padding:13px 24px;border-radius:10px;">Abrir meu painel</a>'
              }
            } catch (e) {}
          }, 5000)
        } catch (e) {
          pixEl.innerHTML = '<p style="color:#f87171;font-size:14px;">Não foi possível gerar o Pix.</p><button onclick="gera()" style="margin-top:8px;padding:12px 22px;border-radius:10px;border:1px solid #334155;background:none;color:#F8FAFC;cursor:pointer;">Tentar de novo</button>'
        }
      }
      function copia() {
        const cec = document.getElementById('cec')
        cec.select(); cec.setSelectionRange(0, 99999)
        navigator.clipboard.writeText(cec.value).catch(() => document.execCommand('copy'))
        document.getElementById('btnCopia').textContent = '✅ Copiado!'
        setTimeout(() => { const b = document.getElementById('btnCopia'); if (b) b.textContent = '📋 Copiar código Pix' }, 2500)
      }
      gera()
    </script>`)
}

// E-mail de boas-vindas com orientações de uso (via Resend)
async function sendWelcome(request, env) {
  if (!env.RESEND_API_KEY || !env.SUPABASE_SERVICE_KEY) return json({ sent: false, reason: 'not_configured' })

  let body
  try { body = await request.json() } catch { return json({ error: 'bad_request' }, 400) }
  if (!body.barbershop_id) return json({ error: 'bad_request' }, 400)

  const sr = await fetch(env.SUPABASE_URL + '/rest/v1/barbershops?id=eq.' + encodeURIComponent(body.barbershop_id) + '&select=id,name,slug,kit_paid,owner_email', {
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

      ${shop.kit_paid ? `
      <div style="background:rgba(212,168,67,0.1);border:1px solid rgba(212,168,67,0.3);border-radius:12px;padding:16px;margin-top:22px;">
        <p style="margin:0;font-size:14px;line-height:1.6;color:#F8FAFC;">💳 <strong>Seus cartões estão a caminho!</strong><br>
        <span style="color:#CBD5E1;font-size:13px;">Você vai receber 100 cartões com o QR Code da sua barbearia para distribuir aos clientes.</span><br><br>
        <span style="color:#CBD5E1;font-size:13px;">🚚 <strong style="color:#F8FAFC;">Prazo de entrega:</strong> impressão e envio em até <strong style="color:#F8FAFC;">15 dias úteis</strong> após a confirmação do pagamento. Enquanto isso, seu app já funciona normalmente.</span></p>
      </div>` : `
      <div style="background:rgba(212,168,67,0.07);border:1px solid rgba(212,168,67,0.2);border-radius:12px;padding:16px;margin-top:22px;">
        <p style="margin:0;font-size:14px;line-height:1.6;color:#F8FAFC;">💳 <strong>Quer cartões com QR Code?</strong><br>
        <span style="color:#CBD5E1;font-size:13px;">São 100 cartões impressos com o link da sua barbearia para distribuir aos clientes. <strong style="color:#F8FAFC;">R$150</strong> — você pode pedir quando quiser pelo seu painel.</span></p>
      </div>`}

      <div style="background:rgba(43,217,122,0.07);border:1px solid rgba(43,217,122,0.25);border-radius:12px;padding:16px;margin-top:16px;">
        <p style="margin:0;font-size:14px;line-height:1.6;color:#F8FAFC;">💳 <strong>Quer aceitar cartão no balcão?</strong><br>
        <span style="color:#CBD5E1;font-size:13px;">Tô com maquininha Point Pro 3 por <strong style="color:#F8FAFC;">R$89</strong> — chip 4G incluso, imprime comprovante e sai SEDEX 10 pra qualquer estado. Responde este e-mail ou chama no WhatsApp!</span></p>
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

// Link wa.me com mensagem pré-escrita de indicação — o barbeiro toca e o WhatsApp abre pronto pra mandar
function refShareLink(slug) {
  const url = `https://cadastro.navalhanobigode.com.br/?ref=${slug}`
  const texto = encodeURIComponent(
    `Ei! Tô usando o Navalha no Bigode na minha barbearia — clientes agendam sozinhos pelo celular, 24h, sem baixar nada. Tem um robô que recupera horário cancelado automaticamente. R$39,90/barbeiro/mês e o 1º mês é grátis.\nCrie a sua: ${url}`)
  return `https://wa.me/?text=${texto}`
}

async function loadBookingFull(env, bookingId) {
  const r = await fetch(env.SUPABASE_URL + '/rest/v1/bookings?id=eq.' + encodeURIComponent(bookingId) +
    '&select=*,services(name),barbers(name),barbershops(name,slug,owner_phone)', { headers: sbHeaders(env) })
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
  const link = `${shop.slug}.navalhanobigode.com.br`
  const hora = String(bk.start_time).slice(0, 5)
  const servico = bk.services?.name ? `✂️ ${bk.services.name}\n` : ''
  const barbeiro = bk.barbers?.name ? `💇 Com: ${bk.barbers.name}\n` : ''
  let text = null

  if (body.type === 'booking_new') {
    const obs = bk.notes ? `📝 Obs: ${bk.notes}\n` : ''
    text = `✅ *Agendamento confirmado!*\n\n💈 ${shop.name}\n${servico}${barbeiro}${obs}📅 ${fmtData(bk.date)} às ${hora}\n\nAté lá, ${bk.client_name}!\nRemarcar: ${link}\nNão vai poder ir? Cancele: https://${shop.slug}.navalhanobigode.com.br/c/${bk.id}`
    // Barbearia demo: quem agenda é dono de barbearia testando — a confirmação vira convite
    if (shop.slug === 'demo') {
      text += `\n\n—\n🤖 Gostou? Esse robô sou eu, o *Navalha no Bigode*. Na SUA barbearia eu faria tudo isso sozinho:\n\n` +
        `✅ Confirmo cada agendamento na hora\n` +
        `⏰ Lembro o cliente antes do corte (adeus, furo de horário)\n` +
        `⚡ Alguém cancelou? Ofereço a vaga pro próximo cliente no mesmo minuto\n` +
        `🤝 Agradeço depois do corte e convido o cliente a voltar\n` +
        `📊 Toda segunda te mando o resumo: agendamentos, faturamento e os cortes mais pedidos\n` +
        `📱 E sua barbearia ganha link próprio de agendamento + painel completo\n\n` +
        `🚀 Fica pronto no MESMO dia, configurado por nós.\nR$ 39,90/barbeiro/mês — 1º mês 100% grátis:\n👉 cadastro.navalhanobigode.com.br`
    }
  } else if (body.type === 'booking_done') {
    text = `💈 *${shop.name}*\n\nObrigado pela visita, ${bk.client_name}! ✂️✨\nEsperamos que tenha ficado no capricho.\n\nQuando precisar, é só agendar de novo: ${link}\n\nAté a próxima! 🤝`
  } else if (body.type === 'late_check') {
    // Atraso em minutos, no fuso de Brasília
    const nowBR = new Date(Date.now() - 3 * 3600 * 1000)
    const minAgora = nowBR.getUTCHours() * 60 + nowBR.getUTCMinutes()
    const [lh, lm] = String(bk.start_time).split(':').map(Number)
    const atraso = Math.max(1, minAgora - (lh * 60 + lm))
    text = `💈 *${shop.name}*\n\nOi, ${bk.client_name}! Você tem um horário marcado às *${hora}* — já são *${atraso} min* de atraso.\n\n*Tá chegando?* Toque e responda:\nhttps://${shop.slug}.navalhanobigode.com.br/late/${bk.id}\n\n⏳ Sem resposta em *${LATE_TIMEOUT_MIN} minutos*, o horário pode ser liberado pra outro cliente.`
  } else if (body.type === 'cancel_by_shop') {
    text = `Olá, ${bk.client_name}! Aqui é da ${shop.name}. 💈\n\nInfelizmente precisei desmarcar seu horário de ${fmtData(bk.date)} às ${hora}${bk.services?.name ? ' (' + bk.services.name + ')' : ''} por um imprevisto. Me desculpe!\n\nVocê pode escolher um novo horário por aqui: ${link}`
  }

  if (!text) return json({ error: 'bad_type' }, 400)
  const sent = await evoSend(env, bk.client_phone, text)
  if (sent && body.type === 'late_check') {
    // Arma o temporizador: o cron libera o horário se não houver resposta no prazo
    await sb(env, `bookings?id=eq.${bk.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ late_check_sent_at: new Date().toISOString(), late_reply: null })
    })
  }
  if (body.type === 'booking_new') {
    // Entrou gente na fila: ofertas com prazo estendido voltam pro prazo padrão de 5 min
    await encurtaOfertas(env, bk.barber_id, bk.date)
  }
  return json({ sent })
}

// Ofertas estendidas (sem fila) encurtam quando aparece um novo agendamento atrás
async function encurtaOfertas(env, barberId, date) {
  const lim = new Date(Date.now() + 5 * 60 * 1000).toISOString()
  await sb(env, `slot_offers?barber_id=eq.${barberId}&date=eq.${date}&status=eq.pending&expires_at=gt.${encodeURIComponent(lim)}`, {
    method: 'PATCH',
    body: JSON.stringify({ expires_at: lim })
  })
}

// ── Auto-cancelamento pelo cliente: link /c/<id> na confirmação e no lembrete ──
async function cancelPage(bookingId, env) {
  if (!/^[a-f0-9-]{36}$/.test(bookingId || '')) return offerHtml(offerMsg('Link inválido', 'Confira o link recebido no WhatsApp.'))
  const bk = await loadBookingFull(env, bookingId)
  if (!bk) return offerHtml(offerMsg('Link inválido', 'Confira o link recebido no WhatsApp.'))
  if (bk.status !== 'confirmed') return offerHtml(offerMsg('Já resolvido', 'Esse horário já foi cancelado ou concluído.'))
  if (bk.date < todayBR()) return offerHtml(offerMsg('Horário no passado', 'Esse agendamento já passou.'))
  const shop = bk.barbershops || {}
  const btn = 'width:100%;padding:15px;border-radius:12px;border:none;font-size:16px;font-weight:bold;cursor:pointer;font-family:inherit;'
  return offerHtml(`
    ${offerMsg('Cancelar seu horário?', `${bk.services?.name ? '<strong style="color:#F8FAFC;">' + bk.services.name + '</strong><br>' : ''}${fmtData(bk.date)} às <strong style="color:#F8FAFC;">${String(bk.start_time).slice(0, 5)}</strong> na ${shop.name || 'barbearia'}.`)}
    <div style="margin-top:22px;display:flex;flex-direction:column;gap:10px;">
      <button style="${btn}background:#7f1d1d;color:#fff;" onclick="resp()">Sim, cancelar meu horário</button>
      <a href="https://${shop.slug}.navalhanobigode.com.br" style="${btn}display:block;background:none;border:1.5px solid #334155;color:#94A3B8;text-decoration:none;">Voltar (manter horário)</a>
    </div>
    <script>
      async function resp() {
        document.querySelectorAll('button').forEach(b => { b.disabled = true; b.style.opacity = 0.5 })
        try {
          const r = await fetch('/api/cancel-act', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ b: '${bookingId}' }) })
          const d = await r.json()
          document.getElementById('box').innerHTML = '<div style="font-size:44px;margin-bottom:12px;">💈</div><h2 style="color:#D4A843;margin:0 0 10px;">' + d.titulo + '</h2><p style="color:#94A3B8;font-size:15px;line-height:1.6;">' + d.texto + '</p>'
        } catch (e) {
          alert('Falha de conexão. Tente de novo.')
          document.querySelectorAll('button').forEach(b => { b.disabled = false; b.style.opacity = 1 })
        }
      }
    </script>`)
}

async function cancelAct(request, env) {
  let body
  try { body = await request.json() } catch { return json({ titulo: 'Erro', texto: 'Requisição inválida.' }, 400) }
  if (!/^[a-f0-9-]{36}$/.test(body.b || '')) return json({ titulo: 'Erro', texto: 'Link inválido.' }, 400)
  const bk = await loadBookingFull(env, body.b)
  if (!bk) return json({ titulo: 'Erro', texto: 'Link inválido.' }, 404)
  if (bk.status !== 'confirmed' || bk.date < todayBR()) return json({ titulo: 'Já resolvido', texto: 'Esse horário já foi atualizado.' })

  await sb(env, `bookings?id=eq.${bk.id}&status=eq.confirmed`, { method: 'PATCH', body: JSON.stringify({ status: 'cancelled' }) })
  // Vaga liberada entra na cascata de antecipação
  await offerNext(env, {
    barbershop_id: bk.barbershop_id, barber_id: bk.barber_id,
    date: bk.date, slot_start: bk.start_time, slot_end: bk.end_time
  }, bk.start_time)
  const shop = bk.barbershops || {}
  if (shop.owner_phone) await evoSend(env, shop.owner_phone,
    `❌ *${bk.client_name}* cancelou o horário de ${fmtData(bk.date)} às ${String(bk.start_time).slice(0, 5)}${bk.services?.name ? ' (' + bk.services.name + ')' : ''}. Já estou oferecendo a vaga pros próximos clientes. ⚡`)
  return json({ titulo: 'Horário cancelado 🤝', texto: `Tudo certo, ${bk.client_name}. Quando quiser voltar, é só agendar: ${shop.slug}.navalhanobigode.com.br` })
}

// ── Remarcação: cliente trocou de horário — cancela o antigo, avisa certo e cascateia a vaga ──
async function reschedule(request, env) {
  if (!env.SUPABASE_SERVICE_KEY) return json({ ok: false }, 503)
  let body
  try { body = await request.json() } catch { return json({ error: 'bad_request' }, 400) }
  const re = /^[a-f0-9-]{36}$/
  if (!re.test(body.old_booking_id || '') || !re.test(body.new_booking_id || '')) return json({ error: 'bad_request' }, 400)
  if (body.old_booking_id === body.new_booking_id) return json({ error: 'bad_request' }, 400)

  const velho = await loadBookingFull(env, body.old_booking_id)
  const novo = await loadBookingFull(env, body.new_booking_id)
  // Só troca horário do MESMO cliente na MESMA barbearia — nada de cancelar horário alheio
  if (!velho || !novo || velho.barbershop_id !== novo.barbershop_id ||
      velho.client_phone !== novo.client_phone ||
      velho.status !== 'confirmed' || novo.status !== 'confirmed') {
    return json({ error: 'invalid' }, 409)
  }

  await sb(env, `bookings?id=eq.${velho.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'cancelled' }) })
  // A vaga liberada entra na cascata de antecipação
  await offerNext(env, {
    barbershop_id: velho.barbershop_id, barber_id: velho.barber_id,
    date: velho.date, slot_start: velho.start_time, slot_end: velho.end_time
  }, velho.start_time)

  // O novo horário também conta como "gente na fila" pras ofertas estendidas
  await encurtaOfertas(env, novo.barber_id, novo.date)

  const shop = novo.barbershops || {}
  const link = `${shop.slug}.navalhanobigode.com.br`
  const servico = novo.services?.name ? `✂️ ${novo.services.name}\n` : ''
  await evoSend(env, novo.client_phone,
    `🔁 *Horário remarcado!*\n\n💈 ${shop.name}\n${servico}` +
    `📅 De: ${fmtData(velho.date)} às ${String(velho.start_time).slice(0, 5)}\n` +
    `📅 Para: *${fmtData(novo.date)} às ${String(novo.start_time).slice(0, 5)}*\n\n` +
    `Até lá, ${novo.client_name}! Se precisar mudar de novo: ${link}`)
  return json({ ok: true })
}

// ── "Tá chegando?": cliente atrasado responde por link; sem resposta, a vaga cascateia ──
const LATE_TIMEOUT_MIN = 10

async function latePage(bookingId, env) {
  if (!/^[a-f0-9-]{36}$/.test(bookingId || '')) return offerHtml(offerMsg('Link inválido', 'Confira o link recebido no WhatsApp.'))
  const bk = await loadBookingFull(env, bookingId)
  if (!bk || !bk.late_check_sent_at) return offerHtml(offerMsg('Link inválido', 'Confira o link recebido no WhatsApp.'))
  if (bk.status !== 'confirmed' || bk.late_reply) return offerHtml(offerMsg('Já resolvido', 'Esse horário já foi atualizado. Qualquer coisa, fale com a barbearia.'))
  const hora = String(bk.start_time).slice(0, 5)
  const btn = 'width:100%;padding:15px;border-radius:12px;border:none;font-size:16px;font-weight:bold;cursor:pointer;font-family:inherit;'
  return offerHtml(`
    ${offerMsg('Tá chegando?', `Seu horário na <strong style="color:#F8FAFC;">${(bk.barbershops || {}).name || 'barbearia'}</strong> era às <strong style="color:#F8FAFC;">${hora}</strong> e estamos te esperando.`)}
    <div style="margin-top:22px;display:flex;flex-direction:column;gap:10px;">
      <button style="${btn}background:#D4A843;color:#0F172A;" onclick="resp('sim')">🏃 Tô chegando!</button>
      <button style="${btn}background:none;border:1.5px solid #334155;color:#94A3B8;" onclick="resp('nao')">😔 Não vou conseguir</button>
    </div>
    <script>
      async function resp(a) {
        document.querySelectorAll('button').forEach(b => { b.disabled = true; b.style.opacity = 0.5 })
        try {
          const r = await fetch('/api/late-act', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ b: '${bookingId}', a }) })
          const d = await r.json()
          document.getElementById('box').innerHTML = '<div style="font-size:44px;margin-bottom:12px;">💈</div><h2 style="color:#D4A843;margin:0 0 10px;">' + d.titulo + '</h2><p style="color:#94A3B8;font-size:15px;line-height:1.6;">' + d.texto + '</p>'
        } catch (e) {
          alert('Falha de conexão. Tente de novo.')
          document.querySelectorAll('button').forEach(b => { b.disabled = false; b.style.opacity = 1 })
        }
      }
    </script>`)
}

async function lateAct(request, env) {
  let body
  try { body = await request.json() } catch { return json({ titulo: 'Erro', texto: 'Requisição inválida.' }, 400) }
  if (!/^[a-f0-9-]{36}$/.test(body.b || '')) return json({ titulo: 'Erro', texto: 'Link inválido.' }, 400)
  const bk = await loadBookingFull(env, body.b)
  if (!bk || !bk.late_check_sent_at) return json({ titulo: 'Erro', texto: 'Link inválido.' }, 404)
  if (bk.status !== 'confirmed' || bk.late_reply) return json({ titulo: 'Já resolvido', texto: 'Esse horário já foi atualizado.' })

  const shop = bk.barbershops || {}
  const hora = String(bk.start_time).slice(0, 5)

  if (body.a === 'sim') {
    await sb(env, `bookings?id=eq.${bk.id}`, { method: 'PATCH', body: JSON.stringify({ late_reply: 'coming' }) })
    if (shop.owner_phone) await evoSend(env, shop.owner_phone, `🏃 *${bk.client_name}* respondeu: tá chegando! (horário das ${hora})`)
    return json({ titulo: 'Boa! Te esperamos 💈', texto: `Avisamos a barbearia que você está a caminho. Seu horário das ${hora} está garantido.` })
  }

  // Não vem: libera o horário e a cascata de antecipação assume
  await sb(env, `bookings?id=eq.${bk.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'cancelled', late_reply: 'cancel' }) })
  await offerNext(env, {
    barbershop_id: bk.barbershop_id, barber_id: bk.barber_id,
    date: bk.date, slot_start: bk.start_time, slot_end: bk.end_time
  }, bk.start_time)
  if (shop.owner_phone) await evoSend(env, shop.owner_phone, `😔 *${bk.client_name}* não vem (horário das ${hora}). Liberei a vaga e já estou oferecendo pros próximos clientes. ⚡`)
  return json({ titulo: 'Tudo bem! 🤝', texto: `Seu horário foi liberado. Quando quiser, é só remarcar: ${shop.slug}.navalhanobigode.com.br` })
}

// Cron: atrasado que não respondeu no prazo vira falta e a vaga cascateia sozinha
async function lateTimeouts(env) {
  if (!env.SUPABASE_SERVICE_KEY) return
  const limite = new Date(Date.now() - LATE_TIMEOUT_MIN * 60 * 1000).toISOString()
  const rows = await sb(env,
    `bookings?status=eq.confirmed&late_reply=is.null&late_check_sent_at=not.is.null&late_check_sent_at=lt.${encodeURIComponent(limite)}` +
    `&date=eq.${todayBR()}&select=*,barbershops(name,slug,owner_phone)`)
  if (!Array.isArray(rows)) return
  for (const bk of rows) {
    await sb(env, `bookings?id=eq.${bk.id}&late_reply=is.null`, { method: 'PATCH', body: JSON.stringify({ status: 'no_show', late_reply: 'timeout' }) })
    await offerNext(env, {
      barbershop_id: bk.barbershop_id, barber_id: bk.barber_id,
      date: bk.date, slot_start: bk.start_time, slot_end: bk.end_time
    }, bk.start_time)
    const shop = bk.barbershops || {}
    if (shop.owner_phone) await evoSend(env, shop.owner_phone,
      `⏳ *${bk.client_name}* não respondeu em ${LATE_TIMEOUT_MIN} min (horário das ${String(bk.start_time).slice(0, 5)}). Marquei como falta, liberei a vaga e já estou oferecendo pros próximos. ⚡`)
  }
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
    const text = `⏰ *Lembrete do seu horário!*\n\n💈 ${shop.name}\n${bk.services?.name ? '✂️ ' + bk.services.name + '\n' : ''}📅 Hoje às ${hora}\n\nTe esperamos, ${bk.client_name}!\nSe não puder vir, remarque em: ${shop.slug}.navalhanobigode.com.br\nOu cancele: https://${shop.slug}.navalhanobigode.com.br/c/${bk.id}`
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

// ── Efeito cascata: oferece vaga liberada a quem tem horário mais tarde ──
function minutos(t) { const [h, m] = String(t).split(':').map(Number); return h * 60 + m }
function horaStr(min) { return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}` }

async function sb(env, path, init = {}) {
  const r = await fetch(env.SUPABASE_URL + '/rest/v1/' + path, {
    ...init,
    headers: { ...sbHeaders(env), 'Content-Type': 'application/json', 'Prefer': init.method ? 'return=representation' : undefined, ...(init.headers || {}) }
  })
  try { return await r.json() } catch { return null }
}

// Oferece a janela liberada ao próximo da fila (a partir de afterTime)
// Prazo estendido: quando não há fila atrás, a oferta vale até 30 min antes da vaga
function prazoOferta(win, temFila) {
  const CINCO = 5 * 60 * 1000
  if (temFila) return CINCO
  const slotUtc = Date.parse(`${win.date}T${String(win.slot_start).slice(0, 8)}Z`) + 3 * 3600 * 1000
  const restante = slotUtc - 30 * 60 * 1000 - Date.now()
  return Math.max(CINCO, restante)
}

async function offerNext(env, win, afterTime) {
  const candidatos = await sb(env,
    `bookings?barber_id=eq.${win.barber_id}&date=eq.${win.date}&status=eq.confirmed` +
    `&start_time=gt.${afterTime}&select=*,services(name),barbershops(name,slug)&order=start_time.asc`)
  if (!Array.isArray(candidatos)) return

  const freedLen = minutos(win.slot_end) - minutos(win.slot_start)
  for (let i = 0; i < candidatos.length; i++) {
    const cand = candidatos[i]
    const dur = minutos(cand.end_time) - minutos(cand.start_time)
    if (dur > freedLen) continue // serviço não cabe na janela

    // Tem mais alguém na fila (depois deste) cujo serviço também caberia?
    const temFila = candidatos.slice(i + 1).some(c => (minutos(c.end_time) - minutos(c.start_time)) <= freedLen)
    const validadeMs = prazoOferta(win, temFila)

    const code = Array.from(crypto.getRandomValues(new Uint8Array(6)))
      .map(b => 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'[b % 31]).join('')
    const [offer] = await sb(env, 'slot_offers', {
      method: 'POST',
      body: JSON.stringify({
        barbershop_id: win.barbershop_id, barber_id: win.barber_id,
        date: win.date, slot_start: win.slot_start, slot_end: win.slot_end,
        booking_id: cand.id,
        code,
        status: 'pending',
        expires_at: new Date(Date.now() + validadeMs).toISOString()
      })
    }) || []
    if (!offer) return

    const shop = cand.barbershops || {}
    const link = `${shop.slug}.navalhanobigode.com.br/o/${code}`
    const validadeTxt = temFila
      ? '⏱ Oferta válida por 5 minutos.'
      : `⏱ Oferta válida até *${new Date(Date.now() + validadeMs - 3 * 3600 * 1000).toISOString().slice(11, 16)}* (você é o próximo da fila, sem pressa).`
    const text =
      `💈 *${shop.name}*\n\n` +
      `Olá, ${cand.client_name}! Abriu um horário mais cedo:\n` +
      `🗓 Dia ${fmtData(win.date)} às 🕐 *${String(win.slot_start).slice(0,5)}h*\n` +
      `Você está marcado às ${String(cand.start_time).slice(0,5)}h\n\n` +
      `Quer antecipar? Toque e escolha:\n${link}\n\n` +
      validadeTxt
    await evoSend(env, cand.client_phone, text)
    return // uma oferta por vez; o resto acontece via resposta ou expiração
  }
}

// ── "⚡ Liberei mais cedo": barbeiro terminou rápido e chama o próximo da fila ──
async function freeNow(request, env) {
  if (!env.SUPABASE_SERVICE_KEY) return json({ error: 'not_configured' }, 503)
  let body
  try { body = await request.json() } catch { return json({ error: 'bad_request' }, 400) }
  const re = /^[a-f0-9-]+$/
  if (!re.test(body.barbershop_id || '') || !re.test(body.barber_id || '')) return json({ error: 'bad_request' }, 400)

  const hoje = todayBR()
  const nowBR = new Date(Date.now() - 3 * 3600 * 1000)
  const nowStr = `${String(nowBR.getUTCHours()).padStart(2, '0')}:${String(nowBR.getUTCMinutes()).padStart(2, '0')}:00`

  const candidatos = await sb(env,
    `bookings?barbershop_id=eq.${body.barbershop_id}&barber_id=eq.${body.barber_id}&date=eq.${hoje}` +
    `&status=eq.confirmed&start_time=gt.${nowStr}&select=*,services(name),barbershops(name,slug)&order=start_time.asc`)
  if (!Array.isArray(candidatos) || !candidatos.length) return json({ none: true })

  const cand = candidatos[0]
  // Evita oferta duplicada pro mesmo agendamento
  const abertas = await sb(env, `slot_offers?booking_id=eq.${cand.id}&status=eq.pending&select=id`)
  if (Array.isArray(abertas) && abertas.length) return json({ already: true, client: cand.client_name })

  // Alguém DEPOIS do primeiro caberia na janela de agora até o horário fixo dele?
  const janela = minutos(cand.start_time) - (nowBR.getUTCHours() * 60 + nowBR.getUTCMinutes())
  const temFila = candidatos.slice(1).some(c => (minutos(c.end_time) - minutos(c.start_time)) <= janela)
  // Prazo: 5 min com fila; sem fila, até 10 min antes do horário fixo dele (mín. 5 min)
  const validadeMs = temFila ? 5 * 60 * 1000
    : Math.max(5 * 60 * 1000, (Date.parse(`${hoje}T${cand.start_time}Z`) + 3 * 3600 * 1000) - 10 * 60 * 1000 - Date.now())

  const code = Array.from(crypto.getRandomValues(new Uint8Array(6)))
    .map(b => 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'[b % 31]).join('')
  const [offer] = await sb(env, 'slot_offers', {
    method: 'POST',
    body: JSON.stringify({
      barbershop_id: cand.barbershop_id, barber_id: cand.barber_id,
      date: hoje, slot_start: nowStr, slot_end: cand.start_time,
      booking_id: cand.id, code, status: 'pending',
      expires_at: new Date(Date.now() + validadeMs).toISOString()
    })
  }) || []
  if (!offer) return json({ error: 'offer_failed' }, 500)

  const shop = cand.barbershops || {}
  await evoSend(env, cand.client_phone,
    `⚡ *${shop.name}*\n\nBoa notícia, ${cand.client_name}! Liberamos mais cedo por aqui.\n` +
    `Seu horário é às ${String(cand.start_time).slice(0, 5)} — *quer vir agora?*\n\n` +
    `Toque e escolha:\n${shop.slug}.navalhanobigode.com.br/o/${code}\n\n` +
    (temFila ? '⏱ Oferta válida por 5 minutos.' : '⏱ Sem pressa — vale até pertinho do seu horário.'))
  return json({ ok: true, client: cand.client_name, at: String(cand.start_time).slice(0, 5) })
}

async function cascadeStart(request, env) {
  if (!env.SUPABASE_SERVICE_KEY) return json({ ok: false })
  let body
  try { body = await request.json() } catch { return json({ error: 'bad_request' }, 400) }
  const bk = await loadBookingFull(env, body.booking_id)
  if (!bk) return json({ ok: false })
  await offerNext(env, {
    barbershop_id: bk.barbershop_id, barber_id: bk.barber_id,
    date: bk.date, slot_start: bk.start_time, slot_end: bk.end_time
  }, bk.start_time)
  return json({ ok: true })
}

function offerHtml(inner) {
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
     <body style="font-family:Arial;background:#0F172A;color:#F8FAFC;display:flex;align-items:center;justify-content:center;min-height:100dvh;margin:0;padding:24px;text-align:center;">
     <div id="box" style="max-width:340px;"><div style="font-size:44px;margin-bottom:12px;">💈</div>${inner}</div></body>`,
    { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
}
const offerMsg = (titulo, texto) => `<h2 style="color:#D4A843;margin:0 0 10px;">${titulo}</h2><p style="color:#94A3B8;font-size:15px;line-height:1.6;">${texto}</p>`

async function loadValidOffer(env, valor, campo) {
  if (!valor || !/^[A-Za-z0-9-]+$/.test(valor)) return { err: offerMsg('Link inválido', 'Confira o link recebido no WhatsApp.') }
  const [offer] = await sb(env, `slot_offers?${campo === 'code' ? 'code' : 'token'}=eq.${valor}&select=*`) || []
  if (!offer) return { err: offerMsg('Oferta não encontrada', 'Este link não é mais válido.') }
  if (offer.status !== 'pending') return { err: offerMsg('Oferta encerrada', 'Essa vaga já foi resolvida. Seu horário original continua valendo.') }
  if (new Date(offer.expires_at) < new Date()) {
    await sb(env, `slot_offers?id=eq.${offer.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'expired' }) })
    return { err: offerMsg('Oferta expirada', 'O prazo da oferta passou. Seu horário original continua valendo.') }
  }
  const bk = await loadBookingFull(env, offer.booking_id)
  if (!bk || bk.status !== 'confirmed') return { err: offerMsg('Oferta encerrada', 'Seu agendamento mudou desde a oferta.') }
  return { offer, bk }
}

// Página da oferta: só mostra os botões — nada é decidido no simples abrir do link
async function offerPage(valor, campo, env) {
  const { err, offer, bk } = await loadValidOffer(env, valor, campo)
  if (err) return offerHtml(err)

  const nova = String(offer.slot_start).slice(0, 5)
  const atual = String(bk.start_time).slice(0, 5)
  const btn = 'width:100%;padding:15px;border-radius:12px;border:none;font-size:16px;font-weight:bold;cursor:pointer;font-family:inherit;'
  return offerHtml(`
    ${offerMsg('Antecipar seu horário?', `Abriu uma vaga às <strong style="color:#F8FAFC;">${nova}</strong> no dia ${fmtData(offer.date)}.<br>Você está marcado para ${atual}.`)}
    <div style="margin-top:22px;display:flex;flex-direction:column;gap:10px;">
      <button style="${btn}background:#D4A843;color:#0F172A;" onclick="resp('sim')">✅ Sim, antecipar para ${nova}</button>
      <button style="${btn}background:none;border:1.5px solid #334155;color:#94A3B8;" onclick="resp('nao')">Manter meu horário das ${atual}</button>
    </div>
    <script>
      async function resp(a) {
        document.querySelectorAll('button').forEach(b => { b.disabled = true; b.style.opacity = 0.5 })
        try {
          const r = await fetch('/api/offer', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ v: '${valor}', c: '${campo}', a }) })
          const d = await r.json()
          document.getElementById('box').innerHTML = '<div style="font-size:44px;margin-bottom:12px;">💈</div><h2 style="color:#D4A843;margin:0 0 10px;">' + d.titulo + '</h2><p style="color:#94A3B8;font-size:15px;line-height:1.6;">' + d.texto + '</p>'
        } catch (e) {
          alert('Falha de conexão. Tente de novo.')
          document.querySelectorAll('button').forEach(b => { b.disabled = false; b.style.opacity = 1 })
        }
      }
    </script>`)
}

// Ação da oferta: só executa via botão (POST) — imune ao robô de prévia do WhatsApp
async function offerAct(request, env) {
  let body
  try { body = await request.json() } catch { return json({ titulo: 'Erro', texto: 'Requisição inválida.' }, 400) }
  const { err, offer, bk } = await loadValidOffer(env, body.v || body.t, body.c || 'token')
  if (err) return json({ titulo: 'Oferta encerrada', texto: 'Essa vaga já foi resolvida. Seu horário original continua valendo.' })

  if (body.a === 'sim') {
    const dur = minutos(bk.end_time) - minutos(bk.start_time)
    const novoFim = horaStr(minutos(offer.slot_start) + dur)
    // A vaga que ele deixa só começa depois do fim do NOVO horário (ex.: "venha agora"
    // colado no horário antigo — o pedaço sobreposto não pode ser oferecido a ninguém)
    const livreIni = novoFim > bk.start_time ? novoFim : bk.start_time
    await sb(env, `bookings?id=eq.${bk.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ start_time: offer.slot_start, end_time: novoFim })
    })
    await sb(env, `slot_offers?id=eq.${offer.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'accepted' }) })
    const shop = bk.barbershops || {}
    await evoSend(env, bk.client_phone,
      `✅ Prontinho, ${bk.client_name}! Seu horário na ${shop.name} foi antecipado para *${String(offer.slot_start).slice(0,5)}* do dia ${fmtData(bk.date)}. Até lá! 💈`)
    if (livreIni < bk.end_time) {
      await offerNext(env, {
        barbershop_id: bk.barbershop_id, barber_id: bk.barber_id,
        date: bk.date, slot_start: livreIni, slot_end: bk.end_time
      }, livreIni)
    }
    return json({ titulo: 'Horário antecipado! ✅', texto: `Seu novo horário é ${String(offer.slot_start).slice(0,5)} do dia ${fmtData(bk.date)}. Enviamos a confirmação no seu WhatsApp.` })
  }

  await sb(env, `slot_offers?id=eq.${offer.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'declined' }) })
  await evoSend(env, bk.client_phone,
    `Tudo certo, ${bk.client_name}! A vaga das ${String(offer.slot_start).slice(0,5)} foi repassada. Seu horário das ${String(bk.start_time).slice(0,5)} continua confirmado. 💈`)
  await offerNext(env, {
    barbershop_id: offer.barbershop_id, barber_id: offer.barber_id,
    date: offer.date, slot_start: offer.slot_start, slot_end: offer.slot_end
  }, bk.start_time)
  return json({ titulo: 'Tudo certo! 👍', texto: `Seu horário das ${String(bk.start_time).slice(0,5)} continua valendo. Obrigado por avisar!` })
}

// Ofertas que venceram sem resposta passam para o próximo da fila
async function processExpiredOffers(env) {
  if (!env.SUPABASE_SERVICE_KEY) return
  const vencidas = await sb(env, `slot_offers?status=eq.pending&expires_at=lt.${new Date().toISOString()}&select=*`)
  if (!Array.isArray(vencidas)) return
  for (const offer of vencidas) {
    await sb(env, `slot_offers?id=eq.${offer.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'expired' }) })
    const bk = await loadBookingFull(env, offer.booking_id)
    if (bk) await evoSend(env, bk.client_phone,
      `Olá, ${bk.client_name}! A vaga das ${String(offer.slot_start).slice(0,5)} foi preenchida. Seu horário das ${String(bk.start_time).slice(0,5)} continua confirmado. 💈`)
    await offerNext(env, {
      barbershop_id: offer.barbershop_id, barber_id: offer.barber_id,
      date: offer.date, slot_start: offer.slot_start, slot_end: offer.slot_end
    }, bk ? bk.start_time : offer.slot_start)
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } })
}
