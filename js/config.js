const SUPABASE_URL = 'https://txmdehfleltpqokhyzex.supabase.co'
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InR4bWRlaGZsZWx0cHFva2h5emV4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODc0NzI4MzUsImV4cCI6MjEwMzA0ODgzNX0.n0b5sG0RxW6-73W41MpSqcc-zSDq7AdxW2JjwvSIsPg'

const { createClient } = supabase
const db = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)

// Extrai o slug da barbearia do subdomínio ou query param (para teste)
function getSlug() {
  const host = window.location.hostname // ex: joao.navalhanobigode.com.br
  const parts = host.split('.')
  // Só extrai subdomínio no domínio real (não em workers.dev / pages.dev)
  if (parts.length >= 3 && parts[0] !== 'www' && host.includes('navalhanobigode')) return parts[0]
  // Fallback para testes: ?barbearia=joao
  const params = new URLSearchParams(window.location.search)
  return params.get('barbearia') || 'teste'
}

// Dias da semana em português
const DIAS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb']
const DIAS_FULL = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado']
const MESES = ['jan','fev','mar','abr','mai','jun','jul','ago','set','out','nov','dez']
