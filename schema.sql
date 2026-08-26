-- ================================================================
-- NAVALHA NO BIGODE — Schema do Banco de Dados
-- Cole tudo isso no SQL Editor do Supabase e clique em "Run"
-- ================================================================

-- ----------------------------------------
-- BARBEARIAS (um registro por cliente)
-- ----------------------------------------
create table if not exists public.barbershops (
  id            uuid default gen_random_uuid() primary key,
  created_at    timestamptz default now(),
  slug          text unique not null,        -- URL: joao → joao.navalhanobigode.com.br
  name          text not null,               -- "Barbearia do João"
  owner_email   text,
  owner_phone   text,                       -- WhatsApp do dono (avisos e cobrança)
  next_due      date,                       -- vencimento da mensalidade
  billing_notified_3d date,                 -- controle de avisos enviados (por vencimento)
  billing_notified_due date,
  billing_notified_overdue date,
  last_renewal_payment_id text,             -- evita renovação duplicada pelo webhook
  owner_birthday date,                      -- 10% de desconto no mês do aniversário
  weekly_report_sent date,                  -- controle do relatório semanal
  logo_url      text,
  primary_color text default '#D4A843',      -- cor principal (hex)
  plan          text default 'solo',         -- solo | equipe | black
  status        text default 'active',       -- active | suspended | trial
  max_barbers   int default 1,               -- limite por plano
  changes_limit int,                         -- null = ilimitado (Black)
  mp_subscription_id text                    -- Mercado Pago (fase 2)
);

-- ----------------------------------------
-- BARBEIROS
-- ----------------------------------------
create table if not exists public.barbers (
  id              uuid default gen_random_uuid() primary key,
  created_at      timestamptz default now(),
  barbershop_id   uuid references public.barbershops(id) on delete cascade not null,
  name            text not null,
  photo_url       text,
  active          boolean default true
);

-- ----------------------------------------
-- SERVIÇOS
-- ----------------------------------------
create table if not exists public.services (
  id                uuid default gen_random_uuid() primary key,
  barbershop_id     uuid references public.barbershops(id) on delete cascade not null,
  name              text not null,
  duration_minutes  int default 30,
  price             numeric(10,2) default 0,
  active            boolean default true
);

-- ----------------------------------------
-- DISPONIBILIDADE (horários por barbeiro)
-- ----------------------------------------
create table if not exists public.availability (
  id            uuid default gen_random_uuid() primary key,
  barber_id     uuid references public.barbers(id) on delete cascade not null,
  day_of_week   int not null,
  start_time    time not null,
  end_time      time not null
);

-- ----------------------------------------
-- AGENDAMENTOS
-- ----------------------------------------
create table if not exists public.bookings (
  id              uuid default gen_random_uuid() primary key,
  created_at      timestamptz default now(),
  barbershop_id   uuid references public.barbershops(id) on delete cascade not null,
  barber_id       uuid references public.barbers(id) not null,
  service_id      uuid references public.services(id) not null,
  client_name     text not null,
  client_phone    text not null,
  date            date not null,
  start_time      time not null,
  end_time        time not null,
  status          text default 'confirmed'
);

-- ----------------------------------------
-- CONTROLE DE ALTERAÇÕES
-- ----------------------------------------
create table if not exists public.booking_changes (
  id              uuid default gen_random_uuid() primary key,
  changed_at      timestamptz default now(),
  booking_id      uuid references public.bookings(id) on delete cascade,
  barbershop_id   uuid references public.barbershops(id) on delete cascade
);

-- ----------------------------------------
-- "TÁ CHEGANDO?" (cliente atrasado) — colunas de controle em bookings
-- ----------------------------------------
alter table public.bookings add column if not exists notes text;  -- observação do cliente no agendamento
alter table public.bookings add column if not exists late_check_sent_at timestamptz;
alter table public.bookings add column if not exists late_reply text;  -- coming | cancel | timeout

-- ----------------------------------------
-- PEDIDO DE CARTÕES — controle em barbershops
-- ----------------------------------------
alter table public.barbershops add column if not exists kit_paid boolean default false;
alter table public.barbershops add column if not exists last_card_payment_id text;
alter table public.barbershops add column if not exists last_pos_payment_id text;  -- venda de maquininha no cadastro
alter table public.barbershops add column if not exists referred_by text;           -- slug do indicador (programa de indicação)
alter table public.barbershops add column if not exists activated_at timestamptz;   -- momento da primeira ativação (pago ou trial)
alter table public.barbershops add column if not exists onboarding_sent_at date;    -- controle do lembrete 48h pós-ativação

-- ----------------------------------------
-- CONVITES DE TESTE GRÁTIS (uso único)
-- Sem policy pública: só o Worker (service key) lê e grava.
-- ----------------------------------------
create table if not exists public.trial_invites (
  id          uuid default gen_random_uuid() primary key,
  created_at  timestamptz default now(),
  code        text unique not null,
  label       text,                                          -- nome/zap do barbeiro convidado
  used_at     timestamptz,
  used_by     uuid references public.barbershops(id)
);
alter table public.trial_invites enable row level security;

-- ----------------------------------------
-- ROW LEVEL SECURITY
-- ----------------------------------------
alter table public.barbershops    enable row level security;
alter table public.barbers        enable row level security;
alter table public.services       enable row level security;
alter table public.availability   enable row level security;
alter table public.bookings       enable row level security;
alter table public.booking_changes enable row level security;

create policy "pub_read_barbershops" on public.barbershops
  for select using (status = 'active');

create policy "pub_read_barbers" on public.barbers
  for select using (active = true);

create policy "pub_read_services" on public.services
  for select using (active = true);

create policy "pub_read_availability" on public.availability
  for select using (true);

create policy "pub_read_bookings" on public.bookings
  for select using (status = 'confirmed');

create policy "pub_insert_bookings" on public.bookings
  for insert with check (true);

-- ----------------------------------------
-- BARBEARIA DE TESTE
-- ----------------------------------------
insert into public.barbershops (slug, name, primary_color, plan, max_barbers, changes_limit)
values ('teste', 'Barbearia Teste', '#1a6b3c', 'equipe', 3, 30)
on conflict (slug) do nothing;
